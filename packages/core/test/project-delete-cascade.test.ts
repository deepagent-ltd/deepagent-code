import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { MessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { testEffect } from "./lib/effect"

// The GET/DELETE /global/projects handler deletes a single ProjectTable row and relies on the
// schema's onDelete: "cascade" foreign keys to remove everything that hangs off it (sessions,
// then their messages/parts). This test pins that invariant directly against the database so the
// handler stays correct even if the schema is refactored.
const database = Database.layerFromPath(":memory:")
const it = testEffect(Layer.mergeAll(database))

describe("project delete cascade", () => {
  it.live("deleting a project row cascades to its sessions and messages", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.make("git-remote:example.com/delete-cascade")
      const sessionID = SessionSchema.ID.descending()
      const messageID = SessionV1.MessageID.make("msg_delete_cascade")

      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(MessageTable)
        .values({ id: messageID, session_id: sessionID, data: {} as never })
        .run()
        .pipe(Effect.orDie)

      // Sanity: the rows are present before deletion.
      expect((yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).length).toBe(1)
      expect((yield* db.select().from(MessageTable).all().pipe(Effect.orDie)).length).toBe(1)

      yield* db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run().pipe(Effect.orDie)

      // The project row and, by cascade, its session and that session's message are all gone.
      expect((yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)).length).toBe(0)
      expect((yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).length).toBe(0)
      expect((yield* db.select().from(MessageTable).all().pipe(Effect.orDie)).length).toBe(0)
    }),
  )

  it.live("deleting an unknown project affects no rows and does not throw", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.make("git-remote:example.com/never-existed")

      yield* db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run().pipe(Effect.orDie)

      expect((yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)).length).toBe(0)
    }),
  )
})
