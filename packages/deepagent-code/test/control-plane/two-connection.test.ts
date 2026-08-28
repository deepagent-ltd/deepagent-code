import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionTable, TaskRunEventTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { MessageID, SessionID } from "@/session/schema"
import { admitTaskRun, transitionToAdmitting } from "@/tool/task-run"

describe("control-plane two-connection fences", () => {
  test("only one SQLite connection can win input admission and write its version event", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepagent-control-plane-two-connection-"))
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* Layer.build(Database.layerFromPath(join(root, "control-plane.sqlite")))
            const second = yield* Layer.build(Database.layerFromPath(join(root, "control-plane.sqlite")))
            const parentSessionID = SessionID.make("ses_two_connection_parent")
            const projectID = Project.ID.make("git-remote:example.com/two-connection")

            const admission = yield* Effect.gen(function* () {
              const { db } = yield* Database.Service
              yield* db
                .insert(ProjectTable)
                .values({ id: projectID, worktree: AbsolutePath.make(root), sandboxes: [] })
                .run()
                .pipe(Effect.orDie)
              yield* db
                .insert(SessionTable)
                .values({
                  id: parentSessionID,
                  project_id: projectID,
                  slug: "two-connection-parent",
                  directory: root,
                  title: "two connection parent",
                  version: "test",
                })
                .run()
                .pipe(Effect.orDie)
              return yield* admitTaskRun({
                parentSessionID,
                parentMessageID: MessageID.ascending("msg_two_connection"),
                toolCallID: "tool_two_connection",
                childSessionID: SessionID.make("ses_two_connection_child"),
                request: { prompt: "exactly once" },
                deliveryMode: "background",
                inputState: "pending",
              })
            }).pipe(Effect.provide(first))

            const attempts = yield* Effect.all(
              [
                transitionToAdmitting({ runID: admission.run.runID, version: admission.run.version }).pipe(
                  Effect.provide(first),
                ),
                transitionToAdmitting({ runID: admission.run.runID, version: admission.run.version }).pipe(
                  Effect.provide(second),
                ),
              ],
              { concurrency: "unbounded" },
            )
            const persisted = yield* Effect.gen(function* () {
              const { db } = yield* Database.Service
              return {
                run: yield* db
                  .select({ version: TaskRunTable.version, inputState: TaskRunTable.input_state })
                  .from(TaskRunTable)
                  .where(eq(TaskRunTable.run_id, admission.run.runID))
                  .get()
                  .pipe(Effect.orDie),
                events: yield* db
                  .select({ version: TaskRunEventTable.version, type: TaskRunEventTable.type })
                  .from(TaskRunEventTable)
                  .where(eq(TaskRunEventTable.run_id, admission.run.runID))
                  .all()
                  .pipe(Effect.orDie),
              }
            }).pipe(Effect.provide(first))

            expect(attempts.filter((attempt) => attempt !== undefined)).toHaveLength(1)
            expect(persisted.run).toEqual({ version: 1, inputState: "admitting" })
            expect(persisted.events).toEqual([
              { version: 0, type: "run_admitted" },
              { version: 1, type: "input_admitting" },
            ])
          }),
        ),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
