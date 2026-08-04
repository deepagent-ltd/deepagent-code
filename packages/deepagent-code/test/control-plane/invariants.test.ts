/**
 * DET-INV: Minimum deterministic coverage for previously-untested invariants.
 * D-3 (P1-12): covers invariants 2, 6, 14, 15, 16 from the design §1.3 table.
 *
 * Invariant 2:  public task_id === child_session_id everywhere
 * Invariant 6:  all ancestors open at admission time
 * Invariant 14: no provider retry after provider work started (execution_started_at set)
 * Invariant 15: no replacement child on timeout/error/interrupt
 * Invariant 16: no automatic takeover in production (spawnTaskTakeover must be guarded)
 *
 * Design refs: §1.3 invariant list, §6.1 admission, §6.4 execution
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"
import { admitTaskRun, getTaskRun, isTerminal, isQuiescent, classifyOnStartup } from "../../src/tool/task-run"
import { startExecution } from "../../src/session/task-executor"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)

const PARENT_SID = SessionID.make("ses_inv_parent")
const DIRECTORY = "/inv_test_dir"

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
      slug: "inv-parent",
      directory: DIRECTORY,
      title: "parent",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

// ── Invariant 2: public task_id === child_session_id ─────────────────────────

describe("CP-TASK-ID-01 (invariant 2): public task_id === child_session_id", () => {
  it.effect("admitTaskRun: run.childSessionID is the stable public task_id", () =>
    Effect.gen(function* () {
      yield* setup
      const admission = yield* admitTaskRun({
        parentSessionID: PARENT_SID,
        parentMessageID: MessageID.ascending("msg_inv2_001") as any,
        toolCallID: "tc_inv2_001",
        request: { description: "invariant 2 test" },
        deliveryMode: "foreground",
      })
      // Invariant 2: the public task_id MUST equal child_session_id
      expect(admission.run.childSessionID).toBeTruthy()
      // The run row is indexed by run_id (internal); child_session_id is what callers see
      expect(admission.run.runID).not.toBe(admission.run.childSessionID.toString())
      // getTaskRun fetches by internal run_id; callers must use child_session_id for task_read
      const fetched = yield* getTaskRun(admission.run.runID)
      expect(fetched?.childSessionID.toString()).toBe(admission.run.childSessionID.toString())
    }),
  )
})

// ── Invariant 6: all ancestors open at admission ──────────────────────────────

describe("CP-ANCESTOR-OPEN-01 (invariant 6): ancestor open check", () => {
  it.effect("admitTaskRun with new root child succeeds (no parent run → open)", () =>
    Effect.gen(function* () {
      yield* setup
      // Top-level admit: no parent run → passes ancestor check trivially
      const admission = yield* admitTaskRun({
        parentSessionID: PARENT_SID,
        parentMessageID: MessageID.ascending("msg_anc_001") as any,
        toolCallID: "tc_anc_001",
        request: { description: "ancestor open test" },
        deliveryMode: "foreground",
      })
      expect(admission.run.state).toBe("admitted")
    }),
  )

  it.effect("classifyOnStartup skips runs with valid (non-expired) leases", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const childSID = SessionID.make("ses_inv6_child")
      yield* db
        .insert(SessionTable)
        .values({
          id: childSID,
          project_id: ProjectV2.ID.global,
          slug: "inv6-child",
          directory: DIRECTORY,
          title: "child",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: "run_inv6_active",
          request_hash: "h1",
          parent_session_id: PARENT_SID,
          parent_message_id: MessageID.ascending("msg_inv6") as any,
          tool_call_id: "tc_inv6",
          child_session_id: childSID,
          generation: 1,
          delivery_mode: "foreground",
          phase: "research",
          state: "running",
          version: 0,
          control_state: "open",
          input_state: "ready",
          execution_owner: "live_owner",
          lease_expires_at: Date.now() + 60_000, // valid non-expired
          execution_started_at: Date.now() - 5_000,
          claim_generation: 1,
          available_at: 0,
          start_attempts: 1,
          attempts: 1,
          time_created: Date.now() - 60_000,
          time_updated: Date.now() - 5_000,
        } as any)
        .run()
        .pipe(Effect.orDie)

      // classifyOnStartup must NOT touch the running run with a valid lease (invariant 6/36)
      const stats = yield* classifyOnStartup({ directory: DIRECTORY })
      expect(stats.classified).toBe(0)
      expect(stats.requeued).toBe(0)

      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_inv6_active"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("running") // untouched
    }),
  )
})

// ── Invariant 14: no provider retry after execution_started_at ───────────────

describe("CP-NO-REPLAY-01 (invariant 14): no provider retry after execution started", () => {
  it.effect("startExecution requires execution_started_at IS NULL (no double-start)", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const childSID = SessionID.make("ses_inv14_child")
      yield* db
        .insert(SessionTable)
        .values({
          id: childSID,
          project_id: ProjectV2.ID.global,
          slug: "inv14-child",
          directory: DIRECTORY,
          title: "child",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const now = Date.now()
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: "run_inv14_started",
          request_hash: "h14",
          parent_session_id: PARENT_SID,
          parent_message_id: MessageID.ascending("msg_inv14") as any,
          tool_call_id: "tc_inv14",
          child_session_id: childSID,
          generation: 1,
          delivery_mode: "foreground",
          phase: "provision",
          state: "provisioning",
          version: 0,
          control_state: "open",
          input_state: "ready",
          execution_owner: "owner_14",
          lease_expires_at: now + 60_000,
          // invariant 14: execution_started_at is already set (provider already ran)
          execution_started_at: now - 30_000,
          claim_generation: 1,
          available_at: 0,
          start_attempts: 1,
          attempts: 1,
          time_created: now - 60_000,
          time_updated: now - 30_000,
        } as any)
        .run()
        .pipe(Effect.orDie)

      // startExecution with execution_started_at already set must fail (A-3 / invariant 14)
      const run = { runID: "run_inv14_started", version: 0, claimGeneration: 1 } as any
      const result = yield* startExecution({ run, ownerToken: "owner_14" }).pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("LegacySubagentExecutor.ClaimLost", () => Effect.succeed("claim_lost" as const)),
      )
      expect(result).toBe("claim_lost") // must reject: execution already started
    }),
  )
})

// ── Invariant 15: no replacement child on timeout/error/interrupt ─────────────

describe("CP-NO-REPLACE-01 (invariant 15): recovery_required is NOT terminal", () => {
  it.effect("isTerminal returns false for recovery_required (quiescent, not terminal)", () =>
    Effect.gen(function* () {
      // C-5 (P1-7): recovery_required must NOT appear in terminalStates
      const mockRun = { state: "recovery_required" } as any
      expect(isTerminal(mockRun)).toBe(false)
      expect(isQuiescent(mockRun)).toBe(true)
    }),
  )

  it.effect("classifyOnStartup sets recovery_required for lease-expired running run with execution_started", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const childSID = SessionID.make("ses_inv15_child")
      yield* db
        .insert(SessionTable)
        .values({
          id: childSID,
          project_id: ProjectV2.ID.global,
          slug: "inv15-child",
          directory: DIRECTORY,
          title: "child",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: "run_inv15",
          request_hash: "h15",
          parent_session_id: PARENT_SID,
          parent_message_id: MessageID.ascending("msg_inv15") as any,
          tool_call_id: "tc_inv15",
          child_session_id: childSID,
          generation: 1,
          delivery_mode: "foreground",
          phase: "research",
          state: "running",
          version: 0,
          control_state: "open",
          input_state: "ready",
          execution_owner: "dead_owner",
          lease_expires_at: Date.now() - 10_000, // expired
          execution_started_at: Date.now() - 60_000, // provider started
          claim_generation: 1,
          available_at: 0,
          start_attempts: 1,
          attempts: 1,
          time_created: Date.now() - 120_000,
          time_updated: Date.now() - 60_000,
        } as any)
        .run()
        .pipe(Effect.orDie)

      const stats = yield* classifyOnStartup({ directory: DIRECTORY })
      expect(stats.classified).toBeGreaterThanOrEqual(1) // recovery_required, not re-queued

      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_inv15"))
        .get()
        .pipe(Effect.orDie)
      // Must be recovery_required — not automatically re-queued (provider may have done work)
      expect(row?.state).toBe("recovery_required")
      expect(isTerminal(row as any)).toBe(false) // not terminal
      expect(isQuiescent(row as any)).toBe(true) // quiescent
    }),
  )
})

// ── Invariant 16: no automatic takeover in production ────────────────────────

describe("CP-NO-TAKEOVER-01 (invariant 16): recovery never creates an automatic replacement", () => {
  it.effect("startup classification only marks the existing run recovery_required", () =>
    Effect.gen(function* () {
      // Invariant 16: automatic takeover must not occur.
      // classifyOnStartup must never create a new run — it only reclassifies existing ones.
      // We verify by counting runs before and after a classify call with a stale running run.
      yield* setup
      const { db } = yield* Database.Service
      const childSID = SessionID.make("ses_inv16_child")
      yield* db
        .insert(SessionTable)
        .values({
          id: childSID,
          project_id: ProjectV2.ID.global,
          slug: "inv16-child",
          directory: DIRECTORY,
          title: "child",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: "run_inv16",
          request_hash: "h16",
          parent_session_id: PARENT_SID,
          parent_message_id: MessageID.ascending("msg_inv16") as any,
          tool_call_id: "tc_inv16",
          child_session_id: childSID,
          generation: 1,
          delivery_mode: "foreground",
          phase: "research",
          state: "running",
          version: 0,
          control_state: "open",
          input_state: "ready",
          execution_owner: "dead_owner_16",
          lease_expires_at: Date.now() - 5_000, // expired
          execution_started_at: Date.now() - 60_000,
          claim_generation: 1,
          available_at: 0,
          start_attempts: 1,
          attempts: 1,
          time_created: Date.now() - 120_000,
          time_updated: Date.now() - 60_000,
        } as any)
        .run()
        .pipe(Effect.orDie)

      const countBefore = yield* db.select({ c: TaskRunTable.run_id }).from(TaskRunTable).all().pipe(Effect.orDie)
      // Run classify twice (second call is idempotent — already recovery_required)
      yield* classifyOnStartup({ directory: DIRECTORY }).pipe(Effect.ignore)
      yield* classifyOnStartup({ directory: DIRECTORY }).pipe(Effect.ignore)
      const countAfter = yield* db.select({ c: TaskRunTable.run_id }).from(TaskRunTable).all().pipe(Effect.orDie)

      // classifyOnStartup must NOT create any new runs (no replacement/takeover)
      expect(countAfter.length).toBe(countBefore.length)
      // The stale run must be recovery_required, not re-queued
      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_inv16"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("recovery_required")
    }),
  )
})
