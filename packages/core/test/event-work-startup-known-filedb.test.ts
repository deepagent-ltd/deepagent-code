import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { layer } from "../src/database/sqlite.bun"
import { StartupInventory } from "../src/session/runner/startup-inventory"

// A real installed graph supplies immutable known rows; corruption is prepared only in
// owned copies. This consumer never migrates, changes the original facts, or calls a model.
const descriptor = process.env.DAC_EVENT_STARTUP_CLASSIFICATIONS
test.skipIf(!descriptor)("cold inventory classifies real Event lineage and refuses missing, corrupt, foreign and mixed custody", async () => {
  const input = await Bun.file(descriptor!).json() as { cases: { name: string; filename: string; accept: boolean }[] }
  const results = []
  for (const value of input.cases) {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA query_only=ON")
      const before = yield* db.get<{ providers: number; work: string; workspace: string }>(sql`SELECT
        (SELECT count(*) FROM session_provider_attempt) providers,
        (SELECT json_group_array(json_object('id',work_id,'outcome',outcome,'revision',control_revision,'hash',binding_hash)) FROM work_execution) work,
        (SELECT json_group_array(json_object('event',event_id,'task',task_id,'state',state,'error',error,'ref',continuation_ref)) FROM event_task_workspace) workspace`)
      const verdict = yield* StartupInventory.verifyStartupInventory(db)
      const after = yield* db.get<typeof before>(sql`SELECT
        (SELECT count(*) FROM session_provider_attempt) providers,
        (SELECT json_group_array(json_object('id',work_id,'outcome',outcome,'revision',control_revision,'hash',binding_hash)) FROM work_execution) work,
        (SELECT json_group_array(json_object('event',event_id,'task',task_id,'state',state,'error',error,'ref',continuation_ref)) FROM event_task_workspace) workspace`)
      return { verdict, before, after }
    }).pipe(Effect.provide(layer({ filename: value.filename, readonly: true })), Effect.scoped))
    expect(result.verdict.ok).toBe(value.accept)
    expect(result.before).toEqual(result.after)
    expect(result.before?.providers).toBe(6)
    expect(result.verdict.unclassifiedItems.length).toBe(value.accept ? 0 : 4)
    results.push({ name: value.name, accepted: result.verdict.ok, providerIncrement: 0,
      originalFactsUnchanged: true, reasons: [...new Set(result.verdict.unclassifiedItems.map((row) => row.reason))] })
  }
  if (process.env.DAC_EVENT_STARTUP_RESULT) await Bun.write(process.env.DAC_EVENT_STARTUP_RESULT,
    JSON.stringify({ results, providerRequests: 0, originalDBWrites: 0 }, null, 2))
})
