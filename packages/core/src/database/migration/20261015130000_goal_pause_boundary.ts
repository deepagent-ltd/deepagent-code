import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015130000_goal_pause_boundary",
  up: (tx) =>
    Effect.gen(function* () {
      yield* tx.run(
        "CREATE TABLE goal_pause_boundary (permit_id TEXT PRIMARY KEY NOT NULL,goal_id TEXT NOT NULL,command_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL,record_hash TEXT NOT NULL,logical_bytes INTEGER NOT NULL,reserved_bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,CONSTRAINT goal_pause_boundary_state_check CHECK(state IN ('prepared','committed')),CONSTRAINT goal_pause_boundary_record_check CHECK(json_valid(record) AND json_type(record)='object' AND length(CAST(record AS BLOB)) BETWEEN 2 AND 1048576),CONSTRAINT goal_pause_boundary_size_check CHECK(logical_bytes=length(CAST(record AS BLOB)) AND reserved_bytes=1048576),CONSTRAINT goal_pause_boundary_hash_check CHECK(length(record_hash)=64 AND record_hash NOT GLOB '*[^0-9a-f]*'))",
      )
      yield* tx.run("CREATE INDEX goal_pause_boundary_goal_idx ON goal_pause_boundary(goal_id)")
    }),
} satisfies DatabaseMigration.Migration
