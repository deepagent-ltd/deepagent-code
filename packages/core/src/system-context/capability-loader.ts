export * as CapabilityLoader from "./capability-loader"

import { contentDigest } from "../contract/digest"
import { Hash } from "../util/hash"
import { Token } from "../util/token"
import { CapabilityBudget } from "./capability-manifest"
import type { CapabilityLevel, CapabilityLoadDeniedReason } from "../contract/capability-load"

// C4-04 — durable capability loader kernel (design §7.4-7.5). This module is the
// single load path for a procedure body: it computes a byte-stable identity over
// the capability id + version + body/runtime/permission hashes, verifies the body
// content against the declared digest (fail-closed), and returns a typed tagged
// union. It carries an in-module deterministic receipt store keyed by identity so
// an exact retry of the identical identity is a no-op `existing` (never a
// duplicate), and it is the kernel that the DISABLED L1 search and the DISABLED
// L2 `capability_load` / `domain_pack_load` callers reuse.
//
// No clock, no absolute path, no randomness enters the identity or the receipt
// key — two identical inputs always produce the identical identity, which is the
// notion of "exact retry". The load reads only signed/trusted bundles; the body
// content source is the catalog/bodies lane (K1 shipped the catalog; the C4-09
// body lane authors bodies), so a capability whose body is absent or whose hash
// drifts is never loaded.

/** The five identity grounds of a capability load (design §7.5 exact-retry binding). */
export interface CapabilityLoaderIdentityInput {
  readonly capabilityId: string
  readonly version: string
  readonly bodyHash: string
  readonly runtimeHash: string
  readonly permissionHash: string
}

/**
 * Byte-stable sha256 identity of a capability load: `capability_load:<sha256>`.
 * Canonical over key order and independent of wall-clock timestamps, absolute
 * paths and randomness, so re-dispatching the same load re-derives the same
 * identity (= exact retry). A different body/runtime/permission hash changes the
 * identity, which is required for a superseded or drifted load to be rejected
 * rather than silently reused.
 */
export const capabilityLoaderIdentity = (
  capabilityId: string,
  version: string,
  bodyHash: string,
  runtimeHash: string,
  permissionHash: string,
): string => `capability_load:${contentDigest({ capabilityId, version, bodyHash, runtimeHash, permissionHash })}`

/** The identity grounds re-derived from a manifest-side resolved load, for convenience. */
export const capabilityLoaderIdentityFrom = (input: CapabilityLoaderIdentityInput): string =>
  capabilityLoaderIdentity(input.capabilityId, input.version, input.bodyHash, input.runtimeHash, input.permissionHash)

/** Typed violation: the body content hash does not equal the declared digest (fail-closed). */
export class CapabilityBodyHashMismatchError extends Error {
  readonly _tag = "capability_body_hash_mismatch"
  override readonly name = "CapabilityBodyHashMismatchError"
  readonly expected: string
  readonly actual: string
  readonly capabilityId: string
  readonly bodyRef: string

  constructor(input: { readonly capabilityId: string; readonly bodyRef: string; readonly expected: string; readonly actual: string }) {
    super(`Capability body hash mismatch for ${input.capabilityId} (${input.bodyRef}): expected ${input.expected}, actual ${input.actual}`)
    this.capabilityId = input.capabilityId
    this.bodyRef = input.bodyRef
    this.expected = input.expected
    this.actual = input.actual
  }
}

/** Typed violation: the L2 single-body budget is exceeded (a body is never loaded over-budget). */
export class CapabilityL2BudgetExceededError extends Error {
  readonly _tag = "capability_l2_budget_exceeded"
  override readonly name = "CapabilityL2BudgetExceededError"
  readonly level: CapabilityLevel
  readonly limitTokens: number
  readonly requestedTokens: number

  constructor(input: { readonly level: CapabilityLevel; readonly limitTokens: number; readonly requestedTokens: number }) {
    super(`Capability L2 budget exceeded: requested ${input.requestedTokens} tokens, limit ${input.limitTokens}`)
    this.level = input.level
    this.limitTokens = input.limitTokens
    this.requestedTokens = input.requestedTokens
  }
}

/** Typed violation: the per-turn content budget is exceeded (2 bodies / 2400 new tokens). */
export class CapabilityTurnBudgetExceededError extends Error {
  readonly _tag = "capability_turn_budget_exceeded"
  override readonly name = "CapabilityTurnBudgetExceededError"
  readonly level: CapabilityLevel
  readonly newLoads: number
  readonly limitNew: number
  readonly newTokens: number
  readonly limitTokens: number

  constructor(input: {
    readonly level: CapabilityLevel
    readonly newLoads: number
    readonly limitNew: number
    readonly newTokens: number
    readonly limitTokens: number
  }) {
    super(
      `Capability turn budget exceeded: new loads ${input.newLoads}/${input.limitNew}, new tokens ${input.newTokens}/${input.limitTokens}`,
    )
    this.level = input.level
    this.newLoads = input.newLoads
    this.limitNew = input.limitNew
    this.newTokens = input.newTokens
    this.limitTokens = input.limitTokens
  }
}

/** A durable load receipt recorded against an identity (design §7.5). */
export interface CapabilityLoadReceipt {
  readonly identity: string
  readonly capabilityId: string
  readonly version: string
  readonly bodyRef: string
  readonly bodyHash: string
  readonly runtimeHash: string
  readonly permissionHash: string
  readonly state: "loaded"
  readonly tokenCount: number
  readonly byteCount: number
}

/** Tagged result of a capability load (design §7.4-7.5): `existing` is the exact-retry no-op. */
export type CapabilityLoadResult =
  | { readonly state: "existing"; readonly receipt: CapabilityLoadReceipt }
  | {
      readonly state: "available"
      readonly body: string
      readonly tokenCount: number
      readonly byteCount: number
      readonly receipt: CapabilityLoadReceipt
    }
  | { readonly state: "superseded"; readonly supersedingRef: string }
  | { readonly state: "missing_body"; readonly bodyRef: string }
  | { readonly state: "denied"; readonly reasonCode: CapabilityLoadDeniedReason }
  | { readonly state: "budget_exceeded"; readonly level: CapabilityLevel; readonly limitTokens: number; readonly requestedTokens: number }

/** Body + declared-digest input to the kernel (design §7.4). */
export interface CapabilityLoadInput {
  readonly body: string | undefined
  readonly declaredDigest: string | undefined
}

/** Grounds the kernel cannot derive from the opaque identity (supersession, permission, body ref). */
export interface CapabilityLoadGrounds {
  readonly bodyRef: string
  readonly capabilityId?: string
  readonly version?: string
  readonly runtimeHash?: string
  readonly permissionHash?: string
  readonly supersedingRef?: string
  readonly deniedReason?: CapabilityLoadDeniedReason
}

// --- deterministic in-module receipt store (C1A boundary: DB persistence is later) ---
const receiptStore = new Map<string, CapabilityLoadReceipt>()

/** Clear the in-module receipt store + per-turn budget (test isolation / fresh environment). */
export function resetCapabilityLoader(): void {
  receiptStore.clear()
  turnBudgets.clear()
}

/** Snapshot of the currently-recorded receipts (test/observability only). */
export function recordedCapabilityLoads(): ReadonlyArray<CapabilityLoadReceipt> {
  return [...receiptStore.values()]
}

/**
 * Load a capability body through the kernel (design §7.4). Exact retry of an
 * identical identity returns the recorded `existing` receipt (no duplicate). A new
 * identity is validated: permission-denied short-circuits, supersession rejects,
 * an absent body or absent declared digest is `missing_body`, a body whose sha256
 * does not equal the declared digest is a typed `capability_body_hash_mismatch`
 * (fail-closed — the drifting body is never loaded), and an over-budget body is
 * `budget_exceeded`. On success a deterministic receipt is recorded.
 */
export function loadCapabilityBody(
  identity: string,
  input: CapabilityLoadInput,
  grounds: CapabilityLoadGrounds,
): CapabilityLoadResult {
  const existing = receiptStore.get(identity)
  if (existing) return { state: "existing", receipt: existing }

  if (grounds.deniedReason !== undefined) return { state: "denied", reasonCode: grounds.deniedReason }

  if (grounds.supersedingRef !== undefined && grounds.supersedingRef !== "") {
    return { state: "superseded", supersedingRef: grounds.supersedingRef }
  }

  const body = input.body
  const declaredDigest = input.declaredDigest
  if (body === undefined || body.length === 0 || declaredDigest === undefined || declaredDigest.length === 0) {
    return { state: "missing_body", bodyRef: grounds.bodyRef }
  }

  const actualDigest = `sha256:${Hash.sha256(body)}`
  if (actualDigest !== declaredDigest) {
    throw new CapabilityBodyHashMismatchError({
      capabilityId: grounds.bodyRef,
      bodyRef: grounds.bodyRef,
      expected: declaredDigest,
      actual: actualDigest,
    })
  }

  const tokenCount = Token.estimate(body)
  if (tokenCount > CapabilityBudget.l2SingleMaxTokens) {
    return {
      state: "budget_exceeded",
      level: "L2",
      limitTokens: CapabilityBudget.l2SingleMaxTokens,
      requestedTokens: tokenCount,
    }
  }

  const byteCount = Buffer.byteLength(body)
  const receipt: CapabilityLoadReceipt = {
    identity,
    capabilityId: grounds.capabilityId ?? grounds.bodyRef,
    version: grounds.version ?? "",
    bodyRef: grounds.bodyRef,
    bodyHash: declaredDigest,
    runtimeHash: grounds.runtimeHash ?? "",
    permissionHash: grounds.permissionHash ?? "",
    state: "loaded",
    tokenCount,
    byteCount,
  }
  receiptStore.set(identity, receipt)
  return { state: "available", body, tokenCount, byteCount, receipt }
}

// --- per-turn budget accounting (design §7.3 / §13; C4-05) ---------------------
const L2_SINGLE_MAX_TOKENS = CapabilityBudget.l2SingleMaxTokens
const L2_TURN_MAX_NEW = CapabilityBudget.l2PerTurnMaxNew
const L2_TURN_MAX_NEW_TOKENS = CapabilityBudget.l2PerTurnMaxNewTokens

/** Mutable per-turn budget state (module-level; reset by `resetCapabilityLoader`). */
const turnBudgets = new Map<string, { newLoads: number; newTokens: number; charged: Set<string> }>()

/** Snapshot of the per-turn budget state for a (session, turn) identity. */
export function turnBudgetView(sessionIdentity: string, turnIdentity: string): { newLoads: number; newTokens: number } {
  const state = turnBudgets.get(`${sessionIdentity}::${turnIdentity}`)
  if (!state) return { newLoads: 0, newTokens: 0 }
  return { newLoads: state.newLoads, newTokens: state.newTokens }
}

/**
 * Record a body load against a session+turn budget (design §7.5 idempotent
 * accounting). The exact same load identity within the same turn is a no-op — a
 * retry never double-charges. A load that would exceed either the per-turn new
 * body count or the per-turn new token ceiling throws the typed
 * `capability_turn_budget_exceeded` (the caller must not proceed).
 */
export function recordCapabilityTurnLoad(
  sessionIdentity: string,
  turnIdentity: string,
  loadIdentity: string,
  tokenCount: number,
): void {
  const key = `${sessionIdentity}::${turnIdentity}`
  let state = turnBudgets.get(key)
  if (!state) {
    state = { newLoads: 0, newTokens: 0, charged: new Set<string>() }
    turnBudgets.set(key, state)
  }
  if (state.charged.has(loadIdentity)) return
  const nextNewLoads = state.newLoads + 1
  const nextNewTokens = state.newTokens + tokenCount
  if (nextNewLoads > L2_TURN_MAX_NEW || nextNewTokens > L2_TURN_MAX_NEW_TOKENS) {
    throw new CapabilityTurnBudgetExceededError({
      level: "L2",
      newLoads: nextNewLoads,
      limitNew: L2_TURN_MAX_NEW,
      newTokens: nextNewTokens,
      limitTokens: L2_TURN_MAX_NEW_TOKENS,
    })
  }
  state.newLoads = nextNewLoads
  state.newTokens = nextNewTokens
  state.charged.add(loadIdentity)
}

/**
 * The L2 single-body + per-turn gate (C4-05, the DISABLED `capability_load` entry).
 * Enforces the frozen L2 budget over a real character-based estimate, then charges
 * the per-turn counter idempotently. An over-budget L2 body or an over-limit turn
 * throws a typed error and never returns a loadable body.
 */
export function capabilityLoad(args: {
  readonly capabilityId: string
  readonly version: string
  readonly bodyHash: string
  readonly runtimeHash: string
  readonly permissionHash: string
  readonly bodyRef: string
  readonly sessionIdentity: string
  readonly turnIdentity: string
  readonly body: string | undefined
  readonly declaredDigest: string | undefined
  readonly supersedingRef?: string
  readonly deniedReason?: CapabilityLoadDeniedReason
}): CapabilityLoadResult {
  const identity = capabilityLoaderIdentity(
    args.capabilityId,
    args.version,
    args.bodyHash,
    args.runtimeHash,
    args.permissionHash,
  )

  // Fail-closed on the L2 single-body ceiling before touching the turn budget.
  const tokenCount = args.body === undefined ? 0 : Token.estimate(args.body)
  if (tokenCount > L2_SINGLE_MAX_TOKENS) {
    throw new CapabilityL2BudgetExceededError({
      level: "L2",
      limitTokens: L2_SINGLE_MAX_TOKENS,
      requestedTokens: tokenCount,
    })
  }

  // Pre-admission turn-budget check (idempotent): a retry of an already-charged
  // load identity is allowed without charging again, but a NEW load that would
  // exceed the per-turn ceiling is rejected BEFORE the kernel records a receipt,
  // so a rejected load never leaves a spurious `existing` receipt behind.
  const key = `${args.sessionIdentity}::${args.turnIdentity}`
  const current = turnBudgets.get(key) ?? { newLoads: 0, newTokens: 0, charged: new Set<string>() }
  if (!current.charged.has(identity)) {
    const nextNewLoads = current.newLoads + 1
    const nextNewTokens = current.newTokens + tokenCount
    if (nextNewLoads > L2_TURN_MAX_NEW || nextNewTokens > L2_TURN_MAX_NEW_TOKENS) {
      throw new CapabilityTurnBudgetExceededError({
        level: "L2",
        newLoads: nextNewLoads,
        limitNew: L2_TURN_MAX_NEW,
        newTokens: nextNewTokens,
        limitTokens: L2_TURN_MAX_NEW_TOKENS,
      })
    }
  }

  const result = loadCapabilityBody(identity, { body: args.body, declaredDigest: args.declaredDigest }, {
    bodyRef: args.bodyRef,
    capabilityId: args.capabilityId,
    version: args.version,
    runtimeHash: args.runtimeHash,
    permissionHash: args.permissionHash,
    supersedingRef: args.supersedingRef,
    deniedReason: args.deniedReason,
  })

  if (result.state === "budget_exceeded") {
    throw new CapabilityL2BudgetExceededError({
      level: result.level,
      limitTokens: result.limitTokens,
      requestedTokens: result.requestedTokens,
    })
  }

  // Charge only an actually-loaded body; an exact retry (`existing`) is idempotent
  // (the same turn + same load identity is already charged, so it is a no-op).
  if (result.state === "available") {
    recordCapabilityTurnLoad(args.sessionIdentity, args.turnIdentity, identity, tokenCount)
  }

  return result
}
