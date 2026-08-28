export * as RetentionSweeper from "./retention-sweeper"

import { Cause, Context, Duration, Effect, Layer, Schedule } from "effect"
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { DeepAgentEventBus } from "./deepagent-event-bus"
import { DeepAgentEventTable } from "./deepagent-event-sql"
import { ApprovalQueueTable } from "./approval-queue-sql"
import { WorkspaceConfig } from "./workspace-config"
import { AgentPushLogTable } from "../im/push-log-sql"
import { EventArtifactTable, EventCompactionReceiptTable, EventSequenceTable } from "../event/sql"
import {
  FilePartArtifactBindingTable,
  FilePartArtifactDiscardTable,
  FilePartArtifactImportTable,
  FilePartArtifactTable,
} from "../file-part-artifact.sql"
import { SessionTable } from "../session/sql"
import type { WorkspaceV2 } from "../workspace"
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
const SWEEP_BATCH_ROWS = 100
// default sweep cadence — hourly (retention is a slow reclaim; a missed hour is harmless).
export const DEFAULT_SWEEP_INTERVAL_MS = Duration.toMillis(Duration.hours(1))

export interface SweepSummary {
  readonly workspacesSwept: number
  readonly deletedEvents: number
  readonly deletedPushLogs: number
  readonly deletedApprovals: number
  // PERF: EventV2 mirror events pruned for archived sessions. Reported separately because the
  // accounting is by aggregate (session), not individual rows, so it has different semantics.
  readonly deletedEventV2Sequences: number
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
  readonly initialDelayMs?: number
  // start the background sweep daemon (scoped fork). Default true; tests pass false and call sweepOnce.
  readonly runLoop?: boolean
  readonly compactSession?: (sessionID: string) => Effect.Effect<boolean>
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
      const initialDelayMs = options?.initialDelayMs ?? intervalMs
      const runLoop = options?.runLoop ?? true

      const sweepOnce: Interface["sweepOnce"] = (nowArg) =>
        Effect.gen(function* () {
          const at = nowArg ?? now()

          const eventWorkspaceRows = yield* db
            .selectDistinct({ workspaceID: DeepAgentEventTable.workspace_id })
            .from(DeepAgentEventTable)
            .orderBy(asc(DeepAgentEventTable.workspace_id))
            .limit(SWEEP_BATCH_ROWS)
            .all()
            .pipe(Effect.orDie)
          const sessionWorkspaceRows = yield* db
            .selectDistinct({ workspaceID: SessionTable.workspace_id })
            .from(SessionTable)
            .where(isNotNull(SessionTable.workspace_id))
            .orderBy(asc(SessionTable.workspace_id))
            .limit(SWEEP_BATCH_ROWS)
            .all()
            .pipe(Effect.orDie)
          const workspaceRows = [...new Set([...eventWorkspaceRows, ...sessionWorkspaceRows].map((row) => row.workspaceID))]
            .filter((workspaceID): workspaceID is WorkspaceV2.ID => workspaceID !== null)
            .map((workspaceID) => ({ workspaceID }))

          let deletedEvents = 0
          let deletedPushLogs = 0
          let deletedApprovals = 0
          let deletedEventV2Sequences = 0

          const abandonedImports = yield* db
            .select({
              eventID: FilePartArtifactImportTable.event_id,
              artifactID: FilePartArtifactImportTable.artifact_id,
              aggregateID: FilePartArtifactImportTable.aggregate_id,
              seq: FilePartArtifactImportTable.seq,
              originalDataHash: FilePartArtifactImportTable.original_data_hash,
              canonicalDataHash: FilePartArtifactImportTable.canonical_data_hash,
              canonicalData: FilePartArtifactImportTable.canonical_data,
            })
            .from(FilePartArtifactImportTable)
            .where(lt(FilePartArtifactImportTable.created_at, at - DAY_MS))
            .limit(SWEEP_BATCH_ROWS)
            .all()
            .pipe(Effect.orDie)
          yield* db.transaction(
            () => Effect.forEach(
              abandonedImports,
              (imported) => Effect.gen(function* () {
                const binding = yield* db.select({ id: FilePartArtifactBindingTable.event_id })
                  .from(FilePartArtifactBindingTable)
                  .where(eq(FilePartArtifactBindingTable.event_id, imported.eventID)).get().pipe(Effect.orDie)
                if (binding) return
                yield* db.insert(FilePartArtifactDiscardTable).values({
                  event_id: imported.eventID,
                  aggregate_id: imported.aggregateID,
                  seq: imported.seq,
                  artifact_id: imported.artifactID,
                  original_data_hash: imported.originalDataHash,
                  canonical_data_hash: imported.canonicalDataHash,
                  canonical_data: imported.canonicalData,
                  created_at: at,
                }).onConflictDoNothing().run().pipe(Effect.orDie)
                yield* db.delete(FilePartArtifactImportTable)
                  .where(eq(FilePartArtifactImportTable.event_id, imported.eventID)).run().pipe(Effect.orDie)
                yield* db.delete(FilePartArtifactTable).where(and(
                  eq(FilePartArtifactTable.artifact_id, imported.artifactID),
                  sql`NOT EXISTS (
                    SELECT 1 FROM ${FilePartArtifactBindingTable} binding
                    WHERE binding.artifact_id = ${imported.artifactID}
                  )`,
                  sql`NOT EXISTS (
                    SELECT 1 FROM ${FilePartArtifactImportTable} imported
                    WHERE imported.artifact_id = ${imported.artifactID}
                  )`,
                )).run().pipe(Effect.orDie)
              }),
              { discard: true },
            ),
            { behavior: "immediate" },
          ).pipe(Effect.orDie)

          for (const { workspaceID } of workspaceRows) {
            const resolved = yield* config.get(workspaceID)
            const olderThan = at - resolved.retentionDays * DAY_MS

            // §A3 events (referential-safe sweep on the bus).
            const eventResult = yield* bus.sweep({ workspaceID, olderThan, limit: SWEEP_BATCH_ROWS })
            deletedEvents += eventResult.deletedEvents

            // §B4 push audit log — prune this workspace's rows past retention.
            const pushIDs = yield* db.select({ id: AgentPushLogTable.id }).from(AgentPushLogTable).where(and(
              eq(AgentPushLogTable.workspace_id, workspaceID), lt(AgentPushLogTable.created_at, olderThan),
            )).orderBy(asc(AgentPushLogTable.id)).limit(SWEEP_BATCH_ROWS).all().pipe(Effect.orDie)
            if (pushIDs.length > 0) {
              const pushDeleted = yield* db.delete(AgentPushLogTable).where(inArray(AgentPushLogTable.id, pushIDs.map((row) => row.id))).returning({ id: AgentPushLogTable.id }).all().pipe(Effect.orDie)
              deletedPushLogs += pushDeleted.length
            }

            // §D2 approval queue — prune RESOLVED items past retention only. A pending item survives
            // regardless of age (a human still owes it a decision).
            const approvalIDs = yield* db.select({ id: ApprovalQueueTable.id }).from(ApprovalQueueTable).where(and(
              eq(ApprovalQueueTable.workspace_id, workspaceID), eq(ApprovalQueueTable.status, "resolved"), lt(ApprovalQueueTable.created_at, olderThan),
            )).orderBy(asc(ApprovalQueueTable.id)).limit(SWEEP_BATCH_ROWS).all().pipe(Effect.orDie)
            if (approvalIDs.length > 0) {
              const approvalDeleted = yield* db.delete(ApprovalQueueTable).where(inArray(ApprovalQueueTable.id, approvalIDs.map((row) => row.id))).returning({ id: ApprovalQueueTable.id }).all().pipe(Effect.orDie)
              deletedApprovals += approvalDeleted.length
            }

            // Archived sessions may be compacted through their active snapshot, but the aggregate
            // root remains readable until the explicit Session/EventV2 remove authority runs. The
            // sweeper must not delete EventSequence directly: doing so would bypass the root
            // lifecycle and make replay/fork history disappear while the Session row remains.
            const archivedFilter = and(
              eq(SessionTable.workspace_id, workspaceID as WorkspaceV2.ID),
              isNotNull(SessionTable.time_archived),
              lt(SessionTable.time_archived, olderThan),
            )

            const compactableSessions = yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(and(
                archivedFilter,
                sql`EXISTS (
                  SELECT 1 FROM ${EventSequenceTable} sequence
                  WHERE sequence.aggregate_id = ${SessionTable.id}
                    AND NOT EXISTS (
                      SELECT 1 FROM ${EventCompactionReceiptTable} receipt
                      WHERE receipt.aggregate_id = sequence.aggregate_id
                        AND receipt.state = 'complete'
                        AND receipt.through_seq >= sequence.seq
                    )
                )`,
                sql`(
                  EXISTS (
                    SELECT 1 FROM ${EventArtifactTable} artifact
                    WHERE artifact.aggregate_id = ${SessionTable.id}
                  ) OR EXISTS (
                    SELECT 1 FROM ${FilePartArtifactBindingTable} binding
                    WHERE binding.aggregate_id = ${SessionTable.id}
                  )
                )`,
              ))
              .orderBy(SessionTable.id)
              .limit(SWEEP_BATCH_ROWS)
              .all()
              .pipe(Effect.orDie)
            yield* Effect.forEach(
              compactableSessions,
              (session) => options?.compactSession?.(session.id) ?? Effect.void,
              { discard: true },
            )
          }

          return {
            workspacesSwept: workspaceRows.length,
            deletedEvents,
            deletedPushLogs,
            deletedApprovals,
            deletedEventV2Sequences,
          }
        })

      // Background daemon (scoped to the layer). A failure in a single pass is logged and swallowed so
      // the loop never dies on one bad sweep. Schedule.spaced waits between completions.
      if (runLoop) {
        yield* Effect.sleep(Duration.millis(initialDelayMs))
          .pipe(
            Effect.andThen(sweepOnce()),
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("retention sweep failed", { cause: Cause.pretty(cause) })).pipe(
                Effect.as<SweepSummary>({
                  workspacesSwept: 0,
                  deletedEvents: 0,
                  deletedPushLogs: 0,
                  deletedApprovals: 0,
                  deletedEventV2Sequences: 0,
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
