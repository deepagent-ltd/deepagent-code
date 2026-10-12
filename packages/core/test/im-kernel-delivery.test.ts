import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive, type IMRepositoryInterface } from "../src/im/repository"
import { KernelDelivery } from "../src/im/kernel-delivery"

const source = {
  realm: "http://127.0.0.1:9/",
  appkey: "audit",
  orgID: 1,
  senderID: "alice",
  credentialFingerprint: "a".repeat(64),
}
const database = Database.layerFromPath(":memory:")
const layer = Layer.merge(database, IMRepositoryLive.pipe(Layer.provide(database)))
const setup = Effect.gen(function* () {
  const repo = yield* IMRepository
  const db = (yield* Database.Service).db
  const group = yield* repo.createGroup({ workspaceID: "ws", type: "project", name: "audit", createdBy: "server" })
  yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: "k:1:bob" })
  const authority = KernelDelivery.runtime(source)
  const create = (requestID: string, content = "hello", runtime = authority) =>
    KernelDelivery.withCreation(
      runtime,
      group.id,
      repo.createMessage({
        groupID: group.id,
        clientRequestID: requestID,
        senderID: "server",
        senderType: "user",
        type: "text",
        content,
      }),
    )
  return { repo, db, group, authority, create }
})
const claim = (repo: IMRepositoryInterface, runtime: KernelDelivery.Runtime, messageID: string) =>
  KernelDelivery.withVerification(
    runtime,
    { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] },
    repo.claimKernelDelivery(runtime, messageID),
  )
const run = <A, E>(effect: Effect.Effect<A, E, IMRepository | Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped))

test("new message and prepared receipt commit together; exact retry cannot consume another dispatch", async () =>
  run(
    Effect.gen(function* () {
      const s = yield* setup
      const message = yield* s.create("one")
      expect((yield* s.repo.kernelDeliveryStatus(message.id)).state).toBe("prepared")
      expect((yield* s.create("one")).id).toBe(message.id)
      expect(yield* s.create("one", "changed").pipe(Effect.flip)).toMatchObject({ code: "message_identity_conflict" })
      const dispatch = yield* claim(s.repo, s.authority, message.id)
      expect(dispatch?.binding.messageID).toBe(message.id)
      expect(dispatch?.text).toBe("hello")
      expect(yield* claim(s.repo, s.authority, message.id)).toBeUndefined()
      expect((yield* s.repo.kernelDeliveryStatus(message.id)).state).toBe("unknown")
      expect(yield* s.repo.listPendingKernelMessages({ runtime: s.authority, limit: 50 })).toHaveLength(0)
      expect(yield* s.repo.acknowledgeKernelDelivery(s.authority, dispatch!, "kernel-one")).toBe(true)
      expect((yield* s.db.get<{ kernel_msg_id: string | null }>(sql`SELECT kernel_msg_id FROM im_messages WHERE id=${message.id}`))?.kernel_msg_id).toBe("kernel-one")
      expect((yield* s.repo.kernelDeliveryStatus(message.id)).state).toBe("acknowledged")
    }),
  ))

test("missing creation authority rolls back the new message; legacy rows are unknown without backfill", async () =>
  run(
    Effect.gen(function* () {
      const s = yield* setup
      expect(
        yield* s.repo
          .createMessage({
            groupID: s.group.id,
            senderID: "server",
            senderType: "user",
            type: "text",
            content: "blocked",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "kernel_delivery_unavailable" })
      expect(yield* s.db.get(sql`SELECT count(*) AS n FROM im_messages`)).toEqual({ n: 0 })
      yield* s.db.run(
        sql`INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,created_at,updated_at) VALUES ('imsg_legacy',${s.group.id},'server','user','text','old',1,1)`,
      )
      expect(yield* s.repo.kernelDeliveryStatus("imsg_legacy")).toMatchObject({
        state: "unknown",
        reason: "legacy_missing_receipt",
      })
      expect(yield* claim(s.repo, s.authority, "imsg_legacy")).toBeUndefined()
      expect(yield* s.db.get(sql`SELECT count(*) AS n FROM im_kernel_delivery`)).toEqual({ n: 0 })
    }),
  ))

test("ACK SQL failure keeps durable dispatched; a new runtime cannot resend; old owner cannot ACK after close", async () =>
  run(
    Effect.gen(function* () {
      const s = yield* setup
      const message = yield* s.create("ack-failure")
      const dispatch = yield* claim(s.repo, s.authority, message.id)
      yield* s.db.run(
        "CREATE TRIGGER refuse_ack BEFORE UPDATE OF kernel_msg_id ON im_messages BEGIN SELECT RAISE(ABORT, 'fixture ack failure'); END",
      )
      yield* s.repo.acknowledgeKernelDelivery(s.authority, dispatch!, "kernel-accepted").pipe(Effect.flip)
      yield* s.db.run("DROP TRIGGER refuse_ack")
      expect((yield* s.db.get<{ kernel_msg_id: string | null }>(sql`SELECT kernel_msg_id FROM im_messages WHERE id=${message.id}`))?.kernel_msg_id).toBeNull()
      expect((yield* s.repo.kernelDeliveryStatus(message.id)).state).toBe("unknown")
      const next = KernelDelivery.runtime(source)
      expect(yield* claim(s.repo, next, message.id)).toBeUndefined()
      KernelDelivery.close(s.authority)
      expect(yield* s.repo.acknowledgeKernelDelivery(s.authority, dispatch!, "late-old")).toBe(false)
      expect(yield* s.repo.listPendingKernelMessages({ runtime: next, limit: 50 })).toHaveLength(0)
    }),
  ))

test("old identity and unknown backlog do not occupy the prepared window; capacity is bounded and atomic", async () =>
  run(
    Effect.gen(function* () {
      const s = yield* setup
      const old = KernelDelivery.runtime({ ...source, credentialFingerprint: "b".repeat(64) })
      for (let i = 0; i < 55; i++) yield* s.create(`old-${i}`, "old", old)
      const message = yield* s.create("current")
      expect(
        (yield* s.repo.listPendingKernelMessages({ runtime: s.authority, limit: 50 })).map((row) => row.message.id),
      ).toEqual([message.id])
      const small = KernelDelivery.runtime(source, 56)
      expect(yield* s.create("over-cap", "no new row", small).pipe(Effect.flip)).toMatchObject({
        code: "kernel_delivery_unavailable",
      })
      expect(yield* s.db.get(sql`SELECT count(*) AS n FROM im_messages`)).toEqual({ n: 56 })
      expect(yield* s.db.get(sql`SELECT count(*) AS n FROM im_kernel_delivery`)).toEqual({ n: 56 })
      expect(() => KernelDelivery.runtime(source, 100001)).toThrow()
    }),
  ))

test("binding corruption and physical message removal cannot authorize dispatch; receipt survives deletion", async () =>
  run(
    Effect.gen(function* () {
      const s = yield* setup
      const message = yield* s.create("tamper")
      yield* s.db.run(
        sql`UPDATE im_kernel_delivery SET binding=json_set(binding, '$.conversationID', 'another') WHERE message_id=${message.id}`,
      )
      yield* claim(s.repo, s.authority, message.id).pipe(Effect.flip)
      const removed = yield* s.create("removed")
      yield* s.db.run(sql`DELETE FROM im_messages WHERE id=${removed.id}`)
      expect(yield* claim(s.repo, s.authority, removed.id)).toBeUndefined()
      expect(yield* s.db.get(sql`SELECT count(*) AS n FROM im_kernel_delivery WHERE message_id=${removed.id}`)).toEqual(
        { n: 1 },
      )
      yield* s.create("removed").pipe(Effect.flip)
      expect(yield* s.db.get(sql`SELECT count(*) AS n FROM im_messages WHERE id=${removed.id}`)).toEqual({ n: 0 })
    }),
  ))

test("SQL rejects a null receipt identity", async () =>
  run(
    Effect.gen(function* () {
      const s = yield* setup
      const message = yield* s.create("non-null")
      const result = yield* s.db
        .run(sql`UPDATE im_kernel_delivery SET message_id=NULL WHERE message_id=${message.id}`)
        .pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect((yield* s.repo.kernelDeliveryStatus(message.id)).state).toBe("prepared")
    }),
  ))

test("dispatch requires a private verified conversation and current member proof", async () =>
  run(
    Effect.gen(function* () {
      const s = yield* setup
      const message = yield* s.create("proof")
      expect(yield* s.repo.claimKernelDelivery(s.authority, message.id)).toBeUndefined()
      expect(
        yield* KernelDelivery.withVerification(
          s.authority,
          { orgID: 2, conversationType: 1, conversationID: "bob", memberIDs: ["alice", "bob"] },
          s.repo.claimKernelDelivery(s.authority, message.id),
        ),
      ).toBeUndefined()
      expect(
        yield* KernelDelivery.withVerification(
          s.authority,
          { orgID: 1, conversationType: 1, conversationID: "bob", memberIDs: ["bob"] },
          s.repo.claimKernelDelivery(s.authority, message.id),
        ),
      ).toBeUndefined()
      expect((yield* s.repo.kernelDeliveryStatus(message.id)).state).toBe("prepared")
      expect(
        yield* s.repo.setMessageKernelMsgID({ messageID: message.id, kernelMsgID: "unowned" }).pipe(Effect.flip),
      ).toMatchObject({ code: "kernel_delivery_unavailable" })
    }),
  ))

test("batch status is read-only, bounded, omits inbound/local-only and exposes no transport credentials", async () =>
  run(
    Effect.gen(function* () {
      const s = yield* setup
      const queued = yield* s.create("queued")
      const accepted = yield* s.create("accepted")
      const dispatched = yield* claim(s.repo, s.authority, accepted.id)
      yield* s.repo.acknowledgeKernelDelivery(s.authority, dispatched!, "kernel-accepted")
      const inbound = yield* s.repo.createMessage({
        groupID: s.group.id,
        senderID: "bob",
        senderType: "user",
        type: "text",
        content: "received",
        kernelMsgID: "kernel-inbound",
      })
      const local = yield* s.repo.createGroup({
        workspaceID: "ws",
        type: "project",
        name: "local",
        createdBy: "server",
      })
      const localMessage = yield* s.repo.createMessage({
        groupID: local.id,
        senderID: "server",
        senderType: "user",
        type: "text",
        content: "local",
      })
      const before = yield* s.db.all("SELECT * FROM im_kernel_delivery")
      yield* s.db.run("PRAGMA query_only=ON")
      expect(
        yield* s.repo.kernelDeliveryStatuses([queued.id, accepted.id, inbound.id, localMessage.id], s.authority),
      ).toEqual({ [queued.id]: { state: "prepared" }, [accepted.id]: { state: "acknowledged" } })
      expect(yield* s.repo.kernelDeliveryStatuses([queued.id])).toEqual({
        [queued.id]: { state: "unknown", reason: "delivery_identity_or_expiry_changed" },
      })
      expect(yield* s.db.all("SELECT * FROM im_kernel_delivery")).toEqual(before)
      yield* s.db.run("PRAGMA query_only=OFF")
      yield* s.repo.kernelDeliveryStatuses(Array(101).fill(queued.id), s.authority).pipe(Effect.flip)
    }),
  ))

test("expired prepared rows keep their original expiry and cannot starve a current message", async () =>
  run(
    Effect.gen(function* () {
      const s = yield* setup
      const old = yield* KernelDelivery.withCreation(
        s.authority,
        s.group.id,
        s.repo.createMessage({
          groupID: s.group.id,
          senderID: "server",
          senderType: "user",
          type: "text",
          content: "expired",
          createdAt: Date.now() - KernelDelivery.TTL - 1,
        }),
      )
      const current = yield* s.create("current-after-expiry")
      expect(yield* claim(s.repo, s.authority, old.id)).toBeUndefined()
      expect(
        (yield* s.repo.listPendingKernelMessages({ runtime: s.authority, limit: 1 })).map((row) => row.message.id),
      ).toEqual([current.id])
      expect((yield* s.repo.kernelDeliveryStatus(old.id, s.authority)).state).toBe("unknown")
    }),
  ))
