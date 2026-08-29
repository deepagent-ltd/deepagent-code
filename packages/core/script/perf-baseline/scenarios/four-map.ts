import { SessionContextResolverV2, type QueryEnvelope } from "@deepagent-code/core/context-federation/resolver-v2"
import { stagedV2Adapters } from "@deepagent-code/core/context-federation/staged-adapters-v2"
import { ContextReference } from "@deepagent-code/core/context-federation/reference"
import { Effect } from "effect"
import { Recorder, timeEffect, type ScenarioOutcome } from "../lib"

// C7-06 successor of the alpha-era "four-map" inspection. The alpha snapshot
// (584d2ff) hardcoded GraphRevisions=v2-none in canonical-turn (the pre-C3-08
// state); since C3-08 the V2 canonical turn resolves through SessionContextResolverV2
// with the staged adapter set (explicit statuses per graph, never a v2-none
// committed value) until production graph sources are wired (C7-03 live matrix).
// What is measurable TODAY is that staged resolver path itself — the
// design-target federation cost proxy: resolution overhead + status assembly.

const ns = ContextReference.SecurityNamespaceID.make("v2:local")
const proj = ContextReference.ProjectScopeKey.make("v2:local")
const loc = ContextReference.LocationKey.make("loc_perf")

const envelope = (): QueryEnvelope => ({
  membership: { sessionId: "ses_perf", activityId: "act_perf", inputIds: [] },
  location: { locationKey: loc },
  principal: {
    securityNamespaceId: ns,
    principalId: "principal-perf",
    authorizationEpoch: 0,
    locationKeys: [loc],
    projectScopeKeys: [proj],
    sessionIds: ["ses_perf"],
    subjectIds: [],
    allowBuiltin: false,
  },
  workspace: { workspaceId: "ws_perf" },
  securityNamespace: { securityNamespaceId: ns },
  projectScope: { projectScopeKey: proj, projectId: "project-perf" },
  egress: { policyId: "v2:history-context", epoch: 0, graphs: ["code", "documents", "knowledge", "memory"], sensitivities: [] },
  agentPolicy: { agentId: "default", autonomyCeiling: "medium", permitDegraded: true },
  modelCapability: {
    modelId: "",
    providerId: "",
    protocol: "openai.responses",
    contextWindow: 0,
    structuredOutput: false,
  },
  releasedKnowledge: { snapshotId: "", binding: "unavailable" },
  queryIntent: "search",
  query: "session context",
  observedLocationMutationEpoch: 0,
})

export const runFourMapStatus = async (warmup = 15, measured = 60): Promise<ScenarioOutcome> => {
  const recorder = new Recorder()
  const adapters = stagedV2Adapters()
  for (let i = 0; i < warmup; i++) {
    void Effect.runPromise(SessionContextResolverV2.resolveGraphs(envelope(), adapters, 5_000))
  }
  let snapshot: Record<string, unknown> = {}
  for (let i = 0; i < measured; i++) {
    const [result, ms] = await Effect.runPromise(
      timeEffect(SessionContextResolverV2.resolveGraphs(envelope(), adapters, 5_000)),
    )
    recorder.add("four_graph_parallel_resolve_staged", ms)
    snapshot = result.graphStatuses
  }
  const statuses = Object.values(snapshot).map((entry) => (entry as { status: string }).status)
  return {
    name: "four-map-federation-status",
    owner_note:
      "C3-08 successor: V2 canonical turn resolves four graphs through SessionContextResolverV2 with stagedV2Adapters (explicit status per graph; no committed v2-none). Staged adapters report degraded_unavailable until live graph sources are wired (C7-03/live lane).",
    status: "ok",
    evidence_refs: [
      "packages/core/src/context-federation/resolver-v2.ts (resolveGraphs, per-graph bounded timeout, no v2-none fallback)",
      "packages/core/src/context-federation/staged-adapters-v2.ts (stagedV2Adapters)",
      "packages/core/src/session/runner/canonical-turn.ts (REAL four-graph selection, staged until C7)",
    ],
    duration_ms: 0,
    groups: recorder.results(),
    extras: {
      unit: "ms",
      graph_statuses: statuses,
      graph_count: statuses.length,
      staged_note:
        "degraded_unavailable is the honest staged state (no live graph sources wired); the resolver/status-assembly cost below is the real current federation overhead",
    },
  }
}
