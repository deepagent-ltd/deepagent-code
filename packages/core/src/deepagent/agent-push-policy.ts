export * as AgentPushPolicy from "./agent-push-policy"

import { DeepAgentEvent } from "./deepagent-event"
import { ContentSafety } from "./content-safety"
import { QuietHours } from "./quiet-hours"

// V4.0 §B2 — the Agent Push Policy gate. An agent's PROACTIVE outbound message (not a reply to a human
// turn) must clear this gate before it lands in `im_messages`. This is PURE: the caller resolves the
// facts (is the agent a group member / does it hold workspace push permission, how many pushes this
// agent→group already did this hour, is it within quiet hours) and this function decides the outcome.
// Composes the §E primitives (ContentSafety §E3, QuietHours §E4) with the §B2 permission + rate rules.
//
// LAYERING: `core`. No Effect/DB — the deepagent-code wiring resolves membership + the rate count (from
// im_agent_push_logs) + quiet-hours window and calls decide(); it then persists the (scrubbed) message
// and appends a push-log row. Gated by the v4AgentPushEnabled flag upstream (a disabled flag never
// reaches here).

// §B2 the push request contract (mirrors docs §B2 AgentPushRequest).
export interface AgentPushRequest {
  readonly workspaceID: string
  readonly groupID: string
  readonly agentID: string
  readonly reason: string
  readonly priority: DeepAgentEvent.EventPriority
  readonly content: string
  readonly idempotencyKey: string
}

// §B2 default rate ceiling — per agent per group. Lenient per the standing "don't over-restrict"
// constraint; deployments tighten it.
export const DEFAULT_PUSH_LIMIT_PER_HOUR = 20
export const PUSH_WINDOW_MS = 3_600_000

// The resolved facts the gate needs (the caller looks these up).
export interface PushFacts {
  // §B2 权限: the agent is a member of the target group OR holds workspace push permission.
  readonly isGroupMember: boolean
  readonly hasWorkspacePushPermission: boolean
  // §B2 限流: how many pushes this (agent, group) already sent in the current window.
  readonly pushesThisWindow: number
  // §B2 静默时段: is the target workspace currently within quiet hours?
  readonly withinQuietHours: boolean
  // optional overrides.
  readonly pushLimitPerHour?: number
  // content-safety config: allowed external-link hosts + max content length.
  readonly allowedLinkHosts?: ReadonlyArray<string>
  readonly maxContentChars?: number
}

export type PushDecision =
  // deliver now — `content` is the SCRUBBED content to persist; `requiresReason` (quiet-hours
  // high/critical passthrough) means the caller MUST record `reason` on the message/log.
  | { readonly type: "deliver"; readonly content: string; readonly requiresReason: boolean; readonly promptInjectionSuspected: boolean }
  // hold for the quiet-hours digest (normal/low during quiet hours) — the scrubbed content is carried
  // so the digest builder can batch it.
  | { readonly type: "digest"; readonly content: string; readonly promptInjectionSuspected: boolean }
  // rejected — fail-closed. `reason` is the machine code; carries the failing check.
  | { readonly type: "blocked"; readonly reason: PushBlockReason }

export type PushBlockReason = "not_authorized" | "rate_limited"

/**
 * §B2 — decide the fate of a proactive agent push. Order (fail-closed first):
 *   1. 权限   → not_authorized unless group member OR workspace push permission.
 *   2. 限流   → rate_limited when pushesThisWindow >= limit.
 *   3. 内容安全 → scrub content (redact secrets / strip off-allowlist links / truncate); the injection
 *               flag is CARRIED to the caller (a flag, not a hard block, per §E3), never silently sent.
 *   4. 静默时段 → normal/low → digest; high/critical → deliver with requiresReason.
 * Note: 去重 (idempotencyKey) is enforced at the persistence layer (unique key), not here.
 */
export const decide = (request: AgentPushRequest, facts: PushFacts): PushDecision => {
  // 1. 权限
  if (!facts.isGroupMember && !facts.hasWorkspacePushPermission) {
    return { type: "blocked", reason: "not_authorized" }
  }

  // 2. 限流
  const limit = facts.pushLimitPerHour ?? DEFAULT_PUSH_LIMIT_PER_HOUR
  if (facts.pushesThisWindow >= limit) {
    return { type: "blocked", reason: "rate_limited" }
  }

  // 3. 内容安全 — scrub before any delivery decision so digest + deliver both carry clean content.
  const scrubbed = ContentSafety.scrub({
    content: request.content,
    ...(facts.allowedLinkHosts != null ? { allowedLinkHosts: facts.allowedLinkHosts } : {}),
    ...(facts.maxContentChars != null ? { maxLogChars: facts.maxContentChars } : {}),
  })

  // 4. 静默时段
  const quiet = QuietHours.decide({ priority: request.priority, withinQuietHours: facts.withinQuietHours })
  if (quiet.action === "digest") {
    return { type: "digest", content: scrubbed.content, promptInjectionSuspected: scrubbed.promptInjectionSuspected }
  }
  return {
    type: "deliver",
    content: scrubbed.content,
    requiresReason: "requiresReason" in quiet ? quiet.requiresReason === true : false,
    promptInjectionSuspected: scrubbed.promptInjectionSuspected,
  }
}
