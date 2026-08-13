import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { count, eq } from "drizzle-orm"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import { AgentGateway } from "../../src/agent-gateway"
import { Database } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import learningLifecycleTriggerMigration from "../../src/database/migration/20260813041100_learning_lifecycle_trigger_authority"
import { DeepAgentDurableLearning, type Admission } from "../../src/deepagent/durable-learning"
import { DeepAgentLearningLifecycleTrigger } from "../../src/deepagent/learning-lifecycle-trigger"
import { LearningLifecycleTriggerTable } from "../../src/deepagent/learning-lifecycle-trigger.sql"
import { LearningJobTable } from "../../src/deepagent/learning-job.sql"
import { createInitialRoundState } from "../../src/deepagent/round-state"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { SessionSchema } from "../../src/session/schema"
import { SessionTable } from "../../src/session/sql"
import { CanonicalJson } from "../../src/util/canonical-json"
import { Hash } from "../../src/util/hash"

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-learning-lifecycle-"))
})

afterEach(async () => {
  AgentGateway.setLearningAuthority(undefined)
  AgentGateway.configure({ enabled: false, runsDir: undefined, durableLearning: false })
  await AgentGateway.flushLearning()
  rmSync(root, { recursive: true, force: true })
})

describe("durable learning lifecycle trigger authority", () => {
  test("admits and deduplicates an idle trigger from a real settled AgentGateway run", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        AgentGateway.setLearningAuthority({
          record: (input) => Effect.runPromise(DeepAgentDurableLearning.record(db, input).pipe(Effect.asVoid)),
          enqueue: (input) =>
            Effect.runPromise(DeepAgentDurableLearning.admit(db, input, { authorityRoot: root }).pipe(Effect.asVoid)),
        })
        AgentGateway.configure({
          enabled: true,
          agentMode: "high",
          baseDir: root,
          runsDir: path.join(root, "runs"),
          durableLearning: true,
          selfLearning: "auto",
          allowProviderExecutedTools: false,
        })

        yield* AgentGateway.manageStream(
          {
            callKind: "session_turn",
            feature: "session_chat",
            providerID: "openai",
            modelID: "test",
            sessionID: "ses_learning",
            messageID: "msg-1",
            workspaceID: path.join(root, "workspace"),
            metadata: { deepagent: { goal_id: "goal-gateway-binding" } },
          },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runDrain)
        yield* Effect.promise(() => AgentGateway.flushLearning())

        const first = yield* DeepAgentLearningLifecycleTrigger.observe(
          db,
          {
            trigger: "idle",
            boundaryKey: "session-idle:ses_learning",
            sessionID: "ses_learning",
            match: "session",
          },
          { authorityRoot: root, runsDir: path.join(root, "runs"), now: 10 },
        )
        const retry = yield* DeepAgentLearningLifecycleTrigger.observe(
          db,
          {
            trigger: "idle",
            boundaryKey: "session-idle:ses_learning",
            sessionID: "ses_learning",
            match: "session",
          },
          { authorityRoot: root, runsDir: path.join(root, "runs"), now: 11 },
        )
        const conflict = yield* DeepAgentLearningLifecycleTrigger.observe(
          db,
          {
            trigger: "idle",
            boundaryKey: "session-idle:forged-boundary",
            sessionID: "ses_learning",
            match: "session",
          },
          { authorityRoot: root, runsDir: path.join(root, "runs"), now: 12 },
        ).pipe(Effect.flip)

        expect(first).toMatchObject({ state: "admitted" })
        expect(retry).toEqual(first)
        expect(conflict).toMatchObject({
          _tag: "DeepAgentLearningLifecycleTrigger.IdentityConflictError",
          trigger: "idle",
          sessionId: "ses_learning",
        })
        expect(yield* db.select({ count: count() }).from(LearningLifecycleTriggerTable).get()).toEqual({ count: 1 })
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 2 })
        const receipt = yield* db.select().from(LearningLifecycleTriggerTable).get()
        expect(receipt).toMatchObject({ trigger: "idle", state: "admitted", boundary_key: "session-idle:ses_learning" })
        expect(JSON.parse(yield* Effect.promise(() => Bun.file(receipt!.artifact_path).text()))).toMatchObject({
          schema_version: "deepagent-code.learning_lifecycle_trigger_receipt.v1",
          trigger: "idle",
          session_id: "ses_learning",
          source_session_relation: "session",
        })
        const sourceTerminal = JSON.parse(
          yield* Effect.promise(() =>
            Bun.file(path.join(root, "runs", first.runId!, "DEEPAGENT_RUN_STATE.json")).text(),
          ),
        )
        expect(sourceTerminal).toMatchObject({ goal_id: "goal-gateway-binding" })
      }),
    )
  })

  test("matches pause to the exact parent run and project switch to the exact workspace", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        writeSource("run-pause", "ses_learning", { parentSessionID: "ses_goal", goalID: "goal-1" })
        writeSource("run-project", "ses_project", { workspace: path.join(root, "project-workspace") })
        yield* insertSession(db, "ses_project", path.join(root, "project-workspace"))

        expect(
          yield* DeepAgentLearningLifecycleTrigger.observe(
            db,
            { trigger: "pause", boundaryKey: "goal-pause:goal-1", sessionID: "ses_wrong", match: "parent" },
            { authorityRoot: root, runsDir: path.join(root, "runs") },
          ),
        ).toEqual({ state: "skipped", reason: "no_exact_settled_run" })
        expect(
          yield* DeepAgentLearningLifecycleTrigger.observe(
            db,
            {
              trigger: "pause",
              boundaryKey: "goal-pause:goal-wrong",
              sessionID: "ses_goal",
              match: "parent",
              goalID: "goal-wrong",
            },
            { authorityRoot: root, runsDir: path.join(root, "runs") },
          ),
        ).toEqual({ state: "skipped", reason: "no_exact_settled_run" })
        expect(
          yield* DeepAgentLearningLifecycleTrigger.observe(
            db,
            {
              trigger: "pause",
              boundaryKey: "goal-pause:goal-1",
              sessionID: "ses_goal",
              match: "parent",
              goalID: "goal-1",
            },
            { authorityRoot: root, runsDir: path.join(root, "runs") },
          ),
        ).toMatchObject({ state: "admitted", runId: "run-pause" })
        expect(
          yield* DeepAgentLearningLifecycleTrigger.observe(
            db,
            {
              trigger: "project_switch",
              boundaryKey: `project-switch:${path.join(root, "other")}`,
              directory: path.join(root, "other"),
            },
            { authorityRoot: root, runsDir: path.join(root, "runs") },
          ),
        ).toEqual({ state: "skipped", reason: "no_exact_settled_run" })
        expect(
          yield* DeepAgentLearningLifecycleTrigger.observe(
            db,
            {
              trigger: "project_switch",
              boundaryKey: `project-switch:${path.join(root, "project-workspace")}`,
              directory: path.join(root, "project-workspace"),
            },
            { authorityRoot: root, runsDir: path.join(root, "runs") },
          ),
        ).toMatchObject({ state: "admitted", runId: "run-project" })
      }),
    )
  })

  test("recovers a prepared receipt without duplicating its durable learning job", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        writeSource("run-crash", "ses_learning")
        yield* db.run(`
          CREATE TRIGGER test_lifecycle_settlement_crash
          BEFORE UPDATE OF state ON learning_lifecycle_trigger_receipt
          WHEN NEW.state = 'admitted'
          BEGIN SELECT RAISE(ABORT, 'simulated_crash_before_receipt_settlement'); END
        `)

        expect(
          yield* DeepAgentLearningLifecycleTrigger.observe(
            db,
            {
              trigger: "idle",
              boundaryKey: "session-idle:ses_learning",
              sessionID: "ses_learning",
              match: "session",
            },
            { authorityRoot: root, runsDir: path.join(root, "runs"), now: 20 },
          ).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        expect(yield* db.select().from(LearningLifecycleTriggerTable).get()).toMatchObject({
          state: "prepared",
        })
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 1 })

        yield* db.run("DROP TRIGGER test_lifecycle_settlement_crash")
        const recovered = yield* DeepAgentLearningLifecycleTrigger.recover(db, { authorityRoot: root })
        const exactRetry = yield* DeepAgentLearningLifecycleTrigger.recover(db, { authorityRoot: root })

        expect(recovered).toHaveLength(1)
        expect(recovered[0]).toMatchObject({ state: "admitted", runId: "run-crash" })
        expect(exactRetry).toHaveLength(0)
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 1 })
      }),
    )
  })

  test("replays artifact publication from a prepared receipt after a crash", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        writeSource("run-publish-crash", "ses_learning")
        mkdirSync(path.join(root, "wrong-authority"))

        expect(
          yield* DeepAgentLearningLifecycleTrigger.observe(
            db,
            {
              trigger: "idle",
              boundaryKey: "session-idle:ses_learning",
              sessionID: "ses_learning",
              match: "session",
            },
            { authorityRoot: path.join(root, "wrong-authority"), runsDir: path.join(root, "runs"), now: 20 },
          ).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        expect(yield* db.select().from(LearningLifecycleTriggerTable).get()).toMatchObject({ state: "prepared" })
        expect(existsSync(path.join(root, "runs", "run-publish-crash", "LEARNING_LIFECYCLE_TRIGGER_IDLE.json"))).toBe(
          false,
        )

        expect(yield* DeepAgentLearningLifecycleTrigger.recover(db, { authorityRoot: root })).toEqual([
          expect.objectContaining({ state: "admitted", runId: "run-publish-crash" }),
        ])
        expect(existsSync(path.join(root, "runs", "run-publish-crash", "LEARNING_LIFECYCLE_TRIGGER_IDLE.json"))).toBe(
          true,
        )
      }),
    )
  })

  test("fails closed when the source admission receipt is tampered", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const source = writeSource("run-tampered", "ses_learning")
        const receipt = JSON.parse(yield* Effect.promise(() => Bun.file(source.receiptPath).text()))
        receipt.admission_intent.diagnoses = [{ forged: true }]
        writeFileSync(source.receiptPath, CanonicalJson.stringify(receipt))

        expect(
          yield* DeepAgentLearningLifecycleTrigger.observe(
            db,
            {
              trigger: "idle",
              boundaryKey: "session-idle:ses_learning",
              sessionID: "ses_learning",
              match: "session",
            },
            { authorityRoot: root, runsDir: path.join(root, "runs") },
          ),
        ).toEqual({ state: "skipped", reason: "no_exact_settled_run" })
        expect(yield* db.select({ count: count() }).from(LearningLifecycleTriggerTable).get()).toEqual({ count: 0 })
      }),
    )
  })
})

function writeSource(
  runID: string,
  sessionID: string,
  options: { readonly parentSessionID?: string; readonly workspace?: string; readonly goalID?: string } = {},
) {
  const runDir = path.join(root, "runs", runID)
  const terminalPath = path.join(runDir, "DEEPAGENT_RUN_STATE.json")
  const receiptPath = path.join(runDir, AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE)
  mkdirSync(runDir, { recursive: true })
  const input: Admission = {
    baseDir: root,
    workspacePath: options.workspace ?? path.join(root, "workspace"),
    rejectedBufferDir: path.join(root, "memory"),
    terminalArtifact: {
      schema_version: "deepagent-code.learning_terminal_artifact.v1",
      path: terminalPath,
      sha256: "0".repeat(64),
      learning_admission_fingerprint: "0".repeat(64),
    },
    input: {
      projectID: "requested-project",
      sessionID,
      runID,
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "session_finalization",
      policy: "auto_merge_safe_project",
    },
  }
  const fingerprint = DeepAgentDurableLearning.admissionFingerprint(input)
  const terminal = CanonicalJson.stringify({
    schema_version: "deepagent_global_run_state.v1",
    run_id: runID,
    generic_agent_session_id: sessionID,
    parent_generic_agent_session_id: options.parentSessionID ?? null,
    goal_id: options.goalID ?? null,
    agent_mode: "high",
    state: "completed",
    updated_at: "2026-08-13T00:00:00.000Z",
    learning_admission_fingerprint: fingerprint,
  })
  const admission: Admission = {
    ...input,
    terminalArtifact: {
      ...input.terminalArtifact,
      sha256: Hash.sha256(terminal),
      learning_admission_fingerprint: fingerprint,
    },
  }
  writeFileSync(terminalPath, terminal)
  writeFileSync(
    receiptPath,
    CanonicalJson.stringify(DeepAgentDurableLearning.localAdmissionReceipt(admission, "submitted")),
  )
  return { receiptPath }
}

function insertSession(db: Database.Interface["db"], sessionID: string, directory: string) {
  return db.insert(SessionTable).values({
    id: SessionSchema.ID.make(sessionID),
    project_id: Project.ID.make("project-db-1"),
    slug: sessionID,
    directory,
    title: sessionID,
    version: "1",
    time_created: 1,
    time_updated: 1,
  })
}

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [learningLifecycleTriggerMigration])
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.insert(ProjectTable).values({
        id: Project.ID.make("project-db-1"),
        worktree: AbsolutePath.make(path.join(root, "workspace")),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      yield* insertSession(db, "ses_learning", path.join(root, "workspace"))
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}
