import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { mkdirSync } from "node:fs"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentLearningGeneration } from "@deepagent-code/core/deepagent/learning-generation"
import { LearningGenerationTable } from "@deepagent-code/core/deepagent/learning-generation.sql"
import { LearningJobTable } from "@deepagent-code/core/deepagent/learning-job.sql"
import { createInitialRoundState } from "@deepagent-code/core/deepagent/round-state"
import { Global } from "@deepagent-code/core/global"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { V2RunnerFrame } from "../../src/session/v2-runner-frame"
import { disposeAllInstances, requireInstance, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
    Database.defaultLayer,
    V2RunnerFrame.gatewayRuntimeLayer,
    httpApiLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("project-switch learning HTTP release gate", () => {
  it.instance(
    "claims only settled generations in the routed previous project, exactly once",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const previous = yield* requireInstance
      const db = (yield* Database.Service).db
      const otherProject = Project.ID.make("project_other_learning_switch")
      yield* db.insert(ProjectTable).values({
        id: otherProject,
        worktree: AbsolutePath.make(path.join(instance.directory, "other")),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      const sessions = [
        { id: "ses_switch_one", projectID: previous.project.id, active: false },
        { id: "ses_switch_two", projectID: previous.project.id, active: false },
        { id: "ses_switch_active", projectID: previous.project.id, active: true },
        { id: "ses_switch_other", projectID: otherProject, active: false },
      ] as const
      yield* Effect.forEach(
        sessions,
        (session) =>
          db.insert(SessionTable).values({
            id: SessionSchema.ID.make(session.id),
            project_id: session.projectID,
            slug: session.id,
            directory: instance.directory,
            title: session.id,
            version: "test",
            v2_authority: true,
            execution_claim_token: session.active ? 123 : null,
          }),
        { discard: true },
      )
      yield* Effect.forEach(
        sessions,
        (session) => {
          const runID = `v2_activity_${Hash.sha256(session.id).slice(0, 24)}`
          const artifact = path.join(Global.Path.agent.data, "runs", runID, "DEEPAGENT_RUN_STATE.json")
          return Effect.gen(function* () {
            yield* Effect.sync(() => mkdirSync(path.dirname(artifact), { recursive: true }))
            yield* DeepAgentLearningGeneration.record(db, {
              baseDir: Global.Path.agent.data,
              workspacePath: instance.directory,
              rejectedBufferDir: path.join(Global.Path.agent.data, "memory"),
              terminalArtifact: {
                schema_version: "deepagent-code.learning_terminal_artifact.v1",
                path: artifact,
                sha256: "0".repeat(64),
                learning_admission_fingerprint: "0".repeat(64),
              },
              input: {
                projectID: session.projectID,
                sessionID: session.id,
                runID,
                mode: "high",
                roundState: createInitialRoundState("high"),
                totalRounds: 1,
                finalStatus: "completed",
                trigger: "idle",
                policy: "manual_review",
                evidence: {
                  schema_version: "deepagent-code.learning_evidence.v1",
                  activity_id: `activity_${session.id}`,
                  plan_goal: "unfinished work",
                  document_refs: [],
                  changed_paths: [],
                  validations: [],
                },
              },
            })
          })
        },
        { discard: true },
      )

      const request = HttpServer.HttpServer.use((server) =>
        Effect.promise(async () => {
          const url = new URL("/deepagent/learning/project-switch", HttpServer.formatAddress(server.address))
          url.searchParams.set("directory", instance.directory)
          const response = await fetch(url, { method: "POST" })
          return { status: response.status, body: await response.json() }
        }),
      )
      expect(yield* request).toEqual({ status: 200, body: 2 })
      expect(yield* request).toEqual({ status: 200, body: 0 })
      yield* DeepAgentLearningGeneration.recover(db, Global.Path.agent.data)
      expect((yield* db.select().from(LearningJobTable).all()).map((job) => job.trigger)).toEqual([
        "project_switch",
        "project_switch",
      ])
      expect(
        (yield* db.select().from(LearningGenerationTable).all())
          .map((row) => ({
            sessionID: row.session_id,
            trigger: row.trigger,
          }))
          .sort((a, b) => a.sessionID.localeCompare(b.sessionID)),
      ).toEqual([
        { sessionID: "ses_switch_active", trigger: null },
        { sessionID: "ses_switch_one", trigger: "project_switch" },
        { sessionID: "ses_switch_other", trigger: null },
        { sessionID: "ses_switch_two", trigger: "project_switch" },
      ])

      yield* db
        .update(SessionTable)
        .set({ execution_claim_token: null })
        .where(eq(SessionTable.id, SessionSchema.ID.make("ses_switch_active")))
      expect(yield* request).toEqual({ status: 200, body: 1 })
      expect(yield* request).toEqual({ status: 200, body: 0 })
      yield* DeepAgentLearningGeneration.recover(db, Global.Path.agent.data)
      expect((yield* db.select().from(LearningJobTable).all()).map((job) => job.trigger)).toEqual([
        "project_switch",
        "project_switch",
        "project_switch",
      ])
    }),
    30_000,
  )
})
