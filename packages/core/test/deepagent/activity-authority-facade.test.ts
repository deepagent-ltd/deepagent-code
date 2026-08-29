import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import facadeActivityMigration from "@deepagent-code/core/database/migration/20260816073717_session_facade_activity"
import facadeOwnerMigration from "@deepagent-code/core/database/migration/20260821100000_session_facade_owner"
import { DeepAgentActivityAuthority } from "@deepagent-code/core/deepagent/activity-authority"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const facadeRef = (activityID: string) => ({ activityKind: "facade" as const, activityID })

describe("DeepAgentActivityAuthority facade branch (FEAT-011 T1+T2)", () => {
  test("fresh path applies the facade migration and reapplication is journal-idempotent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run("PRAGMA foreign_keys = ON")
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.applyOnly(db, [facadeActivityMigration])
        expect(
          yield* db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_facade_activity'"),
        ).toEqual({ name: "session_facade_activity" })
        expect(
          yield* db.get(
            "SELECT count(*) AS count FROM pragma_table_info('session_facade_activity') WHERE name = 'owner_token'",
          ),
        ).toEqual({ count: 1 })
        expect(
          yield* db.get("SELECT count(*) AS count FROM migration WHERE id = '20260816073717_session_facade_activity'"),
        ).toEqual({ count: 1 })
        // The isolation fence stays intact: the objective table keeps its ('legacy','v2') CHECK.
        expect(
          yield* db.get(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_activity_objective' AND sql LIKE '%facade%'",
          ),
        ).toBeUndefined()
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })

  test("upgrade path preserves legacy/v2 objective rows and keeps the kind CHECK fenced", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run("PRAGMA foreign_keys = ON")
        const facadeIndex = migrations.findIndex((migration) => migration.id === facadeActivityMigration.id)
        expect(facadeIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, facadeIndex))
        yield* seed(db)
        // Seed one legacy and one v2 objective row before the facade migration runs.
        yield* db.run(
          "INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created) VALUES ('upgrade-input', 'session-1', '{}', 'queue', 1, 1, 30)",
        )
        // Both objective rows are auto-projected by admission triggers (legacy during seed,
        // v2 on session_activity insert); the facade migration must preserve them untouched.
        yield* db.run(
          "INSERT INTO session_activity (activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at, settled_at) VALUES ('upgrade-v2', 'session-1', 0, 'upgrade-input', 'queue', 'active', 30, NULL)",
        )

        yield* DatabaseMigration.applyOnly(db, [facadeActivityMigration, facadeOwnerMigration])

        expect(
          yield* db.all(
            "SELECT activity_kind, activity_id, version, state, admission_fingerprint FROM session_activity_objective ORDER BY activity_kind",
          ),
        ).toEqual([
          {
            activity_kind: "legacy",
            activity_id: "activity-1",
            version: 1,
            state: "active",
            admission_fingerprint: "admission-payload-1",
          },
          {
            activity_kind: "v2",
            activity_id: "upgrade-v2",
            version: 1,
            state: "active",
            admission_fingerprint: "session-input:upgrade-input",
          },
        ])
        // The facade base table accepts new rows, while the objective CHECK keeps rejecting
        // 'facade' — that CHECK is the isolation fence between facade and the federation machinery.
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, state, created_at, mutation_epoch) VALUES ('facade-upgrade', 'panel', 'session-1', 'active', 40, 0)",
        )
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "INSERT INTO session_activity_objective (activity_kind, activity_id, session_id, version, admission_fingerprint, completion_criteria, enforcement_state, state, no_progress_count, latest_observation_revision, created_at, updated_at) VALUES ('facade', 'facade-upgrade', 'session-1', 1, 'facade-spawn:facade-upgrade', '[]', 'disabled', 'active', 0, -1, 40, 40)",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })

  test("facade never owns an objective row: reconstruct fails closed with NotFoundError", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, spawn_tool_call_id, state, created_at, mutation_epoch) VALUES ('facade-spawned', 'task', 'session-1', 'call-spawn-1', 'active', 40, 0)",
        )
        // Facade settlement bypasses the objective table entirely, so reconstruct has nothing
        // to read and must fail closed instead of leaking into the v2 branch.
        const notFound = yield* DeepAgentActivityAuthority.reconstruct(facadeRef("facade-spawned")).pipe(Effect.flip)
        expect(notFound._tag).toBe("ActivityAuthority.NotFoundError")
        expect(notFound).toMatchObject({ activityKind: "facade", activityID: "facade-spawned" })
        // And objective rows for facade stay rejected at the schema level.
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "INSERT INTO session_activity_objective (activity_kind, activity_id, session_id, version, admission_fingerprint, completion_criteria, enforcement_state, state, no_progress_count, latest_observation_revision, created_at, updated_at) VALUES ('facade', 'facade-nonexistent', 'session-1', 1, 'forged', '[]', 'disabled', 'active', 0, -1, 40, 40)",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("preserves facade terminal reasons and exact retries for every terminal state", async () => {
    for (const [state, baseState] of [
      ["completed", "settled"],
      ["interrupted", "interrupted"],
      ["recovery_required", "recovery_required"],
    ] as const) {
      await run(
        Effect.gen(function* () {
          const activityID = "facade-settle-" + state
          const facadeRefForState = facadeRef(activityID)
          const terminalReason = "terminal-reason-" + state
          const { db } = yield* Database.Service
          yield* db.run(
            `INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, state, created_at, mutation_epoch) VALUES ('${activityID}', 'goal', 'session-1', 'active', 40, 0)`,
          )

          // Fresh rows start at mutation_epoch 0; settlement bumps it to 1.
          const settled = yield* DeepAgentActivityAuthority.settle({
            ...facadeRefForState,
            expectedVersion: 0,
            state,
            terminalReason,
          })
          expect(settled).toMatchObject({
            activityKind: "facade",
            version: 1,
            state,
            terminalReason,
            sessionID: "session-1",
          })
          // Exact retry is idempotent: same terminal state + reason returns the same projection.
          expect(
            yield* DeepAgentActivityAuthority.settle({
              ...facadeRefForState,
              expectedVersion: 0,
              state,
              terminalReason,
            }),
          ).toEqual(settled)
          // Three-state mapping lands on the base table; no objective row is ever written.
          expect(
            yield* db.get(`SELECT state, reason_code FROM session_facade_activity WHERE activity_id = '${activityID}'`),
          ).toEqual({ state: baseState, reason_code: terminalReason })
          expect(
            yield* db.get(
              `SELECT count(*) AS count FROM session_activity_objective WHERE activity_kind = 'facade' AND activity_id = '${activityID}'`,
            ),
          ).toEqual({ count: 0 })
        }),
      )
    }
  })

  test("facade settlement is CAS-guarded against version and base drift", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, state, created_at, mutation_epoch) VALUES ('facade-cas', 'panel', 'session-1', 'active', 40, 0)",
        )
        // Stale expectedVersion (mutation_epoch token) fails closed before touching the base table.
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.settle({
              ...facadeRef("facade-cas"),
              expectedVersion: 99,
              state: "completed",
              terminalReason: "stale_version",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* db.get("SELECT state FROM session_facade_activity WHERE activity_id = 'facade-cas'")).toEqual({
          state: "active",
        })

        // A base that was settled out of band conflicts on settle (no replayable transition).
        yield* db.run(
          "UPDATE session_facade_activity SET state = 'interrupted', reason_code = 'out_of_band', settled_at = 41 WHERE activity_id = 'facade-cas'",
        )
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.settle({
              ...facadeRef("facade-cas"),
              expectedVersion: 0,
              state: "completed",
              terminalReason: "activity_complete",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.get("SELECT state, reason_code FROM session_facade_activity WHERE activity_id = 'facade-cas'"),
        ).toEqual({ state: "interrupted", reason_code: "out_of_band" })

        // Settling an already-terminal base with a different outcome is rejected.
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, state, created_at, mutation_epoch) VALUES ('facade-cas-terminal', 'task', 'session-1', 'active', 42, 0)",
        )
        yield* DeepAgentActivityAuthority.settle({
          ...facadeRef("facade-cas-terminal"),
          expectedVersion: 0,
          state: "interrupted",
          terminalReason: "first_interrupt",
        })
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.settle({
              ...facadeRef("facade-cas-terminal"),
              expectedVersion: 1,
              state: "completed",
              terminalReason: "late_completion",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.get(
            "SELECT state, reason_code FROM session_facade_activity WHERE activity_id = 'facade-cas-terminal'",
          ),
        ).toEqual({ state: "interrupted", reason_code: "first_interrupt" })

        // Settling an unknown facade activity fails closed with NotFoundError.
        const missing = yield* DeepAgentActivityAuthority.settle({
          ...facadeRef("facade-missing"),
          expectedVersion: 0,
          state: "completed",
          terminalReason: "missing",
        }).pipe(Effect.flip)
        expect(missing._tag).toBe("ActivityAuthority.NotFoundError")
        expect(missing).toMatchObject({ activityKind: "facade", activityID: "facade-missing" })
      }),
    )
  })

  test("partial unique index fails closed on a second active facade activity per parent and subkind", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, state, created_at, mutation_epoch) VALUES ('facade-index-first', 'task', 'session-1', 'active', 40, 0)",
        )
        // Same parent + subkind while the first is still active: BUG-004 shape is rejected.
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, state, created_at, mutation_epoch) VALUES ('facade-index-second', 'task', 'session-1', 'active', 41, 0)",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        // A different subkind does not collide.
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, state, created_at, mutation_epoch) VALUES ('facade-index-other-subkind', 'goal', 'session-1', 'active', 42, 0)",
        )
        // Settling frees the slot for the next active activity of that subkind.
        yield* DeepAgentActivityAuthority.settle({
          ...facadeRef("facade-index-first"),
          expectedVersion: 0,
          state: "completed",
          terminalReason: "activity_complete",
        })
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, state, created_at, mutation_epoch) VALUES ('facade-index-next', 'task', 'session-1', 'active', 43, 0)",
        )
        expect(
          yield* db.get(
            "SELECT count(*) AS count FROM session_facade_activity WHERE parent_session_id = 'session-1' AND subkind = 'task' AND state = 'active'",
          ),
        ).toEqual({ count: 1 })
      }),
    )
  })

  test("facade base lifecycle triggers mirror the legacy legal-update fence", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, state, created_at, mutation_epoch) VALUES ('facade-lifecycle', 'task', 'session-1', 'active', 40, 0)",
        )
        // The delegated execution Session may bind exactly once while active. It becomes
        // immutable immediately; all other identity columns remain immutable throughout.
        yield* db.run(
          "UPDATE session_facade_activity SET owner_session_id = 'session-2' WHERE activity_id = 'facade-lifecycle'",
        )
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "UPDATE session_facade_activity SET owner_session_id = 'session-1' WHERE activity_id = 'facade-lifecycle'",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run("UPDATE session_facade_activity SET subkind = 'goal' WHERE activity_id = 'facade-lifecycle'")
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run("UPDATE session_facade_activity SET source = 'forged' WHERE activity_id = 'facade-lifecycle'")
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        // Terminal transitions require settled_at + reason_code in one shot.
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "UPDATE session_facade_activity SET state = 'settled', settled_at = 41 WHERE activity_id = 'facade-lifecycle'",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(
          "UPDATE session_facade_activity SET state = 'settled', reason_code = 'stop', settled_at = 41, mutation_epoch = mutation_epoch + 1 WHERE activity_id = 'facade-lifecycle'",
        )
        // Terminal rows are single-shot: no further updates are legal.
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "UPDATE session_facade_activity SET state = 'interrupted', reason_code = 'late', settled_at = 42 WHERE activity_id = 'facade-lifecycle'",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("binds facade permission requests and effects to the delegated owner session", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, owner_session_id, spawn_tool_call_id, state, created_at, mutation_epoch) VALUES ('facade-permission', 'task', 'session-1', 'session-2', 'call-facade-spawn', 'active', 40, 0)",
        )
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: "runtime-facade", leaseMs: 60_000 })
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...facadeRef("facade-permission"),
          requestID: "facade-permission-request",
          requestKind: "tool",
          idempotencyKey: "facade-permission-request-key",
          permission: "bash",
          patterns: ["bun test"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-facade", callID: "call-child-bash" },
          ownerID: "runtime-facade",
        })
        expect(request).toMatchObject({
          activityKind: "facade",
          activityID: "facade-permission",
          sessionID: "session-2",
          state: "pending",
        })
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.requestPermission({
              ...facadeRef("facade-permission"),
              requestID: "facade-permission-no-progress",
              requestKind: "no_progress",
              idempotencyKey: "facade-permission-no-progress-key",
              permission: "doom_loop",
              patterns: ["bash"],
              alwaysPatterns: [],
              metadata: {},
              ownerID: "runtime-facade",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)

        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: request.requestID,
          idempotencyKey: "facade-permission-decision",
          decision: "approved_once",
          actorType: "user",
          actorID: "user-facade",
        })
        const effect = yield* DeepAgentActivityAuthority.beginPermissionEffect({
          requestID: request.requestID,
          toolName: "bash",
          consumerID: "tool:assistant-facade:call-child-bash",
          idempotencyKey: "facade-permission-effect",
          ownerID: "runtime-facade",
        })
        expect(effect).toMatchObject({ activityKind: "facade", state: "started", version: 1 })
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.settle({
              ...facadeRef("facade-permission"),
              expectedVersion: 0,
              state: "completed",
              terminalReason: "completed-before-effect",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* DeepAgentActivityAuthority.settlePermissionEffect({
          receiptID: effect.receiptID,
          expectedVersion: effect.version,
          ownerID: "runtime-facade",
          outcome: "success",
          result: { ok: true },
        })
        expect(
          yield* DeepAgentActivityAuthority.settle({
            ...facadeRef("facade-permission"),
            expectedVersion: 0,
            state: "completed",
            terminalReason: "activity_complete",
          }),
        ).toMatchObject({ state: "completed", version: 1 })
      }),
    )
  })

  test("recovers abandoned facade permission ownership and fences terminal pending asks", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, owner_session_id, spawn_tool_call_id, state, created_at, mutation_epoch) VALUES ('facade-permission-recovery', 'task', 'session-1', 'session-2', 'call-facade-recovery', 'active', 40, 0)",
        )
        yield* DeepAgentActivityAuthority.requestPermission({
          ...facadeRef("facade-permission-recovery"),
          requestID: "facade-permission-recovery-request",
          requestKind: "tool",
          idempotencyKey: "facade-permission-recovery-key",
          permission: "bash",
          patterns: ["bun test"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-recovery", callID: "call-child-recovery" },
          ownerID: "runtime-before-restart",
        })
        expect(yield* DeepAgentActivityAuthority.recoverPendingPermissions("runtime-after-restart")).toBe(1)
        expect(
          yield* db.get(
            "SELECT state, reason_code, mutation_epoch FROM session_facade_activity WHERE activity_id = 'facade-permission-recovery'",
          ),
        ).toEqual({
          state: "recovery_required",
          reason_code: "pending_permission_recovery_required",
          mutation_epoch: 1,
        })

        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, owner_session_id, spawn_tool_call_id, state, created_at, mutation_epoch) VALUES ('facade-permission-terminal', 'task', 'session-1', 'session-2', 'call-facade-terminal', 'active', 50, 0)",
        )
        yield* DeepAgentActivityAuthority.requestPermission({
          ...facadeRef("facade-permission-terminal"),
          requestID: "facade-permission-terminal-request",
          requestKind: "tool",
          idempotencyKey: "facade-permission-terminal-key",
          permission: "task",
          patterns: ["panel"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-terminal", callID: "call-child-terminal" },
          ownerID: "runtime-terminal",
        })
        yield* DeepAgentActivityAuthority.settle({
          ...facadeRef("facade-permission-terminal"),
          expectedVersion: 0,
          state: "interrupted",
          terminalReason: "user_interrupted",
        })
        expect(
          yield* db.get(
            "SELECT request.state, decision.decision, decision.actor_id FROM session_activity_permission_request request JOIN session_activity_permission_decision decision ON decision.request_id = request.request_id WHERE request.request_id = 'facade-permission-terminal-request'",
          ),
        ).toEqual({ state: "interrupted", decision: "interrupted", actor_id: "facade-terminal-fence" })
      }),
    )
  })

  test("rejects malformed facade permission rows and preserves explicit recovery settlement", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          "INSERT INTO session_facade_activity (activity_id, subkind, parent_session_id, state, created_at, mutation_epoch) VALUES ('facade-recover', 'panel', 'session-1', 'active', 40, 0)",
        )
        // Facade permission rows require a live task facade with a bound delegated owner Session.
        // This panel row has no owner binding, so malformed direct inserts remain rejected.
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "INSERT INTO session_activity_permission_request (request_id, activity_kind, activity_id, session_id, project_id, request_kind, idempotency_key, permission, patterns, always_patterns, metadata_hash, state, authority_epoch, requested_scope, owner_type, owner_id, created_at) VALUES ('facade-recover-request', 'facade', 'facade-recover', 'session-1', 'project-1', 'tool', 'facade-recover-key', 'bash', '[\"touch facade\"]', '[\"touch facade\"]', 'meta-1', 'pending', 0, 'once', 'runtime', 'runtime-facade', 40)",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "INSERT INTO session_activity_permission_effect_dispatch (receipt_id, request_id, activity_kind, activity_id, session_id, project_id, tool_message_id, tool_call_id, tool_name, consumer_id, idempotency_key, owner_id, state, version, started_at) VALUES ('facade-recover-receipt', 'request-missing', 'facade', 'facade-recover', 'session-1', 'project-1', 'assistant-facade', 'call-facade', 'bash', 'tool:assistant-facade:call-facade', 'facade-recover-effect', 'runtime-facade', 'started', 1, 40)",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        // Recovery-required settlement remains quiescent/nonterminal on the facade base.
        const settled = yield* DeepAgentActivityAuthority.settle({
          ...facadeRef("facade-recover"),
          expectedVersion: 0,
          state: "recovery_required",
          terminalReason: "permission_effect_outcome_unknown_after_restart",
        })
        expect(settled).toMatchObject({ version: 1, state: "recovery_required" })
        expect(
          yield* db.get("SELECT state, reason_code FROM session_facade_activity WHERE activity_id = 'facade-recover'"),
        ).toEqual({ state: "recovery_required", reason_code: "permission_effect_outcome_unknown_after_restart" })
      }),
    )
  })
})

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      yield* seed(db)
      return yield* effect.pipe(Effect.provideService(Database.Service, { db }))
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
}

function seed(db: Effect.Success<typeof makeDb>) {
  return Effect.gen(function* () {
    yield* db.run(
      "INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('project-1', '/tmp/project-1', '[]', 1, 1)",
    )
    yield* db.run(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session-1', 'project-1', 'session-1', '/tmp/project-1', 'Activity', '1', 1, 1)",
    )
    yield* db.run(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session-2', 'project-1', 'session-2', '/tmp/project-1', 'Other', '1', 1, 1)",
    )
    yield* db.run(
      "INSERT INTO session_intent (intent_id, session_id, source, state, selected_variant, selected_payload_hash, delivery, admitted_message_id, mutation_epoch, version, time_created, time_admitted, time_updated) VALUES ('intent-1', 'session-1', 'composer', 'admitted', 'original', 'admission-payload-1', 'turn', 'message-1', 0, 1, 1, 1, 1)",
    )
    yield* db.run(
      "INSERT INTO session_activity_admission (admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id, delivery, payload_fingerprint_kind, payload_fingerprint, created_at) VALUES ('admission-1', 'session-1', 'legacy_intent', 'intent-1', 'message-1', 'turn', 'payload_hash', 'admission-payload-1', 1)",
    )
    yield* db.run(
      "INSERT INTO session_legacy_activity (activity_id, session_id, ordinal, trigger_admission_id, owner_token, state, terminal_reason, created_at, settled_at) VALUES ('activity-1', 'session-1', 0, 'admission-1', 'owner-1', 'active', NULL, 1, NULL)",
    )
    yield* db.run(
      "INSERT INTO session_legacy_activity_admission (activity_id, admission_id, ordinal, role, attached_at) VALUES ('activity-1', 'admission-1', 0, 'trigger', 1)",
    )
  })
}
