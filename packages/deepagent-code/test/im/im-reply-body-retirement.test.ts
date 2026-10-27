import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive, IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { ReplyBodyRetirement } from "@deepagent-code/core/im/reply-body-retirement"
import { ReplyBodyRetirementModel } from "@deepagent-code/core/im/reply-body-retirement.model"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { IMReplyOutbox } from "@/im/im-reply-outbox"
import { ReplyBodyFixture } from "../../../core/test/fixture/im-reply-body-retirement"

const isolated = async (body: (filename: string) => Promise<void>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dac-host-reply-body-runtime-"))
  const filename = path.join(dir, "database.sqlite")
  try {
    await body(filename)
  } finally {
    await fs.rm(dir, { recursive: true })
    expect(await Bun.file(filename).exists()).toBe(false)
  }
}
const services = (filename: string) =>
  Layer.mergeAll(Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(filename)), IMBroadcasterLive)
const sessionLayer = (database: ReturnType<typeof Database.layerFromPath>) => {
  const events = EventV2.layer.pipe(Layer.provide(database))
  return SessionV2.layer.pipe(
    Layer.provide(SessionExecution.noopLayer),
    Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
    Layer.provide(SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))),
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(
      ProjectV2.layer.pipe(
        Layer.provide(database),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(Git.defaultLayer),
      ),
    ),
  )
}
const append = (s: Effect.Success<ReturnType<typeof ReplyBodyFixture.make>>) => ({
  id: s.id,
  sessionID: s.sessionID,
  groupID: s.group.id,
  agentID: "auto",
  triggerMessageID: s.inputID,
  replyMessageID: "msg_reply_final",
  replyText: ReplyBodyFixture.reply,
  now: Date.now(),
})

test("actual Host append, lease, UTF8 failure and delivered writers atomically refresh full custody", () =>
  isolated(async (filename) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* ReplyBodyFixture.make({ append: false })
        expect(yield* IMReplyOutbox.appendReply(s.db, append(s))).toBe(true)
        expect(yield* IMReplyOutbox.appendReply(s.db, append(s))).toBe(false)
        yield* ReplyBodyFixture.fullMeter(s.db)
        const claim = yield* IMReplyOutbox.claimDueReply(s.db, { ownerToken: "first", now: Date.now() })
        expect(claim).toBeDefined()
        yield* ReplyBodyFixture.fullMeter(s.db)
        expect(
          yield* IMReplyOutbox.failReplyAttempt(s.db, {
            item: claim!,
            ownerToken: "first",
            reason: "错误🙂完整UTF8",
            now: Date.now(),
          }),
        ).toBe("pending")
        yield* ReplyBodyFixture.fullMeter(s.db)
        const row = yield* ReplyBodyRetirement.read(s.db, s.id)
        const next = yield* IMReplyOutbox.claimDueReply(s.db, { ownerToken: "second", now: row.outbox.available_at })
        expect(next?.attempts).toBe(2)
        expect(yield* IMReplyOutbox.markDelivered(s.db, { item: next!, ownerToken: "wrong" })).toBe(false)
        expect(yield* IMReplyOutbox.markDelivered(s.db, { item: next!, ownerToken: "second" })).toBe(true)
        expect((yield* ReplyBodyRetirement.read(s.db, s.id)).outbox.status).toBe("delivered")
        yield* ReplyBodyFixture.fullMeter(s.db)
        expect(
          Exit.isFailure(yield* Effect.exit(IMReplyOutbox.appendReply(s.db, { ...append(s), groupID: "foreign" }))),
        ).toBe(true)
      }).pipe(Effect.provide(services(filename)), Effect.scoped),
    )
  }))

test("local-only reply is explicit persistent defer, exact append never changes scheduling or creates a receipt", () =>
  isolated(async (filename) => {
    const original = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* ReplyBodyFixture.make({ append: false, bindingWorkspaceID: "wrk_reply_host_local" })
        const input = append(s)
        yield* IMReplyOutbox.appendReply(s.db, input)
        const item = yield* IMReplyOutbox.claimDueReply(s.db, { ownerToken: "first", now: Date.now() })
        const calls = { broadcast: 0, send: 0 }
        const actual = yield* IMBroadcasterService
        const broadcaster = {
          ...actual,
          broadcast: (...args: Parameters<typeof actual.broadcast>) => {
            calls.broadcast++
            return actual.broadcast(...args)
          },
        }
        const message = yield* IMReplyOutbox.deliverReply({ db: s.db, repo: s.repo, broadcaster }, item!)
        expect(calls.broadcast).toBe(1)
        expect(yield* IMReplyOutbox.markDelivered(s.db, { item: item!, ownerToken: "first" })).toBe(true)
        // Local-only is explicit defer; no receipt/expiry is fabricated.
        expect((yield* ReplyBodyRetirement.read(s.db, s.id)).record.transport).toBeNull()
        expect(yield* s.retire(Date.now() + 259200000)).toEqual([])
        yield* ReplyBodyFixture.fullMeter(s.db)
        return { input, item, message }
      }).pipe(Effect.provide(services(filename)), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(yield* IMReplyOutbox.appendReply(db, original.input)).toBe(false)
        expect(
          yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "later", now: Date.now() + 259200000 }),
        ).toBeUndefined()
        yield* ReplyBodyFixture.fullMeter(db)
      }).pipe(Effect.provide(services(filename)), Effect.scoped),
    )
  }))

test("late Host fail reason quota refusal rolls back lease/status/error and actual meter", () =>
  isolated(async (filename) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* ReplyBodyFixture.make({ append: false })
        yield* IMReplyOutbox.appendReply(s.db, append(s))
        const item = yield* IMReplyOutbox.claimDueReply(s.db, { ownerToken: "first", now: Date.now() })
        const original = yield* ReplyBodyRetirement.read(s.db, s.id)
        // Meter boundary itself remains a legal bounded row; actual write must deny
        // growth without overwriting the still-owned original delivery lease.
        yield* s.db.run(
          sql`UPDATE im_reply_body_meter SET used_bytes=${ReplyBodyRetirementModel.BYTE_LIMIT} WHERE meter_id=1`,
        )
        const before = yield* ReplyBodyRetirement.currentMeter(s.db)
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              IMReplyOutbox.failReplyAttempt(s.db, { item: item!, ownerToken: "first", reason: "错误".repeat(2000) }),
            ),
          ),
        ).toBe(true)
        const after = yield* s.db.get(sql`SELECT * FROM im_reply_outbox WHERE id=${s.id}`)
        expect(after).toEqual(original.rawOutbox)
        expect(yield* ReplyBodyRetirement.currentMeter(s.db)).toEqual(before)
        expect(yield* s.db.get(sql`SELECT * FROM im_reply_body WHERE outbox_id=${s.id}`)).toEqual(original.body)
      }).pipe(Effect.provide(services(filename)), Effect.scoped),
    )
  }))

test("Host retired exact append is noop and direct delivery rejects before original repo/broadcast ports", () =>
  isolated(async (filename) => {
    const original = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* ReplyBodyFixture.make({ append: false })
        const input = append(s)
        yield* IMReplyOutbox.appendReply(s.db, input)
        const item = yield* IMReplyOutbox.claimDueReply(s.db, { ownerToken: "first", now: Date.now() })
        const message = yield* s.create()
        yield* s.acknowledge(message.id)
        yield* IMReplyOutbox.markDelivered(s.db, { item: item!, ownerToken: "first" })
        const expiry = (yield* ReplyBodyRetirement.read(s.db, s.id)).record.transport!.binding.expiresAt
        yield* s.retire(expiry)
        const before = yield* ReplyBodyRetirement.read(s.db, s.id)
        const calls = { create: 0, broadcast: 0 }
        const actual = yield* IMBroadcasterService
        const repo = {
          ...s.repo,
          createMessage: (request: Parameters<typeof s.repo.createMessage>[0]) => {
            calls.create++
            return s.repo.createMessage(request)
          },
        }
        const broadcaster = {
          ...actual,
          broadcast: (...args: Parameters<typeof actual.broadcast>) => {
            calls.broadcast++
            return actual.broadcast(...args)
          },
        }
        expect(
          Exit.isFailure(yield* Effect.exit(IMReplyOutbox.deliverReply({ db: s.db, repo, broadcaster }, item!))),
        ).toBe(true)
        expect(calls).toEqual({ create: 0, broadcast: 0 })
        expect(yield* IMReplyOutbox.appendReply(s.db, input)).toBe(false)
        expect(yield* IMReplyOutbox.claimDueReply(s.db, { ownerToken: "later", now: expiry })).toBeUndefined()
        expect((yield* ReplyBodyRetirement.read(s.db, s.id)).body).toEqual(before.body)
        expect(yield* ReplyBodyRetirement.currentMeter(s.db)).toEqual(before.meter)
        return { input, item, meter: before.meter }
      }).pipe(Effect.provide(services(filename)), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(yield* IMReplyOutbox.appendReply(db, original.input)).toBe(false)
        expect(yield* ReplyBodyRetirement.currentMeter(db)).toEqual(original.meter)
      }).pipe(Effect.provide(services(filename)), Effect.scoped),
    )
  }))

test("cold actual Session collector resolves retired closure before any independent final-body read", () =>
  isolated(async (filename) => {
    const sessionID = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* ReplyBodyFixture.make({ append: false })
        yield* IMReplyOutbox.appendReply(s.db, append(s))
        const item = yield* IMReplyOutbox.claimDueReply(s.db, { ownerToken: "first", now: Date.now() })
        const message = yield* s.create()
        yield* s.acknowledge(message.id)
        yield* IMReplyOutbox.markDelivered(s.db, { item: item!, ownerToken: "first" })
        const original = yield* ReplyBodyRetirement.read(s.db, s.id)
        yield* s.retire(original.record.transport!.binding.expiresAt)
        yield* s.db.run(
          sql`UPDATE session SET metadata=${JSON.stringify({ im: { groupID: s.group.id, agent: "auto" } })} WHERE id=${s.sessionID}`,
        )
        return s.sessionID
      }).pipe(Effect.provide(services(filename)), Effect.scoped),
    )
    const database = Database.layerFromPath(filename)
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const original = yield* ReplyBodyRetirement.read(db, "imo_reply_history")
        const actual = yield* SessionV2.Service
        const calls = { final: 0 }
        const observed = {
          ...actual,
          message: (input: Parameters<typeof actual.message>[0]) => {
            calls.final++
            return actual.message(input)
          },
        }
        expect(yield* IMReplyOutbox.collectSessionReply({ db, v2Session: observed }, sessionID)).toBe(false)
        expect(calls.final).toBe(0)
        expect((yield* ReplyBodyRetirement.read(db, "imo_reply_history")).body).toEqual(original.body)
        expect(yield* ReplyBodyRetirement.currentMeter(db)).toEqual(original.meter)
        yield* ReplyBodyFixture.fullMeter(db)
        yield* db.run(sql`UPDATE im_reply_body SET record_hash=${"0".repeat(64)} WHERE outbox_id='imo_reply_history'`)
        expect(
          Exit.isFailure(yield* Effect.exit(IMReplyOutbox.collectSessionReply({ db, v2Session: observed }, sessionID))),
        ).toBe(true)
        expect(calls.final).toBe(0)
      }).pipe(Effect.provide(Layer.mergeAll(database, sessionLayer(database))), Effect.scoped),
    )
  }))

test("cold collector preserves a genuinely ACKed retired split without matching another final or malformed part", () =>
  isolated(async (filename) => {
    const database = Database.layerFromPath(filename)
    const original = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* ReplyBodyFixture.make({ append: false, finalText: "x".repeat(60_001) })
        const session = yield* SessionV2.Service
        expect(yield* IMReplyOutbox.collectSessionReply({ db: s.db, v2Session: session }, s.sessionID)).toBe(true)
        const rows = yield* s.db.all<{
          id: string
          reply_message_id: string
          delivery_message_id: string
          reply_text: string
          agent_id: string
        }>(
          sql`SELECT id,reply_message_id,delivery_message_id,reply_text,agent_id FROM im_reply_outbox WHERE session_id=${s.sessionID} ORDER BY reply_message_id`,
        )
        expect(rows.map((row) => row.reply_message_id)).toEqual([
          "msg_reply_final_impart_00000000",
          "msg_reply_final_impart_00000001",
        ])
        const item = yield* IMReplyOutbox.claimDueReply(s.db, { ownerToken: "split-original", now: Date.now() })
        const part = rows.find((row) => row.id === item?.id)
        if (!item || !part) return yield* Effect.die("The original split delivery was not claimed")
        yield* s.repo.bindKernelConversation({ groupID: s.group.id, kernelConvID: "k:1:bob" })
        const message = yield* KernelDelivery.withCreation(
          s.authority,
          s.group.id,
          s.repo.createMessage({
            id: part.delivery_message_id,
            groupID: s.group.id,
            senderID: part.agent_id,
            senderType: "agent",
            type: "text",
            content: part.reply_text,
            mentions: [],
            metadata: { type: "agent_run", sessionID: s.sessionID, status: "success" },
          }),
        )
        yield* s.acknowledge(message.id)
        expect(yield* IMReplyOutbox.markDelivered(s.db, { item, ownerToken: "split-original" })).toBe(true)
        const expiry = (yield* ReplyBodyRetirement.read(s.db, part.id)).record.transport?.binding.expiresAt
        if (expiry === undefined) return yield* Effect.die("The split has no original ACK expiry")
        expect(yield* s.retire(expiry)).toEqual([s.group.id])
        expect((yield* ReplyBodyRetirement.read(s.db, part.id)).record.bodyState).toBe("retired")
        expect(
          (yield* ReplyBodyRetirement.read(s.db, rows.find((row) => row.id !== part.id)!.id)).record.bodyState,
        ).toBe("live")
        yield* ReplyBodyFixture.fullMeter(s.db)
        return {
          sessionID: s.sessionID,
          part,
          outboxes: yield* s.db.all(sql`SELECT * FROM im_reply_outbox ORDER BY id`),
          bodies: yield* s.db.all(sql`SELECT * FROM im_reply_body ORDER BY outbox_id`),
          meter: yield* ReplyBodyRetirement.currentMeter(s.db),
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(Layer.provideMerge(IMRepositoryLive, database), IMBroadcasterLive, sessionLayer(database)),
        ),
        Effect.scoped,
      ),
    )
    const reopened = Database.layerFromPath(filename)
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const actual = yield* SessionV2.Service
        const calls = { final: 0 }
        const observed = {
          ...actual,
          message: (input: Parameters<typeof actual.message>[0]) => {
            calls.final++
            return actual.message(input)
          },
        }
        expect(yield* IMReplyOutbox.collectSessionReply({ db, v2Session: observed }, original.sessionID)).toBe(false)
        expect(calls.final).toBe(0)
        for (const changed of [
          "msg_reply_finalx_impart_00000000",
          "msg_reply_final_impart_0000000",
          "msg_reply_final_impart_00000000x",
        ]) {
          yield* db.run(sql`UPDATE im_reply_outbox SET reply_message_id=${changed} WHERE id=${original.part.id}`)
          const result = yield* IMReplyOutbox.collectSessionReply({ db, v2Session: observed }, original.sessionID).pipe(
            Effect.exit,
            Effect.ensuring(
              db
                .run(
                  sql`UPDATE im_reply_outbox SET reply_message_id=${original.part.reply_message_id} WHERE id=${original.part.id}`,
                )
                .pipe(Effect.orDie),
            ),
          )
          expect(calls.final).toBeGreaterThan(0)
          expect(Exit.isSuccess(result) ? result.value : false).toBe(false)
          calls.final = 0
        }
        expect(yield* db.all(sql`SELECT * FROM im_reply_outbox ORDER BY id`)).toEqual(original.outboxes)
        expect(yield* db.all(sql`SELECT * FROM im_reply_body ORDER BY outbox_id`)).toEqual(original.bodies)
        expect(yield* ReplyBodyRetirement.currentMeter(db)).toEqual(original.meter)
        yield* ReplyBodyFixture.fullMeter(db)
      }).pipe(Effect.provide(Layer.mergeAll(reopened, sessionLayer(reopened))), Effect.scoped),
    )
  }))

test("legacy unbound denial is retained without blocking the next legitimate ready outbox", () =>
  isolated(async (filename) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* ReplyBodyFixture.make({ append: false })
        yield* IMReplyOutbox.appendReply(s.db, {
          id: "imo_unknown_legacy",
          sessionID: "historical-unknown",
          groupID: "missing-original-group",
          agentID: "auto",
          replyMessageID: "unknown-final",
          replyText: "Original unknown body",
          now: 1,
        })
        const original = yield* ReplyBodyRetirement.read(s.db, "imo_unknown_legacy")
        expect(original.record.origin.kind).toBe("legacy_unbound")
        yield* IMReplyOutbox.appendReply(s.db, append(s))
        const claimed = yield* IMReplyOutbox.claimDueReply(s.db, { ownerToken: "current", now: Date.now() })
        expect(claimed?.id).toBe(s.id)
        expect((yield* ReplyBodyRetirement.read(s.db, "imo_unknown_legacy")).body).toEqual(original.body)
        // Recreated IDs do not upgrade origin or custody into current execution.
        yield* s.db.run(
          sql`INSERT INTO im_groups(id,workspace_id,type,name,created_by,created_at,updated_at) VALUES('missing-original-group','ws','project','replacement','server',1,1)`,
        )
        expect(Exit.isFailure(yield* Effect.exit(ReplyBodyRetirement.read(s.db, "imo_unknown_legacy")))).toBe(true)
      }).pipe(Effect.provide(services(filename)), Effect.scoped),
    )
  }))

test("original settled Activity guard rejects a rewritten final pointer and collector identity remains unchanged", () =>
  isolated(async (filename) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* ReplyBodyFixture.make({ append: false })
        yield* IMReplyOutbox.appendReply(s.db, append(s))
        const original = yield* ReplyBodyRetirement.read(s.db, s.id)
        // The original physical settlement guard is real and remains enabled.
        const activity = yield* s.db.get<{ activity_id: string }>(
          sql`SELECT activity_id FROM session_activity WHERE session_id=${s.sessionID} AND state='settled' AND final_message_id='msg_reply_final'`,
        )
        expect(activity).toBeDefined()
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              s.db.run(
                sql`UPDATE session_activity SET final_message_id='replacement-final' WHERE activity_id=${activity!.activity_id}`,
              ),
            ),
          ),
        ).toBe(true)
        expect(yield* IMReplyOutbox.appendReply(s.db, append(s))).toBe(false)
        expect((yield* s.db.get<{ count: number }>("SELECT count(*) count FROM im_reply_outbox"))?.count).toBe(1)
        expect((yield* ReplyBodyRetirement.read(s.db, s.id)).body).toEqual(original.body)
        expect(yield* ReplyBodyRetirement.currentMeter(s.db)).toEqual(original.meter)
      }).pipe(Effect.provide(services(filename)), Effect.scoped),
    )
  }))
