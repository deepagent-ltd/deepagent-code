export * as CapabilityLoadAdapter from "./capability-load-adapter"

import { and, eq } from "drizzle-orm"
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
import { SessionTable } from "../session/sql"
import { SessionCapabilityLoadTable } from "./capability-load.sql"
import { CapabilityBudget } from "./capability-manifest"
import {
  CapabilityBodyHashMismatchError,
  capabilityLoaderIdentity,
  evaluateCapabilityBody,
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
export const permissionBinding = (request: CapabilityLoadRequest): ContentPermissionBinding => {
  const granted = request.grantedPermissions ?? []
  const fingerprint = contentDigest({
    required: [...request.requiredPermissions].toSorted(),
    granted: [...granted].toSorted(),
  })
  return { permissionFingerprint: fingerprint, required: [...request.requiredPermissions], granted: [...granted] }
}

/** Derive a deterministic runtime-compatibility hash from the runtime identity + required features. */
export const runtimeCompatibilityHash = (request: CapabilityLoadRequest): string =>
  contentDigest({
    runtimeRequired: [...(request.requiredRuntimeFeatures ?? [])].toSorted(),
    runtimeHash: request.runtimeHash,
  })

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
  readonly budget: CapabilityLoadBudgetSnapshot
  readonly level?: CapabilityLevel
  readonly loadedAt?: number
}): ContractLoadReceipt {
  const { request, identity, result } = args
  const state = mapCapabilityLoadResult(result, {
    newThisTurn: args.budget.newLoadsThisTurn,
  })
  const level: CapabilityLevel = args.level ?? "L2"
  const binding = permissionBinding(request)
  const rtc = runtimeCompatibilityHash(request)
  const requestHash = capabilityLoadRequestHash(request, identity)
  const resultHash = capabilityLoadResultHash(state, request.bodyHash)
  const supersedes =
    result.state === "available" && request.supersedingRef !== undefined && request.supersedingRef !== ""
      ? request.supersedingRef
      : undefined
  const tokenCount =
    result.state === "available" ? result.tokenCount : result.state === "budget_exceeded" ? result.requestedTokens : 0
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
    budgetState: args.budget.budgetState,
    newLoadsThisTurn: args.budget.newLoadsThisTurn,
    newTokensThisTurn: args.budget.newTokensThisTurn,
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
 * path the runner reuses: one database transaction reads the durable per-turn budget,
 * validates the body, maps the result,
 * the frozen ContentLoadState, returns the frozen CapabilityLoadReceipt alongside
 * the loaded body (when present) and persists the receipt to the durable
 * `session_capability_load` table (design §7.5) — an exact retry converges on the
 * same row (unique (session_id, catalog_snapshot_id, capability_id, body_hash)); a retry
 * returns the durable winner as `already_loaded` WITH the caller-verified body. Never loads as part of the call: the caller passes a body +
 * declared digest already verified against a signed bundle / trusted pack.
 *
 * The persistence is a transaction over budget read, validation and receipt insert
 * (insert-or-reread by the exact-retry key) and only records states that represent an actually-loaded body
 * (`loaded` / `already_loaded`): a denied/not_found/budget_exceeded attempt loaded
 * nothing, so it leaves no durable fact. Database failures remain typed so the tool boundary
 * can report a ToolFailure instead of turning an expected storage outage into a defect.
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
): Effect.Effect<
  { readonly state: ContentLoadState; readonly receipt: ContractLoadReceipt; readonly body: string | undefined },
  Error
> {
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(SessionCapabilityLoadTable)
          .where(
            and(
              eq(SessionCapabilityLoadTable.session_id, args.identity.sessionId),
              eq(SessionCapabilityLoadTable.catalog_snapshot_id, args.request.catalogSnapshotId),
              eq(SessionCapabilityLoadTable.capability_id, args.request.capabilityId),
              eq(SessionCapabilityLoadTable.body_hash, args.request.bodyHash),
            ),
          )
          .get()
        const rows = yield* tx
          .select({
            loadId: SessionCapabilityLoadTable.load_id,
            tokenCount: SessionCapabilityLoadTable.token_count,
          })
          .from(SessionCapabilityLoadTable)
          .where(
            and(
              eq(SessionCapabilityLoadTable.session_id, args.identity.sessionId),
              eq(SessionCapabilityLoadTable.turn_id, args.identity.turnId),
            ),
          )
          .all()
        const out = computeDurableCapabilityLoad(
          args,
          {
            newLoads: rows.length,
            newTokens: rows.reduce((total, row) => total + row.tokenCount, 0),
          },
          existing,
        )
        if (out.state.state !== "loaded") return out
        const inserted = yield* tx
          .insert(SessionCapabilityLoadTable)
          .values(toLoadReceiptRow(out.receipt, args.request.capabilityId))
          .onConflictDoNothing()
          .returning()
          .get()
        if (inserted) return out
        const winner = yield* tx
          .select()
          .from(SessionCapabilityLoadTable)
          .where(
            and(
              eq(SessionCapabilityLoadTable.session_id, args.identity.sessionId),
              eq(SessionCapabilityLoadTable.catalog_snapshot_id, args.request.catalogSnapshotId),
              eq(SessionCapabilityLoadTable.capability_id, args.request.capabilityId),
              eq(SessionCapabilityLoadTable.body_hash, args.request.bodyHash),
            ),
          )
          .get()
        if (!winner) return yield* Effect.die(new Error("capability load insert lost without a durable winner"))
        return existingLoad(winner, args.request.body)
      }),
    ).pipe(
      Effect.catchDefect(() => Effect.fail(new Error("Capability load storage is unavailable"))),
    )
}

/** Pure validation + durable-budget computation. It never consults the process-local kernel maps. */
function computeDurableCapabilityLoad(
  args: {
    readonly request: CapabilityLoadRequest
    readonly identity: CapabilityLoadTurnIdentity
    readonly contextEpoch: string
    readonly level?: CapabilityLevel
    readonly loadedAt?: number
  },
  budget: { readonly newLoads: number; readonly newTokens: number },
  existing?: LoadReceiptRow,
): {
  readonly state: ContentLoadState
  readonly receipt: ContractLoadReceipt
  readonly body: string | undefined
} {
  const bound = withTurnIdentity(args.request, args.identity)
  if (bound.declaredDigest !== undefined && bound.declaredDigest !== bound.bodyHash)
    throw new CapabilityBodyHashMismatchError({
      capabilityId: bound.capabilityId,
      bodyRef: bound.bodyRef,
      expected: bound.bodyHash,
      actual: bound.declaredDigest,
    })
  const validated = evaluateCapabilityBody(
    loadIdentityFor(bound),
    { body: bound.body, declaredDigest: bound.declaredDigest },
    {
      bodyRef: bound.bodyRef,
      capabilityId: bound.capabilityId,
      version: bound.version,
      runtimeHash: bound.runtimeHash,
      permissionHash: bound.permissionHash,
      supersedingRef: bound.supersedingRef,
      deniedReason: bound.deniedReason,
      sessionId: bound.sessionId,
      turnId: bound.turnId,
    },
  )
  if (validated.state === "available" && existing) return existingLoad(existing, validated.body)
  const result =
    validated.state === "available" &&
    (budget.newLoads + 1 > CapabilityBudget.l2PerTurnMaxNew ||
      budget.newTokens + validated.tokenCount > CapabilityBudget.l2PerTurnMaxNewTokens)
      ? ({
          state: "budget_exceeded",
          level: "L2",
          limitTokens: CapabilityBudget.l2PerTurnMaxNewTokens,
          requestedTokens: budget.newTokens + validated.tokenCount,
        } satisfies CapabilityLoadResult)
      : validated
  const snapshot = {
    budgetState:
      result.state === "budget_exceeded"
        ? ("exceeded" as const)
        : budget.newLoads + (result.state === "available" ? 1 : 0) >= CapabilityBudget.l2PerTurnMaxNew ||
            budget.newTokens + (result.state === "available" ? result.tokenCount : 0) >=
              CapabilityBudget.l2PerTurnMaxNewTokens
          ? ("at_limit" as const)
          : ("within" as const),
    newLoadsThisTurn: budget.newLoads + (result.state === "available" ? 1 : 0),
    newTokensThisTurn: budget.newTokens + (result.state === "available" ? result.tokenCount : 0),
  }
  const receipt = buildCapabilityLoadReceipt({
    request: bound,
    identity: args.identity,
    result,
    contextEpoch: args.contextEpoch,
    budget: snapshot,
    level: args.level,
    loadedAt: args.loadedAt,
  })
  const body = result.state === "available" || result.state === "existing" ? result.body : undefined
  return { state: receipt.state, receipt, body }
}

/** The durable load receipt row (JSON columns decoded by Drizzle; exact-retry key in the schema). */
type LoadReceiptRow = typeof SessionCapabilityLoadTable.$inferSelect

function existingLoad(row: LoadReceiptRow, body: string | undefined) {
  return {
    state: { state: "already_loaded", bodyRef: row.body_ref } satisfies ContentLoadState,
    receipt: receiptFromRow(row),
    body,
  }
}

function toLoadReceiptRow(
  receipt: ContractLoadReceipt,
  capabilityId: string,
): typeof SessionCapabilityLoadTable.$inferInsert {
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
export const capabilityLoadFactOf = (
  receipt: ContractLoadReceipt,
): { readonly capabilityId: string; readonly bodyHash: string } => ({
  capabilityId: receipt.bodyRef.split("@")[0]!.slice("capability://".length),
  bodyHash: receipt.bodyHash,
})

/**
 * The durable read-back seam (W4, design §7.5 snapshot restoration): the load
 * receipts recorded for one session in ONE catalog snapshot, read from
 * `session_capability_load` (a new store / DB connection sees the same rows — the
 * compaction-restart closure). The kernel's in-module `recordedCapabilityLoads()`
 * stays the process-local exact-retry cache; this is the durable fact store the
 * runner uses to rebuild the snapshot after a restart.
 *
 * W15 (P4) — the restore is FILTERED to the request/current catalog snapshot id
 * (`catalog_snapshot_id`, the frozen contract field the receipt always carries):
 * rows recorded under a DIFFERENT catalog snapshot belong to a different Context
 * Epoch, and folding them in would rebuild a snapshot digest that never existed
 * (mixed-epoch facts). Rows are ordered by `load_id` alone — `loaded_at` is
 * audit-only and written as 0 by the production path (the adapter never passes a
 * `loadedAt`), and the table has no real record-time column, so a "first-load
 * time" order is not representable; `load_id` is the deterministic, stable tie
 * that makes the rebuild byte-stable.
 */
export function recordedCapabilityLoadsForSession(
  db: Database.Interface["db"],
  sessionId: string,
  catalogSnapshotId: string,
): Effect.Effect<ReadonlyArray<ContractLoadReceipt>, never> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionCapabilityLoadTable)
      .where(
        and(
          eq(SessionCapabilityLoadTable.session_id, sessionId),
          eq(SessionCapabilityLoadTable.catalog_snapshot_id, catalogSnapshotId),
        ),
      )
      .orderBy(SessionCapabilityLoadTable.load_id)
      .all()
      .pipe(Effect.orDie)
    return rows.map(receiptFromRow)
  })
}

export function recordedCapabilityLoadsForDirectory(db: Database.Interface["db"], directory: string) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ load: SessionCapabilityLoadTable })
      .from(SessionCapabilityLoadTable)
      .innerJoin(SessionTable, eq(SessionTable.id, SessionCapabilityLoadTable.session_id))
      .where(eq(SessionTable.directory, directory))
      .orderBy(SessionCapabilityLoadTable.load_id)
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => ({
      identity: row.load.load_id,
      capabilityId: row.load.capability_id,
      receipt: receiptFromRow(row.load),
    }))
  })
}
