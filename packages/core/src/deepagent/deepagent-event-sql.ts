import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { DeepAgentEvent } from "./deepagent-event"

// V4.0 §A3 — durable persistence for the DeepAgent Event Bus. The design principle is "事件先持久化，
// 再分发" (§设计原则1): publish() writes here in a transaction BEFORE any dispatch, so a crash never
// loses a triggered event. These tables sit ALONGSIDE the lower-level EventV2 `event`/`event_sequence`
// tables (core/src/event/sql.ts) — that log is the per-aggregate sync substrate; this one is the
// domain-event bus with retry/DLQ/priority/dedup semantics EventV2 does not model.

// The main event log. One row per published DeepAgentEvent. `idempotency_key` is UNIQUE — the §A3 幂等
// contract is enforced at the storage layer (a duplicate publish is a no-op, not a second row).
export const DeepAgentEventTable = sqliteTable(
  "deepagent_event",
  {
    id: text().$type<DeepAgentEvent.ID>().primaryKey(),
    type: text().notNull(),
    source: text().$type<DeepAgentEvent.EventSource>().notNull(),
    workspace_id: text().notNull(),
    project_id: text(),
    actor_id: text(),
    correlation_id: text(),
    causation_id: text(),
    idempotency_key: text().notNull(),
    priority: text().$type<DeepAgentEvent.EventPriority>().notNull(),
    payload: text({ mode: "json" }).$type<unknown>(),
    created_at: integer().notNull(),
    // §F1 event_publish_latency_ms — wall-clock delta (injected clock) around the persist transaction,
    // written by the bus on publish. Nullable/ADDITIVE (§H): pre-latency rows read null and are excluded
    // from the Observability percentile samples.
    publish_latency_ms: integer(),
  },
  (table) => [
    // §A3 幂等: storage-enforced dedupe. A re-publish with the same key hits this constraint → no-op.
    uniqueIndex("deepagent_event_idempotency_idx").on(table.idempotency_key),
    // §A4 去重窗口 + §F2 trace: scan same-type recent events (10s dedupe) and follow correlation chains.
    index("deepagent_event_type_created_idx").on(table.type, table.created_at),
    index("deepagent_event_correlation_idx").on(table.correlation_id, table.created_at),
    // §A3 保留期: workspace-scoped retention sweep (default 30 天, per-workspace configurable).
    index("deepagent_event_workspace_created_idx").on(table.workspace_id, table.created_at),
  ],
)

// §A3 delivery/retry state — one row per (event, subscription group) delivery attempt tracker. Kept
// separate from the immutable event log so retry bookkeeping never mutates the audit record. `status`
// drives the retry loop; `attempts` backs the exponential-backoff schedule; a terminal failure flips
// `status` to `dead` and the event surfaces in the DLQ view.
export const DeepAgentEventDeliveryTable = sqliteTable(
  "deepagent_event_delivery",
  {
    event_id: text()
      .$type<DeepAgentEvent.ID>()
      .notNull()
      .references(() => DeepAgentEventTable.id, { onDelete: "cascade" }),
    subscription_group: text().notNull(),
    // pending → delivered | dead. `pending` rows with next_attempt_at <= now are eligible for retry.
    status: text().$type<"pending" | "delivered" | "dead">().notNull(),
    attempts: integer().notNull(),
    last_error: text(),
    next_attempt_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    // one delivery tracker per (event, group).
    uniqueIndex("deepagent_event_delivery_unique_idx").on(table.event_id, table.subscription_group),
    // retry scan: pending rows whose backoff has elapsed, oldest first.
    index("deepagent_event_delivery_due_idx").on(table.status, table.next_attempt_at),
  ],
)
