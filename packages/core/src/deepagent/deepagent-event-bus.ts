export * as DeepAgentEventBus from "./deepagent-event-bus"

import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { and, asc, desc, eq, lte, gt } from "drizzle-orm"
import { Database } from "../database/database"
import { DeepAgentEventDeliveryTable, DeepAgentEventTable } from "./deepagent-event-sql"
import { DeepAgentEvent } from "./deepagent-event"

// V4.0 §A2 — the Event Bus service. Implements the §A2 contract (publish / subscribe / ack / nack /
// replay) on the durable `deepagent_event` + `deepagent_event_delivery` tables (deepagent-event-sql.ts).
//
// DESIGN PRINCIPLE 1 (事件先持久化，再分发): `publish` writes the event row inside a transaction and
// ONLY THEN fans it out to live subscribers. A process crash between persist and dispatch loses no
// event — a subscriber that reconnects reads durable history via `replay`.
//
// §A3 contract enforced here:
//   持久化   : publish returns success only after the row is committed.
//   幂等     : idempotency_key is UNIQUE; a re-publish with the same key is a no-op returning the
//              already-persisted event (never a second row, never a second dispatch).
//   顺序     : same-`correlationID` events keep causal order (single-writer append + created_at asc);
//              no global cross-correlation order is promised (§K non-goal).
//   重试     : failed deliveries schedule an exponential backoff (base 1s, ×2 per attempt), default 3.
//   Dead Letter: attempts beyond the cap flip delivery.status → "dead" (the DLQ view).
//
// LAYERING: `core`. No LSP / panel / task-tool / session imports. The Router (§A4, deepagent-code)
// subscribes here and dispatches to sessions/agents; this service never touches the runtime itself.

// §A3 重试 defaults. Overridable per layer for tests / per-workspace tuning later.
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_BACKOFF_BASE_MS = 1000

// §A4 去重窗口: within this window, a duplicate low-priority event of the same type is merged. The bus
// exposes the primitive (recentByType); the Router applies the merge policy.
export const DEFAULT_DEDUPE_WINDOW_MS = 10_000

export interface DeliveryTracker {
  readonly eventID: DeepAgentEvent.ID
  readonly subscriptionGroup: string
  readonly status: "pending" | "delivered" | "dead"
  readonly attempts: number
  readonly lastError?: string
  readonly nextAttemptAt?: number
}

export interface Interface {
  /**
   * §A3 持久化 + 幂等. Normalizes a PublishInput into a full DeepAgentEvent, commits it, then dispatches
   * to live subscribers. A duplicate idempotency_key returns the existing event without re-dispatch.
   */
  readonly publish: (input: DeepAgentEvent.PublishInput) => Effect.Effect<DeepAgentEvent.Event>
  /**
   * Live stream of newly published events (post-persist). Historical events come from `replay`.
   *
   * DELIVERY TRACKING: when `group` is supplied the subscriber joins a durable consumer group — for
   * the lifetime of the stream's scope the bus records a `pending` delivery row for that group on
   * every matching `publish` (BEFORE the event reaches the stream), so a crash between receipt and
   * `ack` is recoverable via `dueRetries` (§A3 at-least-once). The consumer MUST `ack`/`nack` each
   * event. Group-less subscribers are anonymous observers: pure live broadcast, no delivery tracking,
   * best-effort only. Multi-worker competing-consumer WITHIN one group is a distributed-backend
   * concern (§A2 Redis/Kafka); the in-memory bus broadcasts to every live stream of the group.
   */
  readonly subscribe: (input: {
    readonly type?: string
    readonly group?: string
  }) => Stream.Stream<DeepAgentEvent.Event>
  /** §A2 ack — mark a (event, group) delivery successful. Idempotent. */
  readonly ack: (subscriptionGroup: string, eventID: DeepAgentEvent.ID) => Effect.Effect<void>
  /** §A2 nack — record a failed delivery; schedules retry or flips to DLQ past the attempt cap. */
  readonly nack: (input: {
    readonly subscriptionGroup: string
    readonly eventID: DeepAgentEvent.ID
    readonly reason: string
  }) => Effect.Effect<void>
  /** §A2 replay — durable history for a type/time window (crash recovery + late subscribers). */
  readonly replay: (input: {
    readonly type?: string
    readonly workspaceID?: string
    readonly from: number
    readonly to?: number
  }) => Stream.Stream<DeepAgentEvent.Event>
  /**
   * §A4 去重窗口 primitive — recent same-type events for the Router's dedupe merge. Pass `workspaceID`
   * to scope the window to one tenant (the Router MUST, so a duplicate in workspace A never suppresses
   * an event in workspace B); omit only for cross-tenant maintenance scans.
   */
  readonly recentByType: (input: {
    readonly type: string
    readonly workspaceID?: string
    readonly windowMs?: number
    readonly now?: number
  }) => Effect.Effect<ReadonlyArray<DeepAgentEvent.Event>>
  /** §A Dead Letter view — deliveries that exhausted retries. */
  readonly deadLetters: () => Effect.Effect<ReadonlyArray<DeliveryTracker>>
  /** §A3 retry scan — pending deliveries whose backoff has elapsed (Router/Scheduler drives re-delivery). */
  readonly dueRetries: (now?: number) => Effect.Effect<ReadonlyArray<DeliveryTracker>>
  /** Load a single event by id from the durable log — used by the retry pump to re-dispatch a nacked delivery. */
  readonly getByID: (eventID: DeepAgentEvent.ID) => Effect.Effect<DeepAgentEvent.Event | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/DeepAgentEventBus") {}

export interface LayerOptions {
  readonly maxAttempts?: number
  readonly backoffBaseMs?: number
  readonly now?: () => number
}

const decodeRow = (row: {
  id: string
  type: string
  source: string
  workspace_id: string
  project_id: string | null
  actor_id: string | null
  correlation_id: string | null
  causation_id: string | null
  idempotency_key: string
  priority: string
  payload: unknown
  created_at: number
}): DeepAgentEvent.Event => ({
  id: row.id as DeepAgentEvent.ID,
  type: row.type,
  source: row.source as DeepAgentEvent.EventSource,
  workspaceID: row.workspace_id,
  ...(row.project_id != null ? { projectID: row.project_id } : {}),
  ...(row.actor_id != null ? { actorID: row.actor_id } : {}),
  ...(row.correlation_id != null ? { correlationID: row.correlation_id } : {}),
  ...(row.causation_id != null ? { causationID: row.causation_id } : {}),
  idempotencyKey: row.idempotency_key,
  priority: row.priority as DeepAgentEvent.EventPriority,
  createdAt: row.created_at,
  payload: row.payload ?? undefined,
})

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
      const backoffBaseMs = options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
      const now = options?.now ?? Date.now
      const live = yield* PubSub.unbounded<DeepAgentEvent.Event>()

      yield* Effect.addFinalizer(() => PubSub.shutdown(live))

      // §A3 at-least-once — the set of consumer groups with a live `subscribe({group})` stream, and
      // the type filter each declared. `publish` writes a durable `pending` delivery row for every
      // group whose filter matches, so an event owed to a group survives a crash between receipt and
      // ack (recoverable via `dueRetries`). Ref-counted: a group is registered while ≥1 of its streams
      // is live and dropped when the last unsubscribes, so we never accrue deliveries no one consumes.
      const groups = new Map<string, { types: Map<string | null, number> }>()
      const registerGroup = (group: string, type: string | null) =>
        Effect.sync(() => {
          const entry = groups.get(group) ?? { types: new Map<string | null, number>() }
          entry.types.set(type, (entry.types.get(type) ?? 0) + 1)
          groups.set(group, entry)
        })
      const unregisterGroup = (group: string, type: string | null) =>
        Effect.sync(() => {
          const entry = groups.get(group)
          if (!entry) return
          const next = (entry.types.get(type) ?? 0) - 1
          if (next <= 0) entry.types.delete(type)
          else entry.types.set(type, next)
          if (entry.types.size === 0) groups.delete(group)
        })
      // groups owed a delivery for `event`: any live group with a wildcard (null) filter or a filter
      // matching the event's type.
      const groupsFor = (eventType: string): ReadonlyArray<string> => {
        const out: string[] = []
        for (const [group, entry] of groups) {
          if (entry.types.has(null) || entry.types.has(eventType)) out.push(group)
        }
        return out
      }

      const publish: Interface["publish"] = (input) =>
        Effect.gen(function* () {
          // §A3 幂等: if an event with this idempotency key exists, return it without a second row/dispatch.
          const key = input.idempotencyKey ?? DeepAgentEvent.ID.create()
          const existing = yield* db
            .select()
            .from(DeepAgentEventTable)
            .where(eq(DeepAgentEventTable.idempotency_key, key))
            .get()
            .pipe(Effect.orDie)
          if (existing) return decodeRow(existing)

          const createdAt = now()
          const event: DeepAgentEvent.Event = {
            id: DeepAgentEvent.ID.create(createdAt), // §A1: id time component tracks createdAt (#7)
            type: input.type,
            source: input.source,
            workspaceID: input.workspaceID,
            ...(input.projectID != null ? { projectID: input.projectID } : {}),
            ...(input.actorID != null ? { actorID: input.actorID } : {}),
            ...(input.correlationID != null ? { correlationID: input.correlationID } : {}),
            ...(input.causationID != null ? { causationID: input.causationID } : {}),
            idempotencyKey: key,
            priority: input.priority ?? "normal",
            createdAt,
            payload: input.payload,
          }

          // §A3 持久化 + at-least-once: in ONE immediate transaction, insert the event row and — only
          // if WE won the insert — a `pending` delivery row per live consumer group owed this type.
          // `.returning()` tells us whether the insert actually landed (a racing duplicate that slips
          // past the read-check above hits UNIQUE(idempotency_key) → 0 rows → not the winner). Dispatch
          // happens AFTER commit, so a subscriber never observes an uncommitted event.
          const owed = groupsFor(event.type)
          const wonInsert = yield* db
            .transaction(
              () =>
                Effect.gen(function* () {
                  const returned = yield* db
                    .insert(DeepAgentEventTable)
                    .values([
                      {
                        id: event.id,
                        type: event.type,
                        source: event.source,
                        workspace_id: event.workspaceID,
                        project_id: event.projectID ?? null,
                        actor_id: event.actorID ?? null,
                        correlation_id: event.correlationID ?? null,
                        causation_id: event.causationID ?? null,
                        idempotency_key: event.idempotencyKey,
                        priority: event.priority,
                        payload: event.payload ?? null,
                        created_at: event.createdAt,
                      },
                    ])
                    .onConflictDoNothing({ target: DeepAgentEventTable.idempotency_key })
                    .returning({ id: DeepAgentEventTable.id })
                    .all()
                    .pipe(Effect.orDie)
                  const won = returned.length > 0
                  if (won && owed.length > 0) {
                    yield* db
                      .insert(DeepAgentEventDeliveryTable)
                      .values(
                        owed.map((group) => ({
                          event_id: event.id,
                          subscription_group: group,
                          status: "pending" as const,
                          attempts: 0,
                          last_error: null,
                          next_attempt_at: createdAt, // owed immediately until acked
                          created_at: createdAt,
                          updated_at: createdAt,
                        })),
                      )
                      // a group already tracked for this event (shouldn't happen pre-dispatch) is a no-op.
                      .onConflictDoNothing({
                        target: [
                          DeepAgentEventDeliveryTable.event_id,
                          DeepAgentEventDeliveryTable.subscription_group,
                        ],
                      })
                      .run()
                      .pipe(Effect.orDie)
                  }
                  return won
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)

          if (!wonInsert) {
            // Idempotent no-op: the winner's row is authoritative — return it, never re-dispatch.
            const winner = yield* db
              .select()
              .from(DeepAgentEventTable)
              .where(eq(DeepAgentEventTable.idempotency_key, key))
              .get()
              .pipe(Effect.orDie)
            return winner ? decodeRow(winner) : event
          }
          yield* PubSub.publish(live, event)
          return event
        })

      const subscribe: Interface["subscribe"] = (input) => {
        const filtered = Stream.fromPubSub(live).pipe(
          Stream.filter((event) => (input.type ? event.type === input.type : true)),
        )
        // A grouped subscriber declares a durable consumer group: register it for the stream's scope so
        // `publish` writes `pending` delivery rows it must ack (§A3 at-least-once). Anonymous
        // subscribers (no group) are pure live observers — no delivery tracking.
        if (input.group == null) return filtered
        const group = input.group
        const type = input.type ?? null
        return filtered.pipe(
          Stream.onStart(registerGroup(group, type)),
          Stream.ensuring(unregisterGroup(group, type)),
        )
      }

      const ack: Interface["ack"] = (subscriptionGroup, eventID) => {
        const at = now()
        return db
          .insert(DeepAgentEventDeliveryTable)
          .values([
            {
              event_id: eventID,
              subscription_group: subscriptionGroup,
              status: "delivered",
              attempts: 0, // ack of a never-failed delivery: no attempt was consumed (#8)
              last_error: null,
              next_attempt_at: null,
              created_at: at,
              updated_at: at,
            },
          ])
          .onConflictDoUpdate({
            target: [DeepAgentEventDeliveryTable.event_id, DeepAgentEventDeliveryTable.subscription_group],
            // clear retry state; leave `attempts` as the historical count of prior failures.
            set: { status: "delivered", last_error: null, next_attempt_at: null, updated_at: at },
          })
          .run()
          .pipe(Effect.orDie, Effect.asVoid)
      }

      // §A3 重试 — record a failed delivery. The read-modify-write on `attempts` runs inside an
      // immediate transaction wrapped in `Effect.uninterruptible` (mirroring event.ts) so two
      // concurrent nacks for the same (event, group) can't both read attempts=N and both write N+1 —
      // the second serializes behind the first and reads N+1. Without this the DLQ transition
      // (attempts ≥ maxAttempts) could be delayed or skipped under concurrent failures.
      const nack: Interface["nack"] = (input) =>
        Effect.uninterruptible(
          db
            .transaction(
              () =>
                Effect.gen(function* () {
                  const current = yield* db
                    .select()
                    .from(DeepAgentEventDeliveryTable)
                    .where(
                      and(
                        eq(DeepAgentEventDeliveryTable.event_id, input.eventID),
                        eq(DeepAgentEventDeliveryTable.subscription_group, input.subscriptionGroup),
                      ),
                    )
                    .get()
                    .pipe(Effect.orDie)
                  const attempts = (current?.attempts ?? 0) + 1
                  // §A Dead Letter: past the cap the delivery is dead (surfaces in the DLQ view); else
                  // schedule the next retry with exponential backoff (base × 2^(attempts-1)).
                  const dead = attempts >= maxAttempts
                  const at = now()
                  const nextAttemptAt = dead ? null : at + backoffBaseMs * 2 ** (attempts - 1)
                  yield* db
                    .insert(DeepAgentEventDeliveryTable)
                    .values([
                      {
                        event_id: input.eventID,
                        subscription_group: input.subscriptionGroup,
                        status: dead ? "dead" : "pending",
                        attempts,
                        last_error: input.reason,
                        next_attempt_at: nextAttemptAt,
                        created_at: at,
                        updated_at: at,
                      },
                    ])
                    .onConflictDoUpdate({
                      target: [
                        DeepAgentEventDeliveryTable.event_id,
                        DeepAgentEventDeliveryTable.subscription_group,
                      ],
                      set: {
                        status: dead ? "dead" : "pending",
                        attempts,
                        last_error: input.reason,
                        next_attempt_at: nextAttemptAt,
                        updated_at: at,
                      },
                    })
                    .run()
                    .pipe(Effect.orDie)
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie),
        )

      const replay: Interface["replay"] = (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const conditions = [gt(DeepAgentEventTable.created_at, input.from - 1)]
            if (input.to != null) conditions.push(lte(DeepAgentEventTable.created_at, input.to))
            if (input.type != null) conditions.push(eq(DeepAgentEventTable.type, input.type))
            if (input.workspaceID != null)
              conditions.push(eq(DeepAgentEventTable.workspace_id, input.workspaceID))
            const rows = yield* db
              .select()
              .from(DeepAgentEventTable)
              .where(and(...conditions))
              // id tiebreak: created_at is ms-resolution, so same-ms events would otherwise order
              // nondeterministically — breaking the §A3 same-correlation causal-order guarantee. ids
              // are ascending-monotonic, so (created_at asc, id asc) is a total, stable order (#4).
              .orderBy(asc(DeepAgentEventTable.created_at), asc(DeepAgentEventTable.id))
              .all()
              .pipe(Effect.orDie)
            return Stream.fromIterable(rows.map(decodeRow))
          }),
        )

      const recentByType: Interface["recentByType"] = (input) =>
        Effect.gen(function* () {
          const windowMs = input.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS
          const at = input.now ?? now()
          const conditions = [
            eq(DeepAgentEventTable.type, input.type),
            gt(DeepAgentEventTable.created_at, at - windowMs),
          ]
          // §多租户: scope the dedupe window to one workspace so a duplicate in A can't suppress B (#5).
          if (input.workspaceID != null)
            conditions.push(eq(DeepAgentEventTable.workspace_id, input.workspaceID))
          const rows = yield* db
            .select()
            .from(DeepAgentEventTable)
            .where(and(...conditions))
            .orderBy(desc(DeepAgentEventTable.created_at), desc(DeepAgentEventTable.id))
            .all()
            .pipe(Effect.orDie)
          return rows.map(decodeRow)
        })

      const trackerOf = (row: {
        event_id: string
        subscription_group: string
        status: string
        attempts: number
        last_error: string | null
        next_attempt_at: number | null
      }): DeliveryTracker => ({
        eventID: row.event_id as DeepAgentEvent.ID,
        subscriptionGroup: row.subscription_group,
        status: row.status as DeliveryTracker["status"],
        attempts: row.attempts,
        ...(row.last_error != null ? { lastError: row.last_error } : {}),
        ...(row.next_attempt_at != null ? { nextAttemptAt: row.next_attempt_at } : {}),
      })

      const deadLetters: Interface["deadLetters"] = () =>
        db
          .select()
          .from(DeepAgentEventDeliveryTable)
          .where(eq(DeepAgentEventDeliveryTable.status, "dead"))
          .all()
          .pipe(Effect.orDie, Effect.map((rows) => rows.map(trackerOf)))

      const dueRetries: Interface["dueRetries"] = (nowArg) =>
        Effect.gen(function* () {
          const at = nowArg ?? now()
          const rows = yield* db
            .select()
            .from(DeepAgentEventDeliveryTable)
            .where(
              and(
                eq(DeepAgentEventDeliveryTable.status, "pending"),
                lte(DeepAgentEventDeliveryTable.next_attempt_at, at),
              ),
            )
            .orderBy(asc(DeepAgentEventDeliveryTable.next_attempt_at))
            .all()
            .pipe(Effect.orDie)
          return rows.map(trackerOf)
        })

      const getByID: Interface["getByID"] = (eventID) =>
        db
          .select()
          .from(DeepAgentEventTable)
          .where(eq(DeepAgentEventTable.id, eventID))
          .get()
          .pipe(Effect.orDie, Effect.map((row) => (row ? decodeRow(row) : undefined)))

      return Service.of({
        publish,
        subscribe,
        ack,
        nack,
        replay,
        recentByType,
        deadLetters,
        dueRetries,
        getByID,
      })
    }),
  )

export const layer = layerWith()

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
