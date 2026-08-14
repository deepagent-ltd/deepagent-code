import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const it = testEffect(Database.layerFromPath(":memory:"))

describe("database capability", () => {
  it.effect("persists an immutable reader and writer compatibility boundary", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect(yield* db.get(sql`SELECT capability, minimum_reader_protocol, minimum_writer_protocol
        FROM database_capability WHERE capability = 'bounded_event_snapshot_v1'`)).toEqual({
        capability: "bounded_event_snapshot_v1",
        minimum_reader_protocol: 2,
        minimum_writer_protocol: 2,
      })
      expect(
        (yield* db.run(sql`UPDATE database_capability SET minimum_writer_protocol = 3
          WHERE capability = 'bounded_event_snapshot_v1'`).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(
        (yield* db.run(sql`DELETE FROM database_capability
          WHERE capability = 'bounded_event_snapshot_v1'`).pipe(Effect.exit))._tag,
      ).toBe("Failure")
    }),
  )

  test("fails startup before exposing a database that requires a newer protocol", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "deepagent-code-db-capability-"))
    const filename = path.join(directory, "database.db")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* db.run(sql`DROP TRIGGER database_capability_immutable_update`)
            yield* db.run(sql`UPDATE database_capability SET minimum_reader_protocol = 3, minimum_writer_protocol = 3
              WHERE capability = 'bounded_event_snapshot_v1'`)
          }).pipe(Effect.provide(Database.layerFromPath(filename))),
        ),
      )
      const exit = await Effect.runPromise(
        Effect.scoped(Database.Service.pipe(Effect.provide(Database.layerFromPath(filename)))).pipe(Effect.exit),
      )
      expect(exit._tag).toBe("Failure")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
