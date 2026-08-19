import { afterEach, describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import {
  EventArtifactTable,
  EventSequenceTable,
  EventSyncSequenceTable,
  EventTable,
} from "@deepagent-code/core/event/sql"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LegacyEventCanonicalizerRuntime } from "@/legacy-event-canonicalizer-runtime"
import { eq, sql } from "drizzle-orm"
import { Duration, Effect, Layer } from "effect"
import { resetDatabase } from "./fixture/db"
import { disposeAllInstances } from "./fixture/fixture"
import { pollWithTimeout, testEffect } from "./lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const seedLegacyEvent = Effect.fn("Test.seedLegacyEvent")(function* () {
  const sessions = yield* Session.Service
  const { db } = yield* Database.Service
  const session = yield* sessions.create({ title: "canonicalizer schedule" })
  const messageID = MessageID.ascending()
  const patch = "你".repeat(Math.ceil((EventV2.MAX_ENCODED_PAYLOAD_BYTES + 1024) / 3))
  const message = {
    role: "user" as const,
    time: { created: Date.now() },
    agent: "build",
    summary: {
      diffs: [{ file: "src/large.ts", patch, additions: 2, deletions: 1, status: "modified" as const }],
    },
  }
  const sequence = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, session.id))
    .get()
    .pipe(Effect.orDie)
  const eventID = EventV2.ID.make(`evt_canonicalizer_${messageID}`)
  const syncSequence = yield* db
    .update(EventSyncSequenceTable)
    .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
    .where(eq(EventSyncSequenceTable.id, 1))
    .returning({ seq: EventSyncSequenceTable.seq })
    .get()
    .pipe(Effect.orDie)
  if (!syncSequence) return yield* Effect.die("sync sequence authority missing")
  // fixture-exempt: direct legacy event row insert — reproduces the pre-canonicalizer oversized
  // backlog that the durable schedule is meant to drain (no current runtime path emits v1
  // message.updated payloads above the encoded-payload budget).
  yield* db
    .insert(EventTable)
    .values({
      id: eventID,
      aggregate_id: session.id,
      seq: (sequence?.seq ?? -1) + 1,
      type: EventV2.versionedType("message.updated", 1),
      data: { sessionID: session.id, info: { ...message, id: messageID, sessionID: session.id } },
      sync_seq: syncSequence.seq,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(EventSequenceTable)
    .set({ seq: (sequence?.seq ?? -1) + 1 })
    .where(eq(EventSequenceTable.aggregate_id, session.id))
    .run()
    .pipe(Effect.orDie)
  return { session, eventID }
})

describe("legacy event canonicalizer durable schedule", () => {
  describe("with the schedule enabled", () => {
    const daemon = LegacyEventCanonicalizerRuntime.makeLayer({
      pollInterval: Duration.millis(50),
      maxEventsPerTick: 4,
    }).pipe(
      Layer.provide(EventV2.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ legacyEventCanonicalizer: true })),
    )
    const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, daemon))

    it.instance(
      "drains the legacy artifact backlog without a manual maintenance call",
      () =>
        Effect.gen(function* () {
          const input = yield* seedLegacyEvent()
          const { db } = yield* Database.Service
          const artifact = yield* pollWithTimeout(
            db
              .select()
              .from(EventArtifactTable)
              .where(eq(EventArtifactTable.event_id, input.eventID))
              .get()
              .pipe(Effect.orDie),
            "canonicalizer schedule did not produce an artifact",
            "10 seconds",
          )
          expect(artifact).toMatchObject({
            kind: "legacy_message_diff",
            codec_version: 2,
            aggregate_id: input.session.id,
            event_id: input.eventID,
          })
          // Evidence-only governance: the source event row stays intact (no deletion/VACUUM).
          const source = yield* db
            .select({ id: EventTable.id })
            .from(EventTable)
            .where(eq(EventTable.id, input.eventID))
            .get()
            .pipe(Effect.orDie)
          expect(source?.id).toBe(input.eventID)
        }),
      { git: true },
      30_000,
    )
  })

  describe("with the schedule disabled", () => {
    const daemon = LegacyEventCanonicalizerRuntime.makeLayer({ pollInterval: Duration.millis(50) }).pipe(
      Layer.provide(EventV2.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ legacyEventCanonicalizer: false })),
    )
    const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, daemon))

    it.instance(
      "leaves the backlog untouched while the flag stays off",
      () =>
        Effect.gen(function* () {
          const input = yield* seedLegacyEvent()
          const { db } = yield* Database.Service
          yield* Effect.sleep("500 millis")
          expect(
            yield* db
              .select()
              .from(EventArtifactTable)
              .where(eq(EventArtifactTable.event_id, input.eventID))
              .all()
              .pipe(Effect.orDie),
          ).toEqual([])
        }),
      { git: true },
      30_000,
    )
  })
})
