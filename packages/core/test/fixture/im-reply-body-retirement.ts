export * as ReplyBodyFixture from "./im-reply-body-retirement"
import { expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { IMRepository } from "../../src/im/repository"
import { KernelDelivery } from "../../src/im/kernel-delivery"
import { KernelReader } from "../../src/im/kernel-reader"
import { ReplyBodyRetirement } from "../../src/im/reply-body-retirement"
import { ReplyBodyRetirementModel } from "../../src/im/reply-body-retirement.model"
import { ReplyDeliveryID } from "../../src/im/reply-delivery-id"
export const source = {
  realm: "http://127.0.0.1:9/",
  appkey: "reply-custody",
  orgID: 1,
  senderID: "alice",
  credentialFingerprint: "a".repeat(64),
}
export const scopeKey = "b".repeat(64)
export const reply = "ReplyCustodyCanary 中文🙂"
/** Legal historical settled/admitted storage specimen, not current prompt
 * admission or execution. Original Core repository/transport/reader APIs below
 * run against actual FK-on file SQL; no provider, service or attachment starts. */
export const make = (input?: { append?: boolean; projection?: boolean }) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const repo = yield* IMRepository
    const active = { value: true }
    const observations = new WeakMap<object, { serverNow: number; scopeKey: string; version: 2; deadline: number }>()
    const reader = KernelReader.attach({
      db,
      workspaceID: "ws",
      userID: "server",
      source,
      current: () => Effect.succeed(active.value),
      inspect: () => Effect.succeed({ name: "peer" }),
      readCut: () => Effect.die("Unused read"),
      retirementObservation: (handle) => {
        const value = observations.get(handle)
        observations.delete(handle)
        return value
      },
    })
    const authority = KernelDelivery.runtime(source)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        KernelReader.close(reader)
        KernelDelivery.close(authority)
      }),
    )
    yield* KernelReader.bind(reader, scopeKey, 2)
    yield* KernelReader.ensureScope(reader)
    if (input?.projection) {
      const now = Date.now()
      yield* KernelReader.applyChanges(reader, {
        version: 2,
        scopeKey,
        after: "0",
        upper: "1",
        scanCursor: "1",
        scanProjectionKey: "c".repeat(64),
        pageToken: "",
        windowComplete: true,
        caughtUp: true,
        serverNow: now,
        items: [
          {
            visibility: "visible",
            projectionKey: "c".repeat(64),
            revision: "1",
            cursor: "1",
            conversationType: 1,
            targetId: "bob",
            readOrdinal: "0",
            admittedOrdinal: "1",
            liveUnread: "1",
            storedUnread: "1",
            latestMessageId: "original",
            latestSequence: "1",
            latestMessageTime: now,
            nextExpiryAt: now + 259200000,
          },
        ],
      })
    }
    const existingGroup = input?.projection
      ? (yield* KernelReader.projection(reader, "c".repeat(64)))?.local_group_id
      : undefined
    const group = existingGroup
      ? yield* db.get<{ id: string; kernelConvID: string }>(
          sql`SELECT id,kernel_conv_id kernelConvID FROM im_groups WHERE id=${existingGroup}`,
        )
      : yield* repo.createGroup({
          workspaceID: "ws",
          type: "project",
          name: "Reply custody private",
          createdBy: "server",
        })
    if (!group) return yield* Effect.die("Original reader group absent")
    const sourceMessage = yield* KernelDelivery.withCreation(
      authority,
      group.id,
      repo.createMessage({
        id: "imsg_source_reply",
        groupID: group.id,
        senderID: "server",
        senderType: "user",
        type: "text",
        content: "Historical accepted input",
      }),
    )
    const now = Date.now()
    yield* db.run(
      sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('reply-project','/private/reply-history','[]',${now},${now})`,
    )
    yield* db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,v2_authority)
    VALUES('ses_im_reply_history','reply-project','reply-history','/private/reply-history','History','2',${now},${now},1)`)
    yield* db.run(sql`INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created)
    VALUES('msg_reply_input','ses_im_reply_history','{"text":"Historical admitted input"}','steer',1,1,${now})`)
    yield* db.run(sql`INSERT INTO session_activity(activity_id,session_id,ordinal,trigger_input_id,delivery,state,created_at,settled_at,final_message_id)
    VALUES('activity_reply','ses_im_reply_history',1,'msg_reply_input','steer','settled',${now},${now},'msg_reply_final')`)
    yield* db.run(sql`INSERT INTO session_activity_input(activity_id,input_id,ordinal,admitted_seq,role,promoted_at)
    VALUES('activity_reply','msg_reply_input',1,1,'trigger',${now})`)
    yield* db.run(sql`INSERT INTO im_mention_intent(id,message_id,agent_name,directory,workspace_id,user_id,origin,session_id,input_id,status,created_at,updated_at)
    VALUES('imi_reply_history',${sourceMessage.id},'auto','/private/reply-history','ws','server','local','ses_im_reply_history','msg_reply_input','admitted',${now},${now})`)
    const id = "imo_reply_history"
    if (input?.append !== false)
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`INSERT INTO im_reply_outbox(id,delivery_message_id,session_id,group_id,agent_id,trigger_message_id,reply_message_id,reply_text,time_created,time_updated)
      VALUES(${id},${ReplyDeliveryID.fromOutbox(id)},'ses_im_reply_history',${group.id},'auto','msg_reply_input','msg_reply_final',${reply},${now},${now})`)
            yield* ReplyBodyRetirement.initialize(tx, id)
          }),
        { behavior: "immediate" },
      )
    const create = (kernel = true) =>
      Effect.gen(function* () {
        if (kernel && !group.kernelConvID?.startsWith("kr1:"))
          yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: "k:1:bob" })
        const input = {
          id: ReplyDeliveryID.fromOutbox(id),
          groupID: group.id,
          senderID: "auto",
          senderType: "agent" as const,
          type: "text" as const,
          content: reply,
          mentions: [],
          metadata: { type: "agent_run" as const, sessionID: "ses_im_reply_history", status: "success" as const },
        }
        return yield* kernel
          ? KernelDelivery.withCreation(authority, group.id, repo.createMessage(input))
          : repo.createMessage(input)
      })
    const dispatch = (messageID: string) =>
      KernelDelivery.withVerification(
        authority,
        { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] },
        repo.claimKernelDelivery(authority, messageID),
      )
    const acknowledge = (messageID: string) =>
      Effect.gen(function* () {
        const value = yield* dispatch(messageID)
        if (!value) return yield* Effect.die("Original reply dispatch was not admitted")
        expect(yield* repo.acknowledgeKernelDelivery(authority, value, `kernel-${messageID}`)).toBe(true)
      })
    const delivered = () =>
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* ReplyBodyRetirement.read(tx, id)
            yield* tx.run(
              sql`UPDATE im_reply_outbox SET status='delivered',time_delivered=${Date.now()} WHERE id=${id}`,
            )
            yield* ReplyBodyRetirement.refresh(tx, id)
          }),
        { behavior: "immediate" },
      )
    const retire = (serverNow: number, purpose = KernelDelivery.retireSenderReplies()) =>
      Effect.gen(function* () {
        const handle = {}
        observations.set(handle, { serverNow, scopeKey, version: 2, deadline: performance.now() + 1000 })
        return yield* KernelDelivery.withSenderRetirement(reader, handle, purpose)
      })
    return { db, repo, id, group, create, dispatch, acknowledge, delivered, retire, active, reader, authority }
  })

export const setup = make()

export const fullMeter = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const rows = yield* db.all<ReplyBodyRetirementModel.RawRow>(`SELECT * FROM im_reply_body`)
    const meter = yield* ReplyBodyRetirement.currentMeter(db)
    expect(meter.used_records).toBe(1 + rows.reduce((sum, row) => sum + Number(row.accounted_records), 0))
    for (const row of rows) {
      const o = yield* db.get<ReplyBodyRetirementModel.RawRow>(
        sql`SELECT * FROM im_reply_outbox WHERE id=${row.outbox_id}`,
      )
      const m = row.local_message_id
        ? yield* db.get<ReplyBodyRetirementModel.RawRow>(
            sql`SELECT * FROM im_messages WHERE id=${row.local_message_id}`,
          )
        : null
      const d = row.receipt_message_id
        ? yield* db.get<ReplyBodyRetirementModel.RawRow>(
            sql`SELECT * FROM im_kernel_delivery WHERE message_id=${row.receipt_message_id}`,
          )
        : null
      expect(row.accounted_bytes).toBe(
        ReplyBodyRetirementModel.accounting([row, o!, ...(m ? [m] : []), ...(d ? [d] : [])]),
      )
    }
    expect(meter.used_bytes).toBe(76 + rows.reduce((sum, row) => sum + Number(row.accounted_bytes), 0))
  })
