export * as RetentionSweeper from "./retention-sweeper"

import { Cause, Context, Duration, Effect, Layer, Schedule } from "effect"
import { and, eq, lt } from "drizzle-orm"
import { Database } from "../database/database"
import { DeepAgentEventBus } from "./deepagent-event-bus"
import { DeepAgentEventTable } from "./deepagent-event-sql"
import { ApprovalQueueTable } from "./approval-queue-sql"
import { WorkspaceConfig } from "./workspace-config"
import { AgentPushLogTable } from "../im/push-log-sql"
import * as Log from "../util/log"

// V4.0 §A3 保留期 — the periodic RETENTION SWEEPER. For each workspace that has durable events it reads
// the workspace's configured `retentionDays` (WorkspaceConfig, default 30) and prunes anything older
// than `now - retentionDays*86400_000`:
//   - domain events           → DeepAgentEventBus.sweep (referential-safe: spares events still owed to
//                               a pending delivery or an unresolved approval-queue item; see the bus).
//   - agent push audit log     → im_agent_push_logs rows past retention (the §B4 push audit trail).
//   - resolved approval queue  → deepagent_approval_queue rows already RESOLVED and past retention. A
//                               PENDING item is NEVER pruned (a human still owes it a decision), no
//                               matter how old — audit retention only reclaims settled state.
//
// LAYERING: `core`. Reads WorkspaceConfig + drives the Event Bus; no session/runtime imports. The daemon
// is a scoped fork gated behind `runLoop` (tests pass false and call `sweepOnce` for determinism).

const log = Log.create({ service: "retention-sweeper" })

const DAY_MS = 86_400_000
// default sweep cadence — hourly (retention is a slow reclaim; a missed hour is harmless).
export const DEFAULT_SWEEP_INTERVAL_MS = Duration.toMillis(Duration.hours(1))

export interface SweepSummary {
  readonly workspacesSwept: number
  readonly deletedEvents: number
  readonly deletedPushLogs: number
  readonly deletedApprovals: number
}

export interface Interface {
  /**
   * Run ONE retention pass across every workspace that has events. Deterministic (no timers) so tests
   * can drive it directly; the daemon calls it on the interval. `now` defaults to the injected clock.
   */
  readonly sweepOnce: (now?: number) => Effect.Effect<SweepSummary>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/RetentionSweeper") {}

export interface LayerOptions {
  readonly now?: () => number
  // sweep cadence for the daemon loop. Ignored when runLoop is false.
  readonly intervalMs?: number
  // start the background sweep daemon (scoped fork). Default true; tests pass false and call sweepOnce.
  readonly runLoop?: boolean
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* DeepAgentEventBus.Service
      const config = yield* WorkspaceConfig.Service
      const now = options?.now ?? Date.now
      const intervalMs = options?.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
      const runLoop = options?.runLoop ?? true

      const sweepOnce: Interface["sweepOnce"] = (nowArg) =>
        Effect.gen(function* () {
          const at = nowArg ?? now()

          // enumerate the workspaces that actually have events — the only ones worth a retention pass.
          // (push-log / approval pruning is scoped to these same workspaces; a workspace with no events
          //  but stray audit rows is swept the next time it publishes — acceptable for slow reclaim.)
          const workspaceRows = yield* db
            .selectDistinct({ workspaceID: DeepAgentEventTable.workspace_id })
            .from(DeepAgentEventTable)
            .all()
            .pipe(Effect.orDie)

          let deletedEvents = 0
          let deletedPushLogs = 0
          let deletedApprovals = 0

          for (const { workspaceID } of workspaceRows) {
            const resolved = yield* config.get(workspaceID)
            const olderThan = at - resolved.retentionDays * DAY_MS

            // §A3 events (referential-safe sweep on the bus).
            const eventResult = yield* bus.sweep({ workspaceID, olderThan })
            deletedEvents += eventResult.deletedEvents

            // §B4 push audit log — prune this workspace's rows past retention.
            const pushDeleted = yield* db
              .delete(AgentPushLogTable)
              .where(
                and(
                  eq(AgentPushLogTable.workspace_id, workspaceID),
                  lt(AgentPushLogTable.created_at, olderThan),
                ),
              )
              .returning({ id: AgentPushLogTable.id })
              .all()
              .pipe(Effect.orDie)
            deletedPushLogs += pushDeleted.length

            // §D2 approval queue — prune RESOLVED items past retention only. A pending item survives
            // regardless of age (a human still owes it a decision).
            const approvalDeleted = yield* db
              .delete(ApprovalQueueTable)
              .where(
                and(
                  eq(ApprovalQueueTable.workspace_id, workspaceID),
                  eq(ApprovalQueueTable.status, "resolved"),
                  lt(ApprovalQueueTable.created_at, olderThan),
                ),
              )
              .returning({ id: ApprovalQueueTable.id })
              .all()
              .pipe(Effect.orDie)
            deletedApprovals += approvalDeleted.length
          }

          return {
            workspacesSwept: workspaceRows.length,
            deletedEvents,
            deletedPushLogs,
            deletedApprovals,
          }
        })

      // Background daemon (scoped to the layer). A failure in a single pass is logged and swallowed so
      // the loop never dies on one bad sweep. Schedule.spaced waits between completions.
      if (runLoop) {
        yield* sweepOnce()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("retention sweep failed", { cause: Cause.pretty(cause) })).pipe(
                Effect.as<SweepSummary>({
                  workspacesSwept: 0,
                  deletedEvents: 0,
                  deletedPushLogs: 0,
                  deletedApprovals: 0,
                }),
              ),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(intervalMs))),
            Effect.forkScoped,
          )
      }

      return Service.of({ sweepOnce })
    }),
  )

export const layer = layerWith()
