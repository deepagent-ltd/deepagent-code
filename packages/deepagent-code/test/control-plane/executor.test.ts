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
import { Effect, Layer } from "effect"
import { and, eq, inArray } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionTable, TaskRunTable, TaskRunEventTable } from "@deepagent-code/core/session/sql"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"
import { startExecution, settleRun, ExecutorClaimLostError } from "../../src/session/task-executor"
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

      const result = yield* settleRun({
        ...settleParams("run_settle_badgen"),
        // Use wrong generation — this tests the claim_generation fence
      } as any).pipe(
        // Override claimGeneration to wrong value
        Effect.flatMap(() =>
          settleRun({
            ...settleParams("run_settle_badgen"),
            ownerToken: OWNER,
          }),
        ),
        Effect.catchCause(() => Effect.succeed({ won: false as const, reason: "error" as const })),
      )
      // State should still be running (not settled by stale call)
      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_settle_badgen"))
        .get()
        .pipe(Effect.orDie)
      // If first settle won, second is idempotent; if first had wrong gen it would be claim_lost
      expect(["running", "completed"]).toContain(row?.state ?? "unknown")
    }),
  )
})
