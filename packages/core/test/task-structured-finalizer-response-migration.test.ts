import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Cause, Effect, Exit } from "effect"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import responseMigration from "@deepagent-code/core/database/migration/20260812223000_task_structured_finalizer_response"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("task structured finalizer response migration", () => {
  test("rejects mismatched identities and freezes an exact response chain", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const index = migrations.findIndex((migration) => migration.id === responseMigration.id)
        expect(index).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
        const now = Date.now()
        for (const statement of [
          `
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-response', '/project-response', '[]', ${now}, ${now})`,
          `
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES
            ('session-response-parent', 'project-response', 'parent', '/project-response', 'parent', 'test', ${now}, ${now}),
            ('session-response-child', 'project-response', 'child', '/project-response', 'child', 'test', ${now}, ${now})`,
          `
          INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
            ('message-response-raw', 'session-response-child', ${now}, ${now}, '{"role":"assistant"}'),
            ('message-response-request', 'session-response-child', ${now}, ${now},
              '{"role":"user","metadata":{"deepagent":{"structured_finalizer":{"run_id":"run-response","attempt":1,"source_message_id":"message-response-raw","allow_text":false}}}}'),
            ('message-response-bad-metadata-request', 'session-response-child', ${now}, ${now},
              '{"role":"user","metadata":{"deepagent":{"structured_finalizer":{"run_id":"another-run","attempt":1,"source_message_id":"message-response-raw","allow_text":false}}}}'),
            ('message-response-bad-metadata-result', 'session-response-child', ${now}, ${now},
              '{"role":"assistant","parentID":"message-response-bad-metadata-request","structured":{"result":"bad"}}'),
            ('message-response-result', 'session-response-child', ${now}, ${now},
              '{"role":"assistant","parentID":"message-response-request","structured":{"result":"ok"}}')`,
          `
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES ('part-response-result', 'message-response-result', 'session-response-child', ${now}, ${now},
            '{"type":"text","text":"ok"}')`,
          `
          INSERT INTO task_run (
            run_id, root_run_id, request_hash, parent_session_id, parent_message_id, tool_call_id,
            child_session_id, generation, delivery_mode, phase, state, attempts, raw_result_message_id,
            execution_owner, lease_expires_at, claim_generation, execution_spec, version, control_state,
            time_created, time_updated
          ) VALUES (
            'run-response', 'run-response', 'request-response', 'session-response-parent',
            'message-response-parent', 'call-response', 'session-response-child', 1, 'foreground',
            'finalize', 'finalizing', 1, 'message-response-raw', 'response-owner', ${now + 60_000}, 2,
            '{"prompt":{"text":"inspect"},"agent":"researcher","model":{"providerID":"test","modelID":"test"},"structuredOutput":{"schema":{"type":"object"},"allowTextFallback":true,"receiptVersion":1,"maxAttempts":2}}',
            3, 'open', ${now}, ${now}
          )
        `,
        ]) {
          yield* db.run(statement)
        }
        yield* DatabaseMigration.applyOnly(db, [responseMigration])
        expect(
          yield* db.get(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'task_structured_finalizer_response_insert_guard'",
          ),
        ).toEqual({ name: "task_structured_finalizer_response_insert_guard" })
        expect(
          yield* db.get(`
            SELECT
              run.state AS state,
              run.control_state AS control_state,
              run.interrupt_requested_at AS interrupt_requested_at,
              run.child_session_id AS child_session_id,
              run.execution_owner AS execution_owner,
              run.claim_generation AS claim_generation,
              run.version AS version,
              run.attempts AS attempts,
              run.raw_result_message_id AS source_message_id,
              response.data AS response_message_json,
              json_extract(response.data, '$.parentID') AS parent_id,
              json_extract(request.data, '$.metadata.deepagent.structured_finalizer.run_id') AS metadata_run_id
            FROM task_run run, message request, message response
            WHERE run.run_id = 'run-response'
              AND request.id = 'message-response-request'
              AND response.id = 'message-response-result'
          `),
        ).toMatchObject({
          state: "finalizing",
          control_state: "open",
          interrupt_requested_at: null,
          child_session_id: "session-response-child",
          execution_owner: "response-owner",
          claim_generation: 2,
          version: 3,
          attempts: 1,
          source_message_id: "message-response-raw",
          response_message_json:
            '{"role":"assistant","parentID":"message-response-request","structured":{"result":"ok"}}',
          parent_id: "message-response-request",
          metadata_run_id: "run-response",
        })

        const insert = (requestMessageID: string, sourceMessageID = "message-response-raw") =>
          db.run(`
            INSERT INTO task_structured_finalizer_response (
              run_id, attempt, child_session_id, owner_token, claim_generation, expected_version,
              source_message_id, request_message_id, response_message_id, response_message_json, created_at
            ) VALUES (
              'run-response', 1, 'session-response-child', 'response-owner', 2, 3,
              '${sourceMessageID}', '${requestMessageID}', 'message-response-result',
              '{"role":"assistant","parentID":"message-response-request","structured":{"result":"ok"}}', ${now}
            )
          `)
        expect(Exit.isFailure(yield* insert("message-response-raw").pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* insert("message-response-request", "mismatched-source").pipe(Effect.exit))).toBe(
          true,
        )
        expect(
          Exit.isFailure(
            yield* db
              .run(
                `
                INSERT INTO task_structured_finalizer_response (
                  run_id, attempt, child_session_id, owner_token, claim_generation, expected_version,
                  source_message_id, request_message_id, response_message_id, response_message_json, created_at
                ) VALUES (
                  'run-response', 1, 'session-response-child', 'response-owner', 2, 3,
                  'message-response-raw', 'message-response-bad-metadata-request',
                  'message-response-bad-metadata-result',
                  '{"role":"assistant","parentID":"message-response-bad-metadata-request","structured":{"result":"bad"}}',
                  ${now}
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const legitimate = yield* insert("message-response-request").pipe(Effect.exit)
        expect(Exit.isSuccess(legitimate), Exit.isFailure(legitimate) ? Cause.pretty(legitimate.cause) : "").toBe(true)

        for (const mutation of [
          "UPDATE message SET data = '{\"role\":\"assistant\"}' WHERE id = 'message-response-result'",
          "DELETE FROM message WHERE id = 'message-response-request'",
          `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES ('part-response-extra', 'message-response-result', 'session-response-child', ${now}, ${now},
             '{"type":"text","text":"extra"}')`,
          'UPDATE part SET data = \'{"type":"text","text":"changed"}\' WHERE id = \'part-response-result\'',
          "DELETE FROM part WHERE id = 'part-response-result'",
        ]) {
          expect(Exit.isFailure(yield* db.run(mutation).pipe(Effect.exit))).toBe(true)
        }
      }),
    )
  })
})
