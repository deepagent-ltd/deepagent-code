// BUG-407-012 gap C: drizzle-orm type bindings for session_turn_stage_evidence.
// One row per (session_id, activity_id), upserted forward-only as the provider turn
// crosses each boundary. Observability evidence only — never an authority.
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export type TurnStage =
  | "activity_claimed"
  | "snapshot_started"
  | "snapshot_finished"
  | "snapshot_degraded"
  | "history_loaded"
  | "request_prepared"
  | "provider_dispatch_started"
  | "terminal_settled"

export const SessionTurnStageEvidenceTable = sqliteTable(
  "session_turn_stage_evidence",
  {
    session_id: text().notNull(),
    activity_id: text().notNull(),
    stage: text().$type<TurnStage>().notNull(),
    details: text({ mode: "json" }).$type<Record<string, unknown>>(),
    stage_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.activity_id] })],
)
