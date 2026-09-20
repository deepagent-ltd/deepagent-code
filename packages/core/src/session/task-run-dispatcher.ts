export * as TaskRunDispatcher from "./task-run-dispatcher"

import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm"
import { Cause, Context, Effect, Exit, FiberSet, Layer, Schedule } from "effect"
import { Database } from "../database/database"
import { SessionV2 } from "../session"
import { TaskRunTable } from "./sql"
import { TaskOutbox } from "./task-outbox"
import { TaskRunAuthority } from "./task-run"

type DatabaseService = Database.Interface["db"]

/** Per-run drain budget; matches the foreground task tool's default subagent timeout. */
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000

export type Options = {
  /** Parallel background drains owned by this process (default 4). */
  readonly maxConcurrent?: number
  /** Scan cadence for the daemon loop (default 500ms). */
  readonly scanIntervalMs?: number
  /** Per-run execution budget forwarded to `TaskRunAuthority.execute` (default 30min). */
  readonly runTimeoutMs?: number
  /** Claim + heartbeat lease length (authority default 30s). */
  readonly leaseMs?: number
}

export interface Interface {
  /**
   * One scan+claim pass: claims at most (`maxConcurrent` − active) eligible runs and forks their
   * drains. Returns the number of newly claimed runs.
   */
  readonly tick: Effect.Effect<number>
  /** Run ids with an in-flight drain owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<string>>
  /** Resolves once this process owns no in-flight background drain. */
  readonly awaitIdle: Effect.Effect<void>
  /** Forks the scan cadence loop into the owning scope (idempotent). */
  readonly start: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/TaskRunDispatcher") {}

/**
 * Process-global daemon that drains BACKGROUND durable task runs claimed from the Core V2
 * authority. Per-run protocol is the authority's own executor — CAS claim, lease heartbeat,
 * `SessionExecution.resume` join through `SessionV2.resume`, fenced terminal settle — so this
 * module owns only scanning, the concurrency pool, and shutdown. Foreground runs stay with the
 * parent turn's inline `TaskRunAuthority.execute` call; V1 rows are invisible to the scan.
 */
export const make = (options: Options = {}) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sessions = yield* SessionV2.Service
    const scope = yield* Effect.scope
    const maxConcurrent = options.maxConcurrent ?? 4
    const drains = yield* FiberSet.make<void, never>()
    // Registered BEFORE the drain forks so a synchronously-completing run cannot delete a marker
    // that was never added (which would leak a permit slot forever).
    const inFlight = new Set<string>()
    let closed = false
    let loopStarted = false
    // Shutdown is scope close: stop scanning, then the scope interrupts the in-flight drains whose
    // executor settles 'interrupted' (uninterruptible) and releases the claim lease.
    yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true }))

    const driveRun = (runID: string) =>
      Effect.gen(function* () {
        const run = yield* TaskRunAuthority.get(db, runID)
        if (run === undefined) return
        const exit = yield* TaskRunAuthority.execute({
          db,
          run,
          sessions,
          timeoutMs: options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
          ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
        }).pipe(Effect.exit)
        // Losing the claim CAS to a competing owner is the fence doing its job, not a failure.
        if (Exit.isFailure(exit) && !(Cause.squash(exit.cause) instanceof TaskRunAuthority.ClaimLost))
          yield* Effect.logError("TaskRunDispatcher: background run failed", Cause.squash(exit.cause)).pipe(
            Effect.annotateLogs("runID", runID),
          )
      }).pipe(Effect.ensuring(Effect.sync(() => { inFlight.delete(runID) })))

    const tick = Effect.gen(function* () {
      if (closed) return 0
      const capacity = maxConcurrent - inFlight.size
      if (capacity <= 0) return 0
      const candidates = yield* scanClaimable(db, capacity)
      const fresh = candidates.filter((runID) => !inFlight.has(runID)).slice(0, capacity)
      for (const runID of fresh) {
        inFlight.add(runID)
        yield* FiberSet.run(drains, driveRun(runID))
      }
      return fresh.length
    })

    const start = Effect.suspend(() => {
      // The suspend body is synchronous, so check-and-set guards against a concurrent double start.
      if (loopStarted || closed) return Effect.void
      loopStarted = true
      return tick
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("TaskRunDispatcher: scan tick failed", cause).pipe(Effect.as(0)),
          ),
          Effect.repeat(Schedule.fixed(options.scanIntervalMs ?? 500)),
          Effect.asVoid,
          Effect.forkIn(scope),
        )
    })

    return Service.of({
      tick,
      active: Effect.sync(() => new Set(inFlight)),
      awaitIdle: FiberSet.awaitEmpty(drains),
      start,
    })
  })

/** Manual-tick service; the daemon loop is started by {@link startedLayer}. */
export const layer = (options: Options = {}) => Layer.effect(Service, make(options))

export const startedLayer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.flatMap(make(options), (dispatcher) => dispatcher.start.pipe(Effect.as(dispatcher))),
  )

/**
 * App mount point for the V2 background task runtime: the auto-started run dispatcher plus the
 * notification outbox delivery loop over one SessionV2 composition (which carries Database and
 * SessionExecution). The app cutover composes this next to its execution layers; nothing inside
 * packages/deepagent-code wires it yet.
 */
export const runtimeLayer = (options: Options = {}) =>
  Layer.mergeAll(startedLayer(options), TaskOutbox.startedLayer({ scanIntervalMs: options.scanIntervalMs }))

// Eligibility mirrors `TaskRunAuthority.claim`'s CAS predicate (execution_runtime='v2',
// input_state='ready', control_state='open', admitted-unowned or running-with-expired-lease) plus
// the dispatcher's own policy: background delivery only, available_at respected, priority-desc then
// FIFO ordering. The claim CAS revalidates everything, so a stale scan row can only lose the claim.
const scanClaimable = (db: DatabaseService, limit: number) => {
  const now = Date.now()
  return db
    .select({ run_id: TaskRunTable.run_id })
    .from(TaskRunTable)
    .where(
      and(
        eq(TaskRunTable.execution_runtime, "v2"),
        eq(TaskRunTable.delivery_mode, "background"),
        eq(TaskRunTable.input_state, "ready"),
        eq(TaskRunTable.control_state, "open"),
        lte(TaskRunTable.available_at, now),
        or(
          and(eq(TaskRunTable.state, "admitted"), isNull(TaskRunTable.execution_owner)),
          and(
            eq(TaskRunTable.state, "running"),
            or(isNull(TaskRunTable.lease_expires_at), lte(TaskRunTable.lease_expires_at, now))!,
          ),
        )!,
      ),
    )
    .orderBy(desc(TaskRunTable.priority), asc(TaskRunTable.time_created), asc(TaskRunTable.generation))
    .limit(limit)
    .all()
    .pipe(Effect.orDie)
    .pipe(Effect.map((rows) => rows.map((row) => row.run_id)))
}
