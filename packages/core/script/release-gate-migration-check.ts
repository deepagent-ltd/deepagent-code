// Release-gate migration check: open a DB copy via layerFromPath (which applies pending
// migrations) and report the latest applied migrations. Never touches the live DB.
import { Effect } from "effect"
import { Database } from "../src/database/database"

const filename = process.argv[2]
if (!filename) {
  console.error("usage: bun script/release-gate-migration-check.ts <db-path>")
  process.exit(1)
}

const program = Effect.gen(function* () {
  const svc = yield* Database.Service
  const rows = yield* svc.db.all<{ id: string }>("SELECT id FROM migration ORDER BY id DESC LIMIT 6")
  console.log("APPLIED_OK")
  for (const row of rows) console.log("  migration:", row.id)
  const count = yield* svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM migration")
  console.log("total migrations:", count?.n)
}).pipe(Effect.provide(Database.layerFromPath(filename)))

await Effect.runPromise(program)
