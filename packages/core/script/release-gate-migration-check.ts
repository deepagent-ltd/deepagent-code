// Release-gate migration check: open a DB copy via layerFromPath (which applies pending
// migrations) and report the latest applied migrations. Never touches the live DB.
import { Effect } from "effect"
import { Database } from "../src/database/database"
import { migrations } from "../src/database/migration.gen"

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
  // §16.4 D-1 — deterministic oracle: the DB's applied migration set must equal the generated
  // registry, in order, with nothing missing and nothing extra. Any divergence (partial apply,
  // interruption, id drift, out-of-registry rows) fails the gate with the first difference.
  const applied = yield* svc.db.all<{ id: string }>("SELECT id FROM migration ORDER BY id")
  // Set equality on id-sorted lists: the registry's APPLY order is pinned by the digest gate
  // (migration-registry-gate.test.ts); the DB side only proves "all of them, none extra".
  const expected = [...migrations.map((migration) => migration.id)].sort()
  const first = expected.findIndex((id, index) => applied[index]?.id !== id)
  if (first === -1 && applied.length === expected.length) console.log("REGISTRY_MATCH_OK")
  else
    console.error(
      `REGISTRY_MISMATCH at index ${first}: registry=${expected[first]} applied=${applied[first]?.id ?? "(missing)"}`,
    )
}).pipe(Effect.provide(Database.layerFromPath(filename)))

await Effect.runPromise(program)
