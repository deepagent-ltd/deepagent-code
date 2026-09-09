import { describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRestart } from "@deepagent-code/core/session/execution/restart"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const activeID = SessionSchema.ID.make("ses_runtime_active")
const recoveryID = SessionSchema.ID.make("ses_runtime_recovery")
const idleID = SessionSchema.ID.make("ses_runtime_idle")
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set([activeID])),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
  }),
)
const store = SessionStore.layer.pipe(Layer.provide(database))
const restart = SessionRestart.layer.pipe(Layer.provide(database), Layer.provide(execution), Layer.provide(store))
const status = SessionRuntimeStatus.layer.pipe(Layer.provide(execution), Layer.provide(restart))
const it = testEffect(Layer.mergeAll(database, execution, store, restart, status))

describe("SessionRuntimeStatus", () => {
  it.effect("distinguishes process-owned work from orphaned durable claims", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(
          [activeID, recoveryID, idleID].map((id) => ({
            id,
            project_id: ProjectV2.ID.global,
            slug: id,
            directory: AbsolutePath.make("/project"),
            title: id,
            version: "test",
            time_suspended: id === idleID ? null : 1,
          })),
        )
        .run()
        .pipe(Effect.orDie)

      expect(Object.fromEntries(yield* SessionRuntimeStatus.Service.use((service) => service.list))).toEqual({
        [activeID]: "busy",
        [recoveryID]: "recovery_required",
      })
    }),
  )
})
