import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DateTime, Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { ProjectV2 } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { SessionActivityInputTable, SessionActivityTable } from "@deepagent-code/core/context-federation/session-sql"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive, IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { IMDacSession } from "@deepagent-code/core/im/dac-session"
import { IMReplyOutboxTable } from "@deepagent-code/core/im/reply-outbox.sql"
import { ReplyBodyRetirement } from "@deepagent-code/core/im/reply-body-retirement"
import { IMReplyOutbox } from "../../src/im/im-reply-outbox"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { GroupTable, MessageTable } from "@deepagent-code/core/im/sql"
import { testEffect } from "../lib/effect"

const root = mkdtempSync(path.join(os.tmpdir(), "dac-personal-final-"))
const database = Layer.suspend(() => Database.layerFromPath(path.join(root, `${crypto.randomUUID()}.sqlite`)))
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = ProjectV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
)
const sessions = SessionV2.layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
  Layer.provide(SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(projects),
  Layer.orDie,
)
const it = testEffect(
  Layer.mergeAll(
    database,
    events,
    projects,
    sessions,
    IMBroadcasterLive,
    IMRepositoryLive.pipe(Layer.provide(database)),
  ),
)
const prepare = (text: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const session = yield* SessionV2.Service
    const repo = yield* IMRepository
    const group = yield* repo.createGroup({ workspaceID: root, createdBy: "server", type: "project", name: "personal" })
    const project = yield* (yield* ProjectV2.Service).resolve(AbsolutePath.make(root))
    const scope = {
      ownerID: "server",
      accountKey: "local",
      executorID: "local",
      conversationKey: group.id,
      groupID: group.id,
      projectID: project.id,
      directory: root,
      workspaceID: null,
    }
    const command = yield* IMDacSession.make(db, session).submit(
      scope,
      { commandID: crypto.randomUUID(), text: "private command", delivery: "queue" },
      Effect.succeed([]),
    )
    const assistantID = SessionMessage.ID.make(`msg_${crypto.randomUUID()}`)
    const publisher = yield* EventV2.Service
    yield* publisher.publish(SessionEvent.Step.Started, {
      sessionID: SessionV2.ID.make(command.sessionID),
      timestamp: DateTime.makeUnsafe(Date.now()),
      assistantMessageID: assistantID,
      agent: "auto",
      model: { id: ModelV2.ID.make("deepseek-flash"), providerID: ProviderV2.ID.make("deepseek") },
    })
    yield* publisher.publish(SessionEvent.Text.Started, {
      sessionID: SessionV2.ID.make(command.sessionID),
      timestamp: DateTime.makeUnsafe(Date.now()),
      assistantMessageID: assistantID,
      textID: "answer",
    })
    yield* publisher.publish(SessionEvent.Text.Ended, {
      sessionID: SessionV2.ID.make(command.sessionID),
      timestamp: DateTime.makeUnsafe(Date.now()),
      assistantMessageID: assistantID,
      textID: "answer",
      text,
    })
    return { db, session, repo, command, assistantID, text, scope, groupID: group.id }
  })
const settle = (f: Effect.Success<ReturnType<typeof prepare>>) =>
  Effect.gen(function* () {
    const activityID = `activity_${crypto.randomUUID()}`
    yield* f.db
      .insert(SessionActivityTable)
      .values({
        activity_id: activityID,
        session_id: f.command.sessionID,
        ordinal: 1,
        trigger_input_id: f.command.inputID,
        delivery: "queue",
        state: "settled",
        created_at: Date.now(),
        settled_at: Date.now(),
        final_message_id: f.assistantID,
      })
      .run()
      .pipe(Effect.orDie)
    yield* f.db
      .insert(SessionActivityInputTable)
      .values({
        activity_id: activityID,
        input_id: f.command.inputID,
        ordinal: 1,
        admitted_seq: 1,
        role: "trigger",
        promoted_at: Date.now(),
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("personal final collector / original outbox (file SQLite, no provider)", () => {
  it.live("requires the Activity final pointer and collects exact ordinary output once", () =>
    Effect.gen(function* () {
      const f = yield* prepare("中文最终答案，工具与推理均不回传。")
      expect(yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)).toBe(
        false,
      )
      yield* settle(f)
      expect(yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)).toBe(
        true,
      )
      expect(yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)).toBe(
        false,
      )
      const rows = yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.reply_text).toBe(f.text)
      expect((yield* ReplyBodyRetirement.read(f.db, rows[0]!.id)).record.origin.kind).toBe("dac_session")
      expect(
        yield* IMReplyOutbox.drainPass({
          db: f.db,
          repo: f.repo,
          v2Session: f.session,
          broadcaster: yield* IMBroadcasterService,
        }),
      ).toBe(1)
      const page = yield* f.repo.listMessages({ groupID: f.groupID, limit: 100 })
      expect(page.messages).toHaveLength(1)
      expect(page.messages[0]?.content).toBe(f.text)
      expect(page.messages[0]?.content).not.toContain("private command")
    }),
  )
  it.live("retains every Unicode byte of a long final and delivers stable parts in order", () =>
    Effect.gen(function* () {
      const f = yield* prepare("完整中文🙂".repeat(12000))
      yield* settle(f)
      yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)
      const rows = yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie)
      expect(rows.length).toBeGreaterThan(1)
      expect(rows.every((row) => Buffer.byteLength(row.reply_text) <= 60000)).toBe(true)
      expect(
        rows
          .toSorted((a, b) => a.reply_message_id.localeCompare(b.reply_message_id))
          .map((row) => row.reply_text)
          .join(""),
      ).toBe(f.text)
      expect(
        yield* IMReplyOutbox.drainPass({
          db: f.db,
          repo: f.repo,
          v2Session: f.session,
          broadcaster: yield* IMBroadcasterService,
        }),
      ).toBe(rows.length)
      const after = yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie)
      expect(after.every((row) => row.status === "delivered")).toBe(true)
    }),
  )
  it.live("bounds escaped text by the actual kernel JSON envelope without losing bytes", () =>
    Effect.gen(function* () {
      const f = yield* prepare('\u0001\\"\n'.repeat(12000))
      yield* settle(f)
      yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)
      const rows = yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie)
      expect(rows.length).toBeGreaterThan(1)
      expect(
        rows.every((row) => Buffer.byteLength(JSON.stringify({ content: `[Agent·dac] ${row.reply_text}` })) <= 65536),
      ).toBe(true)
      expect(
        rows
          .toSorted((a, b) => a.reply_message_id.localeCompare(b.reply_message_id))
          .map((row) => row.reply_text)
          .join(""),
      ).toBe(f.text)
    }),
  )
  it.live("keeps the original transport receipt pending until its exact ACK, without resending", () =>
    Effect.gen(function* () {
      const f = yield* prepare("最终回复等待原传输 ACK。")
      yield* settle(f)
      yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)
      yield* f.db
        .update(GroupTable)
        .set({ kernel_conv_id: "k:1:alice" })
        .where(sql`${GroupTable.id}=${f.groupID}`)
        .run()
        .pipe(Effect.orDie)
      // Original issuer and receipt APIs exercise the local transport state machine;
      // this test has no SDK socket and does not claim a live remote delivery.
      const runtime = KernelDelivery.runtime({
        realm: "test",
        appkey: "test",
        orgID: 1,
        senderID: "receiver",
        credentialFingerprint: "0".repeat(64),
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(runtime)))
      const deps = {
        db: f.db,
        repo: f.repo,
        v2Session: f.session,
        broadcaster: yield* IMBroadcasterService,
        authorize: (
          _binding: Parameters<NonNullable<IMReplyOutbox.DeliveryDeps["authorize"]>>[0],
          effect: Parameters<NonNullable<IMReplyOutbox.DeliveryDeps["authorize"]>>[1],
        ) => KernelDelivery.withCreation(runtime, f.groupID, effect(undefined)),
      }
      const now = Date.now()
      expect(yield* IMReplyOutbox.drainPass(deps, { now })).toBe(0)
      const waiting = (yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]!
      expect(waiting.status).toBe("pending")
      expect(waiting.last_error).toBe("awaiting_kernel_ack")
      expect(waiting.attempts).toBe(0)
      const messageID = waiting.delivery_message_id!
      const dispatch = yield* KernelDelivery.withVerification(
        runtime,
        { conversationType: 1, conversationID: "alice", orgID: 1, memberIDs: ["receiver", "alice"] },
        f.repo.claimKernelDelivery(runtime, messageID),
      )
      expect(dispatch).toBeDefined()
      if (!dispatch) return
      expect(yield* f.repo.acknowledgeKernelDelivery(runtime, dispatch, "ack-original")).toBe(true)
      expect(
        yield* IMReplyOutbox.drainPass(deps, { now: now + IMReplyOutbox.IM_REPLY_RECONCILE_INTERVAL_MS + 1 }),
      ).toBe(1)
      expect((yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]?.status).toBe("delivered")
      expect(
        yield* f.db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(sql`${MessageTable.group_id}=${f.groupID}`)
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )
  it.live("does not claim or deliver historical unbound execution replies", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* IMReplyOutbox.appendReply(db, {
        sessionID: "ses_imtask_history",
        groupID: "historical",
        agentID: "old",
        replyMessageID: "msg_old",
        replyText: "old history",
        now: Date.now(),
      })
      expect(yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "test" })).toBeUndefined()
      expect((yield* db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]?.status).toBe("pending")
    }),
  )
})

it.live("explicit final retry keeps original identity, is idempotent, and never readmits model work", () =>
  Effect.gen(function* () {
    const f = yield* prepare("同一份最终答复，只重试投递。")
    yield* settle(f)
    yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)
    const broadcaster = yield* IMBroadcasterService
    const failure = {
      db: f.db,
      repo: f.repo,
      broadcaster,
      authorize: () => Effect.fail(new Error("known before create")),
    }
    for (const attempt of Array.from({ length: IMReplyOutbox.IM_REPLY_MAX_ATTEMPTS }, (_, index) => index))
      yield* IMReplyOutbox.drainPass(failure, { now: Date.now() + attempt * 100000, maxClaims: 1 })
    const before = (yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]!
    expect(before.status).toBe("dead")
    expect(before.attempts).toBe(8)
    const bridge = IMDacSession.make(f.db, f.session)
    expect((yield* bridge.command(f.scope, f.command.commandID)).replyStatus).toBe("dead")
    const foreign = { ...f.scope, ownerID: "other" }
    expect((yield* bridge.retryReply(foreign, f.command.commandID).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* bridge.retryReply(f.scope, f.command.commandID)).replyStatus).toBe("pending")
    expect((yield* bridge.retryReply(f.scope, f.command.commandID)).replyStatus).toBe("pending")
    const after = (yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]!
    expect(after.id).toBe(before.id)
    expect(after.delivery_message_id).toBe(before.delivery_message_id)
    expect(after.reply_message_id).toBe(before.reply_message_id)
    expect(after.reply_text).toBe(before.reply_text)
    expect(after.attempts).toBe(0)
    expect(yield* f.db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
    expect(yield* IMReplyOutbox.drainPass({ db: f.db, repo: f.repo, broadcaster })).toBe(1)
    expect((yield* bridge.retryReply(f.scope, f.command.commandID)).replyStatus).toBe("delivered")
    expect(yield* f.db.select().from(MessageTable).all().pipe(Effect.orDie)).toHaveLength(1)
  }),
)

it.live("final retry refuses a changed Activity pointer and a message created before a failed acknowledgement", () =>
  Effect.gen(function* () {
    const f = yield* prepare("不可伪造新最终指针。")
    yield* settle(f)
    yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)
    const broadcaster = yield* IMBroadcasterService
    const failure = {
      db: f.db,
      repo: f.repo,
      broadcaster,
      authorize: (
        _binding: Parameters<NonNullable<IMReplyOutbox.DeliveryDeps["authorize"]>>[0],
        effect: Parameters<NonNullable<IMReplyOutbox.DeliveryDeps["authorize"]>>[1],
      ) => effect(undefined).pipe(Effect.andThen(Effect.fail(new Error("after create, outcome must reconcile")))),
    }
    for (const attempt of Array.from({ length: IMReplyOutbox.IM_REPLY_MAX_ATTEMPTS }, (_, index) => index))
      yield* IMReplyOutbox.drainPass(failure, { now: Date.now() + attempt * 100000, maxClaims: 1 })
    const before = (yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]!
    expect(before.status).toBe("dead")
    expect(yield* f.db.select().from(MessageTable).all().pipe(Effect.orDie)).toHaveLength(1)
    const bridge = IMDacSession.make(f.db, f.session)
    expect((yield* bridge.command(f.scope, f.command.commandID)).replyStatus).toBe("unknown")
    expect((yield* bridge.retryReply(f.scope, f.command.commandID).pipe(Effect.exit))._tag).toBe("Failure")
    expect(
      (yield* f.db
        .update(SessionActivityTable)
        .set({ final_message_id: "msg_changed_final" })
        .where(eq(SessionActivityTable.session_id, f.command.sessionID))
        .run()
        .pipe(Effect.exit))._tag,
    ).toBe("Failure")
    expect((yield* bridge.retryReply(f.scope, f.command.commandID).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]).toEqual(before)
    expect(yield* f.db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
  }),
)

it.live("unknown transport stays unknown after the final outbox reaches its attempt cap", () =>
  Effect.gen(function* () {
    const f = yield* prepare("原运输结果未知，不能把尝试次数上限当成未发送。")
    yield* settle(f)
    yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)
    yield* f.db
      .update(GroupTable)
      .set({ kernel_conv_id: "k:1:alice" })
      .where(sql`${GroupTable.id}=${f.groupID}`)
      .run()
      .pipe(Effect.orDie)
    const runtime = KernelDelivery.runtime({
      realm: "test",
      appkey: "test",
      orgID: 1,
      senderID: "receiver",
      credentialFingerprint: "0".repeat(64),
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(runtime)))
    const deps = {
      db: f.db,
      repo: f.repo,
      broadcaster: yield* IMBroadcasterService,
      authorize: (
        _binding: Parameters<NonNullable<IMReplyOutbox.DeliveryDeps["authorize"]>>[0],
        effect: Parameters<NonNullable<IMReplyOutbox.DeliveryDeps["authorize"]>>[1],
      ) => KernelDelivery.withCreation(runtime, f.groupID, effect(undefined)),
    }
    const now = Date.now()
    yield* IMReplyOutbox.drainPass(deps, { now })
    const original = (yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]!
    const dispatch = yield* KernelDelivery.withVerification(
      runtime,
      { conversationType: 1, conversationID: "alice", orgID: 1, memberIDs: ["receiver", "alice"] },
      f.repo.claimKernelDelivery(runtime, original.delivery_message_id!),
    )
    expect(dispatch).toBeDefined()
    if (!dispatch) return yield* Effect.die("Original transport was not dispatched")
    yield* f.repo.uncertainKernelDelivery(runtime, dispatch)
    expect((yield* ReplyBodyRetirement.read(f.db, original.id)).receipt?.state).toBe("unknown")
    KernelDelivery.close(runtime)
    for (const attempt of Array.from({ length: IMReplyOutbox.IM_REPLY_MAX_ATTEMPTS }, (_, index) => index))
      yield* IMReplyOutbox.drainPass(deps, { now: now + (attempt + 1) * 100000, maxClaims: 1 })
    const before = (yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]!
    expect(before.status).toBe("dead")
    expect(before.attempts).toBe(IMReplyOutbox.IM_REPLY_MAX_ATTEMPTS)
    const bridge = IMDacSession.make(f.db, f.session)
    expect((yield* bridge.command(f.scope, f.command.commandID)).replyStatus).toBe("unknown")
    expect((yield* bridge.binding(f.scope)).recentCommands[0]?.replyStatus).toBe("unknown")
    expect((yield* bridge.retryReply(f.scope, f.command.commandID).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]).toEqual(before)
    expect((yield* ReplyBodyRetirement.read(f.db, before.id)).receipt?.state).toBe("unknown")
    expect(yield* f.db.select().from(MessageTable).all().pipe(Effect.orDie)).toHaveLength(1)
    expect(yield* f.db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
  }),
)

it.live(
  "binding recovery returns at most eight exact command metadata records across generations without private text",
  () =>
    Effect.gen(function* () {
      const f = yield* prepare("final is not command text")
      const bridge = IMDacSession.make(f.db, f.session)
      for (const index of Array.from({ length: 10 }, (_, index) => index))
        yield* bridge.submit(
          f.scope,
          { commandID: `metadata-${index}`, text: `private-${index}`, delivery: "queue", newSession: index === 5 },
          Effect.succeed([]),
        )
      const recovered = yield* bridge.binding(f.scope)
      expect(recovered.recentCommands).toHaveLength(8)
      expect(
        recovered.recentCommands.every(
          (row) => row.groupID === f.groupID && row.bindingID === recovered.bindingID && row.directory === root,
        ),
      ).toBe(true)
      expect(new Set(recovered.recentCommands.map((row) => row.sessionID)).size).toBe(2)
      expect(JSON.stringify(recovered)).not.toContain("private-")
      expect(
        recovered.recentCommands.every((row) => !("text" in row) && !("references" in row) && !("referenceIDs" in row)),
      ).toBe(true)
      expect((yield* bridge.binding({ ...f.scope, ownerID: "other" })).recentCommands).toHaveLength(0)
      expect((yield* bridge.binding({ ...f.scope, directory: root + "/foreign" })).recentCommands).toHaveLength(0)
    }),
)

it.live("a current DAC reply lease is reclaimed after expiry and fences stale settlement", () =>
  Effect.gen(function* () {
    const f = yield* prepare("Only the original DAC final may be delivered.")
    yield* settle(f)
    yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)
    const now = Date.now() + 1000
    const first = yield* IMReplyOutbox.claimDueReply(f.db, { ownerToken: "crashed", now, leaseMs: 1000 })
    expect(first).toBeDefined()
    if (!first) return yield* Effect.die("Expected current DAC outbox lease")
    expect(yield* IMReplyOutbox.claimDueReply(f.db, { ownerToken: "other", now: now + 500 })).toBeUndefined()
    const reclaimed = yield* IMReplyOutbox.claimDueReply(f.db, { ownerToken: "other", now: now + 1500 })
    expect(reclaimed?.id).toBe(first.id)
    expect(reclaimed?.attempts).toBe(2)
    expect(yield* IMReplyOutbox.markDelivered(f.db, { item: first, ownerToken: "crashed", now: now + 2000 })).toBe(
      false,
    )
    expect((yield* f.db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie))[0]?.status).toBe("delivering")
    expect(yield* f.db.select().from(MessageTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }),
)

it.live("ordinary mentions and historical Session metadata cannot collect or execute a DAC reply", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const repo = yield* IMRepository
    const session = yield* SessionV2.Service
    const group = yield* repo.createGroup({ workspaceID: root, createdBy: "server", type: "project", name: "ordinary" })
    yield* repo.createMessage({
      groupID: group.id,
      senderID: "server",
      senderType: "user",
      type: "text",
      content: "@auto @build please answer",
      mentions: ["auto", "build"],
    })
    const ordinary = yield* session.create({
      metadata: { im: { groupID: group.id, agent: "auto" } },
      location: { directory: AbsolutePath.make(root) },
    })
    expect(yield* IMReplyOutbox.collectSessionReply({ db, v2Session: session }, ordinary.id)).toBe(false)
    expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(IMReplyOutboxTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.all("SELECT count(*) count FROM im_mention_intent")).toEqual([{ count: 0 }])
    expect((yield* repo.listMessages({ groupID: group.id, limit: 10 })).messages).toHaveLength(1)
  }),
)
