import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// V4.0 §D2/§F — durable HUMAN TAKEOVER log. A "takeover" is the moment a human steps IN over an agent:
// pausing/reverting an agent's session, or claiming a branch/session an agent was driving. The §D2
// Takeover surface needs a record of these so an operator can see WHEN and BY WHOM control was reclaimed,
// and §F exposes the count as the `human_takeover_total` metric. One append-only row per takeover event —
// this is an audit record (never mutated), kept separate from the Approval Queue (whose rows are mutable
// pending→resolved decisions) because a takeover is an already-happened FACT, not a request awaiting one.
export const HumanTakeoverTable = sqliteTable(
  "deepagent_human_takeover",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    // the session the human took over (an agent's session / a goal session). Optional so a branch-level
    // takeover with no single session can still be recorded.
    session_id: text(),
    // the agent whose work was taken over, when known (the acting agent id).
    agent_id: text(),
    // the human actor who reclaimed control (routed workspace identity / user id).
    actor_id: text(),
    // a short, free-form reason ("paused", "reverted", "claimed_branch", …) for the §D2 surface.
    reason: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    // §F metric + §D2 surface: a workspace's takeovers over a window, newest first.
    index("deepagent_human_takeover_workspace_idx").on(table.workspace_id, table.created_at),
  ],
)

export * as HumanTakeoverSql from "./human-takeover-sql"
