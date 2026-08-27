export * as ModelProtocolContract from "./model-protocol"

import { Schema } from "effect"
import { contentDigest } from "./digest"

// C0-02 Phase 2 - Explicit model protocol contract (freeze base)
// Design authority: docs/core-v2.0-beta/design.md §5.1-5.3 (explicit model
// protocol), plus worklist C2-01/C2-04 (protocol/route/origin/capability/
// lowering fields that feed the prepared attempt identity).
// Pure-new contract module: not imported by any production module this wave.
//
// Cross-field coherence: this contract freezes the shape and the versioned enums,
// not cross-field rules. Coherence between fields (e.g. a `selectionState` of
// `disabled` implies a `disabledReason`; a `conflict` selection implies
// `model_protocol_selection_required`) is enforced by consumers / refinements
// on the V2 request path, NOT by the frozen shape.
//
// Invariant literals: fields frozen to an always-true literal (e.g.
// `noLocalSummaryFallback`, `historyStaysReadable`) are deliberate invariants.
// Changing their truth value is a semantic change that requires a schema-version
// successor per the C0-02 successor rule; it must not be re-frozen in place.

/**
 * Version matrix for the model protocol contract. `config` is the provider
 * config schema version, `catalog` the catalog-entry schema version, and
 * `compactRequest` / `compactReceipt` the remote-compact contract versions.
 * The numeric tags version the per-concept enums so an added value is a
 * backward-compatible successor and a removed/changed value bumps the tag.
 */
export const ModelProtocolVersion = {
  config: "model-protocol.v1",
  catalog: "model-catalog-entry.v1",
  compactRequest: "model-compact-request.v1",
  compactReceipt: "model-compact-receipt.v1",
  protocol: 1,
  capability: 1,
  transport: 1,
  route: 1,
  selectionKind: 1,
  selectionState: 1,
  disabledReason: 1,
  availability: 1,
  compactOutcome: 1,
  compactReason: 1,
} as const

/**
 * Explicit model protocol (design §5.1). Frozen closed union — an unknown
 * protocol is a typed decode error, never silently coerced. The runtime never
 * infers a protocol from a single HTTP error and never falls back within the
 * same attempt (design §5.1).
 */
export const ModelProtocol = Schema.Literals([
  "openai.responses",
  "openai-compatible.responses",
  "openai-compatible.chat",
  "anthropic.messages",
] as const)
export type ModelProtocol = typeof ModelProtocol.Type

/**
 * Stream transport for a protocol/endpoint (design §5.1 `stream_transport`).
 * Frozen closed set; an unknown transport is rejected.
 */
export const ModelStreamTransport = Schema.Literals([
  "http_sse",
  "http_chunked",
  "byte_stream",
  "none",
] as const)
export type ModelStreamTransport = typeof ModelStreamTransport.Type

/**
 * Capability set a protocol actually supports (design §5.1). Every capability
 * is a discriminated boolean so consumers branch on a small closed set rather
 * than probing the provider at request time. `protocolRevision` is the protocol
 * revision the capabilities were resolved against.
 */
export const ModelProtocolCapabilities = Schema.Struct({
  structuredOutput: Schema.Boolean,
  reasoningItems: Schema.Boolean,
  providerToolExecution: Schema.Boolean,
  previousResponseId: Schema.Boolean,
  remoteCompaction: Schema.Boolean,
  streamTransport: ModelStreamTransport,
  protocolRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type ModelProtocolCapabilities = typeof ModelProtocolCapabilities.Type

/**
 * Provider route / origin binding. A route identifies a resolvable dispatch
 * path for a provider; `routeId`/`originId` are stable ids, `endpointRef` is a
 * hash-addressed endpoint reference (never raw credentials), and
 * `protocolVersion` is the wire protocol version the origin speaks.
 */
export const ProviderRouteOrigin = Schema.Struct({
  routeId: Schema.String,
  originId: Schema.String,
  endpointRef: Schema.String,
  protocolVersion: Schema.String,
  region: Schema.String.pipe(Schema.optional),
})
export type ProviderRouteOrigin = typeof ProviderRouteOrigin.Type

/**
 * Endpoint / origin / capability / lowering version bindings (design §5.1,
 * C2-04). These bind a concrete resolved config to the versions that produced
 * it, so a prepared attempt identity is stable and a config drift is detected
 * before dispatch rather than silently changing the wire shape.
 */
export const ModelVersionBindings = Schema.Struct({
  endpointVersion: Schema.String,
  originVersion: Schema.String,
  capabilityVersion: Schema.String,
  loweringVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type ModelVersionBindings = typeof ModelVersionBindings.Type

/**
 * Source classification for the initial protocol migration (design §5.2).
 * `canonical_openai` -> `openai.responses`, `allowlisted_provider` ->
 * `openai-compatible.responses`, `openai_compatible` -> `openai-compatible.chat`
 * unless explicitly probed, `anthropic` -> `anthropic.messages`, and
 * `unknown` / `conflict` are disabled.
 */
export const ModelProtocolSelectionKind = Schema.Literals([
  "canonical_openai",
  "allowlisted_provider",
  "openai_compatible",
  "anthropic",
  "unknown",
  "conflict",
] as const)
export type ModelProtocolSelectionKind = typeof ModelProtocolSelectionKind.Type

/**
 * Resolution state of a protocol selection (design §5.2). `disabled` is the
 * only legal state for an unknown/conflict model: there is no inferred fallback,
 * and the caller must surface `model_protocol_selection_required`.
 */
export const ModelProtocolSelectionState = Schema.Literals(["selected", "probed", "disabled"] as const)
export type ModelProtocolSelectionState = typeof ModelProtocolSelectionState.Type

/**
 * Reason a protocol selection is disabled (design §5.2). A model whose source
 * classification is unknown/conflict is disabled with
 * `model_protocol_selection_required`; only a closed set of reasons is legal.
 */
export const ModelProtocolDisabledReason = Schema.Literals([
  "model_protocol_selection_required",
  "unknown_provider",
  "protocol_conflict",
  "capability_probe_failed",
] as const)
export type ModelProtocolDisabledReason = typeof ModelProtocolDisabledReason.Type

/**
 * Provider protocol configuration (design §5.1-5.2, C2-01). Carries the
 * explicit protocol, the source classification (selectionKind), the resolution
 * state (selectionState) and an optional disabled reason — a disabled config is
 * never silently mapped to a guessed protocol. Route/origin and version
 * bindings feed the prepared attempt identity.
 *
 * Probe evidence is NOT carried on the config: a capability probe is a
 * configuration action bound to endpoint origin, model id, time and response
 * fingerprint, and its evidence lives at the turn level
 * (PreparedModelCapabilityEvidence in prepared-turn.ts). The config carries only
 * the resolved outcome (selectionState) and the capability set it resolved
 * against.
 */
export class ModelProviderConfig extends Schema.Class<ModelProviderConfig>("ModelProtocol.ModelProviderConfig")({
  schemaVersion: Schema.Literal(ModelProtocolVersion.config),
  providerId: Schema.String,
  protocol: ModelProtocol,
  selectionKind: ModelProtocolSelectionKind,
  selectionState: ModelProtocolSelectionState,
  disabledReason: ModelProtocolDisabledReason.pipe(Schema.optional),
  routeOrigin: ProviderRouteOrigin,
  versionBindings: ModelVersionBindings,
  capabilities: ModelProtocolCapabilities,
}) {}

/**
 * Availability of a model in the catalog (design §5.2 allowlist / disabled).
 * Closed set: a model is never implicitly available via an unlisted value.
 */
export const ModelAvailability = Schema.Literals(["stable", "preview", "allowlisted", "disabled"] as const)
export type ModelAvailability = typeof ModelAvailability.Type

/**
 * Catalog entry binding a model id to an explicit protocol, route/origin, the
 * endpoint/origin/capability version bindings, the resolved capability set and
 * the context window (design §5.1-5.2). The catalog is the single source of
 * truth: the runtime does not infer a protocol from a one-off HTTP error.
 */
export class ModelCatalogEntry extends Schema.Class<ModelCatalogEntry>("ModelProtocol.ModelCatalogEntry")({
  schemaVersion: Schema.Literal(ModelProtocolVersion.catalog),
  modelId: Schema.String,
  providerId: Schema.String,
  protocol: ModelProtocol,
  availability: ModelAvailability,
  routeOrigin: ProviderRouteOrigin,
  versionBindings: ModelVersionBindings,
  capabilities: ModelProtocolCapabilities,
  contextWindow: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/**
 * Protocol attempt identity (design §5.1 + C2-04). This is the bounded set of
 * protocol/route/origin/capability/lowering fields that feed the prepared
 * attempt identity so an exact retry never changes the model protocol, context,
 * capability body or tool set mid-attempt. `endpointOriginHash` is a stable
 * hash of the route-origin binding and `capabilityFingerprint` a stable hash of
 * the resolved capability set.
 */
export const ProtocolAttemptIdentity = Schema.Struct({
  protocol: ModelProtocol,
  routeId: Schema.String,
  originId: Schema.String,
  endpointOriginHash: Schema.String,
  capabilityFingerprint: Schema.String,
  loweringVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  protocolRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type ProtocolAttemptIdentity = typeof ProtocolAttemptIdentity.Type

/**
 * Remote-compact request (design §5.3). Remote compaction always uses a
 * separate attempt and wire hash from the provider turn; it never mutates the
 * turn's own attempt identity.
 */
export class RemoteCompactRequest extends Schema.Class<RemoteCompactRequest>("ModelProtocol.RemoteCompactRequest")({
  schemaVersion: Schema.Literal(ModelProtocolVersion.compactRequest),
  compactAttemptId: Schema.String,
  sessionId: Schema.String,
  activityId: Schema.String,
  turnId: Schema.String,
  protocol: ModelProtocol,
  wireHash: Schema.String,
  requestHash: Schema.String,
  historyRef: Schema.String,
  originalHistoryRef: Schema.String,
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

/**
 * Reason a remote compact entered recovery (design §5.3). Never free text: an
 * unknown provider result is represented by a closed reason code so the caller
 * opens a compact recovery and keeps the original history readable.
 */
export const RemoteCompactRecoveryReason = Schema.Literals([
  "network_unknown",
  "timeout",
  "provider_error",
  "stream_interrupted",
  "response_id_missing",
] as const)
export type RemoteCompactRecoveryReason = typeof RemoteCompactRecoveryReason.Type

/**
 * Remote-compact settled outcome (design §5.3). A compact that genuinely
 * completed carries the provider response hash and the compacted history ref.
 */
export const RemoteCompactSettled = Schema.Struct({
  outcome: Schema.Literal("compacted"),
  responseHash: Schema.String,
  responseFingerprint: Schema.String,
  compactedHistoryRef: Schema.String,
  tokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type RemoteCompactSettled = typeof RemoteCompactSettled.Type

/**
 * Remote-compact recovery outcome (design §5.3). An unknown result must enter
 * compact recovery and keep the original history readable. There is deliberately
 * no "local summary success" member — a compact failure is never masked as a
 * local success (the `noLocalSummaryFallback` and `historyStaysReadable`
 * literals make that intent explicit at the schema level).
 */
export const RemoteCompactRecoveryRequired = Schema.Struct({
  outcome: Schema.Literal("recovery_required"),
  reasonCode: RemoteCompactRecoveryReason,
  retainedOriginalHistoryRef: Schema.String,
  historyStaysReadable: Schema.Literal(true),
  noLocalSummaryFallback: Schema.Literal(true),
})
export type RemoteCompactRecoveryRequired = typeof RemoteCompactRecoveryRequired.Type

/**
 * Remote-compact outcome discriminant union (design §5.3). Either the compact
 * settled with provider evidence, or it entered recovery — never a locally
 * invented success.
 */
export const RemoteCompactOutcome = Schema.Union([RemoteCompactSettled, RemoteCompactRecoveryRequired]).pipe(
  Schema.toTaggedUnion("outcome"),
)
export type RemoteCompactOutcome = typeof RemoteCompactOutcome.Type

/**
 * Remote-compact receipt (design §5.3). Binds a compact attempt to its wire
 * hash and outcome. The settled case carries provider evidence via the outcome;
 * the recovery case retains the original history ref so the pre-compact history
 * stays readable.
 */
export class RemoteCompactReceipt extends Schema.Class<RemoteCompactReceipt>("ModelProtocol.RemoteCompactReceipt")({
  schemaVersion: Schema.Literal(ModelProtocolVersion.compactReceipt),
  compactReceiptId: Schema.String,
  compactAttemptId: Schema.String,
  protocol: ModelProtocol,
  wireHash: Schema.String,
  outcome: RemoteCompactOutcome,
  originalHistoryRef: Schema.String,
  resultHash: Schema.String,
  completedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

// ---- typed violations ------------------------------------------------------

/** Typed violation: an illegal value decodes when a protocol/version field is unknown. */
export class ModelProtocolDecodeError extends Schema.TaggedErrorClass<ModelProtocolDecodeError>()(
  "ModelProtocol.DecodeError",
  { message: Schema.String, path: Schema.Array(Schema.String) },
) {}

/**
 * Typed violation: remote compact is not available for the request (design
 * §5.3). Remote compact is only legal on an explicit Responses route
 * (`openai.responses` or `openai-compatible.responses`) with the
 * remote-compaction capability enabled and a non-disabled selection state.
 */
export class RemoteCompactGateError extends Schema.TaggedErrorClass<RemoteCompactGateError>()(
  "ModelProtocol.RemoteCompactGateError",
  { protocol: Schema.String, reason: Schema.Literals(["not_responses_route", "capability_disabled", "selection_disabled"]) },
) {}

export type ModelProtocolValidation =
  | { readonly ok: true; readonly value: ModelProviderConfig }
  | { readonly ok: false; readonly error: ModelProtocolDecodeError }

function extractErrorPath(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const atIndex = message.indexOf("\n  at ")
  if (atIndex === -1) return []
  const lines = message.slice(atIndex).split("\n")
  // Effect may emit several "at [...]" lines for a union member: an
  // "Unexpected key" aggregation artifact plus the genuine location. The real
  // required-field absence is the line preceded by "Missing key", so we prefer
  // that so a missing member field reports its own path (e.g. ["packSnapshotRef"])
  // and not the artifact path. When there is no "Missing key" line we return the
  // most specific (most segments) reported path.
  type Entry = { seg: string[]; kind: "missing" | "other" }
  const entries: Entry[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.includes("[")) continue
    const segs: string[] = []
    const re = /\[([^\]]*)\]/g
    let current: RegExpExecArray | null
    while ((current = re.exec(line)) !== null) {
      const raw = current[1]!
      segs.push(raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw)
    }
    if (segs.length === 0) continue
    let kind: "missing" | "other" = "other"
    for (let j = i - 1; j >= 0; j--) {
      const upper = lines[j]!
      if (upper.startsWith("  at ") || upper.includes("[")) continue
      if (upper.includes("Missing key")) kind = "missing"
      break
    }
    entries.push({ seg: segs, kind })
  }
  if (entries.length === 0) return []
  const pool = entries.filter((e) => e.kind === "missing")
  const chosen = pool.length > 0 ? pool : entries
  let best = chosen[0]!.seg
  for (const e of chosen) {
    if (e.seg.length > best.length) best = e.seg
  }
  return best
}

/** Decode a ModelProviderConfig. Extra properties are rejected. */
export const decodeModelProviderConfig = (input: unknown): ModelProviderConfig => {
  try {
    return Schema.decodeUnknownSync(ModelProviderConfig, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new ModelProtocolDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode a ModelProviderConfig to its schema-derived JSON shape. */
export const encodeModelProviderConfig = (value: ModelProviderConfig): ModelProviderConfig =>
  Schema.encodeSync(ModelProviderConfig)(value)

/** Non-throwing validation for a ModelProviderConfig. */
export const validateModelProviderConfig = (input: unknown): ModelProtocolValidation => {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(ModelProviderConfig, { onExcessProperty: "error" })(input) }
  } catch (error) {
    return {
      ok: false,
      error: new ModelProtocolDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) }),
    }
  }
}

/** Decode a ModelCatalogEntry. Extra properties are rejected. */
export const decodeModelCatalogEntry = (input: unknown): ModelCatalogEntry => {
  try {
    return Schema.decodeUnknownSync(ModelCatalogEntry, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new ModelProtocolDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode a ModelCatalogEntry to its schema-derived JSON shape. */
export const encodeModelCatalogEntry = (value: ModelCatalogEntry): ModelCatalogEntry =>
  Schema.encodeSync(ModelCatalogEntry)(value)

/** Decode a RemoteCompactReceipt. Extra properties are rejected. */
export const decodeRemoteCompactReceipt = (input: unknown): RemoteCompactReceipt => {
  try {
    return Schema.decodeUnknownSync(RemoteCompactReceipt, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new ModelProtocolDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode a RemoteCompactReceipt to its schema-derived JSON shape. */
export const encodeRemoteCompactReceipt = (value: RemoteCompactReceipt): RemoteCompactReceipt =>
  Schema.encodeSync(RemoteCompactReceipt)(value)

/**
 * Enforce the remote-compact eligibility gate (design §5.3). Throws
 * `RemoteCompactGateError` when the protocol is not an explicit Responses route,
 * the remote-compaction capability is not enabled, or the config selection state
 * is disabled. A compact must never be attempted for an ineligible request.
 */
export const assertRemoteCompactEligible = (
  protocol: ModelProtocol,
  capabilities: ModelProtocolCapabilities,
  selectionState: ModelProtocolSelectionState,
): void => {
  const isResponsesRoute = protocol === "openai.responses" || protocol === "openai-compatible.responses"
  if (!isResponsesRoute) {
    throw new RemoteCompactGateError({ protocol, reason: "not_responses_route" })
  }
  if (!capabilities.remoteCompaction) {
    throw new RemoteCompactGateError({ protocol, reason: "capability_disabled" })
  }
  if (selectionState === "disabled") {
    throw new RemoteCompactGateError({ protocol, reason: "selection_disabled" })
  }
}

/** Byte-stable canonical content digest of a ModelProviderConfig (timestamp-independent). */
export const modelProviderConfigDigest = (value: ModelProviderConfig): string => contentDigest(value)

/** Byte-stable canonical content digest of a ModelCatalogEntry (timestamp-independent). */
export const modelCatalogEntryDigest = (value: ModelCatalogEntry): string => contentDigest(value)

/** Byte-stable canonical content digest of a ProtocolAttemptIdentity. */
export const protocolAttemptIdentityDigest = (value: ProtocolAttemptIdentity): string => contentDigest(value)

/** Byte-stable canonical content digest of a RemoteCompactRequest (as a request). */
export const remoteCompactRequestDigest = (value: RemoteCompactRequest): string => contentDigest(value)

/** Byte-stable canonical content digest of a RemoteCompactReceipt (timestamp-independent). */
export const remoteCompactReceiptDigest = (value: RemoteCompactReceipt): string => contentDigest(value)
