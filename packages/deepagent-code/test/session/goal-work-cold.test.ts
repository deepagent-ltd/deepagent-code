import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { GoalControlFixture } from "../../../core/test/fixture/goal-control"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"
import { GoalWorkBoundaryFixture } from "../fixture/goal-work-boundary"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"

const facts = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return yield* Effect.forEach(
    [
      "goal_control",
      "goal_control_command",
      "goal_tick_permit",
      "session",
      "session_input",
      "session_context_selection",
      "session_provider_attempt",
      "deepagent_event",
    ],
    (table) => db.all(sql.raw(`SELECT * FROM ${table} ORDER BY rowid`)),
  )
})

test("new process rejects old bound Goal ticks using real file DB before any downstream execution", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "authority.sqlite")
  const database = WorkAuthorityFixture.database(filename)
  const before = await Effect.runPromise(
    Effect.gen(function* () {
      yield* WorkAuthorityFixture.initialize()
      const db = (yield* Database.Service).db
      yield* GoalWorkBoundaryFixture.reserve(db, "file-root")
      const root = yield* GoalControlFixture.activate(db, "file-root")
      const child = yield* GoalControlFixture.activate(db, "file-child")
      const grandchild = yield* GoalControlFixture.activate(db, "file-grandchild")
      yield* db.run(sql`UPDATE session SET parent_id=${root.input.sessionID} WHERE id=${child.input.sessionID}`)
      yield* db.run(sql`UPDATE session SET parent_id=${child.input.sessionID} WHERE id=${grandchild.input.sessionID}`)
      return yield* facts
    }).pipe(Effect.provide(database), Effect.scoped),
  )
  // The first DB scope has closed. This is the production tick port in a fresh process; only its
  // downstream dependencies are tripwires. No model, Instance or validation subprocess may run.
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "../fixture/goal-work-cold-child.ts"), filename],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const output = await new Response(child.stdout).text()
  const errors = await new Response(child.stderr).text()
  expect({ exit: await child.exited, errors }).toEqual({ exit: 0, errors: "" })
  expect(JSON.parse(output)).toEqual({ outcomes: ["unsupported", "unsupported", "unsupported"], calls: [] })
  expect(await Effect.runPromise(facts.pipe(Effect.provide(database), Effect.scoped))).toEqual(before)
}, 30000)
