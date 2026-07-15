import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

// V4.0 — per-workspace configuration store. One row per workspace holding the V4 policy knobs that
// four subsystems need but that must be tunable per tenant rather than baked into code:
//   §A3 retention   — how many days of durable events/audit to keep before the retention sweep prunes.
//   §E4 quiet hours — the workspace's quiet-hours window (local start/end hour + tz offset) for the
//                     agent-push digest gate.
//   §E2 rate limits — per-workspace overrides for the event-publish + agent-execution ceilings.
//   §E1 trust       — the set of event sources this workspace trusts (security-gate layer 1).
// Stored as a single JSON `config` blob (schema-versioned, forward-compatible) rather than a wide row,
// so adding a knob is a schema-version bump, not a migration. Absent row ⇒ the code's lenient defaults.
export const WorkspaceConfigTable = sqliteTable("deepagent_workspace_config", {
  workspace_id: text().primaryKey(),
  // JSON: WorkspaceConfig.Settings (see workspace-config.ts). Nullable columns are avoided — the whole
  // config is one validated blob so partial writes can't leave an inconsistent row.
  config: text({ mode: "json" }).$type<unknown>().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})

export * as WorkspaceConfigSql from "./workspace-config-sql"
