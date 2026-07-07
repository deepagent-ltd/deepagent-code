import { Context, Effect, Layer } from "effect"
import type { DocumentStore } from "../document-store"
import { GraphQuery } from "../graph-query"
import type { ContextConfig, ContextConfigOverrides } from "./config"
import { resolveContextConfig } from "./config"
import type { Ledger } from "./ledger"
import { loadLedger } from "./ledger"
import type { WorkingSet, WorkingSetCandidate } from "./working-set"
import { assemble, anchorCandidates, ledgerRecall } from "./working-set"

// V3.8 Appendix-A C1/C2 (Stage 2) — the Curator service. It assembles the per-turn Working Set from:
//  - the session Ledger (task anchor + recall candidates), loaded from the run-scoped DocumentStore,
//  - relevance recall via the SHARED GraphQuery service (keyword/token, NO embeddings — decision #3),
//  - the caller-supplied near-field verbatim turns + active references,
// under the HARD 50% ceiling enforced in working-set.assemble.
//
// DEFAULT-SAFE (Phase 3 lesson): DocumentStore construction/reads throw SYNCHRONOUSLY (JSON.parse /
// readFileSync). Effect.catch recovers only typed errors, NOT defects, and catchAllCause is not in
// this build. So the "never fails into the session loop" guarantee is implemented with
// Effect.matchCauseEffect, which recovers the CAUSE (defects included). On ANY failure the Curator
// returns `undefined` (a signal to the caller to fall back to existing compaction) — it never throws.

export type CuratorRequest = {
  // The current task/step text used for relevance scoring (typically the latest user message + the
  // ledger's current `next`).
  readonly task: string
  // Run-scoped DocumentStore holding this session's ledger. Omitted -> anchor/recall come only from
  // an empty ledger (near-field still assembles). The Curator NEVER constructs a store itself.
  readonly store?: DocumentStore
  readonly sessionId: string
  // Model context window in tokens (for the budget). 0/unknown -> Curator returns undefined (fall
  // back), since a budget can't be computed.
  readonly contextTokens: number
  // Verbatim recent turns (already ordered oldest->newest by the caller). Each carries optional real
  // token counts (C5) and an isReasoning flag so reasoning is excluded.
  readonly nearField: readonly WorkingSetCandidate[]
  // Active references: latest version of files/tool outputs the current task touches.
  readonly references?: readonly WorkingSetCandidate[]
  // Workspace path for GraphQuery's project-store union (optional).
  readonly workspacePath?: string
  readonly configOverrides?: ContextConfigOverrides
}

export interface Interface {
  // Build the Working Set for this turn, or undefined if unconfigured/failed (caller falls back).
  readonly curate: (req: CuratorRequest) => Effect.Effect<WorkingSet | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/deepagent/context/Curator") {}

// GraphQuery recall over the ledger entries: pulls `ledger`-type hits scored by keyword/token
// similarity + graph distance, mapped to recall candidates. This is the "recall via GraphQuery" path
// (decision #3 — reuse the shared retrieval service, no parallel recall layer). Falls back to the
// in-ledger `ledgerRecall` scorer when GraphQuery returns nothing (e.g. knowledge-source unconfigured
// in a pure unit test), so recall still works over the loaded ledger.
const buildRecall = (
  graph: GraphQuery.Interface,
  req: CuratorRequest,
  ledger: Ledger,
  config: ContextConfig,
) =>
  Effect.gen(function* () {
    const result = yield* graph.query({
      ...(req.workspacePath ? { workspacePath: req.workspacePath } : {}),
      task: req.task,
      types: ["ledger"],
      limitPerType: config.recallLimit,
    })
    const anchorIds = new Set(anchorCandidates(ledger).map((c) => c.id))
    const hits = (result.byType["ledger"] ?? [])
      .filter((h) => !anchorIds.has(h.doc.id))
      .map(
        (h): WorkingSetCandidate => ({
          id: h.doc.id,
          kind: "recall",
          text: h.doc.body,
          score: h.score,
        }),
      )
    if (hits.length > 0) return hits
    // Fallback: score the loaded ledger locally (GraphQuery empty -> unconfigured knowledge-source).
    return ledgerRecall(ledger, req.task, config)
  })

const curateImpl = (graph: GraphQuery.Interface) => (req: CuratorRequest) =>
  Effect.gen(function* () {
    const config = resolveContextConfig(req.configOverrides)
    if (req.contextTokens <= 0) return undefined // can't budget -> fall back

    // Ledger load throws synchronously on a corrupt store; the whole gen is guarded below.
    const ledger = req.store ? loadLedger(req.store, req.sessionId) : { sessionId: req.sessionId, entries: [], updatedAt: Date.now() }
    const anchor = anchorCandidates(ledger)
    const recall = yield* buildRecall(graph, req, ledger, config)

    const nearField = req.nearField.slice(-config.nearFieldTurns)

    return assemble({
      contextTokens: req.contextTokens,
      config,
      anchor,
      nearField,
      references: req.references ?? [],
      recall,
    })
  }).pipe(
    // DEFAULT-SAFE: recover the CAUSE (defects from sync store throws included), never rethrow into
    // the session loop. Returns undefined -> caller keeps existing compaction behavior.
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(undefined),
      onSuccess: (ws) => Effect.succeed(ws),
    }),
  )

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const graph = yield* GraphQuery.Service
    return Service.of({ curate: curateImpl(graph) })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(GraphQuery.layer))
