import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { Context, Data, DateTime, Effect, Layer, Schema, Types } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import {
  MessageTable,
  PartTable,
  SessionIntentTable,
  SessionSteerTable,
  SessionTable,
} from "@deepagent-code/core/session/sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { MessageID, SessionID } from "./schema"
import type { Receipt } from "./prompt-intent"
import { SessionMutationEpoch } from "./mutation-epoch"
import { SessionPromptEpochTable } from "./prompt-epoch.sql"

// V4.1 §S1.1 — the durable mid-turn STEER buffer.
//
// REUSE-VS-NEW: the core `SessionInput` model (packages/core/src/session/input.ts) already has a
// steer data model (Delivery="steer", admit/promoteSteers). It is NOT reused directly because it is
// fully EVENT-SOURCED: `admit` publishes a `PromptLifecycle.Admitted` event and rows only land via the
// `SessionProjector` — a pipeline that is dormant in the live product (deepagent-code wires
// `SessionExecution.noopLayer` and gates the V2 event system behind `experimentalEventSystem`, default
// OFF). Worse, `promoteSteers` materializes into the V2 `session_message` store consumed by the
// dormant V2 runner's `entriesForRunner` — a DIFFERENT history store than the LIVE loop, which reads
// the V1 `MessageTable` via `MessageV2.filterCompactedEffect`. Reusing it would force activating the
// forbidden event system AND target the wrong history. So this is a clean, PLAIN durable buffer:
// direct row writes to `session_steer` (survives process restart mid-goal), reusing only the neutral
// `Prompt` payload schema and `Delivery` literal from core. Drained steers are persisted as ordinary
// V1 user messages by the runLoop (prompt.ts), landing at the tail of real history — cache-safe.
//
// Chat steers cross one transaction boundary in `materialize`: the V1 message, all parts, and consume
// stamp commit together after re-checking the Session mutation epoch. Goal steers use `markConsumed`
// without V1 materialization. A revert advances the epoch and supersedes every old pending row, so an
// admission or drain that loses the race cannot append after the rewritten history boundary.

export type Delivery = SessionInput.Delivery

// Raised when the same correlationID is reused with a different payload, which
// would silently overwrite or ignore the earlier steer. Callers should surface
// this as a 409-style client error.
export class CorrelationConflict extends Data.TaggedError("SessionSteer.CorrelationConflict")<{
  readonly sessionID: SessionID
  readonly correlationID: string
}> {}

export class Admitted extends Schema.Class<Admitted>("SessionSteer.Admitted")({
  seq: Schema.Int,
  id: SessionMessage.ID,
  sessionID: SessionID,
  correlationID: Schema.optional(Schema.String),
  prompt: Prompt,
  delivery: SessionInput.Delivery,
  mutationEpoch: Schema.Int,
  timeCreated: Schema.Finite,
}) {}

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)

const fromRow = (row: typeof SessionSteerTable.$inferSelect): Admitted =>
  new Admitted({
    seq: row.seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionID.make(row.session_id),
    correlationID: row.correlation_id ?? undefined,
    prompt: decodePrompt(row.prompt),
    delivery: row.delivery,
    mutationEpoch: row.mutation_epoch,
    timeCreated: row.time_created,
  })

export interface Interface {
  // Buffer a user message for later absorption. `id` is always server-minted.
  // `correlationID` is an optional client retry key: identical payload retries return the stored row;
  // different payload for the same key returns a CorrelationConflict (never silently drops).
  readonly admit: (input: {
    readonly sessionID: SessionID
    readonly prompt: Prompt
    readonly delivery?: Delivery
    readonly correlationID?: string
    readonly intent?: Receipt & {
      readonly state: "admitting"
      readonly ownerToken: string
      readonly messageID: MessageID
    }
  }) => Effect.Effect<Admitted, CorrelationConflict | SessionMutationEpoch.Stale>
  // NON-consuming read of current-epoch pending steers in send-order. The chat runLoop follows this with
  // atomic `materialize`; the goal driver follows it with `markConsumed` after applying the guidance.
  //
  // V4.1 §S1.3 DELIVERY DIMENSION: `delivery` scopes the read to ONE delivery channel (default "steer",
  // so S1.1's parent-runLoop drain is unchanged). This is what lets TWO drainers coexist on the SAME
  // session id without contention: the parent runLoop drains `delivery="steer"` while the goal driver
  // drains `delivery="goal_steer"` — disjoint rows, never first-come-first-served over the same buffer.
  readonly pending: (sessionID: SessionID, delivery?: Delivery) => Effect.Effect<ReadonlyArray<Admitted>>
  // Stamp current-epoch steer ids consumed. This remains the goal-driver path; chat history uses the
  // stronger `materialize` transaction. Idempotent and scoped to the caller's delivery channel.
  readonly markConsumed: (
    sessionID: SessionID,
    ids: ReadonlyArray<SessionMessage.ID>,
    delivery?: Delivery,
  ) => Effect.Effect<void>
  // Non-consuming peek used by the loop's needsFollowUp decision. `delivery` (default "steer") scopes it.
  readonly hasPending: (sessionID: SessionID, delivery?: Delivery) => Effect.Effect<boolean>
  // Reserve a stable history timestamp immediately before V1 materialization. It is ordered strictly
  // after the active PromptEpoch boundary so a steer admitted before compaction cannot sort into the
  // retired physical prefix. The reservation is durable and reused by crash retries.
  readonly materializationTime: (admitted: Admitted) => Effect.Effect<number, SessionMutationEpoch.Stale>
  readonly materialize: (input: {
    readonly admitted: Admitted
    readonly info: SessionV1.User
    readonly parts: ReadonlyArray<SessionV1.Part>
  }) => Effect.Effect<boolean, SessionMutationEpoch.Stale>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionSteer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const admit: Interface["admit"] = Effect.fn("SessionSteer.admit")(function* (input) {
      const delivery = input.delivery ?? "steer"
      const timeCreated = DateTime.toEpochMillis(yield* DateTime.now)
      const id = SessionMessage.ID.create()
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const session = yield* tx
                .select({ mutationEpoch: SessionTable.mutation_epoch })
                .from(SessionTable)
                .where(eq(SessionTable.id, input.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!session) return yield* Effect.die(`Session not found: ${input.sessionID}`)
              if (
                input.intent &&
                (input.intent.sessionID !== input.sessionID || input.intent.messageID !== input.correlationID)
              )
                return yield* Effect.die("SessionSteer.admit: intent identity does not match steer admission")
              if (input.intent?.mutationEpoch !== undefined && input.intent.mutationEpoch !== session.mutationEpoch)
                return yield* Effect.fail(
                  new SessionMutationEpoch.Stale({
                    sessionID: input.sessionID,
                    observed: input.intent.mutationEpoch,
                    current: session.mutationEpoch,
                  }),
                )
              const inserted = yield* tx
                .insert(SessionSteerTable)
                .values({
                  id,
                  session_id: input.sessionID,
                  correlation_id: input.correlationID,
                  prompt: encodePrompt(input.prompt),
                  delivery,
                  mutation_epoch: session.mutationEpoch,
                  time_created: timeCreated,
                })
                .onConflictDoNothing()
                .returning()
                .get()
                .pipe(Effect.orDie)
              const row =
                inserted ??
                (input.correlationID
                  ? yield* tx
                      .select()
                      .from(SessionSteerTable)
                      .where(
                        and(
                          eq(SessionSteerTable.session_id, input.sessionID),
                          eq(SessionSteerTable.correlation_id, input.correlationID),
                        ),
                      )
                      .get()
                      .pipe(Effect.orDie)
                  : undefined)
              if (!row) return yield* Effect.die("SessionSteer.admit: server-generated id conflicted (impossible)")
              const admitted = fromRow(row)
              if (admitted.mutationEpoch !== session.mutationEpoch)
                return yield* Effect.fail(
                  new SessionMutationEpoch.Stale({
                    sessionID: input.sessionID,
                    observed: admitted.mutationEpoch,
                    current: session.mutationEpoch,
                  }),
                )
              if (!inserted && (admitted.delivery !== delivery || !Prompt.equivalence(admitted.prompt, input.prompt)))
                return yield* Effect.fail(
                  new CorrelationConflict({ sessionID: input.sessionID, correlationID: input.correlationID! }),
                )
              if (input.intent) {
                const intent = yield* tx
                  .update(SessionIntentTable)
                  .set({
                    state: "admitted",
                    delivery,
                    admitted_message_id: admitted.id,
                    owner_token: null,
                    lease_expires_at: null,
                    time_admitted: timeCreated,
                    time_updated: timeCreated,
                    version: input.intent.version + 1,
                  })
                  .where(
                    and(
                      eq(SessionIntentTable.intent_id, input.intent.intentID),
                      eq(SessionIntentTable.session_id, input.sessionID),
                      eq(SessionIntentTable.state, "admitting"),
                      eq(SessionIntentTable.owner_token, input.intent.ownerToken),
                      eq(SessionIntentTable.mutation_epoch, session.mutationEpoch),
                    ),
                  )
                  .returning({ intentID: SessionIntentTable.intent_id })
                  .get()
                  .pipe(Effect.orDie)
                if (!intent) return yield* Effect.die("SessionSteer.admit: intent admission ownership was lost")
              }
              return admitted
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const pending: Interface["pending"] = Effect.fn("SessionSteer.pending")(function* (sessionID, delivery = "steer") {
      const session = yield* db
        .select({ mutationEpoch: SessionTable.mutation_epoch })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return []
      const rows = yield* db
        .select()
        .from(SessionSteerTable)
        .where(
          and(
            eq(SessionSteerTable.session_id, sessionID),
            eq(SessionSteerTable.mutation_epoch, session.mutationEpoch),
            isNull(SessionSteerTable.consumed_seq),
            isNull(SessionSteerTable.superseded_at),
            eq(SessionSteerTable.delivery, delivery),
          ),
        )
        .orderBy(asc(SessionSteerTable.seq))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const markConsumed: Interface["markConsumed"] = Effect.fn("SessionSteer.markConsumed")(function* (
      sessionID,
      ids,
      delivery = "steer",
    ) {
      if (ids.length === 0) return
      const session = yield* db
        .select({ mutationEpoch: SessionTable.mutation_epoch })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return
      // Persist-first step 3: stamp consumed AFTER the caller has durably materialized the messages.
      // `consumed_seq` records the wall-clock of the stamp (any non-null == consumed). Re-assert
      // `consumed_seq IS NULL` in the WHERE so a concurrent drain that already claimed a row is a no-op
      // here, and only the ids we were handed are touched. Uninterruptible so the stamp commits atomically.
      // The `delivery` filter keeps the stamp scoped to the caller's own channel (steer vs goal_steer).
      const stampedAt = DateTime.toEpochMillis(yield* DateTime.now)
      yield* Effect.uninterruptible(
        db
          .update(SessionSteerTable)
          .set({ consumed_seq: stampedAt })
          .where(
            and(
              eq(SessionSteerTable.session_id, sessionID),
              eq(SessionSteerTable.mutation_epoch, session.mutationEpoch),
              isNull(SessionSteerTable.consumed_seq),
              isNull(SessionSteerTable.superseded_at),
              eq(SessionSteerTable.delivery, delivery),
              inArray(SessionSteerTable.id, [...ids]),
            ),
          )
          .run()
          .pipe(Effect.orDie),
      )
    })

    const hasPending: Interface["hasPending"] = Effect.fn("SessionSteer.hasPending")(function* (
      sessionID,
      delivery = "steer",
    ) {
      const session = yield* db
        .select({ mutationEpoch: SessionTable.mutation_epoch })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return false
      const row = yield* db
        .select({ seq: SessionSteerTable.seq })
        .from(SessionSteerTable)
        .where(
          and(
            eq(SessionSteerTable.session_id, sessionID),
            eq(SessionSteerTable.mutation_epoch, session.mutationEpoch),
            isNull(SessionSteerTable.consumed_seq),
            isNull(SessionSteerTable.superseded_at),
            eq(SessionSteerTable.delivery, delivery),
          ),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row !== undefined
    })

    const materializationTime: Interface["materializationTime"] = Effect.fn("SessionSteer.materializationTime")(
      function* (admitted) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const session = yield* tx
                  .select({ mutationEpoch: SessionTable.mutation_epoch })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, admitted.sessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (!session) return yield* Effect.die(`Session not found: ${admitted.sessionID}`)
                if (session.mutationEpoch !== admitted.mutationEpoch)
                  return yield* Effect.fail(
                    new SessionMutationEpoch.Stale({
                      sessionID: admitted.sessionID,
                      observed: admitted.mutationEpoch,
                      current: session.mutationEpoch,
                    }),
                  )
                const steer = yield* tx
                  .select({ materialized_at: SessionSteerTable.materialized_at })
                  .from(SessionSteerTable)
                  .where(
                    and(
                      eq(SessionSteerTable.id, admitted.id),
                      eq(SessionSteerTable.mutation_epoch, session.mutationEpoch),
                      isNull(SessionSteerTable.consumed_seq),
                      isNull(SessionSteerTable.superseded_at),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if (!steer) return yield* Effect.die(`Pending steer not found: ${admitted.id}`)
                if (steer.materialized_at !== null) return steer.materialized_at
                const epoch = yield* tx
                  .select({ source_end_message_id: SessionPromptEpochTable.source_end_message_id })
                  .from(SessionPromptEpochTable)
                  .where(
                    and(
                      eq(SessionPromptEpochTable.session_id, admitted.sessionID),
                      eq(SessionPromptEpochTable.state, "active"),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                const boundary = epoch?.source_end_message_id
                  ? yield* tx
                      .select({ time_created: MessageTable.time_created })
                      .from(MessageTable)
                      .where(eq(MessageTable.id, MessageID.make(epoch.source_end_message_id)))
                      .get()
                      .pipe(Effect.orDie)
                  : undefined
                const materializedAt = Math.max(
                  DateTime.toEpochMillis(yield* DateTime.now),
                  (boundary?.time_created ?? -1) + 1,
                )
                const reserved = yield* tx
                  .update(SessionSteerTable)
                  .set({ materialized_at: materializedAt })
                  .where(and(eq(SessionSteerTable.id, admitted.id), isNull(SessionSteerTable.materialized_at)))
                  .returning({ materialized_at: SessionSteerTable.materialized_at })
                  .get()
                  .pipe(Effect.orDie)
                return reserved?.materialized_at ?? materializedAt
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.catchTag("SqlError", Effect.die))
      },
    )

    const materialize: Interface["materialize"] = Effect.fn("SessionSteer.materialize")(function* (input) {
      if (String(input.info.id) !== String(input.admitted.id) || input.info.sessionID !== input.admitted.sessionID)
        return yield* Effect.die("SessionSteer.materialize: message identity does not match admitted steer")
      if (input.parts.some((part) => part.messageID !== input.info.id || part.sessionID !== input.info.sessionID))
        return yield* Effect.die("SessionSteer.materialize: part identity does not match admitted steer")
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const session = yield* tx
                .select({ mutationEpoch: SessionTable.mutation_epoch })
                .from(SessionTable)
                .where(eq(SessionTable.id, input.admitted.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!session) return false
              if (session.mutationEpoch !== input.admitted.mutationEpoch)
                return yield* Effect.fail(
                  new SessionMutationEpoch.Stale({
                    sessionID: input.admitted.sessionID,
                    observed: input.admitted.mutationEpoch,
                    current: session.mutationEpoch,
                  }),
                )
              const row = yield* tx
                .select({ id: SessionSteerTable.id })
                .from(SessionSteerTable)
                .where(
                  and(
                    eq(SessionSteerTable.id, input.admitted.id),
                    eq(SessionSteerTable.mutation_epoch, session.mutationEpoch),
                    isNull(SessionSteerTable.consumed_seq),
                    isNull(SessionSteerTable.superseded_at),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (!row) return false
              const { id: _, sessionID: __, ...message } = input.info
              const data = message as Types.DeepMutable<typeof message>
              const storedMessage = yield* tx
                .select()
                .from(MessageTable)
                .where(eq(MessageTable.id, input.info.id))
                .get()
                .pipe(Effect.orDie)
              if (
                storedMessage &&
                (storedMessage.session_id !== input.info.sessionID ||
                  JSON.stringify(storedMessage.data) !== JSON.stringify(data))
              )
                return yield* Effect.die("SessionSteer.materialize: message ID conflicts with persisted content")
              if (!storedMessage)
                yield* tx
                  .insert(MessageTable)
                  .values({
                    id: input.info.id,
                    session_id: input.info.sessionID,
                    time_created: input.info.time.created,
                    data,
                  })
                  .run()
                  .pipe(Effect.orDie)
              yield* Effect.forEach(input.parts, (part) => {
                const { id: _, messageID: __, sessionID: ___, ...data } = part
                return Effect.gen(function* () {
                  const stored = yield* tx
                    .select()
                    .from(PartTable)
                    .where(eq(PartTable.id, part.id))
                    .get()
                    .pipe(Effect.orDie)
                  if (
                    stored &&
                    (stored.message_id !== part.messageID ||
                      stored.session_id !== part.sessionID ||
                      JSON.stringify(stored.data) !== JSON.stringify(data))
                  )
                    return yield* Effect.die("SessionSteer.materialize: part ID conflicts with persisted content")
                  if (!stored)
                    yield* tx
                      .insert(PartTable)
                      .values({
                        id: part.id,
                        message_id: part.messageID,
                        session_id: part.sessionID,
                        time_created: input.info.time.created,
                        data: data as Types.DeepMutable<typeof data>,
                      })
                      .run()
                      .pipe(Effect.orDie)
                })
              })
              yield* tx
                .update(SessionSteerTable)
                .set({ consumed_seq: DateTime.toEpochMillis(yield* DateTime.now) })
                .where(
                  and(
                    eq(SessionSteerTable.id, input.admitted.id),
                    eq(SessionSteerTable.mutation_epoch, session.mutationEpoch),
                    isNull(SessionSteerTable.consumed_seq),
                    isNull(SessionSteerTable.superseded_at),
                  ),
                )
                .run()
                .pipe(Effect.orDie)
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    return Service.of({ admit, pending, markConsumed, hasPending, materializationTime, materialize })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export * as SessionSteer from "./steer"
