export * as TaskOutbox from "./task-outbox"

import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schedule } from "effect"
import { Database } from "../database/database"
import { Identifier } from "../id/id"
import { SessionV2 } from "../session"
import { SessionV1 } from "../v1/session"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { TaskNotificationOutboxTable, TaskRunTable } from "./sql"

type DatabaseService = Database.Interface["db"]

/** Result text excerpt cap for the parent notification prompt (deterministic, content-derived). */
const EXCERPT_LIMIT = 4_000

export type Options = {
  /** Scan cadence for the daemon loop (default 500ms). */
  readonly scanIntervalMs?: number
  /** Delivery claim lease (default 30s). */
  readonly leaseMs?: number
  /** Attempts before a row dead-letters (default 5). */
  readonly maxAttempts?: number
  /** Base backoff for the first retry (default 1s, doubling per attempt). */
  readonly backoffBaseMs?: number
  /** Backoff ceiling (default 60s). */
  readonly backoffMaxMs?: number
}

/** One claimed `task_notification_outbox` row with the joined terminal run evidence. */
export type Item = {
  readonly id: string
  readonly runID: string
  /**
   * Deterministic prompt message id for the parent notification. The settle transaction derives it
   * from the run id (bijective with the outbox row: `run_id` is UNIQUE), so a crash between the
   * parent-input admission and the delivered mark can only ever converge on the SAME input row.
   */
  readonly messageID: SessionMessage.ID
  readonly parentSessionID: SessionSchema.ID
  readonly runState: typeof TaskRunTable.$inferSelect["state"]
  readonly text: string
  readonly error?: { readonly code: string; readonly message: string }
  readonly attempts: number
}

export interface Interface {
  /** One claim+deliver pass over the oldest due row (serial delivery, FIFO order). */
  readonly tick: Effect.Effect<number>
  /** Forks the cadence loop into the owning scope (idempotent). */
  readonly start: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/TaskOutboxDelivery") {}

/**
 * The parent notification text. Deterministic in the durable row content (run id, terminal state,
 * output/error) — never wall-clock — so an exact delivery retry recomputes the identical prompt and
 * the deterministic message id converges instead of conflicting.
 */
export function notificationText(item: Pick<Item, "runID" | "runState" | "text" | "error">) {
  const excerpt =
    item.text.length > EXCERPT_LIMIT ? `${item.text.slice(0, EXCERPT_LIMIT)}\n…[truncated]` : item.text
  return [
    `Background task ${item.runID} finished with state "${item.runState}".`,
    ...(item.error === undefined ? [] : [`Error (${item.error.code}): ${item.error.message}`]),
    excerpt,
  ]
    .filter((section) => section.length > 0)
    .join("\n\n")
}

const expiredLease = (now: number) =>
  or(isNull(TaskNotificationOutboxTable.lease_expires_at), lte(TaskNotificationOutboxTable.lease_expires_at, now))!

const claimableStatus = (now: number) =>
  or(
    eq(TaskNotificationOutboxTable.status, "pending"),
    // A "delivering" row whose lease expired is a crashed delivery: re-claimable with attempts CAS.
    and(eq(TaskNotificationOutboxTable.status, "delivering"), expiredLease(now)),
  )!

/**
 * Claim the oldest due V2 notification row: pending past `available_at`, or a crashed "delivering"
 * row with an expired lease. The claim CAS installs the lease owner and bumps attempts inside one
 * IMMEDIATE transaction. Rows whose run is `execution_runtime='v1'` are invisible here — they
 * belong to the historical app-layer delivery loop.
 */
export const claim = Effect.fn("TaskOutbox.claim")(function* (
  db: DatabaseService,
  input: {
    readonly ownerToken: string
    readonly leaseMs?: number
    readonly now?: number
  },
) {
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const candidate = yield* tx
          .select({
            outbox: TaskNotificationOutboxTable,
            runState: TaskRunTable.state,
            runError: TaskRunTable.error,
          })
          .from(TaskNotificationOutboxTable)
          .innerJoin(TaskRunTable, eq(TaskRunTable.run_id, TaskNotificationOutboxTable.run_id))
          .where(
            and(
              eq(TaskRunTable.execution_runtime, "v2"),
              lte(TaskNotificationOutboxTable.available_at, now),
              claimableStatus(now),
            ),
          )
          .orderBy(asc(TaskNotificationOutboxTable.time_created), asc(TaskNotificationOutboxTable.id))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (candidate === undefined) return undefined

        const updated = yield* tx
          .update(TaskNotificationOutboxTable)
          .set({
            status: "delivering",
            lease_owner: input.ownerToken,
            lease_expires_at: now + (input.leaseMs ?? 30_000),
            attempts: candidate.outbox.attempts + 1,
            time_updated: now,
          })
          .where(
            and(
              eq(TaskNotificationOutboxTable.id, candidate.outbox.id),
              eq(TaskNotificationOutboxTable.attempts, candidate.outbox.attempts),
              lte(TaskNotificationOutboxTable.available_at, now),
              claimableStatus(now),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (updated === undefined) return undefined
        return toItem(updated, candidate.runState, candidate.runError)
      }),
    { behavior: "immediate" },
  )
})

export const make = (options: Options = {}) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sessions = yield* SessionV2.Service
    const scope = yield* Effect.scope
    const ownerToken = `core-v2-task-outbox:${Identifier.ascending("job")}`
    const leaseMs = options.leaseMs ?? 30_000
    const maxAttempts = options.maxAttempts ?? 5
    let closed = false
    let loopStarted = false
    yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true }))

    // Delivery = ONE durable session_input admission into the parent with the deterministic message
    // id and the `queue` delivery mode (opens a future activity instead of steering). SessionV2.prompt
    // schedules the advisory SessionExecution wake itself — the parent pickup rides the existing
    // drain machinery, never a second path built here.
    const deliverOne = (item: Item) =>
      Effect.gen(function* () {
        yield* sessions.prompt({
          id: item.messageID,
          sessionID: item.parentSessionID,
          prompt: new Prompt({ text: notificationText(item) }),
          delivery: "queue",
        })
        const delivered = yield* markDelivered(db, item, ownerToken)
        // The admission is committed and exactly-once by the deterministic id; a lost lease only
        // means a later claim re-observes the same input row before it can mark delivered.
        if (!delivered)
          yield* Effect.logWarning("TaskOutbox: delivery lost its lease after admission; a re-claim converges", {
            id: item.id,
          })
      }).pipe(Effect.catchCause((cause) => onDeliveryFailure(item, cause)))

    const onDeliveryFailure = (item: Item, cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        const failure = Cause.squash(cause)
        const reason = failureMessage(failure)
        // A conflicting deterministic id or a vanished parent is permanent — dead-letter at once.
        // Everything else retries with backoff until the bounded attempts are exhausted.
        const fatal =
          failure instanceof SessionV2.PromptConflictError || failure instanceof SessionV2.NotFoundError
        if (fatal || item.attempts >= maxAttempts) {
          yield* markDead(db, item, ownerToken, reason)
          yield* Effect.logError("TaskOutbox: notification dead-lettered", { id: item.id, reason })
          return
        }
        yield* release(db, item, ownerToken, reason, backoffMs(item.attempts))
        yield* Effect.logWarning("TaskOutbox: delivery failed; retrying with backoff", { id: item.id, reason })
      })

    const backoffMs = (attempts: number) =>
      Math.min((options.backoffBaseMs ?? 1_000) * 2 ** Math.max(0, attempts - 1), options.backoffMaxMs ?? 60_000)

    const tick: Effect.Effect<number> = Effect.gen(function* () {
      if (closed) return 0
      const item = yield* claim(db, { ownerToken, leaseMs }).pipe(Effect.orDie)
      if (item === undefined) return 0
      yield* deliverOne(item)
      return 1
    })

    const start = Effect.suspend(() => {
      // The suspend body is synchronous, so check-and-set guards against a concurrent double start.
      if (loopStarted || closed) return Effect.void
      loopStarted = true
      return tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("TaskOutbox: delivery tick failed", cause).pipe(Effect.as(0)),
        ),
        Effect.repeat(Schedule.fixed(options.scanIntervalMs ?? 500)),
        Effect.asVoid,
        Effect.forkIn(scope),
      )
    })

    return Service.of({ tick, start })
  })

/** Manual-tick service; the daemon loop is started by {@link startedLayer}. */
export const layer = (options: Options = {}) => Layer.effect(Service, make(options))

export const startedLayer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.flatMap(make(options), (delivery) => delivery.start.pipe(Effect.as(delivery))),
  )

// ── Row state transitions (lease-owner + attempts CAS) ────────────────────────────────────────

const markDelivered = (db: DatabaseService, item: Item, ownerToken: string) => {
  const now = Date.now()
  return db
    .update(TaskNotificationOutboxTable)
    .set({
      status: "delivered",
      parent_input_message_id: SessionV1.MessageID.make(item.messageID),
      time_delivered: now,
      time_updated: now,
      lease_owner: null,
      lease_expires_at: null,
      last_error: null,
    })
    .where(
      and(
        eq(TaskNotificationOutboxTable.id, item.id),
        eq(TaskNotificationOutboxTable.status, "delivering"),
        eq(TaskNotificationOutboxTable.lease_owner, ownerToken),
        eq(TaskNotificationOutboxTable.attempts, item.attempts),
        gt(TaskNotificationOutboxTable.lease_expires_at, now),
      ),
    )
    .returning({ id: TaskNotificationOutboxTable.id })
    .get()
    .pipe(Effect.orDie)
    .pipe(Effect.map((row) => row !== undefined))
}

const release = (
  db: DatabaseService,
  item: Item,
  ownerToken: string,
  reason: string,
  delayMs: number,
) => {
  const now = Date.now()
  return db
    .update(TaskNotificationOutboxTable)
    .set({
      status: "pending",
      available_at: now + delayMs,
      last_error: reason,
      time_updated: now,
      lease_owner: null,
      lease_expires_at: null,
    })
    .where(
      and(
        eq(TaskNotificationOutboxTable.id, item.id),
        eq(TaskNotificationOutboxTable.status, "delivering"),
        eq(TaskNotificationOutboxTable.lease_owner, ownerToken),
        eq(TaskNotificationOutboxTable.attempts, item.attempts),
      ),
    )
    .run()
    .pipe(Effect.orDie)
}

const markDead = (db: DatabaseService, item: Item, ownerToken: string, reason: string) => {
  const now = Date.now()
  return db
    .update(TaskNotificationOutboxTable)
    .set({
      status: "dead",
      last_error: reason,
      time_updated: now,
      lease_owner: null,
      lease_expires_at: null,
    })
    .where(
      and(
        eq(TaskNotificationOutboxTable.id, item.id),
        eq(TaskNotificationOutboxTable.status, "delivering"),
        eq(TaskNotificationOutboxTable.lease_owner, ownerToken),
        eq(TaskNotificationOutboxTable.attempts, item.attempts),
      ),
    )
    .run()
    .pipe(Effect.orDie)
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

const toItem = (
  row: typeof TaskNotificationOutboxTable.$inferSelect,
  runState: Item["runState"],
  runError: Item["error"] | null,
): Item => ({
  id: row.id,
  runID: row.run_id,
  messageID: SessionMessage.ID.make(row.message_id),
  parentSessionID: row.parent_session_id,
  runState,
  text: row.payload.text,
  ...(runError === null || runError === undefined ? {} : { error: { code: runError.code, message: runError.message } }),
  attempts: row.attempts,
})

const failureMessage = (failure: unknown) => {
  const message = failure instanceof Error && failure.message.trim() ? failure.message : String(failure ?? "unknown")
  return message.slice(0, 300)
}
