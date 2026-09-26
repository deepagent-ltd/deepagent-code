import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { EventV2 } from "@deepagent-code/core/event"
import type { EventTypeRegistration } from "@deepagent-code/core/deepagent/event-registry"
import { createRuntimeFeatureRegistry } from "@deepagent-code/core/flag/runtime-features"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { V2OutboxWriter } from "../../src/event/v2-outbox-writer"
import { DeepAgentEventOutboxTable } from "@deepagent-code/core/deepagent/event-outbox-sql"
import { EventTable } from "@deepagent-code/core/event/sql"
import { GlobalBus } from "../../src/bus/global"

// W5 ① — 运行时写入器: the EventV2 publish surface (EventV2Bridge) lands C5-registered publishes into
// `deepagent_event_outbox` (V2OutboxWriter) IN THE SAME TRANSACTION as the EventV2 event row (design
// §8.3 — design.md: 禁止状态提交后 best-effort publish). Verifies:
//   1. PUBLISH → ROW, SAME TX: a registered EventV2 publish writes exactly one outbox row (envelope +
//      digest + deterministic idempotency key) committed with the event row — the C5 outbox ledger is
//      production-written and there is NO window where the event row exists without its outbox row.
//   2. EXACT-RETRY FENCE: re-publishing the SAME event id is an EventV2 exact retry (no re-projection,
//      no re-notify) AND the commit hook re-runs `already_landed` (UNIQUE idempotency-key fence) — still
//      one outbox row, one event row, one downstream mirror emission.
//   3. LANDING FAILURE = TRANSACTION FAILURE: a landing failure (registry/contract mismatch with the C5
//      registration) rolls back the whole publish — no event row without its outbox row.
//   4. FAIL-CLOSED: an UNREGISTERED type publishes normally but lands nothing (the outbox refuses
//      arbitrary self-authorizing types, design §8.8 — no silent outbox entry).

type Db = Database.Interface["db"]

// A sync EventV2 definition (the exact-retry path needs durable identity + exact retry).
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

/** A registration whose kind/schema policy the outbox rejects (producer kind mismatch) — the landing
 * failure that must roll back the publish (fail-closed). */
const brokenRegistration: EventTypeRegistration = {
  ...testRegistration,
  allowedProducerKinds: ["user"],
}

// The bridge's GlobalBus mirror runs only while the V2 admission switch is OFF (its owner is the
// durable V2 consumer). The outbox landing is independent of the switch — keep the mirror live so
// the "effect ran once" assertion counts something real. `RuntimeFeatures` is an immutable
// process-start snapshot, so OFF is injected through the bridge's registry seam — flipping
// process.env after the snapshot is intentionally unobservable.
const admissionOff = createRuntimeFeatureRegistry(undefined, {
  DEEPAGENT_CODE_EVENT_V2_ADMISSION: "false",
})

/** Build EventV2 + the SAME Database + the bridge over it, so the test can read the outbox from the
 * exact db the landing wrote to. */
const runWith = <A>(
  body: (db: Db, bridge: EventV2Bridge.Service["Service"]) => Effect.Effect<A, unknown>,
  registry = V2OutboxWriter.EVENT_V2_OUTBOX_REGISTRY.register(testRegistration),
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = Database.layerFromPath(":memory:")
      const ctx = yield* Layer.build(
        Layer.provideMerge(
          Layer.provideMerge(EventV2Bridge.layerWithRegistry(registry, admissionOff), EventV2.layer),
          database,
        ),
      )
      const db = Context.get(ctx, Database.Service).db
      const bridge = Context.get(ctx, EventV2Bridge.Service)
      return yield* body(db, bridge)
    }).pipe(Effect.scoped),
  )

describe("W5 outbox writer — EventV2 publish lands in deepagent_event_outbox", () => {
  test("publish → exactly one outbox row (idempotency-keyed, digest-bound, same transaction)", () =>
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
        // The durable EventV2 row is there too (the commit hook ran INSIDE the publish transaction —
        // event row ⇒ outbox row, atomically).
        const eventRow = yield* db.select().from(EventTable).where(eq(EventTable.id, published.id)).get()
        expect(eventRow?.id).toBe(published.id)
      }),
    ))

  test("exact retry (publish again with the same id) → commit hook re-runs already_landed → NO duplicate effect", () =>
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

          // Re-publish the SAME event id + payload ("crash at the caller window" recovery): the commit
          // hook re-runs for the already-stored event and `land` returns `already_landed` — one row.
          const replay = yield* bridge.publish(
            TestEvent,
            { sessionID: "ses_w5_replay", value: "v2" },
            {
              id: first.id,
              idempotent: true,
            },
          )
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
          const eventRows = yield* db.select().from(EventTable).where(eq(EventTable.id, first.id)).all()
          expect(eventRows.length).toBe(1)
        } finally {
          GlobalBus.off("event", mirrorListener)
        }
      }),
    ))

  test("F1 landing failure = transaction failure: no event row survives (no missing-row window)", () =>
    runWith(
      (db, bridge) =>
        Effect.gen(function* () {
          // A registration whose producer policy the envelope violates: the commit hook's `land` fails
          // the registry validation → the whole publish transaction ROLLS BACK (fail-closed, design §8.3).
          const checked = yield* bridge.publishChecked(TestEvent, { sessionID: "ses_w5_fail", value: "v3" })
            .pipe(Effect.catch(Effect.succeed))
          expect(checked).toBeInstanceOf(EventV2.CommitHookError)
          if (checked instanceof EventV2.CommitHookError) {
            expect(checked.eventType).toBe(TestEvent.type)
            expect(checked.message).toContain("producer")
          }
          // The old public channel remains compatible: the same hook error is still a defect.
          const outcome = yield* bridge.publish(TestEvent, { sessionID: "ses_w5_fail_legacy", value: "v3" }).pipe(Effect.exit)
          expect(Exit.isFailure(outcome)).toBe(true)
          // NO durable event row and NO outbox row — the landing window is closed.
          const eventRows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, "ses_w5_fail")).all()
          expect(eventRows.length).toBe(0)
          const outboxRows = yield* db.select().from(DeepAgentEventOutboxTable).all()
          expect(outboxRows.length).toBe(0)
        }),
      V2OutboxWriter.EVENT_V2_OUTBOX_REGISTRY.register(brokenRegistration),
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
        // …then land the SAME identity again (exact-retry commit-hook rerun) → fenced, no second row.
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

  test("a caller's own commit hook COMPOSES with the outbox landing (never replaced)", () =>
    runWith((db, bridge) =>
      Effect.gen(function* () {
        const seqs: number[] = []
        // The fork-delivery cursor is exactly this shape: the caller commits its own local projection IN
        // the same transaction as the event. The bridge must run BOTH hooks (existing caller hook first,
        // then the outbox landing) — the F1 seam regression the fork tests lock.
        const published = yield* bridge.publish(
          TestEvent,
          { sessionID: "ses_w5_compose", value: "v5" },
          { commit: (seq) => Effect.sync(() => seqs.push(seq)) },
        )
        expect(seqs).toEqual([0])
        const landed = yield* V2OutboxWriter.forEvent(db, published.id)
        expect(landed).toBeDefined()
      }),
    ))

  test("replay driver (F1): a replayed commit lands its outbox row in-transaction under the same idempotency key", () =>
    runWith((db, bridge) =>
      Effect.gen(function* () {
        // A serialized event as sync/import would re-commit it into this DB (a session imported from
        // another device, sync). The bridge threads an in-transaction `onCommit` into `replayAll`, so
        // the C5 outbox row lands with the replayed event row (design §8.3, no best-effort-after path).
        const serialized: EventV2.SerializedEvent = {
          id: EventV2.ID.create(),
          type: EventV2.versionedType("w5.outbox.test.event", 1),
          seq: 0,
          aggregateID: "ses_w5_imported",
          data: { sessionID: "ses_w5_imported", value: "imported" },
        }
        yield* bridge.replayAll([serialized])
        const landed = yield* V2OutboxWriter.forEvent(db, serialized.id)
        expect(landed).toBeDefined()
        if (!landed) return
        expect(landed.idempotencyKey).toBe(`eventv2:${serialized.id}`)
        // Re-replay of the same identity: the exact replay is a commit hook re-run → already_landed,
        // still ONE outbox row (and one event row).
        yield* bridge.replayAll([serialized])
        const rows = yield* db
          .select()
          .from(DeepAgentEventOutboxTable)
          .where(eq(DeepAgentEventOutboxTable.idempotency_key, `eventv2:${serialized.id}`))
          .all()
        expect(rows.length).toBe(1)
      }),
    ))

  test("exact replay repairs a historical event whose C5 outbox row is missing", () =>
    runWith((db, bridge) =>
      Effect.gen(function* () {
        const event = yield* bridge.publish(TestEvent, { sessionID: "ses_w5_historical", value: "historical" })
        const serialized: EventV2.SerializedEvent = {
          id: event.id,
          type: EventV2.versionedType(TestEvent.type, 1),
          seq: event.seq!,
          aggregateID: "ses_w5_historical",
          data: event.data,
        }
        yield* db.delete(DeepAgentEventOutboxTable).where(eq(DeepAgentEventOutboxTable.idempotency_key, `eventv2:${event.id}`)).run()
        expect(yield* V2OutboxWriter.forEvent(db, event.id)).toBeUndefined()

        const hooks: number[] = []
        yield* bridge.replayAllChecked([serialized], { onCommit: (seq) => Effect.sync(() => hooks.push(seq)) })
        expect(hooks).toEqual([event.seq!])
        expect(yield* V2OutboxWriter.forEvent(db, event.id)).toBeDefined()
        expect((yield* db.select().from(EventTable).where(eq(EventTable.id, event.id)).all()).length).toBe(1)
      }),
    ))

  test("F7 scoped registry 同库: the bridge + EventV2 + Database share ONE Database", async () => {
    // Database.defaultLayer resolves the on-disk path from Global; isolate the test home so the real
    // user data dir is never touched (and clean it up after). This composes the SAME wiring as
    // EventV2Bridge production composition (which uses Layer.provide — its provided layers' outputs are not part
    // of the built context, so the test merges the outputs to OBSERVE the single shared Database; the
    // layer objects are identical, so one Database.defaultLayer instance is memoized in both graphs).
    const home = mkdtempSync(join(tmpdir(), "dsh-eventv2-default-"))
    const wasHome = process.env.DEEPAGENT_CODE_TEST_HOME
    process.env.DEEPAGENT_CODE_TEST_HOME = home
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const graph = EventV2Bridge.layerWithRegistry(
            V2OutboxWriter.EVENT_V2_OUTBOX_REGISTRY.register(testRegistration),
          ).pipe(
            Layer.provideMerge(EventV2.defaultLayer),
            Layer.provideMerge(Database.defaultLayer),
            Layer.provideMerge(Global.defaultLayer),
          )
          const ctx = yield* Layer.build(graph)
          const db = Context.get(ctx, Database.Service).db
          const bridge = Context.get(ctx, EventV2Bridge.Service)
          const published = yield* bridge.publish(TestEvent, { sessionID: "ses_w5_default", value: "v4" })
          // The outbox row and the event row live in the ONE Database the layer graph shared — the
          // in-transaction commit hook landed into the SAME db the event row committed to.
          const landed = yield* V2OutboxWriter.forEvent(db, published.id)
          expect(landed).toBeDefined()
          const eventRow = yield* db.select().from(EventTable).where(eq(EventTable.id, published.id)).get()
          expect(eventRow?.id).toBe(published.id)
        }).pipe(Effect.scoped),
      )
    } finally {
      if (wasHome === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
      else process.env.DEEPAGENT_CODE_TEST_HOME = wasHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
