export * as SelectionContract from "./selection"

import { Schema } from "effect"
import { contentDigest } from "./digest"

// C0-02 Phase 1 - Selection contract (freeze base)
// Design authority: docs/core-v2.0-beta/design.md §6 (four-graph federation).
// Pure-new contract module: not imported by any production module this wave.

export const SelectionVersion = {
  schema: "context-selection.v1",
  graphStatus: 1,
  graphKind: 1,
  queryIntent: 1,
  reasonCode: 1,
} as const

/** The four federated graphs in authority order (design §6.1). */
export const GraphKindSchema = Schema.Literals(["code", "documents", "knowledge", "memory"])
export type GraphKind = typeof GraphKindSchema.Type

/**
 * Query intent for the context resolver. Bounded set: an unknown intent is a
 * typed decode error, never silently treated as a default.
 */
export const SelectionQueryIntent = Schema.Literals([
  "search",
  "recall",
  "related",
  "trace_evidence",
  "explain_decision",
  "find_conflicts",
])
export type SelectionQueryIntent = typeof SelectionQueryIntent.Type

/**
 * Bounded per-graph reason code carried by a graph that is not fully ready.
 * Frozen explicit closed union so consumers branch on a small set, not free text.
 */
export const GraphStatusReasonCode = Schema.Literals([
  "none",
  "cold_start",
  "bootstrap_complete_no_match",
  "bootstrap_budget_exhausted",
  "bootstrap_timeout",
  "fresh_timeout",
  "refresh_failed",
  "parser_unsupported",
  "lsp_unavailable",
  "overlay_unavailable",
  "scope_denied",
  "security_namespace_denied",
  "project_scope_denied",
  "agent_policy_denied",
  "model_capability_denied",
  "provider_egress_denied",
  "source_timeout",
  "source_error",
  "partial_sources",
  "source_disabled",
  "link_refresh_pending",
  "released_snapshot_unavailable",
])
export type GraphStatusReasonCode = typeof GraphStatusReasonCode.Type

/**
 * Per-graph status. The `status` field is a closed union
 * ready | empty | degraded | denied | timeout (design §6.2), so a V2 attempt can
 * never fall back to the legacy v2-none value: an absent or unknown graph must
 * be represented explicitly with one of these five states, and an unknown value
 * is rejected with a typed decode error.
 */
export const GraphStatus = Schema.Struct({
  graph: GraphKindSchema,
  status: Schema.Literals(["ready", "empty", "degraded", "denied", "timeout"]),
  revision: Schema.String,
  adapterVersion: Schema.String,
  observedMutationEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  latencyMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  candidateCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reasonCode: GraphStatusReasonCode.pipe(Schema.optional),
})
export type GraphStatus = typeof GraphStatus.Type

export const SelectionMembership = Schema.Struct({
  sessionId: Schema.String,
  activityId: Schema.String,
  inputIds: Schema.Array(Schema.String),
})
export type SelectionMembership = typeof SelectionMembership.Type

export const SelectionLocation = Schema.Struct({
  locationKey: Schema.String,
  workspaceId: Schema.String.pipe(Schema.optional),
})
export type SelectionLocation = typeof SelectionLocation.Type

export const SelectionPrincipal = Schema.Struct({
  principalId: Schema.String,
  authorizationEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type SelectionPrincipal = typeof SelectionPrincipal.Type

export const SelectionWorkspace = Schema.Struct({
  workspaceId: Schema.String,
  tenantId: Schema.String.pipe(Schema.optional),
})
export type SelectionWorkspace = typeof SelectionWorkspace.Type

export const SelectionSecurityNamespace = Schema.Struct({
  securityNamespaceId: Schema.String,
})
export type SelectionSecurityNamespace = typeof SelectionSecurityNamespace.Type

export const SelectionProjectScope = Schema.Struct({
  projectScopeKey: Schema.String,
  projectId: Schema.String.pipe(Schema.optional),
})
export type SelectionProjectScope = typeof SelectionProjectScope.Type

export const SelectionEgress = Schema.Struct({
  policyId: Schema.String,
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  graphs: Schema.Array(GraphKindSchema),
  sensitivities: Schema.Array(Schema.String),
})
export type SelectionEgress = typeof SelectionEgress.Type

export const SelectionAgentPolicy = Schema.Struct({
  agentId: Schema.String,
  autonomyCeiling: Schema.Literals(["low", "medium", "high", "critical"]),
  permitDegraded: Schema.Boolean,
})
export type SelectionAgentPolicy = typeof SelectionAgentPolicy.Type

export const SelectionModelCapability = Schema.Struct({
  modelId: Schema.String,
  providerId: Schema.String,
  protocol: Schema.Literals([
    "openai.responses",
    "openai-compatible.responses",
    "openai-compatible.chat",
    "anthropic.messages",
  ]),
  contextWindow: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  structuredOutput: Schema.Boolean,
})
export type SelectionModelCapability = typeof SelectionModelCapability.Type

export const SelectionReleasedKnowledge = Schema.Struct({
  snapshotId: Schema.String,
  binding: Schema.Literal("current"),
  supersedes: Schema.String.pipe(Schema.optional),
})
export type SelectionReleasedKnowledge = typeof SelectionReleasedKnowledge.Type

/**
 * Deterministic selection + validation identity for exact-retry binding
 * (design §2.3, §4.1 step 8). Only stable fields (no wall-clock timestamp, no
 * absolute path), so a retry re-derives it and hashes it to a stable digest.
 */
export const SelectionIdentity = Schema.Struct({
  selectionId: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  queryFingerprint: Schema.String,
  authorizationFingerprint: Schema.String,
  executionFingerprint: Schema.String,
  observedLocationMutationEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  selectedSourceFingerprint: Schema.String,
})
export type SelectionIdentity = typeof SelectionIdentity.Type

export const SelectionValidation = Schema.Struct({
  validationId: Schema.String,
  outcome: Schema.Literals(["valid", "invalidated", "denied", "timeout"]),
  validUntil: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type SelectionValidation = typeof SelectionValidation.Type

export const SelectionRef = Schema.Struct({
  graph: GraphKindSchema,
  ref: Schema.String,
  token: Schema.String,
  score: Schema.Finite,
  freshness: Schema.Literals(["current", "historical", "expired", "superseded", "conflict", "unknown"]),
  sensitivity: Schema.String,
  reason: Schema.String,
})
export type SelectionRef = typeof SelectionRef.Type

export const SelectionArtifactAvailable = Schema.Struct({
  status: Schema.Literal("available"),
  ref: Schema.String,
})
export type SelectionArtifactAvailable = typeof SelectionArtifactAvailable.Type

export const SelectionArtifactDegraded = Schema.Struct({
  status: Schema.Literal("degraded_unavailable"),
  inlineAudit: Schema.String,
})
export type SelectionArtifactDegraded = typeof SelectionArtifactDegraded.Type

export const SelectionArtifactBinding = Schema.Union([SelectionArtifactAvailable, SelectionArtifactDegraded])
export type SelectionArtifactBinding = typeof SelectionArtifactBinding.Type

/**
 * V2 context selection envelope (design §6.1-6.3), the root contract Phase 2
 * Lane P references as `SelectionEnvelope`. `selectionMode` is the single
 * literal "v2": a V2 attempt must always be backed by a real four-graph
 * selection, and the legacy v2-none fallback is not a legal value here. Absence
 * of a graph is expressed per graph (empty / degraded / denied / timeout),
 * never as a default "none" at the envelope level.
 */
export class SelectionEnvelope extends Schema.Class<SelectionEnvelope>("ContextSelection.SelectionEnvelope")({
  schemaVersion: Schema.Literal(SelectionVersion.schema),
  selectionMode: Schema.Literal("v2"),
  selectionId: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  triggerInputId: Schema.String,
  membership: SelectionMembership,
  location: SelectionLocation,
  principal: SelectionPrincipal,
  workspace: SelectionWorkspace,
  securityNamespace: SelectionSecurityNamespace,
  projectScope: SelectionProjectScope,
  egress: SelectionEgress,
  agentPolicy: SelectionAgentPolicy,
  modelCapability: SelectionModelCapability,
  releasedKnowledge: SelectionReleasedKnowledge,
  queryIntent: SelectionQueryIntent,
  identity: SelectionIdentity,
  validation: SelectionValidation,
  graphStatuses: Schema.Record(GraphKindSchema, GraphStatus),
  selectedRefs: Schema.Array(SelectionRef),
  projectionHash: Schema.String,
  tokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  artifactBinding: SelectionArtifactBinding,
}) {}

/** Typed decode error carrying the offending JSON path (e.g. ["graphStatuses"]["code"]["status"]). */
export class SelectionDecodeError extends Schema.TaggedErrorClass<SelectionDecodeError>()(
  "SelectionContract.DecodeError",
  {
    message: Schema.String,
    path: Schema.Array(Schema.String),
  },
) {}

export type SelectionValidationResult =
  | { readonly ok: true; readonly value: SelectionEnvelope }
  | { readonly ok: false; readonly error: SelectionDecodeError }

/** Extract the bracket path segments from an Effect Schema decode error message. */
function extractErrorPath(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const atIndex = message.indexOf("\n  at ")
  if (atIndex === -1) return []
  const lineStart = atIndex + 6
  const lineEnd = message.indexOf("\n", lineStart)
  const tail = lineEnd === -1 ? message.slice(lineStart) : message.slice(lineStart, lineEnd)
  const segments: string[] = []
  const re = /\[([^\]]*)\]/g
  let current: RegExpExecArray | null
  while ((current = re.exec(tail)) !== null) {
    const raw = current[1]!
    segments.push(raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw)
  }
  return segments
}

/**
 * Decode a SelectionEnvelope from unknown input. Extra properties are rejected.
 * On failure it throws a typed SelectionDecodeError carrying the exact path.
 */
export const decodeSelectionEnvelope = (input: unknown): SelectionEnvelope => {
  try {
    return Schema.decodeUnknownSync(SelectionEnvelope, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new SelectionDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode a SelectionEnvelope to its schema-derived JSON shape. Round-trips with decodeSelectionEnvelope. */
export const encodeSelectionEnvelope = (value: SelectionEnvelope): SelectionEnvelope => Schema.encodeSync(SelectionEnvelope)(value)

/** Non-throwing validation: ok/true+value on success, or the typed decode error. */
export const validateSelection = (input: unknown): SelectionValidationResult => {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(SelectionEnvelope, { onExcessProperty: "error" })(input) }
  } catch (error) {
    return {
      ok: false,
      error: new SelectionDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) }),
    }
  }
}

/**
 * Byte-stable canonical content digest (SHA-256) of a SelectionEnvelope.
 * Canonical over key order and independent of timestamps and absolute paths.
 */
export const selectionDigest = (value: SelectionEnvelope): string => contentDigest(value)
