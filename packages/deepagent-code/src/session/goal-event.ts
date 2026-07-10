import { Schema } from "effect"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionID } from "./schema"

/**
 * V3.9 §D — the live Goal Loop event. Published whenever a goal's phase or ledger changes (start, each
 * tick's status, pause/resume, terminal). Mirrors `plan.updated` so it flows through the same SSE
 * stream the app already consumes; the app reducer projects it into a per-session goal status bar
 * (Codex thread-goal style: Active / Paused / Blocked-ish (needs_human) / Complete).
 *
 * `phase` is the DRIVER-level phase (adds "paused" over the core GoalPhase). `ledger` is the observable
 * budget accounting (ticks / tokens / cost / wallclock) so the UI can render a live "12k / 50k tokens"
 * progress readout. `gaps` are the unmet-criterion descriptions when the loop escalates (needs_human).
 */
export const GoalLedgerEvent = Schema.Struct({
  ticks: Schema.Number,
  tokens: Schema.Number,
  cost: Schema.Number,
  wallclockMs: Schema.Number,
})

export const GoalEvent = {
  Updated: EventV2.define({
    type: "goal.updated",
    schema: {
      sessionID: SessionID,
      goalId: Schema.String,
      planDocId: Schema.String,
      /** running | paused | done | needs_human | rolled_back | stopped (driver-level GoalPointerPhase). */
      phase: Schema.String,
      ledger: GoalLedgerEvent,
      stallCount: Schema.Number,
      /** Unmet-criterion / gap descriptions surfaced when the loop escalates or completes. */
      gaps: Schema.Array(Schema.String),
    },
  }),
}
