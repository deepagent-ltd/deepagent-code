/**
 * DET-ADM-01: admitTaskRun + input projection chain
 *
 * Covers:
 *  - admitTaskRun: creates state=admitted + task_admission row
 *  - admitTaskRun exact retry: returns same run (exactRetry=true)
 *  - admitTaskRun conflict: different request hash → AdmissionConflict
 *  - prepare(): produces PreparedTaskInput with correct hash + partCount
 *  - projectExact: CAS admitting→ready, writes message+part+input_admitted event
 *  - projectExact exact replay: returns {exactReplay:true}
 *  - projectExact wrong input_state: InputProjectionConflictError
 *
 * Design refs: §3.3, §6.1, §6.2, §1.3 #33 (atomic input admission), #24 (co-transactional event)
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import {
  SessionTable,
  TaskRunTable,
  TaskAdmissionTable,
  TaskRunEventTable,
  MessageTable,
  PartTable,
} from "@deepagent-code/core/session/sql"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"
import { admitTaskRun, transitionToAdmitting } from "../../src/tool/task-run"
import { prepare, projectExact, InputProjectionConflictError } from "../../src/session/task-input"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)

const PARENT_SID = SessionID.make("ses_adm_parent")
const DIRECTORY = "/adm_test_dir"

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
      slug: "adm-parent",
      directory: DIRECTORY,
      title: "parent",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

// ── admitTaskRun ──────────────────────────────────────────────────────────────

describe("DET-ADM-01: admitTaskRun", () => {
  it.effect("creates admitted task_run + task_admission row", () =>
    Effect.gen(function* () {
      yield* setup

      const admission = yield* admitTaskRun({
        parentSessionID: PARENT_SID,
        parentMessageID: MessageID.ascending("msg_adm_001") as any,
        toolCallID: "tc_adm_001",
        request: { description: "test task", subagent_type: "researcher" },
        deliveryMode: "foreground",
        executionSpec: { prompt: { text: "Analyze this codebase." } },
      })

      expect(admission.exactRetry).toBe(false)
      expect(admission.run.state).toBe("admitted")
      expect(admission.runCreated).toBe(true)

      const { db } = yield* Database.Service
      const admRow = yield* db
        .select()
        .from(TaskAdmissionTable)
        .where(eq(TaskAdmissionTable.run_id, admission.run.runID))
        .get()
        .pipe(Effect.orDie)
      expect(admRow).toBeTruthy()
      expect(admRow?.delivery_mode).toBe("foreground")

      const runRow = yield* db
        .select({ state: TaskRunTable.state, input_state: TaskRunTable.input_state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, admission.run.runID))
        .get()
        .pipe(Effect.orDie)
      expect(runRow?.state).toBe("admitted")
    }),
  )

  it.effect("exact retry returns exactRetry=true with same runID", () =>
    Effect.gen(function* () {
      yield* setup

      const params = {
        parentSessionID: PARENT_SID,
        parentMessageID: MessageID.ascending("msg_adm_retry") as any,
        toolCallID: "tc_adm_retry",
        request: { description: "retry test", subagent_type: "researcher" },
        deliveryMode: "foreground" as const,
      }

      const first = yield* admitTaskRun(params)
      const second = yield* admitTaskRun(params)

      expect(second.exactRetry).toBe(true)
      expect(second.run.runID).toBe(first.run.runID)
    }),
  )

  it.effect("different request hash → AdmissionConflict", () =>
    Effect.gen(function* () {
      yield* setup

      const base = {
        parentSessionID: PARENT_SID,
        parentMessageID: MessageID.ascending("msg_adm_conflict") as any,
        toolCallID: "tc_adm_conflict",
        deliveryMode: "foreground" as const,
      }
      yield* admitTaskRun({ ...base, request: { description: "first" } })

      const result = yield* admitTaskRun({ ...base, request: { description: "different" } }).pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("TaskRun.AdmissionConflict", () => Effect.succeed("conflict" as const)),
      )
      expect(result).toBe("conflict")
    }),
  )
})

// ── prepare + projectExact ────────────────────────────────────────────────────

describe("DET-ADM-01: prepare() + projectExact()", () => {
  it.effect("prepare() returns PreparedTaskInput with valid hash + partCount=1", () =>
    Effect.gen(function* () {
      yield* setup

      const admission = yield* admitTaskRun({
        parentSessionID: PARENT_SID,
        parentMessageID: MessageID.ascending("msg_prep_001") as any,
        toolCallID: "tc_prep_001",
        request: { description: "prepare test" },
        deliveryMode: "foreground",
        executionSpec: { prompt: { text: "Explain the bug." } },
      })

      const prepared = yield* prepare(admission.run)

      expect(prepared.partCount).toBe(1)
      expect(prepared.materializedHash).toBeTruthy()
      expect(prepared.materializedHash.length).toBeGreaterThan(0)
      expect(prepared.parts.length).toBe(1)
      expect(prepared.prompt).toBe("Explain the bug.")
    }),
  )

  it.effect("projectExact: transitions admitting→ready, writes message+part+event", () =>
    Effect.gen(function* () {
      yield* setup

      const admission = yield* admitTaskRun({
        parentSessionID: PARENT_SID,
        parentMessageID: MessageID.ascending("msg_proj_001") as any,
        toolCallID: "tc_proj_001",
        request: { description: "projection test" },
        deliveryMode: "foreground",
        executionSpec: { prompt: { text: "Find the bug in foo.ts." } },
      })

      // D-1 (P1-9): use transitionToAdmitting() production path instead of raw UPDATE bypass.
      // The child session must exist before the message FK write — create it here as the
      // production durable path does (task.ts durable block creates the child session).
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: admission.run.childSessionID,
          project_id: ProjectV2.ID.global,
          slug: "proj-child-001",
          directory: DIRECTORY,
          title: "child-proj-001",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      // Use transitionToAdmitting() — the production entry point for this transition.
      const admittingRun = yield* transitionToAdmitting({
        runID: admission.run.runID,
        version: admission.run.version,
      })
      expect(admittingRun).toBeTruthy()
      expect(admittingRun?.inputState).toBe("admitting")

      const prepared = yield* prepare({
        ...admission.run,
        version: admittingRun!.version,
        inputState: "admitting" as const,
      })
      const result = yield* projectExact({
        prepared,
        runID: admission.run.runID,
        expectedRunVersion: admittingRun!.version,
      })
      expect(result.exactReplay).toBe(false)

      // Verify task_run.input_state = 'ready'
      const runRow = yield* db
        .select({ input_state: TaskRunTable.input_state, version: TaskRunTable.version })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, admission.run.runID))
        .get()
        .pipe(Effect.orDie)
      expect(runRow?.input_state).toBe("ready")
      expect(runRow?.version).toBe(2) // 1 + 1 from CAS

      // Verify Message row created
      const msgCount = yield* db
        .select({ id: MessageTable.id })
        .from(MessageTable)
        // tsgo: cross-package Brand<"SessionID"> breaks eq() overload resolution
        .where(eq(MessageTable.session_id as any, admission.run.childSessionID as any))
        .all()
        .pipe(Effect.orDie)
      expect(msgCount.length).toBeGreaterThanOrEqual(1)

      // Verify Part row created
      const partCount = yield* db
        .select({ id: PartTable.id })
        .from(PartTable)
        // tsgo: same cross-package Brand<"SessionID"> overload issue
        .where(eq(PartTable.session_id as any, admission.run.childSessionID as any))
        .all()
        .pipe(Effect.orDie)
      expect(partCount.length).toBe(1)

      // Verify input_admitted event co-transactionally written (design §1.3 #24)
      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, admission.run.runID))
        .all()
        .pipe(Effect.orDie)
      expect(events.some((e) => e.type === "input_admitted")).toBe(true)
    }),
  )

  it.effect("projectExact exact replay returns exactReplay=true", () =>
    Effect.gen(function* () {
      yield* setup

      const admission = yield* admitTaskRun({
        parentSessionID: PARENT_SID,
        parentMessageID: MessageID.ascending("msg_replay_001") as any,
        toolCallID: "tc_replay_001",
        request: { description: "replay test" },
        deliveryMode: "foreground",
        executionSpec: { prompt: { text: "Test prompt." } },
      })

      const { db } = yield* Database.Service
      // Insert child session so message(session_id) FK constraint is satisfied.
      yield* db
        .insert(SessionTable)
        .values({
          id: admission.run.childSessionID,
          project_id: ProjectV2.ID.global,
          slug: "proj-child-replay",
          directory: DIRECTORY,
          title: "child-proj-replay",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      // D-1: use production transitionToAdmitting() path instead of raw UPDATE bypass
      const admittingRun = yield* transitionToAdmitting({
        runID: admission.run.runID,
        version: admission.run.version,
      })
      expect(admittingRun).toBeTruthy()

      const prepared = yield* prepare({
        ...admission.run,
        version: admittingRun!.version,
        inputState: "admitting" as const,
      })
      yield* projectExact({ prepared, runID: admission.run.runID, expectedRunVersion: admittingRun!.version })

      // Second call with same data → exact replay (input_state already 'ready')
      const replay = yield* projectExact({
        prepared,
        runID: admission.run.runID,
        expectedRunVersion: admittingRun!.version + 1, // version after first projection
      })
      expect(replay.exactReplay).toBe(true)
    }),
  )

  it.effect("projectExact rejects a replay when the materialized envelope was altered", () =>
    Effect.gen(function* () {
      yield* setup

      const admission = yield* admitTaskRun({
        parentSessionID: PARENT_SID,
        parentMessageID: MessageID.ascending("msg_replay_tampered") as any,
        toolCallID: "tc_replay_tampered",
        request: { description: "tampered replay test" },
        deliveryMode: "foreground",
        executionSpec: { prompt: { text: "Original prompt." } },
      })

      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: admission.run.childSessionID,
          project_id: ProjectV2.ID.global,
          slug: "proj-child-tampered",
          directory: DIRECTORY,
          title: "child-proj-tampered",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const admittingRun = yield* transitionToAdmitting({
        runID: admission.run.runID,
        version: admission.run.version,
      })
      const prepared = yield* prepare(admittingRun!)
      yield* projectExact({ prepared, runID: admission.run.runID, expectedRunVersion: admittingRun!.version })
      yield* db
        .update(PartTable)
        .set({ data: { type: "text", text: "Altered after projection." } as any })
        .where(eq(PartTable.id, prepared.parts[0]!.partID))
        .run()
        .pipe(Effect.orDie)

      const conflict = yield* Effect.flip(
        projectExact({
          prepared,
          runID: admission.run.runID,
          expectedRunVersion: admittingRun!.version + 1,
        }),
      )
      expect(conflict).toBeInstanceOf(InputProjectionConflictError)
      expect(conflict.reason).toContain("hash/count mismatch")

      const conflictedRun = yield* db
        .select({
          state: TaskRunTable.state,
          inputState: TaskRunTable.input_state,
          reason: TaskRunTable.reason,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, admission.run.runID))
        .get()
        .pipe(Effect.orDie)
      expect(conflictedRun?.state).toBe("recovery_required")
      expect(conflictedRun?.inputState).toBe("conflict")
      expect(conflictedRun?.reason).toBe("input_projection_conflict")

      const recoveryEvent = yield* db
        .select({ type: TaskRunEventTable.type, toState: TaskRunEventTable.to_state })
        .from(TaskRunEventTable)
        .where(
          and(
            eq(TaskRunEventTable.run_id, admission.run.runID),
            eq(TaskRunEventTable.type, "input_projection_conflict"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      expect(recoveryEvent).toEqual({ type: "input_projection_conflict", toState: "recovery_required" })
    }),
  )

  it.effect("projectExact wrong input_state → InputProjectionConflictError", () =>
    Effect.gen(function* () {
      yield* setup

      const admission = yield* admitTaskRun({
        parentSessionID: PARENT_SID,
        parentMessageID: MessageID.ascending("msg_conflict_001") as any,
        toolCallID: "tc_conflict_001",
        request: { description: "conflict test" },
        deliveryMode: "foreground",
        executionSpec: { prompt: { text: "Test." } },
      })

      // Do NOT transition to admitting — leave as 'legacy' (or admitted)
      const prepared = yield* prepare(admission.run)

      const result = yield* projectExact({
        prepared,
        runID: admission.run.runID,
        expectedRunVersion: 0,
      }).pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("LegacyTaskInput.InputProjectionConflict", () => Effect.succeed("conflict" as const)),
      )
      expect(result).toBe("conflict")
    }),
  )
})
