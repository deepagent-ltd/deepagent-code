export * as IMTaskStatusLocator from "./task-status-locator"

import { and, eq, isNull, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { IMTaskStatusNotice } from "@deepagent-code/core/im/task-status-notice"
import { IMTaskStatusNoticeSchema } from "@deepagent-code/core/im/task-status-notice.schema"
import { IMTaskSourceTable } from "@deepagent-code/core/im/task-authority.sql"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { GroupTable, MemberTable, MessageTable, TaskStatusNoticeMetadata } from "@deepagent-code/core/im/sql"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { IMReplyOutboxTable } from "./im-reply-outbox"
import { IMTaskState } from "./task-state"

const ID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const fields = { version: Schema.Literal(1), messageID: ID, groupID: ID }
export const Result = Schema.Union([
  Schema.Struct({ ...fields, state: Schema.Literal("available"),
    notice: Schema.Struct({ noticeID: ID, kind: IMTaskStatusNoticeSchema.Kind, createdAt: Schema.Int }),
    task: Schema.Struct({ requestID: ID, instanceID: ID,
      directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
      disposition: Schema.Literals(["open", "refused"]),
      grant: Schema.NullOr(Schema.Struct({ state: Schema.Literals(["active", "revoked"]), revision: Schema.Int })),
      work: Schema.NullOr(Schema.Struct({ workID: ID, sessionID: ID, outcome: WorkAuthoritySchema.Outcome,
        controlState: WorkAuthoritySchema.ControlState, recoveryRequired: Schema.Boolean,
        hasExecutionClaim: Schema.Boolean, processActive: Schema.Boolean })),
    }),
  }),
  Schema.Struct({ ...fields, state: Schema.Literal("unavailable"),
    code: Schema.Literals(["not_task_status", "status_changed", "delivery_unknown", "placement_unavailable"]),
  }),
])
export type Result = typeof Result.Type

/** A fixed notice locates the current owned task, never an assistant result. Original
 * reader visibility and authenticated task management are both supplied by the caller. */
export const make = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const states = yield* IMTaskState.make
  const read = (input: { messageID: string; workspaceID: string; userID: string; directory: string }) => Effect.gen(function* () {
    const visibleMessage = yield* KernelReader.messagePredicate(db)
    const found = yield* db.transaction((tx) => Effect.gen(function* () {
      const visible = yield* tx.select({ message: MessageTable, group: GroupTable,
        ordinary: sql<number>`CASE WHEN ${KernelReader.ordinaryGroup} THEN 1 ELSE 0 END` })
        .from(MessageTable).innerJoin(GroupTable, eq(GroupTable.id, MessageTable.group_id))
        .innerJoin(MemberTable, and(eq(MemberTable.group_id, GroupTable.id), eq(MemberTable.member_id, input.userID),
          eq(MemberTable.member_type, "user")))
        .where(and(sql`${MessageTable.id}=${input.messageID}`, eq(GroupTable.workspace_id, input.workspaceID),
          isNull(GroupTable.deleted_at), isNull(MessageTable.deleted_at))).get()
      if (!visible) return undefined
      const unavailable = (code: Extract<Result, { state: "unavailable" }>["code"]): Result => ({
        version: 1, messageID: visible.message.id, groupID: visible.group.id, state: "unavailable", code,
      })
      if (!visible.ordinary) {
        if (!(yield* tx.select({ id: MessageTable.id }).from(MessageTable)
          .where(and(eq(MessageTable.id, visible.message.id), visibleMessage)).get())) return unavailable("placement_unavailable")
        yield* KernelReader.verifyMessage(db, visible.message)
      }
      const hint = Schema.decodeUnknownOption(TaskStatusNoticeMetadata, { onExcessProperty: "error" })(visible.message.metadata)
      if (visible.message.sender_type !== "agent" || visible.message.type !== "text" || Option.isNone(hint))
        return unavailable("not_task_status")
      const notice = yield* IMTaskStatusNotice.readByDelivery(tx, visible.message.id)
      if (!notice || notice.noticeID !== hint.value.noticeID || notice.requestID !== hint.value.requestID ||
        notice.kind !== hint.value.kind || notice.groupID !== visible.group.id || notice.agentID !== visible.message.sender_id ||
        notice.text !== visible.message.content || notice.directory !== input.directory) return unavailable("status_changed")
      const owned = yield* IMTaskAuthority.readManagementInTransaction(tx, { requestID: notice.requestID, directory: input.directory })
      const source = yield* tx.select().from(IMTaskSourceTable).where(eq(IMTaskSourceTable.source_id, notice.sourceID)).get()
      const outbox = yield* tx.select().from(IMReplyOutboxTable).where(eq(IMReplyOutboxTable.id, notice.outboxID)).get()
      if (!source || !outbox || notice.instanceID !== owned.request.instance_id || notice.actorID !== owned.request.actor_id ||
        notice.requestHash !== owned.request.request_hash || notice.requestRevision !== owned.request.revision ||
        notice.sourceID !== owned.request.source_id || source.message_id !== notice.sourceMessageID ||
        source.proof_hash !== notice.sourceProofHash || source.snapshot_hash !== notice.sourceSnapshotHash ||
        source.proof_hash !== LocalOperator.hash(source.proof) || source.snapshot_hash !== LocalOperator.hash(source.snapshot) ||
        outbox.delivery_message_id !== visible.message.id || outbox.group_id !== notice.groupID ||
        outbox.agent_id !== notice.agentID || outbox.trigger_message_id !== notice.sourceMessageID ||
        outbox.reply_message_id !== notice.noticeID || outbox.reply_text !== notice.text ||
        outbox.session_id !== (notice.sessionID ?? notice.requestID)) return unavailable("status_changed")
      if (notice.kind === "refused" ? owned.grant !== undefined || owned.work !== undefined :
        notice.grantID !== owned.grant?.grant_id || notice.workID !== (owned.work?.work_id ?? null) ||
        notice.sessionID !== (owned.work?.session_id ?? null)) return unavailable("status_changed")
      const delivery = yield* KernelDelivery.read(tx, visible.message.id)
      if (delivery && !KernelDelivery.wireMessage(delivery.binding, visible.message)) return unavailable("status_changed")
      if (!visible.ordinary && (!delivery || delivery.state !== "acknowledged")) return unavailable("delivery_unknown")
      return { notice, groupID: visible.group.id }
    }))
    if (!found || "state" in found) return found
    const current = yield* states.read({ requestID: found.notice.requestID, directory: input.directory })
    if (current.instanceID !== found.notice.instanceID || current.requestRevision !== found.notice.requestRevision ||
      current.targetScope.directory !== found.notice.directory) return { ...fieldsFor(found.groupID, input.messageID),
        state: "unavailable" as const, code: "status_changed" as const }
    return { ...fieldsFor(found.groupID, input.messageID), state: "available" as const,
      notice: { noticeID: found.notice.noticeID, kind: found.notice.kind, createdAt: found.notice.createdAt },
      task: { requestID: current.requestID, instanceID: current.instanceID, directory: current.targetScope.directory,
        disposition: current.disposition,
        grant: current.grant ? { state: current.grant.state, revision: current.grant.revision } : null,
        work: current.work ? { workID: current.work.workID, sessionID: current.work.sessionID, outcome: current.work.outcome,
          controlState: current.work.controlState, recoveryRequired: current.work.recoveryRequired,
          hasExecutionClaim: current.work.hasExecutionClaim, processActive: current.work.processActive } : null },
    }
  })
  return { read }
})

function fieldsFor(groupID: string, messageID: string) {
  return { version: 1 as const, groupID, messageID }
}
