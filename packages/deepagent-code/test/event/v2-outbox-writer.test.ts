import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import type { EventTypeRegistration } from "@deepagent-code/core/deepagent/event-registry"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { V2OutboxWriter } from "../../src/event/v2-outbox-writer"
import { DeepAgentEventOutboxTable } from "@deepagent-code/core/deepagent/event-outbox-sql"
import { EventTable } from "@deepagent-code/core/event/sql"
import { GlobalBus } from "../../src/bus/global"

// W5 ① — 运行时写入器: the EventV2 publish surface (EventV2Bridge) lands C5-registered publishes into
// `deepagent_event_outbox` (V2OutboxWriter). Verifies:
//   1. PUBLISH → ROW: a registered EventV2 publish writes exactly one outbox row (envelope + digest +
//      deterministic idempotency key) — the C5 outbox ledger is production-written.
//   2. CRASH-WINDOW REPLAY → 不重复效果: after the durable commit, replaying the SAME event id is an
//      EventV2 exact retry (no re-projection, no re-notify) AND the outbox land returns
//      `already_landed` (UNIQUE idempotency-key fence) — still one outbox row, one event row, one
//      downstream mirror emission.
//   3. FAIL-CLOSED: an UNREGISTERED type publishes normally but lands nothing (the outbox refuses
//      arbitrary self-authorizing types, design §8.8 — no silent outbox entry).

type Db = Database.Interface["db"]

// A sync EventV2 definition (the crash-window replay path needs durable identity + exact retry).
const TestEvent = EventV2.define({
  type: "w5.outbox.test.event",
  sync: { version: 1, aggregate: "sessionID" },
  schema: { sessionID: Schema.String, value: Schema.String },
})

const testRegistration: EventTypeRegistration = {
  eventType: "w5.outbox.test.event",
  kind: "fact" as const,
  schemaId: "w5.outbox.test.event.schema",
  schemaVersion: "1",
  payloadContentType: "application/json",
  payloadVersion: "v1",
  allowedProducerKinds: ["eventv2"],
  allowedSourceKinds: ["system"],
  causation: { allowed: [], requiresCause: false },
  risk: "low",
  objective: "record the w5 outbox test fact",
  requestedCapability: "deepagent.session.observe",
  autonomyCeiling: "low",
}

const saved = process.env.DEEPAGENT_CODE_EVENT_V2_ADMISSION

beforeAll(() => {
  // The bridge's GlobalBus mirror runs only while the V2 admission switch is OFF (its owner is the
  // durable V2 consumer). The outbox landing is independent of the switch — keep the mirror live so the
  // "effect ran once" assertion counts something real.
  process.env.DEEPAGENT_CODE_EVENT_V2_ADMISSION = "false"
  V2OutboxWriter.register(testRegistration)
})
afterAll(() => {
  if (saved === undefined) delete process.env.DEEPAGENT_CODE_EVENT_V2_ADMISSION
  else process.env.DEEPAGENT_CODE_EVENT_V2_ADMISSION = saved
})

/** Build EventV2 + the SAME Database + the bridge over it, so the test can read the outbox from the
 * exact db the landing wrote to. */
const runWith = <A>(body: (db: Db, bridge: EventV2Bridge.Service["Service"]) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = Database.layerFromPath(":memory:")
      const ctx = yield* Layer.build(
        Layer.provideMerge(Layer.provideMerge(EventV2Bridge.layer, EventV2.layer), database),
      )
      const db = Context.get(ctx, Database.Service).db
      const bridge = Context.get(ctx, EventV2Bridge.Service)
      return yield* body(db, bridge)
    }).pipe(Effect.scoped),
  )

describe("W5 outbox writer — EventV2 publish lands in deepagent_event_outbox", () => {
  test("publish → exactly one outbox row (idempotency-keyed, digest-bound)", () =>
    runWith((db, bridge) =>
      Effect.gen(function* () {
        const published = yield* bridge.publish(TestEvent, { sessionID: "ses_w5_test", value: "v1" })
        const landed = yield* V2OutboxWriter.forEvent(db, published.id)
        expect(landed).toBeDefined()
        if (!landed) return
        expect(landed.eventId).toBe(published.id)
        expect(landed.eventType).toBe("w5.outbox.test.event")
        expect(landed.eventKind).toBe("fact")
        expect(landed.idempotencyKey).toBe(`eventv2:${published.id}`)
        expect(landed.envelopeDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(landed.envelope.eventId).toBe(published.id)
        expect(landed.envelope.payload.payloadHash).toMatch(/^[0-9a-f]{64}$/)
        // Exactly one outbox row for the identity.
        const rows = yield* db
          .select()
          .from(DeepAgentEventOutboxTable)
          .where(eq(DeepAgentEventOutboxTable.idempotency_key, `eventv2:${published.id}`))
          .all()
        expect(rows.length).toBe(1)
        // The durable EventV2 row is there too (the publish committed before the landing).
        const eventRow = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.id, published.id))
          .get()
        expect(eventRow?.id).toBe(published.id)
      }),
    ))

  test("crash-window replay (publish again after the durable commit) → NO duplicate effect", () =>
    runWith((db, bridge) =>
      Effect.gen(function* () {
        let mirrors = 0
        const mirrorListener = () => {
          mirrors++
        }
        GlobalBus.on("event", mirrorListener)
        try {
          const first = yield* bridge.publish(TestEvent, { sessionID: "ses_w5_replay", value: "v2" })
          // The post-commit effect (the mirror/listener plane) ran once: the event mirror + its sync
          // mirror emission (registered sync definition) — exactly 2 emits, both from the ONE publish.
          expect(mirrors).toBe(2)
          const landedFirst = yield* V2OutboxWriter.forEvent(db, first.id)
          expect(landedFirst).toBeDefined()

          // Replay: same event id + same payload — the "crash after publish, before the effect" recovery.
          const replay = yield* bridge.publish(TestEvent, { sessionID: "ses_w5_replay", value: "v2" }, {
            id: first.id,
            idempotent: true,
          })
          expect(replay.id).toBe(first.id)
          // The effect (mirror/notify plane) did NOT run again — EventV2 exact retry, no re-notify.
          expect(mirrors).toBe(2)
          // The outbox land is fenced by the idempotency key — still ONE row.
          const landedAgain = yield* V2OutboxWriter.forEvent(db, first.id)
          expect(landedAgain).toBeDefined()
          const rows = yield* db
            .select()
            .from(DeepAgentEventOutboxTable)
            .where(eq(DeepAgentEventOutboxTable.idempotency_key, `eventv2:${first.id}`))
            .all()
          expect(rows.length).toBe(1)
          // The durable event log has exactly one event row for the event id (no duplicate projection).
          const eventRows = yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.id, first.id))
            .all()
          expect(eventRows.length).toBe(1)
        } finally {
          GlobalBus.off("event", mirrorListener)
        }
      }),
    ))

  test("an UNREGISTERED event type publishes normally but lands NO outbox row (fail-closed registry)", () =>
    runWith((db, bridge) =>
      Effect.gen(function* () {
        const MirrorEvent = EventV2.define({
          type: "w5.outbox.unregistered",
          sync: { version: 1, aggregate: "sessionID" },
          schema: { sessionID: Schema.String },
        })
        const published = yield* bridge.publish(MirrorEvent, { sessionID: "ses_w5_unreg" })
        const landed = yield* V2OutboxWriter.forEvent(db, published.id)
        expect(landed).toBeUndefined()
      }),
    ))

  test("land() idempotency: a second land of the same event returns already_landed (single row)", () =>
    runWith((db) =>
      Effect.gen(function* () {
        // Publish once through the bridge (writes the row)…
        const published = yield* Effect.sync(() => ({
          id: EventV2.ID.create(),
          type: "w5.outbox.test.event",
          data: { sessionID: "ses_w5_land", value: "v3" },
          location: undefined,
        }))
        const first = yield* V2OutboxWriter.land(db, {
          event: published as EventV2.Payload,
          registration: testRegistration,
          now: 10,
        })
        expect(first.kind).toBe("landed")
        // …then land the SAME identity again (crash-window replay) → fenced, no second row.
        const again = yield* V2OutboxWriter.land(db, {
          event: published as EventV2.Payload,
          registration: testRegistration,
          now: 20,
        })
        expect(again.kind).toBe("already_landed")
        const rows = yield* db
          .select()
          .from(DeepAgentEventOutboxTable)
          .where(eq(DeepAgentEventOutboxTable.idempotency_key, `eventv2:${published.id}`))
          .all()
        expect(rows.length).toBe(1)
      }),
    ))
})
