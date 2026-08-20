import { index, sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { DeepAgentEvent } from "./deepagent-event"

// FEAT-008 — durable admission receipt for `agent.handoff.requested` processing.
//
// WHY A NEW TABLE (and not reuse of an existing one):
//   - `deepagent_event_delivery` tracks DELIVERY lifecycle only (pending → delivered | dead). It has
//     no handoff identity and cannot express the BUSINESS terminal states accepted/rejected, so after
//     a crash it cannot answer "未处理 / 处理中 / 已完成" for a handoff request — only "was the event
//     acked by this group".
//   - `task_admission` is the subagent control-plane receipt for task_run admission (keyed by
//     run/origin_key); its schema and idempotency semantics are orthogonal to handoff admission.
//   - `agent_execution` is the per-task execution state machine; it is only touched once the handoff
//     passes validation (a reject during validation — missing original event, security gate, etc. —
//     must still leave a durable "rejected" receipt), and it never models the in-flight "processing"
//     admission of the consumer itself.
//
// One row per handoffID. The consumer writes `processing` at the START of handling (before any
// side-effecting decision) and settles to `accepted`/`rejected` on the terminal outcome. A row stuck
// in `processing` after a crash means "not finished" — the retry pump re-admits it (begin() re-stamps
// the claimant) once the delivery claim's lease lapses; a TERMINAL row is never overwritten, so a
// redelivery short-circuits without re-running side effects.
export const DeepAgentHandoffAdmissionTable = sqliteTable(
  "deepagent_handoff_admission",
  {
    // the handoff request's identity (payload.handoffID) — one admission per handoff request.
    handoff_id: text().primaryKey(),
    // the bus event that carries the handoff request (§F2 trace spine).
    event_id: text().$type<DeepAgentEvent.ID>().notNull(),
    workspace_id: text().notNull(),
    // processing → accepted | rejected. `processing` rows are "not finished" and re-admissible.
    state: text().$type<"processing" | "accepted" | "rejected">().notNull(),
    // who is currently handling (or last settled) the admission — the delivery claim's claimant id
    // on the pump path, a stable consumer tag on the live-subscription path.
    claimant_id: text().notNull(),
    // the terminal reject reason (mirrors the rejectHandoff reason), null while processing/accepted.
    reason: text(),
    started_at: integer().notNull(),
    updated_at: integer().notNull(),
    // when the admission reached its terminal state (null while processing).
    settled_at: integer(),
  },
  (table) => [
    // crash-recovery scan: outstanding (non-terminal) admissions per tenant.
    index("deepagent_handoff_admission_workspace_state_idx").on(table.workspace_id, table.state),
    // trace lookup: which admission a handoff event produced.
    uniqueIndex("deepagent_handoff_admission_event_idx").on(table.event_id),
  ],
)
