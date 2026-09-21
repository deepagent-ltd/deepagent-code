export * as DomainPackLoadTool from "./domain-pack-load-tool"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@deepagent-code/llm"
import { Tool } from "../tool/tool"
import { Tools } from "../tool/tools"
import { Token } from "../util/token"
import { domainPackLoadName } from "./capability-load-tool"
import {
  findPackDoc,
  packDocName,
  productionStoreResolver,
  type StoreResolver,
} from "./domain-pack-docs"

// P2-a (WS3 chain repair, docs/V2.0.1-001-llm-agent-system-manual.md §4.5): the production
// `domain_pack_load` tool — the L1 -> L2 link that makes the seeded domain-pack manual loadable by
// the model. The input is a single opaque `ref` (the durable DocumentStore doc id surfaced by
// `pack_search`; the model never names a path, URL or body). Execution resolves the doc in the
// user-global durable store, requires status `active` (a candidate/rejected/missing ref settles as
// a typed not_found, never a body), enforces the per-turn budget of 2 NEW documents
// (design §4.6, enforced as a ToolFailure) and returns the title/summary plus the body bounded to
// ~600 tokens.
//
// Load recording (design §4.5 "加载记录进 Context Epoch，同会话不重复加载"): capability_load
// records durable `session_capability_load` receipt rows whose frozen decode is capability-only
// (a domain-pack row would fail the receipt decode loudly), so this tool mirrors the semantics with
// a minimal SESSION-scoped loaded-set in module state — the same pattern the loader kernel uses
// (capability-loader-memory.ts turnBudgets). A ref already loaded in the session settles as
// `already_loaded` WITH the body and is never re-charged; NEW loads are charged to the turn keyed
// by the execute Context's assistantMessageID (one assistant message == one provider turn). The
// maps are process-local and keyed by globally unique session/message ids, so concurrent Locations
// cannot collide.

export const name = domainPackLoadName

/** Disclosure budget for one domain-pack document load (design §4.6). */
export const DomainPackLoadBudget = {
  perTurnMaxNew: 2,
  bodyMaxTokens: 600,
} as const

// Token.estimate uses 4 chars/token, so this many chars lands exactly on the token ceiling.
const maxBodyChars = DomainPackLoadBudget.bodyMaxTokens * 4

/** The model-facing input: the opaque durable doc ref from a `pack_search` card. */
export const DomainPackLoadInput = Schema.Struct({
  ref: Schema.String.check(Schema.isPattern(/^doc:\S+$/)),
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

// Session/turn load state (see the module header): sessionID -> refs loaded in the session;
// `${sessionID}::${assistantMessageID}` -> refs newly loaded in that turn.
const sessionLoaded = new Map<string, Set<string>>()
const turnCharged = new Map<string, Set<string>>()

/** Test hook: clear all session/turn load state (mirrors resetCapabilityLoader). */
export function resetDomainPackLoadState(): void {
  sessionLoaded.clear()
  turnCharged.clear()
}

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
          const loaded = sessionLoaded.get(context.sessionID)
          if (loaded?.has(input.ref)) return loadedOutput(found, input.ref, "already_loaded", store)
          const turnKey = `${context.sessionID}::${context.assistantMessageID}`
          const charged = turnCharged.get(turnKey) ?? new Set<string>()
          if (charged.size >= DomainPackLoadBudget.perTurnMaxNew)
            return yield* Effect.fail(
              new ToolFailure({
                message: `Domain pack load budget exhausted for this turn: at most ${DomainPackLoadBudget.perTurnMaxNew} new documents load per turn. Documents already loaded in this session can be re-loaded freely, or load this document in a later turn.`,
              }),
            )
          charged.add(input.ref)
          turnCharged.set(turnKey, charged)
          if (loaded) loaded.add(input.ref)
          else sessionLoaded.set(context.sessionID, new Set([input.ref]))
          return loadedOutput(found, input.ref, "loaded", store)
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
    yield* tools.register({ [name]: makeDomainPackLoadTool() }).pipe(Effect.orDie)
  }),
)
