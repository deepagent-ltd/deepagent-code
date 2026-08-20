// UPD-005 (/responses/compact): server-side history compaction seam.
//
// OpenAI serves a unary `/responses/compact` endpoint that returns the
// compacted item list with a `compaction` item carrying opaque
// `encrypted_content` (server-held encrypted context). This module owns:
//   1. the capability decision (canonical OpenAI Responses route only —
//      compatible families are never assumed to serve it),
//   2. the session-scoped staging of `encrypted_content`,
//   3. the unary call itself, with fail-over to the local summary path on
//      any error.
//
// PERSISTENCE (Gap 1 closed): `encrypted_content` is durably stored in
// `session_compaction_encrypted_content` (migration
// 20260820000000_remote_compact_persistence). EncryptedContentStore is the
// read/write wrapper over that table — get/set/clear keep their signatures.
// The compaction layer binds the Database handle (EncryptedContentStore.bind);
// without a bound handle the store degrades to process-lifetime memory (unit
// tests and callers outside the durable compaction path). With a bound handle,
// a restart no longer loses the blob: the next compaction reads it back from
// the table and replays it (§4.3).
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { eq } from "drizzle-orm"
import { OpenAIResponses } from "@deepagent-code/llm/protocols/openai-responses"
import { byProvider as OpenAICompatibleProfiles } from "@deepagent-code/llm/providers/openai-compatible-profile"
import type { LLMRequest } from "@deepagent-code/llm"
import type { RequestExecutor } from "@deepagent-code/llm/route"
import type { Database } from "@deepagent-code/core/database/database"
import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"
import { SessionCompactionEncryptedContentTable } from "./compaction-sql"
import { LLMNative } from "./llm/native-request"
import { LLMNativeRuntime } from "./llm/native-runtime"

/**
 * Capability probe for `/responses/compact`.
 * - `@ai-sdk/openai` lowers onto the OpenAI Responses route, whose protocol
 *   advertises compact support (canonical OpenAI).
 * - `@ai-sdk/openai-compatible` families must opt in per profile
 *   (`supportsResponsesCompact`); only DeepSeek does today (user-verified
 *   2026-08-18) — never assumed for anyone else.
 * - Azure also serves the Responses API, but its endpoint path is shaped
 *   differently (`/openai/responses?api-version=…`) and compact there is
 *   unverified — deliberately not assumed either.
 */
export const supportsRemoteCompaction = (model: Provider.Model): boolean => {
  if (model.api.npm === "@ai-sdk/openai") return OpenAIResponses.supportsRemoteCompaction
  if (model.api.npm === "@ai-sdk/openai-compatible")
    return OpenAICompatibleProfiles[String(model.providerID)]?.supportsResponsesCompact === true
  return false
}

// Attribution recorded with a stored blob: provenance for the same-source
// replay check (providerID) plus optional capability re-check and run linkage.
export type EncryptedContentAttribution = {
  readonly providerID?: string
  readonly modelID?: string
  readonly sourceRunID?: string
}

export type EncryptedContentRecord = {
  readonly encryptedContent: string
  readonly providerID: string
  readonly modelID: string | undefined
  readonly sourceRunID: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

// Bound by the compaction layer (production) or tests. The bun SQLite driver is
// fully synchronous, so the store keeps its synchronous get/set/clear signatures
// by running the drizzle effects with Effect.runSync.
let boundDb: Database.Interface["db"] | undefined

// Fallback for callers without a bound Database handle (unit tests, seams used
// before the compaction layer is built). Never read when a handle is bound.
const memory = new Map<string, EncryptedContentRecord>()

const readRecord = (sessionID: string): EncryptedContentRecord | undefined => {
  if (!boundDb) return memory.get(sessionID)
  const row = Effect.runSync(
    boundDb
      .select()
      .from(SessionCompactionEncryptedContentTable)
      .where(eq(SessionCompactionEncryptedContentTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie),
  )
  if (!row) return undefined
  return {
    encryptedContent: row.encrypted_content,
    providerID: row.provider_id,
    modelID: row.model_id ?? undefined,
    sourceRunID: row.source_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const writeRecord = (sessionID: string, value: string, attribution: EncryptedContentAttribution | undefined) => {
  const now = Date.now()
  const providerID = attribution?.providerID ?? "unknown"
  const modelID = attribution?.modelID ?? null
  const sourceRunID = attribution?.sourceRunID ?? null
  if (!boundDb) {
    memory.set(sessionID, {
      encryptedContent: value,
      providerID,
      modelID: modelID ?? undefined,
      sourceRunID: sourceRunID ?? undefined,
      createdAt: now,
      updatedAt: now,
    })
    return
  }
  // Forward-only upsert: keep exactly the latest blob per session (§4.1).
  Effect.runSync(
    boundDb
      .insert(SessionCompactionEncryptedContentTable)
      .values({
        session_id: sessionID,
        encrypted_content: value,
        provider_id: providerID,
        model_id: modelID,
        source_run_id: sourceRunID,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: SessionCompactionEncryptedContentTable.session_id,
        set: {
          encrypted_content: value,
          provider_id: providerID,
          model_id: modelID,
          source_run_id: sourceRunID,
          updated_at: now,
        },
      })
      .run()
      .pipe(Effect.orDie),
  )
}

const deleteRecord = (sessionID: string) => {
  if (!boundDb) {
    memory.delete(sessionID)
    return
  }
  Effect.runSync(
    boundDb
      .delete(SessionCompactionEncryptedContentTable)
      .where(eq(SessionCompactionEncryptedContentTable.session_id, sessionID))
      .run()
      .pipe(Effect.orDie),
  )
}

export const EncryptedContentStore = {
  /** Bind the durable Database handle; pass undefined to restore memory-only mode. */
  bind: (db: Database.Interface["db"] | undefined): void => {
    boundDb = db
  },
  get: (sessionID: string): string | undefined => readRecord(sessionID)?.encryptedContent,
  /** Full record incl. provenance — used for the same-source replay check (§4.3). */
  getRecord: (sessionID: string): EncryptedContentRecord | undefined => readRecord(sessionID),
  set: (sessionID: string, value: string, attribution?: EncryptedContentAttribution): void => {
    writeRecord(sessionID, value, attribution)
  },
  clear: (sessionID: string): void => {
    deleteRecord(sessionID)
  },
} as const

export type RemoteCompactionOutcome =
  | { readonly used: "remote"; readonly encryptedContent: string }
  | { readonly used: "local"; readonly reason: string }

export type RemoteCompactionInput = {
  readonly sessionID: string
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly system?: readonly string[]
  readonly messages: readonly ModelMessage[]
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Attempt server-side compaction; never throws the decision out — every
 * failure mode (unsupported provider, missing API key, transport/HTTP error,
 * malformed compact payload) resolves to `{ used: "local" }` so callers keep
 * the existing local summary path with zero behavioural change.
 *
 * Requires `RequestExecutor.Service` in the environment (production provides
 * `RequestExecutor.defaultLayer`; tests inject a mock HTTP layer).
 */
export const attemptRemoteCompaction = (
  input: RemoteCompactionInput,
): Effect.Effect<RemoteCompactionOutcome, never, RequestExecutor.Service> =>
  Effect.gen(function* () {
    if (!supportsRemoteCompaction(input.model)) {
      // Capability lost (e.g. the session switched to a model whose route does
      // not serve /responses/compact): local summarization takes over and the old
      // blob is invalidated so it can never be replayed against an incapable route (§4.3).
      EncryptedContentStore.clear(input.sessionID)
      return { used: "local", reason: `provider package ${input.model.api.npm} does not serve /responses/compact` }
    }

    const runtime = LLMNativeRuntime.status(input)
    if (runtime.type === "unsupported") return { used: "local", reason: runtime.reason }

    // Same-provenance check BEFORE replay (§4.3): a blob minted by a different
    // provider cannot be expanded by the current one — treat it as absent, drop
    // it, and fail over to local summarization.
    const record = EncryptedContentStore.getRecord(input.sessionID)
    if (record && record.providerID !== input.model.providerID) {
      EncryptedContentStore.clear(input.sessionID)
      return {
        used: "local",
        reason: `encrypted_content belongs to provider ${record.providerID}, not ${input.model.providerID}`,
      }
    }
    const previous = record?.encryptedContent

    const request: LLMRequest = LLMNative.request({
      model: input.model,
      apiKey: runtime.apiKey,
      baseURL: runtime.baseURL,
      system: [...(input.system ?? [])],
      messages: [...input.messages],
    })
    const result = yield* OpenAIResponses.compactConversation({ request, previousEncryptedContent: previous }).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    )
    if (!result.ok) return { used: "local", reason: errorMessage(result.error) }
    EncryptedContentStore.set(input.sessionID, result.value.encryptedContent, {
      providerID: input.model.providerID,
      modelID: input.model.id,
    })
    return { used: "remote", encryptedContent: result.value.encryptedContent } satisfies RemoteCompactionOutcome
  })

export * as RemoteCompact from "./remote-compact"
