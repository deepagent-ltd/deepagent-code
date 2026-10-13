import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { KernelReader } from "../src/im/kernel-reader"
import { ReplyBodyRetirement } from "../src/im/reply-body-retirement"
import { ReplyBodyRetirementModel } from "../src/im/reply-body-retirement.model"
import { ReplyDeliveryID } from "../src/im/reply-delivery-id"

import { ReplyBodyFixture } from "./fixture/im-reply-body-retirement"
const setup = ReplyBodyFixture.setup
const fullMeter = ReplyBodyFixture.fullMeter
const reply = ReplyBodyFixture.reply
const run = <A, E>(filename: string, body: Effect.Effect<A, E, Database.Service | IMRepository | Scope.Scope>) =>
  Effect.runPromise(
    body.pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(filename))), Effect.scoped),
  )
const isolated = async (body: (filename: string) => Promise<void>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dac-reply-body-runtime-"))
  const filename = path.join(dir, "database.sqlite")
  try {
    await body(filename)
  } finally {
    await fs.rm(dir, { recursive: true })
    expect(await Bun.file(filename).exists()).toBe(false)
  }
}

test("actual 2→3 local custody charges complete UTF8 rows and survives cold reopen", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const s = yield* setup
        expect((yield* ReplyBodyRetirement.read(s.db, s.id)).body.accounted_records).toBe(2)
        yield* fullMeter(s.db)
        const local = yield* s.create(false)
        expect((yield* ReplyBodyRetirement.read(s.db, s.id)).body.accounted_records).toBe(3)
        yield* fullMeter(s.db)
        // An existing local-only original message does not manufacture remote receipt.
        expect((yield* KernelDelivery.history(s.db, local.id)).kind).toBe("missing")
      const before = yield* ReplyBodyRetirement.read(s.db,s.id)
      expect(yield* s.repo.setMessageKernelMsgID({messageID:local.id,kernelMsgID:"中文🙂"})).toBe(true)
      const after = yield* ReplyBodyRetirement.read(s.db,s.id)
      expect(after.record.message).toEqual(before.record.message)
      expect(after.record.transport).toBeNull()
      expect(after.body.custody_state).toBe("local")
      expect(after.meter.used_bytes-before.meter.used_bytes).toBe(10)
      yield* fullMeter(s.db)
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        expect(
          (yield* ReplyBodyRetirement.read((yield* Database.Service).db, "imo_reply_history")).body.accounted_records,
        ).toBe(3)
        yield* fullMeter((yield* Database.Service).db)
      }),
    )
  }))

test("ACK plus original expiry atomically clears both copies and FTS, cold exact history stays blocked", () =>
  isolated(async (filename) => {
    const result = await run(
      filename,
      Effect.gen(function* () {
        const s = yield* setup
        const message = yield* s.create()
        expect((yield* ReplyBodyRetirement.read(s.db, s.id)).body.accounted_records).toBe(4)
        yield* s.acknowledge(message.id)
        yield* s.delivered()
        const before = yield* ReplyBodyRetirement.read(s.db, s.id)
        const facts = before.rawReceipt
        const expiry = before.record.transport!.binding.expiresAt
        expect(yield* s.retire(expiry - 1)).toEqual([])
        expect(yield* s.retire(expiry)).toEqual([s.group.id])
        const after = yield* ReplyBodyRetirement.read(s.db, s.id)
        expect(after.record.bodyState).toBe("retired")
        expect(after.outbox.reply_text).toBe("")
        expect(after.message?.content).toBe("")
        expect(after.message?.deleted_at).toBe(expiry)
        expect(after.receipt?.binding).toBeNull()
        expect(
          Object.fromEntries(
            Object.entries(after.rawReceipt!).filter(([key]) => !["binding", "body_state"].includes(key)),
          ),
        ).toEqual(
          Object.fromEntries(Object.entries(facts!).filter(([key]) => !["binding", "body_state"].includes(key))),
        )
        expect(
          (yield* s.db.get<{ count: number }>(
            sql`SELECT count(*) count FROM im_messages_fts WHERE msg_id=${message.id}`,
          ))?.count,
        ).toBe(0)
        expect(yield* s.retire(expiry + 1)).toEqual([])
        yield* fullMeter(s.db)
        expect((yield* KernelDelivery.history(s.db, message.id)).kind).toBe("reply_retired")
        expect((yield* KernelDelivery.statuses(s.db, [message.id]))[message.id]).toEqual({ state: "acknowledged" })
        expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.read(s.db, message.id)))).toBe(true)
        return { messageID: message.id, expiry, meter: yield* ReplyBodyRetirement.currentMeter(s.db) }
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect((yield* ReplyBodyRetirement.read(db, "imo_reply_history")).record.retiredAt).toBe(result.expiry)
        expect(yield* ReplyBodyRetirement.currentMeter(db)).toEqual(result.meter)
        expect(
          yield* ReplyBodyRetirement.exactCollected(db, {
            sessionID: "ses_im_reply_history",
            replyMessageID: "msg_reply_final",
          }),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              (yield* IMRepository).createMessage({
                id: result.messageID,
                groupID: (yield* ReplyBodyRetirement.read(db, "imo_reply_history")).outbox.group_id,
                senderID: "auto",
                senderType: "agent",
                type: "text",
                content: reply,
              }),
            ),
          ),
        ).toBe(true)
        yield* fullMeter(db)
        expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      }),
    )
  }))

for (const state of ["prepared", "dispatched", "unknown"] as const)
  test(`delivered + ${state} defers expiry without dropping body/transport/budget`, () =>
    isolated(async (filename) => {
      await run(
        filename,
        Effect.gen(function* () {
          const s = yield* setup
          const message = yield* s.create()
          if (state !== "prepared") {
            const dispatch = yield* s.dispatch(message.id)
            if (!dispatch) return yield* Effect.die("Original dispatch absent")
            if (state === "unknown") yield* s.repo.uncertainKernelDelivery(s.authority, dispatch)
          }
          yield* s.delivered()
          const before = yield* ReplyBodyRetirement.read(s.db, s.id)
          const meter = yield* ReplyBodyRetirement.currentMeter(s.db)
          expect(yield* s.retire(before.record.transport!.binding.expiresAt)).toEqual([])
          expect((yield* ReplyBodyRetirement.read(s.db, s.id)).body).toEqual(before.body)
          expect(yield* ReplyBodyRetirement.currentMeter(s.db)).toEqual(meter)
          yield* fullMeter(s.db)
        }),
      )
    }))

test("late current owner change rolls back every body and preserves original accounting", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const s = yield* setup
        const message = yield* s.create()
        yield* s.acknowledge(message.id)
        yield* s.delivered()
        const before = yield* ReplyBodyRetirement.read(s.db, s.id)
        // Actual SQL late trigger changes membership inside the body TX.
        yield* s.db.run(
          `CREATE TRIGGER reply_late_member AFTER UPDATE OF content ON im_messages WHEN NEW.content='' BEGIN DELETE FROM im_members WHERE group_id=NEW.group_id AND member_id='server'; END`,
        )
        expect(Exit.isFailure(yield* Effect.exit(s.retire(before.record.transport!.binding.expiresAt)))).toBe(true)
        expect((yield* ReplyBodyRetirement.read(s.db, s.id)).body).toEqual(before.body)
        expect(yield* ReplyBodyRetirement.currentMeter(s.db)).toEqual(before.meter)
        expect(
          (yield* s.db.get<{ count: number }>(
            sql`SELECT count(*) count FROM im_members WHERE group_id=${s.group.id} AND member_id='server'`,
          ))?.count,
        ).toBe(1)
      }),
    )
  }))

test("old sender ledger cold exact expired text echo stays body-free without new Message or meter growth", () =>
  isolated(async (filename) => {
    const original = await run(
      filename,
      Effect.gen(function* () {
        const s = yield* ReplyBodyFixture.make({ projection: true })
        const message = yield* s.create()
        yield* s.acknowledge(message.id)
        yield* s.delivered()
        const before = yield* ReplyBodyRetirement.read(s.db, s.id)
        const item = {
          effectKey: "d".repeat(64),
          messageId: `kernel-${message.id}`,
          sequence: "1",
          deliveryCursor: "1",
          messageTime: message.createdAt,
          expiresAt: before.record.transport!.binding.expiresAt,
          senderId: "alice",
          targetId: "bob",
          conversationType: 1 as const,
          content: JSON.stringify({ content: `[Agent·auto] ${reply}` }),
          isSend: true,
          isRead: false,
          messageType: "jg:text" as const,
        }
        const page = {
          version: 2 as const,
          scopeKey: ReplyBodyFixture.scopeKey,
          projectionKey: "c".repeat(64),
          projectionRevision: "1",
          direction: "newer" as const,
          nextDeliveryCursor: "1",
          finished: true,
          serverNow: Date.now(),
          items: [item],
        }
        yield* KernelReader.applyMessages(s.reader, page)
        const ledger = yield* s.db.get(sql`SELECT * FROM im_kernel_reader_message WHERE effect_key=${item.effectKey}`)
        expect(ledger).toMatchObject({ owns_message: 0, local_message_id: message.id, storage_state: "present" })
        yield* s.retire(item.expiresAt)
        const expired = { ...page, serverNow: item.expiresAt }
        const meter = yield* s.db.get("SELECT used_records,used_bytes FROM im_kernel_reader_meter")
        const replyMeter = yield* ReplyBodyRetirement.currentMeter(s.db)
        const counts = yield* s.db.get(
          "SELECT (SELECT count(*) FROM im_messages) messages,(SELECT count(*) FROM im_reply_outbox) outbox",
        )
        expect(yield* KernelReader.applyMessages(s.reader, expired)).toEqual([])
        expect(yield* s.db.get(sql`SELECT * FROM im_kernel_reader_message WHERE effect_key=${item.effectKey}`)).toEqual(
          ledger,
        )
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              KernelReader.applyMessages(s.reader, { ...expired, items: [{ ...item, content: item.content + " " }] }),
            ),
          ),
        ).toBe(true)
        return { expired, meter, replyMeter, counts, ledger }
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const reader = KernelReader.attach({
          db,
          workspaceID: "ws",
          userID: "server",
          source: ReplyBodyFixture.source,
          current: () => Effect.succeed(true),
          inspect: () => Effect.succeed({ name: "peer" }),
          readCut: () => Effect.die("No historical read execution"),
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(reader)))
        yield* KernelReader.bind(reader, ReplyBodyFixture.scopeKey, 2)
        expect(yield* KernelReader.applyMessages(reader, original.expired)).toEqual([])
        expect(yield* db.get("SELECT used_records,used_bytes FROM im_kernel_reader_meter")).toEqual(original.meter)
        expect(yield* ReplyBodyRetirement.currentMeter(db)).toEqual(original.replyMeter)
        expect(
          yield* db.get(
            "SELECT (SELECT count(*) FROM im_messages) messages,(SELECT count(*) FROM im_reply_outbox) outbox",
          ),
        ).toEqual(original.counts)
        expect(
          yield* db.get(
            sql`SELECT * FROM im_kernel_reader_message WHERE effect_key=${original.expired.items[0]!.effectKey}`,
          ),
        ).toEqual(original.ledger)
      }),
    )
  }))

test("actual COMMIT return loss reconciles exact after-marker read-only, cold body stays retired", () =>
  isolated(async (filename) => {
    const original = await run(
      filename,
      Effect.gen(function* () {
        const s = yield* setup
        const message = yield* s.create()
        yield* s.acknowledge(message.id)
        yield* s.delivered()
        const before = yield* ReplyBodyRetirement.read(s.db, s.id)
        const transaction = s.db.transaction.bind(s.db)
        const loss = { once: true, calls: 0 }
        s.db.transaction = ((...args: Parameters<typeof s.db.transaction>) =>
          transaction(...args).pipe(
            Effect.flatMap((value) => {
              loss.calls++
              if (!loss.once) return Effect.succeed(value)
              loss.once = false
              return Effect.fail(new Error("Controlled reply successful COMMIT return loss"))
            }),
          )) as typeof s.db.transaction
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            s.db.transaction = transaction
          }),
        )
        expect(yield* s.retire(before.record.transport!.binding.expiresAt)).toEqual([s.group.id])
        expect(loss.calls).toBe(2)
        return {
          id: s.id,
          body: (yield* ReplyBodyRetirement.read(s.db, s.id)).body,
          meter: yield* ReplyBodyRetirement.currentMeter(s.db),
        }
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect((yield* ReplyBodyRetirement.read(db, original.id)).body).toEqual(original.body)
        expect(yield* ReplyBodyRetirement.currentMeter(db)).toEqual(original.meter)
        expect((yield* KernelDelivery.history(db, original.body.local_message_id!)).kind).toBe("reply_retired")
      }),
    )
  }))

test("complete mutable Message facts are sealed separately from ACK/retirement-safe immutable header", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const s = yield* setup
        const message = yield* s.create()
        const before = yield* ReplyBodyRetirement.read(s.db, s.id)
        yield* s.db.run(sql`UPDATE im_messages SET delivery_status='tampered-raw-fact' WHERE id=${message.id}`)
        expect(Exit.isFailure(yield* Effect.exit(ReplyBodyRetirement.read(s.db, s.id)))).toBe(true)
        expect(yield* s.db.get(sql`SELECT * FROM im_reply_body WHERE outbox_id=${s.id}`)).toEqual(before.body)
        expect(yield* ReplyBodyRetirement.currentMeter(s.db)).toEqual(before.meter)
      }),
    )
  }))

test("late actual scope identity change rolls back both bodies, original receipt and meter", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const s = yield* setup
        const message = yield* s.create()
        yield* s.acknowledge(message.id)
        yield* s.delivered()
        const original = yield* ReplyBodyRetirement.read(s.db, s.id)
        const scope = yield* s.db.get("SELECT * FROM im_kernel_reader_scope")
        yield* s.db.run(
          `CREATE TRIGGER reply_late_scope AFTER UPDATE OF content ON im_messages WHEN NEW.content='' BEGIN UPDATE im_kernel_reader_scope SET binding_hash='${"e".repeat(64)}'; END`,
        )
        expect(Exit.isFailure(yield* Effect.exit(s.retire(original.record.transport!.binding.expiresAt)))).toBe(true)
        const after = yield* ReplyBodyRetirement.read(s.db, s.id)
        expect(after.rawMessage).toEqual(original.rawMessage)
        expect(after.rawOutbox).toEqual(original.rawOutbox)
        expect(after.rawReceipt).toEqual(original.rawReceipt)
        expect(after.body).toEqual(original.body)
        expect(after.meter).toEqual(original.meter)
        expect(yield* s.db.get("SELECT * FROM im_kernel_reader_scope")).toEqual(scope)
      }),
    )
  }))
