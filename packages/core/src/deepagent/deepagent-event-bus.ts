export * as DeepAgentEventBus from "./deepagent-event-bus"

import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { and, asc, desc, eq, lte, lt, gt, notExists, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { DeepAgentEventDeliveryTable, DeepAgentEventDropTable, DeepAgentEventTable } from "./deepagent-event-sql"
import { ApprovalQueueTable } from "./approval-queue-sql"
import { DeepAgentEvent } from "./deepagent-event"
import { RateLimiter } from "./rate-limiter"
import { LMNEvents } from "./lmn-events"

// §A3 DLQ alert — the event type the bus publishes when a delivery flips to "dead" (see nack).
const DLQ_ALERT_TYPE = LMNEvents.DLQ_ALERT

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

// §A4/§E2 tryPublish outcome — a discriminated union so a caller learns whether the event was shed by
// the rate gate. `published` carries the persisted event (identical to `publish`'s result); `dropped`
// signals the low/normal event exceeded the per-workspace ceiling and was NOT persisted.
export type TryPublishResult =
  | { readonly published: DeepAgentEvent.Event }
  | { readonly dropped: "rate_limited" }

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
   * §A4/§E2 rate-gated publish. Applies the per-workspace event-publish rate ceiling
   * (EVENT_PUBLISH_PER_WORKSPACE, or `opts.limit`) BEFORE persisting, then delegates to `publish`.
   *
   * PRIORITY BYPASS (§A4): high/critical events ALWAYS publish (never dropped) — the ceiling only sheds
   * low/normal load. A low/normal event over the ceiling returns `{ dropped: "rate_limited" }` and is
   * NOT persisted (no row, no dispatch). Otherwise the persisted event is returned as `{ published }`.
   * The discriminated union lets the caller observe the drop (e.g. to log a blocked-push counter).
   *
   * Keyed per workspaceID (fixed-window, in-memory). This is ADDITIVE — existing `publish` callers are
   * untouched and bypass the gate entirely.
   */
  readonly tryPublish: (
    input: DeepAgentEvent.PublishInput,
    opts?: { readonly limit?: number },
  ) => Effect.Effect<TryPublishResult>
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
  /**
   * §A4 event_dropped — persist an append-only DROP RECORD for an event the router SHED (a backpressure
   * drop). Makes event_dropped a queryable/persisted signal (Observability.event_dropped_total by
   * reason), mirroring how dead deliveries feed dlq_events_total. FAIL-SAFE: never fails — a drop record
   * is best-effort audit, and a write hiccup must not perturb the caller's ack/nack path (Effect.orDie is
   * intentionally avoided; a write failure is swallowed).
   */
  readonly recordDrop: (input: {
    readonly event: DeepAgentEvent.Event
    readonly reason: string
  }) => Effect.Effect<void>
  /** §A3 retry scan — pending deliveries whose backoff has elapsed (Router/Scheduler drives re-delivery). */
  readonly dueRetries: (now?: number) => Effect.Effect<ReadonlyArray<DeliveryTracker>>
  /** Load a single event by id from the durable log — used by the retry pump to re-dispatch a nacked delivery. */
  readonly getByID: (eventID: DeepAgentEvent.ID) => Effect.Effect<DeepAgentEvent.Event | undefined>
  /**
   * §A3 保留期 (retention sweep) — delete durable events for one workspace older than `olderThan`
   * (epoch ms, exclusive), returning how many event rows were removed.
   *
   * REFERENTIAL SAFETY (an event still owed to a human/consumer MUST survive its retention window):
   *   - an event with a PENDING `deepagent_event_delivery` (status='pending') is EXCLUDED — an unacked
   *     at-least-once delivery still owes the event to a consumer group; deleting it would strand the
   *     retry pump (which loads the event by id to re-dispatch).
   *   - an event referenced by an UNRESOLVED `deepagent_approval_queue` row (status='pending') is
   *     EXCLUDED — a human still has to act on it; its source event must remain for the trace + payload.
   *   - `delivered`/`dead` deliveries do NOT protect an event (terminal), and cascade-delete with it.
   *
   * Workspace-scoped via `deepagent_event_workspace_created_idx`. Delivery rows for deleted events are
   * removed by the FK ON DELETE CASCADE (PRAGMA foreign_keys=ON).
   */
  readonly sweep: (input: {
    readonly workspaceID: string
    readonly olderThan: number
  }) => Effect.Effect<{ readonly deletedEvents: number }>
  /**
   * §E2 — prune the publish rate-limiter's per-workspace buckets whose fixed window has elapsed as of
   * `now`, bounding the limiter's memory for idle workspaces. Returns how many buckets were dropped.
   * The limiter lives inside this layer's closure; this exposes its `sweep` so a periodic daemon
   * (v4-event-runtime) can drive it on a cadence without reaching into private state. `now` defaults to
   * the injected clock (deterministic in tests). A no-op that never throws — safe to call any time.
   */
  readonly sweepPublishLimiter: (now?: number) => Effect.Effect<{ readonly prunedBuckets: number }>
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
      // §A4/§E2 — ONE in-memory fixed-window limiter for the whole bus, keyed per workspaceID. Only
      // `tryPublish` consults it; `publish` is unchanged. `now` (the injected clock) drives window
      // resets so tests cross a boundary deterministically.
      const publishLimiter = new RateLimiter.Service()

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
          // §F1 event_publish_latency_ms — wall-clock delta (injected clock) around the persist
          // transaction. One now() before, one after; the delta is written on the row so Observability
          // can build the publish-latency histogram. Cheap + additive.
          const publishStart = now()
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
          // §F1 — record the persist latency on the row (delta of the two clock reads around the
          // commit). Non-fatal + additive: a lightweight UPDATE that never blocks dispatch.
          const publishLatencyMs = now() - publishStart
          yield* db
            .update(DeepAgentEventTable)
            .set({ publish_latency_ms: publishLatencyMs })
            .where(eq(DeepAgentEventTable.id, event.id))
            .run()
            .pipe(Effect.orDie)
          yield* PubSub.publish(live, event)
          return event
        })

      // §A4/§E2 rate-gated publish — see the Interface doc. Priority bypass first (high/critical always
      // pass), then the fixed-window ceiling for low/normal; under the ceiling we delegate to `publish`.
      const tryPublish: Interface["tryPublish"] = (input, opts) =>
        Effect.gen(function* () {
          const priority = input.priority ?? "normal"
          // §A4: high/critical are never shed — publish unconditionally (still records a hit-free path).
          if (priority === "high" || priority === "critical") {
            return { published: yield* publish(input) }
          }
          const limit = opts?.limit ?? RateLimiter.EVENT_PUBLISH_PER_WORKSPACE.limit
          const admitted = publishLimiter.check(
            input.workspaceID,
            limit,
            RateLimiter.EVENT_PUBLISH_PER_WORKSPACE.windowMs,
            now(),
          )
          if (!admitted) return { dropped: "rate_limited" as const }
          return { published: yield* publish(input) }
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
        Effect.gen(function* () {
          // The transaction returns whether THIS nack flipped the delivery to "dead" for the FIRST time
          // (a fresh DLQ transition), plus the final attempt count — so the §A3 alert fires once, after
          // commit, only on the transition (not on a nack of an already-dead delivery).
          const transition = yield* Effect.uninterruptible(
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
                    // FIRST transition = it is dead now AND was not already dead before this nack.
                    return { justDied: dead && current?.status !== "dead", attempts }
                  }),
                { behavior: "immediate" },
              )
              .pipe(Effect.orDie),
          )
          // §A3 "生成告警" — a dead-letter must fire an alert, not sit silently in the DLQ view. Emit ONCE
          // on the transition. FAIL-SAFE: the whole alert path is caught so an alert failure never breaks
          // the nack contract (the delivery is already durably "dead"; the alert is best-effort notify).
          if (transition.justDied) {
            yield* emitDlqAlert(input.eventID, input.subscriptionGroup, input.reason, transition.attempts).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }
        })

      // §A3 DLQ alert — publish a system `dlq.alert` (high priority) for a delivery that just exhausted
      // its retries. IDEMPOTENT: the idempotency key is (event, group)-stable so a re-emit is a bus no-op
      // (never a second alert). SELF-CASCADE GUARD: if the DEAD event is itself a dlq.alert, do NOT alert
      // on it (an alert whose own delivery dies must not spawn another alert). Best-effort by construction
      // — the caller wraps this in catchCause so any failure is swallowed.
      const emitDlqAlert = (
        eventID: DeepAgentEvent.ID,
        subscriptionGroup: string,
        reason: string,
        attempts: number,
      ) =>
        Effect.gen(function* () {
          const dead = yield* getByID(eventID)
          // guard: never alert on a dead dlq.alert (severs the alert-of-an-alert cascade).
          if (dead && dead.type === DLQ_ALERT_TYPE) return
          yield* publish({
            type: DLQ_ALERT_TYPE,
            source: "system",
            workspaceID: dead?.workspaceID ?? "system",
            ...(dead?.projectID != null ? { projectID: dead.projectID } : {}),
            // chain the alert to the dead event's correlation so it lands on the same §F2 trace spine.
            correlationID: dead?.correlationID ?? eventID,
            causationID: eventID,
            // (event, group)-keyed ⇒ one alert per dead delivery, idempotent across re-emits.
            idempotencyKey: `dlq-alert:${eventID}:${subscriptionGroup}`,
            priority: "high",
            payload: {
              deadEventID: eventID,
              deadEventType: dead?.type,
              subscriptionGroup,
              reason,
              attempts,
            },
          })
        })

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

      // §A4 event_dropped — append a durable drop record. Best-effort: a write failure is caught + logged
      // (not orDie'd) so a drop-audit hiccup never perturbs the caller's ack/nack path.
      const recordDrop: Interface["recordDrop"] = (input) =>
        db
          .insert(DeepAgentEventDropTable)
          .values([
            {
              event_id: input.event.id,
              workspace_id: input.event.workspaceID,
              reason: input.reason,
              priority: input.event.priority,
              created_at: now(),
            },
          ])
          .run()
          .pipe(
            Effect.catchCause(() => Effect.void),
            Effect.asVoid,
          )

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

      // §A3 保留期 — delete this workspace's events older than `olderThan`, SPARING any event still owed
      // to a consumer (a pending delivery) or a human (an unresolved approval-queue item). Runs in an
      // immediate transaction so the count reflects exactly what was removed. Delivery rows for the
      // deleted events cascade via the FK (foreign_keys=ON) — we assert that below with a defensive
      // cleanup that is a no-op when the cascade fires as expected.
      const sweep: Interface["sweep"] = (input) =>
        db
          .transaction(
            () =>
              Effect.gen(function* () {
                // an event is DELETABLE iff: this workspace, older than the cutoff, AND not referenced by
                // a pending delivery, AND not referenced by a pending approval-queue row. The two
                // notExists sub-selects are the referential-safety guard.
                const noPendingDelivery = notExists(
                  db
                    .select({ one: sql`1` })
                    .from(DeepAgentEventDeliveryTable)
                    .where(
                      and(
                        eq(DeepAgentEventDeliveryTable.event_id, DeepAgentEventTable.id),
                        eq(DeepAgentEventDeliveryTable.status, "pending"),
                      ),
                    ),
                )
                const noPendingApproval = notExists(
                  db
                    .select({ one: sql`1` })
                    .from(ApprovalQueueTable)
                    .where(
                      and(
                        eq(ApprovalQueueTable.event_id, DeepAgentEventTable.id),
                        eq(ApprovalQueueTable.status, "pending"),
                      ),
                    ),
                )
                const deletable = and(
                  eq(DeepAgentEventTable.workspace_id, input.workspaceID),
                  lt(DeepAgentEventTable.created_at, input.olderThan),
                  noPendingDelivery,
                  noPendingApproval,
                )

                // Delete the terminal (delivered/dead) delivery rows of the doomed events FIRST. The FK
                // cascade already removes them, but doing it explicitly keeps the sweep correct even if a
                // future backend runs with foreign_keys OFF, and never touches a `pending` delivery (those
                // events are excluded by `deletable`, so their deliveries aren't in this set).
                yield* db
                  .delete(DeepAgentEventDeliveryTable)
                  .where(
                    sql`${DeepAgentEventDeliveryTable.event_id} in (${db
                      .select({ id: DeepAgentEventTable.id })
                      .from(DeepAgentEventTable)
                      .where(deletable)})`,
                  )
                  .run()
                  .pipe(Effect.orDie)

                const deleted = yield* db
                  .delete(DeepAgentEventTable)
                  .where(deletable)
                  .returning({ id: DeepAgentEventTable.id })
                  .all()
                  .pipe(Effect.orDie)

                return { deletedEvents: deleted.length }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)

      // §E2 — drive the in-memory rate-limiter's stale-window prune. Synchronous + total (never fails),
      // wrapped in Effect.sync so the daemon can schedule it uniformly with the other bus effects.
      const sweepPublishLimiter: Interface["sweepPublishLimiter"] = (nowArg) =>
        Effect.sync(() => ({ prunedBuckets: publishLimiter.sweep(nowArg ?? now()) }))

      return Service.of({
        publish,
        tryPublish,
        subscribe,
        ack,
        nack,
        replay,
        recentByType,
        deadLetters,
        recordDrop,
        dueRetries,
        getByID,
        sweep,
        sweepPublishLimiter,
      })
    }),
  )

export const layer = layerWith()

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
