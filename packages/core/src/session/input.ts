export * as SessionInput from "./input"

import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { EventSequenceTable } from "../event/sql"
import { Hash } from "../util/hash"
import { NonNegativeInt } from "../schema"
import { V2Schema } from "../v2-schema"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

// V4.1: `steer` = mid-turn user input absorbed at the next turn boundary by the parent session's own
// runLoop (S1.1). `queue` = deferred user input promoted between turns. `goal_steer` (§S1.3) = guidance
// directed at a RUNNING goal, drained by the goal DRIVER between ticks and threaded into the next step
// prompt — a DISTINCT delivery dimension so the parent runLoop's `steer` drain and the goal driver's
// `goal_steer` drain read DISJOINT rows on the same session id and never contend for the same buffer.
export const Delivery = Schema.Literals(["steer", "queue", "goal_steer"])
export type Delivery = typeof Delivery.Type

export class Admitted extends Schema.Class<Admitted>("SessionInput.Admitted")({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionSchema.ID,
  prompt: Prompt,
  delivery: Delivery,
  timeCreated: V2Schema.DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(Schema.optional),
}) {}

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)

const fromRow = (row: typeof SessionInputTable.$inferSelect): Admitted =>
  new Admitted({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    prompt: decodePrompt(row.prompt),
    delivery: row.delivery,
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
  })

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    /**
     * In-transaction hook committed atomically with the PromptLifecycle.Admitted event and its
     * `session_input` projection (same contract as `EventV2.publish`'s `{ commit }` option): the
     * hook must be an idempotent write or CAS, and a failure rolls back BOTH the event and the
     * projected row. Not replayed from the serialized event log, so a hook that repairs state must
     * converge on its own.
     */
    readonly commit?: (seq: number, event: EventV2.Payload) => Effect.Effect<void, unknown>
  },
) {
  const existing = yield* find(db, input.id)
  if (existing !== undefined) return existing
  const timestamp = yield* DateTime.now
  return yield* events
    .publish(SessionEvent.PromptLifecycle.Admitted, {
      messageID: input.id,
      sessionID: input.sessionID,
      timestamp,
      prompt: input.prompt,
      delivery: input.delivery,
    }, input.commit === undefined ? undefined : { commit: input.commit })
    .pipe(
      Effect.flatMap((event) =>
        event.seq === undefined
          ? Effect.die("Prompt admission event is missing aggregate sequence")
          : Effect.succeed(
              new Admitted({
                admittedSeq: event.seq,
                id: input.id,
                sessionID: input.sessionID,
                prompt: input.prompt,
                delivery: input.delivery,
                timeCreated: timestamp,
              }),
            ),
      ),
      Effect.catchDefect((defect) =>
        find(db, input.id).pipe(Effect.flatMap((stored) => (stored ? Effect.succeed(stored) : Effect.die(defect)))),
      ),
    )
})

export const latestSeq = Effect.fn("SessionInput.latestSeq")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
  },
) {
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.admittedSeq,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (stored) return
  // Crash replay re-projects admitted events over a projection that may still hold the intact
  // admission row (durable admission survives replay). An exact duplicate is idempotent; any
  // content divergence remains a lifecycle conflict.
  const existing = yield* db
    .select()
    .from(SessionInputTable)
    .where(and(eq(SessionInputTable.id, input.id), eq(SessionInputTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  const admitted = existing ? fromRow(existing) : undefined
  if (
    !admitted ||
    admitted.admittedSeq !== input.admittedSeq ||
    admitted.delivery !== input.delivery ||
    DateTime.toEpochMillis(admitted.timeCreated) !== DateTime.toEpochMillis(input.timeCreated) ||
    !matchesPrompt(admitted, input)
  )
    return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectPromoted = Effect.fn("SessionInput.projectPromoted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!updated) {
    // Crash replay may re-project a promotion over an input that is already promoted. An exact
    // duplicate is idempotent; any divergence remains a lifecycle conflict.
    const replayed = yield* db
      .select()
      .from(SessionInputTable)
      .where(and(eq(SessionInputTable.id, input.id), eq(SessionInputTable.session_id, input.sessionID)))
      .get()
      .pipe(Effect.orDie)
    const existing = replayed ? fromRow(replayed) : undefined
    if (
      !existing ||
      existing.promotedSeq !== input.promotedSeq ||
      DateTime.toEpochMillis(existing.timeCreated) !== DateTime.toEpochMillis(input.timeCreated) ||
      !matchesPrompt(existing, input)
    )
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return toMessage(existing)
  }
  const stored = fromRow(updated)
  if (
    !matchesPrompt(stored, input) ||
    DateTime.toEpochMillis(stored.timeCreated) !== DateTime.toEpochMillis(input.timeCreated)
  )
    return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return toMessage(stored)
})

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, delivery),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
  },
) => input.delivery === expected.delivery && matchesPrompt(input, expected)

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

export const guardReservedID = Effect.fn("SessionInput.guardReservedID")(function* (
  db: DatabaseService,
  event: EventV2.Payload,
) {
  if (event.replayExact) return
  if (
    Schema.is(SessionEvent.PromptLifecycle.Admitted)(event) ||
    Schema.is(SessionEvent.PromptLifecycle.Promoted)(event)
  )
    return
  const id = reservedID(event)
  if (id === undefined) return
  const admitted = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (admitted === undefined) return
  return yield* Effect.die(new LifecycleConflict({ id }))
})

const reservedID = (event: EventV2.Payload) => {
  if (Schema.is(SessionEvent.Step.Started)(event)) return event.data.assistantMessageID
  if (Schema.is(SessionEvent.AgentSwitched)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.ModelSwitched)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Prompted)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Synthetic)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Shell.Started)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Compaction.Started)(event)) return event.data.messageID
}

export const projectLegacyPrompted = Effect.fn("SessionInput.projectLegacyPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const inserted = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.promotedSeq,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      promoted_seq: input.promotedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!inserted) return yield* Effect.die("Prompt projection conflicts with admitted input")
  return fromRow(inserted)
})

const publish = Effect.fn("SessionInput.publish")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
) {
  for (const row of rows) {
    yield* events
      .publish(SessionEvent.PromptLifecycle.Promoted, {
        sessionID,
        timestamp: yield* DateTime.now,
        messageID: SessionMessage.ID.make(row.id),
        prompt: decodePrompt(row.prompt),
        timeCreated: DateTime.makeUnsafe(row.time_created),
      })
      .pipe(
        Effect.catchDefect((defect) =>
          defect instanceof LifecycleConflict
            ? find(db, SessionMessage.ID.make(row.id)).pipe(
                Effect.flatMap((stored) => (stored?.promotedSeq === undefined ? Effect.die(defect) : Effect.void)),
              )
            : Effect.die(defect),
        ),
      )
  }
  return rows.map((row) => row.id)
})

export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return yield* publish(db, events, sessionID, rows)
})

export type PromotedInputs = readonly string[]

// W2-3 — non-consuming read of the session's FIFO `queue` inputs still awaiting promotion, in
// admit order. Mirrors promoteNextQueued's ordering; used by the TUI /queue view (and any future
// queue surface) to show what is deferred until the activity settles.
export const pendingQueueInputs = Effect.fn("SessionInput.pendingQueueInputs")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "queue"),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

export const promoteNextQueued = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "queue"),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return undefined
  const ids = yield* publish(db, events, sessionID, [row])
  return ids[0]
})

// ---------------------------------------------------------------------------------------------------
// W1.1 — goal_steer drain affordances (design W1 §1). `goal_steer` (§S1.3) is guidance directed at a
// RUNNING goal: the parent runLoop's `steer` drain and the goal driver's `goal_steer` drain read
// DISJOINT rows, and a goal steer is NEVER promoted into the session transcript (the goal threads it
// into its next step prompt instead). Consumption therefore cannot reuse the `steer`/`queue`
// promotion event: the goal channel stamps rows consumed directly, mirroring the SessionSteer
// `consumed_seq` convention (any non-null == consumed, one-way, idempotent).
// ---------------------------------------------------------------------------------------------------

/** Goal-directed steer text waiting on the goal driver, in send-order (non-consuming read). */
export const pendingGoalSteers = Effect.fn("SessionInput.pendingGoalSteers")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "goal_steer"),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

/**
 * Stamp the given goal-steer rows consumed (idempotent: already-consumed ids are skipped). The
 * consumed marker is `promoted_seq` — the session_input row's one-way consumption watermark; the
 * goal channel never triggers a PromptLifecycle.Promoted projection for these rows, so a stamped
 * goal_steer row is a plain "delivered to the goal" state, not a transcript message.
 */
export const consumeGoalSteers = Effect.fn("SessionInput.consumeGoalSteers")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  ids: ReadonlyArray<SessionMessage.ID>,
) {
  if (ids.length === 0) return
  const stampedAt = yield* DateTime.now
  yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: DateTime.toEpochMillis(stampedAt) })
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        inArray(SessionInputTable.id, ids.map((id) => id)),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

// One deterministic notice per pending goal steer (a goal_steer that found no active goal): the
// notice's message id derives from the steer's own row id, so re-drains across crash/restart never
// fan out duplicate notices for the same steer.
const goalSteerNoticeID = (steerID: SessionMessage.ID): SessionMessage.ID =>
  SessionMessage.ID.make(`msg_${Hash.sha256(`goal-steer-pending:${steerID}`).slice(0, 40)}`)

export const GOAL_STEER_PENDING_NOTICE =
  "Goal-directed instruction recorded: it will be delivered to the goal once a goal is running (no active goal in this session yet)."

/**
 * W1.1 — publish the one-time "waiting for a goal" notice for a pending goal_steer that no active
 * goal could receive. Idempotent by the derived deterministic message id: a crash between the notice
 * and the consume (or repeated no-goal drains) never repeats the notice for the same steer.
 */
export const publishGoalSteerPendingNotice = Effect.fn("SessionInput.publishGoalSteerPendingNotice")(
  function* (db: DatabaseService, events: EventV2.Interface, sessionID: SessionSchema.ID, steerID: SessionMessage.ID) {
    const messageID = goalSteerNoticeID(steerID)
    const existing = yield* db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, messageID))
      .get()
      .pipe(Effect.orDie)
    if (existing) return
    yield* events.publish(SessionEvent.Synthetic, {
      sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      text: GOAL_STEER_PENDING_NOTICE,
    })
  },
)

const toMessage = (input: Admitted) =>
  new SessionMessage.User({
    id: input.id,
    type: "user",
    text: input.prompt.text,
    files: input.prompt.files,
    agents: input.prompt.agents,
    references: input.prompt.references,
    format: input.prompt.format,
    time: { created: input.timeCreated },
  })
