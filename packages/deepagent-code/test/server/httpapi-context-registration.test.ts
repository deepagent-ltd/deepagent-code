import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { Database } from "@deepagent-code/core/database/database"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { tmpdir } from "../fixture/fixture"

// The complete production route factory owns construction and request services. Do not
// inject a Gateway or a synthetic authorization/context middleware into the request.
test("production readiness registration shares the runner Gateway without request injection", async () => {
  await using fixture = await tmpdir()
  const directory = path.join(fixture.path, "current")
  const foreign = path.join(fixture.path, "foreign")
  await Bun.write(path.join(directory, "README.md"), "# REGISTRATIONCONTEXTFACT\n")
  await Bun.write(path.join(directory, "main.ts"), "export const actual = 'REGISTRATIONCONTEXTFACT'\n")
  await Bun.write(path.join(foreign, "README.md"), "# FOREIGNREGISTRATIONFACT\n")
  const currentID = SessionSchema.ID.create()
  const foreignID = SessionSchema.ID.create()
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: currentID,
            project_id: Project.ID.global,
            directory,
            title: "current registration",
            slug: "current",
            version: "test",
          },
          {
            id: foreignID,
            project_id: Project.ID.global,
            directory: foreign,
            title: "foreign registration",
            slug: "foreign",
            version: "test",
          },
        ])
        .run()
        .pipe(Effect.orDie)
    }).pipe(Effect.provide(Database.defaultLayer)),
  )
  const web = HttpRouter.toWebHandler(HttpApiApp.createRoutes(), { disableLogger: true })
  try {
    const current = await web.handler(
      new Request(
        `http://localhost/context/readiness?session_id=${currentID}&directory=${encodeURIComponent(directory)}`,
      ),
      HttpApiApp.context,
    )
    expect(current.status).toBe(200)
    const result = await current.json()
    expect(result.session_id).toBe(currentID)
    expect(result.statuses.knowledge.revision).toBe("released:none")
    expect(result.statuses.memory.revision).toBe("memory:0")
    const rejected = await web.handler(
      new Request(
        `http://localhost/context/readiness?session_id=${foreignID}&directory=${encodeURIComponent(directory)}`,
      ),
      HttpApiApp.context,
    )
    expect(rejected.status).toBe(404)
    expect(JSON.stringify(await rejected.json())).not.toContain("FOREIGNREGISTRATIONFACT")
  } finally {
    await web.dispose()
  }
}, 30_000)
