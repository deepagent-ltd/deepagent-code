export * as Scheduler from "./scheduler"

import { Context, Effect, Layer } from "effect"
import { and, asc, eq, lte, or, isNull } from "drizzle-orm"
import { Database } from "../database/database"
import { DeepAgentScheduleTable } from "./scheduler-sql"
import { DeepAgentEvent } from "./deepagent-event"
import { Identifier } from "../util/identifier"

// V4.0 §A4 — the durable Scheduler service. Owns the `deepagent_schedule` rows and the transitions on
// them; it does NOT publish events itself (that would couple core to dispatch). The tick loop
// (deepagent-code) calls `due(now)`, publishes each returned schedule's `eventTemplate` through the
// Event Bus, then calls `markFired`/`recheckCondition` to advance state. This keeps core pure of the
// runtime while the durable state (survives restarts, unlike BackgroundJob) lives here.
//
// LAYERING: `core`. No dispatch / session / RuntimeFlags imports.

// The event a schedule emits when it fires — a PublishInput without the bus-filled defaults.
export type EventTemplate = Omit<DeepAgentEvent.PublishInput, "idempotencyKey">

// §A4 条件触发: fire when ≥ `threshold` events of `eventType` are observed within `windowMs`
// (e.g. 连续 3 次 CI 失败 → 修复 Goal). Evaluation is delegated to `conditionMet` (pure) against the
// Event Bus `recentByType` count; the scheduler only stores the spec + re-check cadence.
export interface ConditionSpec {
  readonly eventType: string
  readonly threshold: number
  readonly windowMs: number
  // §A4 跨 workspace 计数 — when true, the tick loop counts trigger events across ALL workspaces (it
  // omits the workspaceID filter in recentByType), so a SYSTEM-level condition (e.g. the "3× CI failure
  // → repair" trigger registered in the system workspace) can observe CI failures that land in per-
  // project workspaces. Omitted/false ⇒ the historical behavior: count only within the schedule's own
  // workspace. Fail-safe: an existing condition row (no flag) is unchanged.
  readonly crossWorkspace?: boolean
}

export type ScheduleKind = "delay" | "periodic" | "condition"
export type ScheduleStatus = "active" | "fired" | "cancelled"

export interface Schedule {
  readonly id: string
  readonly workspaceID: string
  readonly kind: ScheduleKind
  readonly status: ScheduleStatus
  readonly eventTemplate: EventTemplate
  readonly fireAt?: number
  readonly intervalMs?: number
  readonly condition?: ConditionSpec
  readonly lastFiredAt?: number
  // the stable dedupe key (schedule_key column), when this row was registered with one.
  readonly scheduleKey?: string
}

// `scheduleKey` (all three inputs): an OPTIONAL stable dedupe identity. When set, the row carries it in
// the `schedule_key` column, which has a partial-unique index (NULLs distinct) — so a second insert of
// the same key is rejected at the DB layer and the service swallows the conflict (onConflictDoNothing).
// This makes boot-time idempotent registration safe even under a multi-process TOCTOU. Omit for ad-hoc
// schedules (no dedupe).
export interface ScheduleDelayInput {
  readonly workspaceID: string
  readonly fireAt: number
  readonly eventTemplate: EventTemplate
  readonly scheduleKey?: string
}
export interface SchedulePeriodicInput {
  readonly workspaceID: string
  readonly intervalMs: number
  readonly firstFireAt: number
  readonly eventTemplate: EventTemplate
  readonly scheduleKey?: string
}
export interface ScheduleConditionInput {
  readonly workspaceID: string
  readonly condition: ConditionSpec
  readonly recheckEveryMs?: number // next re-check cadence; omit ⇒ eligible every tick
  readonly firstCheckAt: number
  readonly eventTemplate: EventTemplate
  readonly scheduleKey?: string
}

// §A4 条件触发 — PURE evaluator. `recentCount` is the number of matching events the caller counted via
// EventBus.recentByType({type: spec.eventType, windowMs: spec.windowMs, workspaceID}). Kept pure so the
// threshold logic is unit-testable without a bus/db.
export const conditionMet = (spec: ConditionSpec, recentCount: number): boolean => recentCount >= spec.threshold

export interface Interface {
  /** §A4 延迟事件 — fire the templated event once at `fireAt`. */
  readonly scheduleDelay: (input: ScheduleDelayInput) => Effect.Effect<Schedule>
  /** §A4 周期扫描 — fire every `intervalMs`, starting at `firstFireAt`, until cancelled. */
  readonly schedulePeriodic: (input: SchedulePeriodicInput) => Effect.Effect<Schedule>
  /** §A4 条件触发 — fire when `condition` is met at a re-check; stays active for repeated firing. */
  readonly scheduleCondition: (input: ScheduleConditionInput) => Effect.Effect<Schedule>
  /** Active schedules whose next fire/check time (`fireAt`) is ≤ now (null fireAt ⇒ always due). */
  readonly due: (now: number) => Effect.Effect<ReadonlyArray<Schedule>>
  /**
   * Record that a schedule fired at `firedAt`. delay → status fired. periodic → advance fireAt by
   * intervalMs (catching up past `firedAt` so a slow tick doesn't fire a burst) and stay active.
   * condition → stay active; caller sets the next recheck via `recheckCondition`.
   */
  readonly markFired: (id: string, firedAt: number) => Effect.Effect<void>
  /** condition schedules: set the next re-check time after an evaluation that did NOT fire. */
  readonly recheckCondition: (id: string, nextCheckAt: number) => Effect.Effect<void>
  /** Cancel a schedule (idempotent). */
  readonly cancel: (id: string) => Effect.Effect<void>
  /** List schedules for a workspace (active by default). */
  readonly list: (workspaceID: string, status?: ScheduleStatus) => Effect.Effect<ReadonlyArray<Schedule>>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/DeepAgentScheduler") {}

export interface LayerOptions {
  readonly now?: () => number
}

const decode = (row: {
  id: string
  workspace_id: string
  kind: string
  status: string
  event_template: unknown
  fire_at: number | null
  interval_ms: number | null
  condition: unknown
  last_fired_at: number | null
  schedule_key?: string | null
}): Schedule => ({
  id: row.id,
  workspaceID: row.workspace_id,
  kind: row.kind as ScheduleKind,
  status: row.status as ScheduleStatus,
  eventTemplate: row.event_template as EventTemplate,
  ...(row.fire_at != null ? { fireAt: row.fire_at } : {}),
  ...(row.interval_ms != null ? { intervalMs: row.interval_ms } : {}),
  ...(row.condition != null ? { condition: row.condition as ConditionSpec } : {}),
  ...(row.last_fired_at != null ? { lastFiredAt: row.last_fired_at } : {}),
  ...(row.schedule_key != null ? { scheduleKey: row.schedule_key } : {}),
})

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = options?.now ?? Date.now
      const newID = () => "sch_" + Identifier.ascending()

      // Unkeyed insert: no dedupe, return the row we wrote (the historical behavior).
      const insert = (values: typeof DeepAgentScheduleTable.$inferInsert) =>
        db
          .insert(DeepAgentScheduleTable)
          .values([values])
          .run()
          .pipe(Effect.orDie, Effect.as(decode(values as Parameters<typeof decode>[0])))

      // Keyed insert: idempotent on `schedule_key`. `onConflictDoNothing` makes a duplicate insert a
      // no-op at the DB layer (closing the multi-process TOCTOU that a list-then-insert guard cannot),
      // then we re-read the CANONICAL row by key so a race-loser returns the WINNER's row (its real id),
      // not the phantom values it tried to insert. Existing rows may predate the column and thus carry a
      // key already, so this also dedupes an ordinary re-registration.
      const insertKeyed = (values: typeof DeepAgentScheduleTable.$inferInsert, key: string) =>
        Effect.gen(function* () {
          yield* db
            .insert(DeepAgentScheduleTable)
            .values([values])
            .onConflictDoNothing({ target: DeepAgentScheduleTable.schedule_key })
            .run()
            .pipe(Effect.orDie)
          const winner = yield* db
            .select()
            .from(DeepAgentScheduleTable)
            .where(eq(DeepAgentScheduleTable.schedule_key, key))
            .get()
            .pipe(Effect.orDie)
          // winner is always present (we either inserted it or a concurrent writer did).
          return decode((winner ?? values) as Parameters<typeof decode>[0])
        })

      // Route to the keyed or unkeyed path based on whether a scheduleKey was supplied.
      const insertMaybeKeyed = (values: typeof DeepAgentScheduleTable.$inferInsert) =>
        values.schedule_key != null ? insertKeyed(values, values.schedule_key) : insert(values)

      const scheduleDelay: Interface["scheduleDelay"] = (input) => {
        const at = now()
        return insertMaybeKeyed({
          id: newID(),
          workspace_id: input.workspaceID,
          kind: "delay",
          status: "active",
          event_template: input.eventTemplate,
          fire_at: input.fireAt,
          interval_ms: null,
          condition: null,
          last_fired_at: null,
          schedule_key: input.scheduleKey ?? null,
          created_at: at,
          updated_at: at,
        })
      }

      const schedulePeriodic: Interface["schedulePeriodic"] = (input) => {
        // A non-positive interval would never advance fire_at (interval 0) or move it backward
        // (negative) → the schedule would hot-refire every tick forever. Reject at creation (a caller
        // bug, not a recoverable condition — consistent with the module's orDie discipline).
        if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0)
          return Effect.die(new Error(`schedulePeriodic: intervalMs must be a positive number, got ${input.intervalMs}`))
        const at = now()
        return insertMaybeKeyed({
          id: newID(),
          workspace_id: input.workspaceID,
          kind: "periodic",
          status: "active",
          event_template: input.eventTemplate,
          fire_at: input.firstFireAt,
          interval_ms: input.intervalMs,
          condition: null,
          last_fired_at: null,
          schedule_key: input.scheduleKey ?? null,
          created_at: at,
          updated_at: at,
        })
      }

      const scheduleCondition: Interface["scheduleCondition"] = (input) => {
        // recheckEveryMs is the condition's cadence; if supplied it must be positive for the same
        // reason as periodic's interval. Omitting it means "re-check every tick" (interval null).
        if (input.recheckEveryMs != null && (!Number.isFinite(input.recheckEveryMs) || input.recheckEveryMs <= 0))
          return Effect.die(
            new Error(`scheduleCondition: recheckEveryMs must be a positive number when set, got ${input.recheckEveryMs}`),
          )
        const at = now()
        return insertMaybeKeyed({
          id: newID(),
          workspace_id: input.workspaceID,
          kind: "condition",
          status: "active",
          event_template: input.eventTemplate,
          fire_at: input.firstCheckAt,
          interval_ms: input.recheckEveryMs ?? null,
          condition: input.condition,
          last_fired_at: null,
          schedule_key: input.scheduleKey ?? null,
          created_at: at,
          updated_at: at,
        })
      }

      const due: Interface["due"] = (nowArg) =>
        db
          .select()
          .from(DeepAgentScheduleTable)
          .where(
            and(
              eq(DeepAgentScheduleTable.status, "active"),
              // null fire_at ⇒ always eligible (condition checked every tick); else fire_at <= now.
              or(isNull(DeepAgentScheduleTable.fire_at), lte(DeepAgentScheduleTable.fire_at, nowArg)),
            ),
          )
          .orderBy(asc(DeepAgentScheduleTable.fire_at))
          .all()
          .pipe(Effect.orDie, Effect.map((rows) => rows.map(decode)))

      // §A4 — record a fire. The select-then-update runs in an immediate transaction wrapped in
      // `Effect.uninterruptible` so a concurrent `cancel` can't slip between the two: without this a
      // tick's markFired could read status=active, yield, and then overwrite a `cancel` that committed
      // in the gap — firing a schedule the user cancelled. Every UPDATE also re-asserts status='active'
      // in its WHERE so, even under the txn, a lost-cancel can never resurrect a terminal row.
      const markFired: Interface["markFired"] = (id, firedAt) =>
        Effect.uninterruptible(
          db
            .transaction(
              () =>
                Effect.gen(function* () {
                  const row = yield* db
                    .select()
                    .from(DeepAgentScheduleTable)
                    .where(eq(DeepAgentScheduleTable.id, id))
                    .get()
                    .pipe(Effect.orDie)
                  if (!row || row.status !== "active") return
                  const at = now()
                  const active = and(
                    eq(DeepAgentScheduleTable.id, id),
                    eq(DeepAgentScheduleTable.status, "active"),
                  )
                  if (row.kind === "delay") {
                    yield* db
                      .update(DeepAgentScheduleTable)
                      .set({ status: "fired", last_fired_at: firedAt, updated_at: at })
                      .where(active)
                      .run()
                      .pipe(Effect.orDie)
                    return
                  }
                  // periodic AND condition both advance fire_at past firedAt by their cadence so a
                  // fire is not immediately re-eligible next tick. periodic's cadence is interval_ms;
                  // a condition's cadence is its recheck interval (interval_ms, from recheckEveryMs).
                  // Catch-up (while next <= firedAt) means a slow/backlogged tick fires ONCE and
                  // resumes cadence rather than emitting a burst of missed ticks. `interval > 0` is
                  // guaranteed at creation, so the loop terminates.
                  const interval = row.interval_ms ?? 0
                  if (interval > 0) {
                    let next = (row.fire_at ?? firedAt) + interval
                    while (next <= firedAt) next += interval
                    yield* db
                      .update(DeepAgentScheduleTable)
                      .set({ fire_at: next, last_fired_at: firedAt, updated_at: at })
                      .where(active)
                      .run()
                      .pipe(Effect.orDie)
                    return
                  }
                  // No cadence (a condition created without recheckEveryMs = "re-check every tick").
                  // fire_at stays in the past, so the row is due again next tick — INTENTIONAL for
                  // every-tick evaluation, but the caller MUST then `recheckCondition` or `cancel`
                  // after acting on a fire, or it will re-fire each tick until the window drains.
                  yield* db
                    .update(DeepAgentScheduleTable)
                    .set({ last_fired_at: firedAt, updated_at: at })
                    .where(active)
                    .run()
                    .pipe(Effect.orDie)
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie),
        )

      const recheckCondition: Interface["recheckCondition"] = (id, nextCheckAt) =>
        db
          .update(DeepAgentScheduleTable)
          .set({ fire_at: nextCheckAt, updated_at: now() })
          .where(and(eq(DeepAgentScheduleTable.id, id), eq(DeepAgentScheduleTable.status, "active")))
          .run()
          .pipe(Effect.orDie, Effect.asVoid)

      const cancel: Interface["cancel"] = (id) =>
        db
          .update(DeepAgentScheduleTable)
          .set({ status: "cancelled", updated_at: now() })
          .where(eq(DeepAgentScheduleTable.id, id))
          .run()
          .pipe(Effect.orDie, Effect.asVoid)

      const list: Interface["list"] = (workspaceID, status) =>
        db
          .select()
          .from(DeepAgentScheduleTable)
          .where(
            and(
              eq(DeepAgentScheduleTable.workspace_id, workspaceID),
              eq(DeepAgentScheduleTable.status, status ?? "active"),
            ),
          )
          .orderBy(asc(DeepAgentScheduleTable.fire_at))
          .all()
          .pipe(Effect.orDie, Effect.map((rows) => rows.map(decode)))

      return Service.of({
        scheduleDelay,
        schedulePeriodic,
        scheduleCondition,
        due,
        markFired,
        recheckCondition,
        cancel,
        list,
      })
    }),
  )

export const layer = layerWith()

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
