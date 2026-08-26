// Release-gate data integrity check: open a DB COPY (never the live authority), verify physical
// integrity, the foreign-key graph, and the migration registry set, then report one verdict.
import { Effect } from "effect"
import { Database } from "../src/database/database"
import { DataIntegrity } from "../src/database/data-integrity"
import { migrations } from "../src/database/migration.gen"

const filename = process.argv[2]
if (!filename) {
  console.error("usage: bun script/data-integrity-check.ts <db-path>")
  process.exit(1)
}

const program = Effect.gen(function* () {
  const svc = yield* Database.Service
  const verdict = yield* DataIntegrity.check(svc.db)
  if (!verdict.ok) {
    console.error("DATA_INTEGRITY_FAIL", verdict.reason, verdict.detail)
    for (const row of verdict.rows ?? []) console.error("  row:", JSON.stringify(row))
    process.exitCode = 1
    return
  }
  // D-1 oracle: applied migration set must equal the registry (id-sorted set equality).
  const applied = yield* svc.db.all<{ id: string }>("SELECT id FROM migration ORDER BY id")
  const expected = [...migrations.map((migration) => migration.id)].sort()
  const first = expected.findIndex((id, index) => applied[index]?.id !== id)
  if (first === -1 && applied.length === expected.length) console.log("DATA_INTEGRITY_OK")
  else {
    console.error(`REGISTRY_MISMATCH at index ${first}: registry=${expected[first]} applied=${applied[first]?.id ?? "(missing)"}`)
    process.exitCode = 1
  }
}).pipe(Effect.provide(Database.layerFromPath(filename)))

await Effect.runPromise(program)
