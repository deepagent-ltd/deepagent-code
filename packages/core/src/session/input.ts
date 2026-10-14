import { GoalChildSchema } from "../deepagent/goal-child.schema"
export * as SessionInput from "./input"

import { and, asc, count, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable, EventSequenceTable } from "../event/sql"
import { Hash } from "../util/hash"
import { NonNegativeInt } from "../schema"
import { SessionV1 } from "../v1/session"
import { V2Schema } from "../v2-schema"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { SessionActivityTable } from "../context-federation/session-sql"
import { CollaborationMode } from "./collaboration-mode"
import { GoalControl } from "../deepagent/goal-control"

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
  revertEpoch: NonNegativeInt.pipe(Schema.optional),
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
    ...(row.revert_epoch === null ? {} : { revertEpoch: row.revert_epoch }),
  })

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export class StaleRevertEpoch extends Schema.TaggedErrorClass<StaleRevertEpoch>()("SessionInput.StaleRevertEpoch", {
  sessionID: SessionSchema.ID,
  expected: NonNegativeInt,
  actual: NonNegativeInt,
}) {}

export class ModeChangeRefused extends Schema.TaggedErrorClass<ModeChangeRefused>()("SessionInput.ModeChangeRefused", {
  sessionID: SessionSchema.ID,
  currentAgent: Schema.String,
  requestedAgent: Schema.String,
  code: Schema.Literals(["MODE_CHANGE_REQUIRES_QUEUE", "GOAL_MODE_CHANGE_BUSY"]),
}) {
  override get message() {
    return this.code === "MODE_CHANGE_REQUIRES_QUEUE"
      ? "A different agent must be queued for the next activity; the current activity keeps its mode."
      : "Pause or stop the current Goal and confirm that no Goal work is in flight before changing its execution mode."
  }
}

export const requireModeChange = Effect.fn("SessionInput.requireModeChange")(function* (
  db: DatabaseService | Parameters<Parameters<DatabaseService["transaction"]>[0]>[0],
  input: { sessionID: SessionSchema.ID; requestedAgent?: string; currentAgent?: string; delivery: Delivery },
) {
  if (input.requestedAgent === undefined) return
  const session = yield* db
    .select({ agent: SessionTable.agent })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  const active = yield* db
    .select({ id: SessionActivityTable.activity_id })
    .from(SessionActivityTable)
    .where(and(eq(SessionActivityTable.session_id, input.sessionID), eq(SessionActivityTable.state, "active")))
    .get()
    .pipe(Effect.orDie)
  // An omitted Session selector can change its config default while a turn is in flight.
  // The captured ContextEpoch is the actual running identity until this activity settles.
  const epoch =
    active && !session?.agent
      ? yield* db
          .select({ agent: SessionContextEpochTable.agent })
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
      : undefined
  const currentAgent = CollaborationMode.configuredCollaborationMode(
    session?.agent ?? epoch?.agent ?? input.currentAgent,
  )
  const requestedAgent = CollaborationMode.configuredCollaborationMode(input.requestedAgent)
  if (requestedAgent === currentAgent) return
  const goal = yield* GoalControl.current(db, input.sessionID)
  if (goal) {
    const observed = yield* GoalControl.snapshot(db, goal)
    if (
      (!GoalControl.isTerminal(goal.requested_phase) && goal.requested_phase !== "paused") ||
      observed.inFlight ||
      observed.recoveryRequired ||
      observed.preparation !== "ready"
    )
      return yield* new ModeChangeRefused({
        sessionID: input.sessionID,
        currentAgent,
        requestedAgent,
        code: "GOAL_MODE_CHANGE_BUSY",
      })
  }
  if (input.delivery !== "steer") return
  if (active)
    return yield* new ModeChangeRefused({
      sessionID: input.sessionID,
      currentAgent,
      requestedAgent,
      code: "MODE_CHANGE_REQUIRES_QUEUE",
    })
})

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly revertEpoch?: number
    readonly currentAgent?: string
    /**
     * In-transaction hook committed atomically with the PromptLifecycle.Admitted event and its
     * `session_input` projection (same contract as `EventV2.publishChecked`'s `{ commit }` option): the
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
  const commit = (seq: number, event: EventV2.Payload) =>
    Effect.gen(function* () {
      yield* requireModeChange(db, {
        sessionID: input.sessionID,
        requestedAgent: input.prompt.agent,
        currentAgent: input.currentAgent,
        delivery: input.delivery,
      })
      if (input.revertEpoch !== undefined) {
        const session = yield* db
          .select({ mutationEpoch: SessionTable.mutation_epoch })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (session?.mutationEpoch !== input.revertEpoch)
          return yield* new StaleRevertEpoch({
            sessionID: input.sessionID,
            expected: input.revertEpoch,
            actual: session?.mutationEpoch ?? 0,
          })
      }
      if (input.commit) yield* input.commit(seq, event)
    })
  return yield* events
    .publishChecked(
      SessionEvent.PromptLifecycle.Admitted,
      {
        messageID: input.id,
        sessionID: input.sessionID,
        timestamp,
        prompt: input.prompt,
        delivery: input.delivery,
        ...(input.revertEpoch === undefined ? {} : { revertEpoch: input.revertEpoch }),
      },
      { commit },
    )
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
                ...(input.revertEpoch === undefined ? {} : { revertEpoch: input.revertEpoch }),
                timeCreated: timestamp,
              }),
            ),
      ),
      Effect.catch((error) =>
        error.cause instanceof StaleRevertEpoch ||
        error.cause instanceof GoalChildSchema.Error ||
        error.cause instanceof ModeChangeRefused
          ? Effect.fail(error.cause)
          : Effect.die(error),
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
    readonly revertEpoch?: number
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
      revert_epoch: input.revertEpoch ?? null,
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
    admitted.revertEpoch !== input.revertEpoch ||
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
    readonly revertEpoch?: number
  },
) =>
  input.delivery === expected.delivery && input.revertEpoch === expected.revertEpoch && matchesPrompt(input, expected)

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

/** A preparation witness, never an admission or an execution permission. */
export interface SelectionSnapshot {
  readonly sessionID: SessionSchema.ID
  readonly cutoff: number
  readonly agent: string | undefined
  readonly model: Prompt["model"]
}

export class SelectionMismatch extends Error {
  constructor(readonly reason: "snapshot" | "sequence" | "session" | "input" = "snapshot") {
    super(`Session selection changed: ${reason}`)
  }
}

type SelectionState = {
  readonly session: typeof SessionTable.$inferSelect
  readonly count: number
  readonly digest: string
  readonly pendingAgent: string | undefined
  readonly pendingModel: Prompt["model"]
  readonly queueSequence: number | undefined
  readonly firstSteerSequence: number | undefined
  readonly cutoff: number
  readonly promotion: Delivery | undefined
}
const selections = new WeakMap<SelectionSnapshot, SelectionState>()
const selectionSession = (session: typeof SessionTable.$inferSelect) => ({
  id: session.id,
  project: session.project_id,
  directory: session.directory,
  workspace: session.workspace_id,
  parent: session.parent_id,
  epoch: session.mutation_epoch,
  interrupt: session.interrupt_seq,
  agent: session.agent,
  model: session.model,
  permission: session.permission,
})
const sameSelectionSession = (a: typeof SessionTable.$inferSelect, b: typeof SessionTable.$inferSelect) =>
  JSON.stringify(selectionSession(a)) === JSON.stringify(selectionSession(b))
const selectionState = (snapshot: SelectionSnapshot) => {
  const state = selections.get(snapshot)
  if (!state) throw new SelectionMismatch()
  return state
}

const selectionRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  promotion: Delivery | undefined,
  cutoff: number,
  after?: number,
) {
  if (promotion !== "steer" && promotion !== "queue") return []
  const steers = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        lte(SessionInputTable.admitted_seq, cutoff),
        eq(SessionInputTable.delivery, "steer"),
        after === undefined ? undefined : gt(SessionInputTable.admitted_seq, after),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(128)
    .all()
    .pipe(Effect.orDie)
  if (promotion === "steer" || after !== undefined) return steers
  const queued = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        lte(SessionInputTable.admitted_seq, cutoff),
        eq(SessionInputTable.delivery, "queue"),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return queued ? [queued, ...steers] : steers
})

// Admitted events are intentionally outside the Session snapshot codec's compaction set.
// Their original projection is the per-page immutable fact, not a caller-created page hash.
const requireSelectionRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
) {
  if (rows.length === 0) return
  const admitted = yield* db
    .select({ seq: EventTable.seq, data: EventTable.data })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, sessionID),
        eq(EventTable.type, EventV2.durableType(SessionEvent.PromptLifecycle.Admitted)),
        inArray(
          EventTable.seq,
          rows.map((row) => row.admitted_seq),
        ),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  if (admitted.length !== rows.length) return yield* Effect.die(new SelectionMismatch("input"))
  const bySequence = new Map(admitted.map((event) => [event.seq, event.data]))
  for (const row of rows) {
    const source = Schema.decodeUnknownOption(SessionEvent.PromptLifecycle.Admitted.data)(
      bySequence.get(row.admitted_seq),
    )
    if (
      Option.isNone(source) ||
      source.value.sessionID !== sessionID ||
      source.value.messageID !== row.id ||
      source.value.delivery !== row.delivery ||
      (source.value.revertEpoch ?? null) !== row.revert_epoch ||
      DateTime.toEpochMillis(source.value.timestamp) !== row.time_created ||
      !Prompt.equivalence(source.value.prompt, decodePrompt(row.prompt))
    )
      return yield* Effect.die(new SelectionMismatch("input"))
  }
})

const selectionBatch = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  promotion: Delivery | undefined,
  cutoff: number,
) {
  const batch = {
    count: 0,
    digest: Hash.sha256("session.selection.v1"),
    pendingAgent: undefined as string | undefined,
    pendingModel: undefined as Prompt["model"],
    queueSequence: undefined as number | undefined,
    firstSteerSequence: undefined as number | undefined,
  }
  const cursor = { after: undefined as number | undefined }
  while (true) {
    const rows = yield* selectionRows(db, sessionID, promotion, cutoff, cursor.after)
    yield* requireSelectionRows(db, sessionID, rows)
    for (const row of rows) {
      batch.count++
      batch.digest = Hash.sha256(`${batch.digest}\n${JSON.stringify(row)}`)
      batch.pendingAgent = row.prompt.agent ?? batch.pendingAgent
      batch.pendingModel = row.prompt.model ?? batch.pendingModel
      if (row.delivery === "queue") batch.queueSequence = row.admitted_seq
      if (row.delivery === "steer" && batch.firstSteerSequence === undefined)
        batch.firstSteerSequence = row.admitted_seq
    }
    const steers = rows.filter((row) => row.delivery === "steer")
    if (steers.length < 128) return batch
    cursor.after = steers.at(-1)!.admitted_seq
  }
})

// Read promotion pages from the original admissions so a deleted or reclassified pending
// projection cannot silently disappear between pages. Previously promoted rows stay excluded;
// this batch's own committed prefix is skipped by the immutable admission cursor.
const selectionPromotionRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  state: SelectionState,
  after: number | undefined,
) {
  const page = (delivery: "queue" | "steer") =>
    db
      .select({ input: SessionInputTable })
      .from(EventTable)
      .leftJoin(
        SessionInputTable,
        and(
          eq(SessionInputTable.session_id, EventTable.aggregate_id),
          eq(SessionInputTable.admitted_seq, EventTable.seq),
        ),
      )
      .where(
        and(
          eq(EventTable.aggregate_id, sessionID),
          eq(EventTable.type, EventV2.durableType(SessionEvent.PromptLifecycle.Admitted)),
          eq(sql<string>`json_extract(${EventTable.data}, '$.delivery')`, delivery),
          lte(EventTable.seq, state.cutoff),
          delivery === "queue"
            ? eq(EventTable.seq, state.queueSequence!)
            : gt(EventTable.seq, after ?? state.firstSteerSequence! - 1),
          or(
            isNull(SessionInputTable.promoted_seq),
            gt(SessionInputTable.promoted_seq, state.cutoff),
            // Only a real earlier canonical promotion can exclude a historical member.
            // A changed projection stamp must remain visible and fail before publication.
            sql`NOT EXISTS (SELECT 1 FROM event selection_promotion
              WHERE selection_promotion.aggregate_id=${EventTable.aggregate_id}
                AND selection_promotion.seq=${SessionInputTable.promoted_seq}
                AND selection_promotion.type=${EventV2.durableType(SessionEvent.PromptLifecycle.Promoted)}
                AND json_extract(selection_promotion.data, '$.sessionID')=${sessionID}
                AND json_extract(selection_promotion.data, '$.messageID')=${SessionInputTable.id})`,
          ),
        ),
      )
      .orderBy(asc(EventTable.seq))
      .limit(delivery === "queue" ? 1 : 128)
      .all()
      .pipe(Effect.orDie)
  const queue = after === undefined && state.queueSequence !== undefined ? yield* page("queue") : []
  const steers = state.firstSteerSequence === undefined ? [] : yield* page("steer")
  const rows = [...queue, ...steers].map((item) => {
    if (!item.input || item.input.promoted_seq !== null) throw new SelectionMismatch("input")
    return item.input
  })
  yield* requireSelectionRows(db, sessionID, rows)
  return rows
})

// Capture one real SQL batch. Agent and model are independently last-wins, exactly like the
// projector. The aggregate sequence catches even A→B→A switches before an epoch exists.
export const captureSelection = Effect.fn("SessionInput.captureSelection")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  promotion: Delivery | undefined,
) {
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const session = yield* db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!session) return yield* Effect.die(new SelectionMismatch())
          const cutoff = yield* latestSeq(db, sessionID)
          const batch = yield* selectionBatch(db, sessionID, promotion, cutoff)
          const agent = batch.pendingAgent ?? session.agent ?? undefined
          const model = batch.pendingModel ?? session.model ?? undefined
          const snapshot: SelectionSnapshot = Object.freeze({
            sessionID,
            cutoff,
            agent,
            model: model === undefined ? undefined : Object.freeze({ ...model }),
          })
          selections.set(snapshot, { session, ...batch, cutoff, promotion })
          return snapshot
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

// Call inside the epoch's transaction, after expensive Context observation. A snapshot carries
// only observed facts; a caller-created object cannot substitute a guessed selector or batch.
export const requireSelection = Effect.fn("SessionInput.requireSelection")(function* (
  db: DatabaseService,
  snapshot: SelectionSnapshot,
) {
  const state = selectionState(snapshot)
  const session = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, snapshot.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (
    !session ||
    !sameSelectionSession(state.session, session) ||
    (yield* latestSeq(db, snapshot.sessionID)) !== state.cutoff
  )
    return yield* Effect.die(new SelectionMismatch())
  const batch = yield* selectionBatch(db, snapshot.sessionID, state.promotion, state.cutoff)
  if (batch.count !== state.count || batch.digest !== state.digest) return yield* Effect.die(new SelectionMismatch())
})

const requireMirrorGap = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  after: number,
  through: number,
) {
  if (through < after) return yield* Effect.die(new SelectionMismatch("sequence"))
  if (through === after) return
  const mirrored = yield* db
    .select({ count: count() })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, sessionID),
        gt(EventTable.seq, after),
        lte(EventTable.seq, through),
        inArray(EventTable.type, [
          EventV2.versionedType(SessionV1.Event.MessageUpdated.type, SessionV1.Event.MessageUpdated.sync!.version),
          EventV2.versionedType(SessionV1.Event.PartUpdated.type, SessionV1.Event.PartUpdated.sync!.version),
        ]),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  // The aggregate/sequence uniqueness constraint makes this an exact coverage check. Missing
  // (e.g. compacted) evidence is not permission to ignore a gap.
  if (mirrored?.count !== through - after) return yield* Effect.die(new SelectionMismatch("sequence"))
})

// ContextUpdated is the only selection-neutral canonical event preparation may publish. Its
// exact committed sequence advances this witness; it never recaptures a different pending batch.
export const afterContextUpdate = Effect.fn("SessionInput.afterContextUpdate")(function* (
  db: DatabaseService,
  snapshot: SelectionSnapshot,
  event: Pick<EventV2.Payload, "id" | "seq" | "type">,
) {
  const seq = event.seq ?? -1
  const state = selectionState(snapshot)
  if (seq !== state.cutoff + 1) return yield* Effect.die(new SelectionMismatch("sequence"))
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const committed = yield* db
            .select({ id: EventTable.id })
            .from(EventTable)
            .where(
              and(
                eq(EventTable.id, event.id),
                eq(EventTable.aggregate_id, snapshot.sessionID),
                eq(EventTable.seq, seq),
                eq(
                  EventTable.type,
                  EventV2.versionedType(SessionEvent.ContextUpdated.type, SessionEvent.ContextUpdated.sync!.version),
                ),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!committed || event.type !== SessionEvent.ContextUpdated.type)
            return yield* Effect.die(new SelectionMismatch("sequence"))
          const cutoff = yield* latestSeq(db, snapshot.sessionID)
          yield* requireMirrorGap(db, snapshot.sessionID, seq, cutoff)
          const next = Object.freeze({ ...snapshot, cutoff })
          selections.set(next, { ...state, cutoff })
          yield* requireSelection(db, next).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (exit._tag === "Failure") selections.delete(next)
              }),
            ),
          )
          selections.delete(snapshot)
          return next
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export interface SelectionPromotion {
  readonly seq: number
  readonly selectionChanges: number
  readonly replacementSeq: number | undefined
}

// Revalidate each promotion in its existing EventV2 transaction. Do not put publish inside an
// outer transaction: its observers must only see committed projections. New admissions or a
// switch between batch members cause a rebuild; already committed members remain durable.
export const promoteSelection = Effect.fn("SessionInput.promoteSelection")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  snapshot: SelectionSnapshot,
  commit?: (promotion: SelectionPromotion) => Effect.Effect<void>,
) {
  const state = selectionState(snapshot)
  return yield* Effect.gen(function* () {
    yield* requireSelection(db, snapshot)
    const promoted: string[] = []
    const cursor = {
      seq: state.cutoff,
      selectionChanges: 0,
      replacementSeq: undefined as number | undefined,
      after: undefined as number | undefined,
    }
    const expected = { ...state.session }
    while (promoted.length < state.count) {
      const rows = yield* db
        .transaction(() => selectionPromotionRows(db, snapshot.sessionID, state, cursor.after), {
          behavior: "immediate",
        })
        .pipe(Effect.orDie)
      if (rows.length === 0 || promoted.length + rows.length > state.count)
        return yield* Effect.die(new SelectionMismatch("input"))
      for (const row of rows) {
        expected.agent = row.prompt.agent ?? expected.agent
        expected.model = row.prompt.model ?? expected.model
        yield* events.publish(
          SessionEvent.PromptLifecycle.Promoted,
          {
            sessionID: snapshot.sessionID,
            timestamp: yield* DateTime.now,
            messageID: SessionMessage.ID.make(row.id),
            prompt: decodePrompt(row.prompt),
            timeCreated: DateTime.makeUnsafe(row.time_created),
          },
          {
            commit: (seq) =>
              Effect.gen(function* () {
                const session = yield* db
                  .select()
                  .from(SessionTable)
                  .where(eq(SessionTable.id, snapshot.sessionID))
                  .get()
                  .pipe(Effect.orDie)
                const current = yield* db
                  .select()
                  .from(SessionInputTable)
                  .where(eq(SessionInputTable.id, row.id))
                  .get()
                  .pipe(Effect.orDie)
                // Synchronous V1 egress may occupy the sequence gap, but no new admission, switch,
                // control or canonical history event may enter the frozen promotion batch.
                if (seq <= cursor.seq) return yield* Effect.die(new SelectionMismatch("sequence"))
                yield* requireMirrorGap(db, snapshot.sessionID, cursor.seq, seq - 1)
                if (!session || !sameSelectionSession(expected, session))
                  return yield* Effect.die(new SelectionMismatch("session"))
                if (JSON.stringify(current) !== JSON.stringify({ ...row, promoted_seq: seq }))
                  return yield* Effect.die(new SelectionMismatch("input"))
                cursor.seq = seq
                if (row.prompt.agent !== undefined || row.prompt.model !== undefined) {
                  cursor.selectionChanges++
                  cursor.replacementSeq = seq
                }
                if (promoted.length === state.count - 1 && commit) yield* commit(cursor)
              }),
          },
        )
        promoted.push(row.id)
        if (row.delivery === "steer") cursor.after = row.admitted_seq
      }
      // Page publication has released every EventV2 transaction before yielding. The next
      // original admission page and current frontier must still pass their own fences.
      if (promoted.length < state.count) yield* Effect.yieldNow
    }
    return promoted as PromotedInputs
  }).pipe(Effect.ensuring(Effect.sync(() => selections.delete(snapshot))))
})

// Compatibility read-only projection for callers that only need pending overrides.
export const peekActiveSelection = Effect.fn("SessionInput.peekActiveSelection")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  promotion: Delivery | undefined,
) {
  if (promotion !== "steer" && promotion !== "queue") return undefined
  const snapshot = yield* captureSelection(db, sessionID, promotion)
  const state = selectionState(snapshot)
  selections.delete(snapshot)
  const agent = state.pendingAgent
  const model = state.pendingModel
  if (agent === undefined && model === undefined) return undefined
  return { ...(agent === undefined ? {} : { agent }), ...(model === undefined ? {} : { model: { ...model } }) }
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
        inArray(
          SessionInputTable.id,
          ids.map((id) => id),
        ),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

/**
 * Publish a one-shot durable Synthetic notice keyed by a caller-derived deterministic message id.
 * Idempotent: an existing message row with the same id means the notice already landed (crash replay,
 * repeated drain, exact retry), so the publish is skipped and the session never shows duplicates.
 */
export const publishSyntheticNoticeOnce = Effect.fn("SessionInput.publishSyntheticNoticeOnce")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
    text: string
  },
) {
  const existing = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.messageID))
    .get()
    .pipe(Effect.orDie)
  if (existing) return
  yield* events.publish(SessionEvent.Synthetic, {
    sessionID: input.sessionID,
    messageID: input.messageID,
    timestamp: yield* DateTime.now,
    text: input.text,
  })
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
export const publishGoalSteerPendingNotice = Effect.fn("SessionInput.publishGoalSteerPendingNotice")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  steerID: SessionMessage.ID,
) {
  yield* publishSyntheticNoticeOnce(db, events, {
    sessionID,
    messageID: goalSteerNoticeID(steerID),
    text: GOAL_STEER_PENDING_NOTICE,
  })
})

const toMessage = (input: Admitted) =>
  new SessionMessage.User({
    id: input.id,
    type: "user",
    text: input.prompt.text,
    files: input.prompt.files,
    agents: input.prompt.agents,
    references: input.prompt.references,
    format: input.prompt.format,
    metadata: input.prompt.metadata,
    agent: input.prompt.agent,
    model: input.prompt.model,
    intent: input.prompt.intent,
    time: { created: input.timeCreated },
  })
