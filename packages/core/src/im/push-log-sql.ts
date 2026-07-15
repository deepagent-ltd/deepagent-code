import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as IMID from "./id"

// V4.0 §B4 — durable log of agent PROACTIVE pushes (one row per accepted/attempted push). Backs the
// §B2 rate-limit accounting (per agent per group per window) and the Oversight trace of what an agent
// pushed and why. Kept in its own table (not folded into im_messages) so the push audit — reason,
// priority, policy decision, idempotency key — is queryable independently of the delivered message.
export const AgentPushLogTable = sqliteTable(
  "im_agent_push_logs",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    group_id: text().$type<IMID.GroupID>().notNull(),
    agent_id: text().notNull(),
    // §B2 request fields.
    reason: text().notNull(),
    priority: text().notNull(),
    // the policy outcome: delivered | digest | blocked:<reason>. Recorded for the audit even when the
    // push was rejected (so a burst of blocked pushes is visible to Oversight).
    decision: text().notNull(),
    // §B2 去重: unique per push attempt. The UNIQUE index below makes this the storage-level dedup key
    // (mirrors deepagent_event.idempotency_key) — a re-attempt with the same key is a no-op, not a
    // second delivery.
    idempotency_key: text().notNull(),
    // the delivered message id when the push resulted in an im_messages row (null for digest/blocked).
    message_id: text().$type<IMID.MessageID>(),
    // §B2 静默时段: the SCRUBBED content, retained for `digest` outcomes so the (later) digest builder
    // has a source to batch. Null for blocked pushes (nothing to deliver). Delivered pushes carry it
    // too for the audit trail.
    content: text(),
    created_at: integer().notNull(),
    // §E4 digest flush marker: a `decision='digest'` push is held during quiet hours (no message
    // written). NULL ⇒ still held (awaiting the quiet-hours-end digest); set to the flush epoch ms once
    // the DigestBuilder has batched + delivered it, so a flushed row is never re-delivered (idempotent).
    digest_flushed_at: integer(),
  },
  (table) => [
    // §B2 去重: storage-enforced one-delivery-per-key.
    uniqueIndex("idx_im_agent_push_logs_idempotency").on(table.idempotency_key),
    // §B2 rate-limit scan + Oversight timeline: this agent's recent pushes to a group, newest first.
    // Mirrors docs §B4 idx_im_agent_push_logs_agent_time.
    index("idx_im_agent_push_logs_agent_time").on(table.agent_id, table.group_id, table.created_at),
    // per-workspace audit sweep.
    index("idx_im_agent_push_logs_workspace").on(table.workspace_id, table.created_at),
    // §E4 digest scan: unflushed held-digest rows per workspace (decision='digest' AND
    // digest_flushed_at IS NULL) so the DigestBuilder finds pending digests without a full-table scan.
    index("idx_im_agent_push_logs_digest_pending").on(
      table.workspace_id,
      table.decision,
      table.digest_flushed_at,
    ),
  ],
)

export * as PushLogSql from "./push-log-sql"
