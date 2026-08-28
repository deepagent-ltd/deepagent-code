import type { ScenarioOutcome } from "../lib"

export const FOUR_MAP_EVIDENCE_REFS = [
  "packages/core/src/session/runner/canonical-turn.ts:37 GraphRevisions constant (all four graphs = v2-none)",
  "packages/core/src/session/runner/canonical-turn.ts:28-31 comment: no federation graphs are queried yet",
] as const

/**
 * Four-graph federation status on this alpha.
 *
 * Inspection result (not a timed measurement): the V2 canonical turn does NOT
 * query the code/documents/knowledge/memory graphs at all — GraphRevisions in
 * packages/core/src/session/runner/canonical-turn.ts hardcodes every revision to
 * "v2-none", so today's four-graph phase is an unmeasurable-by-construction
 * no-op rather than a real adapter path worth timing. The only durable selection
 * work that exists on the dispatch chain (activity -> selection admission with
 * empty v2-local fingerprints) lives inside the serialized runner behind
 * SessionExecution placement and needs model-level wiring to reach.
 */
export const runFourMapStatus = async (): Promise<ScenarioOutcome> => ({
  name: "four-map-federation-status",
  owner_note:
    "current behavior classification by code inspection: V2 canonical turn owner commits v2-none for all four graphs; legacy runtime is the only graph-querying implementation today and is not reachable from the measured harness without provider wiring.",
  status: "unavailable",
  unavailable_reason:
    "no live four-graph query path exists in the current dispatch chain (v2-none fast path is hardcoded); timing it would measure nothing and could not be labeled as the design-target federation cost",
  evidence_refs: FOUR_MAP_EVIDENCE_REFS,
  duration_ms: 0,
  groups: [],
  extras: {
    unit: "n/a",
    status_now: "legacy-owned graphs; v2-none fast path hardcoded in canonical turn",
  },
})
