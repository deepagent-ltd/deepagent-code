import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { SessionSchema } from "../../src/session/schema"
import { SessionTable } from "../../src/session/sql"
import { SessionProjector } from "../../src/session/projector"
import { tmpRoot } from "./tmpdir"

export function quotaLayer(filename: string) {
  const database = Database.layerFromPath(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(Layer.merge(database, events)))
  return Layer.mergeAll(database, events, projector)
}

export const seedQuotaSession = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  directory = "/quota-fixture",
) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      directory,
      slug: sessionID,
      title: "quota fixture",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

export function runQuota<A, E>(effect: Effect.Effect<A, E, Database.Service>, sessionID: SessionSchema.ID) {
  return Effect.runPromise(
    seedQuotaSession(sessionID).pipe(
      Effect.andThen(effect),
      Effect.provide(quotaLayer(path.join(tmpRoot(), "quota.sqlite"))),
      Effect.scoped,
    ),
  )
}
