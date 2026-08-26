import { describe, expect } from "bun:test"
import { Effect, Layer, Schema, Stream } from "effect"
import { EventV2 } from "@deepagent-code/core/event"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"

// §16.4 DATA-AND-RECOVERY D-4 — response loss / partial projection oracle. The event journal is
// the durable authority; a projection consumer that loses its response mid-replay must be able to
// resume from its last durable cursor and observe EXACTLY the tail — byte-identical to a consumer
// that never lost anything. This pins that determinism plus exact-retry convergence.

const database = Database.layerFromPath(":memory:")
const eventLayer = Layer.mergeAll(EventV2.layer.pipe(Layer.provide(database)), database)
const it = testEffect(eventLayer)

const SyncPayload = EventV2.define({
  type: "oracle.sync",
  sync: { version: 1, aggregate: "sessionID" },
  schema: { sessionID: Schema.String, kind: Schema.String, body: Schema.String },
})

type SyncData = { readonly sessionID: string; readonly kind: string; readonly body: string }
const body = (row: EventV2.CursorEvent) => (row.event.data as SyncData).body

describe("response loss / partial projection oracle", () => {
  it.effect("replays the full journal in seq order with no gaps or duplicates", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      for (let i = 0; i < 5; i++)
        yield* events.publish(SyncPayload, { sessionID: aggregateID, kind: "session", body: `body-${i}` })

      // aggregateEvents drains the journal then tails live events forever; take(n) bounds the replay.
      const replayed = yield* events.aggregateEvents({ aggregateID }).pipe(Stream.take(5), Stream.runCollect)
      expect(replayed.map((row) => body(row))).toEqual(["body-0", "body-1", "body-2", "body-3", "body-4"])
      expect(new Set(replayed.map((row) => row.event.seq)).size).toBe(5)
    }))

  it.effect("resumes from a mid-journal cursor and observes exactly the tail after a simulated response loss", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      for (let i = 0; i < 5; i++)
        yield* events.publish(SyncPayload, { sessionID: aggregateID, kind: "session", body: `body-${i}` })

      // A consumer that read the first three events, then lost the response (crash) and restarts
      // from its last durable cursor must see exactly the tail — identical to the tail of a
      // full replay from scratch.
      const firstThree = yield* events.aggregateEvents({ aggregateID }).pipe(Stream.take(3), Stream.runCollect)
      const cursor = firstThree.at(-1)?.cursor

      const tailAfterLoss = yield* events.aggregateEvents({ aggregateID, after: cursor }).pipe(Stream.take(2), Stream.runCollect)
      const full = yield* events.aggregateEvents({ aggregateID }).pipe(Stream.take(5), Stream.runCollect)
      expect(tailAfterLoss.map((row) => row.event.seq)).toEqual(full.slice(3).map((row) => row.event.seq))
      expect(tailAfterLoss.map((row) => body(row))).toEqual(["body-3", "body-4"])
    }))

  it.effect("converges an exact retry of a synchronized event without duplicating journal rows", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const id = EventV2.ID.create()
      yield* events.publish(SyncPayload, { sessionID: aggregateID, kind: "session", body: "once" }, { id })
      const first = yield* events.aggregateEvents({ aggregateID }).pipe(Stream.take(1), Stream.runCollect)
      expect(first).toHaveLength(1)

      // Exact retry: same id, idempotent flag. Must converge — same row, no duplicate.
      yield* events.publish(SyncPayload, { sessionID: aggregateID, kind: "session", body: "once" }, { id, idempotent: true })
      const afterRetry = yield* events.aggregateEvents({ aggregateID }).pipe(Stream.take(1), Stream.runCollect)
      expect(afterRetry).toHaveLength(1)
      expect(afterRetry[0]?.event.id).toBe(first[0]?.event.id)
      expect(afterRetry[0]?.event.seq).toBe(first[0]?.event.seq)
    }))
})
