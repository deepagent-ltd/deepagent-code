import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { count, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../../src/database/database"
import type { Admission } from "../../src/deepagent/durable-learning"
import { DeepAgentLearningGeneration } from "../../src/deepagent/learning-generation"
import { LearningGenerationTable } from "../../src/deepagent/learning-generation.sql"
import { LearningJobTable } from "../../src/deepagent/learning-job.sql"
import { createInitialRoundState } from "../../src/deepagent/round-state"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { SessionSchema } from "../../src/session/schema"
import { SessionTable } from "../../src/session/sql"
import { Hash } from "../../src/util/hash"
import { tmpRoot } from "../fixture/tmpdir"

let root: string

beforeEach(() => {
  root = mkdtempSync(tmpRoot())
  mkdirSync(path.join(root, "workspace"))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("settled learning generation", () => {
  test("one durable generation chooses one of three triggers, then admits one job", async () => {
    await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const source = admission("activity-a")
      const first = yield* DeepAgentLearningGeneration.record(db, source, 10)
      expect(yield* DeepAgentLearningGeneration.record(db, source, 99)).toEqual(first)
      expect(yield* DeepAgentLearningGeneration.claim(db, { trigger: "idle", sessionID: "ses_generation", dueAt: 9 }, 11)).toBeUndefined()

      const paused = yield* DeepAgentLearningGeneration.claim(db, { trigger: "pause", sessionID: "ses_generation" }, 12)
      expect(paused).toMatchObject({ trigger: "pause", generation_id: source.input.runID })
      expect(yield* DeepAgentLearningGeneration.claim(db, { trigger: "project_switch", projectID: "project-generation" }, 13)).toBeUndefined()
      expect(yield* DeepAgentLearningGeneration.claim(db, { trigger: "idle", sessionID: "ses_generation", dueAt: 100 }, 14)).toBeUndefined()

      yield* DeepAgentLearningGeneration.admitClaimed(db, paused!, root)
      expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 1 })
      expect(yield* db.select().from(LearningJobTable).get()).toMatchObject({ trigger: "pause", run_id: source.input.runID })
      expect(existsSync(source.terminalArtifact.path)).toBe(true)
      expect(yield* DeepAgentLearningGeneration.recover(db, root)).toEqual([])
      expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 1 })
    }))
  })

  test("restart completes a chosen trigger without changing it or repeating the job", async () => {
    const file = path.join(root, "generation.sqlite")
    await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const source = admission("activity-crash")
      yield* DeepAgentLearningGeneration.record(db, source, 10)
      expect(yield* DeepAgentLearningGeneration.claim(db, { trigger: "project_switch", projectID: "project-generation" }, 20))
        .toMatchObject({ trigger: "project_switch", admitted_at: null })
      expect(existsSync(source.terminalArtifact.path)).toBe(false)
    }), file)

    // Open a new Database layer against the same file: no process-local queue or in-memory
    // observer is available to finish this prepared generation.
    await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const recovered = yield* DeepAgentLearningGeneration.recover(db, root)
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toMatchObject({ trigger: "project_switch" })
      expect(yield* DeepAgentLearningGeneration.notify(db, { trigger: "pause", sessionID: "ses_generation" }, root)).toBeUndefined()
      expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 1 })
      expect(yield* DeepAgentLearningGeneration.recover(db, root)).toEqual([])
    }), file)
  })

  test("active execution cannot be claimed, and a new activity is a new generation", async () => {
    await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DeepAgentLearningGeneration.record(db, admission("activity-a"), 10)
      yield* db.update(SessionTable).set({ execution_claim_token: 123 }).where(eq(SessionTable.id, SessionSchema.ID.make("ses_generation")))
      expect(yield* DeepAgentLearningGeneration.claim(db, { trigger: "idle", sessionID: "ses_generation", dueAt: 100 }, 101)).toBeUndefined()
      yield* db.update(SessionTable).set({ execution_claim_token: null }).where(eq(SessionTable.id, SessionSchema.ID.make("ses_generation")))
      expect(yield* DeepAgentLearningGeneration.notify(db, { trigger: "idle", sessionID: "ses_generation", dueAt: 100 }, root))
        .toMatchObject({ trigger: "idle" })
      yield* DeepAgentLearningGeneration.record(db, admission("activity-b"), 110)
      expect(yield* DeepAgentLearningGeneration.notify(db, { trigger: "pause", sessionID: "ses_generation" }, root))
        .toMatchObject({ trigger: "pause" })
      expect(yield* db.select({ count: count() }).from(LearningGenerationTable).get()).toEqual({ count: 2 })
      expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 2 })
    }))
  })

  test("pause can claim the previous settled generation while a newer provider turn is active", async () => {
    await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DeepAgentLearningGeneration.record(db, admission("settled-before-pause"), 10)
      yield* db.update(SessionTable).set({ execution_claim_token: 123 })
        .where(eq(SessionTable.id, SessionSchema.ID.make("ses_generation")))
      expect(yield* DeepAgentLearningGeneration.claim(db, { trigger: "pause", sessionID: "ses_generation" }, 20))
        .toMatchObject({ trigger: "pause", activity_id: "settled-before-pause" })
      expect(yield* DeepAgentLearningGeneration.claim(db, { trigger: "idle", sessionID: "ses_generation", dueAt: 100 }, 101))
        .toBeUndefined()
    }))
  })

  test("project switch claims only the previous project namespace", async () => {
    await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      mkdirSync(path.join(root, "other-workspace"))
      yield* db.insert(ProjectTable).values({
        id: Project.ID.make("project-other"),
        worktree: AbsolutePath.make(path.join(root, "other-workspace")),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      yield* db.insert(SessionTable).values({
        id: SessionSchema.ID.make("ses_other"),
        project_id: Project.ID.make("project-other"),
        slug: "other",
        directory: path.join(root, "other-workspace"),
        title: "other",
        version: "1",
        time_created: 1,
        time_updated: 1,
      })
      const previous = admission("activity-a")
      const otherSource = admission("activity-b", "ses_other")
      const other: Admission = {
        ...otherSource,
        workspacePath: path.join(root, "other-workspace"),
        input: { ...otherSource.input, projectID: "project-other" },
      }
      yield* DeepAgentLearningGeneration.record(db, previous, 10)
      yield* DeepAgentLearningGeneration.record(db, other, 11)
      expect(yield* DeepAgentLearningGeneration.notify(db, { trigger: "project_switch", projectID: "project-generation" }, root))
        .toMatchObject({ session_id: "ses_generation", project_id: "project-generation" })
      expect(yield* db.select().from(LearningGenerationTable).where(eq(LearningGenerationTable.session_id, "ses_other")).get())
        .toMatchObject({ trigger: null, admitted_at: null })
      expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 1 })
    }))
  })
})

function admission(activityID: string, sessionID = "ses_generation"): Admission {
  const runID = `v2_activity_${Hash.sha256(`${sessionID}:${activityID}`).slice(0, 24)}`
  return {
    baseDir: root,
    workspacePath: path.join(root, "workspace"),
    rejectedBufferDir: path.join(root, "memory"),
    terminalArtifact: {
      schema_version: "deepagent-code.learning_terminal_artifact.v1",
      path: path.join(root, "runs", runID, "DEEPAGENT_RUN_STATE.json"),
      sha256: "0".repeat(64),
      learning_admission_fingerprint: "0".repeat(64),
    },
    input: {
      projectID: "project-generation",
      sessionID,
      runID,
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "idle",
      policy: "manual_review",
      evidence: {
        schema_version: "deepagent-code.learning_evidence.v1",
        activity_id: activityID,
        plan_goal: "unfinished work",
        document_refs: [],
        changed_paths: [],
        validations: [],
      },
    },
  }
}

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>, file = ":memory:") {
  return Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({
      id: Project.ID.make("project-generation"),
      worktree: AbsolutePath.make(path.join(root, "workspace")),
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    }).onConflictDoNothing()
    yield* db.insert(SessionTable).values({
      id: SessionSchema.ID.make("ses_generation"),
      project_id: Project.ID.make("project-generation"),
      slug: "generation",
      directory: path.join(root, "workspace"),
      title: "generation",
      version: "1",
      time_created: 1,
      time_updated: 1,
    }).onConflictDoNothing()
    return yield* effect
  }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped))
}
