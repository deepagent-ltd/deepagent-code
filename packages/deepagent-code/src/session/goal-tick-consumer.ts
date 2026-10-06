export * as GoalTickConsumer from "./goal-tick-consumer"

import { Context, Deferred, Effect, Layer, Option, Stream, Schedule, Duration, Cause } from "effect"
import { randomUUID } from "node:crypto"
import { ConsumerReceipts } from "@deepagent-code/core/deepagent/consumer-receipts"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { QuietHours } from "@deepagent-code/core/deepagent/quiet-hours"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Log } from "@deepagent-code/core/util/log"

// V4.1 §N — the GOAL TICK CONSUMER: the piece that makes the goal-loop tick GENUINELY event-driven.
//
// The V4.0 contract (§N) says "tick = goal.tick event" with persistence/retry/dedup, but historically a
// tick ran in an in-process for-loop (goal-driver runToCompletion) and `goal.tick` was only an
// after-the-fact TRACE with no consumer. This service closes that gap: it consumes the durable COMMAND
// `goal.tick.requested`, executes EXACTLY ONE tick (via an injected `runTick` port), and — while the goal
// is non-terminal — re-emits the next `goal.tick.requested` (the self-driving chain). Because the command
// rides the Event Bus, the tick inherits persistence, at-least-once delivery, retry-with-backoff, and
// dedup; a nack retries the REAL tick, not a breadcrumb.
//
// COLD RECOVERY: the production `runTick` port (makeGoalTickPort, wired separately) reconstructs the
// entire goal wiring from durable state + the event payload on a COLD fiber (no in-memory control map),
// so a goal survives a process restart and resumes from the durable run_context doc. This service itself
// holds NO per-goal state — it is a stateless bus consumer, exactly like SupervisorNotifier.
//
// IDEMPOTENCY: normal commands key on the strictly monotonic durable cursor. Resume seeds use a separate
// one-shot namespace because the command that observed a pause already consumed the current cursor without
// advancing state. The production port compares request.seq with durable state before executing, so a
// delivery retried after its tick persisted only repairs the successor and never runs a second tick.
//
// FLAG-GATED: either v4MultiAgentRuntime or the independent v4GoalTickEventDriven flag enables this
// consumer, matching GoalManager's driver selection. Both off ⇒ handle() ACKS deliveries but drives
// nothing — the in-process BackgroundJob driver (goal-manager, flags-OFF path) is authoritative.

const log = Log.create({ service: "goal-tick-consumer" })

// The durable consumer group this service reads under (§A3 at-least-once: publish records a pending
// delivery row per owed event for this group, so a crash mid-handle is recoverable via dueRetries).
export const TICK_GROUP = "goal-tick-consumer"

const DEFAULT_RETRY_PUMP_INTERVAL_MS = 30_000

// The command payload carried by a goal.tick.requested event. `seq` is the dedup identity;
// `expectedPlanVersion` is advisory (trace + sanity-check). `workspaceID` is the REAL workspace id
// (a "wrk"-prefixed id) used by the quiet-hours gate to look up the workspace's configured window.
// Optional for back-compat: old commands without it fall back to "never quiet" (the safe default).
export type GoalTickRequest = {
  readonly sessionID: string
  readonly goalId: string
  readonly planDocId: string
  readonly seq: number
  readonly expectedPlanVersion: number
  /** §E4/§N — real workspace id for the quiet-hours lookup. Absent ⇒ never quiet (fail-safe). */
  readonly workspaceID?: string
}

// What the injected runTick port returns after executing ONE tick. `progress` mirrors the driver's
// OneTickResult.progress; `nextSeq`/`nextExpectedPlanVersion` are read from the POST-tick durable state
// so the consumer can construct the next command deterministically.
export type GoalTickPortResult = {
  readonly progress: "stopped" | "paused" | "terminal" | "continue"
  readonly nextSeq: number
  readonly nextExpectedPlanVersion: number
}

// The injected execution port. Production wires makeGoalTickPort (cold reconstruction + runOneTick);
// tests wire a deterministic stub. Lives on `never` — a defect is caught by the consumer and nacked.
export type GoalTickPort = (request: GoalTickRequest) => Effect.Effect<GoalTickPortResult>

// Parse the event payload into a GoalTickRequest. Returns null when the payload is not a well-formed
// goal.tick.requested (defensive: a malformed command is acked-and-dropped rather than nacked forever).
const parseRequest = (payload: unknown): GoalTickRequest | null => {
  if (typeof payload !== "object" || payload === null) return null
  const p = payload as Record<string, unknown>
  if (
    typeof p.sessionID !== "string" ||
    typeof p.goalId !== "string" ||
    typeof p.planDocId !== "string" ||
    typeof p.seq !== "number" ||
    typeof p.expectedPlanVersion !== "number"
  )
    return null
  return {
    sessionID: p.sessionID,
    goalId: p.goalId,
    planDocId: p.planDocId,
    seq: p.seq,
    expectedPlanVersion: p.expectedPlanVersion,
    // §E4/§N — optional real workspace id; absent on old commands ⇒ falls back to "never quiet".
    ...(typeof p.workspaceID === "string" ? { workspaceID: p.workspaceID } : {}),
  }
}

// Build the next-tick command from a port result. Exposed so goal-manager's start() reuses the SAME key
// scheme for the FIRST command (seq=0), guaranteeing no drift between the seed and the chain.
export const tickCommand = (request: {
  sessionID: string
  goalId: string
  planDocId: string
  seq: number
  expectedPlanVersion: number
  /** §E4/§N — real workspace id; included in the payload so the consumer's quiet-hours gate can use it. */
  workspaceID?: string
}): DeepAgentEvent.PublishInput => ({
  type: LMNEvents.GOAL_TICK_REQUESTED,
  source: "system",
  // FEATURE-003-407 residual: the durable event row's workspace_id MUST be the REAL workspace id, not
  // the sessionID. The bus's groupsFor routes workspace-bound consumer groups (workspace_id != "") by
  // this column, so a sessionID here misroutes the event to zero tenants and poisons per-workspace
  // queries. The real id travels in `request.workspaceID` (stamped by goal-manager from the session);
  // when it is genuinely unavailable (legacy commands), fall back to "" — the bus's GLOBAL semantics
  // (a "" row is owed only to global groups, same as any cross-workspace event).
  workspaceID: request.workspaceID ?? "",
  actorID: request.sessionID,
  // §N: the command is the goal's own work — normal priority; it is NOT an approval-queue candidate.
  priority: "normal",
  // Dedup identity — a redelivered command for the same (goal, seq) is a no-op at the bus.
  idempotencyKey: `goal:tick:${request.goalId}:${request.seq}`,
  payload: {
    sessionID: request.sessionID,
    goalId: request.goalId,
    planDocId: request.planDocId,
    seq: request.seq,
    expectedPlanVersion: request.expectedPlanVersion,
    // §E4/§N — carry the real workspace id in the payload for the quiet-hours gate downstream.
    ...(request.workspaceID != null ? { workspaceID: request.workspaceID } : {}),
  },
})

// A paused command consumes the normal cursor key without advancing durable state. Resume therefore keeps
// the current cursor in the payload (the tick's true pre-state) but uses a fresh seed identity; successors
// return to the normal cursor namespace immediately after the resumed tick persists.
export const resumeTickCommand = (request: Parameters<typeof tickCommand>[0]): DeepAgentEvent.PublishInput => ({
  ...tickCommand(request),
  idempotencyKey: `goal:tick:${request.goalId}:resume:${DeepAgentEvent.ID.create()}`,
})

export interface Interface {
  /**
   * Claim ONE due goal.tick.requested delivery. A future or already-owned delivery is a no-op.
   * Flag off ⇒ ack (discharge) + drive nothing; quiet hours ⇒ defer the original pending row.
   * Otherwise: run one tick via the port, then re-emit the next command (progress==="continue") or stop
   * the chain (terminal/paused/stopped), and ack. A port DEFECT nacks (the bus retries the real tick).
   * Exposed for deterministic testing; the background subscription calls it.
   */
  readonly handle: (event: DeepAgentEvent.Event) => Effect.Effect<void>
  /** §A3 retry pump for THIS group — re-drives pending deliveries whose backoff elapsed. */
  readonly pumpRetries: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/GoalTickConsumer") {}

export interface LayerOptions {
  /** The tick execution port. Default = production makeGoalTickPort (wired via the full layer); tests inject a stub. */
  readonly runTick: GoalTickPort
  /** Start the background bus subscription + retry pump. Default true; tests set false + call handle(). */
  readonly runLoop?: boolean
  readonly retryPumpIntervalMs?: number
  readonly now?: () => number
  readonly leaseMs?: number
  readonly renewalIntervalMs?: number
}

export const layerWith = (options: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const flags = yield* RuntimeFlags.Service
      const { db } = yield* Database.Service
      const runTick = options.runTick
      const runLoop = options.runLoop ?? true
      const retryPumpIntervalMs = options.retryPumpIntervalMs ?? DEFAULT_RETRY_PUMP_INTERVAL_MS
      const now = options.now ?? Date.now
      const leaseMs = options.leaseMs ?? 300_000
      const renewalIntervalMs = options.renewalIntervalMs ?? Math.max(1, Math.floor(leaseMs / 3))
      if (
        !Number.isSafeInteger(leaseMs) ||
        leaseMs < 2 ||
        leaseMs > 86_400_000 ||
        !Number.isSafeInteger(renewalIntervalMs) ||
        renewalIntervalMs < 1 ||
        renewalIntervalMs >= leaseMs
      )
        return yield* Effect.die("invalid goal tick delivery lease configuration")
      const claimantId = `goal-tick:${randomUUID()}`

      // §E4/§N quiet-hours gate — WorkspaceConfig is OPTIONAL (same discipline as event-dispatcher and
      // agent-push): absent ⇒ never quiet (the correct fail-safe), so the consumer stays testable with
      // just Bus + Flags. When present, a CONFIGURED quiet-hours window defers a low/normal tick past the
      // window on the original pending delivery. Goal ticks are always normal priority.
      const workspaceConfig = yield* Effect.serviceOption(WorkspaceConfig.Service)

      // §E4/§N — resolve whether `at` falls inside the workspace's configured quiet window, and if so
      // compute the window's END epoch (ms) for durable deferral. Mirrors the same
      // arithmetic used by event-dispatcher.ts fireOrDefer so the two paths behave identically.
      // Returns { quiet:false } when: no WorkspaceConfig service, no configured window, or a lookup fails
      // (fail-safe: never quiet ⇒ execute normally — identical to the scheduler path's fail-safe).
      const resolveTickQuietHours = (
        workspaceID: string,
        at: number,
      ): Effect.Effect<{ readonly quiet: boolean; readonly endAt?: number }> =>
        Option.isNone(workspaceConfig)
          ? Effect.succeed({ quiet: false })
          : workspaceConfig.value.get(workspaceID).pipe(
              Effect.map((resolved) => {
                const qh = resolved.quietHours
                if (qh == null) return { quiet: false as const }
                if (!QuietHours.isWithinQuietHours(at, qh.startHour, qh.endHour, qh.tzOffsetMinutes))
                  return { quiet: false as const }
                // Walk forward hour-by-hour to the first instant outside the window (bounded: ≤ 24 steps
                // since the window is < 24h). Align to the next whole local-hour boundary first.
                const hourMs = 3_600_000
                const localMs = at + qh.tzOffsetMinutes * 60_000
                let boundary = Math.ceil(localMs / hourMs) * hourMs
                for (let i = 0; i < 25; i++) {
                  const hour = ((Math.floor(boundary / hourMs) % 24) + 24) % 24
                  const inWindow =
                    qh.startHour < qh.endHour
                      ? hour >= qh.startHour && hour < qh.endHour
                      : hour >= qh.startHour || hour < qh.endHour
                  if (!inWindow) break
                  boundary += hourMs
                }
                return { quiet: true as const, endAt: boundary - qh.tzOffsetMinutes * 60_000 }
              }),
              Effect.orElseSucceed(() => ({ quiet: false as const })),
            )

      const handleClaimed = (event: DeepAgentEvent.Event, claimToken: string) =>
        Effect.gen(function* () {
          const claim = { subscriptionGroup: TICK_GROUP, eventID: event.id, claimToken }
          const ack = () => bus.ackClaim(claim).pipe(Effect.asVoid)
          // Both flags off ⇒ the event-driven path is dormant; the in-process driver is authoritative. Still ACK
          // to discharge the durable delivery row (this group wildcard-less-subscribes only this type, but
          // a stray delivery must not pile up).
          if (!flags.v4MultiAgentRuntime && !flags.v4GoalTickEventDriven) {
            yield* ack()
            return
          }
          const request = parseRequest(event.payload)
          if (request == null) {
            log.warn("goal.tick.requested with malformed payload; acking (dropped)", { eventID: event.id })
            yield* ack()
            return
          }

          // Keep the original obligation pending. Neither a process-local timer nor a fresh resume
          // event is the authority for deferred work; restart reclaims this row after its due time.
          if (request.workspaceID != null) {
            const at = now()
            const qh = yield* resolveTickQuietHours(request.workspaceID, at)
            if (qh.quiet) {
              const until = qh.endAt ?? at + 3_600_000
              const deferred = yield* bus.deferClaim({ ...claim, until })
              if (!deferred) return yield* Effect.die("goal tick deferral lost its live claim or due time")
              log.info("goal tick deferred by quiet hours", {
                eventID: event.id,
                goalId: request.goalId,
                seq: request.seq,
                workspaceID: request.workspaceID,
                until,
                reason: "quiet_hours",
              })
              return
            }
          }

          // C5-10 deduplicates completed receipts, not unknown in-flight side effects:
          //   - first delivery → receipt `pending` → runTick → re-emit (if continue) → receipt `done`;
          //   - redelivery     → a `done` receipt returns "existing" and runs NOTHING again (the receipt
          //                       is the durable dedupe of the completed tick — cold-recovery safe);
          //   - sink failure   → the receipt STAYS `pending` and the bus nack re-drives the real side
          //                       effect. The port's seq guard skips execution only AFTER the tick
          //                       checkpoint committed; a pre-checkpoint crash remains F15. Re-emit
          //                       uses the bus idempotencyKey `goal:tick:<goalId>:<seq>`.
          // A defect degrades to a nack so the bus retries the REAL tick.
          const outcome = yield* ConsumerReceipts.runOnce(db, {
            consumerKind: "goal_tick",
            sourceEventId: event.id,
            sideEffect: runTick(request).pipe(
              Effect.tap(({ progress, nextSeq, nextExpectedPlanVersion }) =>
                progress === "continue"
                  ? bus
                      .publish(
                        tickCommand({
                          sessionID: request.sessionID,
                          goalId: request.goalId,
                          planDocId: request.planDocId,
                          seq: nextSeq,
                          expectedPlanVersion: nextExpectedPlanVersion,
                          workspaceID: request.workspaceID,
                        }),
                      )
                      .pipe(
                        Effect.tap(() =>
                          Effect.logInfo("goal tick executed; re-emitted next command", {
                            goalId: request.goalId,
                            seq: request.seq,
                            nextSeq,
                          }),
                        ),
                      )
                  : // terminal / paused / stopped: do NOT re-emit. The terminal FACT (goal.completed /
                    // needs_human / rolled_back) is emitted by the tick's own onStatus port; resume
                    // re-seeds the chain for a paused goal.
                    Effect.logInfo("goal tick chain halted", {
                      goalId: request.goalId,
                      seq: request.seq,
                      progress,
                    }),
              ),
            ),
            now: now(),
          }).pipe(Effect.exit)

          if (outcome._tag === "Failure") {
            log.error("goal tick execution failed; nacking for retry", {
              eventID: event.id,
              goalId: request.goalId,
              cause: Cause.pretty(outcome.cause),
            })
            yield* bus.nackClaim({ ...claim, reason: "goal tick execution failed" })
            return
          }
          if (outcome.value.kind === "existing") {
            // Redelivery of an already-completed tick (crash after `done`, or a replayed delivery):
            // ack without re-running — the durable receipt is the once-run authority.
            log.info("goal tick receipt done; skipping redelivered tick", {
              eventID: event.id,
              goalId: request.goalId,
              seq: request.seq,
            })
            yield* ack()
            return
          }
          yield* ack()
        })

      const processClaim = (eventID: DeepAgentEvent.ID, claimToken: string) => {
        const claim = { subscriptionGroup: TICK_GROUP, eventID, claimToken }
        const work = Effect.gen(function* () {
          const event = yield* bus.getByID(eventID)
          if (!event) return yield* Effect.die("pending goal tick event missing")
          yield* handleClaimed(event, claimToken)
        })
        const renew = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.millis(renewalIntervalMs))
            if (yield* bus.renewClaim({ ...claim, leaseMs })) continue
            return yield* Effect.die("goal tick delivery lease lost")
          }
        })
        // Losing the lease interrupts only this handling fiber. This is delivery ownership, not
        // an exactly-once fence for a provider/tool that already dispatched (F15 remains separate).
        return Effect.raceFirst(work, renew)
      }

      const handle: Interface["handle"] = (event) =>
        Effect.gen(function* () {
          const claim = yield* bus.claimDue({
            subscriptionGroup: TICK_GROUP,
            claimantId,
            eventID: event.id,
            now: now(),
            limit: 1,
            leaseMs,
          })
          if (claim.deliveries.length === 0) return
          yield* processClaim(event.id, claim.claimToken)
        })

      const pumpRetries: Interface["pumpRetries"] = (at) =>
        Effect.gen(function* () {
          let redriven = 0
          // Claim only the row about to execute, not a batch whose leases expire while queued.
          while (redriven < 50) {
            const claim = yield* bus.claimDue({
              subscriptionGroup: TICK_GROUP,
              claimantId,
              now: at ?? now(),
              limit: 1,
              leaseMs,
            })
            const delivery = claim.deliveries[0]
            if (!delivery) break
            yield* processClaim(delivery.eventID, claim.claimToken)
            redriven++
          }
          return redriven
        })

      if (runLoop) {
        yield* bus.registerConsumerGroup(TICK_GROUP, LMNEvents.GOAL_TICK_REQUESTED)
        const ready = yield* Deferred.make<void>()
        yield* bus.subscribe({ type: LMNEvents.GOAL_TICK_REQUESTED, group: TICK_GROUP }).pipe(
          Stream.onStart(Deferred.succeed(ready, undefined)),
          Stream.runForEach((event) =>
            handle(event).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => log.error("goal tick handle failed", { cause: Cause.pretty(cause) })),
              ),
            ),
          ),
          Effect.forkScoped,
        )
        // Timeout guards against DB-stall (busy WAL/retention sweep): durable registration already
        // happened via registerConsumerGroup above, so a brief live-stream miss is recoverable via
        // the retry pump. 500ms is well above normal fiber-schedule latency (<1ms).
        yield* Deferred.await(ready).pipe(Effect.timeout(Duration.millis(500)), Effect.ignore)

        yield* pumpRetries().pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("goal tick retry pump failed", { cause: Cause.pretty(cause) })).pipe(
              Effect.as(0),
            ),
          ),
          Effect.repeat(Schedule.spaced(Duration.millis(retryPumpIntervalMs))),
          Effect.forkScoped,
        )
      }

      return Service.of({ handle, pumpRetries })
    }),
  )
