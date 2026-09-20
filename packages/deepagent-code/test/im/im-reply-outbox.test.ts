import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import * as DateTime from "effect/DateTime"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { IMRepository, IMRepositoryError, IMMessage } from "@deepagent-code/core/im/repository"
import type { IMRepositoryInterface } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { IMReplyOutbox } from "@/im/im-reply-outbox"
import { testEffect } from "../lib/effect"

// V2 IM durable-only — the reply half (src/im/im-reply-outbox.ts). The terminal assistant reply of
// a settled IM session must reach the IM conversation AT-LEAST-ONCE: append (idempotent on
// (session, reply)) → claim (lease + attempts CAS) → deliver → delivered | pending+backoff | dead.
// Nothing is dropped silently: a failing delivery increments attempts with backoff and re-queues;
// past the cap the row settles `dead` (logged, still in the table) — never vanished.

const root = mkdtempSync(`${os.tmpdir()}/im-reply-outbox-`)
const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const projects = ProjectV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
)
const v2Session = SessionV2.layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(store),
  Layer.provide(projector),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(projects),
  Layer.orDie,
)

// A recording repo whose createMessage can be switched to failing mid-test: the simulated
// downstream outage for the retry path. Unused members die loudly (never silently succeed).
const createdMessages: Array<{ groupID: string; senderID: string; content: string; metadata: unknown }> = []
let deliveriesFail = false
const repo: IMRepositoryInterface = {
  listGroups: () => Effect.die("unused"),
  createGroup: () => Effect.die("unused"),
  createDirectGroup: () => Effect.die("unused"),
  getGroup: () => Effect.die("unused"),
  addMember: () => Effect.die("unused"),
  listMessages: () => Effect.die("unused"),
  listThread: () => Effect.die("unused"),
  searchMessages: () => Effect.die("unused"),
  createMessage: (input) =>
    deliveriesFail
      ? Effect.fail(new IMRepositoryError({ message: "simulated delivery outage" }))
      : Effect.sync(() => {
          createdMessages.push({
            groupID: input.groupID,
            senderID: input.senderID,
            content: input.content,
            metadata: input.metadata ?? null,
          })
          return IMMessage.make({
            id: `im_created_${createdMessages.length}`,
            groupID: input.groupID,
            senderID: input.senderID,
            senderType: input.senderType,
            type: input.type,
            content: input.content,
            mentions: input.mentions ?? [],
            metadata: input.metadata ?? null,
            replyToID: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            deletedAt: null,
          })
        }),
  getMessage: () => Effect.die("unused"),
  markRead: () => Effect.die("unused"),
  createAttachment: () => Effect.die("unused"),
  getAttachment: () => Effect.die("unused"),
  listAttachments: () => Effect.die("unused"),
}
const broadcasts: Array<{ groupID: string; type: string }> = []
const broadcaster = {
  broadcast: (groupID: string, event: { type: string }) => broadcasts.push({ groupID, type: event.type }),
  sendToUser: () => {},
  register: () => true,
  unregister: () => {},
  getConnectionCount: () => 0,
  getUserConnectionCount: () => 0,
}

const it = testEffect(
  Layer.mergeAll(
    database,
    events,
    projector,
    store,
    projects,
    v2Session,
    Layer.succeed(IMRepository, repo),
    Layer.sync(IMBroadcasterService, () => broadcaster),
  ),
)

const outboxRow = (id: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(IMReplyOutbox.IMReplyOutboxTable)
      .where(eq(IMReplyOutbox.IMReplyOutboxTable.id, id))
      .get()
      .pipe(Effect.orDie)
  })

const baseAppend = {
  sessionID: "ses_im_outbox_1",
  groupID: "grp_outbox",
  agentID: "auto",
  replyMessageID: "msg_reply_1",
  replyText: "the terminal reply",
}

describe("IMReplyOutbox append/claim/settle", () => {
  it.effect("append is idempotent per (session, reply) — re-collection never double-writes", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const id = IMReplyOutbox.replyOutboxID(baseAppend.sessionID, baseAppend.replyMessageID)
      expect(yield* IMReplyOutbox.appendReply(db, { ...baseAppend, now: 1_000 })).toBe(true)
      expect(yield* IMReplyOutbox.appendReply(db, { ...baseAppend, now: 2_000 })).toBe(false)

      const rows = yield* db.select().from(IMReplyOutbox.IMReplyOutboxTable).all().pipe(Effect.orDie)
      expect(rows.length).toBe(1)
      expect(rows[0]?.id).toBe(id)
      expect(rows[0]?.status).toBe("pending")
    }),
  )

  it.effect("a failed delivery retries with backoff and is never dropped; recovery delivers exactly once", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const id = IMReplyOutbox.replyOutboxID(baseAppend.sessionID, baseAppend.replyMessageID)
      yield* IMReplyOutbox.appendReply(db, { ...baseAppend, now: 0 })

      // Outage: the delivery write fails — attempts increment, status returns to pending with a
      // backed-off available_at, and the row is not claimable again before the backoff elapses.
      deliveriesFail = true
      for (let attempt = 1; attempt <= 3; attempt++) {
        const before = yield* outboxRow(id)
        yield* IMReplyOutbox.drainPass({ db, repo, broadcaster }, { now: before!.available_at })
        const after = yield* outboxRow(id)
        expect(after?.status).toBe("pending")
        expect(after?.attempts).toBe(attempt)
        expect(after?.last_error).toBe("simulated delivery outage")
        expect(after?.available_at).toBeGreaterThan(before!.available_at)
      }

      // The backed-off row is not claimable before available_at…
      const pending = yield* outboxRow(id)
      expect(
        yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "early", now: pending!.available_at - 1 }),
      ).toBeUndefined()

      // …then the outage heals and the next due pass delivers exactly once.
      deliveriesFail = false
      yield* IMReplyOutbox.drainPass({ db, repo, broadcaster }, { now: pending!.available_at })
      const delivered = yield* outboxRow(id)
      expect(delivered?.status).toBe("delivered")
      expect(delivered?.time_delivered).toBe(pending!.available_at)
      expect(createdMessages).toEqual([
        {
          groupID: baseAppend.groupID,
          senderID: baseAppend.agentID,
          content: baseAppend.replyText,
          metadata: { type: "agent_run", sessionID: baseAppend.sessionID, status: "success" },
        },
      ])
      expect(broadcasts.at(-1)).toEqual({ groupID: baseAppend.groupID, type: "message_created" })

      // A settled row is never re-claimed.
      expect(
        yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "late", now: delivered!.available_at + 10_000 }),
      ).toBeUndefined()
    }),
  )

  it.effect("past the attempt cap the row settles dead — visible in the table, never vanished", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const input = { ...baseAppend, sessionID: "ses_im_outbox_dead", replyMessageID: "msg_reply_dead" }
      const id = IMReplyOutbox.replyOutboxID(input.sessionID, input.replyMessageID)
      yield* IMReplyOutbox.appendReply(db, { ...input, now: 0 })

      deliveriesFail = true
      let now = 0
      for (let attempt = 1; attempt <= IMReplyOutbox.IM_REPLY_MAX_ATTEMPTS; attempt++) {
        const before = yield* outboxRow(id)
        now = before!.available_at
        yield* IMReplyOutbox.drainPass({ db, repo, broadcaster }, { now })
      }

      const dead = yield* outboxRow(id)
      expect(dead?.status).toBe("dead")
      expect(dead?.attempts).toBe(IMReplyOutbox.IM_REPLY_MAX_ATTEMPTS)
      // Dead is terminal: the drain never picks it up again.
      expect(
        yield* IMReplyOutbox.claimDueReply(db, {
          ownerToken: "post-mortem",
          now: now + 10 * IMReplyOutbox.IM_REPLY_BACKOFF_CAP_MS,
        }),
      ).toBeUndefined()
    }),
  )

  it.effect("a crashed deliverer's lease lapses and the row is reclaimable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const input = { ...baseAppend, sessionID: "ses_im_outbox_lease", replyMessageID: "msg_reply_lease" }
      const id = IMReplyOutbox.replyOutboxID(input.sessionID, input.replyMessageID)
      yield* IMReplyOutbox.appendReply(db, { ...input, now: 0 })

      const first = yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "crashed", now: 0, leaseMs: 1_000 })
      expect(first?.id).toBe(id)
      // Live lease: another owner cannot claim.
      expect(yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "other", now: 500 })).toBeUndefined()
      // Lapsed lease: reclaimable (crash recovery).
      const reclaimed = yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "other", now: 1_500 })
      expect(reclaimed?.id).toBe(id)
      expect(reclaimed?.attempts).toBe(2)
      // The stale owner's settle is CAS-fenced out.
      expect(yield* IMReplyOutbox.markDelivered(db, { item: first!, ownerToken: "crashed", now: 2_000 })).toBe(false)
      expect((yield* outboxRow(id))?.status).toBe("delivering")
    }),
  )
})

// ── Collection: the settled session's terminal assistant reply lands in the outbox ────────────────

const zero = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

describe("IMReplyOutbox.collectSessionReply", () => {
  it.effect("appends the terminal assistant reply of a projected IM session; re-collection is a no-op", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_im_collect_1")
      yield* session.create({
        id: sessionID,
        title: "IM collect",
        metadata: { im: { groupID: "grp_collect", agent: "auto" } },
        location: { directory: AbsolutePath.make(root) },
      })

      // Project a realistic settled conversation through the REAL event pipeline: one user prompt
      // in, one assistant text reply out — exactly the terminal shape the collector reads.
      const publisher = yield* EventV2.Service
      const assistantID = SessionMessage.ID.make("msg_collect_reply")
      yield* publisher.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_collect_trigger"),
        prompt: new Prompt({ text: "the triggering mention" }),
        delivery: "steer",
        timestamp: zero,
      })
      yield* publisher.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: assistantID,
        agent: "auto",
        model,
      })
      yield* publisher.publish(SessionEvent.Text.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: assistantID,
        textID: "txt_collect_1",
      })
      yield* publisher.publish(SessionEvent.Text.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: assistantID,
        textID: "txt_collect_1",
        text: "the projected terminal reply",
      })

      expect(yield* IMReplyOutbox.collectSessionReply({ db, v2Session: session }, sessionID, 10_000)).toBe(true)
      const row = yield* outboxRow(IMReplyOutbox.replyOutboxID(sessionID, assistantID))
      expect(row?.reply_text).toBe("the projected terminal reply")
      expect(row?.group_id).toBe("grp_collect")
      expect(row?.trigger_message_id).toBe("msg_collect_trigger")

      // Re-collection (the periodic reconcile) is a no-op.
      expect(yield* IMReplyOutbox.collectSessionReply({ db, v2Session: session }, sessionID, 11_000)).toBe(false)
    }),
  )

  it.effect("skips non-IM sessions", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_collect_not_im")
      yield* session.create({
        id: sessionID,
        title: "regular",
        location: { directory: AbsolutePath.make(root) },
      })
      expect(yield* IMReplyOutbox.collectSessionReply({ db, v2Session: session }, sessionID, 10_000)).toBe(false)
    }),
  )
})
