import { afterAll, describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DateTime, Effect, Fiber, Layer, SubscriptionRef } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { ProjectV2 } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { SessionActivityTable } from "@deepagent-code/core/context-federation/session-sql"
import { SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive, IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { IMDacSession } from "@deepagent-code/core/im/dac-session"
import { IMReplyOutboxTable } from "@deepagent-code/core/im/reply-outbox.sql"
import { ReplyBodyRetirement } from "@deepagent-code/core/im/reply-body-retirement"
import { IMReplyOutbox } from "../../src/im/im-reply-outbox"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { GroupTable, MessageTable } from "@deepagent-code/core/im/sql"
import { testEffect } from "../lib/effect"
import { openFixtureActivity, settleFixtureActivity } from "../../../core/test/fixture/open-activity"

import { createHash } from "node:crypto"
import { KernelConfig } from "../../src/im/kernel/config"
import { KernelSdk } from "../../src/im/kernel/sdk"
import { KernelClient } from "../../src/im/kernel/client"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import { IMKernelDeliveryTable } from "@deepagent-code/core/im/kernel-delivery.sql"
import { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"
import { ReplyBodyFixture } from "../../../core/test/fixture/im-reply-body-retirement"
const modes = new Map<string, "confirmed_acceptance" | "unknown">()
const queries: IMDacSessionSchema.ReplyReceiptQuery[] = []
const probe = { publish: 0, delay: 0 }
const native = KernelLiveFirstSeenFixture.make({
  outboundPublish: () => {
    probe.publish++
    throw new Error("receipt path must not PUBLISH")
  },
  queryDelayMs: (topic) => (topic === "qry_delivery_receipt" ? probe.delay : 0),
  response(topic, request, original) {
    if (topic === "qry_delivery_capabilities")
      return {
        name: "DeliveryCapabilities",
        value: {
          version: 1,
          profile: "mysql-receipt-v1",
          maxLifetimeMs: 259200000,
          maxContentBytes: 65536,
          eventualDelivery: false,
        },
      }
    if (topic !== "qry_delivery_receipt") return original
    const input = IMDacSessionSchema.ReplyReceiptQuery.make({
      version: 1,
      channelType: Number(request.channelType) as 1 | 2,
      targetId: String(request.targetId),
      clientUid: String(request.clientUid),
      requestHash: String(request.requestHash),
      expiresAt: Number(String(request.expiresAt)),
    })
    queries.push(input)
    return {
      name: "DeliveryReceiptResult",
      value: {
        version: 1,
        state: modes.get(input.clientUid) ?? "confirmed_acceptance",
        clientUid: input.clientUid,
        requestHash: input.requestHash,
        expiresAt: input.expiresAt,
        msgId: `confirmed-${input.clientUid}`,
        msgTime: Date.now(),
        msgSeqNo: String(queries.length),
      },
    }
  },
})
const config = {
  appkey: `private-reconcile-${native.server.port}`,
  navigator: native.server.url.origin,
  token: "private-first-seen-token",
  userID: "receiver",
  identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" },
}
const original = KernelConfig.deliverySource(config)
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
    KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config))),
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
    yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: `k:1:${group.id}` })
    const project = yield* (yield* ProjectV2.Service).resolve(AbsolutePath.make(root))
    // Match the real Host dacScope: persistent reader Binding encodes orgID
    // as Decimal text, while KernelDelivery Source retains the numeric orgID.
    const account = KernelReaderSchema.decode(
      KernelReaderSchema.Binding,
      KernelReaderSchema.encode(
        KernelReaderSchema.Binding,
        {
          version: 1,
          instanceID: "00000000-0000-4000-8000-000000000001",
          workspaceID: root,
          realm: original.realm,
          appkey: original.appkey,
          orgID: String(original.orgID),
          userID: original.senderID,
          scopeKey: "d".repeat(64),
          readerVersion: 2,
        },
        8192,
      ),
      8192,
    )
    const scope = {
      ownerID: "server",
      accountKey: createHash("sha256")
        .update(JSON.stringify([account.realm, account.appkey, account.orgID, account.userID]))
        .digest("hex"),
      executorID: account.instanceID,
      conversationKey: JSON.stringify([1, group.id]),
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
    yield* SessionInput.promoteNextQueued(db, publisher, SessionV2.ID.make(command.sessionID))
    const activity = yield* openFixtureActivity({
      sessionId: SessionV2.ID.make(command.sessionID),
      triggerInputId: command.inputID,
      securityNamespaceId: SecurityNamespaceID.make("sec_im_reply_outbox"),
      now: Date.now(),
    })
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
    return { db, session, repo, command, assistantID, activityID: activity.activityId, text, scope, groupID: group.id }
  })
const settle = (f: Effect.Success<ReturnType<typeof prepare>>) =>
  Effect.gen(function* () {
    yield* (yield* EventV2.Service).publish(SessionEvent.Step.Ended, {
      sessionID: SessionV2.ID.make(f.command.sessionID),
      timestamp: DateTime.makeUnsafe(Date.now()),
      assistantMessageID: f.assistantID,
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    yield* settleFixtureActivity({
      activityId: f.activityID,
      finalMessageId: f.assistantID,
      securityNamespaceId: SecurityNamespaceID.make("sec_im_reply_outbox"),
      now: Date.now(),
    })
  })

const seed = (text: string) =>
  Effect.gen(function* () {
    const f = yield* prepare(text)
    yield* settle(f)
    yield* IMReplyOutbox.collectSessionReply({ db: f.db, v2Session: f.session }, f.command.sessionID)
    const authority = KernelDelivery.runtime(original)
    yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(authority)))
    const rows = yield* f.db
      .select()
      .from(IMReplyOutboxTable)
      .where(eq(IMReplyOutboxTable.session_id, f.command.sessionID))
      .orderBy(IMReplyOutboxTable.reply_message_id)
      .all()
    for (const row of rows) {
      const message = yield* KernelDelivery.withCreation(
        authority,
        f.groupID,
        f.repo.createMessage({
          id: row.delivery_message_id!,
          groupID: f.groupID,
          senderID: row.agent_id,
          senderType: "agent",
          type: "text",
          content: row.reply_text,
          mentions: [],
          metadata: { type: "agent_run", sessionID: f.command.sessionID, status: "success" },
        }),
      )
      const dispatch = yield* KernelDelivery.withVerification(
        authority,
        { conversationType: 1, conversationID: f.groupID, orgID: 1, memberIDs: ["receiver", f.groupID] },
        f.repo.claimKernelDelivery(authority, message.id),
      )
      if (!dispatch) return yield* Effect.die("Original dispatch fixture was not admitted")
      yield* f.repo.uncertainKernelDelivery(authority, dispatch)
      yield* f.db.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* ReplyBodyRetirement.read(tx, row.id)
            yield* tx
              .update(IMReplyOutboxTable)
              .set({ status: "dead", attempts: 8, last_error: "historical_unknown", time_updated: Date.now() })
              .where(eq(IMReplyOutboxTable.id, row.id))
              .run()
            yield* ReplyBodyRetirement.refresh(tx, row.id)
          }),
        { behavior: "immediate" },
      )
    }
    const client = yield* KernelClient.Service
    for (let n = 0; n < 200; n++) {
      if ((yield* SubscriptionRef.get(client.state)) === "connected") break
      if (n === 199) return yield* Effect.die("Original SDK did not CONNECT")
      yield* Effect.sleep("10 millis")
    }
    const active = { value: true }
    const current = Effect.suspend(() =>
      active.value ? Effect.void : Effect.fail(new Error("fixture reader retired")),
    )
    const transport = {
      source: { ...original, credentialFingerprint: "c".repeat(64) },
      current,
      protect: <A, E>(effect: Effect.Effect<A, E>) =>
        current.pipe(
          Effect.andThen(effect),
          Effect.tap(() => current),
        ),
      query: client.getDeliveryReceipt!,
    }
    const bridge = IMDacSession.make(f.db, f.session)
    return {
      ...f,
      rows,
      active,
      transport,
      bridge,
      reconcile: (cursor?: string) => bridge.reconcileReply(f.scope, f.command.commandID, { cursor }, transport),
    }
  })

// Actual Session projection, original collector/custody/dispatch APIs, file SQLite,
// original SDK → protobuf WS peer. No provider, PUBLISH, new command or outbox retry.
describe("original final reply receipt reconciliation", () => {
  it.live("reconciles a cold account using the real Host Decimal binding without replacing original dispatch", () =>
    Effect.gen(function* () {
      const f = yield* seed("original host-bound final")
      expect(f.rows).toHaveLength(1)
      const row = f.rows[0]
      const before = yield* f.db
        .select()
        .from(IMKernelDeliveryTable)
        .where(eq(IMKernelDeliveryTable.message_id, row.delivery_message_id!))
        .get()
      expect(before?.binding?.source.orgID).toBe(1)
      expect(before?.binding?.source.credentialFingerprint).not.toBe(f.transport.source.credentialFingerprint)
      modes.set(before!.wire_id, "unknown")
      const start = queries.length
      const first = yield* f.reconcile()
      expect(first).toMatchObject({ state: "unconfirmed", totalParts: 1, confirmedParts: 0, unconfirmedParts: 1 })
      expect(first.parts[0].outcome).toBe("unconfirmed")
      expect(queries.length - start).toBe(1)
      expect(
        (yield* f.db
          .select()
          .from(IMKernelDeliveryTable)
          .where(eq(IMKernelDeliveryTable.message_id, row.delivery_message_id!))
          .get())?.state,
      ).toBe("unknown")
      modes.clear()
      const result = yield* f.reconcile()
      expect(result).toMatchObject({
        state: "confirmed_acceptance",
        totalParts: 1,
        confirmedParts: 1,
        unconfirmedParts: 0,
      })
      const after = yield* f.db
        .select()
        .from(IMKernelDeliveryTable)
        .where(eq(IMKernelDeliveryTable.message_id, row.delivery_message_id!))
        .get()
      expect(after).toMatchObject({
        message_id: before!.message_id,
        binding_hash: before!.binding_hash,
        wire_id: before!.wire_id,
        dispatch_owner: before!.dispatch_owner,
        state: "acknowledged",
      })
      const outbox = yield* f.db.select().from(IMReplyOutboxTable).where(eq(IMReplyOutboxTable.id, row.id)).get()
      expect(outbox).toMatchObject({
        id: row.id,
        delivery_message_id: row.delivery_message_id,
        attempts: 8,
        last_error: "historical_unknown",
        status: "delivered",
        lease_owner: null,
        lease_expires_at: null,
      })
      const known = queries.length
      expect((yield* f.reconcile()).parts[0].outcome).toBe("already_confirmed")
      expect(queries.length).toBe(known)
      const different = yield* Effect.exit(
        f.bridge.reconcileReply(
          f.scope,
          f.command.commandID,
          {},
          { ...f.transport, source: { ...f.transport.source, orgID: 2 } },
        ),
      )
      expect(different._tag).toBe("Failure")
      expect(queries.length).toBe(known)
      expect(
        yield* f.db
          .select()
          .from(IMKernelDeliveryTable)
          .where(eq(IMKernelDeliveryTable.message_id, row.delivery_message_id!))
          .get(),
      ).toEqual(after)
      expect(probe.publish).toBe(0)
    }),
  )
  it.live(
    "settles original multipart independently, preserves unknown and leases, then paginates and rejects stale authority",
    () =>
      Effect.gen(function* () {
        const f = yield* seed("x".repeat(120001))
        expect(f.rows).toHaveLength(3)
        const binding = yield* f.db
          .select()
          .from(IMKernelDeliveryTable)
          .where(eq(IMKernelDeliveryTable.message_id, f.rows[1].delivery_message_id!))
          .get()
        modes.set(binding!.wire_id, "unknown")
        yield* f.db.transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(IMReplyOutboxTable)
                .set({ lease_owner: "active-original-worker", lease_expires_at: Date.now() + 60000 })
                .where(eq(IMReplyOutboxTable.id, f.rows[2].id))
                .run()
              yield* ReplyBodyRetirement.refresh(tx, f.rows[2].id)
            }),
          { behavior: "immediate" },
        )
        const beforeQueries = queries.length
        const first = yield* f.reconcile()
        expect(first).toMatchObject({
          state: "partial",
          totalParts: 3,
          confirmedParts: 1,
          unconfirmedParts: 2,
          activeParts: 1,
          hasMore: false,
        })
        expect(first.parts.map((p) => p.outcome)).toEqual(["confirmed_acceptance", "unconfirmed", "active_delivery"])
        expect(queries.length - beforeQueries).toBe(2)
        expect(first.command.replyStatus).toBe("unknown")
        expect(
          (yield* f.db.select().from(IMReplyOutboxTable).all()).every(
            (r) => r.attempts === 8 && r.last_error === "historical_unknown",
          ),
        ).toBe(true)
        yield* ReplyBodyFixture.fullMeter(f.db)
        modes.clear()
        yield* f.db.transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(IMReplyOutboxTable)
                .set({ lease_owner: null, lease_expires_at: null })
                .where(eq(IMReplyOutboxTable.id, f.rows[2].id))
                .run()
              yield* ReplyBodyRetirement.refresh(tx, f.rows[2].id)
            }),
          { behavior: "immediate" },
        )
        expect((yield* f.reconcile()).state).toBe("confirmed_acceptance")
        const ledgerBefore = yield* f.db.all(sql`SELECT * FROM im_reply_body ORDER BY outbox_id`)
        const receiptBefore = yield* f.db.select().from(IMKernelDeliveryTable).all()
        const count = queries.length
        expect((yield* f.reconcile()).parts.every((p) => p.outcome === "already_confirmed")).toBe(true)
        expect(queries.length).toBe(count)
        expect(yield* f.db.all(sql`SELECT * FROM im_reply_body ORDER BY outbox_id`)).toEqual(ledgerBefore)
        expect(yield* f.db.select().from(IMKernelDeliveryTable).all()).toEqual(receiptBefore)
        yield* ReplyBodyFixture.fullMeter(f.db)
        const paged = yield* seed("y".repeat(60000 * 32 + 1))
        const pages = [yield* paged.reconcile()]
        const indices: number[] = []
        // A page also yields after its original four-second work budget. Follow
        // that cursor instead of assuming every machine settles 32 remote RPCs.
        for (const index of Array.from({ length: 33 }, (_, index) => index)) {
          const page = pages[index]!
          expect(page.totalParts).toBe(33)
          expect(page.parts.length).toBeGreaterThan(0)
          expect(page.parts.length).toBeLessThanOrEqual(32)
          expect(page.parts.map((part) => part.index)).toEqual(
            Array.from({ length: page.parts.length }, (_, offset) => indices.length + offset),
          )
          indices.push(...page.parts.map((part) => part.index))
          expect(page.confirmedParts).toBe(indices.length)
          if (!page.hasMore) {
            expect(page).toMatchObject({ state: "confirmed_acceptance", confirmedParts: 33, nextCursor: null })
            break
          }
          expect(page.state).toBe("partial")
          expect(page.nextCursor).not.toBeNull()
          expect(page.nextCursor).not.toBe(pages[index - 1]?.nextCursor)
          expect(index).toBeLessThan(32)
          pages.push(yield* paged.reconcile(page.nextCursor!))
        }
        expect(indices).toEqual(Array.from({ length: 33 }, (_, index) => index))
        // Already-confirmed parts need no remote receipt RPC. This fast path
        // retains the strict page-size oracle independently of network timing.
        const confirmedQueries = queries.length
        const confirmed = yield* paged.reconcile()
        expect(confirmed).toMatchObject({ totalParts: 33, confirmedParts: 33, hasMore: true })
        expect(confirmed.parts).toHaveLength(32)
        expect(confirmed.parts.map((part) => part.index)).toEqual(Array.from({ length: 32 }, (_, index) => index))
        expect(confirmed.parts.every((part) => part.outcome === "already_confirmed")).toBe(true)
        const confirmedTail = yield* paged.reconcile(confirmed.nextCursor!)
        expect(confirmedTail).toMatchObject({ state: "confirmed_acceptance", confirmedParts: 33, hasMore: false, nextCursor: null })
        expect(confirmedTail.parts).toHaveLength(1)
        expect(confirmedTail.parts[0]).toMatchObject({ index: 32, outcome: "already_confirmed" })
        expect(queries.length).toBe(confirmedQueries)
        expect(yield* Effect.exit(f.reconcile(pages[0]!.nextCursor!))).toMatchObject({ _tag: "Failure" })
        const guarded = yield* seed("z".repeat(60001))
        const beforeGuard = queries.length
        const tail = guarded.rows[1]
        // An incomplete or malformed original set never becomes a one-part success.
        for (const changed of ["missing-tail", `${tail.reply_message_id}x`, "msg_foreign_impart_00000001"]) {
          yield* guarded.db
            .update(IMReplyOutboxTable)
            .set(changed === "missing-tail" ? { group_id: "unrelated" } : { reply_message_id: changed })
            .where(eq(IMReplyOutboxTable.id, tail.id))
            .run()
          expect((yield* Effect.exit(guarded.reconcile()))._tag).toBe("Failure")
          yield* guarded.db
            .update(IMReplyOutboxTable)
            .set({ group_id: guarded.groupID, reply_message_id: tail.reply_message_id })
            .where(eq(IMReplyOutboxTable.id, tail.id))
            .run()
        }
        expect(queries.length).toBe(beforeGuard)
        expect(
          (yield* Effect.exit(
            guarded.bridge.reconcileReply(
              guarded.scope,
              guarded.command.commandID,
              {},
              { ...guarded.transport, source: { ...original, senderID: "another-account" } },
            ),
          ))._tag,
        ).toBe("Failure")
        expect(queries.length).toBe(beforeGuard)
        const wrong = yield* seed("wrong receipt")
        const wrongReceipt = yield* wrong.db
          .select()
          .from(IMKernelDeliveryTable)
          .where(eq(IMKernelDeliveryTable.message_id, wrong.rows[0].delivery_message_id!))
          .get()
        modes.set(wrongReceipt!.wire_id, "unknown")
        const unchanged = yield* wrong.db.select().from(IMKernelDeliveryTable).all()
        expect((yield* wrong.reconcile()).state).toBe("unconfirmed")
        expect(yield* wrong.db.select().from(IMKernelDeliveryTable).all()).toEqual(unchanged)
        modes.clear()
        const racing = yield* seed("concurrent original worker")
        const raced = yield* racing.bridge.reconcileReply(
          racing.scope,
          racing.command.commandID,
          {},
          {
            ...racing.transport,
            query: (request) =>
              racing.transport.query(request).pipe(
                Effect.tap(() =>
                  racing.db.transaction(
                    (tx) =>
                      Effect.gen(function* () {
                        yield* tx
                          .update(IMReplyOutboxTable)
                          .set({
                            status: "delivering",
                            lease_owner: "new-original-worker",
                            lease_expires_at: Date.now() + 60000,
                          })
                          .where(eq(IMReplyOutboxTable.id, racing.rows[0].id))
                          .run()
                        yield* ReplyBodyRetirement.refresh(tx, racing.rows[0].id)
                      }),
                    { behavior: "immediate" },
                  ),
                ),
              ),
          },
        )
        expect(raced.parts[0].outcome).toBe("active_delivery")
        expect(raced.state).toBe("unconfirmed")
        expect(
          (yield* racing.db
            .select()
            .from(IMKernelDeliveryTable)
            .where(eq(IMKernelDeliveryTable.message_id, racing.rows[0].delivery_message_id!))
            .get())?.state,
        ).toBe("unknown")
        expect(
          (yield* racing.db.select().from(IMReplyOutboxTable).where(eq(IMReplyOutboxTable.id, racing.rows[0].id)).get())
            ?.lease_owner,
        ).toBe("new-original-worker")
        yield* ReplyBodyFixture.fullMeter(racing.db)
        const stale = yield* seed("late reply")
        probe.delay = 75
        const pending = yield* stale.reconcile().pipe(Effect.forkScoped)
        yield* Effect.sleep("10 millis")
        stale.active.value = false
        expect((yield* Effect.exit(Fiber.join(pending)))._tag).toBe("Failure")
        expect(
          (yield* stale.db.select().from(IMReplyOutboxTable).where(eq(IMReplyOutboxTable.id, stale.rows[0].id)).get())
            ?.status,
        ).toBe("dead")
        expect(probe.publish).toBe(0)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            probe.delay = 0
          }),
        ),
      ),
    30000,
  )
})

afterAll(() => native.server.stop(true))
it.live(
  "yields a real cursor after one slow receipt without extending any guard",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("b".repeat(60001))
      const before = queries.length
      probe.delay = 4050
      const started = performance.now()
      const first = yield* f.reconcile()
      expect(performance.now() - started).toBeGreaterThanOrEqual(4000)
      expect(first).toMatchObject({
        state: "partial",
        totalParts: 2,
        confirmedParts: 1,
        unconfirmedParts: 1,
        hasMore: true,
      })
      expect(first.parts).toHaveLength(1)
      expect(first.parts[0].index).toBe(0)
      expect(queries.length - before).toBe(1)
      probe.delay = 0
      const second = yield* f.reconcile(first.nextCursor!)
      expect(second).toMatchObject({
        state: "confirmed_acceptance",
        confirmedParts: 2,
        hasMore: false,
        nextCursor: null,
      })
      expect(second.parts[0].index).toBe(1)
      expect(queries.length - before).toBe(2)
      const confirmed = queries.length
      expect((yield* f.reconcile()).parts.every((p) => p.outcome === "already_confirmed")).toBe(true)
      expect(queries.length).toBe(confirmed)
      expect(probe.publish).toBe(0)
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          probe.delay = 0
        }),
      ),
    ),
  15000,
)
