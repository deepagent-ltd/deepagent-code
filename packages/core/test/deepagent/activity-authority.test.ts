import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import activityAuthorityMigration from "@deepagent-code/core/database/migration/20260811200000_activity_objective_permission_authority"
import activityPermissionTerminalFenceMigration from "@deepagent-code/core/database/migration/20260811224500_activity_permission_terminal_fence"
import activityPermissionRouteFeedbackMigration from "@deepagent-code/core/database/migration/20260812014934_activity_permission_route_feedback"
import { DeepAgentActivityAuthority } from "@deepagent-code/core/deepagent/activity-authority"
import { PermissionSaved } from "@deepagent-code/core/permission/saved"
import { ProjectV2 } from "@deepagent-code/core/project"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const ref = { activityKind: "legacy" as const, activityID: "activity-1" }

describe("DeepAgentActivityAuthority", () => {
  test("backfills a disabled objective and projects the base activity terminal state", async () => {
    await run(
      Effect.gen(function* () {
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective).toMatchObject({
          version: 1,
          admissionFingerprint: "admission-payload-1",
          enforcementState: "disabled",
          state: "active",
          latestObservationRevision: -1,
        })
        const { db } = yield* Database.Service
        yield* db.run(
          "UPDATE session_legacy_activity SET state = 'settled', terminal_reason = 'stop', settled_at = 20 WHERE activity_id = 'activity-1'",
        )
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective).toMatchObject({
          version: 2,
          state: "completed",
          terminalReason: "stop",
          settledAt: 20,
        })

        yield* db.run(
          "INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created) VALUES ('v2-input', 'session-1', '{}', 'queue', 1, 1, 30)",
        )
        yield* db.run(
          "INSERT INTO session_activity (activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at, settled_at) VALUES ('v2-activity', 'session-1', 0, 'v2-input', 'queue', 'active', 30, NULL)",
        )
        expect(
          (yield* DeepAgentActivityAuthority.reconstruct({
            activityKind: "v2",
            activityID: "v2-activity",
          })).objective,
        ).toMatchObject({ admissionFingerprint: "session-input:v2-input", enforcementState: "disabled" })
        yield* db.run(
          "UPDATE session_activity SET state = 'interrupted', settled_at = 31 WHERE activity_id = 'v2-activity'",
        )
        expect(
          (yield* DeepAgentActivityAuthority.reconstruct({
            activityKind: "v2",
            activityID: "v2-activity",
          })).objective,
        ).toMatchObject({ version: 2, state: "interrupted", settledAt: 31 })
      }),
    )
  })

  test("applies to a fresh database and reapplication is journal-idempotent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run("PRAGMA foreign_keys = ON")
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.applyOnly(db, [activityAuthorityMigration])
        yield* DatabaseMigration.applyOnly(db, [activityAuthorityMigration])
        expect(
          yield* db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_activity_objective'"),
        ).toEqual({ name: "session_activity_objective" })
        expect(
          yield* db.get(
            "SELECT count(*) AS count FROM migration WHERE id = '20260811200000_activity_objective_permission_authority'",
          ),
        ).toEqual({ count: 1 })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })

  test("backfills pending permissions already stranded behind a terminal objective", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run("PRAGMA foreign_keys = ON")
        const terminalFenceIndex = migrations.findIndex(
          (migration) => migration.id === activityPermissionTerminalFenceMigration.id,
        )
        expect(terminalFenceIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, terminalFenceIndex))
        yield* DatabaseMigration.applyOnly(db, [activityPermissionRouteFeedbackMigration])
        yield* seed(db)
        yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-upgrade-terminal",
          requestKind: "tool",
          idempotencyKey: "permission-upgrade-terminal-key",
          permission: "bash",
          patterns: ["bun test"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-upgrade", callID: "call-upgrade" },
          ownerID: "runtime-before-upgrade",
        }).pipe(Effect.provideService(Database.Service, { db }))
        yield* db.run(
          "UPDATE session_legacy_activity SET state = 'interrupted', terminal_reason = 'upgrade-stop', settled_at = 20 WHERE activity_id = 'activity-1'",
        )
        expect(
          yield* db.get(
            "SELECT state FROM session_activity_permission_request WHERE request_id = 'permission-upgrade-terminal'",
          ),
        ).toEqual({ state: "pending" })

        yield* DatabaseMigration.applyOnly(db, [activityPermissionTerminalFenceMigration])

        expect(
          yield* db.get(
            "SELECT request.state, decision.decision, decision.actor_id FROM session_activity_permission_request request JOIN session_activity_permission_decision decision ON decision.request_id = request.request_id WHERE request.request_id = 'permission-upgrade-terminal'",
          ),
        ).toEqual({ state: "interrupted", decision: "interrupted", actor_id: "activity-authority" })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })

  test("settles a disabled objective and atomically interrupts pending tool permission", async () => {
    await run(
      Effect.gen(function* () {
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-terminal-pending",
          requestKind: "tool",
          idempotencyKey: "permission-terminal-pending-key",
          permission: "bash",
          patterns: ["bun test"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-terminal", callID: "call-terminal" },
          ownerID: "runtime-1",
        })
        expect(
          yield* DeepAgentActivityAuthority.settle({
            ...ref,
            expectedVersion: 1,
            state: "interrupted",
            terminalReason: "user_interrupted",
          }),
        ).toMatchObject({ version: 2, enforcementState: "disabled", state: "interrupted" })
        const { db } = yield* Database.Service
        expect(
          yield* db.get(
            "SELECT request.state, decision.decision, decision.actor_id FROM session_activity_permission_request request JOIN session_activity_permission_decision decision ON decision.request_id = request.request_id WHERE request.request_id = 'permission-terminal-pending'",
          ),
        ).toEqual({ state: "interrupted", decision: "interrupted", actor_id: "activity-authority" })
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.decidePermission({
              requestID: request.requestID,
              idempotencyKey: "permission-terminal-late-approval",
              decision: "approved_once",
              actorType: "user",
              actorID: "user-1",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("preserves V2 disabled terminal reasons and exact retries for every terminal state", async () => {
    for (const [state, baseState] of [
      ["completed", "settled"],
      ["interrupted", "interrupted"],
      ["recovery_required", "failed"],
    ] as const) {
      await run(
        Effect.gen(function* () {
          const activityID = "v2-disabled-" + state
          const inputID = "v2-disabled-input-" + state
          const v2Ref = { activityKind: "v2" as const, activityID }
          const terminalReason = "terminal-reason-" + state
          const { db } = yield* Database.Service
          yield* db.run(
            `INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created) VALUES ('${inputID}', 'session-1', '{}', 'queue', 1, 1, 30)`,
          )
          yield* db.run(
            `INSERT INTO session_activity (activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at, settled_at) VALUES ('${activityID}', 'session-1', 0, '${inputID}', 'queue', 'active', 30, NULL)`,
          )
          yield* DeepAgentActivityAuthority.requestPermission({
            ...v2Ref,
            requestID: "permission-v2-terminal-" + state,
            requestKind: "tool",
            idempotencyKey: "permission-v2-terminal-key-" + state,
            permission: "bash",
            patterns: ["bun test"],
            alwaysPatterns: [],
            metadata: {},
            tool: { messageID: "assistant-v2-" + state, callID: "call-v2-" + state },
            ownerID: "runtime-1",
          })

          const settled = yield* DeepAgentActivityAuthority.settle({
            ...v2Ref,
            expectedVersion: 1,
            state,
            terminalReason,
          })
          expect(settled).toMatchObject({ version: 2, state, terminalReason })
          expect(
            yield* DeepAgentActivityAuthority.settle({
              ...v2Ref,
              expectedVersion: 1,
              state,
              terminalReason,
            }),
          ).toEqual(settled)
          expect(yield* db.get(`SELECT state FROM session_activity WHERE activity_id = '${activityID}'`)).toEqual({
            state: baseState,
          })
          expect(
            yield* db.get(
              `SELECT request.state, decision.decision FROM session_activity_permission_request request JOIN session_activity_permission_decision decision ON decision.request_id = request.request_id WHERE request.request_id = 'permission-v2-terminal-${state}'`,
            ),
          ).toEqual({ state: "interrupted", decision: "interrupted" })
        }),
      )
    }
  })

  test("does not consume an approved-once tool permission after activity settlement", async () => {
    await run(
      Effect.gen(function* () {
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-terminal-approved",
          requestKind: "tool",
          idempotencyKey: "permission-terminal-approved-key",
          permission: "bash",
          patterns: ["bun test"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-approved", callID: "call-approved" },
          ownerID: "runtime-1",
        })
        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: request.requestID,
          idempotencyKey: "permission-terminal-approved-decision",
          decision: "approved_once",
          actorType: "user",
          actorID: "user-1",
        })
        yield* DeepAgentActivityAuthority.settle({
          ...ref,
          expectedVersion: 1,
          state: "completed",
          terminalReason: "activity_complete",
        })
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.consumeOnce({
              requestID: request.requestID,
              consumerID: "tool:assistant-approved:call-approved",
              idempotencyKey: "permission-terminal-approved-consumption",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("settle and approve-once race converges without a terminal pending request or consumption", async () => {
    await run(
      Effect.gen(function* () {
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-settle-race",
          requestKind: "tool",
          idempotencyKey: "permission-settle-race-key",
          permission: "bash",
          patterns: ["bun test"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-race", callID: "call-race" },
          ownerID: "runtime-1",
        })
        const [settled, approved] = yield* Effect.all(
          [
            DeepAgentActivityAuthority.settle({
              ...ref,
              expectedVersion: 1,
              state: "interrupted",
              terminalReason: "settle_race",
            }).pipe(Effect.exit),
            DeepAgentActivityAuthority.decidePermission({
              requestID: request.requestID,
              idempotencyKey: "permission-settle-race-decision",
              decision: "approved_once",
              actorType: "user",
              actorID: "user-1",
            }).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        )
        expect(Exit.isSuccess(settled)).toBe(true)
        const { db } = yield* Database.Service
        const durable = yield* db.get<{ state: string; decision: string }>(
          "SELECT request.state, decision.decision FROM session_activity_permission_request request JOIN session_activity_permission_decision decision ON decision.request_id = request.request_id WHERE request.request_id = 'permission-settle-race'",
        )
        if (!durable) return yield* Effect.die(new Error("permission race did not produce a durable decision"))
        expect(durable.state).toBe(durable.decision)
        expect(["approved_once", "interrupted"]).toContain(durable.decision)
        expect(
          yield* db.get(
            "SELECT count(*) AS count FROM session_activity_permission_request WHERE activity_kind = 'legacy' AND activity_id = 'activity-1' AND state = 'pending'",
          ),
        ).toEqual({ count: 0 })
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.consumeOnce({
              requestID: request.requestID,
              consumerID: "tool:assistant-race:call-race",
              idempotencyKey: "permission-settle-race-consumption",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.get(
            "SELECT count(*) AS count FROM session_activity_permission_once_consumption WHERE request_id = 'permission-settle-race'",
          ),
        ).toEqual({ count: 0 })
        if (durable.decision === "approved_once") expect(Exit.isSuccess(approved)).toBe(true)
        if (durable.decision === "interrupted") expect(Exit.isFailure(approved)).toBe(true)
      }),
    )
  })

  test("configures objective criteria with exact retry and CAS semantics", async () => {
    await run(
      Effect.gen(function* () {
        const configured = yield* configure()
        expect(configured).toMatchObject({
          version: 2,
          objectiveText: "Finish the durable activity",
          completionCriteria: [{ kind: "plan_complete" }],
          enforcementState: "monitoring",
          stallThreshold: 2,
        })
        expect(configured.objectiveFingerprint).toHaveLength(64)
        expect((yield* configure()).version).toBe(2)
        const conflict = yield* DeepAgentActivityAuthority.configure({
          ...ref,
          expectedVersion: 1,
          objectiveText: "Different objective",
          completionCriteria: [{ kind: "plan_complete" }],
          enforcementState: "monitoring",
          stallThreshold: 2,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(conflict)).toBe(true)
        const { db } = yield* Database.Service
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "UPDATE session_activity_objective SET version = version + 1, objective_fingerprint = 'tampered', objective_text = 'tampered', updated_at = updated_at + 1 WHERE activity_kind = 'legacy' AND activity_id = 'activity-1'",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("settles the base activity and objective in one transaction", async () => {
    await run(
      Effect.gen(function* () {
        const configured = yield* configure()
        const { db } = yield* Database.Service
        expect(
          yield* db.get(
            "SELECT count(*) AS count FROM session_activity_permission_effect_dispatch WHERE activity_kind = 'legacy' AND activity_id = 'activity-1' AND state IN ('started', 'unknown')",
          ),
        ).toEqual({ count: 0 })
        const settled = yield* DeepAgentActivityAuthority.settle({
          ...ref,
          expectedVersion: configured.version,
          state: "completed",
          terminalReason: "objective_complete",
        })
        expect(settled).toMatchObject({
          version: configured.version + 1,
          state: "completed",
          terminalReason: "objective_complete",
        })
        expect(
          yield* DeepAgentActivityAuthority.settle({
            ...ref,
            expectedVersion: configured.version,
            state: "completed",
            terminalReason: "objective_complete",
          }),
        ).toEqual(settled)
        expect(
          yield* db.get(
            "SELECT state, terminal_reason, settled_at FROM session_legacy_activity WHERE activity_id = 'activity-1'",
          ),
        ).toMatchObject({ state: "settled", terminal_reason: "objective_complete", settled_at: settled.settledAt })
      }),
    )
  })

  test("persists the full progress vector and stops only when every dimension is unchanged", async () => {
    await run(
      Effect.gen(function* () {
        const configured = yield* configure()
        const first = yield* observe(configured.version, false)
        expect(first.objective).toMatchObject({ version: 3, state: "active", noProgressCount: 0 })
        expect(first.observation).toMatchObject({ revision: 0, changed: true, noProgressCount: 0 })
        const exactRetry = yield* observe(configured.version, false)
        expect(exactRetry.objective.version).toBe(3)
        expect(exactRetry.observation.revision).toBe(0)
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.observe({
              ...ref,
              idempotencyKey: "observation-" + configured.version,
              expectedVersion: configured.version,
              workspaceRevision: "workspace-1",
              planVersion: 1,
              validationFingerprint: "validation-fail",
              evidence: [{ fingerprint: "evidence-1", kind: "read", sourceReceiptID: "read-1" }],
              effectReceipts: [{ receiptID: "effect-1", fingerprint: "effect-fingerprint-1" }],
              nextAction: "conflicting retry",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        const unchanged = yield* observe(first.objective.version, false, "same action, different wording")
        expect(unchanged.objective).toMatchObject({ version: 4, state: "active", noProgressCount: 1 })

        const changed = yield* observe(unchanged.objective.version, true)
        expect(changed.objective).toMatchObject({ version: 5, state: "active", noProgressCount: 0 })
        const repeated = yield* observe(changed.objective.version, true)
        expect(repeated.objective).toMatchObject({ version: 6, state: "active", noProgressCount: 1 })
        const stalled = yield* observe(repeated.objective.version, true)
        expect(stalled.objective).toMatchObject({
          version: 7,
          state: "needs_human",
          noProgressCount: 2,
          terminalReason: "no_progress",
        })

        const reconstructed = yield* DeepAgentActivityAuthority.reconstruct(ref)
        expect(reconstructed.latestObservation).toMatchObject({ revision: 4, changed: false, noProgressCount: 2 })
        expect(reconstructed.evidence.map((item) => item.fingerprint)).toEqual(["evidence-1", "evidence-2"])
        expect(reconstructed.effectReceipts).toEqual([{ receiptID: "effect-1", fingerprint: "effect-fingerprint-1" }])
      }),
    )
  })

  test("approve-once resumes the same activity and can be consumed only once", async () => {
    await run(
      Effect.gen(function* () {
        yield* stall()
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-once",
          requestKind: "no_progress",
          idempotencyKey: "permission-once-key",
          permission: "doom_loop",
          patterns: ["read"],
          alwaysPatterns: ["read"],
          metadata: { count: 2 },
          ownerID: "runtime-1",
        })
        expect(
          yield* DeepAgentActivityAuthority.requestPermission({
            ...ref,
            requestID: "permission-once",
            requestKind: "no_progress",
            idempotencyKey: "permission-once-key",
            permission: "doom_loop",
            patterns: ["read"],
            alwaysPatterns: ["read"],
            metadata: { count: 2 },
            ownerID: "runtime-1",
          }),
        ).toEqual(request)
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.requestPermission({
              ...ref,
              requestID: "permission-once",
              requestKind: "no_progress",
              idempotencyKey: "permission-once-key",
              permission: "doom_loop",
              patterns: ["read"],
              alwaysPatterns: ["read"],
              metadata: { count: 2 },
              ownerID: "runtime-conflict",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.requestPermission({
              ...ref,
              requestID: "permission-once-sibling",
              requestKind: "no_progress",
              idempotencyKey: "permission-once-sibling-key",
              permission: "doom_loop",
              patterns: ["write"],
              alwaysPatterns: [],
              metadata: { count: 2 },
              ownerID: "runtime-1",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        const decision = yield* DeepAgentActivityAuthority.decidePermission({
          requestID: request.requestID,
          idempotencyKey: "decision-once-key",
          decision: "approved_once",
          actorType: "user",
          actorID: "user-1",
        })
        expect(
          yield* DeepAgentActivityAuthority.decidePermission({
            requestID: request.requestID,
            idempotencyKey: "decision-once-key",
            decision: "approved_once",
            actorType: "user",
            actorID: "user-1",
          }),
        ).toEqual(decision)
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.decidePermission({
              requestID: request.requestID,
              idempotencyKey: "decision-once-key",
              decision: "approved_once",
              actorType: "user",
              actorID: "user-conflict",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(request.requestedScope).toBe("project")
        expect(decision).toMatchObject({ decision: "approved_once", scope: "once", authorityEpoch: 0 })
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective).toMatchObject({
          state: "active",
          noProgressCount: 0,
        })

        const consumed = yield* DeepAgentActivityAuthority.consumeOnce({
          requestID: request.requestID,
          consumerID: "tool-call-1",
          idempotencyKey: "consume-once-key",
        })
        expect(
          yield* DeepAgentActivityAuthority.consumeOnce({
            requestID: request.requestID,
            consumerID: "tool-call-1",
            idempotencyKey: "consume-once-key",
          }),
        ).toEqual(consumed)
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.consumeOnce({
              requestID: request.requestID,
              consumerID: "tool-call-2",
              idempotencyKey: "consume-other-key",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("always approval atomically updates PermissionSaved", async () => {
    await run(
      Effect.gen(function* () {
        yield* stall()
        const first = yield* permissionRequest("1", "read")
        expect(first.authorityEpoch).toBe(0)

        const decision = yield* DeepAgentActivityAuthority.decidePermission({
          requestID: first.requestID,
          idempotencyKey: "decision-always-key-1",
          decision: "approved_always",
          actorType: "user",
          actorID: "user-1",
        })
        expect(decision).toMatchObject({ decision: "approved_always", scope: "project", authorityEpoch: 1 })
        expect(
          yield* DeepAgentActivityAuthority.decidePermission({
            requestID: first.requestID,
            idempotencyKey: "decision-always-key-1",
            decision: "approved_always",
            actorType: "user",
            actorID: "user-1",
          }),
        ).toEqual(decision)

        const { db } = yield* Database.Service
        expect(
          yield* db.get(
            "SELECT action, resource FROM permission WHERE project_id = 'project-1' AND action = 'doom_loop'",
          ),
        ).toEqual({ action: "doom_loop", resource: "read" })
        expect(yield* db.get("SELECT epoch FROM permission_saved_epoch WHERE project_id = 'project-1'")).toEqual({
          epoch: 1,
        })

        const resumed = (yield* DeepAgentActivityAuthority.reconstruct(ref)).objective
        const repeated = yield* noEvidence(resumed.version)
        yield* noEvidence(repeated.objective.version)
        const second = yield* permissionRequest("2", "write")
        yield* Effect.gen(function* () {
          const saved = yield* PermissionSaved.Service
          yield* saved.add({
            projectID: ProjectV2.ID.make("project-1"),
            action: "bash",
            resources: ["bun test"],
          })
        }).pipe(Effect.provide(PermissionSaved.layer))
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.decidePermission({
              requestID: second.requestID,
              idempotencyKey: "decision-always-key-2",
              decision: "approved_always",
              actorType: "user",
              actorID: "user-1",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.get(
            "SELECT state FROM session_activity_permission_request WHERE request_id = 'permission-always-2'",
          ),
        ).toEqual({ state: "pending" })
      }),
    )
  })

  test("always fanout approves matching siblings without consuming before their effects start", async () => {
    await run(
      Effect.gen(function* () {
        const first = yield* toolPermissionRequest("fanout-always-first", "bash", ["ls"], ["ls *"])
        const matching = yield* toolPermissionRequest("fanout-always-matching", "bash", ["ls -la"], [])
        const unmatched = yield* toolPermissionRequest("fanout-always-unmatched", "bash", ["pwd"], [])
        const otherPermission = yield* toolPermissionRequest("fanout-always-other-permission", "edit", ["ls -la"], [])
        const decision = yield* DeepAgentActivityAuthority.decidePermissionWithFanout({
          requestID: first.requestID,
          idempotencyKey: `permission-decision:${first.requestID}:approved_always:fanout:always`,
          decision: "approved_always",
          sessionFanout: "always",
          actorType: "user",
          actorID: "permission-ui",
        })
        expect(
          yield* DeepAgentActivityAuthority.decidePermissionWithFanout({
            requestID: first.requestID,
            idempotencyKey: `permission-decision:${first.requestID}:approved_always:fanout:always`,
            decision: "approved_always",
            sessionFanout: "always",
            actorType: "user",
            actorID: "permission-ui",
          }),
        ).toEqual(decision)

        const { db } = yield* Database.Service
        expect(
          yield* db.all<{ request_id: string; state: string }>(
            "SELECT request_id, state FROM session_activity_permission_request WHERE request_id LIKE 'permission-tool-fanout-always-%' ORDER BY request_id",
          ),
        ).toEqual([
          { request_id: first.requestID, state: "approved_always" },
          { request_id: matching.requestID, state: "approved_once" },
          { request_id: otherPermission.requestID, state: "pending" },
          { request_id: unmatched.requestID, state: "pending" },
        ])
        expect(
          yield* db.all<{ request_id: string; decision: string; authority_epoch: number }>(
            "SELECT request_id, decision, authority_epoch FROM session_activity_permission_decision WHERE request_id LIKE 'permission-tool-fanout-always-%' ORDER BY request_id",
          ),
        ).toEqual([
          { request_id: first.requestID, decision: "approved_always", authority_epoch: 1 },
          { request_id: matching.requestID, decision: "approved_once", authority_epoch: 0 },
        ])
        expect(
          yield* db.get(
            `SELECT request_id, consumer_id FROM session_activity_permission_once_consumption WHERE request_id = '${matching.requestID}'`,
          ),
        ).toBeUndefined()
        const late = yield* toolPermissionRequest("fanout-always-late", "bash", ["ls later"], ["ls later"])
        yield* DeepAgentActivityAuthority.decidePermissionWithFanout({
          requestID: first.requestID,
          idempotencyKey: `permission-decision:${first.requestID}:approved_always:fanout:always`,
          decision: "approved_always",
          sessionFanout: "always",
          actorType: "user",
          actorID: "permission-ui",
        })
        expect(
          yield* db.get(`SELECT state FROM session_activity_permission_request WHERE request_id = '${late.requestID}'`),
        ).toEqual({ state: "pending" })
      }),
    )
  })

  test("reject fanout atomically denies every pending sibling on the same route", async () => {
    await run(
      Effect.gen(function* () {
        const first = yield* toolPermissionRequest("fanout-reject-first", "bash", ["rm -rf build"], [])
        const sibling = yield* toolPermissionRequest("fanout-reject-sibling", "edit", ["src/index.ts"], [])
        yield* DeepAgentActivityAuthority.decidePermissionWithFanout({
          requestID: first.requestID,
          idempotencyKey: `permission-decision:${first.requestID}:denied:fanout:reject`,
          decision: "denied",
          sessionFanout: "reject",
          actorType: "user",
          actorID: "permission-ui",
          feedback: "stop this session",
        })

        const { db } = yield* Database.Service
        expect(
          yield* db.all<{ request_id: string; state: string }>(
            "SELECT request_id, state FROM session_activity_permission_request WHERE request_id LIKE 'permission-tool-fanout-reject-%' ORDER BY request_id",
          ),
        ).toEqual([
          { request_id: first.requestID, state: "denied" },
          { request_id: sibling.requestID, state: "denied" },
        ])
        expect(
          yield* db.all<{ request_id: string; decision: string; feedback: string | null }>(
            "SELECT request_id, decision, feedback FROM session_activity_permission_decision WHERE request_id LIKE 'permission-tool-fanout-reject-%' ORDER BY request_id",
          ),
        ).toEqual([
          { request_id: first.requestID, decision: "denied", feedback: "stop this session" },
          { request_id: sibling.requestID, decision: "denied", feedback: null },
        ])
        const late = yield* toolPermissionRequest("fanout-reject-late", "bash", ["pwd"], [])
        yield* DeepAgentActivityAuthority.decidePermissionWithFanout({
          requestID: first.requestID,
          idempotencyKey: `permission-decision:${first.requestID}:denied:fanout:reject`,
          decision: "denied",
          sessionFanout: "reject",
          actorType: "user",
          actorID: "permission-ui",
          feedback: "stop this session",
        })
        expect(
          yield* db.get(`SELECT state FROM session_activity_permission_request WHERE request_id = '${late.requestID}'`),
        ).toEqual({ state: "pending" })
      }),
    )
  })

  test("binds permission admission to the canonical session workspace", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("UPDATE session SET workspace_id = 'workspace-1' WHERE id = 'session-1'")
        expect(
          Exit.isFailure(
            yield* toolPermissionRequest("workspace-mismatch", "bash", ["ls"], [], "workspace-2").pipe(Effect.exit),
          ),
        ).toBe(true)
        const request = yield* toolPermissionRequest("workspace-exact", "bash", ["ls"], [], "workspace-1")
        expect(request.workspaceID).toBe("workspace-1")
        expect(
          Exit.isFailure(
            yield* db.run("UPDATE session SET workspace_id = 'workspace-2' WHERE id = 'session-1'").pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                `
                INSERT INTO session_activity_permission_request (
                  request_id, activity_kind, activity_id, session_id, project_id, workspace_id, request_kind,
                  idempotency_key, permission, patterns, always_patterns, metadata_hash, tool_message_id,
                  tool_call_id, state, authority_epoch, requested_scope, owner_type, owner_id, created_at,
                  expires_at, decided_at
                ) VALUES (
                  'permission-workspace-direct', 'legacy', 'activity-1', 'session-1', 'project-1',
                  'workspace-2', 'tool', 'permission-workspace-direct-key', 'bash', '["ls"]', '[]',
                  'metadata', 'assistant-direct', 'call-direct', 'pending', 0, 'once', 'runtime',
                  'runtime-1', 1, NULL, NULL
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("reject fanout expires stale siblings and interrupts a pending no-progress activity", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-tool-fanout-reject-sibling",
          requestKind: "tool",
          idempotencyKey: "permission-tool-key-fanout-reject-sibling",
          permission: "edit",
          patterns: ["src/index.ts"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-sibling", callID: "call-sibling" },
          ownerID: "runtime-1",
        })
        const expiring = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-tool-fanout-reject-expired",
          requestKind: "tool",
          idempotencyKey: "permission-tool-key-fanout-reject-expired",
          permission: "edit",
          patterns: ["src/index.ts"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-expired", callID: "call-expired" },
          ownerID: "runtime-1",
          expiresAt: Date.now() + 20,
        })
        const configured = yield* configure()
        const firstObservation = yield* noEvidence(configured.version)
        const secondObservation = yield* noEvidence(firstObservation.objective.version)
        yield* noEvidence(secondObservation.objective.version)
        const challenge = yield* permissionRequest("fanout-reject-no-progress", "read")
        yield* Effect.sleep("30 millis")
        yield* DeepAgentActivityAuthority.decidePermissionWithFanout({
          requestID: challenge.requestID,
          idempotencyKey: `permission-decision:${challenge.requestID}:interrupted:fanout:reject`,
          decision: "interrupted",
          sessionFanout: "reject",
          actorType: "user",
          actorID: "permission-ui",
        })

        expect(
          yield* db.get(
            `SELECT state FROM session_activity_permission_request WHERE request_id = '${expiring.requestID}'`,
          ),
        ).toEqual({ state: "expired" })
        expect(
          yield* db.get(
            `SELECT state FROM session_activity_permission_request WHERE request_id = '${challenge.requestID}'`,
          ),
        ).toEqual({ state: "interrupted" })
        expect(
          yield* db.get(
            "SELECT decision, actor_id FROM session_activity_permission_decision WHERE request_id = 'permission-tool-fanout-reject-sibling'",
          ),
        ).toEqual({ decision: "interrupted", actor_id: "activity-authority" })
        expect(yield* db.get("SELECT state FROM session_legacy_activity WHERE activity_id = 'activity-1'")).toEqual({
          state: "interrupted",
        })
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective).toMatchObject({
          state: "interrupted",
          terminalReason: "permission_interrupted",
        })
      }),
    )
  })

  test("restart reconstruction settles pending asks with an interrupted decision receipt", async () => {
    await run(
      Effect.gen(function* () {
        yield* configure()
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.requestPermission({
              ...ref,
              requestID: "permission-tool-without-call",
              requestKind: "tool",
              idempotencyKey: "permission-tool-without-call-key",
              permission: "bash",
              patterns: ["bun test"],
              alwaysPatterns: ["bun test"],
              metadata: {},
              ownerID: "runtime-before-restart",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-restart",
          requestKind: "tool",
          idempotencyKey: "permission-restart-key",
          permission: "bash",
          patterns: ["bun test"],
          alwaysPatterns: ["bun test"],
          metadata: {},
          tool: { messageID: "assistant-1", callID: "call-1" },
          ownerID: "runtime-before-restart",
        })
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).pendingPermissionRequestIDs).toEqual([
          "permission-restart",
        ])
        expect(yield* DeepAgentActivityAuthority.recoverPendingPermissions("runtime-before-restart")).toBe(0)
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective.state).toBe("active")
        expect(yield* DeepAgentActivityAuthority.recoverPendingPermissions("runtime-after-restart")).toBe(1)
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).pendingPermissionRequestIDs).toEqual([])
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective).toMatchObject({
          state: "recovery_required",
          terminalReason: "pending_permission_recovery_required",
        })

        const { db } = yield* Database.Service
        expect(
          yield* db.get("SELECT state, terminal_reason FROM session_legacy_activity WHERE activity_id = 'activity-1'"),
        ).toEqual({ state: "recovery_required", terminal_reason: "pending_permission_recovery_required" })
        expect(
          yield* db.get(
            "SELECT request.state, decision.decision, decision.actor_type, decision.actor_id FROM session_activity_permission_request request JOIN session_activity_permission_decision decision ON decision.request_id = request.request_id WHERE request.request_id = 'permission-restart'",
          ),
        ).toEqual({
          state: "interrupted",
          decision: "interrupted",
          actor_type: "system",
          actor_id: "runtime-after-restart",
        })
      }),
    )
  })

  test("does not recover a healthy permission owner before its lease expires", async () => {
    await run(
      Effect.gen(function* () {
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: "runtime-live", leaseMs: 10 })
        yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-live-owner",
          requestKind: "tool",
          idempotencyKey: "permission-live-owner-key",
          permission: "bash",
          patterns: ["bun test"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-live", callID: "call-live" },
          ownerID: "runtime-live",
        })
        expect(yield* DeepAgentActivityAuthority.recoverPendingPermissions("runtime-other")).toBe(0)
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).pendingPermissionRequestIDs).toEqual([
          "permission-live-owner",
        ])

        yield* Effect.sleep("20 millis")
        expect(yield* DeepAgentActivityAuthority.recoverPendingPermissions("runtime-other")).toBe(1)
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective.state).toBe("recovery_required")
      }),
    )
  })

  test("atomically consumes approved-once permission when the external effect starts and replays only terminal data", async () => {
    await run(
      Effect.gen(function* () {
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: "runtime-effect", leaseMs: 1_000 })
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-effect-once",
          requestKind: "tool",
          idempotencyKey: "permission-effect-once-request",
          permission: "bash",
          patterns: ["touch output"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-effect", callID: "call-effect" },
          ownerID: "runtime-effect",
        })
        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: request.requestID,
          idempotencyKey: "permission-effect-once-decision",
          decision: "approved_once",
          actorType: "user",
          actorID: "user-1",
        })
        const started = yield* DeepAgentActivityAuthority.beginPermissionEffect({
          requestID: request.requestID,
          toolName: "bash",
          consumerID: "tool:assistant-effect:call-effect",
          idempotencyKey: "permission-effect:permission-effect-once",
          ownerID: "runtime-effect",
        })
        expect(started).toMatchObject({ state: "started", version: 1, toolName: "bash" })
        const { db } = yield* Database.Service
        expect(
          yield* db.get(
            "SELECT consumption.consumer_id, dispatch.state FROM session_activity_permission_once_consumption consumption JOIN session_activity_permission_effect_dispatch dispatch ON dispatch.request_id = consumption.request_id WHERE consumption.request_id = 'permission-effect-once'",
          ),
        ).toEqual({ consumer_id: "tool:assistant-effect:call-effect", state: "started" })
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.beginPermissionEffect({
              requestID: request.requestID,
              toolName: "bash",
              consumerID: "tool:assistant-effect:call-effect",
              idempotencyKey: "permission-effect:permission-effect-once",
              ownerID: "runtime-effect",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)

        const settled = yield* DeepAgentActivityAuthority.settlePermissionEffect({
          receiptID: started.receiptID,
          expectedVersion: started.version,
          ownerID: "runtime-effect",
          outcome: "success",
          result: { output: "done" },
        })
        expect(settled).toMatchObject({ state: "settled", version: 2, outcome: "success", result: { output: "done" } })
        expect(
          yield* DeepAgentActivityAuthority.beginPermissionEffect({
            requestID: request.requestID,
            toolName: "bash",
            consumerID: "tool:assistant-effect:call-effect",
            idempotencyKey: "permission-effect:permission-effect-once",
            ownerID: "runtime-after-restart",
          }),
        ).toEqual(settled)
        const backdatedRequest = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-effect-backdated",
          requestKind: "tool",
          idempotencyKey: "permission-effect-backdated-request",
          permission: "bash",
          patterns: ["touch old-output"],
          alwaysPatterns: ["touch old-output"],
          metadata: {},
          tool: { messageID: "assistant-backdated", callID: "call-backdated" },
          ownerID: "runtime-effect",
        })
        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: backdatedRequest.requestID,
          idempotencyKey: "permission-effect-backdated-decision",
          decision: "approved_always",
          actorType: "user",
          actorID: "user-1",
        })
        expect(
          Exit.isFailure(
            yield* db
              .run(
                `INSERT INTO session_activity_permission_effect_dispatch (
                   receipt_id, request_id, activity_kind, activity_id, session_id, project_id, workspace_id,
                   tool_message_id, tool_call_id, tool_name, consumer_id, idempotency_key, owner_id,
                   state, version, outcome, result_json, result_hash, started_at, settled_at
                 ) VALUES (
                   'permission-effect:permission-effect-backdated', 'permission-effect-backdated',
                   'legacy', 'activity-1', 'session-1', 'project-1', NULL,
                   'assistant-backdated', 'call-backdated', 'bash', 'tool:assistant-backdated:call-backdated',
                   'permission-effect:permission-effect-backdated', 'runtime-effect',
                   'started', 1, NULL, NULL, NULL,
                   CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) - 2000, NULL
                 )`,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                `DELETE FROM session_activity_permission_effect_dispatch
                 WHERE receipt_id = '${settled.receiptID}'`,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run("DELETE FROM session WHERE id = 'session-1'")
        expect(
          yield* db.get(
            `SELECT receipt_id FROM session_activity_permission_effect_dispatch
             WHERE receipt_id = '${settled.receiptID}'`,
          ),
        ).toBeUndefined()
      }),
    )
  })

  test("recovers an abandoned started permission effect as unknown and terminal recovery-required", async () => {
    await run(
      Effect.gen(function* () {
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
          ownerID: "runtime-effect-before-crash",
          leaseMs: 10,
        })
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-effect-crash",
          requestKind: "tool",
          idempotencyKey: "permission-effect-crash-request",
          permission: "bash",
          patterns: ["touch output"],
          alwaysPatterns: ["touch output"],
          metadata: {},
          tool: { messageID: "assistant-crash", callID: "call-crash" },
          ownerID: "runtime-effect-before-crash",
        })
        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: request.requestID,
          idempotencyKey: "permission-effect-crash-decision",
          decision: "approved_always",
          actorType: "user",
          actorID: "user-1",
        })
        yield* DeepAgentActivityAuthority.beginPermissionEffect({
          requestID: request.requestID,
          toolName: "bash",
          consumerID: "tool:assistant-crash:call-crash",
          idempotencyKey: "permission-effect:permission-effect-crash",
          ownerID: "runtime-effect-before-crash",
        })
        const { db } = yield* Database.Service
        expect(
          Exit.isFailure(
            yield* db
              .run(
                `UPDATE session_activity_objective
                 SET state = 'recovery_required', terminal_reason = 'direct recovery',
                   version = version + 1, settled_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
                 WHERE activity_kind = 'legacy' AND activity_id = 'activity-1'`,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* DeepAgentActivityAuthority.recoverPermissionEffects("runtime-effect-before-crash")).toBe(0)
        yield* Effect.sleep("20 millis")
        const [started] = yield* DeepAgentActivityAuthority.permissionEffectsForToolCall({
          sessionID: "session-1",
          toolMessageID: "assistant-crash",
          toolCallID: "call-crash",
          toolName: "bash",
        })
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.settlePermissionEffect({
              receiptID: started!.receiptID,
              expectedVersion: started!.version,
              ownerID: "runtime-effect-before-crash",
              outcome: "success",
              result: { output: "late" },
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
          ownerID: "runtime-effect-after-crash",
          leaseMs: 1_000,
        })
        expect(yield* DeepAgentActivityAuthority.recoverPermissionEffects("runtime-effect-after-crash")).toBe(1)
        expect(
          yield* DeepAgentActivityAuthority.permissionEffectsForToolCall({
            sessionID: "session-1",
            toolMessageID: "assistant-crash",
            toolCallID: "call-crash",
            toolName: "bash",
          }),
        ).toMatchObject([{ state: "unknown", version: 2 }])
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective).toMatchObject({
          state: "recovery_required",
          terminalReason: "permission_effect_outcome_unknown_after_restart",
        })
        expect(yield* db.get("SELECT state FROM session_legacy_activity WHERE activity_id = 'activity-1'")).toEqual({
          state: "recovery_required",
        })
      }),
    )
  })

  test("restart quarantines a started effect before settling a sibling pending permission", async () => {
    await run(
      Effect.gen(function* () {
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
          ownerID: "runtime-incident-before-restart",
          leaseMs: 100,
        })
        const effectRequest = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-incident-effect",
          requestKind: "tool",
          idempotencyKey: "permission-incident-effect-request",
          permission: "glob",
          patterns: ["**/*"],
          alwaysPatterns: ["**/*"],
          metadata: {},
          tool: { messageID: "assistant-incident", callID: "call-incident" },
          ownerID: "runtime-incident-before-restart",
        })
        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: effectRequest.requestID,
          idempotencyKey: "permission-incident-effect-decision",
          decision: "approved_always",
          actorType: "user",
          actorID: "user-1",
        })
        yield* DeepAgentActivityAuthority.beginPermissionEffect({
          requestID: effectRequest.requestID,
          toolName: "glob",
          consumerID: "tool:assistant-incident:call-incident",
          idempotencyKey: "permission-effect:permission-incident-effect",
          ownerID: "runtime-incident-before-restart",
        })
        const pending = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-incident-external-directory",
          requestKind: "tool",
          idempotencyKey: "permission-incident-external-directory-request",
          permission: "external_directory",
          patterns: ["/external/worktree/*"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-incident", callID: "call-incident" },
          ownerID: "runtime-incident-before-restart",
        })
        yield* Effect.sleep("120 millis")
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
          ownerID: "runtime-incident-after-restart",
          leaseMs: 1_000,
        })

        expect(yield* DeepAgentActivityAuthority.recoverPermissionEffects("runtime-incident-after-restart")).toBe(1)
        // The activity terminal fence settles the sibling pending request in the same transaction,
        // so the subsequent pending sweep is an idempotent no-op.
        expect(yield* DeepAgentActivityAuthority.recoverPendingPermissions("runtime-incident-after-restart")).toBe(0)

        const { db } = yield* Database.Service
        expect(
          yield* db.get(
            `SELECT state FROM session_activity_permission_effect_dispatch WHERE request_id = '${effectRequest.requestID}'`,
          ),
        ).toEqual({ state: "unknown" })
        expect(
          yield* db.get(
            `SELECT state FROM session_activity_permission_request WHERE request_id = '${pending.requestID}'`,
          ),
        ).toEqual({ state: "interrupted" })
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective).toMatchObject({
          state: "recovery_required",
          terminalReason: "permission_effect_outcome_unknown_after_restart",
        })
        expect(yield* db.get("SELECT state FROM session_legacy_activity WHERE activity_id = 'activity-1'")).toEqual({
          state: "recovery_required",
        })
      }),
    )
  })

  test("base activity tables cannot bypass unresolved permission effect terminal fences", async () => {
    await run(
      Effect.gen(function* () {
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: "runtime-base-fence", leaseMs: 1_000 })
        const legacyRequest = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-effect-base-legacy",
          requestKind: "tool",
          idempotencyKey: "permission-effect-base-legacy-request",
          permission: "bash",
          patterns: ["touch legacy"],
          alwaysPatterns: ["touch legacy"],
          metadata: {},
          tool: { messageID: "assistant-base-legacy", callID: "call-base-legacy" },
          ownerID: "runtime-base-fence",
        })
        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: legacyRequest.requestID,
          idempotencyKey: "permission-effect-base-legacy-decision",
          decision: "approved_always",
          actorType: "user",
          actorID: "user-1",
        })
        yield* DeepAgentActivityAuthority.beginPermissionEffect({
          requestID: legacyRequest.requestID,
          toolName: "bash",
          consumerID: "tool:assistant-base-legacy:call-base-legacy",
          idempotencyKey: "permission-effect:permission-effect-base-legacy",
          ownerID: "runtime-base-fence",
        })
        const { db } = yield* Database.Service
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "UPDATE session_legacy_activity SET state = 'settled', terminal_reason = 'bypass', settled_at = 20 WHERE activity_id = 'activity-1'",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)

        yield* db.run(
          "INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created) VALUES ('v2-base-fence-input', 'session-1', '{}', 'queue', 1, 1, 30)",
        )
        yield* db.run(
          "INSERT INTO session_activity (activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at, settled_at) VALUES ('v2-base-fence', 'session-1', 0, 'v2-base-fence-input', 'queue', 'active', 30, NULL)",
        )
        const v2Request = yield* DeepAgentActivityAuthority.requestPermission({
          activityKind: "v2",
          activityID: "v2-base-fence",
          requestID: "permission-effect-base-v2",
          requestKind: "tool",
          idempotencyKey: "permission-effect-base-v2-request",
          permission: "bash",
          patterns: ["touch v2"],
          alwaysPatterns: ["touch v2"],
          metadata: {},
          tool: { messageID: "assistant-base-v2", callID: "call-base-v2" },
          ownerID: "runtime-base-fence",
        })
        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: v2Request.requestID,
          idempotencyKey: "permission-effect-base-v2-decision",
          decision: "approved_always",
          actorType: "user",
          actorID: "user-1",
        })
        yield* DeepAgentActivityAuthority.beginPermissionEffect({
          requestID: v2Request.requestID,
          toolName: "bash",
          consumerID: "tool:assistant-base-v2:call-base-v2",
          idempotencyKey: "permission-effect:permission-effect-base-v2",
          ownerID: "runtime-base-fence",
        })
        expect(
          Exit.isFailure(
            yield* db
              .run(
                "UPDATE session_activity SET state = 'interrupted', settled_at = 31 WHERE activity_id = 'v2-base-fence'",
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("rotates a permission owner and atomically quarantines sibling effects plus pending asks", async () => {
    await run(
      Effect.gen(function* () {
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: "runtime-rotate-old", leaseMs: 60_000 })
        for (const suffix of ["a", "b"] as const) {
          const request = yield* DeepAgentActivityAuthority.requestPermission({
            ...ref,
            requestID: `permission-rotate-${suffix}`,
            requestKind: "tool",
            idempotencyKey: `permission-rotate-${suffix}-request`,
            permission: "bash",
            patterns: [`touch ${suffix}`],
            alwaysPatterns: [`touch ${suffix}`],
            metadata: {},
            tool: { messageID: `assistant-rotate-${suffix}`, callID: `call-rotate-${suffix}` },
            ownerID: "runtime-rotate-old",
          })
          yield* DeepAgentActivityAuthority.decidePermission({
            requestID: request.requestID,
            idempotencyKey: `permission-rotate-${suffix}-decision`,
            decision: "approved_always",
            actorType: "user",
            actorID: "user-1",
          })
          yield* DeepAgentActivityAuthority.beginPermissionEffect({
            requestID: request.requestID,
            toolName: "bash",
            consumerID: `tool:assistant-rotate-${suffix}:call-rotate-${suffix}`,
            idempotencyKey: `permission-effect:permission-rotate-${suffix}`,
            ownerID: "runtime-rotate-old",
          })
        }
        yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-rotate-pending",
          requestKind: "tool",
          idempotencyKey: "permission-rotate-pending-request",
          permission: "bash",
          patterns: ["pwd"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-rotate-pending", callID: "call-rotate-pending" },
          ownerID: "runtime-rotate-old",
        })

        expect(
          yield* DeepAgentActivityAuthority.rotatePermissionOwner({
            previousOwnerID: "runtime-rotate-old",
            ownerID: "runtime-rotate-new",
            leaseMs: 60_000,
          }),
        ).toMatchObject({ quarantinedEffectCount: 2, recoveredPendingCount: 1 })
        const { db } = yield* Database.Service
        expect(
          yield* db.get(
            "SELECT count(*) AS count FROM session_activity_permission_effect_dispatch WHERE owner_id = 'runtime-rotate-old' AND state = 'unknown'",
          ),
        ).toEqual({ count: 2 })
        expect(
          yield* db.get(
            "SELECT state FROM session_activity_permission_request WHERE request_id = 'permission-rotate-pending'",
          ),
        ).toEqual({ state: "interrupted" })
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective).toMatchObject({
          state: "recovery_required",
          terminalReason: "permission_effect_outcome_unknown_after_restart",
        })
        expect(
          yield* db
            .get("SELECT owner_id FROM session_activity_permission_owner_lease ORDER BY owner_id")
            .pipe(Effect.orDie),
        ).toEqual({ owner_id: "runtime-rotate-new" })
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.settlePermissionEffect({
              receiptID: "permission-effect:permission-rotate-a",
              expectedVersion: 1,
              ownerID: "runtime-rotate-old",
              outcome: "success",
              result: { output: "stale" },
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
            ownerID: "runtime-rotate-new",
            leaseMs: 60_000,
          }),
        ).toMatchObject({ owner_id: "runtime-rotate-new" })
      }),
    )
  })

  test("failed permission owner rotation leaves the old owner and effects untouched", async () => {
    await run(
      Effect.gen(function* () {
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: "runtime-rollback-old", leaseMs: 60_000 })
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-rollback",
          requestKind: "tool",
          idempotencyKey: "permission-rollback-request",
          permission: "bash",
          patterns: ["touch rollback"],
          alwaysPatterns: ["touch rollback"],
          metadata: {},
          tool: { messageID: "assistant-rollback", callID: "call-rollback" },
          ownerID: "runtime-rollback-old",
        })
        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: request.requestID,
          idempotencyKey: "permission-rollback-decision",
          decision: "approved_always",
          actorType: "user",
          actorID: "user-1",
        })
        yield* DeepAgentActivityAuthority.beginPermissionEffect({
          requestID: request.requestID,
          toolName: "bash",
          consumerID: "tool:assistant-rollback:call-rollback",
          idempotencyKey: "permission-effect:permission-rollback",
          ownerID: "runtime-rollback-old",
        })
        const { db } = yield* Database.Service
        yield* db.run(`
          CREATE TRIGGER permission_owner_rotation_injected_abort
          BEFORE UPDATE ON session_activity_permission_effect_dispatch
          WHEN OLD.owner_id = 'runtime-rollback-old' AND NEW.state = 'unknown'
          BEGIN
            SELECT RAISE(ABORT, 'injected permission owner rotation failure');
          END
        `)

        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.rotatePermissionOwner({
              previousOwnerID: "runtime-rollback-old",
              ownerID: "runtime-rollback-new",
              leaseMs: 60_000,
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.get(
            "SELECT state, owner_id FROM session_activity_permission_effect_dispatch WHERE request_id = 'permission-rollback'",
          ),
        ).toEqual({ state: "started", owner_id: "runtime-rollback-old" })
        expect(
          yield* db.get(
            "SELECT count(*) AS count FROM session_activity_permission_owner_lease WHERE owner_id = 'runtime-rollback-old'",
          ),
        ).toEqual({ count: 1 })
        expect(
          yield* db.get(
            "SELECT count(*) AS count FROM session_activity_permission_owner_lease WHERE owner_id = 'runtime-rollback-new'",
          ),
        ).toEqual({ count: 0 })
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective.state).toBe("active")
      }),
    )
  })

  test("activity terminal settlement races permission effect start without leaving a replayable started effect", async () => {
    await run(
      Effect.gen(function* () {
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: "runtime-effect-race", leaseMs: 1_000 })
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-effect-race",
          requestKind: "tool",
          idempotencyKey: "permission-effect-race-request",
          permission: "bash",
          patterns: ["touch output"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-effect-race", callID: "call-effect-race" },
          ownerID: "runtime-effect-race",
        })
        yield* DeepAgentActivityAuthority.decidePermission({
          requestID: request.requestID,
          idempotencyKey: "permission-effect-race-decision",
          decision: "approved_once",
          actorType: "user",
          actorID: "user-1",
        })
        const [started, terminal] = yield* Effect.all(
          [
            DeepAgentActivityAuthority.beginPermissionEffect({
              requestID: request.requestID,
              toolName: "bash",
              consumerID: "tool:assistant-effect-race:call-effect-race",
              idempotencyKey: "permission-effect:permission-effect-race",
              ownerID: "runtime-effect-race",
            }).pipe(Effect.exit),
            DeepAgentActivityAuthority.settle({
              ...ref,
              expectedVersion: 1,
              state: "completed",
              terminalReason: "effect_start_race",
            }).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        )
        expect(Number(Exit.isSuccess(started)) + Number(Exit.isSuccess(terminal))).toBe(1)
        const { db } = yield* Database.Service
        const activity = yield* db.get<{ state: string }>(
          "SELECT state FROM session_activity_objective WHERE activity_kind = 'legacy' AND activity_id = 'activity-1'",
        )
        const dispatch = yield* db.get<{ state: string }>(
          "SELECT state FROM session_activity_permission_effect_dispatch WHERE request_id = 'permission-effect-race'",
        )
        expect(activity?.state === "completed" ? dispatch === undefined : dispatch?.state === "started").toBe(true)
      }),
    )
  })

  test("uses database time and rejects forged or unbounded permission owner leases", async () => {
    await run(
      Effect.gen(function* () {
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
              ownerID: "runtime-unbounded",
              leaseMs: 31_536_000_001,
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        const { db } = yield* Database.Service
        const future = Date.now() + 60_000
        expect(
          Exit.isFailure(
            yield* db
              .run(
                `INSERT INTO session_activity_permission_owner_lease (owner_id, heartbeat_at, lease_expires_at) VALUES ('runtime-future', ${future}, ${future + 1000})`,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: "runtime-expiring", leaseMs: 5 })
        yield* Effect.sleep("15 millis")
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
              ownerID: "runtime-expiring",
              leaseMs: 60_000,
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("releasing one permission scope does not expose another scope to recovery", async () => {
    await run(
      Effect.gen(function* () {
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: "runtime-scope-a", leaseMs: 60_000 })
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: "runtime-scope-b", leaseMs: 60_000 })
        yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-scope-b",
          requestKind: "tool",
          idempotencyKey: "permission-scope-b-key",
          permission: "bash",
          patterns: ["bun test"],
          alwaysPatterns: [],
          metadata: {},
          tool: { messageID: "assistant-scope-b", callID: "call-scope-b" },
          ownerID: "runtime-scope-b",
        })

        yield* DeepAgentActivityAuthority.releasePermissionOwner("runtime-scope-a")

        expect(yield* DeepAgentActivityAuthority.recoverPendingPermissions("runtime-scope-c")).toBe(0)
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).pendingPermissionRequestIDs).toEqual([
          "permission-scope-b",
        ])
      }),
    )
  })

  test("deny remains needs-human and restart interrupts a pending no-progress challenge", async () => {
    await run(
      Effect.gen(function* () {
        yield* stall()
        const denied = yield* permissionRequest("deny", "read", [])
        expect(
          yield* DeepAgentActivityAuthority.decidePermission({
            requestID: denied.requestID,
            idempotencyKey: "decision-deny-key",
            decision: "denied",
            actorType: "user",
            actorID: "user-1",
          }),
        ).toMatchObject({ decision: "denied", scope: "once" })
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective.state).toBe("needs_human")
      }),
    )

    await run(
      Effect.gen(function* () {
        yield* stall()
        yield* permissionRequest("restart-no-progress", "read", [])
        expect(yield* DeepAgentActivityAuthority.recoverPendingPermissions("runtime-after-restart")).toBe(1)
        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective).toMatchObject({
          state: "interrupted",
          terminalReason: "pending_permission_interrupted_after_restart",
        })
        const { db } = yield* Database.Service
        expect(
          yield* db.get("SELECT state, terminal_reason FROM session_legacy_activity WHERE activity_id = 'activity-1'"),
        ).toEqual({ state: "interrupted", terminal_reason: "pending_permission_interrupted_after_restart" })
      }),
    )
  })

  test("expired asks and expired once grants cannot resume or consume", async () => {
    await run(
      Effect.gen(function* () {
        yield* stall()
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-expired-request",
          requestKind: "no_progress",
          idempotencyKey: "permission-expired-request-key",
          permission: "doom_loop",
          patterns: ["read"],
          alwaysPatterns: [],
          metadata: {},
          ownerID: "runtime-1",
          expiresAt: Date.now() + 10,
        })
        yield* Effect.sleep("20 millis")
        const { db } = yield* Database.Service
        expect(
          yield* DeepAgentActivityAuthority.requestPermission({
            ...ref,
            requestID: "permission-expired-request",
            requestKind: "no_progress",
            idempotencyKey: "permission-expired-request-key",
            permission: "doom_loop",
            patterns: ["read"],
            alwaysPatterns: [],
            metadata: {},
            ownerID: "runtime-1",
            expiresAt: request.expiresAt,
          }),
        ).toEqual(request)
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.requestPermission({
              ...ref,
              requestID: "permission-expired-request",
              requestKind: "no_progress",
              idempotencyKey: "permission-expired-request-key",
              permission: "doom_loop",
              patterns: ["read"],
              alwaysPatterns: [],
              metadata: {},
              ownerID: "runtime-1",
              expiresAt: request.expiresAt! + 1,
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                `INSERT INTO session_activity_permission_decision (decision_id, request_id, idempotency_key, decision, actor_type, actor_id, scope, authority_epoch, decided_at, expires_at) VALUES ('expired-direct-decision', '${request.requestID}', 'expired-direct-decision-key', 'approved_once', 'user', 'user-1', 'once', ${request.authorityEpoch}, ${Date.now()}, NULL)`,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.decidePermission({
              requestID: request.requestID,
              idempotencyKey: "decision-after-expiry",
              decision: "approved_once",
              actorType: "user",
              actorID: "user-1",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* DeepAgentActivityAuthority.decidePermission({
            requestID: request.requestID,
            idempotencyKey: "decision-expired",
            decision: "expired",
            actorType: "system",
            actorID: "clock",
          }),
        ).toMatchObject({ decision: "expired" })
      }),
    )

    await run(
      Effect.gen(function* () {
        yield* stall()
        const request = yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID: "permission-expired-consumption",
          requestKind: "no_progress",
          idempotencyKey: "permission-expired-consumption-key",
          permission: "doom_loop",
          patterns: ["read"],
          alwaysPatterns: [],
          metadata: {},
          ownerID: "runtime-1",
          expiresAt: Date.now() + 200,
        })
        const decisionExpiresAt = Date.now() + 50
        const decision = yield* DeepAgentActivityAuthority.decidePermission({
          requestID: request.requestID,
          idempotencyKey: "decision-expiring-once",
          decision: "approved_once",
          actorType: "user",
          actorID: "user-1",
          expiresAt: decisionExpiresAt,
        })
        expect(
          yield* DeepAgentActivityAuthority.decidePermission({
            requestID: request.requestID,
            idempotencyKey: "decision-expiring-once",
            decision: "approved_once",
            actorType: "user",
            actorID: "user-1",
            expiresAt: decisionExpiresAt,
          }),
        ).toEqual(decision)
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.decidePermission({
              requestID: request.requestID,
              idempotencyKey: "decision-expiring-once",
              decision: "approved_once",
              actorType: "user",
              actorID: "user-1",
              expiresAt: decisionExpiresAt + 1,
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* Effect.sleep("60 millis")
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.consumeOnce({
              requestID: request.requestID,
              consumerID: "tool-call-after-expiry",
              idempotencyKey: "consume-after-expiry",
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )

    await run(
      Effect.gen(function* () {
        yield* stall()
        const request = yield* permissionRequest("expiring-always", "read")
        expect(
          Exit.isFailure(
            yield* DeepAgentActivityAuthority.decidePermission({
              requestID: request.requestID,
              idempotencyKey: "decision-expiring-always",
              decision: "approved_always",
              actorType: "user",
              actorID: "user-1",
              expiresAt: Date.now() + 1000,
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("PermissionSaved epoch advances only for an actual authority change", async () => {
    await run(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const saved = yield* PermissionSaved.Service
          const projectID = ProjectV2.ID.make("project-1")
          expect((yield* saved.epoch(projectID)).epoch).toBe(0)
          yield* saved.add({ projectID, action: "bash", resources: ["bun test"] })
          expect((yield* saved.epoch(projectID)).epoch).toBe(1)
          yield* saved.add({ projectID, action: "bash", resources: ["bun test"] })
          expect((yield* saved.epoch(projectID)).epoch).toBe(1)
          expect(
            yield* saved.compareAndAdd({
              projectID,
              action: "bash",
              resources: ["bun test"],
              expectedEpoch: 0,
            }),
          ).toMatchObject({ epoch: 1 })
          expect(
            Exit.isFailure(
              yield* saved
                .compareAndAdd({
                  projectID,
                  action: "bash",
                  resources: ["bun run build"],
                  expectedEpoch: 0,
                })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        }).pipe(Effect.provide(PermissionSaved.layer))
      }),
    )
  })
})

function configure() {
  return DeepAgentActivityAuthority.configure({
    ...ref,
    expectedVersion: 1,
    objectiveText: "Finish the durable activity",
    completionCriteria: [{ kind: "plan_complete" }],
    enforcementState: "monitoring",
    stallThreshold: 2,
  })
}

function observe(expectedVersion: number, includeSecondEvidence: boolean, nextAction = "inspect") {
  return DeepAgentActivityAuthority.observe({
    ...ref,
    idempotencyKey: "observation-" + expectedVersion,
    expectedVersion,
    workspaceRevision: "workspace-1",
    planVersion: 1,
    validationFingerprint: "validation-fail",
    evidence: [
      { fingerprint: "evidence-1", kind: "read", sourceReceiptID: "read-1" },
      ...(includeSecondEvidence ? [{ fingerprint: "evidence-2", kind: "grep", sourceReceiptID: "grep-1" }] : []),
    ],
    effectReceipts: [{ receiptID: "effect-1", fingerprint: "effect-fingerprint-1" }],
    nextAction,
  })
}

function stall() {
  return Effect.gen(function* () {
    const configured = yield* configure()
    const first = yield* noEvidence(configured.version)
    const second = yield* noEvidence(first.objective.version)
    return (yield* noEvidence(second.objective.version)).objective
  })
}

function noEvidence(expectedVersion: number) {
  return DeepAgentActivityAuthority.observe({
    ...ref,
    idempotencyKey: "no-evidence-observation-" + expectedVersion,
    expectedVersion,
    workspaceRevision: "workspace-1",
    planVersion: 1,
    validationFingerprint: "validation-fail",
    evidence: [],
    effectReceipts: [],
    nextAction: "inspect",
  })
}

function permissionRequest(suffix: string, pattern: string, alwaysPatterns = [pattern]) {
  return DeepAgentActivityAuthority.requestPermission({
    ...ref,
    requestID: "permission-always-" + suffix,
    requestKind: "no_progress",
    idempotencyKey: "permission-always-key-" + suffix,
    permission: "doom_loop",
    patterns: [pattern],
    alwaysPatterns,
    metadata: {},
    ownerID: "runtime-1",
  })
}

function toolPermissionRequest(
  suffix: string,
  permission: string,
  patterns: readonly string[],
  alwaysPatterns: readonly string[],
  workspaceID?: string,
) {
  return DeepAgentActivityAuthority.requestPermission({
    ...ref,
    requestID: "permission-tool-" + suffix,
    requestKind: "tool",
    idempotencyKey: "permission-tool-key-" + suffix,
    permission,
    patterns,
    alwaysPatterns,
    metadata: {},
    tool: { messageID: "assistant-" + suffix, callID: "call-" + suffix },
    ownerID: "runtime-1",
    ...(workspaceID ? { workspaceID } : {}),
  })
}

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      yield* seed(db)
      yield* DatabaseMigration.applyOnly(db, [activityAuthorityMigration])
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
