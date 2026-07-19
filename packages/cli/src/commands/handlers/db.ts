import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect, Option } from "effect"
import { sql } from "drizzle-orm"

export default Runtime.handler(Commands.commands.db, (input) =>
  Effect.gen(function* () {
    const queryOpt = input.query as Option.Option<string>
    const query = Option.getOrElse(queryOpt, () => undefined)

    if (query) {
      const { Database } = yield* Effect.promise(() => import("@deepagent-code/core/database/database"))
      const result = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db.all<Record<string, unknown>>(sql.raw(query))
      }).pipe(Effect.provide(Database.defaultLayer), Effect.orDie)

      if (input.format === "json") {
        console.log(JSON.stringify(result, null, 2))
      } else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }

    const { spawn } = yield* Effect.promise(() => import("node:child_process"))
    const { Database } = yield* Effect.promise(() => import("@deepagent-code/core/database/database"))
    const child = spawn("sqlite3", [Database.path()], { stdio: "inherit" })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
)
