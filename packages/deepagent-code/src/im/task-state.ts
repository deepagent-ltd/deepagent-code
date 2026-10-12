export * as IMTaskState from "./task-state"

import { eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { IMTaskAuthoritySchema } from "@deepagent-code/core/im/task-authority.schema"
import { IMTaskSourceTable } from "@deepagent-code/core/im/task-authority.sql"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { IMTaskStatusNotice } from "@deepagent-code/core/im/task-status-notice"
import { IMTaskStatusNoticeTable } from "@deepagent-code/core/im/task-status-notice.sql"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { MessageTable } from "@deepagent-code/core/im/sql"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { IMReplyOutboxTable } from "./im-reply-outbox"

const unavailable = () =>
  new IMTaskAuthoritySchema.Error({
    code: "IM_TASK_AUTHORITY_UNAVAILABLE",
    message: "Current task management status is unavailable",
  })
const conflict = () =>
  new IMTaskAuthoritySchema.Error({
    code: "IM_TASK_IDENTITY_CONFLICT",
    message: "Original task state differs from its durable identity",
  })

/** Administrative observation of an already-owned request. The original single-Session
 * status getter classifies unresolved tool admissions; no source or execution is refreshed. */
export const make = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const execution = yield* SessionExecution.Service
  const runtime = yield* SessionRuntimeStatus.Service
  const read = Effect.fn("IMTaskState.read")(function* (input: { requestID: string; directory: string }) {
    if (!runtime.get) return yield* unavailable()
    const value = yield* IMTaskAuthority.readManagement(db, input)
    const current = value.work ? yield* runtime.get(SessionSchema.ID.make(value.work.session_id)) : undefined
    const active = yield* execution.active
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        // Reauthenticate and re-read after the process observation; a foreign or superseded
        // request cannot inherit the status of the Session observed above.
        const actual = yield* IMTaskAuthority.readManagementInTransaction(tx, input)
        if (actual.work?.work_id !== value.work?.work_id || actual.work?.session_id !== value.work?.session_id)
          return yield* conflict()
        const source = yield* tx
          .select()
          .from(IMTaskSourceTable)
          .where(eq(IMTaskSourceTable.source_id, actual.request.source_id))
          .get()
        if (
          source &&
          (source.proof_hash !== LocalOperator.hash(source.proof) ||
            source.snapshot_hash !== LocalOperator.hash(source.snapshot) ||
            source.instance_id !== actual.request.instance_id ||
            (actual.grant &&
              (source.proof_hash !== actual.grant.source_proof_hash ||
                source.snapshot_hash !== actual.grant.source_snapshot_hash)))
        )
          return yield* conflict()
        const sourceGroup = source
          ? Schema.decodeUnknownOption(Schema.Struct({ group: Schema.Struct({ id: Schema.String }) }))(source.snapshot)
          : Option.none()
        const session = actual.work
          ? yield* tx
              .select({
                id: SessionTable.id,
                directory: SessionTable.directory,
                claim: SessionTable.execution_claim_token,
              })
              .from(SessionTable)
              .where(eq(SessionTable.id, SessionSchema.ID.make(actual.work.session_id)))
              .get()
          : undefined
        if (
          (session && session.directory !== input.directory) ||
          (actual.work?.admission_state === "ready" && !session)
        )
          return yield* conflict()
        const unresolved = actual.work
          ? yield* tx.get<{ countUnknown: number; countExpired: number; dispatchUnknown: number }>(sql`
        SELECT
          (SELECT count(*) FROM work_count_acquisition WHERE work_id=${actual.work.work_id} AND state='unknown') countUnknown,
          (SELECT count(*) FROM work_count_acquisition WHERE work_id=${actual.work.work_id} AND state='sending' AND deadline<=${Date.now()}) countExpired,
          (SELECT count(*) FROM work_dispatch_reservation WHERE work_id=${actual.work.work_id} AND state='unknown') dispatchUnknown`)
          : undefined
        const outbox = actual.grant
          ? yield* tx.select().from(IMReplyOutboxTable).where(eq(IMReplyOutboxTable.id, actual.grant.result_key)).get()
          : undefined
        if (
          outbox &&
          (!actual.grant ||
            outbox.session_id !== actual.grant.session_id ||
            outbox.agent_id !== actual.request.target.agentID ||
            (source &&
              (outbox.trigger_message_id !== source.message_id ||
                Option.isNone(sourceGroup) ||
                outbox.group_id !== sourceGroup.value.group.id)))
        )
          return yield* conflict()
        const resultMessageID = outbox ? `imsg_reply_${contentDigest(outbox.id).slice(0, 40)}` : undefined
        const message = resultMessageID
          ? yield* tx
              .select()
              .from(MessageTable)
              .where(sql`${MessageTable.id}=${resultMessageID}`)
              .get()
          : undefined
        const historical = resultMessageID ? yield* KernelDelivery.history(tx,resultMessageID) : undefined
        const delivery = historical?.kind==="missing" ? undefined : historical?.receipt
        if (
          delivery &&
          (!message ||
            !outbox ||
            message.group_id !== outbox.group_id ||
            message.sender_type !== "agent" ||
            message.sender_id !== outbox.agent_id ||
            (historical?.kind!=="reply_retired" && (!delivery.binding || !KernelDelivery.wireMessage(delivery.binding, message))))
        )
          return yield* conflict()
        const hasClaim = session?.claim !== null && session?.claim !== undefined
        const refusal = yield* tx.select({ id: IMTaskStatusNoticeTable.notice_id }).from(IMTaskStatusNoticeTable)
          .where(sql`${IMTaskStatusNoticeTable.request_id}=${actual.request.request_id} AND ${IMTaskStatusNoticeTable.kind}='refused'`).get()
        const notice = refusal ? yield* IMTaskStatusNotice.read(tx, refusal.id) : undefined
        if (refusal && (!notice || notice.requestHash !== actual.request.request_hash ||
          notice.requestRevision !== actual.request.revision || notice.actorID !== actual.request.actor_id ||
          notice.instanceID !== actual.request.instance_id || actual.grant || actual.work)) return yield* conflict()
        return {
          version: 1 as const,
          disposition: notice ? "refused" as const : "open" as const,
          requestID: actual.request.request_id,
          requestRevision: actual.request.revision,
          instanceID: actual.request.instance_id,
          source: source
            ? {
                messageID: source.message_id,
                senderID: source.proof.senderID,
                origin: source.proof.origin,
                groupID: Option.isSome(sourceGroup) ? sourceGroup.value.group.id : null,
              }
            : null,
          targetScope: {
            directory: actual.request.target.location.directory,
            workspaceID: actual.request.target.location.workspaceID ?? null,
            agentID: actual.request.target.agentID,
          },
          grant: actual.grant
            ? { state: actual.grant.state, revision: actual.grant.revision, expiresAt: actual.grant.expires_at }
            : null,
          work: actual.work
            ? {
                workID: actual.work.work_id,
                sessionID: actual.work.session_id,
                inputID: actual.work.input_id,
                admissionState: actual.work.admission_state,
                controlState: actual.work.control_state,
                controlRevision: actual.work.control_revision,
                outcome: actual.work.outcome,
                hasExecutionClaim: hasClaim,
                processActive: active.has(SessionSchema.ID.make(actual.work.session_id)),
                sessionRecoveryRequired: current?.status === "recovery_required",
                countUnknown: unresolved?.countUnknown ?? 0,
                countSendingExpired: unresolved?.countExpired ?? 0,
                dispatchUnknown: unresolved?.dispatchUnknown ?? 0,
                recoveryRequired:
                  actual.work.outcome === "unknown" ||
                  current?.status === "recovery_required" ||
                  !!unresolved?.countUnknown ||
                  !!unresolved?.countExpired ||
                  !!unresolved?.dispatchUnknown,
              }
            : null,
          delivery: {
            outboxStatus: outbox?.status ?? null,
            attempts: outbox?.attempts ?? 0,
            receiptState: delivery?.state ?? null,
          },
        }
      }),
    )
  })
  return { read }
})
export type Interface = Effect.Success<typeof make>
export type State = Effect.Success<ReturnType<Interface["read"]>>
