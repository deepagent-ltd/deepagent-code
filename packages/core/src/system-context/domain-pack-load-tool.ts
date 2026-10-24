export * as DomainPackLoadTool from "./domain-pack-load-tool"

import { Effect, Layer, Option, Schema } from "effect"
import { ToolFailure } from "@deepagent-code/llm"
import { and, count, eq, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { SessionToolQuota } from "../session/tool-quota.schema"
import { SessionTable } from "../session/sql"
import { AgentGateway } from "../agent-gateway"
import { Tool } from "../tool/tool"
import { Tools } from "../tool/tools"
import { Token } from "../util/token"
import { domainPackLoadName } from "./capability-load-tool"
import { findPackDoc, packDocName, productionStoreResolver, type StoreResolver } from "./domain-pack-docs"

// P2-a (WS3 chain repair, docs/V2.0.1-001-llm-agent-system-manual.md §4.5): the production
// `domain_pack_load` tool — the L1 -> L2 link that makes the seeded domain-pack manual loadable by
// the model. The input is a single opaque `ref` (the durable DocumentStore doc id surfaced by
// `pack_search`; the model never names a path, URL or body). Execution resolves the doc in the
// user-global durable store, requires status `active` (a candidate/rejected/missing ref settles as
// a typed not_found, never a body), enforces the per-turn budget of 2 NEW documents
// (design §4.6, enforced as a ToolFailure) and returns the title/summary plus the body bounded to
// ~600 tokens.
//
// Quota facts remain in the original Session event aggregate across restart and projection
// compaction. They are deliberately outside the projection codec's rebuildEventTypes: neither
// metadata edits nor retiring a host may grant the same Session a fresh disclosure budget.

export const name = domainPackLoadName

/** Disclosure budget for one domain-pack document load (design §4.6). */
export const DomainPackLoadBudget = {
  perTurnMaxNew: SessionToolQuota.LIMITS.newPerTurn,
  bodyMaxTokens: 600,
  perSessionMaxLoaded: SessionToolQuota.LIMITS.loaded,
  refMaxBytes: SessionToolQuota.LIMITS.refBytes,
} as const

// Token.estimate uses 4 chars/token, so this many chars lands exactly on the token ceiling.
const maxBodyChars = DomainPackLoadBudget.bodyMaxTokens * 4

/** The model-facing input: the opaque durable doc ref from a `pack_search` card. */
export const DomainPackLoadInput = Schema.Struct({
  ref: SessionToolQuota.Ref,
})
export type DomainPackLoadInput = typeof DomainPackLoadInput.Type

export const DomainPackLoadNotFoundReason = Schema.Literals([
  "domain_pack_document_unknown",
  "domain_pack_document_not_active",
  "domain_pack_store_unavailable",
])
export type DomainPackLoadNotFoundReason = typeof DomainPackLoadNotFoundReason.Type

/** The structured output: the load state plus the bounded body on success. */
export const DomainPackLoadOutput = Schema.Struct({
  state: Schema.Literals(["loaded", "already_loaded", "not_found"]),
  ref: Schema.String,
  reason: DomainPackLoadNotFoundReason.pipe(Schema.optional),
  pack: Schema.String.pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  type: Schema.String.pipe(Schema.optional),
  summary: Schema.String.pipe(Schema.optional),
  body: Schema.String.pipe(Schema.optional),
  token_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  truncated: Schema.Boolean.pipe(Schema.optional),
  total_chars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
})
export type DomainPackLoadOutput = typeof DomainPackLoadOutput.Type

export interface DomainPackLoadToolOptions {
  /** Store seam; the default resolves the gateway-configured user-global durable store. */
  readonly store?: StoreResolver
}

/** Compatibility test hook. Durable Session facts are never reset by a process-local call. */
export function resetDomainPackLoadState(): void {}

/** A ready-to-register `domain_pack_load` tool (permission `capability.read`, like the load family). */
export function makeDomainPackLoadTool(options: DomainPackLoadToolOptions = {}): Tool.AnyTool {
  const resolveStore = options.store ?? productionStoreResolver
  return Tool.withPermission(
    Tool.make({
      description:
        "Load the body of one active domain pack document found via pack_search (pass its ref). Bodies are bounded to ~600 tokens and at most 2 new documents load per turn; a document already loaded in this session returns as already_loaded. Never used to load a path, URL or arbitrary content.",
      input: DomainPackLoadInput,
      output: DomainPackLoadOutput,
      execute: (input, context) =>
        Effect.gen(function* () {
          const store = yield* Effect.try({
            try: () => resolveStore(),
            catch: (error) =>
              new ToolFailure({
                message: `Domain pack store is unavailable: ${error instanceof Error ? error.message : String(error)}`,
              }),
          })
          if (!store) return notFound(input.ref, "domain_pack_store_unavailable")
          const found = yield* Effect.try({
            try: () => findPackDoc(store, input.ref),
            catch: (error) =>
              new ToolFailure({
                message: `Domain pack document read failed: ${error instanceof Error ? error.message : String(error)}`,
              }),
          })
          if (!found) return notFound(input.ref, "domain_pack_document_unknown")
          if (found.doc.status !== "active") return notFound(input.ref, "domain_pack_document_not_active")
          const database = yield* Effect.serviceOption(Database.Service)
          const events = yield* Effect.serviceOption(EventV2.Service)
          if (database._tag === "None" || events._tag === "None")
            return yield* new ToolFailure({
              message: "Domain pack load quota requires the original Session database and event service",
            })
          const db = database.value.db
          const scope = and(
            eq(EventTable.aggregate_id, context.sessionID),
            eq(EventTable.type, EventV2.durableType(SessionToolQuota.Loaded)),
          )
          const loaded = yield* db
            .select({ id: EventTable.id })
            .from(EventTable)
            .where(and(scope, sql`json_extract(${EventTable.data}, '$.ref') = ${input.ref}`))
            .get()
            .pipe(Effect.orDie)
          if (
            !(yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(eq(SessionTable.id, context.sessionID))
              .get()
              .pipe(Effect.orDie))
          )
            return yield* new ToolFailure({ message: "Domain pack load requires a durable Session" })
          if (loaded) return loadedOutput(found, input.ref, "already_loaded", store)
          // The body read is outside the quota transaction; only the bounded fact and SQL enter it.
          const output = loadedOutput(found, input.ref, "loaded", store)
          const admitted = yield* events.value
            .publishChecked(
              SessionToolQuota.Loaded,
              {
                sessionID: context.sessionID,
                assistantMessageID: context.assistantMessageID,
                toolCallID: context.toolCallID,
                ref: input.ref,
              },
              {
                commit: () =>
                  Effect.gen(function* () {
                    if (
                      !(yield* db
                        .select({ id: SessionTable.id })
                        .from(SessionTable)
                        .where(eq(SessionTable.id, context.sessionID))
                        .get()
                        .pipe(Effect.orDie))
                    )
                      return yield* new ToolFailure({ message: "Domain pack load requires a durable Session" })
                    if (
                      yield* db
                        .select({ id: EventTable.id })
                        .from(EventTable)
                        .where(and(scope, sql`json_extract(${EventTable.data}, '$.ref') = ${input.ref}`))
                        .get()
                        .pipe(Effect.orDie)
                    )
                      return yield* new ToolFailure({ message: "DOMAIN_PACK_ALREADY_LOADED" })
                    const total = yield* db
                      .select({ value: count() })
                      .from(EventTable)
                      .where(scope)
                      .get()
                      .pipe(Effect.orDie)
                    if ((total?.value ?? 0) >= DomainPackLoadBudget.perSessionMaxLoaded)
                      return yield* new ToolFailure({ message: "Domain pack load capacity exhausted for this Session" })
                    const turn = yield* db
                      .select({ value: count() })
                      .from(EventTable)
                      .where(
                        and(
                          scope,
                          sql`json_extract(${EventTable.data}, '$.assistantMessageID') = ${context.assistantMessageID}`,
                        ),
                      )
                      .get()
                      .pipe(Effect.orDie)
                    if ((turn?.value ?? 0) >= DomainPackLoadBudget.perTurnMaxNew)
                      return yield* new ToolFailure({
                        message: `Domain pack load budget exhausted for this turn: at most ${DomainPackLoadBudget.perTurnMaxNew} new documents load per turn`,
                      })
                  }),
              },
            )
            .pipe(
              Effect.mapError((error) =>
                error.cause instanceof ToolFailure
                  ? error.cause
                  : new ToolFailure({ message: "Domain pack load quota is unavailable" }),
              ),
              Effect.result,
            )
          if (admitted._tag === "Success") return output
          if (admitted.failure.message === "DOMAIN_PACK_ALREADY_LOADED")
            return { ...output, state: "already_loaded" as const }
          return yield* admitted.failure
        }),
      toModelOutput: ({ output }) => [{ type: "text", text: renderLoadText(output) }],
    }),
    "capability.read",
  )
}

function notFound(ref: string, reason: DomainPackLoadNotFoundReason): DomainPackLoadOutput {
  return { state: "not_found", ref, reason }
}

function loadedOutput(
  found: NonNullable<ReturnType<typeof findPackDoc>>,
  ref: string,
  state: "loaded" | "already_loaded",
  store: Parameters<typeof findPackDoc>[0],
): DomainPackLoadOutput {
  const body = store.loadBody(ref) ?? ""
  const bounded = boundBody(body)
  return {
    state,
    ref,
    pack: found.pack,
    name: packDocName(found.doc),
    type: found.doc.type,
    summary: found.doc.description,
    body: bounded.text,
    token_count: Token.estimate(bounded.text),
    truncated: bounded.truncated,
    total_chars: body.length,
  }
}

function boundBody(body: string): { text: string; truncated: boolean } {
  if (body.length <= maxBodyChars) return { text: body, truncated: false }
  return { text: `${body.slice(0, maxBodyChars)}\n... (truncated, ${body.length} chars total)`, truncated: true }
}

function renderLoadText(output: DomainPackLoadOutput): string {
  switch (output.state) {
    case "not_found":
      return `Domain pack document not loadable: ${output.reason} (ref ${output.ref}).`
    case "already_loaded":
      return `${cardLine(output)} is already loaded in this session.\nDocument body:\n${output.body ?? ""}\n(~${output.token_count ?? 0} tokens).`
    case "loaded":
      return `${cardLine(output)}\nDocument body:\n${output.body ?? ""}\n(~${output.token_count ?? 0} tokens${output.truncated ? `, truncated from ${output.total_chars ?? 0} chars` : ""}).`
  }
}

function cardLine(output: DomainPackLoadOutput): string {
  return `[${output.pack ?? ""}] ${output.name ?? output.ref} (${output.type ?? "document"}) — ${output.summary ?? ""}`
}

/** Production registration (design §4.5): register `domain_pack_load` into the Location tool registry. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const gateway = yield* Effect.serviceOption(AgentGateway.Runtime)
    yield* tools
      .register({
        [name]: makeDomainPackLoadTool({
          store: () => (Option.isSome(gateway) ? gateway.value.withStorage(productionStoreResolver) : null),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
