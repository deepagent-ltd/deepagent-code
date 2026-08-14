import { describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { MoveSession } from "@deepagent-code/core/control-plane/move-session"
import { EventTable } from "@deepagent-code/core/event/sql"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const layer = Layer.mergeAll(database, SessionV2.defaultLayer, MoveSession.defaultLayer)
const it = testEffect(layer)

const source = AbsolutePath.make("/source")
const destination = AbsolutePath.make("/destination")
const projectID = ProjectV2.ID.make("project")

const insertSession = Effect.fn("MoveSessionTest.insertSession")(function* (sessionID: SessionV2.ID) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values([{ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 }])
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionID,
        project_id: projectID,
        slug: sessionID,
        directory: source,
        title: "move",
        version: "test",
        time_created: 1,
        time_updated: 1,
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

describe("MoveSession", () => {
  it.effect("keeps an exact-location retry idempotent", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_move_same_location")
      yield* insertSession(sessionID)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: source }, moveChanges: true }),
      )

      expect(yield* SessionV2.Service.use((service) => service.get(sessionID))).toMatchObject({
        id: sessionID,
        location: { directory: source },
      })
    }),
  )

  it.effect("rejects placement changes before durable Session or Event side effects", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_move_requires_transfer")
      yield* insertSession(sessionID)
      const { db } = yield* Database.Service
      const before = {
        session: yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
        events: yield* db
          .select({ count: sql<number>`count(*)` })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .get(),
      }

      const error = yield* MoveSession.Service.use((service) =>
        service
          .moveSession({ sessionID, destination: { directory: destination }, moveChanges: true })
          .pipe(Effect.flip),
      )

      expect(error).toEqual(
        new MoveSession.TransferUnsupportedError({
          sessionID,
          source,
          destination,
          message:
            "Session moves require durable transfer admission, execution fencing, and idempotent change receipts",
        }),
      )
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toEqual(before.session)
      expect(
        yield* db
          .select({ count: sql<number>`count(*)` })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .get(),
      ).toEqual(before.events)
    }),
  )

  it.effect("preserves the typed not-found result", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_move_missing")
      const error = yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: destination } }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(SessionV2.NotFoundError)
    }),
  )
})
