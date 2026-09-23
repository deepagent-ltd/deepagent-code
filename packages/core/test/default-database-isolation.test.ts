import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { Project } from "@deepagent-code/core/project"
import { projectLayer } from "./fixture/project-layer"
import { join } from "node:path"

test("the Core project test layer shares its in-memory authority database", async () => {
  const database = Database.layerFromPath(":memory:")
  const files = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Project.Service
      const { db } = yield* Database.Service
      return yield* db.all<{ name: string; file: string }>("PRAGMA database_list")
    }).pipe(Effect.provide(Layer.merge(database, projectLayer(database))), Effect.scoped),
  )
  expect(files.find((file) => file.name === "main")?.file).toBe("")
})

test("Core project tests keep default storage behind the two explicitly isolated integration cases", async () => {
  const allowed = new Set(["location-layer.test.ts", "session-runner-model-location.test.ts"])
  const files = [...new Bun.Glob("*.test.ts").scanSync({ cwd: import.meta.dir })]
  const offenders = await Promise.all(
    files.map(async (file) => {
      if (allowed.has(file)) return undefined
      return /Project\.defaultLayer/.test(await Bun.file(join(import.meta.dir, file)).text()) ? file : undefined
    }),
  )
  expect(offenders.filter((file) => file !== undefined)).toEqual([])
})
