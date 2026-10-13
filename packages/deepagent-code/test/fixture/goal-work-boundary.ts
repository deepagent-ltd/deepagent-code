export * as GoalWorkBoundaryFixture from "./goal-work-boundary"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@deepagent-code/core/database/database"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"

// Reserve through the actual Work authority before creating its Session. Only the host source/route
// verifier is controlled; the resulting binding and recursive Session ancestry are real SQL records.
export const reserve = Effect.fn("GoalWorkBoundaryFixture.reserve")(function* (
  db: Database.Interface["db"],
  suffix: string,
) {
  yield* db.run(
    "CREATE TABLE IF NOT EXISTS test_work_source (id text PRIMARY KEY, revision integer, record_hash text, enabled integer)",
  )
  yield* db.run(sql`INSERT OR IGNORE INTO test_work_source VALUES ('operator-one', 1, ${"f".repeat(64)}, 1)`)
  yield* db.run(
    "CREATE TABLE IF NOT EXISTS test_work_route (id text PRIMARY KEY, evidence_hash text, configuration_hash text, enabled integer)",
  )
  yield* db.run(
    sql`INSERT OR IGNORE INTO test_work_route VALUES ('route-one', ${"d".repeat(64)}, ${"c".repeat(64)}, 1)`,
  )
  return yield* WorkAuthority.reserve(db, {
    binding: {
      ...WorkAuthorityFixture.binding(suffix),
      sessionID: `ses_goal_${suffix}`,
      location: { directory: "/tmp/goal-fixture" },
    },
    now: WorkAuthorityFixture.NOW,
  }).pipe(Effect.provide(WorkAuthorityFixture.verifier))
})
