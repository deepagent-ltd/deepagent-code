import { describe, expect, test } from "bun:test"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import migration from "@deepagent-code/core/database/migration/20260813120000_legacy_provider_receipt_supersession"

describe("legacy provider receipt supersession migration", () => {
  test("terminalizes only legacy unknown receipts superseded by a later request", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(`
          CREATE TABLE session_tool_request_receipt (
            receipt_id TEXT PRIMARY KEY,
            request_ordinal INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            provider_attempt_id TEXT,
            provider_state TEXT NOT NULL,
            request_error_code TEXT,
            created_at INTEGER NOT NULL,
            terminal_at INTEGER
          )
        `)
        yield* db.run(`
          CREATE TRIGGER session_tool_request_receipt_provider_transition
          BEFORE UPDATE OF provider_state ON session_tool_request_receipt
          WHEN NEW.provider_state != OLD.provider_state
          BEGIN
            SELECT RAISE(ABORT, 'original transition guard');
          END
        `)
        yield* db.run(`
          INSERT INTO session_tool_request_receipt VALUES
            ('superseded', 1, 'session-a', NULL, 'indeterminate_after_crash', 'legacy_dispatch_outcome_unknown', 10, 10),
            ('tail', 2, 'session-a', NULL, 'indeterminate_after_crash', 'legacy_dispatch_outcome_unknown', 20, 20),
            ('attempt', 1, 'session-b', 'attempt-1', 'indeterminate_after_crash', 'legacy_dispatch_outcome_unknown', 30, 30),
            ('attempt-tail', 2, 'session-b', NULL, 'indeterminate_after_crash', 'legacy_dispatch_outcome_unknown', 40, 40),
            ('non-legacy', 1, 'session-c', NULL, 'indeterminate_after_crash', 'process_restart_outcome_unknown', 50, 50),
            ('non-legacy-tail', 2, 'session-c', NULL, 'indeterminate_after_crash', 'process_restart_outcome_unknown', 60, 60)
        `)

        yield* DatabaseMigration.applyOnly(db, [migration])

        expect(
          yield* db.all<{
            receipt_id: string
            provider_state: string
            request_error_code: string | null
          }>(`SELECT receipt_id, provider_state, request_error_code FROM session_tool_request_receipt ORDER BY receipt_id`),
        ).toEqual([
          {
            receipt_id: "attempt",
            provider_state: "indeterminate_after_crash",
            request_error_code: "legacy_dispatch_outcome_unknown",
          },
          {
            receipt_id: "attempt-tail",
            provider_state: "indeterminate_after_crash",
            request_error_code: "legacy_dispatch_outcome_unknown",
          },
          {
            receipt_id: "non-legacy",
            provider_state: "indeterminate_after_crash",
            request_error_code: "process_restart_outcome_unknown",
          },
          {
            receipt_id: "non-legacy-tail",
            provider_state: "indeterminate_after_crash",
            request_error_code: "process_restart_outcome_unknown",
          },
          {
            receipt_id: "superseded",
            provider_state: "failed",
            request_error_code: "legacy_request_superseded_by_later_request",
          },
          {
            receipt_id: "tail",
            provider_state: "indeterminate_after_crash",
            request_error_code: "legacy_dispatch_outcome_unknown",
          },
        ])

        expect(
          yield* db
            .run("UPDATE session_tool_request_receipt SET provider_state = 'failed' WHERE receipt_id = 'tail'")
            .pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })
})
