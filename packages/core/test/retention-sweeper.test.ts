import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { RetentionSweeper } from "@deepagent-code/core/deepagent/retention-sweeper"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEventDeliveryTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { ApprovalQueueTable } from "@deepagent-code/core/deepagent/approval-queue-sql"
import { AgentPushLogTable } from "@deepagent-code/core/im/push-log-sql"
import { EventSequenceTable, EventTable } from "@deepagent-code/core/event/sql"
import { EventV2 } from "@deepagent-code/core/event"
import {
  FilePartArtifactChunkTable,
  FilePartArtifactImportTable,
  FilePartArtifactTable,
} from "@deepagent-code/core/file-part-artifact.sql"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { testEffect } from "./lib/effect"

// V4.0 §A3 保留期 — the retention sweep + sweeper daemon. Verifies age-based deletion, referential
// safety (a pending delivery / unresolved approval spares its event), per-workspace retentionDays, and
// workspace isolation. `now` is a deterministic clock so the cutoff math is exact.

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

const DAY = 86_400_000

const database = Database.layerFromPath(":memory:")
const bus = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
const cfg = WorkspaceConfig.layerWith({ now }).pipe(Layer.provideMerge(database))
// runLoop:false — drive sweepOnce directly for determinism.
const sweeper = RetentionSweeper.layerWith({ now, runLoop: false }).pipe(
  Layer.provide(bus),
  Layer.provide(cfg),
  Layer.provide(database),
)
const it = testEffect(Layer.mergeAll(sweeper, bus, cfg, database))

const publishAt = (bus: DeepAgentEventBus.Interface, at: number, over?: Partial<DeepAgentEvent.PublishInput>) => {
  setNow(at)
  return bus.publish({
    type: "ci.failure",
    source: "ci",
    workspaceID: "wrk_1",
    idempotencyKey: `k-${at}-${Math.random()}`,
    payload: { failedTests: 1 },
    ...over,
  })
}

describe("RetentionSweeper", () => {
  it.effect("§A3 deletes events older than retention, keeps fresh ones", () =>
    Effect.gen(function* () {
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })

      const old = yield* publishAt(b, 1_000) // ancient
      const fresh = yield* publishAt(b, 100 * DAY) // recent

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedEvents).toBe(1)

      const remaining = yield* b.getByID(old.id)
      expect(remaining).toBeUndefined() // swept
      const kept = yield* b.getByID(fresh.id)
      expect(kept?.id).toBe(fresh.id) // spared
    }),
  )

  it.effect("§A3 referential safety: an event with a PENDING delivery survives its retention window", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })

      const owed = yield* publishAt(b, 1_000)
      const plain = yield* publishAt(b, 2_000)
      // an unacked at-least-once delivery still owes `owed` to a consumer group.
      yield* db
        .insert(DeepAgentEventDeliveryTable)
        .values([
          {
            event_id: owed.id,
            subscription_group: "router",
            status: "pending",
            attempts: 0,
            last_error: null,
            next_attempt_at: 1_000,
            created_at: 1_000,
            updated_at: 1_000,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedEvents).toBe(1) // only `plain`

      expect(yield* b.getByID(owed.id)).toBeDefined() // spared — still owed
      expect(yield* b.getByID(plain.id)).toBeUndefined()
    }),
  )

  it.effect("§A3 referential safety: a DELIVERED delivery does NOT protect its event (cascades)", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })

      const done = yield* publishAt(b, 1_000)
      yield* db
        .insert(DeepAgentEventDeliveryTable)
        .values([
          {
            event_id: done.id,
            subscription_group: "router",
            status: "delivered",
            attempts: 0,
            last_error: null,
            next_attempt_at: null,
            created_at: 1_000,
            updated_at: 1_000,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedEvents).toBe(1)
      expect(yield* b.getByID(done.id)).toBeUndefined()
      // the delivery row cascaded away with the event.
      const deliveries = yield* db.select().from(DeepAgentEventDeliveryTable).all().pipe(Effect.orDie)
      expect(deliveries.length).toBe(0)
    }),
  )

  it.effect("§A3 referential safety: an UNRESOLVED approval-queue item spares its event", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })

      const escalated = yield* publishAt(b, 1_000)
      yield* db
        .insert(ApprovalQueueTable)
        .values([
          {
            id: "apq_1",
            workspace_id: "wrk_1",
            event_id: escalated.id,
            event_type: "goal.needs_human",
            correlation_id: null,
            summary: "needs a human",
            status: "pending",
            decision: null,
            resolved_by: null,
            resolved_at: null,
            created_at: 1_000,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      setNow(100 * DAY)
      yield* s.sweepOnce()
      expect(yield* b.getByID(escalated.id)).toBeDefined() // spared — human still owes a decision
    }),
  )

  it.effect("§A3 a RESOLVED approval-queue item does NOT spare its event and is itself pruned", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })

      const settled = yield* publishAt(b, 1_000)
      yield* db
        .insert(ApprovalQueueTable)
        .values([
          {
            id: "apq_2",
            workspace_id: "wrk_1",
            event_id: settled.id,
            event_type: "goal.needs_human",
            correlation_id: null,
            summary: "was resolved",
            status: "resolved",
            decision: "approved",
            resolved_by: "user_1",
            resolved_at: 2_000,
            created_at: 1_000,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(yield* b.getByID(settled.id)).toBeUndefined() // resolved item doesn't protect it
      expect(summary.deletedApprovals).toBe(1) // and the resolved row is pruned
      const approvals = yield* db.select().from(ApprovalQueueTable).all().pipe(Effect.orDie)
      expect(approvals.length).toBe(0)
    }),
  )

  it.effect("§A3 respects PER-WORKSPACE retentionDays", () =>
    Effect.gen(function* () {
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      // wrk_short keeps 1 day; wrk_long keeps 90.
      yield* c.set("wrk_short", { retentionDays: 1 })
      yield* c.set("wrk_long", { retentionDays: 90 })

      const shortEvt = yield* publishAt(b, 100 * DAY, { workspaceID: "wrk_short" })
      const longEvt = yield* publishAt(b, 100 * DAY, { workspaceID: "wrk_long" })

      // 10 days later: past wrk_short's 1-day window, within wrk_long's 90-day window.
      setNow(110 * DAY)
      yield* s.sweepOnce()
      expect(yield* b.getByID(shortEvt.id)).toBeUndefined() // 10d > 1d retention
      expect(yield* b.getByID(longEvt.id)).toBeDefined() // 10d < 90d retention
    }),
  )

  it.effect("§A3 workspace isolation: a sweep never crosses workspace boundaries", () =>
    Effect.gen(function* () {
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_a", { retentionDays: 1 })
      yield* c.set("wrk_b", { retentionDays: 1 })

      const a = yield* publishAt(b, 1_000, { workspaceID: "wrk_a" })
      const b1 = yield* publishAt(b, 100 * DAY, { workspaceID: "wrk_b" }) // fresh in B

      setNow(100 * DAY)
      yield* s.sweepOnce()
      expect(yield* b.getByID(a.id)).toBeUndefined() // A's old event swept
      expect(yield* b.getByID(b1.id)).toBeDefined() // B's fresh event untouched
    }),
  )

  it.effect("§B4 prunes agent push audit rows past retention", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })
      // an event so the workspace is enumerated by the sweep.
      yield* publishAt(b, 100 * DAY)

      yield* db
        .insert(AgentPushLogTable)
        .values([
          {
            id: "push_old",
            workspace_id: "wrk_1",
            group_id: "img_1" as any,
            agent_id: "agt_1",
            reason: "old",
            priority: "normal",
            decision: "deliver",
            idempotency_key: "old-1",
            message_id: null,
            content: null,
            created_at: 1_000,
          },
          {
            id: "push_new",
            workspace_id: "wrk_1",
            group_id: "img_1" as any,
            agent_id: "agt_1",
            reason: "new",
            priority: "normal",
            decision: "deliver",
            idempotency_key: "new-1",
            message_id: null,
            content: null,
            created_at: 100 * DAY,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedPushLogs).toBe(1)
      const logs = yield* db.select().from(AgentPushLogTable).all().pipe(Effect.orDie)
      expect(logs.map((l) => l.id)).toEqual(["push_new"])
    }),
  )

  // PERF §EventV2-retention: verify that EventV2 mirror events are pruned for archived sessions
  // that exceeded retentionDays. The event table has no timestamp of its own; we use the session's
  // time_archived as the retention anchor.

  /** Insert a minimal project + session row so the event_sequence FK is satisfiable. */
  const insertArchivedSession = (opts: { sessionID: string; workspaceID: string; timeArchived: number }) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .run(
          `INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated)
           VALUES ('proj_test', '/tmp', '[]', 0, 0)`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          `INSERT OR IGNORE INTO session
             (id, project_id, workspace_id, slug, directory, title, version, time_created, time_updated, time_archived)
           VALUES ('${opts.sessionID}', 'proj_test', '${opts.workspaceID}', 'test',
                   '/tmp', 'test', '1', 0, 0, ${opts.timeArchived})`,
        )
        .pipe(Effect.orDie)
    })

  /** Insert event_sequence + one event row for a session aggregate. */
  const insertEventV2 = (opts: { sessionID: string; eventID: string }) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .run(`INSERT OR IGNORE INTO event_sequence (aggregate_id, seq) VALUES ('${opts.sessionID}', 1)`)
        .pipe(Effect.orDie)
      yield* db
        .run("UPDATE event_sync_sequence SET seq = seq + 1 WHERE id = 1")
        .pipe(Effect.orDie)
      yield* db
        .run(
          `INSERT OR IGNORE INTO event (id, aggregate_id, seq, type, data, sync_seq)
           VALUES (
             '${opts.eventID}', '${opts.sessionID}', 1, 'message.part.updated.1', '{}',
             (SELECT seq FROM event_sync_sequence WHERE id = 1)
           )`,
        )
        .pipe(Effect.orDie)
    })

  it.effect("§EventV2-retention: preserves archived EventV2 roots until explicit removal", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })
      // Publish a DeepAgentEvent so the workspace is enumerated by the sweeper.
      yield* publishAt(b, 1_000)

      // An archived session whose time_archived is ancient (1 ms epoch = 1970).
      yield* insertArchivedSession({ sessionID: "ses_old", workspaceID: "wrk_1", timeArchived: 1_000 })
      yield* insertEventV2({ sessionID: "ses_old", eventID: "evt_old" })

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedEventV2Sequences).toBe(0)

      // Archived roots remain readable; Session/EventV2.remove owns the explicit cascade.
      const seqs = yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)
      expect(seqs.find((r) => r.aggregate_id === "ses_old")).toBeDefined()
      const evts = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(evts.find((r) => r.id === "evt_old")).toBeDefined()
    }),
  )

  it.effect("§EventV2-retention: discovers archived Session workspaces without a DeepAgent event", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_session_only", { retentionDays: 30 })
      yield* insertArchivedSession({ sessionID: "ses_session_only", workspaceID: "wrk_session_only", timeArchived: 1_000 })
      yield* insertEventV2({ sessionID: "ses_session_only", eventID: "evt_session_only" })

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.workspacesSwept).toBe(1)
      expect(summary.deletedEventV2Sequences).toBe(0)
      expect(yield* db.select().from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, "ses_session_only")).get()).toBeDefined()
    }),
  )

  it.effect("§EventV2-retention: preserves sidecar authorities without blocking other archived sessions", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })
      yield* publishAt(b, 1_000)

      yield* insertArchivedSession({ sessionID: "ses_artifact", workspaceID: "wrk_1", timeArchived: 1_000 })
      yield* insertEventV2({ sessionID: "ses_artifact", eventID: "evt_artifact" })
      yield* db.run(`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('msg_artifact', 'ses_artifact', 1, 1, '{"role":"user","time":{"created":1}}')
      `).pipe(Effect.orDie)
      yield* db.run(`
        INSERT INTO event_artifact (
          artifact_id, event_id, aggregate_id, seq, kind, original_data_hash,
          canonical_data_hash, canonical_data, body_hash, body_bytes, chunk_count,
          codec_version, created_at
        ) VALUES (
          'evtart_retention', 'evt_artifact', 'ses_artifact', 1, 'legacy_message_diff',
          '${"a".repeat(64)}', '${"b".repeat(64)}', '{}', '${"c".repeat(64)}', 0, 1, 2, 1
        )
      `).pipe(Effect.orDie)
      yield* db.run(`
        INSERT INTO session_diff_migration_receipt (
          message_id, session_id, artifact_id, source_event_id,
          expected_message_data_hash, committed_message_data_hash,
          expected_session_summary_hash, committed_session_summary_hash,
          canonicalizer_version, canonicalization_version, epoch_hashes, state,
          failure_reason, created_at, updated_at, committed_at
        ) VALUES (
          'msg_artifact', 'ses_artifact', 'evtart_retention', 'evt_artifact',
          '${"d".repeat(64)}', '${"e".repeat(64)}', '${"f".repeat(64)}', '${"0".repeat(64)}',
          1, 1, '[]', 'committed', NULL, 1, 1, 1
        )
      `).pipe(Effect.orDie)
      yield* insertArchivedSession({ sessionID: "ses_prunable", workspaceID: "wrk_1", timeArchived: 1_000 })
      yield* insertEventV2({ sessionID: "ses_prunable", eventID: "evt_prunable" })

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedEventV2Sequences).toBe(0)
      expect(
        yield* db.select().from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, "ses_artifact")).get().pipe(Effect.orDie),
      ).toBeDefined()
      expect(
        yield* db.select().from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, "ses_prunable")).get().pipe(Effect.orDie),
      ).toBeDefined()
      expect(yield* db.all<{ state: string }>(sql`
        SELECT state FROM session_diff_migration_receipt WHERE message_id = 'msg_artifact'
      `).pipe(Effect.orDie)).toEqual([{ state: "committed" }])
    }),
  )

  it.effect("§EventV2-retention: invokes bounded compaction for sidecar sessions instead of leaking raw history", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      yield* c.set("wrk_1", { retentionDays: 30 })
      yield* publishAt(b, 1_000)
      yield* insertArchivedSession({ sessionID: "ses_compact", workspaceID: "wrk_1", timeArchived: 1_000 })
      yield* insertEventV2({ sessionID: "ses_compact", eventID: "evt_compact" })
      yield* db.run(`
        INSERT INTO event_artifact (
          artifact_id, event_id, aggregate_id, seq, kind, original_data_hash,
          canonical_data_hash, canonical_data, body_hash, body_bytes, chunk_count,
          codec_version, created_at
        ) VALUES (
          'evtart_compact', 'evt_compact', 'ses_compact', 1, 'legacy_message_diff',
          '${"a".repeat(64)}', '${"b".repeat(64)}', '{}', '${"c".repeat(64)}', 0, 1, 2, 1
        )
      `).pipe(Effect.orDie)
      setNow(100 * DAY)
      const invoked: string[] = []
      const compacting = RetentionSweeper.layerWith({
        now,
        runLoop: false,
        compactSession: (sessionID) =>
          Effect.sync(() => invoked.push(sessionID)).pipe(Effect.as(true)),
      }).pipe(
        Layer.provide(Layer.succeed(DeepAgentEventBus.Service)(b)),
        Layer.provide(Layer.succeed(WorkspaceConfig.Service)(c)),
        Layer.provide(Layer.succeed(Database.Service)({ db })),
      )
      const summary = yield* Effect.gen(function* () {
        const service = yield* RetentionSweeper.Service
        return yield* service.sweepOnce()
      }).pipe(Effect.provide(Layer.fresh(compacting)))
      expect(summary.deletedEventV2Sequences).toBe(0)
      expect(invoked).toEqual(["ses_compact"])
      expect(yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, "ses_compact")).get()).toBeDefined()
    }),
  )

  it.effect("§EventV2-retention: sidecar compaction cannot starve an independent prunable batch", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      yield* c.set("wrk_1", { retentionDays: 30 })
      yield* publishAt(b, 1_000)
      yield* Effect.forEach(
        Array.from({ length: 101 }, (_, index) => String(index).padStart(3, "0")),
        (suffix) => Effect.gen(function* () {
          const sessionID = `ses_sidecar_${suffix}`
          const eventID = `evt_sidecar_${suffix}`
          yield* insertArchivedSession({ sessionID, workspaceID: "wrk_1", timeArchived: 1_000 })
          yield* insertEventV2({ sessionID, eventID })
          yield* db.run(sql`
            INSERT INTO event_artifact (
              artifact_id, event_id, aggregate_id, seq, kind, original_data_hash,
              canonical_data_hash, canonical_data, body_hash, body_bytes, chunk_count,
              codec_version, created_at
            ) VALUES (
              ${`evtart_sidecar_${suffix}`}, ${eventID}, ${sessionID}, 1, 'legacy_message_diff',
              ${"a".repeat(64)}, ${"b".repeat(64)}, '{}', ${"c".repeat(64)}, 0, 1, 2, 1
            )
          `).pipe(Effect.orDie)
        }),
        { discard: true },
      )
      yield* insertArchivedSession({ sessionID: "ses_zz_prunable", workspaceID: "wrk_1", timeArchived: 1_000 })
      yield* insertEventV2({ sessionID: "ses_zz_prunable", eventID: "evt_zz_prunable" })

      setNow(100 * DAY)
      const invoked: string[] = []
      const compacting = RetentionSweeper.layerWith({
        now,
        runLoop: false,
        compactSession: (sessionID) => Effect.sync(() => invoked.push(sessionID)).pipe(Effect.as(false)),
      }).pipe(
        Layer.provide(Layer.succeed(DeepAgentEventBus.Service)(b)),
        Layer.provide(Layer.succeed(WorkspaceConfig.Service)(c)),
        Layer.provide(Layer.succeed(Database.Service)({ db })),
      )
      const summary = yield* Effect.gen(function* () {
        const service = yield* RetentionSweeper.Service
        return yield* service.sweepOnce()
      }).pipe(Effect.provide(Layer.fresh(compacting)))
      expect(summary.deletedEventV2Sequences).toBe(0)
      expect(invoked).toHaveLength(100)
      expect(yield* db.select().from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, "ses_zz_prunable")).get()).toBeDefined()
    }),
  )

  it.effect("§EventV2-retention: reclaims an expired abandoned FilePart import", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const s = yield* RetentionSweeper.Service
      yield* db.insert(FilePartArtifactTable).values({
        artifact_id: "fpart_abandoned",
        body_hash: "a".repeat(64),
        body_bytes: 1,
        chunk_bytes: 262_144,
        chunk_count: 1,
        codec_version: 1,
        complete: true,
        created_at: 1,
      }).run().pipe(Effect.orDie)
      yield* db.insert(FilePartArtifactChunkTable).values({
        artifact_id: "fpart_abandoned",
        chunk_index: 0,
        data: Buffer.from("x"),
        chunk_hash: "b".repeat(64),
      }).run().pipe(Effect.orDie)
      yield* db.insert(FilePartArtifactImportTable).values({
        event_id: EventV2.ID.make("evt_abandoned"),
        aggregate_id: "ses_abandoned",
        seq: 1,
        artifact_id: "fpart_abandoned",
        original_data_hash: "c".repeat(64),
        canonical_data_hash: "d".repeat(64),
        canonical_data: {},
        created_at: 1,
      }).run().pipe(Effect.orDie)

      yield* s.sweepOnce(2 * DAY)
      expect(yield* db.select().from(FilePartArtifactImportTable).all()).toEqual([])
      expect(yield* db.select().from(FilePartArtifactTable).all()).toEqual([])
      expect(yield* db.select().from(FilePartArtifactChunkTable).all()).toEqual([])
    }),
  )

  it.effect("§EventV2-retention: spares event_sequence rows for recently-archived sessions", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })
      yield* publishAt(b, 100 * DAY)

      // Archived just now — not yet past retentionDays.
      yield* insertArchivedSession({ sessionID: "ses_new", workspaceID: "wrk_1", timeArchived: 100 * DAY })
      yield* insertEventV2({ sessionID: "ses_new", eventID: "evt_new" })

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedEventV2Sequences).toBe(0)

      const seqs = yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)
      expect(seqs.find((r) => r.aggregate_id === "ses_new")).toBeDefined()
    }),
  )

  it.effect("§EventV2-retention: spares event_sequence rows for non-archived sessions", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })
      yield* publishAt(b, 1_000)

      // Insert with a placeholder time_archived, then clear it to NULL → active session.
      yield* insertArchivedSession({ sessionID: "ses_active", workspaceID: "wrk_1", timeArchived: 0 })
      yield* db
        .run(`UPDATE session SET time_archived = NULL WHERE id = 'ses_active'`)
        .pipe(Effect.orDie)
      yield* insertEventV2({ sessionID: "ses_active", eventID: "evt_active" })

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedEventV2Sequences).toBe(0)

      const seqs = yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)
      expect(seqs.find((r) => r.aggregate_id === "ses_active")).toBeDefined()
    }),
  )
})
