export * as ContextStagedAdaptersV2 from "./staged-adapters-v2"

import { Effect } from "effect"
import type { GraphKind } from "../contract/selection"
import { AdapterVersion, type V2Adapter } from "./adapters-v2"

/**
 * C3-08 — staged (honest) V2 adapter set for the runner composition.
 *
 * The four-graph federation resolver (F1) is the single production selection writer, but the
 * production graph sources (code-intelligence, document store, released snapshot, durable memory)
 * are not yet wired into the location-scoped runner composition. So a V2 turn resolves each graph to
 * an explicit `degraded_unavailable` status with a bounded `source_disabled` reason — NEVER the
 * legacy v2-none fallback. This is honest: no graph was queried, the selection still has a real
 * content-addressed identity + validation, and once the real adapter set is wired (C7), the same
 * path yields real candidate refs. The adapter set is overridable by supplying a
 * `SessionContextResolverV2` service in the composition.
 */
export function stagedV2Adapters(): Readonly<Record<GraphKind, V2Adapter>> {
  const make = (graph: GraphKind): V2Adapter => ({
    graph,
    source: `${graph}:staged`,
    adapterVersion: AdapterVersion[graph],
    resolve: () =>
      Effect.succeed({
        candidates: [],
        revision: `${graph}:staged:0`,
        observedMutationEpoch: 0,
        available: false,
        unavailableReasonCode: "source_disabled",
      }),
  })
  return {
    code: make("code"),
    documents: make("documents"),
    knowledge: make("knowledge"),
    memory: make("memory"),
  }
}
