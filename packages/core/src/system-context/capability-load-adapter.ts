export * as CapabilityLoadAdapter from "./capability-load-adapter"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { contentDigest } from "../contract/digest"
import {
  CapabilityLoadReceipt as ContractLoadReceipt,
  CapabilityLoadVersion,
  ContentPermissionBinding,
  decodeCapabilityLoadReceipt,
  type CapabilityLoadDeniedReason,
  type ContentLoadState,
  type CapabilityLevel,
} from "../contract/capability-load"
import { Database } from "../database/database"
import { SessionCapabilityLoadTable } from "./capability-load.sql"
import { CapabilityBudget } from "./capability-manifest"
import {
  CapabilityL2BudgetExceededError,
  CapabilityTurnBudgetExceededError,
  capabilityLoad,
  capabilityLoaderIdentity,
  recordedCapabilityLoads,
  resetCapabilityLoader,
  turnBudgetView,
  type CapabilityLoadResult,
} from "./capability-loader"

// C4-07 — 接内核 (wire the K2 kernel into the frozen C0-02 contract). This module
// is the CAPABILITY-SIDE adapter: it maps the K2 kernel's 6-state result union
// (existing | available | superseded | missing_body | denied | budget_exceeded) onto
// the FROZEN ContentLoadState union (loaded | already_loaded | denied | disabled |
// incompatible | not_found | budget_exceeded), builds a byte-stable FROZEN
// CapabilityLoadReceipt (the `session_capability_load` durable receipt, design
// §7.5), and provides the typed `withTurnIdentity(...)` seam the runner uses to
// bind the REAL session/activity/turn identity (a prepared-turn turnId) into the
// load before the kernel runs.
//
// The mapping is a TOTAL function over the kernel union (every kernel state has a
// ContentLoadState). The kernel never emits `disabled` or `incompatible` — those
// are authored/authorization-side states (a disabled capability is excluded by
// search before any load, and runtime incompatibility is an authorization guard),
// so the mapping surface covers exactly the states the kernel can emit. A
// `superseded` request maps to `not_found` (catalog_snapshot_mismatch): the
// requested capability version is no longer current in this catalog snapshot,
// which is the frozen not-found reason that best represents "the ref you asked
// for does not belong to the snapshot you are loading against".
//
// FROZEN imports only: contract/capability-load.ts is consumed (never edited);
// system-context/capability-loader.ts is the K2 kernel (this lane adds a mapping
// layer on top; it does not rewrite the kernel). Nothing here expands permission:
// the receipt records required vs granted, and the body is CONTENT, never an
// instruction the loader enforces.

/** Real session/activity/turn identity bound to a load (design §7.5). */
export interface CapabilityLoadTurnIdentity {
  readonly sessionId: string
  readonly activityId: string
  readonly turnId: string
}

/** The non-identity grounds the caller provides for one capability load. */
export interface CapabilityLoadRequest {
  readonly capabilityId: string
  readonly version: string
  readonly bodyHash: string
  readonly runtimeHash: string
  readonly permissionHash: string
  readonly bodyRef: string
  readonly body: string | undefined
  readonly declaredDigest: string | undefined
  readonly catalogSnapshotId: string
  /** Manifest-declared required permissions (from the frozen manifest / search card). */
  readonly requiredPermissions: ReadonlyArray<string>
  /** The permissions the runtime has actually granted for this load (never expanded). */
  readonly grantedPermissions?: ReadonlyArray<string>
  /** Manifest-declared required runtime features (from the frozen manifest). */
  readonly requiredRuntimeFeatures?: ReadonlyArray<string>
  readonly supersedingRef?: string
  readonly deniedReason?: CapabilityLoadDeniedReason
}

/** The per-turn budget bookkeeping added to a receipt (design §13). */
export interface CapabilityLoadBudgetSnapshot {
  readonly budgetState: "within" | "at_limit" | "exceeded"
  readonly newLoadsThisTurn: number
  readonly newTokensThisTurn: number
}

/**
 * Map the K2 kernel's 6-state result union onto the FROZEN ContentLoadState union.
 * Total: every kernel state has a ContentLoadState. `limitNewPerTurn` defaults to
 * the frozen L2 per-turn cap; `newThisTurn` is the loaded-count for the turn.
 */
export function mapCapabilityLoadResult(
  result: CapabilityLoadResult,
  extras: { readonly limitNewPerTurn?: number; readonly newThisTurn?: number } = {},
): ContentLoadState {
  switch (result.state) {
    case "available":
      return {
        state: "loaded",
        bodyRef: result.receipt.bodyRef,
        tokenCount: result.tokenCount,
        byteCount: result.byteCount,
        supersedes: supersedesOf(result),
      }
    case "existing":
      return { state: "already_loaded", bodyRef: result.receipt.bodyRef }
    case "denied":
      return { state: "denied", reasonCode: result.reasonCode }
    case "budget_exceeded":
      return {
        state: "budget_exceeded",
        level: result.level,
        limitTokens: result.limitTokens,
        requestedTokens: result.requestedTokens,
        limitNewPerTurn: extras.limitNewPerTurn ?? CapabilityBudget.l2PerTurnMaxNew,
        newThisTurn: extras.newThisTurn ?? 0,
      }
    case "missing_body":
      return { state: "not_found", reasonCode: "capability_unregistered" }
    case "superseded":
      return { state: "not_found", reasonCode: "catalog_snapshot_mismatch" }
  }
}

function supersedesOf(result: CapabilityLoadResult): string | undefined {
  // A `loaded` body may carry no supersession; supersession is expressed through
  // the kernel's `superseded` state, not through the loaded body. The frozen shape
  // keeps `supersedes` optional, so we leave it undefined for a `loaded` result.
  return undefined
}

/** Derive the byte-stable request hash for a load (design §7.5 exact-retry binding). */
export const capabilityLoadRequestHash = (
  request: CapabilityLoadRequest,
  identity: Pick<CapabilityLoadTurnIdentity, "sessionId" | "activityId" | "turnId">,
): string =>
  contentDigest({
    capabilityId: request.capabilityId,
    version: request.version,
    bodyHash: request.bodyHash,
    runtimeHash: request.runtimeHash,
    permissionHash: request.permissionHash,
    catalogSnapshotId: request.catalogSnapshotId,
    sessionId: identity.sessionId,
    activityId: identity.activityId,
    turnId: identity.turnId,
  })

/** Derive the byte-stable result hash for a load (design §7.5 binding). */
export const capabilityLoadResultHash = (state: ContentLoadState, bodyHash: string): string =>
  contentDigest({ state, bodyHash })

/** Derive a deterministic permission fingerprint from required + granted permissions. */
export const permissionBinding = (
  request: CapabilityLoadRequest,
): ContentPermissionBinding => {
  const granted = request.grantedPermissions ?? []
  const fingerprint = contentDigest({ required: [...request.requiredPermissions].toSorted(), granted: [...granted].toSorted() })
  return { permissionFingerprint: fingerprint, required: [...request.requiredPermissions], granted: [...granted] }
}

/** Derive a deterministic runtime-compatibility hash from the runtime identity + required features. */
export const runtimeCompatibilityHash = (request: CapabilityLoadRequest): string =>
  contentDigest({
    runtimeRequired: [...(request.requiredRuntimeFeatures ?? [])].toSorted(),
    runtimeHash: request.runtimeHash,
  })

/** Derive a deterministic per-turn budget snapshot from the (session, turn) budget map. */
export const budgetSnapshotFor = (sessionId: string, turnId: string, state: ContentLoadState): CapabilityLoadBudgetSnapshot => {
  const view = turnBudgetView(sessionId, turnId)
  const count = view.newLoads
  const tokens = view.newTokens
  const atLimit = count >= CapabilityBudget.l2PerTurnMaxNew || tokens >= CapabilityBudget.l2PerTurnMaxNewTokens
  return {
    budgetState: state.state === "budget_exceeded" ? "exceeded" : atLimit ? "at_limit" : "within",
    newLoadsThisTurn: count,
    newTokensThisTurn: tokens,
  }
}

/**
 * Build the FROZEN CapabilityLoadReceipt (`session_capability_load`) for a load.
 * Every frozen field is filled: load/session/activity/turn identity, catalog
 * snapshot, body/runtime/permission hashes, the permission + runtime binding,
 * request/result hash, deterministic budget bookkeeping and the mapped tagged
 * state. `loadedAt` is audit-only (excluded from the receipt digest). The value
 * is passed through `decodeCapabilityLoadReceipt` so an incoherent field (e.g.
 * an unknown state) fails loudly rather than silently truncating.
 */
export function buildCapabilityLoadReceipt(args: {
  readonly request: CapabilityLoadRequest
  readonly identity: CapabilityLoadTurnIdentity
  readonly result: CapabilityLoadResult
  readonly contextEpoch: string
  readonly level?: CapabilityLevel
  readonly loadedAt?: number
}): ContractLoadReceipt {
  const { request, identity, result } = args
  const state = mapCapabilityLoadResult(result, { newThisTurn: turnBudgetView(identity.sessionId, identity.turnId).newLoads })
  const level: CapabilityLevel = args.level ?? "L2"
  const budget = budgetSnapshotFor(identity.sessionId, identity.turnId, state)
  const binding = permissionBinding(request)
  const rtc = runtimeCompatibilityHash(request)
  const requestHash = capabilityLoadRequestHash(request, identity)
  const resultHash = capabilityLoadResultHash(state, request.bodyHash)
  const supersedes =
    result.state === "available" && request.supersedingRef !== undefined && request.supersedingRef !== ""
      ? request.supersedingRef
      : undefined
  const tokenCount = result.state === "available" ? result.tokenCount : result.state === "budget_exceeded" ? result.requestedTokens : 0
  const byteCount = result.state === "available" ? result.byteCount : 0

  return decodeCapabilityLoadReceipt({
    schemaVersion: CapabilityLoadVersion.receipt,
    contentKind: "capability",
    loadId: capabilityLoadRequestHash(request, identity),
    sessionId: identity.sessionId,
    activityId: identity.activityId,
    turnId: identity.turnId,
    catalogSnapshotId: request.catalogSnapshotId,
    version: request.version,
    bodyHash: request.bodyHash,
    runtimeHash: request.runtimeHash,
    permissionHash: request.permissionHash,
    permissionBinding: binding,
    runtimeCompatibilityHash: rtc,
    requestHash,
    resultHash,
    level,
    bodyRef: request.bodyRef,
    supersedes,
    tokenCount,
    byteCount,
    budgetState: budget.budgetState,
    newLoadsThisTurn: budget.newLoadsThisTurn,
    newTokensThisTurn: budget.newTokensThisTurn,
    contextEpoch: args.contextEpoch,
    loadedAt: args.loadedAt ?? 0,
    state,
  })
}

/**
 * The runner-side seam that binds the REAL prepared-turn identity (sessionId /
 * activityId / turnId) into a load request. `turnId` is the prepared-turn turnId
 * from the frozen PreparedProviderTurn — the kernel is engineered to take
 * caller-passed session/turn identity, and the runner passes the durable turn
 * identity here so the receipt and the attempt share one identity.
 */
export function withTurnIdentity(
  request: CapabilityLoadRequest,
  identity: CapabilityLoadTurnIdentity,
): CapabilityLoadRequest & CapabilityLoadTurnIdentity {
  return { ...request, sessionId: identity.sessionId, activityId: identity.activityId, turnId: identity.turnId }
}

/** Resolve the kernel identity for a bound request (the `capability_load:<sha256>` tag). */
export const loadIdentityFor = (bound: CapabilityLoadRequest & CapabilityLoadTurnIdentity): string =>
  capabilityLoaderIdentity(
    bound.sessionId,
    bound.capabilityId,
    bound.version,
    bound.bodyHash,
    bound.runtimeHash,
    bound.permissionHash,
  )

/**
 * Run one capability load through the K2 kernel with the frozen receipt binding,
 * bound to a real session/activity/turn identity. This is the production `capability_load`
 * path the runner reuses: it charges the per-turn budget, maps the kernel result to
 * the frozen ContentLoadState, returns the frozen CapabilityLoadReceipt alongside
 * the loaded body (when present) and persists the receipt to the durable
 * `session_capability_load` table (design §7.5) — an exact retry converges on the
 * same row (unique (session_id, capability_id, body_hash)); a retry of a body the
 * kernel already holds returns `already_loaded` WITH the body (the W4 kernel
 * `existing` carries it). Never loads as part of the call: the caller passes a body +
 * declared digest already verified against a signed bundle / trusted pack.
 *
 * The persistence is a transaction over the receipt insert (insert-or-ignore by the
 * exact-retry key) and only records states that represent an actually-loaded body
 * (`loaded` / `already_loaded`): a denied/not_found/budget_exceeded attempt loaded
 * nothing, so it leaves no durable fact. Mapped/lookup failures are typed defects.
 *
 * The database handle is passed in (not required as a service): the tool layer resolves
 * `Database.Service` once at build time and closes over the `db`, so the execute effects
 * stay dependency-free like the other built-in tools.
 */
export function sessionCapabilityLoad(
  db: Database.Interface["db"],
  args: {
    readonly request: CapabilityLoadRequest
    readonly identity: CapabilityLoadTurnIdentity
    readonly contextEpoch: string
    readonly level?: CapabilityLevel
    readonly loadedAt?: number
  },
): Effect.Effect<{ readonly state: ContentLoadState; readonly receipt: ContractLoadReceipt; readonly body: string | undefined }, never> {
  const out = computeCapabilityLoad(args)
  return persistLoadReceipt(db, out, args.request.capabilityId).pipe(Effect.as(out))
}

/** The pure kernel + receipt computation (kept separable so the write path stays a thin shell). */
function computeCapabilityLoad(args: {
  readonly request: CapabilityLoadRequest
  readonly identity: CapabilityLoadTurnIdentity
  readonly contextEpoch: string
  readonly level?: CapabilityLevel
  readonly loadedAt?: number
}): { readonly state: ContentLoadState; readonly receipt: ContractLoadReceipt; readonly body: string | undefined } {
  const { request, identity } = args
  const bound = withTurnIdentity(request, identity)
  let result: CapabilityLoadResult
  try {
    result = capabilityLoad({
      capabilityId: bound.capabilityId,
      version: bound.version,
      bodyHash: bound.bodyHash,
      runtimeHash: bound.runtimeHash,
      permissionHash: bound.permissionHash,
      bodyRef: bound.bodyRef,
      sessionIdentity: bound.sessionId,
      turnIdentity: bound.turnId,
      body: bound.body,
      declaredDigest: bound.declaredDigest,
      supersedingRef: bound.supersedingRef,
      deniedReason: bound.deniedReason,
    })
  } catch (error) {
    // The frozen ContentLoadState carries a `budget_exceeded` state. The gated
    // `capability_load` entry surfaces an over-budget body/turn as a typed throw;
    // the adapter re-forms it as the frozen budget_exceeded ContentLoadState so
    // the durable receipt can record the outcome (it never loads the body).
    result = budgetExceededState(error)
  }
  const receipt = buildCapabilityLoadReceipt({
    request: bound,
    identity,
    result,
    contextEpoch: args.contextEpoch,
    level: args.level,
    loadedAt: args.loadedAt,
  })
  const body =
    result.state === "available" || result.state === "existing" ? result.body : undefined
  return { state: receipt.state, receipt, body }
}

/** The durable load receipt row (JSON columns decoded by Drizzle; exact-retry key in the schema). */
type LoadReceiptRow = typeof SessionCapabilityLoadTable.$inferSelect

/** Insert the receipt row in one transaction; the unique key makes an exact retry a no-op. */
function persistLoadReceipt(
  db: Database.Interface["db"],
  out: { readonly state: ContentLoadState; readonly receipt: ContractLoadReceipt },
  capabilityId: string,
) {
  if (out.state.state !== "loaded" && out.state.state !== "already_loaded") return Effect.void
  return db
    .transaction((tx) =>
      tx
        .insert(SessionCapabilityLoadTable)
        .values(toLoadReceiptRow(out.receipt, capabilityId))
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    )
    .pipe(Effect.orDie)
}

function toLoadReceiptRow(receipt: ContractLoadReceipt, capabilityId: string): typeof SessionCapabilityLoadTable.$inferInsert {
  return {
    load_id: receipt.loadId,
    schema_version: receipt.schemaVersion,
    content_kind: receipt.contentKind,
    session_id: receipt.sessionId,
    activity_id: receipt.activityId,
    turn_id: receipt.turnId,
    catalog_snapshot_id: receipt.catalogSnapshotId,
    ...(receipt.packId === undefined ? {} : { pack_id: receipt.packId }),
    capability_id: capabilityId,
    version: receipt.version,
    body_hash: receipt.bodyHash,
    runtime_hash: receipt.runtimeHash,
    permission_hash: receipt.permissionHash,
    permission_binding: receipt.permissionBinding,
    runtime_compatibility_hash: receipt.runtimeCompatibilityHash,
    request_hash: receipt.requestHash,
    result_hash: receipt.resultHash,
    level: receipt.level,
    body_ref: receipt.bodyRef,
    ...(receipt.supersedes === undefined ? {} : { supersedes: receipt.supersedes }),
    token_count: receipt.tokenCount,
    byte_count: receipt.byteCount,
    budget_state: receipt.budgetState,
    new_loads_this_turn: receipt.newLoadsThisTurn,
    new_tokens_this_turn: receipt.newTokensThisTurn,
    context_epoch: receipt.contextEpoch,
    loaded_at: receipt.loadedAt,
    state: receipt.state,
  }
}

/**
 * Rebuild a receipt from a durable row. The row stores the frozen receipt fields
 * (the tagged `state` and `permissionBinding` as JSON), so the decode re-validates
 * the frozen shape — an incoherent/unknown field fails loudly rather than
 * truncating. This wave writes capability-kind rows only; a domain-pack row would
 * need the pack binding columns and fails the decode loudly (never a silent read).
 */
function receiptFromRow(row: LoadReceiptRow): ContractLoadReceipt {
  return decodeCapabilityLoadReceipt({
    schemaVersion: row.schema_version,
    contentKind: "capability",
    loadId: row.load_id,
    sessionId: row.session_id,
    activityId: row.activity_id,
    turnId: row.turn_id,
    catalogSnapshotId: row.catalog_snapshot_id,
    ...(row.pack_id === null ? {} : { packId: row.pack_id }),
    version: row.version,
    bodyHash: row.body_hash,
    runtimeHash: row.runtime_hash,
    permissionHash: row.permission_hash,
    permissionBinding: row.permission_binding,
    runtimeCompatibilityHash: row.runtime_compatibility_hash,
    requestHash: row.request_hash,
    resultHash: row.result_hash,
    level: row.level,
    bodyRef: row.body_ref,
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    tokenCount: row.token_count,
    byteCount: row.byte_count,
    budgetState: row.budget_state,
    newLoadsThisTurn: row.new_loads_this_turn,
    newTokensThisTurn: row.new_tokens_this_turn,
    contextEpoch: row.context_epoch,
    loadedAt: row.loaded_at,
    state: row.state,
  })
}

/**
 * The durable snapshot fact for one receipt (design §7.5 restoration): the frozen
 * receipt does not carry `capabilityId` top-level (it is bound through `body_ref`),
 * so the snapshot fact derives it from the body ref — `capability://<id>@<version>`.
 */
export const capabilityLoadFactOf = (receipt: ContractLoadReceipt): { readonly capabilityId: string; readonly bodyHash: string } => ({
  capabilityId: receipt.bodyRef.split("@")[0]!.slice("capability://".length),
  bodyHash: receipt.bodyHash,
})

/**
 * The durable read-back seam (W4, design §7.5 snapshot restoration): the load
 * receipts recorded for one session, read from `session_capability_load` (a new
 * store / DB connection sees the same rows — the compaction-restart closure). The
 * kernel's in-module `recordedCapabilityLoads()` stays the process-local exact-retry
 * cache; this is the durable fact store the runner uses to rebuild the snapshot
 * after a restart. Ordered by first-load time (loaded_at, then load_id) so the
 * rebuild is deterministic.
 */
export function recordedCapabilityLoadsForSession(
  db: Database.Interface["db"],
  sessionId: string,
): Effect.Effect<ReadonlyArray<ContractLoadReceipt>, never> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionCapabilityLoadTable)
      .where(eq(SessionCapabilityLoadTable.session_id, sessionId))
      .orderBy(SessionCapabilityLoadTable.loaded_at, SessionCapabilityLoadTable.load_id)
      .all()
      .pipe(Effect.orDie)
    return rows.map(receiptFromRow)
  })
}

function budgetExceededState(error: unknown): CapabilityLoadResult {
  if (error instanceof CapabilityL2BudgetExceededError) {
    return {
      state: "budget_exceeded",
      level: error.level,
      limitTokens: error.limitTokens,
      requestedTokens: error.requestedTokens,
    }
  }
  if (error instanceof CapabilityTurnBudgetExceededError) {
    return { state: "budget_exceeded", level: error.level, limitTokens: error.limitTokens, requestedTokens: error.newTokens }
  }
  throw error
}

// Re-export the kernel's observable surface so callers can test/observe the adapter
// against the single loader (reset for test isolation, receipts for observability).
export { recordedCapabilityLoads, resetCapabilityLoader }
