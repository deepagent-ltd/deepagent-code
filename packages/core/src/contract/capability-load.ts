export * as CapabilityLoadContract from "./capability-load"

import { Schema } from "effect"
import { contentDigest } from "./digest"

// C0-02 Phase 2 - Capability / domain-pack load contract (freeze base)
// Design authority: docs/core-v2.0-beta/design.md §7.2-7.3 (manifest shape & the
// three-level disclosure budgets), §7.4 (loader input & tagged union) and §7.5
// (durable receipt + exact retry). Plus design §13 hard budgets: L0 <=4096
// bytes/700 tokens, L2 single <=1200 tokens, per turn <=2 new / 2400 tokens.
// Pure-new contract module: not imported by any production module this wave.

/**
 * Version matrix for the capability-load contract. `receipt` is the durable
 * load receipt schema version (`session_capability_load` /
 * `domain_pack_load`), `request` is the loader request schema version.
 * Numeric tags version the per-concept enums (level, state, denied/disabled/
 * not-found reasons, budget state).
 */
export const CapabilityLoadVersion = {
  receipt: "capability-load.v1",
  request: "capability-load-request.v1",
  level: 1,
  state: 1,
  deniedReason: 1,
  disabledReason: 1,
  notFoundReason: 1,
  budgetState: 1,
  loadReason: 1,
} as const

/**
 * The three-level disclosure tiers (design §7.3): L0 boot catalog, L1 search
 * card, L2 procedure body. A frozen closed set.
 */
export const CapabilityLevel = Schema.Literals(["L0", "L1", "L2"] as const)
export type CapabilityLevel = typeof CapabilityLevel.Type

/**
 * Frozen budget limits (design §7.3, §13). L0 is capped at 4096 bytes / 700
 * tokens; a single L2 body at 1200 tokens; and a provider turn may load at most
 * 2 new L2 bodies / 2400 new L2 tokens. Encoded as exact literals so a contract
 * that drifts from the freeze fails to decode.
 */
export const CapabilityBudgetLimits = Schema.Struct({
  l0MaxBytes: Schema.Literal(4096),
  l0MaxTokens: Schema.Literal(700),
  l2SingleMaxTokens: Schema.Literal(1200),
  l2PerTurnMaxNew: Schema.Literal(2),
  l2PerTurnMaxNewTokens: Schema.Literal(2400),
})
export type CapabilityBudgetLimits = typeof CapabilityBudgetLimits.Type

/**
 * Why a body is being loaded. Bounded closed set — never free text — so a
 * consumer can reason about the load without a prose reason.
 */
export const CapabilityLoadReason = Schema.Literals([
  "operation_guidance",
  "feature_execution",
  "investigation",
  "procedure_step",
  "context_augmentation",
  "domain_knowledge_required",
] as const)
export type CapabilityLoadReason = typeof CapabilityLoadReason.Type

/**
 * Loader request (design §7.4 `capability_load` input). The loader only reads
 * signed bundles or trusted user packs; it never accepts an arbitrary path/URL
 * from the model. `expectedActions` are action refs (identifiers), not prose.
 */
export const CapabilityLoadRequest = Schema.Struct({
  schemaVersion: Schema.Literal(CapabilityLoadVersion.request),
  capabilityId: Schema.String,
  catalogSnapshotId: Schema.String,
  reason: CapabilityLoadReason,
  expectedActions: Schema.Array(Schema.String),
})
export type CapabilityLoadRequest = typeof CapabilityLoadRequest.Type

/** Closed set of denied reasons (design §7.6: capability content is not permission). */
export const CapabilityLoadDeniedReason = Schema.Literals([
  "permission_scope_denied",
  "security_namespace_denied",
  "egress_denied",
  "agent_policy_denied",
] as const)
export type CapabilityLoadDeniedReason = typeof CapabilityLoadDeniedReason.Type

/** Closed set of disabled reasons (design §7.6: not-yet-complete capabilities are not advertised). */
export const CapabilityLoadDisabledReason = Schema.Literals([
  "maintenance_only",
  "disabled",
  "unavailable",
  "incompatible_runtime",
] as const)
export type CapabilityLoadDisabledReason = typeof CapabilityLoadDisabledReason.Type

/** Closed set of not-found reasons (design §7.4). */
export const CapabilityNotFoundReason = Schema.Literals([
  "capability_unregistered",
  "domain_pack_not_active",
  "catalog_snapshot_mismatch",
] as const)
export type CapabilityNotFoundReason = typeof CapabilityNotFoundReason.Type

/** Budget state for a turn (design §7.3, §13). */
export const CapabilityBudgetState = Schema.Literals(["within", "at_limit", "exceeded"] as const)
export type CapabilityBudgetState = typeof CapabilityBudgetState.Type

/** Permission binding for the load (design §7.5). Never expands permissions. */
export const ContentPermissionBinding = Schema.Struct({
  permissionFingerprint: Schema.String,
  required: Schema.Array(Schema.String),
  granted: Schema.Array(Schema.String),
})
export type ContentPermissionBinding = typeof ContentPermissionBinding.Type

/** Loaded state: the body was loaded this call (design §7.4). */
export const ContentLoadLoaded = Schema.Struct({
  state: Schema.Literal("loaded"),
  bodyRef: Schema.String,
  tokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  byteCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  supersedes: Schema.String.pipe(Schema.optional),
})
export type ContentLoadLoaded = typeof ContentLoadLoaded.Type

/** Already-loaded state: the exact body is already present (design §7.4). */
export const ContentLoadAlreadyLoaded = Schema.Struct({
  state: Schema.Literal("already_loaded"),
  bodyRef: Schema.String,
})
export type ContentLoadAlreadyLoaded = typeof ContentLoadAlreadyLoaded.Type

/** Denied state (design §7.4, §7.6). */
export const ContentLoadDenied = Schema.Struct({
  state: Schema.Literal("denied"),
  reasonCode: CapabilityLoadDeniedReason,
})
export type ContentLoadDenied = typeof ContentLoadDenied.Type

/** Disabled state (design §7.4, §7.6). */
export const ContentLoadDisabled = Schema.Struct({
  state: Schema.Literal("disabled"),
  reasonCode: CapabilityLoadDisabledReason,
})
export type ContentLoadDisabled = typeof ContentLoadDisabled.Type

/** Incompatible state: the runtime does not satisfy the manifest requirements. */
export const ContentLoadIncompatible = Schema.Struct({
  state: Schema.Literal("incompatible"),
  runtimeRequired: Schema.String,
  runtimeFound: Schema.String,
})
export type ContentLoadIncompatible = typeof ContentLoadIncompatible.Type

/** Not-found state (design §7.4). */
export const ContentLoadNotFound = Schema.Struct({
  state: Schema.Literal("not_found"),
  reasonCode: CapabilityNotFoundReason,
})
export type ContentLoadNotFound = typeof ContentLoadNotFound.Type

/** Budget-exceeded state (design §7.3, §13). */
export const ContentLoadBudgetExceeded = Schema.Struct({
  state: Schema.Literal("budget_exceeded"),
  level: CapabilityLevel,
  limitTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  requestedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limitNewPerTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  newThisTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ContentLoadBudgetExceeded = typeof ContentLoadBudgetExceeded.Type

/**
 * Tagged state of a load (design §7.4 output union): loaded | already_loaded |
 * denied | disabled | incompatible | not_found | budget_exceeded. Frozen closed
 * union (design §7.4), so an unknown state is a typed decode error.
 */
export const ContentLoadState = Schema.Union([
  ContentLoadLoaded,
  ContentLoadAlreadyLoaded,
  ContentLoadDenied,
  ContentLoadDisabled,
  ContentLoadIncompatible,
  ContentLoadNotFound,
  ContentLoadBudgetExceeded,
]).pipe(Schema.toTaggedUnion("state"))
export type ContentLoadState = typeof ContentLoadState.Type

/** Common durable-receipt fields for a session content load (design §7.5). */
const contentLoadCommon = {
  schemaVersion: Schema.Literal(CapabilityLoadVersion.receipt),
  loadId: Schema.String,
  sessionId: Schema.String,
  activityId: Schema.String,
  turnId: Schema.String,
  catalogSnapshotId: Schema.String,
  packId: Schema.String.pipe(Schema.optional),
  version: Schema.String,
  bodyHash: Schema.String,
  runtimeHash: Schema.String,
  permissionHash: Schema.String,
  permissionBinding: ContentPermissionBinding,
  runtimeCompatibilityHash: Schema.String,
  requestHash: Schema.String,
  resultHash: Schema.String,
  level: CapabilityLevel,
  bodyRef: Schema.String,
  supersedes: Schema.String.pipe(Schema.optional),
  tokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  byteCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  budgetState: CapabilityBudgetState,
  newLoadsThisTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  newTokensThisTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contextEpoch: Schema.String,
  loadedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: ContentLoadState,
}

/**
 * Durable capability load receipt `session_capability_load` (design §7.5).
 * Carries the load/session/activity/turn identity, catalog snapshot, body /
 * runtime / permission hashes, permission + runtime binding, request/result
 * hash (so an exact retry returns the same receipt + body hash), the tagged
 * state and the budget state. `loadedAt` is audit-only and excluded from the
 * content digest.
 */
export class CapabilityLoadReceipt extends Schema.Class<CapabilityLoadReceipt>("CapabilityLoad.Receipt")({
  ...contentLoadCommon,
  contentKind: Schema.Literal("capability"),
}) {}

/**
 * Durable domain-pack load receipt `domain_pack_load` (design §7.4-7.5). It
 * reuses the same durable loader kernel and state union as the capability load,
 * but the pack ref must belong to the current active pack snapshot; that binding
 * is carried by `packSnapshotRef` / `activePackSnapshotHash` and the
 * `refBelongsToActiveSnapshot` literal (enforced at the schema level).
 */
export class DomainPackLoadReceipt extends Schema.Class<DomainPackLoadReceipt>("CapabilityLoad.DomainPackReceipt")({
  ...contentLoadCommon,
  contentKind: Schema.Literal("domain_pack"),
  packSnapshotRef: Schema.String,
  activePackSnapshotHash: Schema.String,
  refBelongsToActiveSnapshot: Schema.Literal(true),
}) {}

/**
 * Session content load discriminant union (design §7.4-7.5): a capability load
 * or a domain-pack load, both reusing the same kernel and tagged state.
 */
export const SessionContentLoad = Schema.Union([CapabilityLoadReceipt, DomainPackLoadReceipt]).pipe(
  Schema.toTaggedUnion("contentKind"),
)
export type SessionContentLoad = typeof SessionContentLoad.Type

// ---- typed violations ------------------------------------------------------

/** Typed violation: an illegal load receipt decodes when a state/version field is unknown. */
export class CapabilityLoadDecodeError extends Schema.TaggedErrorClass<CapabilityLoadDecodeError>()(
  "CapabilityLoad.DecodeError",
  { message: Schema.String, path: Schema.Array(Schema.String) },
) {}

/** Typed violation: loading an exact retry when the capability body is absent from the bundle. */
export class MissingCapabilityBodyError extends Schema.TaggedErrorClass<MissingCapabilityBodyError>()(
  "CapabilityLoad.MissingBodyError",
  { capabilityId: Schema.String, bodyRef: Schema.String },
) {}

/** Typed violation: a loaded capability supersedes another and is not an exact retry. */
export class SupersededCapabilityError extends Schema.TaggedErrorClass<SupersededCapabilityError>()(
  "CapabilityLoad.SupersededError",
  { capabilityId: Schema.String, supersedingRef: Schema.String },
) {}

/** Typed violation: the request exceeds a frozen budget limit (design §7.3, §13). */
export class BudgetExceededError extends Schema.TaggedErrorClass<BudgetExceededError>()(
  "CapabilityLoad.BudgetExceededError",
  { level: CapabilityLevel, limitTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), requestedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) },
) {}

export type CapabilityLoadValidation =
  | { readonly ok: true; readonly value: CapabilityLoadReceipt }
  | { readonly ok: false; readonly error: CapabilityLoadDecodeError }

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

/** Decode a CapabilityLoadReceipt. Extra properties are rejected. */
export const decodeCapabilityLoadReceipt = (input: unknown): CapabilityLoadReceipt => {
  try {
    return Schema.decodeUnknownSync(CapabilityLoadReceipt, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new CapabilityLoadDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode a CapabilityLoadReceipt to its schema-derived JSON shape. */
export const encodeCapabilityLoadReceipt = (value: CapabilityLoadReceipt): CapabilityLoadReceipt =>
  Schema.encodeSync(CapabilityLoadReceipt)(value)

/** Decode a DomainPackLoadReceipt. Extra properties are rejected. */
export const decodeDomainPackLoadReceipt = (input: unknown): DomainPackLoadReceipt => {
  try {
    return Schema.decodeUnknownSync(DomainPackLoadReceipt, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new CapabilityLoadDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode a DomainPackLoadReceipt to its schema-derived JSON shape. */
export const encodeDomainPackLoadReceipt = (value: DomainPackLoadReceipt): DomainPackLoadReceipt =>
  Schema.encodeSync(DomainPackLoadReceipt)(value)

/** Decode a SessionContentLoad (capability | domain_pack). Extra properties are rejected. */
export const decodeSessionContentLoad = (input: unknown): SessionContentLoad => {
  try {
    return Schema.decodeUnknownSync(SessionContentLoad, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new CapabilityLoadDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode a SessionContentLoad to its schema-derived JSON shape. */
export const encodeSessionContentLoad = (value: SessionContentLoad): SessionContentLoad =>
  Schema.encodeSync(SessionContentLoad)(value)

/** Non-throwing validation of a CapabilityLoadReceipt. */
export const validateCapabilityLoadReceipt = (input: unknown): CapabilityLoadValidation => {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(CapabilityLoadReceipt, { onExcessProperty: "error" })(input) }
  } catch (error) {
    return {
      ok: false,
      error: new CapabilityLoadDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) }),
    }
  }
}

/**
 * Enforce an exact retry: the same request hash must produce the same loaded
 * snapshot (design §7.5). If the request hash matches but the body hash drifts,
 * it is not an exact retry and is a typed conflict rather than a reuse.
 */
export class ContentLoadRetryMismatchError extends Schema.TaggedErrorClass<ContentLoadRetryMismatchError>()(
  "CapabilityLoad.RetryMismatchError",
  { cause: Schema.Literals(["request_hash", "body_hash", "snapshot_id"]) },
) {}

/**
 * Assert an exact retry against the previously recorded request/result identity
 * (design §7.5). Throws `ContentLoadRetryMismatchError` when the request hash,
 * body hash or snapshot id drift; an exact retry must return the same receipt
 * and body hash.
 */
export const assertContentLoadExactRetry = (
  recorded: { requestHash: string; bodyHash: string; catalogSnapshotId: string },
  candidate: { requestHash: string; bodyHash: string; catalogSnapshotId: string },
): void => {
  if (candidate.requestHash !== recorded.requestHash) throw new ContentLoadRetryMismatchError({ cause: "request_hash" })
  if (candidate.bodyHash !== recorded.bodyHash) throw new ContentLoadRetryMismatchError({ cause: "body_hash" })
  if (candidate.catalogSnapshotId !== recorded.catalogSnapshotId) throw new ContentLoadRetryMismatchError({ cause: "snapshot_id" })
}

/**
 * Assert a capability body is present in the signed bundle / trusted pack
 * (design §7.4). Throws `MissingCapabilityBodyError` when the body hash is
 * absent for an otherwise loaded reference — an exact retry must never fabricate
 * a body it cannot prove.
 */
export const assertCapabilityBodyPresent = (capabilityId: string, bodyRef: string, bodyHash: string): void => {
  if (!bodyHash) throw new MissingCapabilityBodyError({ capabilityId, bodyRef })
}

/**
 * Assert a loaded capability is not superseded (design §7.5). When the manifest
 * points to a newer superseding ref, the old body is not an exact retry target
 * and a typed `SupersededCapabilityError` is thrown instead of silently reusing
 * the outdated body.
 */
export const assertCapabilityNotSuperseded = (capabilityId: string, supersedingRef: string | undefined): void => {
  if (supersedingRef !== undefined && supersedingRef !== "") {
    throw new SupersededCapabilityError({ capabilityId, supersedingRef })
  }
}

/**
 * Assert a content load is within the frozen budget limits (design §7.3, §13):
 * L0 <= 4096 bytes / 700 tokens, a single L2 body <= 1200 tokens, and per turn
 * at most 2 new L2 bodies / 2400 new L2 tokens. Throws `BudgetExceededError`
 * with the exceeded discipline.
 */
export const assertContentLoadBudget = (
  level: CapabilityLevel,
  requestedTokens: number,
  requestedBytes: number,
  newThisTurn: number,
  newTokensThisTurn: number,
): void => {
  if (level === "L0" && (requestedBytes > 4096 || requestedTokens > 700)) {
    throw new BudgetExceededError({ level, limitTokens: 700, requestedTokens })
  }
  if (level === "L2") {
    if (requestedTokens > 1200) throw new BudgetExceededError({ level, limitTokens: 1200, requestedTokens })
    if (newThisTurn > 2) throw new BudgetExceededError({ level, limitTokens: 2, requestedTokens: newThisTurn })
    if (newTokensThisTurn > 2400) throw new BudgetExceededError({ level, limitTokens: 2400, requestedTokens: newTokensThisTurn })
  }
}

/** Byte-stable canonical content digest of a CapabilityLoadReceipt (timestamp-independent). */
export const capabilityLoadReceiptDigest = (value: CapabilityLoadReceipt): string => contentDigest(value)

/** Byte-stable canonical content digest of a DomainPackLoadReceipt (timestamp-independent). */
export const domainPackLoadReceiptDigest = (value: DomainPackLoadReceipt): string => contentDigest(value)

/** Byte-stable canonical content digest of a SessionContentLoad (timestamp-independent). */
export const sessionContentLoadDigest = (value: SessionContentLoad): string => contentDigest(value)

/** Byte-stable canonical content digest of a ContentLoadState (tagged, timestamp-independent). */
export const contentLoadStateDigest = (value: ContentLoadState): string => contentDigest(value)

/** Byte-stable canonical content digest of a CapabilityLoadRequest (timestamp-independent). */
export const capabilityLoadRequestDigest = (value: CapabilityLoadRequest): string => contentDigest(value)
