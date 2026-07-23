import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { Context, Data, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSteerTable } from "@deepagent-code/core/session/sql"
import { SessionID } from "./schema"

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
// EXACTLY-ONCE MATERIALIZATION (no loss, no duplicate). Draining a steer into history is a
// PERSIST-FIRST protocol split across two service calls the runLoop orchestrates in order:
//   1. `pending(sessionID)` — a NON-consuming read of the ordered pending steers.
//   2. runLoop persists each as a V1 user message keyed by the steer's OWN id (idempotent upsert).
//   3. `markConsumed(...)` — stamp those rows consumed.
// This deliberately AVOIDS the earlier stamp-then-persist ordering, which had a permanent-loss window:
// a crash after the stamp commit but before the message was materialized would leave the steer marked
// consumed yet never in history — the user's steering message lost forever. With persist-first, a
// crash between steps 2 and 3 leaves the row still pending; the next drain re-persists (a no-op upsert
// on the same message id — see prompt.ts drainSteers, which keys the message AND its text part by the
// steer id) and then stamps. At-least-once persist + idempotent upsert = exactly-once materialization,
// and `markConsumed`'s `consumed_seq IS NULL` guard keeps it consume-once against a concurrent drain.

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
  prompt: Prompt,
  delivery: SessionInput.Delivery,
  timeCreated: Schema.Finite,
}) {}

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)

const fromRow = (row: typeof SessionSteerTable.$inferSelect): Admitted =>
  new Admitted({
    seq: row.seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionID.make(row.session_id),
    prompt: decodePrompt(row.prompt),
    delivery: row.delivery,
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
  }) => Effect.Effect<Admitted, CorrelationConflict>
  // NON-consuming read of pending steers for the session, in send-order (ascending `seq`). Persist-first
  // step 1: the runLoop reads these, materializes each as a V1 history message keyed by the steer id
  // (idempotent), THEN calls markConsumed. Reading does NOT mark anything — a crash before markConsumed
  // leaves the rows pending so the next drain re-materializes (no loss).
  //
  // V4.1 §S1.3 DELIVERY DIMENSION: `delivery` scopes the read to ONE delivery channel (default "steer",
  // so S1.1's parent-runLoop drain is unchanged). This is what lets TWO drainers coexist on the SAME
  // session id without contention: the parent runLoop drains `delivery="steer"` while the goal driver
  // drains `delivery="goal_steer"` — disjoint rows, never first-come-first-served over the same buffer.
  readonly pending: (sessionID: SessionID, delivery?: Delivery) => Effect.Effect<ReadonlyArray<Admitted>>
  // Stamp the given steer ids consumed, in ONE transaction, re-asserting `consumed_seq IS NULL` so a
  // concurrent drain can never re-claim them. Called by the runLoop AFTER the messages are durably
  // persisted (persist-first). Idempotent: already-consumed ids are skipped by the WHERE guard. The
  // `delivery` filter (default "steer") keeps the stamp scoped to the caller's own channel.
  readonly markConsumed: (
    sessionID: SessionID,
    ids: ReadonlyArray<SessionMessage.ID>,
    delivery?: Delivery,
  ) => Effect.Effect<void>
  // Non-consuming peek used by the loop's needsFollowUp decision. `delivery` (default "steer") scopes it.
  readonly hasPending: (sessionID: SessionID, delivery?: Delivery) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionSteer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const findByCorrelation = (sessionID: SessionID, correlationID: string) =>
      db
        .select()
        .from(SessionSteerTable)
        .where(
          and(eq(SessionSteerTable.session_id, sessionID), eq(SessionSteerTable.correlation_id, correlationID)),
        )
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => (row === undefined ? undefined : fromRow(row))),
        )

    const admit: Interface["admit"] = Effect.fn("SessionSteer.admit")(function* (input) {
      const delivery = input.delivery ?? "steer"
      const timeCreated = DateTime.toEpochMillis(yield* DateTime.now)
      // Always server-minted: the canonical durable/V1 message ID is never client-supplied.
      const id = SessionMessage.ID.create()
      const inserted = yield* db
        .insert(SessionSteerTable)
        .values({
          id,
          session_id: input.sessionID,
          correlation_id: input.correlationID,
          prompt: encodePrompt(input.prompt),
          delivery,
          time_created: timeCreated,
        })
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (inserted) return fromRow(inserted)
      // Correlation conflict path: another row with the same (session, correlationID) already exists.
      if (input.correlationID === undefined)
        return yield* Effect.die("SessionSteer.admit: server-generated id conflicted (impossible)")
      const existing = yield* findByCorrelation(input.sessionID, input.correlationID)
      if (!existing) return yield* Effect.die("SessionSteer.admit: conflicting correlation row vanished")
      // Identical payload = idempotent retry; different payload = explicit conflict.
      if (existing.delivery === delivery && Prompt.equivalence(existing.prompt, input.prompt)) return existing
      return yield* Effect.fail(
        new CorrelationConflict({ sessionID: input.sessionID, correlationID: input.correlationID }),
      )
    })

    const pending: Interface["pending"] = Effect.fn("SessionSteer.pending")(function* (sessionID, delivery = "steer") {
      const rows = yield* db
        .select()
        .from(SessionSteerTable)
        .where(
          and(
            eq(SessionSteerTable.session_id, sessionID),
            isNull(SessionSteerTable.consumed_seq),
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
              isNull(SessionSteerTable.consumed_seq),
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
      const row = yield* db
        .select({ seq: SessionSteerTable.seq })
        .from(SessionSteerTable)
        .where(
          and(
            eq(SessionSteerTable.session_id, sessionID),
            isNull(SessionSteerTable.consumed_seq),
            eq(SessionSteerTable.delivery, delivery),
          ),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row !== undefined
    })

    return Service.of({ admit, pending, markConsumed, hasPending })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export * as SessionSteer from "./steer"
