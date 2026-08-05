/**
 * DET-REC-01: classifyOnStartup — startup crash recovery classification
 *
 * Covers:
 *  - admitted+legacy → re-enqueued (canEnqueue branch)
 *  - provisioning+ready+no_execution+expired_lease → re-enqueued (canRequeue)
 *  - running+execution_started+expired_lease → recovery_required
 *  - running+VALID lease → skipped (not touched)
 *  - finalizing+expired_lease → recovery_required
 *  - task_run_event written co-transactionally with each state change
 *
 * Design refs: §11.1 (startup reconciliation), §1.3 #6 (single executor topology)
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { and, eq, inArray } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionTable, TaskRunTable, TaskRunEventTable } from "@deepagent-code/core/session/sql"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"
import { classifyOnStartup, getTaskRun, resolveRecovery, transitionToAdmitting } from "../../src/tool/task-run"
import { LegacyTaskInput } from "../../src/session/task-input"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)

const PARENT_SID = SessionID.make("ses_rec_parent")
const DIRECTORY = "/rec_test_dir"

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: PARENT_SID,
      project_id: ProjectV2.ID.global,
      slug: "rec-parent",
      directory: DIRECTORY,
      title: "parent",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const insertRun = (
  runID: string,
  childID: string,
  opts: {
    state?: string
    inputState?: string
    executionStartedAt?: number | null
    leaseExpiry?: number | null
    owner?: string | null
  } = {},
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    const childSID = SessionID.make(childID)
    yield* db
      .insert(SessionTable)
      .values({
        id: childSID,
        project_id: ProjectV2.ID.global,
        slug: `rec-child-${runID}`,
        directory: DIRECTORY,
        title: `child-${runID}`,
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    // tsgo: run_id is a TEXT primaryKey() with no default — required in insert type,
    // but tsgo's Drizzle generic resolution incorrectly excludes it. Cast via any.
    yield* db
      .insert(TaskRunTable)
      .values({
        run_id: runID,
        request_hash: "rhash",
        parent_session_id: PARENT_SID,
        parent_message_id: MessageID.ascending(`msg_${runID}`) as any,
        tool_call_id: `tc_${runID}`,
        child_session_id: childSID,
        generation: 1,
        delivery_mode: "foreground",
        phase: opts.state === "admitted" ? "admission" : "research",
        state: opts.state ?? "running",
        version: 0,
        control_state: "open",
        input_state: opts.inputState ?? "legacy",
        execution_owner: opts.owner !== undefined ? opts.owner : "some_owner",
        lease_expires_at: opts.leaseExpiry !== undefined ? opts.leaseExpiry : now - 5_000, // expired by default
        execution_started_at: opts.executionStartedAt !== undefined ? opts.executionStartedAt : now - 10_000,
        claim_generation: 1,
        available_at: 0,
        start_attempts: 1,
        attempts: 1,
        time_created: now - 60_000,
        time_updated: now - 10_000,
      } as any)
      .run()
      .pipe(Effect.orDie)
  })

describe("DET-REC-01: classifyOnStartup", () => {
  it.effect("admitted+input_state=legacy+expired lease → recovery_required without execution", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertRun("run_rec_admitted", "ses_rec_admitted", {
        state: "admitted",
        inputState: "legacy",
        executionStartedAt: null,
        leaseExpiry: Date.now() - 1_000,
        owner: null,
      })

      const stats = yield* classifyOnStartup({ directory: DIRECTORY })
      expect(stats.classified).toBeGreaterThanOrEqual(1)

      const { db } = yield* Database.Service
      const row = yield* db
        .select({ state: TaskRunTable.state, reason: TaskRunTable.reason })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_rec_admitted"))
        .get()
        .pipe(Effect.orDie)
      expect(row).toEqual({ state: "recovery_required", reason: "legacy_input_unverified" })

      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, "run_rec_admitted"))
        .all()
        .pipe(Effect.orDie)
      expect(events.some((e) => e.type === "recovery_required")).toBe(true)
    }),
  )

  it.effect("provisioning+ready+no execution_started+expired lease → re-enqueued", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertRun("run_rec_prov_requeue", "ses_rec_prov_requeue", {
        state: "admitted",
        inputState: "legacy",
        executionStartedAt: null,
        leaseExpiry: Date.now() - 1_000,
        owner: null,
      })

      const { db } = yield* Database.Service
      const admitted = yield* getTaskRun("run_rec_prov_requeue")
      expect(admitted).toBeTruthy()
      const admitting = yield* transitionToAdmitting({
        runID: "run_rec_prov_requeue",
        version: admitted!.version,
      })
      expect(admitting).toBeTruthy()
      const prepared = yield* LegacyTaskInput.prepare(admitting!)
      yield* LegacyTaskInput.projectExact({
        prepared,
        runID: "run_rec_prov_requeue",
        expectedRunVersion: admitting!.version,
      })
      yield* db
        .update(TaskRunTable)
        .set({
          state: "provisioning",
          phase: "provision",
          execution_owner: "expired-owner",
          lease_expires_at: Date.now() - 1_000,
        })
        .where(eq(TaskRunTable.run_id, "run_rec_prov_requeue"))
        .run()
        .pipe(Effect.orDie)

      const stats = yield* classifyOnStartup({ directory: DIRECTORY })
      expect(stats.requeued).toBeGreaterThanOrEqual(1)

      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_rec_prov_requeue"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("queued")
    }),
  )

  it.effect("running+execution_started+expired lease → recovery_required", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertRun("run_rec_running_exp", "ses_rec_running_exp", {
        state: "running",
        executionStartedAt: Date.now() - 30_000,
        leaseExpiry: Date.now() - 5_000, // lease expired
      })

      const stats = yield* classifyOnStartup({ directory: DIRECTORY })
      expect(stats.classified).toBeGreaterThanOrEqual(1)

      const { db } = yield* Database.Service
      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_rec_running_exp"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("recovery_required")

      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, "run_rec_running_exp"))
        .all()
        .pipe(Effect.orDie)
      expect(events.some((e) => e.type === "recovery_required")).toBe(true)
    }),
  )

  it.effect("running+VALID non-expired lease → skipped entirely (invariant #36)", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertRun("run_rec_healthy", "ses_rec_healthy", {
        state: "running",
        executionStartedAt: Date.now() - 5_000,
        leaseExpiry: Date.now() + 60_000, // valid lease
      })

      const stats = yield* classifyOnStartup({ directory: DIRECTORY })
      // The healthy run must NOT be classified or requeued
      expect(stats.classified).toBe(0)
      expect(stats.requeued).toBe(0)

      const { db } = yield* Database.Service
      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_rec_healthy"))
        .get()
        .pipe(Effect.orDie)
      // State must be unchanged — another process owns this run
      expect(row?.state).toBe("running")
    }),
  )

  it.effect("finalizing+expired lease → recovery_required", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertRun("run_rec_finalizing", "ses_rec_finalizing", {
        state: "finalizing",
        executionStartedAt: Date.now() - 60_000,
        leaseExpiry: Date.now() - 5_000,
      })

      // Fix phase to finalize to match state
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({ phase: "finalize" })
        .where(eq(TaskRunTable.run_id, "run_rec_finalizing"))
        .run()
        .pipe(Effect.orDie)

      const stats = yield* classifyOnStartup({ directory: DIRECTORY })
      expect(stats.classified).toBeGreaterThanOrEqual(1)

      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_rec_finalizing"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("recovery_required")
    }),
  )

  it.effect("pending, admitting, and corrupt ready inputs fail closed with distinct reasons", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertRun("run_rec_pending", "ses_rec_pending", {
        state: "admitted",
        inputState: "pending",
        executionStartedAt: null,
        owner: null,
      })
      yield* insertRun("run_rec_admitting", "ses_rec_admitting", {
        state: "admitted",
        inputState: "admitting",
        executionStartedAt: null,
        owner: null,
      })
      yield* insertRun("run_rec_corrupt_ready", "ses_rec_corrupt_ready", {
        state: "admitted",
        inputState: "ready",
        executionStartedAt: null,
        owner: null,
      })

      const stats = yield* classifyOnStartup({ directory: DIRECTORY })
      expect(stats.classified).toBeGreaterThanOrEqual(3)
      const { db } = yield* Database.Service
      const rows = yield* db
        .select({ runID: TaskRunTable.run_id, state: TaskRunTable.state, reason: TaskRunTable.reason })
        .from(TaskRunTable)
        .where(inArray(TaskRunTable.run_id, ["run_rec_pending", "run_rec_admitting", "run_rec_corrupt_ready"]))
        .all()
        .pipe(Effect.orDie)
      expect(Object.fromEntries(rows.map((row) => [row.runID, row.reason]))).toEqual({
        run_rec_pending: "input_not_materialized",
        run_rec_admitting: "input_admission_outcome_unknown",
        run_rec_corrupt_ready: "input_materialization_mismatch",
      })
      expect(rows.every((row) => row.state === "recovery_required")).toBe(true)
    }),
  )

  it.effect("explicit resolution closes active descendants and same-child later generations atomically", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertRun("run_rec_root", "ses_rec_resolution", {
        state: "running",
        inputState: "ready",
        executionStartedAt: Date.now() - 1_000,
      })
      yield* insertRun("run_rec_descendant", "ses_rec_descendant", {
        state: "running",
        inputState: "ready",
        executionStartedAt: Date.now() - 1_000,
      })
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({ state: "recovery_required", execution_owner: "stale-root-owner", lease_expires_at: Date.now() - 1 })
        .where(eq(TaskRunTable.run_id, "run_rec_root"))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(TaskRunTable)
        .set({ parent_run_id: "run_rec_root" })
        .where(eq(TaskRunTable.run_id, "run_rec_descendant"))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: "run_rec_later",
          root_run_id: "run_rec_root",
          continuation_of_run_id: "run_rec_root",
          request_hash: "later",
          parent_session_id: PARENT_SID,
          parent_message_id: MessageID.ascending("msg_run_rec_later"),
          tool_call_id: "tc_run_rec_later",
          child_session_id: SessionID.make("ses_rec_resolution"),
          generation: 2,
          delivery_mode: "foreground",
          phase: "admission",
          state: "admitted",
          version: 0,
          control_state: "open",
          input_state: "pending",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)

      yield* resolveRecovery({ runID: "run_rec_root", resolution: "failed", reason: "explicit_test" })
      const rows = yield* db
        .select({ runID: TaskRunTable.run_id, state: TaskRunTable.state, owner: TaskRunTable.execution_owner })
        .from(TaskRunTable)
        .where(inArray(TaskRunTable.run_id, ["run_rec_root", "run_rec_descendant", "run_rec_later"]))
        .all()
        .pipe(Effect.orDie)
      const states = Object.fromEntries(rows.map((row) => [row.runID, row.state]))
      expect(states).toEqual({
        run_rec_root: "failed",
        run_rec_descendant: "closed",
        run_rec_later: "closed",
      })
      expect(rows.every((row) => row.owner === null)).toBe(true)
    }),
  )
})
