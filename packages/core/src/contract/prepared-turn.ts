export * as PreparedTurnContract from "./prepared-turn"

import { Schema } from "effect"
import { contentDigest } from "./digest"
import { ModelProtocol, ProtocolAttemptIdentity } from "./model-protocol"
import { SelectionEnvelope, SelectionIdentity, selectionDigest } from "./selection"

// C0-02 Phase 2 - Prepared provider turn contract (freeze base)
// Design authority: docs/core-v2.0-beta/design.md §4.1 (prepare order) and §4.2
// (state machine), plus worklist C2-04. Cross-references the frozen Phase 1
// selection contract imports (SelectionIdentity / SelectionEnvelope /
// selectionDigest) — the selection snapshot is exactly the SelectionEnvelope
// bound to this attempt.
// Pure-new contract module: not imported by any production module this wave.

/**
 * Version matrix for the prepared provider turn contract. `schema` is the
 * identity schema version (design §4.1). Numeric tags version the per-concept
 * enums (state, failed-terminal predicate, uncertainty reason, validation
 * outcome) so a removed/changed value bumps the tag.
 */
export const PreparedTurnVersion = {
  schema: "prepared-turn.v1",
  state: 1,
  failedTerminalPredicate: 1,
  uncertaintyReason: 1,
  validationOutcome: 1,
  finishReason: 1,
  providerTerminalEvidence: 1,
} as const

/**
 * Provider-turn state machine (design §4.2). Frozen to EXACTLY the vocabulary
 * used by the frozen Phase 1 recovery contract (RecoveryAttemptState in
 * recovery-command.ts) so the provider-turn vocabularies are consistent:
 * prepared | dispatching | streaming | settled | failed_terminal |
 * indeterminate_after_crash | abandoned_before_dispatch | resolved_abandoned |
 * resolved_settled | frozen_forked.
 */
export const PreparedTurnState = Schema.Literals([
  "prepared",
  "dispatching",
  "streaming",
  "settled",
  "failed_terminal",
  "indeterminate_after_crash",
  "abandoned_before_dispatch",
  "resolved_abandoned",
  "resolved_settled",
  "frozen_forked",
] as const)
export type PreparedTurnState = typeof PreparedTurnState.Type

/**
 * Closed set of the literal state vocabulary, exported so a cross-lane
 * consistency test can assert agreement with the recovery contract.
 */
export const PreparedTurnStateLiterals = [
  "prepared",
  "dispatching",
  "streaming",
  "settled",
  "failed_terminal",
  "indeterminate_after_crash",
  "abandoned_before_dispatch",
  "resolved_abandoned",
  "resolved_settled",
  "frozen_forked",
] as const

/**
 * Predicate that proves a failed_terminal turn can never produce a late result
 * (design §4.2). A terminal failure is only legal when the wire was never sent
 * or the provider synchronously rejected before admission; network-close, SSE
 * malformed, client cancel, timeout or no-finish are NOT terminal predicates.
 */
export const PreparedTurnFailedTerminalPredicate = Schema.Literals([
  "wire_never_sent",
  "provider_pre_admission_reject",
  "auth_pre_admission_reject",
  "param_pre_admission_reject",
] as const)
export type PreparedTurnFailedTerminalPredicate = typeof PreparedTurnFailedTerminalPredicate.Type

/**
 * Closed reason for an indeterminate-after-crash turn (design §4.2). An unknown
 * result is never promoted to a terminal state; it must enter recovery, keeping
 * the original result queryable.
 */
export const PreparedTurnUncertaintyReason = Schema.Literals([
  "network_unknown",
  "timeout",
  "stream_malformed",
  "client_cancel",
  "no_finish_seen",
] as const)
export type PreparedTurnUncertaintyReason = typeof PreparedTurnUncertaintyReason.Type

/**
 * Finish reason for a settled provider turn. Closed set so a consumer never
 * branches on free text.
 */
export const PreparedTurnFinishReason = Schema.Literals([
  "complete",
  "length",
  "tool_calls",
  "content_filter",
  "stop",
  "unknown",
] as const)
export type PreparedTurnFinishReason = typeof PreparedTurnFinishReason.Type

/**
 * Provider terminal evidence state (design §4.2, C1B-08). Mirrors the closed set
 * used by the recovery contract so a settled turn's provider evidence is
 * decodable by the recovery service.
 */
export const PreparedTurnProviderTerminalEvidence = Schema.Literals(["settled", "rejected", "unknown"] as const)
export type PreparedTurnProviderTerminalEvidence = typeof PreparedTurnProviderTerminalEvidence.Type

/**
 * Model provider route identity bound to the attempt (design §4.1 step 3, §5.1).
 * Carries the provider/model id and the protocol attempt identity so an exact
 * retry resolves to the same route/origin/protocol/lowering.
 */
export const PreparedProviderModelRoute = Schema.Struct({
  providerId: Schema.String,
  modelId: Schema.String,
  protocolIdentity: ProtocolAttemptIdentity,
})
export type PreparedProviderModelRoute = typeof PreparedProviderModelRoute.Type

/**
 * Capability catalog / domain-pack snapshot reference (design §4.1 steps 5 & 8).
 * Carries the catalog snapshot id and the body / runtime / permission hashes for
 * both the capability catalog and the active domain pack, plus the loaded
 * capability body hashes restored from the Context Epoch.
 */
export const PreparedCapabilitySnapshotRef = Schema.Struct({
  catalogSnapshotId: Schema.String,
  catalogBodyHash: Schema.String,
  catalogRuntimeHash: Schema.String,
  catalogPermissionHash: Schema.String,
  domainPackSnapshotId: Schema.String.pipe(Schema.optional),
  domainPackBodyHash: Schema.String.pipe(Schema.optional),
  domainPackRuntimeHash: Schema.String.pipe(Schema.optional),
  domainPackPermissionHash: Schema.String.pipe(Schema.optional),
  loadedCapabilities: Schema.Array(Schema.Struct({ capabilityId: Schema.String, bodyHash: Schema.String })),
})
export type PreparedCapabilitySnapshotRef = typeof PreparedCapabilitySnapshotRef.Type

/**
 * Model capability evidence bound to the attempt (design §4.1 step 3). A probe
 * result is a configuration action bound to endpoint origin, model id and the
 * response fingerprint — never an in-turn probe.
 */
export const PreparedModelCapabilityEvidence = Schema.Struct({
  modelId: Schema.String,
  providerId: Schema.String,
  protocol: ModelProtocol,
  capabilityFingerprint: Schema.String,
  contextWindow: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  structuredOutput: Schema.Boolean,
  probeRef: Schema.String.pipe(Schema.optional),
  probeResponseFingerprint: Schema.String.pipe(Schema.optional),
})
export type PreparedModelCapabilityEvidence = typeof PreparedModelCapabilityEvidence.Type

/**
 * Validation identity for the attempt (design §4.1 step 7, §6.3). Binds the
 * authorization / egress / location-mutation-epoch / released-knowledge binding
 * that was re-verified before dispatch. The outcome is a closed set and an
 * invalidated selection creates a selection successor before dispatch.
 */
export const PreparedValidationIdentity = Schema.Struct({
  validationId: Schema.String,
  outcome: Schema.Literals(["valid", "invalidated", "denied", "timeout"]),
  authorizationFingerprint: Schema.String,
  egressFingerprint: Schema.String,
  locationMutationEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  releasedKnowledgeBinding: Schema.Literals(["bound", "unavailable"]),
})
export type PreparedValidationIdentity = typeof PreparedValidationIdentity.Type

/**
 * Common identity fields for a PreparedProviderTurn (design §4.1 step 8).
 * Carries every exact-retry binding field: request hash, provider/model route
 * identity, the frozen SelectionEnvelope snapshot and SelectionIdentity,
 * selection digest, permission fingerprint, capability snapshot refs, route
 * origin hash, protocol lowering hash, model capability evidence and validation
 * identity. All stable fields — a retry re-derives the same identity.
 */
const preparedTurnCommon = {
  schemaVersion: Schema.Literal(PreparedTurnVersion.schema),
  turnId: Schema.String,
  attemptVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  requestHash: Schema.String,
  providerModelRoute: PreparedProviderModelRoute,
  selectionIdentity: SelectionIdentity,
  selection: SelectionEnvelope,
  selectionHash: Schema.String,
  permissionFingerprint: Schema.String,
  capabilitySnapshot: PreparedCapabilitySnapshotRef,
  routeOriginHash: Schema.String,
  protocolLoweringHash: Schema.String,
  modelCapabilityEvidence: PreparedModelCapabilityEvidence,
  validation: PreparedValidationIdentity,
}

/** Detail for a prepared (not yet dispatched) turn. */
export const PreparedTurnPreparedDetail = Schema.Struct({
  wireHash: Schema.String,
  sealedAt: Schema.String,
})
export type PreparedTurnPreparedDetail = typeof PreparedTurnPreparedDetail.Type

/** Detail for a dispatching turn (sealed wire request, single physical dispatch). */
export const PreparedTurnDispatchingDetail = Schema.Struct({
  wireHash: Schema.String,
  transportKey: Schema.String,
  dispatchEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  dispatchedAt: Schema.String,
})
export type PreparedTurnDispatchingDetail = typeof PreparedTurnDispatchingDetail.Type

/** Detail for an actively streaming turn. */
export const PreparedTurnStreamingDetail = Schema.Struct({
  wireHash: Schema.String,
  streamId: Schema.String,
  firstSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  transportKey: Schema.String,
})
export type PreparedTurnStreamingDetail = typeof PreparedTurnStreamingDetail.Type

/** Detail for a settled turn (terminal: a real result with provider evidence). */
export const PreparedTurnSettledDetail = Schema.Struct({
  responseHash: Schema.String,
  responseFingerprint: Schema.String,
  finishReason: PreparedTurnFinishReason,
  providerTerminalEvidence: PreparedTurnProviderTerminalEvidence,
  terminal: Schema.Literal("settled"),
})
export type PreparedTurnSettledDetail = typeof PreparedTurnSettledDetail.Type

/** Detail for a failed_terminal turn (proven to never produce a late result). */
export const PreparedTurnFailedTerminalDetail = Schema.Struct({
  predicate: PreparedTurnFailedTerminalPredicate,
  noLateResultProof: Schema.Literal(true),
})
export type PreparedTurnFailedTerminalDetail = typeof PreparedTurnFailedTerminalDetail.Type

/** Detail for an indeterminate turn (unknown result, must enter recovery). */
export const PreparedTurnIndeterminateDetail = Schema.Struct({
  uncertaintyReason: PreparedTurnUncertaintyReason,
  networkUnknown: Schema.Literal(true),
  originalHistoryRef: Schema.String,
})
export type PreparedTurnIndeterminateDetail = typeof PreparedTurnIndeterminateDetail.Type

/** Detail for an abandoned-before-dispatch turn (no physical dispatch). */
export const PreparedTurnAbandonedBeforeDispatchDetail = Schema.Struct({
  uncertaintyReason: PreparedTurnUncertaintyReason,
  safeBoundaryRef: Schema.String,
})
export type PreparedTurnAbandonedBeforeDispatchDetail = typeof PreparedTurnAbandonedBeforeDispatchDetail.Type

/** Detail for an abandoned resolution of an indeterminate turn. */
export const PreparedTurnResolvedAbandonedDetail = Schema.Struct({
  resolutionRef: Schema.String,
  bridgeRef: Schema.String,
  terminal: Schema.Literal("abandoned"),
  uncertaintyReason: PreparedTurnUncertaintyReason,
})
export type PreparedTurnResolvedAbandonedDetail = typeof PreparedTurnResolvedAbandonedDetail.Type

/** Detail for a settled resolution of an indeterminate turn (provider evidence). */
export const PreparedTurnResolvedSettledDetail = Schema.Struct({
  resolutionRef: Schema.String,
  bridgeRef: Schema.String,
  terminal: Schema.Literal("settled"),
  evidenceHash: Schema.String,
})
export type PreparedTurnResolvedSettledDetail = typeof PreparedTurnResolvedSettledDetail.Type

/** Detail for a frozen fork of an unrecoverable turn (original session read-only). */
export const PreparedTurnFrozenForkedDetail = Schema.Struct({
  forkRef: Schema.String,
  safeBoundaryRef: Schema.String,
  originalSessionReadOnly: Schema.Literal(true),
  forkManifestRef: Schema.String,
})
export type PreparedTurnFrozenForkedDetail = typeof PreparedTurnFrozenForkedDetail.Type

/** Member: turn is prepared and its identity computed; not yet dispatched. */
export class PreparedTurnPrepared extends Schema.Class<PreparedTurnPrepared>("PreparedTurn.Prepared")({
  ...preparedTurnCommon,
  state: Schema.Literal("prepared"),
  prepared: PreparedTurnPreparedDetail,
}) {}

/** Member: the sealed wire request is dispatching (single physical dispatch). */
export class PreparedTurnDispatching extends Schema.Class<PreparedTurnDispatching>("PreparedTurn.Dispatching")({
  ...preparedTurnCommon,
  state: Schema.Literal("dispatching"),
  dispatching: PreparedTurnDispatchingDetail,
}) {}

/** Member: the turn is streaming. */
export class PreparedTurnStreaming extends Schema.Class<PreparedTurnStreaming>("PreparedTurn.Streaming")({
  ...preparedTurnCommon,
  state: Schema.Literal("streaming"),
  streaming: PreparedTurnStreamingDetail,
}) {}

/** Member: the turn settled with a real result. */
export class PreparedTurnSettled extends Schema.Class<PreparedTurnSettled>("PreparedTurn.Settled")({
  ...preparedTurnCommon,
  state: Schema.Literal("settled"),
  settled: PreparedTurnSettledDetail,
}) {}

/** Member: the turn failed terminal (proven no late result). */
export class PreparedTurnFailedTerminal extends Schema.Class<PreparedTurnFailedTerminal>("PreparedTurn.FailedTerminal")({
  ...preparedTurnCommon,
  state: Schema.Literal("failed_terminal"),
  failedTerminal: PreparedTurnFailedTerminalDetail,
}) {}

/** Member: the turn is indeterminate after a crash (unknown result). */
export class PreparedTurnIndeterminate extends Schema.Class<PreparedTurnIndeterminate>("PreparedTurn.Indeterminate")({
  ...preparedTurnCommon,
  state: Schema.Literal("indeterminate_after_crash"),
  indeterminate: PreparedTurnIndeterminateDetail,
}) {}

/** Member: the turn was abandoned before dispatch. */
export class PreparedTurnAbandonedBeforeDispatch extends Schema.Class<PreparedTurnAbandonedBeforeDispatch>(
  "PreparedTurn.AbandonedBeforeDispatch",
)({
  ...preparedTurnCommon,
  state: Schema.Literal("abandoned_before_dispatch"),
  abandonedBeforeDispatch: PreparedTurnAbandonedBeforeDispatchDetail,
}) {}

/** Member: an indeterminate turn resolved as abandoned. */
export class PreparedTurnResolvedAbandoned extends Schema.Class<PreparedTurnResolvedAbandoned>(
  "PreparedTurn.ResolvedAbandoned",
)({
  ...preparedTurnCommon,
  state: Schema.Literal("resolved_abandoned"),
  resolvedAbandoned: PreparedTurnResolvedAbandonedDetail,
}) {}

/** Member: an indeterminate turn resolved as settled. */
export class PreparedTurnResolvedSettled extends Schema.Class<PreparedTurnResolvedSettled>("PreparedTurn.ResolvedSettled")({
  ...preparedTurnCommon,
  state: Schema.Literal("resolved_settled"),
  resolvedSettled: PreparedTurnResolvedSettledDetail,
}) {}

/** Member: an unrecoverable turn frozen into a fork (original session read-only). */
export class PreparedTurnFrozenForked extends Schema.Class<PreparedTurnFrozenForked>("PreparedTurn.FrozenForked")({
  ...preparedTurnCommon,
  state: Schema.Literal("frozen_forked"),
  frozenForked: PreparedTurnFrozenForkedDetail,
}) {}

/**
 * PreparedProviderTurn discriminant union (design §4.2). Discriminated on
 * `state`; each member carries its own state-specific detail. Frozen with no
 * default fallback (there is no v2-none equivalent): a turn must always be in a
 * real prepared/terminal/recovery state.
 */
export const PreparedProviderTurn = Schema.Union([
  PreparedTurnPrepared,
  PreparedTurnDispatching,
  PreparedTurnStreaming,
  PreparedTurnSettled,
  PreparedTurnFailedTerminal,
  PreparedTurnIndeterminate,
  PreparedTurnAbandonedBeforeDispatch,
  PreparedTurnResolvedAbandoned,
  PreparedTurnResolvedSettled,
  PreparedTurnFrozenForked,
]).pipe(Schema.toTaggedUnion("state"))
export type PreparedProviderTurn = typeof PreparedProviderTurn.Type

// ---- typed violations ------------------------------------------------------

/** Typed violation: an illegal turn decodes when a state/version field is unknown. */
export class PreparedTurnDecodeError extends Schema.TaggedErrorClass<PreparedTurnDecodeError>()(
  "PreparedTurn.DecodeError",
  { message: Schema.String, path: Schema.Array(Schema.String) },
) {}

export type PreparedTurnValidation =
  | { readonly ok: true; readonly value: PreparedProviderTurn }
  | { readonly ok: false; readonly error: PreparedTurnDecodeError }

function extractErrorPath(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const atIndex = message.indexOf("\n  at ")
  if (atIndex === -1) return []
  // Effect may emit several "at [...]" lines for a nested union member (e.g. an
  // unexpected-key sub-error followed by the deeper missing-key path). The most
  // specific reported path is the one with the most segments, so we return that
  // rather than the first line.
  let best: string[] = []
  for (const line of message.slice(atIndex).split("\n")) {
    if (!line.includes("[")) continue
    const segments: string[] = []
    const re = /\[([^\]]*)\]/g
    let current: RegExpExecArray | null
    while ((current = re.exec(line)) !== null) {
      const raw = current[1]!
      segments.push(raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw)
    }
    if (segments.length > best.length) best = segments
  }
  return best
}

/** Decode a PreparedProviderTurn. Extra properties are rejected. */
export const decodePreparedProviderTurn = (input: unknown): PreparedProviderTurn => {
  try {
    return Schema.decodeUnknownSync(PreparedProviderTurn, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new PreparedTurnDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode a PreparedProviderTurn to its schema-derived JSON shape. */
export const encodePreparedProviderTurn = (value: PreparedProviderTurn): PreparedProviderTurn =>
  Schema.encodeSync(PreparedProviderTurn)(value)

/** Non-throwing validation of a PreparedProviderTurn. */
export const validatePreparedProviderTurn = (input: unknown): PreparedTurnValidation => {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(PreparedProviderTurn, { onExcessProperty: "error" })(input) }
  } catch (error) {
    return {
      ok: false,
      error: new PreparedTurnDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) }),
    }
  }
}

/**
 * Enforce an exact retry against a newly derived identity. If the request hash,
 * route identity, selection hash, permission fingerprint, route-origin hash or
 * protocol-lowering hash drift from the recorded attempt, the retry is not an
 * exact retry and must be rejected with a typed error rather than reusing the
 * attempt identity.
 */
export class PreparedTurnMismatchError extends Schema.TaggedErrorClass<PreparedTurnMismatchError>()(
  "PreparedTurn.MismatchError",
  { cause: Schema.Literals(["request_hash", "route_identity", "selection", "permission", "route_origin", "protocol_lowering"]) },
) {}

/**
 * Assert a candidate identity is an exact retry of the recorded turn (design
 * §2.3, §4.1 step 8). Throws `PreparedTurnMismatchError` naming the first field
 * that drifted; an exact retry implies a byte-identical prepared identity.
 */
export const assertPreparedTurnExactRetry = (
  recorded: PreparedProviderTurn,
  candidate: {
    requestHash: string
    routeOriginHash: string
    protocolLoweringHash: string
    permissionFingerprint: string
    selectionHash: string
  },
): void => {
  if (candidate.requestHash !== recorded.requestHash) throw new PreparedTurnMismatchError({ cause: "request_hash" })
  if (candidate.routeOriginHash !== recorded.routeOriginHash) throw new PreparedTurnMismatchError({ cause: "route_origin" })
  if (candidate.protocolLoweringHash !== recorded.protocolLoweringHash) throw new PreparedTurnMismatchError({ cause: "protocol_lowering" })
  if (candidate.permissionFingerprint !== recorded.permissionFingerprint) throw new PreparedTurnMismatchError({ cause: "permission" })
  if (candidate.selectionHash !== recorded.selectionHash) throw new PreparedTurnMismatchError({ cause: "selection" })
}

/** Byte-stable canonical content digest of a PreparedProviderTurn (timestamp-independent). */
export const preparedTurnDigest = (value: PreparedProviderTurn): string => contentDigest(value)

/** Derive the selection hash of a turn's frozen SelectionEnvelope snapshot. */
export const preparedSelectionDigest = (selection: SelectionEnvelope): string => selectionDigest(selection)

/** Byte-stable canonical content digest of a PreparedValidationIdentity (timestamp-independent). */
export const preparedValidationDigest = (value: PreparedValidationIdentity): string => contentDigest(value)
