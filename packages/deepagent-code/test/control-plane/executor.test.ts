/**
 * DET-FENCE-01: startExecution + settleRun CAS/lease/generation fences
 *
 * Covers:
 *  - startExecution: correct params succeed; wrong generation/owner/input_state fail
 *  - settleRun: correct params produce won=true; expired lease/wrong generation produce won=false
 *  - Audit trail: task_run_event rows written co-transactionally
 *
 * Design refs: §5 (stale callback), §6.4 (start fence), §6.7 (settle priority), §1.3 #24 (events)
 */
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionTable, TaskRunTable, TaskRunEventTable } from "@deepagent-code/core/session/sql"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { run as runExecutor, startExecution, settleRun } from "../../src/session/task-executor"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)

const PARENT_SID = SessionID.make("ses_exec_parent")
const DIRECTORY = "/exec_test_dir"
const OWNER = "test_owner_1"
const CLAIM_GEN = 1

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
      slug: "exec-parent",
      directory: DIRECTORY,
      title: "parent",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const insertProvisioningRun = (
  runID: string,
  childID: string,
  opts: {
    owner?: string
    version?: number
    claimGen?: number
    leaseExpiry?: number
    inputState?: string
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
        slug: `exec-child-${runID}`,
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
        phase: "provision",
        state: "provisioning",
        version: opts.version ?? 0,
        control_state: "open",
        input_state: opts.inputState ?? "ready",
        execution_owner: opts.owner ?? OWNER,
        lease_expires_at: opts.leaseExpiry ?? now + 60_000,
        claim_generation: opts.claimGen ?? CLAIM_GEN,
        available_at: 0,
        start_attempts: 1,
        attempts: 1,
        time_created: now,
        time_updated: now,
      } as any)
      .run()
      .pipe(Effect.orDie)
  })

const assistantMessage = (id: string, text: string) =>
  ({
    info: { id, role: "assistant" },
    parts: [{ type: "text", text, synthetic: false, ignored: false }],
  }) as unknown as SessionV1.WithParts

// ── startExecution ────────────────────────────────────────────────────────────

describe("DET-FENCE-01 startExecution CAS", () => {
  it.effect("correct owner/version/claimGen → transitions to running + writes event", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertProvisioningRun("run_se_ok", "ses_exec_se_ok")

      const { db } = yield* Database.Service
      const run = {
        runID: "run_se_ok",
        version: 0,
        claimGeneration: CLAIM_GEN,
        inputState: "ready" as const,
        controlState: "open" as const,
        state: "provisioning" as const,
        phase: "provision" as const,
        // minimal run shape needed by startExecution
      } as any
      yield* startExecution({ run, ownerToken: OWNER, leaseMs: 30_000 })

      const row = yield* db
        .select({ state: TaskRunTable.state, version: TaskRunTable.version })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_se_ok"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("running")
      expect(row?.version).toBe(1)

      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, "run_se_ok"))
        .all()
        .pipe(Effect.orDie)
      expect(events.some((e) => e.type === "execution_started")).toBe(true)
    }),
  )

  it.effect("wrong claim_generation → ExecutorClaimLostError", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertProvisioningRun("run_se_badgen", "ses_exec_se_badgen")

      const run = { runID: "run_se_badgen", version: 0, claimGeneration: 99 } as any
      const result = yield* startExecution({ run, ownerToken: OWNER }).pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("LegacySubagentExecutor.ClaimLost", () => Effect.succeed("claim_lost" as const)),
      )
      expect(result).toBe("claim_lost")
    }),
  )

  it.effect("wrong owner → ExecutorClaimLostError", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertProvisioningRun("run_se_badowner", "ses_exec_se_badowner")

      const run = { runID: "run_se_badowner", version: 0, claimGeneration: CLAIM_GEN } as any
      const result = yield* startExecution({ run, ownerToken: "wrong_owner" }).pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("LegacySubagentExecutor.ClaimLost", () => Effect.succeed("claim_lost" as const)),
      )
      expect(result).toBe("claim_lost")
    }),
  )

  it.effect("input_state='legacy' (not ready) → ExecutorClaimLostError", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertProvisioningRun("run_se_notready", "ses_exec_se_notready", { inputState: "legacy" })

      const run = { runID: "run_se_notready", version: 0, claimGeneration: CLAIM_GEN } as any
      const result = yield* startExecution({ run, ownerToken: OWNER }).pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("LegacySubagentExecutor.ClaimLost", () => Effect.succeed("claim_lost" as const)),
      )
      expect(result).toBe("claim_lost")
    }),
  )
})

// ── settleRun ─────────────────────────────────────────────────────────────────

describe("DET-FENCE-01 settleRun CAS + lease fence", () => {
  const settleParams = (runID: string) => ({
    runID,
    parentSessionID: PARENT_SID as string,
    ownerToken: OWNER,
    claimGeneration: CLAIM_GEN,
    deliveryMode: "foreground" as const,
    directory: DIRECTORY,
    agentType: "task",
    state: "completed" as const,
    reason: "test_settled",
  })

  it.effect("correct params → won=true, state=completed, run_settled event", () =>
    Effect.gen(function* () {
      yield* setup
      // Start as running (settle requires active state)
      yield* insertProvisioningRun("run_settle_ok", "ses_exec_settle_ok")
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({ state: "running", phase: "research", version: 1, execution_started_at: Date.now() })
        .where(eq(TaskRunTable.run_id, "run_settle_ok"))
        .run()
        .pipe(Effect.orDie)

      const result = yield* settleRun({ ...settleParams("run_settle_ok"), now: Date.now() })
      expect(result.won).toBe(true)
      if (result.won) expect(result.finalState).toBe("completed")

      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_settle_ok"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("completed")

      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, "run_settle_ok"))
        .all()
        .pipe(Effect.orDie)
      expect(events.some((e) => e.type === "run_settled")).toBe(true)
    }),
  )

  it.effect("expired lease → won=false (claim_lost) — stale callback cannot settle", () =>
    Effect.gen(function* () {
      yield* setup
      const pastExpiry = Date.now() - 10_000 // lease expired 10s ago
      yield* insertProvisioningRun("run_settle_expired", "ses_exec_settle_expired", {
        leaseExpiry: pastExpiry,
      })
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({ state: "running", phase: "research", version: 1, execution_started_at: Date.now() })
        .where(eq(TaskRunTable.run_id, "run_settle_expired"))
        .run()
        .pipe(Effect.orDie)

      const result = yield* settleRun({
        ...settleParams("run_settle_expired"),
        now: Date.now(),
      })
      // Design §5: expired lease fence prevents settlement
      expect(result.won).toBe(false)
    }),
  )

  it.effect("wrong claimGeneration → won=false (claim_lost)", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertProvisioningRun("run_settle_badgen", "ses_exec_settle_badgen")
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({ state: "running", phase: "research", version: 1, execution_started_at: Date.now() })
        .where(eq(TaskRunTable.run_id, "run_settle_badgen"))
        .run()
        .pipe(Effect.orDie)

      // D-1 (P1-9): explicitly pass a WRONG claimGeneration token so the fence is actually tested.
      // The correct generation is CLAIM_GEN (1); we pass 999 which must cause won=false.
      const wrongGen = 999
      const result = yield* settleRun({
        ...settleParams("run_settle_badgen"),
        claimGeneration: wrongGen, // wrong generation — CAS must reject this
      })
      // Wrong generation must produce won=false
      expect(result.won).toBe(false)

      // Row state must be unchanged — wrong generation settle must not modify state
      const row = yield* db
        .select({ state: TaskRunTable.state, version: TaskRunTable.version })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_settle_badgen"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("running") // unchanged
      expect(row?.version).toBe(1) // version not bumped
    }),
  )
})

describe("DET-EXEC-01 executor lifecycle", () => {
  it.live("persists the assistant text and raw result message before terminal completion", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_success"
      const childSessionID = SessionID.make("ses_exec_success")
      yield* insertProvisioningRun(runID, childSessionID)

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 300,
        loopFn: () => Effect.succeed(assistantMessage("msg_executor_success", "verified result")),
      })

      const { db } = yield* Database.Service
      const row = yield* db
        .select({
          state: TaskRunTable.state,
          output: TaskRunTable.output,
          messageID: TaskRunTable.raw_result_message_id,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      expect(row).toMatchObject({
        state: "completed",
        output: "verified result",
        messageID: "msg_executor_success",
      })
    }),
  )

  it.live("interrupts a live provider activity when its lease fence is lost", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_lease_lost"
      const childSessionID = SessionID.make("ses_exec_lease_lost")
      yield* insertProvisioningRun(runID, childSessionID)

      const execution = yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 60,
        loopFn: () => Effect.never,
      }).pipe(Effect.forkChild)

      const { db } = yield* Database.Service
      yield* Effect.sleep("10 millis")
      yield* db
        .update(TaskRunTable)
        .set({ lease_expires_at: Date.now() - 1 })
        .where(eq(TaskRunTable.run_id, runID))
        .run()
        .pipe(Effect.orDie)
      yield* Fiber.join(execution)

      const row = yield* db
        .select({ state: TaskRunTable.state, reason: TaskRunTable.reason })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      expect(row).toMatchObject({ state: "recovery_required", reason: "execution_lease_lost" })

      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, runID))
        .all()
        .pipe(Effect.orDie)
      expect(events.some((event) => event.type === "execution_recovery_required")).toBe(true)
    }),
  )

  it.live("persists the provider failure for the parent instead of returning a generic terminal state", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_provider_failure"
      const childSessionID = SessionID.make("ses_exec_provider_failure")
      yield* insertProvisioningRun(runID, childSessionID)

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 300,
        loopFn: () => Effect.fail(new Error("injected provider failure")),
      })

      const { db } = yield* Database.Service
      const row = yield* db
        .select({ state: TaskRunTable.state, reason: TaskRunTable.reason, error: TaskRunTable.error })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("failed")
      expect(row?.reason).toContain("injected provider failure")
      expect(row?.error).toMatchObject({ code: "failed" })
      expect(row?.error?.message).toContain("injected provider failure")
    }),
  )
})
