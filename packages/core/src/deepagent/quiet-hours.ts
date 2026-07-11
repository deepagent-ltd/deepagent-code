export * as QuietHours from "./quiet-hours"

import { DeepAgentEvent } from "./deepagent-event"

// V4.0 §E4 — the QUIET-HOURS decision POLICY. A PURE, deterministic function: given the event's
// priority and whether "now" falls inside the workspace's configured quiet window, it decides whether
// a proactive push is delivered immediately, deferred into a digest, or delivered instantly-but-logged.
//
// LAYERING: lives in `core`, imports NOTHING runtime. The caller resolves `withinQuietHours` (via the
// `isWithinQuietHours` helper below or its own tz logic) and passes it in, so this stays pure.
//
// §E4 责任, mapped to `decide`:
//   normal/low proactive push during quiet hours → 汇总为摘要 (digest), delivered when quiet hours end.
//   high/critical → 允许即时送达, but the caller MUST record the reason (requiresReason:true).
//   outside quiet hours → deliver normally.

export type QuietHoursDecision =
  | { readonly action: "deliver" }
  | { readonly action: "digest" }
  | { readonly action: "deliver"; readonly requiresReason: true }

export interface QuietHoursInput {
  readonly priority: DeepAgentEvent.EventPriority
  // resolved by the caller (see `isWithinQuietHours`) — is "now" inside the workspace's quiet window?
  readonly withinQuietHours: boolean
}

/**
 * §E4 — the pure quiet-hours decision:
 *   - outside quiet hours            → { action: "deliver" }.
 *   - inside, low/normal priority    → { action: "digest" } (defer into the quiet-hours digest).
 *   - inside, high/critical priority → { action: "deliver", requiresReason: true } (instant, but the
 *                                       caller MUST record WHY it broke through quiet hours).
 */
export const decide = (input: QuietHoursInput): QuietHoursDecision => {
  if (!input.withinQuietHours) return { action: "deliver" }

  if (input.priority === "high" || input.priority === "critical") {
    return { action: "deliver", requiresReason: true }
  }

  return { action: "digest" }
}

/**
 * §E4 helper — does the instant `now` (epoch ms, UTC) fall within [startHour, endHour) in the
 * workspace's local time? Pure and deterministic.
 *
 * `tzOffsetMinutes` is the workspace's offset from UTC in minutes (e.g. +480 for UTC+8, -300 for
 * UTC-5); it defaults to 0 (UTC). The local hour is derived arithmetically from the epoch so there is
 * no dependency on the host's timezone or Date locale.
 *
 * Wrap-around: when `startHour > endHour` the window spans midnight (e.g. 22→6 means 22:00–05:59), so
 * an hour qualifies if it is >= start OR < end. When `startHour === endHour` the window is empty
 * (never quiet). The comparison is inclusive of `startHour` and exclusive of `endHour`.
 */
export const isWithinQuietHours = (
  now: number,
  startHour: number,
  endHour: number,
  tzOffsetMinutes: number = 0,
): boolean => {
  if (startHour === endHour) return false

  // Shift epoch by the tz offset, then take the hour-of-day in [0,24).
  const localMs = now + tzOffsetMinutes * 60_000
  const localHour = Math.floor(localMs / 3_600_000) % 24
  const hour = localHour < 0 ? localHour + 24 : localHour

  if (startHour < endHour) {
    return hour >= startHour && hour < endHour
  }
  // wrap-around window spanning midnight.
  return hour >= startHour || hour < endHour
}
