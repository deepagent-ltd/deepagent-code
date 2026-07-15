import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"

// V4.0 §A4 — durable persistence for the Scheduler. Unlike `BackgroundJob` (core/src/background-job.ts,
// EXPLICITLY non-durable — a restart loses live jobs), the V4.0 Scheduler must survive process restarts:
// a delayed event scheduled before a crash still fires after recovery, and periodic scans resume on
// their cadence. So schedule entries are rows here, re-hydrated on boot and driven by a tick loop
// (the loop lives in deepagent-code; this table + the Scheduler service in core own the durable state).
//
// Three §A4 kinds share one table (`kind`):
//   delay     — fire the templated event once at `fire_at`, then status → fired.
//   periodic  — fire every `interval_ms`; on fire, advance `fire_at` and stay active.
//   condition — fire when a threshold of trigger events is observed in a window (e.g. 连续 3 次 CI 失败).
//               `fire_at` is the next re-check time; the condition body lives in `condition` (JSON).
export const DeepAgentScheduleTable = sqliteTable(
  "deepagent_schedule",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    // delay | periodic | condition
    kind: text().$type<"delay" | "periodic" | "condition">().notNull(),
    // active | fired | cancelled. `delay` flips to `fired` after it fires; `periodic`/`condition` stay
    // `active` until cancelled (a condition may fire repeatedly across its lifetime).
    status: text().$type<"active" | "fired" | "cancelled">().notNull(),
    // the PublishInput (minus id/createdAt/idempotencyKey defaults) emitted when this schedule fires.
    // Stored as JSON; the tick loop hands it to EventBus.publish. idempotencyKey is derived per fire.
    event_template: text({ mode: "json" }).$type<unknown>().notNull(),
    // delay: absolute fire time. periodic: next fire time (advanced on each fire). condition: next
    // re-check time (nullable ⇒ check every tick).
    fire_at: integer(),
    // periodic only: the cadence in ms.
    interval_ms: integer(),
    // condition only: JSON { eventType, threshold, windowMs }. See scheduler.ts ConditionSpec.
    condition: text({ mode: "json" }).$type<unknown>(),
    // last time this schedule actually fired (for periodic drift accounting + observability).
    last_fired_at: integer(),
    // OPTIONAL stable dedupe key for schedules that must be registered idempotently across restarts
    // (e.g. the boot-time §A4 bootstrap schedules). NULL for ordinary ad-hoc schedules — and since
    // SQLite treats NULLs as distinct in a UNIQUE index, the uniqueness below constrains ONLY keyed
    // rows, leaving every unkeyed schedule free. This closes the multi-process TOCTOU on a list-then-
    // insert bootstrap: a concurrent second insert of the same key is rejected at the DB layer.
    schedule_key: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    // tick scan: active schedules whose next fire/check time has elapsed, oldest first.
    index("deepagent_schedule_due_idx").on(table.status, table.fire_at),
    // per-workspace listing + retention.
    index("deepagent_schedule_workspace_idx").on(table.workspace_id, table.status),
    // idempotent bootstrap: at most one row per non-null schedule_key. Unkeyed rows (schedule_key NULL)
    // are unconstrained (NULLs distinct in SQLite unique indexes) — a natural partial-unique semantics.
    uniqueIndex("deepagent_schedule_key_uidx").on(table.schedule_key),
  ],
)

export * as SchedulerSql from "./scheduler-sql"
