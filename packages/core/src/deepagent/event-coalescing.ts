export * as EventCoalescing from "./event-coalescing"

import type { EventRisk, EventWorkEnvelope } from "../contract/event-envelope"
import { validateEventWorkEnvelope } from "../contract/event-envelope"

// C5-07 — COALESCING / BACKPRESSURE / QUOTA POLICY (PURE + deterministic). Design authority:
// docs/core-v2.0-beta/design.md §8.4 (router order: ... dedupe/coalesce -> priority/backpressure ->
// durable task admission) + §8.6 (low 合并; normal 受回压; high/critical 不丢失但 durable 排队、延迟执行或
// 升级人工，不能无限并发) + §8.8 (coalescing window, fact reducer, 同一根因重复 low 合并保留计数/首尾时间/refs).
//
// This is the DECISION + MERGE policy — a pure function of the envelope + the routing state. It has no
// Effect, no DB, no clock, and decides what the router hands to the durable admission/spool:
//   - low       : a same-(session/consumer/kind) envelope already in the coalescing WINDOW MERGES into a
//                 single bounded envelope (identity preserved on the base); otherwise it admits.
//   - normal    : a per-consumer rate limit is enforced; a normal event that EXCEEDS the rate is SPOOLED
//                 (durable queue) — NEVER silently dropped.
//   - high/critical : NEVER merge, NEVER drop — always go to the durable SPOOL, drained with bounded
//                 concurrency (§8.6: 高优先不丢但不无限并发).
//
// LAYERING: `core`. Pure — the durable spool (event-spool.ts) and the admission (event-admission.ts)
// consume the decision. Coalescing is a routing-time concept: the merge produces ONE bounded envelope
// (the contract's `verifiedFacts` array is what accumulates), and the count / first-last times are
// carried out-of-band by the caller's coalescing window (the frozen contract has no time field).

/** The drain priority the spool orders by. Envelope risk maps `medium` -> `normal` (§8.6 use of terms). */
export type DrainPriority = "low" | "normal" | "high" | "critical"

// Higher = more urgent. The drain order is critical > high > normal > low.
export const DRAIN_RANK: Record<DrainPriority, number> = { low: 0, normal: 1, high: 2, critical: 3 }

export const riskToDrainPriority = (risk: EventRisk): DrainPriority => (risk === "medium" ? "normal" : risk)

/** A stable coalescing key: same session target, same consumer, same event kind. */
export interface CoalesceKey {
  readonly session: string
  readonly consumer: string
  readonly kind: string
}

export const coalesceKey = (envelope: EventWorkEnvelope, consumer?: string): CoalesceKey => ({
  session: envelope.actorAndScope.workspaceId,
  consumer: consumer ?? envelope.delivery.consumerGroupId,
  kind: envelope.eventType,
})

/** Newer envelope was seen in the same-key window → should coalesce? */
export const isLowMergeable = (envelope: EventWorkEnvelope): boolean =>
  riskToDrainPriority(envelope.risk) === "low"

/** Does the base + incoming pair (same key) fall within the coalescing window? */
export const inSameWindow = (base: CoalesceKey, key: CoalesceKey): boolean =>
  base.session === key.session && base.consumer === key.consumer && base.kind === key.kind

export interface CoalesceContext {
  readonly now: number
  /** The most-recent same-key low event's timestamp (the coalescing window anchor). Omit if none. */
  readonly lastSeenSameKeyAt?: number
  readonly windowMs: number
  /** Per-consumer rate state for the NORMAL throttle. `usedInWindow` = events already accepted in the window. */
  readonly consumerRate: { readonly limit: number; readonly usedInWindow: number }
}

export type CoalesceDecision =
  | { readonly action: "merge" }
  | { readonly action: "admit" }
  | { readonly action: "spool"; readonly priority: DrainPriority; readonly throttled: boolean }

/**
 * The C5-07 routing decision for one bounded envelope.
 *
 *   1. high/critical → `spool` (never merge, never drop). Drained later under bounded concurrency (§8.6).
 *   2. normal       → `spool` when the per-consumer rate is exceeded (throttled — NEVER silently drop);
 *                     else `admit`.
 *   3. low          → `merge` when a same-key envelope already sits in the coalescing window; else `admit`.
 */
export const classify = (envelope: EventWorkEnvelope, ctx: CoalesceContext): CoalesceDecision => {
  const priority = riskToDrainPriority(envelope.risk)
  if (priority === "high" || priority === "critical") return { action: "spool", priority, throttled: false }
  if (priority === "normal") {
    const exceeded = ctx.consumerRate.usedInWindow >= ctx.consumerRate.limit
    return exceeded ? { action: "spool", priority, throttled: true } : { action: "admit" }
  }
  if (ctx.lastSeenSameKeyAt != null && ctx.now - ctx.lastSeenSameKeyAt <= ctx.windowMs) return { action: "merge" }
  return { action: "admit" }
}

/**
 * MERGE SHAPE (design §8.8: 同一根因的重复 low observation 合并，保留计数/首尾时间和 refs). The frozen
 * contract has no time/count field, so the merge accumulates the only mergeable member — `verifiedFacts`
 * (deduped by factId) — and preserves the BASE envelope's identity (eventRef), payload ref, objective,
 * capability, correlation, and delivery cursor. The incoming NOT-later event must be low; the merge is a
 * no-op identity when it is not. The window's count/first-last-time bookkeeping is returned out-of-band
 * (`mergeStats`), not on the frozen envelope.
 *
 * The merge is BOUNDED: it reads only the two frozen envelopes (which carry payload by reference) and
 * never touches raw payload bytes, so a merged bundle can never leak an unbounded history (§8.8).
 */
export const mergeEnvelopes = (base: EventWorkEnvelope, incoming: EventWorkEnvelope): EventWorkEnvelope => {
  if (!isLowMergeable(base) || !isLowMergeable(incoming)) return base
  const facts = new Map<string, { factId: string; factHash: string }>()
  for (const fact of [...base.verifiedFacts, ...incoming.verifiedFacts]) facts.set(fact.factId, fact)
  const merged: EventWorkEnvelope = {
    ...base,
    verifiedFacts: [...facts.values()],
  }
  // Re-validate through the frozen contract: a merge that does not round-trip is not a valid envelope.
  const validation = validateEventWorkEnvelope(merged)
  return validation.ok ? validation.value : base
}

/** Out-of-band bookkeeping the coalescing window carries (a merge is more than one root-cause event). */
export const mergeStats = (
  firstSeenAt: number,
  lastSeenAt: number,
  mergedEvents: number,
  facts: ReadonlyArray<string>,
): { readonly firstSeenAt: number; readonly lastSeenAt: number; readonly mergedEvents: number; readonly factIds: ReadonlyArray<string> } => ({
  firstSeenAt,
  lastSeenAt,
  mergedEvents,
  factIds: facts,
})

/** The per-consumer rate budget for the normal-throttle path (design §8.6). Default 5/s per consumer. */
export const DEFAULT_NORMAL_RATE_LIMIT = 5
export const DEFAULT_NORMAL_RATE_WINDOW_MS = 1000
