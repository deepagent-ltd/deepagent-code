import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Hash } from "../../util/hash"
import type { DatabaseMigration } from "../migration"

// Migration approval identities are immutable. Importing evolving profile constants would
// silently change the meaning of this already-journaled storage contract.
const profiles = [
  ["project_work_v1", "91f818914d67956676de5fafdf32f5bfdc35144bbfccfb2fc50f397fbf1b65ba"],
  ["project_deepseek_context_bound_v1", "7bd21a7125686ceb9423f5269f7d82c55f0f9786281c8da0eccd629589c0cd7a"],
  ["project_shared_root_v1", "ee5ae4adb8c71abab978d841e2a2c4a2ce0b2e197720926b357017b5c145eb6b"],
  ["event_deepseek_dag_v1", "c5e37acd49bc82027d2b531070a545c577e409da0b17856abe19d218a6c05f98"],
] as const
const triggers = [
  ["work_command_intent_binding_insert", "939b1e279b7cb80cf24ba468925a39de81d628b8d93483d05c369d6064c69876"],
  ["work_write_stage_binding_insert", "e60c7da3128663e5d2e0862a2e1542fe04120e4071029bd8a33b2dff9e35baf9"],
] as const

export default {
  id: "20261011013000_work_native_profile_admission",
  up(tx) {
    return Effect.gen(function* () {
      if ((yield* tx.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys !== 1 ||
        (yield* tx.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys"))?.defer_foreign_keys !== 0)
        return yield* Effect.die("Native Work profile migration requires non-deferred FK-on storage")
      const observed = yield* Effect.forEach(triggers, ([name, hash]) => Effect.gen(function* () {
        const original = yield* tx.get<{ sql: string }>(sql`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=${name}`)
        if (!original || Hash.sha256(original.sql) !== hash)
          return yield* Effect.die("Native Work profile migration requires the original binding triggers")
        return { name, sql: original.sql }
      }))
      const approved = `json_extract(w.binding,'$.profile.version') IS 1 AND w.execution_role IS 'agent' AND (${profiles.map(
        ([id, hash]) => `(json_extract(w.binding,'$.profile.id') IS '${id}' AND json_extract(w.binding,'$.profile.hash') IS '${hash}')`,
      ).join(" OR ")})`
      // Replace only the profile predicate. Receipt/claim/binding/tool/capacity fences and
      // all historical rows remain intact; a DAG controller still cannot execute a tool.
      for (const trigger of observed) {
        yield* tx.run(sql.raw(`DROP TRIGGER ${trigger.name}`))
        yield* tx.run(sql.raw(trigger.sql.replace("json_extract(w.binding,'$.profile.id') IS 'project_work_v1'", approved)))
      }
    })
  },
} satisfies DatabaseMigration.Migration
