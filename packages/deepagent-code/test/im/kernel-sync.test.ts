import { expect } from "bun:test"
import { Effect, SubscriptionRef } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { bodies, cases, ready, wait, type State } from "./fixture/kernel-sync-current"

const pending = (state: State) =>
  state.lease.reader.pending({ conversationType: 1, conversationID: "sender", name: "Sender" })
const create = (state: State, content: string) =>
  Effect.gen(function* () {
    const groupID = yield* pending(state)
    const message = yield* state.lease.engine.createMessage({
      groupID,
      clientRequestID: "original-sync-request",
      senderID: "server",
      senderType: "user",
      type: "text",
      content,
    })
    return { groupID, message }
  })

// Each case owns a real SDK process, HTTPS/DPoP peer, captured Instance and file DB.
// Reader cursors replace retired timestamp mirrors; delivery receipts own ACKs.
cases(import.meta.path, [
  {
    id: "inbound-land",
    name: "scoped protected traffic lands, broadcasts reader_changed and advances its delivery cursor",
    run: (state) =>
      Effect.gen(function* () {
        const message = state.remote.add(1, "sender", "landed")
        yield* ready(state)
        const rows = yield* bodies(state)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          message_id: "landed",
          sender_id: "sender",
          content: message.content,
          message_time: message.messageTime,
        })
        expect(state.broadcasts).toContainEqual({ groupID: rows[0]!.local_group_id, type: "reader_changed" })
        expect((yield* KernelReader.scope(state.lease.reader.runtime))?.completed_after).toBe(
          String(state.remote.state.revision),
        )
        expect(
          (yield* KernelReader.projection(state.lease.reader.runtime, state.remote.conversation(1, "sender").key))
            ?.newer_after,
        ).toBe("1")
        expect(
          yield* state.database.db.get(sql`SELECT count(*) n FROM im_messages WHERE kernel_msg_id IS NOT NULL`),
        ).toEqual({ n: 0 })
      }),
  },
  {
    id: "inbound-dedup",
    name: "at-least-once protected pages keep immutable message identity while later delivery cursors progress",
    run: (state) =>
      Effect.gen(function* () {
        state.remote.add(1, "sender", "dedup-original")
        yield* ready(state)
        const first = yield* bodies(state)
        const projection = state.remote.conversation(1, "sender")
        const page = yield* state.client.getDeliveryMessages({
          version: 2,
          scopeKey: "a".repeat(64),
          projectionKey: projection.key,
          projectionRevision: String(state.remote.state.revision),
          direction: "older",
          limit: 32,
        })
        yield* KernelReader.applyMessages(state.lease.reader.runtime, page)
        expect(yield* bodies(state)).toEqual(first)
        state.remote.add(1, "sender", "dedup-next")
        yield* ready(state)
        expect((yield* bodies(state)).find((row) => row.message_id === "dedup-original")).toEqual(first[0])
        expect(yield* bodies(state)).toHaveLength(2)
        expect((yield* KernelReader.projection(state.lease.reader.runtime, projection.key))?.newer_after).toBe("2")
      }),
  },
  {
    id: "inbound-legacy-skip",
    name: "retired own-echo, unbound and system streams cannot write; authenticated scoped traffic still lands",
    run: (state) =>
      Effect.gen(function* () {
        yield* state.sync.catchUp
        state.remote.add(1, "sender", "protected-real")
        yield* ready(state)
        expect((yield* bodies(state)).map((row) => row.message_id)).toEqual(["protected-real"])
        expect(state.legacy.reads).toBe(0)
        expect(yield* state.database.db.get(sql`SELECT count(*) n FROM im_messages`)).toEqual({ n: 1 })
        expect(
          yield* state.database.db.get(
            sql`SELECT count(*) n FROM im_messages WHERE kernel_msg_id IN ('legacy-own','legacy-unbound','legacy-system')`,
          ),
        ).toEqual({ n: 0 })
      }),
  },
  {
    id: "inbound-reconnect",
    name: "a real SDK reconnect catches up protected history without replaying global mirrors",
    run: (state) =>
      Effect.gen(function* () {
        const original = state.client.captureCurrentLink?.()
        const connections = state.remote.state.connections
        state.native.disconnect()
        state.remote.add(1, "sender", "reconnect-history")
        yield* wait(
          SubscriptionRef.get(state.client.state).pipe(
            Effect.map((value) =>
              value === "connected" && state.remote.state.connections > connections ? true : undefined,
            ),
          ),
        )
        expect(state.client.captureCurrentLink?.()).not.toBe(original)
        yield* ready(state)
        expect((yield* bodies(state)).map((row) => row.message_id)).toEqual(["reconnect-history"])
        expect((yield* KernelReader.scope(state.lease.reader.runtime))?.completed_after).toBe(
          String(state.remote.state.revision),
        )
      }),
  },
  {
    id: "history-paging",
    name: "more than 20 messages and saturated timestamps recover through bounded overlapping V2 pages",
    run: (state) =>
      Effect.gen(function* () {
        const timestamp = Date.now()
        for (const index of Array.from({ length: 255 }, (_, index) => index))
          state.remote.add(1, "sender", `history-${index}`, { time: timestamp })
        yield* ready(state)
        const rows = yield* bodies(state)
        expect(rows).toHaveLength(255)
        expect(new Set(rows.map((row) => row.message_id)).size).toBe(255)
        expect(new Set(rows.map((row) => row.local_message_id)).size).toBe(255)
        const pages = state.remote.queries.filter((query) => query.topic === "qry_delivery_messages")
        expect(pages.length).toBeGreaterThan(1)
        expect(pages.every((query) => query.request.limit === 32)).toBe(true)
        expect(pages.some((query) => query.request.anchorDeliveryCursor)).toBe(true)
        const projection = yield* KernelReader.projection(
          state.lease.reader.runtime,
          state.remote.conversation(1, "sender").key,
        )
        expect(projection).toMatchObject({ newer_after: "255", history_complete: 1 })
        yield* ready(state)
        expect(yield* bodies(state)).toEqual(rows)
      }),
  },
  {
    id: "history-cold-checkpoint",
    name: "a failed later page preserves its physical checkpoint and a new Instance resumes without skipping older traffic",
    run: (state) =>
      Effect.gen(function* () {
        for (const index of Array.from({ length: 225 }, (_, index) => index))
          state.remote.add(1, "sender", `checkpoint-${index}`)
        state.remote.add(1, "sender", "future-wall-clock", { time: Date.now() + 1000 })
        state.remote.state.malformedAfter = "32"
        yield* state.lease.engine.catchUp
        expect((yield* SubscriptionRef.get(state.lease.reader.state)).state).toBe("unavailable")
        const before = yield* bodies(state)
        expect(before).toHaveLength(32)
        const key = state.remote.conversation(1, "sender").key
        expect((yield* KernelReader.projection(state.lease.reader.runtime, key))?.newer_after).toBe("32")
        const originalFile = yield* Effect.promise(() => fs.stat(path.join(state.directory, "current.sqlite")))
        state.remote.state.malformedAfter = ""
        const start = state.remote.queries.length
        const lease = yield* state.reopen
        expect(lease.reader).not.toBe(state.lease.reader)
        const reopenedFile = yield* Effect.promise(() => fs.stat(path.join(state.directory, "current.sqlite")))
        expect({ dev: reopenedFile.dev, ino: reopenedFile.ino }).toEqual({
          dev: originalFile.dev,
          ino: originalFile.ino,
        })
        yield* ready({ lease })
        const after = yield* bodies(state)
        expect(after).toHaveLength(226)
        expect(
          before.every((row) =>
            after.some(
              (current) =>
                current.message_id === row.message_id &&
                current.immutable_hash === row.immutable_hash &&
                current.local_message_id === row.local_message_id,
            ),
          ),
        ).toBe(true)
        expect(
          state.remote.queries
            .slice(start)
            .some((query) => query.topic === "qry_delivery_messages" && query.request.anchorDeliveryCursor === "32"),
        ).toBe(true)
        expect((yield* KernelReader.projection(lease.reader.runtime, key))?.newer_after).toBe("226")
      }),
  },
  {
    id: "history-nonprogress",
    name: "nonprogressing protected pages are bounded and never skip the original completed cursor",
    run: (state) =>
      Effect.gen(function* () {
        const before = yield* KernelReader.scope(state.lease.reader.runtime)
        state.remote.state.nonprogressing = true
        state.remote.add(1, "sender", "stalled-boundary")
        const start = state.remote.queries.length
        yield* state.lease.engine.catchUp
        expect((yield* SubscriptionRef.get(state.lease.reader.state)).state).not.toBe("ready")
        expect((yield* KernelReader.scope(state.lease.reader.runtime))?.completed_after).toBe(before?.completed_after)
        expect(state.remote.queries.length - start).toBeGreaterThan(1)
        expect(state.remote.queries.length - start).toBeLessThanOrEqual(128)
        expect(yield* bodies(state)).toEqual([])
      }),
  },
  {
    id: "outbound-ack",
    name: "an original protected SDK send records its ACK on the durable delivery identity",
    run: (state) =>
      Effect.gen(function* () {
        const { groupID, message } = yield* create(state, "hi sender")
        yield* state.lease.engine.send({ groupID, messageID: message.id, content: message.content })
        const status = yield* wait(
          state.lease.engine
            .deliveryStatus(message.id)
            .pipe(Effect.map((status) => (status.state === "acknowledged" ? status : undefined))),
        )
        expect(status).toMatchObject({ messageID: message.id, state: "acknowledged", kernelMessageID: "ack-1" })
        expect(state.remote.sent).toHaveLength(1)
        const receipt = yield* KernelDelivery.read(state.database.db, message.id)
        expect(receipt?.binding).toMatchObject({ messageID: message.id, conversationID: "sender", conversationType: 1 })
        expect(state.remote.sent[0]).toMatchObject({
          target: "sender",
          text: "hi sender",
          clientID: receipt?.binding.wireID,
          expiresAt: receipt?.binding.expiresAt,
        })
        expect(yield* state.database.db.get(sql`SELECT kernel_msg_id FROM im_messages WHERE id=${message.id}`)).toEqual(
          { kernel_msg_id: null },
        )
      }),
  },
  {
    id: "outbound-local",
    name: "an ordinary group without a kernel binding never reaches protected send or creates a delivery receipt",
    run: (state) =>
      Effect.gen(function* () {
        const group = yield* state.repo.createGroup({
          workspaceID: state.lease.workspaceID,
          type: "project",
          name: "local",
          createdBy: "server",
        })
        const message = yield* state.repo.createMessage({
          groupID: group.id,
          senderID: "server",
          senderType: "user",
          type: "text",
          content: "local only",
        })
        yield* state.lease.engine.send({ groupID: group.id, messageID: message.id, content: message.content })
        yield* state.lease.engine.drainPending
        expect(state.remote.sent).toHaveLength(0)
        expect(yield* KernelDelivery.read(state.database.db, message.id)).toBeUndefined()
        expect((yield* state.repo.getMessage(message.id))?.content).toBe("local only")
      }),
  },
  {
    id: "outbound-unknown-reconnect",
    name: "a dispatched SDK failure remains unknown after a real reconnect and is never sent again",
    run: (state) =>
      Effect.gen(function* () {
        state.remote.state.mode = "reject"
        const { groupID, message } = yield* create(state, "unknown original")
        yield* state.lease.engine.send({ groupID, messageID: message.id, content: message.content })
        // Public status also reports an in-flight dispatched row as unknown.
        // Observe the real settled receipt before closing its original socket.
        yield* wait(
          KernelDelivery.read(state.database.db, message.id).pipe(
            Effect.map((value) => (value?.state === "unknown" ? value : undefined)),
          ),
        )
        const before = yield* state.lease.engine.deliveryStatus(message.id)
        expect(state.remote.sent).toHaveLength(1)
        state.remote.state.mode = "ack"
        const connections = state.remote.state.connections
        state.native.disconnect()
        yield* wait(
          SubscriptionRef.get(state.client.state).pipe(
            Effect.map((value) =>
              value === "connected" && state.remote.state.connections > connections ? true : undefined,
            ),
          ),
        )
        yield* ready(state)
        yield* state.lease.engine.drainPending
        expect(yield* state.lease.engine.deliveryStatus(message.id)).toEqual(before)
        expect(state.remote.sent).toHaveLength(1)
      }),
  },
  {
    id: "outbound-one-attempt",
    name: "same-ID retries and repeated durable drains consume exactly one original send attempt",
    run: (state) =>
      Effect.gen(function* () {
        state.remote.state.mode = "reject"
        const { groupID, message } = yield* create(state, "single original attempt")
        yield* state.lease.engine.drainPending
        expect(yield* state.lease.engine.deliveryStatus(message.id)).toMatchObject({
          state: "unknown",
          kernelMessageID: null,
        })
        for (const pass of Array.from({ length: 12 }, (_, index) => index)) {
          const retry = yield* state.lease.engine.createMessage({
            groupID,
            clientRequestID: "original-sync-request",
            senderID: "server",
            senderType: "user",
            type: "text",
            content: message.content,
          })
          expect(retry.id).toBe(message.id)
          yield* state.lease.engine.drainPending
          expect(state.remote.sent.length, `pass ${pass}`).toBe(1)
        }
        expect(yield* state.database.db.get(sql`SELECT count(*) n FROM im_messages WHERE id=${message.id}`)).toEqual({
          n: 1,
        })
        expect(
          yield* state.database.db.get(sql`SELECT count(*) n FROM im_kernel_delivery WHERE message_id=${message.id}`),
        ).toEqual({ n: 1 })
      }),
  },
])
