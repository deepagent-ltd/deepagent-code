export * as CapabilityLoaderMemory from "./capability-loader-memory"

import { Token } from "../util/token"
import { CapabilityBudget } from "./capability-manifest"
import {
  CapabilityL2BudgetExceededError,
  CapabilityTurnBudgetExceededError,
  capabilityLoaderIdentity,
  evaluateCapabilityBody,
  type CapabilityLoadGrounds,
  type CapabilityLoadInput,
  type CapabilityLoadReceipt,
  type CapabilityLoadResult,
} from "./capability-loader"
import type { CapabilityLoadDeniedReason } from "../contract/capability-load"

// Standalone memory kernel for isolated tests and the unreleased domain-pack prototype. Production
// capability loading uses capability-load-adapter.ts and durable session_capability_load rows only.
const receiptStore = new Map<string, { readonly receipt: CapabilityLoadReceipt; readonly body: string }>()
const turnBudgets = new Map<string, { newLoads: number; newTokens: number; charged: Set<string> }>()

export function resetCapabilityLoader(): void {
  receiptStore.clear()
  turnBudgets.clear()
}

export function recordedCapabilityLoads(): ReadonlyArray<CapabilityLoadReceipt> {
  return [...receiptStore.values()].map((entry) => entry.receipt)
}

export function loadCapabilityBody(
  identity: string,
  input: CapabilityLoadInput,
  grounds: CapabilityLoadGrounds,
): CapabilityLoadResult {
  const existing = receiptStore.get(identity)
  if (existing) return { state: "existing", receipt: existing.receipt, body: existing.body }

  const result = evaluateCapabilityBody(identity, input, grounds)
  if (result.state === "available") receiptStore.set(identity, { receipt: result.receipt, body: result.body })
  return result
}

export function turnBudgetView(sessionIdentity: string, turnIdentity: string): { newLoads: number; newTokens: number } {
  const state = turnBudgets.get(`${sessionIdentity}::${turnIdentity}`)
  if (!state) return { newLoads: 0, newTokens: 0 }
  return { newLoads: state.newLoads, newTokens: state.newTokens }
}

export function recordCapabilityTurnLoad(
  sessionIdentity: string,
  turnIdentity: string,
  loadIdentity: string,
  tokenCount: number,
): void {
  const key = `${sessionIdentity}::${turnIdentity}`
  const state = turnBudgets.get(key) ?? { newLoads: 0, newTokens: 0, charged: new Set<string>() }
  if (!turnBudgets.has(key)) turnBudgets.set(key, state)
  if (state.charged.has(loadIdentity)) return
  const nextNewLoads = state.newLoads + 1
  const nextNewTokens = state.newTokens + tokenCount
  if (
    nextNewLoads > CapabilityBudget.l2PerTurnMaxNew ||
    nextNewTokens > CapabilityBudget.l2PerTurnMaxNewTokens
  )
    throw new CapabilityTurnBudgetExceededError({
      level: "L2",
      newLoads: nextNewLoads,
      limitNew: CapabilityBudget.l2PerTurnMaxNew,
      newTokens: nextNewTokens,
      limitTokens: CapabilityBudget.l2PerTurnMaxNewTokens,
    })
  state.newLoads = nextNewLoads
  state.newTokens = nextNewTokens
  state.charged.add(loadIdentity)
}

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
    args.sessionIdentity,
    args.capabilityId,
    args.version,
    args.bodyHash,
    args.runtimeHash,
    args.permissionHash,
  )
  const tokenCount = args.body === undefined ? 0 : Token.estimate(args.body)
  if (tokenCount > CapabilityBudget.l2SingleMaxTokens)
    throw new CapabilityL2BudgetExceededError({
      level: "L2",
      limitTokens: CapabilityBudget.l2SingleMaxTokens,
      requestedTokens: tokenCount,
    })

  const current = turnBudgets.get(`${args.sessionIdentity}::${args.turnIdentity}`) ?? {
    newLoads: 0,
    newTokens: 0,
    charged: new Set<string>(),
  }
  if (
    !current.charged.has(identity) &&
    (current.newLoads + 1 > CapabilityBudget.l2PerTurnMaxNew ||
      current.newTokens + tokenCount > CapabilityBudget.l2PerTurnMaxNewTokens)
  )
    throw new CapabilityTurnBudgetExceededError({
      level: "L2",
      newLoads: current.newLoads + 1,
      limitNew: CapabilityBudget.l2PerTurnMaxNew,
      newTokens: current.newTokens + tokenCount,
      limitTokens: CapabilityBudget.l2PerTurnMaxNewTokens,
    })

  const result = loadCapabilityBody(identity, { body: args.body, declaredDigest: args.declaredDigest }, {
    bodyRef: args.bodyRef,
    capabilityId: args.capabilityId,
    version: args.version,
    runtimeHash: args.runtimeHash,
    permissionHash: args.permissionHash,
    supersedingRef: args.supersedingRef,
    deniedReason: args.deniedReason,
    sessionId: args.sessionIdentity,
    turnId: args.turnIdentity,
  })
  if (result.state === "budget_exceeded")
    throw new CapabilityL2BudgetExceededError({
      level: result.level,
      limitTokens: result.limitTokens,
      requestedTokens: result.requestedTokens,
    })
  if (result.state === "available")
    recordCapabilityTurnLoad(args.sessionIdentity, args.turnIdentity, identity, tokenCount)
  return result
}
