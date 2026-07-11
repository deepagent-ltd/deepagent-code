export * as PanelConvenePolicy from "./panel-convene-policy"

import { DeepAgentEvent } from "./deepagent-event"

// V4.0 §M — the Expert Panel AUTO-CONVENE policy. In V3.9 a panel was convened only by an explicit
// in-session Convener call; V4.0 lets the Event Router auto-summon a panel for high-risk events
// (destructive migration PRs, security alerts, architecture changes) AFTER a policy check. This module
// is that PURE policy: given an event, decide whether to auto-convene, and if so at what urgency. The
// deepagent-code wiring subscribes to the bus, calls shouldConvene(), and (on convene) drives the
// EXISTING V3.9 panel orchestrator — this module adds NO new panel mechanics (Arbiter, same-question
// dispatch, minority retention, fail-closed all stay V3.9).
//
// LAYERING: `core`, pure (no Effect/DB). The wiring resolves the flag + rate limits and dispatches.

// A signal that marks an event as high-risk enough to warrant a panel. Rule-driven so new risk classes
// are declarative. `match` is the event type (exact or `prefix.*`); `when` is an optional predicate on
// the payload for finer control (e.g. only destructive migrations, only high/critical alerts).
export interface RiskRule {
  readonly match: string
  readonly riskClass: RiskClass
  // optional payload predicate; omitted ⇒ the type match alone qualifies.
  readonly when?: (payload: Record<string, unknown>) => boolean
}

export type RiskClass = "security" | "destructive_migration" | "architecture_change" | "repeated_failure"

const matchesType = (pattern: string, eventType: string): boolean => {
  if (pattern === eventType || pattern === "*") return true
  if (pattern.endsWith(".*")) return eventType.startsWith(pattern.slice(0, -1))
  return false
}

const asRecord = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}

// §M default high-risk rules. Ordered; the FIRST matching rule classifies the event.
export const DEFAULT_RULES: ReadonlyArray<RiskRule> = [
  // security alerts always convene.
  { match: "monitor.alert", riskClass: "security", when: (p) => p.category === "security" || p.severity === "critical" },
  // a PR flagged as a destructive/irreversible migration.
  { match: "pr.comment", riskClass: "destructive_migration", when: (p) => p.destructive === true || p.migration === true },
  { match: "git.push", riskClass: "destructive_migration", when: (p) => p.destructive === true },
  // an explicit architecture-change signal.
  { match: "pr.comment", riskClass: "architecture_change", when: (p) => p.architectureChange === true },
  // CI failing repeatedly (the §A4 condition-trigger shape) is worth a diagnostic panel.
  { match: "ci.failure", riskClass: "repeated_failure", when: (p) => typeof p.consecutiveFailures === "number" && (p.consecutiveFailures as number) >= 3 },
]

export type ConveneDecision =
  | { readonly type: "convene"; readonly riskClass: RiskClass; readonly urgency: DeepAgentEvent.EventPriority }
  | { readonly type: "skip"; readonly reason: "flag_disabled" | "no_risk_match" }

/**
 * §M — decide whether an event auto-convenes a panel.
 *   1. flag gate  → skip flag_disabled when the auto-convene feature is off (fail-closed: no panel).
 *   2. risk match → skip no_risk_match when no risk rule applies.
 *   3. convene    → carry the risk class + an urgency derived from the event priority (critical/high
 *                   events keep their urgency; a matched security risk is escalated to at least high).
 * Enabling the feature is intentionally distinct from the panel body being available — a disabled flag
 * means "don't auto-summon", NOT "panels don't exist" (explicit V3.9 convening is unaffected).
 */
export const shouldConvene = (input: {
  readonly event: DeepAgentEvent.Event
  readonly flagEnabled: boolean
  readonly rules?: ReadonlyArray<RiskRule>
}): ConveneDecision => {
  if (!input.flagEnabled) return { type: "skip", reason: "flag_disabled" }

  const rules = input.rules ?? DEFAULT_RULES
  const payload = asRecord(input.event.payload)
  const rule = rules.find((r) => matchesType(r.match, input.event.type) && (r.when ? r.when(payload) : true))
  if (!rule) return { type: "skip", reason: "no_risk_match" }

  // urgency: an auto-convened panel is BY DEFINITION high-risk, so floor EVERY convening event to at
  // least "high". This matters because §A4 backpressure (event-router.ts) drops low/normal events when
  // the queue is full — a destructive-migration/architecture/security convene request must not be
  // silently discardable at low/normal. Critical is carried through unchanged.
  const base = input.event.priority
  const urgency: DeepAgentEvent.EventPriority = base === "critical" ? "critical" : "high"

  return { type: "convene", riskClass: rule.riskClass, urgency }
}
