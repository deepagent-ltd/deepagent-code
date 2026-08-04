/**
 * DET-FENCE-01 (partial): enqueueRun CAS fence — admitted → queued version bump
 * DET-QUEUE-01 (partial): classifyOnStartup skips runs with non-expired leases
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
import { classifyOnStartup } from "../../src/tool/task-run"
import { enqueueRun } from "../../src/session/task-dispatcher"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)

const parentSessionID = SessionID.make("ses_cp_disp_parent")
const DIRECTORY = "/cp_disp_test_dir"

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
      id: parentSessionID,
      project_id: ProjectV2.ID.global,
      slug: "cp-disp-parent",
      directory: DIRECTORY,
      title: "parent",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const insertAdmittedRun = (runID: string, childID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    const childSessionID = SessionID.make(childID)
    yield* db
      .insert(SessionTable)
      .values({
        id: childSessionID,
        project_id: ProjectV2.ID.global,
        slug: `cp-child-${runID}`,
        directory: DIRECTORY,
        title: `child-${runID}`,
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(TaskRunTable)
      .values({
        run_id: runID,
        request_hash: "h1",
        parent_session_id: parentSessionID,
        parent_message_id: MessageID.ascending(`msg_${runID}`) as any,
        tool_call_id: `tc_${runID}`,
        child_session_id: childSessionID,
        generation: 1,
        delivery_mode: "foreground",
        phase: "admission",
        state: "admitted",
        version: 0,
        control_state: "open",
        input_state: "legacy",
        available_at: 0,
        claim_generation: 0,
        start_attempts: 0,
        attempts: 0,
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("DET-FENCE-01: enqueueRun CAS", () => {
  it.effect("transitions admitted → queued with version bump", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertAdmittedRun("run_enq_001", "ses_child_enq_001")

      const result = yield* enqueueRun({ runID: "run_enq_001", runVersion: 0 })
      // enqueueRun returns the runID on success
      expect(result).toBeTruthy()

      const { db } = yield* Database.Service
      const row = yield* db
        .select({ state: TaskRunTable.state, version: TaskRunTable.version })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_enq_001"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("queued")
      expect(row?.version).toBe(1) // version bumped from 0 → 1
    }),
  )

  it.effect("returns undefined (CAS miss) when version does not match", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertAdmittedRun("run_enq_002", "ses_child_enq_002")

      // Pass wrong version — CAS must miss without error
      const result = yield* enqueueRun({ runID: "run_enq_002", runVersion: 99 })
      expect(result).toBeUndefined()

      const { db } = yield* Database.Service
      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_enq_002"))
        .get()
        .pipe(Effect.orDie)
      // State must remain admitted — the CAS miss must not modify the row
      expect(row?.state).toBe("admitted")
    }),
  )
})

describe("DET-QUEUE-01: classifyOnStartup skips non-expired leases", () => {
  it.effect("running run with a valid future lease is left untouched", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertAdmittedRun("run_classify_001", "ses_child_classify_001")

      const { db } = yield* Database.Service
      const futureExpiry = Date.now() + 60_000

      // Manually set to running state with a live (non-expired) lease
      yield* db
        .update(TaskRunTable)
        .set({
          state: "running",
          phase: "research",
          version: 1,
          execution_owner: "other_process_pid",
          lease_expires_at: futureExpiry,
          time_updated: Date.now(),
        })
        .where(eq(TaskRunTable.run_id, "run_classify_001"))
        .run()
        .pipe(Effect.orDie)

      // classifyOnStartup must skip this run because the lease is valid
      const stats = yield* classifyOnStartup({ directory: DIRECTORY })
      expect(stats.classified).toBe(0)
      expect(stats.requeued).toBe(0)

      // State must be unchanged
      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_classify_001"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("running")
    }),
  )

  it.effect("admitted run with expired lease is re-enqueued as queued", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertAdmittedRun("run_classify_002", "ses_child_classify_002")

      const { db } = yield* Database.Service
      // Set an expired lease (already in the past)
      yield* db
        .update(TaskRunTable)
        .set({ lease_expires_at: Date.now() - 1_000, time_updated: Date.now() - 2_000 })
        .where(eq(TaskRunTable.run_id, "run_classify_002"))
        .run()
        .pipe(Effect.orDie)

      const stats = yield* classifyOnStartup({ directory: DIRECTORY })
      // admitted + input_state=legacy + expired lease → requeued
      expect(stats.requeued).toBeGreaterThanOrEqual(1)
    }),
  )
})
