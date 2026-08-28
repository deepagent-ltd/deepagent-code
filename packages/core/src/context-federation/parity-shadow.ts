export * as ParityShadow from "./parity-shadow"

import { Context, Effect, Layer } from "effect"
import { Hash } from "../util/hash"
import { CanonicalJson } from "../util/canonical-json"
import { ContextFederationExecutionParity as ExecutionParity, type Observation } from "./execution-parity"
import type { SelectionRef, GraphKind, GraphStatus } from "../contract/selection"
import type { QueryResultV2 } from "./resolver-v2"
import { canonicalContextRef } from "./reference"

/**
 * C3-07 — recorded-transcript parity + side-effect-free shadow cohort.
 *
 * For the SAME input we record what the V2 resolver WOULD select versus what the recorded (legacy)
 * path actually selected. The comparison reuses the `execution-parity` Observation shape and augments
 * it with a selection-specific, explainable delta (added/removed refs) plus a per-graph status
 * mapping, and a deterministic SHA-256 hash that changes iff the input or the selection changes.
 *
 * Shadow mode runs the V2 resolver as a probe but NEVER dispatches the result: the counting
 * transport / tool seam is not invoked (zero Provider/tool side effects) and the recorded dispatched
 * selection is left untouched. No selection rows are written by a shadow run.
 *
 * Shadow switch: module-local typed flag, OFF by default. It is deliberately NOT registered in the
 * `RuntimeFeatures` manifest registry, because that registry is derived from the frozen capability
 * catalog and is fail-closed on any unknown feature — a non-manifested shadow flag would assert a
 * drift. See the F3 report for this divergence.
 */

// ---------------------------------------------------------------------------
// shadow switch (module-local, default OFF)
// ---------------------------------------------------------------------------

export const shadowMode = { enabled: false }

/** Flip the shadow switch for a test run. */
export function setShadowModeForTest(enabled: boolean) {
  shadowMode.enabled = enabled
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** The selection the recorded path dispatched (the baseline). */
export type SelectionSnapshot = {
  readonly selectedRefs: readonly SelectionRef[]
  readonly graphStatuses: Readonly<Record<GraphKind, GraphStatus>>
}

export type GraphStatusPair = {
  readonly recorded: GraphStatus["status"]
  readonly v2: GraphStatus["status"]
  readonly changed: boolean
}

export type RefsDelta = {
  /** Refs present in V2 but absent from the recorded selection. */
  readonly added: readonly string[]
  /** Refs present in the recorded selection but absent from V2. */
  readonly removed: readonly string[]
  readonly common: number
}

export type RecordedParity = {
  readonly observation: Observation
  readonly delta: RefsDelta
  readonly graphMapping: Readonly<Record<GraphKind, GraphStatusPair>>
  /** Deterministic content hash; changes iff the input or selection changes. */
  readonly hash: string
  readonly verdict: "match" | "differs"
}

export type ShadowOutcome =
  | { readonly mode: "off" }
  | { readonly mode: "shadow"; readonly parity: RecordedParity }

export type DispatchSeam = {
  /** Provider transport that a real dispatch would call. Suppressed in shadow. */
  readonly transport: () => Effect.Effect<void>
  /** Tool execution that a real dispatch would call. Suppressed in shadow. */
  readonly tool: () => Effect.Effect<void>
}

export type RunShadowInput = {
  readonly case: Observation["case"]
  readonly inputFingerprint: string
  readonly recorded: SelectionSnapshot
  readonly resolve: () => Effect.Effect<QueryResultV2>
  readonly dispatch: DispatchSeam
}

// ---------------------------------------------------------------------------
// parity builder (pure, deterministic, explainable)
// ---------------------------------------------------------------------------

/**
 * Build the parity record for the same input: compare the recorded selection against the V2 selection.
 * Pure / deterministic: identical inputs (inputFingerprint + both snapshots) produce an identical
 * record, and the hash changes iff either snapshot changes.
 */
export function buildRecordedParity(
  recorded: SelectionSnapshot,
  v2: SelectionSnapshot,
  case_: Observation["case"],
  inputFingerprint: string,
): RecordedParity {
  const delta = refsDelta(recorded.selectedRefs, v2.selectedRefs)
  const graphMapping = graphStatusMapping(recorded.graphStatuses, v2.graphStatuses)
  const parityHash = Hash.sha256(
    CanonicalJson.stringify({
      inputFingerprint,
      delta: { added: delta.added, removed: delta.removed, common: delta.common },
      graphMapping: graphStatusMappingFingerprint(graphMapping),
    }),
  )
  const observation: Observation = {
    case: case_,
    legacyRequestHash: inputFingerprint,
    coreV2RequestHash: inputFingerprint,
    legacyOutcomeHash: outcomeHash(recorded),
    coreV2OutcomeHash: outcomeHash(v2),
    evidence: ["real_session_replay"],
  }
  const verdict: RecordedParity["verdict"] =
    delta.added.length === 0 && delta.removed.length === 0 && noGraphChanged(graphMapping) ? "match" : "differs"
  return { observation, delta, graphMapping, hash: parityHash, verdict }
}

/** Build a selection snapshot from a V2 resolution result. */
export function snapshotFrom(result: QueryResultV2): SelectionSnapshot {
  return {
    selectedRefs: result.candidates.map((candidate) => ({
      graph: candidate.ref.graph,
      ref: canonicalContextRef(candidate.ref),
      token: candidate.title,
      score: 1,
      freshness: "current",
      sensitivity: sensitivityOf(candidate),
      reason: "v2_shadow",
    })),
    graphStatuses: result.graphStatuses,
  }
}

// ---------------------------------------------------------------------------
// shadow runner (Effect service)
// ---------------------------------------------------------------------------

export interface Interface {
  readonly runShadow: (input: RunShadowInput) => Effect.Effect<ShadowOutcome>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ParityShadow") {}

export const layer = Layer.succeed(
  Service,
  Service.of({ runShadow: shadowRun }),
)

function shadowRun(input: RunShadowInput): Effect.Effect<ShadowOutcome> {
  if (!shadowMode.enabled) {
    return Effect.succeed({ mode: "off" })
  }
  return Effect.gen(function* () {
    const result = yield* input.resolve()
    const v2 = snapshotFrom(result)
    const parity = buildRecordedParity(input.recorded, v2, input.case, input.inputFingerprint)
    // A shadow run resolves the V2 selection but NEVER dispatches it: the transport / tool seams are
    // intentionally not invoked, so the recorded dispatched selection is unaffected.
    return { mode: "shadow", parity }
  })
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function refsDelta(recorded: readonly SelectionRef[], v2: readonly SelectionRef[]): RefsDelta {
  const recordedSet = new Set(recorded.map((ref) => ref.ref))
  const v2Set = new Set(v2.map((ref) => ref.ref))
  const added = [...v2Set].filter((ref) => !recordedSet.has(ref))
  const removed = [...recordedSet].filter((ref) => !v2Set.has(ref))
  const common = [...v2Set].filter((ref) => recordedSet.has(ref)).length
  return { added: added.toSorted(), removed: removed.toSorted(), common }
}

function graphStatusMapping(
  recorded: Readonly<Record<GraphKind, GraphStatus>>,
  v2: Readonly<Record<GraphKind, GraphStatus>>,
): Record<GraphKind, GraphStatusPair> {
  const keys = new Set<GraphKind>([...Object.keys(recorded) as GraphKind[], ...Object.keys(v2) as GraphKind[]])
  return Object.fromEntries(
    [...keys].sort().map((graph) => {
      const recordedStatus = recorded[graph]?.status ?? "degraded_unavailable"
      const v2Status = v2[graph]?.status ?? "degraded_unavailable"
      return [graph, { recorded: recordedStatus, v2: v2Status, changed: recordedStatus !== v2Status }]
    }),
  ) as Record<GraphKind, GraphStatusPair>
}

function graphStatusMappingFingerprint(mapping: Readonly<Record<GraphKind, GraphStatusPair>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(mapping)
      .sort()
      .map((graph) => [graph, { recorded: mapping[graph as GraphKind].recorded, v2: mapping[graph as GraphKind].v2 }]),
  )
}

function noGraphChanged(mapping: Readonly<Record<GraphKind, GraphStatusPair>>): boolean {
  return Object.values(mapping).every((pair) => !pair.changed)
}

function outcomeHash(snapshot: SelectionSnapshot): string {
  return Hash.sha256(
    CanonicalJson.stringify({
      selected: snapshot.selectedRefs.map((ref) => ({ graph: ref.graph, ref: ref.ref })),
      graphStatuses: graphStatusesFingerprint(snapshot.graphStatuses),
    }),
  )
}

function graphStatusesFingerprint(statuses: Readonly<Record<GraphKind, GraphStatus>>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(statuses)
      .sort()
      .map((graph) => [graph, statuses[graph as GraphKind].status]),
  )
}

function sensitivityOf(candidate: QueryResultV2["candidates"][number]): SelectionRef["sensitivity"] {
  if (candidate.trust === "governed_guidance") return "public"
  return "source_code"
}
