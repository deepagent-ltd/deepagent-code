import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { WorkStorageCleanup } from "../../src/session/work-storage-cleanup"

/** SQL-only observer of an actually produced private Native database. No bootstrap,
 * verifier, Authority, migration or execution service is constructed. */
export function storageUsage(filename: string, instanceID: string) {
  return Effect.runPromise(Effect.gen(function* () {
    return yield* WorkStorageCleanup.usage(yield* EffectDrizzleSqlite.makeWithDefaults(), instanceID)
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
}
