// UPD-005 (/responses/compact): server-side history compaction seam.
//
// OpenAI serves a unary `/responses/compact` endpoint that returns the
// compacted item list with a `compaction` item carrying opaque
// `encrypted_content` (server-held encrypted context). This module owns:
//   1. the capability decision (canonical OpenAI Responses route only —
//      compatible families are never assumed to serve it),
//   2. the session-scoped in-memory staging of `encrypted_content`,
//   3. the unary call itself, with fail-over to the local summary path on
//      any error.
//
// PERSISTENCE GAP (no-migration constraint): `encrypted_content` cannot be
// persisted today — it would need a new table/column in the core database,
// which is reserved for a migration window (parallel work owns migrations).
// The store below is process-lifetime only; a restart loses it and the
// session silently falls back to local summarization (the previous encrypted
// context is simply not sent). Wiring the server-side path end-to-end is
// additionally blocked by the compaction data model: the durable state
// machine commits a TEXT summary, while remote compaction yields an opaque
// blob with no text to commit. Until both gaps close, compaction.ts always
// runs the local path and this module is exercised at unit level only.
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { OpenAIResponses } from "@deepagent-code/llm/protocols/openai-responses"
import { byProvider as OpenAICompatibleProfiles } from "@deepagent-code/llm/providers/openai-compatible-profile"
import type { LLMRequest } from "@deepagent-code/llm"
import type { RequestExecutor } from "@deepagent-code/llm/route"
import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"
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

// Session-scoped in-memory staging for the opaque encrypted context. Keyed by
// sessionID; sent back on the next compaction so the provider can expand it.
// See the PERSISTENCE GAP note above — this Map is the ONLY store today.
const encryptedContent = new Map<string, string>()

export const EncryptedContentStore = {
  get: (sessionID: string): string | undefined => encryptedContent.get(sessionID),
  set: (sessionID: string, value: string): void => {
    encryptedContent.set(sessionID, value)
  },
  clear: (sessionID: string): void => {
    encryptedContent.delete(sessionID)
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
    if (!supportsRemoteCompaction(input.model))
      return { used: "local", reason: `provider package ${input.model.api.npm} does not serve /responses/compact` }

    const runtime = LLMNativeRuntime.status(input)
    if (runtime.type === "unsupported") return { used: "local", reason: runtime.reason }

    const request: LLMRequest = LLMNative.request({
      model: input.model,
      apiKey: runtime.apiKey,
      baseURL: runtime.baseURL,
      system: [...(input.system ?? [])],
      messages: [...input.messages],
    })
    const previous = EncryptedContentStore.get(input.sessionID)
    const result = yield* OpenAIResponses.compactConversation({ request, previousEncryptedContent: previous }).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    )
    if (!result.ok) return { used: "local", reason: errorMessage(result.error) }
    EncryptedContentStore.set(input.sessionID, result.value.encryptedContent)
    return { used: "remote", encryptedContent: result.value.encryptedContent } satisfies RemoteCompactionOutcome
  })

export * as RemoteCompact from "./remote-compact"
