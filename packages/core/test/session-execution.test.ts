import { describe, expect, test } from "bun:test"
import { asc, eq, sql } from "drizzle-orm"
import { Context, Deferred, Effect, Exit, Layer, LayerMap, Scope } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { EventV2 } from "@deepagent-code/core/event"
import { EventTable } from "@deepagent-code/core/event/sql"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { Delegation } from "../src/tool/delegation"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import {
  SessionRestart,
  classifyTaskRun,
  classifyToolReceipt,
  classifyTurn,
} from "@deepagent-code/core/session/execution/restart"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionProviderAttemptTable,
  SessionProviderOwnerLeaseTable,
} from "@deepagent-code/core/context-federation/session-sql"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "@deepagent-code/core/context-federation/sql"
import { LocationKey, ProjectScopeKey, SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { Hash } from "@deepagent-code/core/util/hash"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, store, owners))

describe("SessionExecution lifecycle", () => {
  test("classifies only explicitly bound provider receipt and attempt pairs", () => {
    const receipt = {
      receiptId: "receipt",
      state: "preparing" as const,
      activityId: "activity",
      providerTurnSeq: 1,
      providerAttemptId: "attempt",
      requestHash: "request",
      providerId: "provider",
      ownerToken: "owner",
    }
    const attempt = {
      attemptId: "attempt",
      state: "prepared" as const,
      activityId: "activity",
      providerTurnSeq: 1,
      requestHash: "request",
      providerId: "provider",
      ownerToken: "owner",
    }
    expect(classifyTurn(receipt)).toBe("authority_conflict")
    expect(classifyTurn(receipt, attempt)).toBe("safe_before_dispatch")
    expect(classifyTurn({ ...receipt, state: "dispatching", dispatchingAt: 1 }, attempt)).toBe("recovery_required")
    expect(classifyTurn({ ...receipt, state: "settled" }, { ...attempt, state: "settled" })).toBe("terminal_consistent")
    expect(classifyTurn({ ...receipt, state: "settled" }, { ...attempt, state: "failed" })).toBe("authority_conflict")
    expect(classifyTurn(receipt, { ...attempt, requestHash: "different" })).toBe("authority_conflict")
  })

  test("classifies tool receipts by dispatch evidence only", () => {
    expect(classifyToolReceipt({ providerState: "preparing" })).toBe("safe_before_dispatch")
    expect(classifyToolReceipt({ providerState: "prepared" })).toBe("safe_before_dispatch")
    expect(classifyToolReceipt({ providerState: "dispatching" })).toBe("recovery_required")
    expect(classifyToolReceipt({ providerState: "streaming" })).toBe("recovery_required")
    expect(classifyToolReceipt({ providerState: "indeterminate_after_crash" })).toBe("recovery_required")
  })

  test("classifies task runs by execution evidence and lease liveness", () => {
    const observedAt = 1_000_000
    expect(classifyTaskRun({ state: "queued" }, observedAt)).toBe("safe_before_dispatch")
    expect(classifyTaskRun({ state: "admitted" }, observedAt)).toBe("safe_before_dispatch")
    expect(classifyTaskRun({ state: "provisioning" }, observedAt)).toBe("safe_before_dispatch")
    // A live lease wins even before dispatch: claiming writes the owner before provisioning ends.
    expect(
      classifyTaskRun(
        { state: "provisioning", executionOwner: "owner", leaseExpiresAt: observedAt + 1 },
        observedAt,
      ),
    ).toBe("owned_elsewhere")
    expect(
      classifyTaskRun({ state: "running", executionOwner: "owner", leaseExpiresAt: observedAt + 1 }, observedAt),
    ).toBe("owned_elsewhere")
    expect(classifyTaskRun({ state: "running", executionOwner: "owner", leaseExpiresAt: observedAt - 1 }, observedAt)).toBe(
      "recovery_required",
    )
    expect(classifyTaskRun({ state: "finalizing" }, observedAt)).toBe("recovery_required")
    expect(classifyTaskRun({ state: "recovery_required" }, observedAt)).toBe("recovery_required")
  })

  test("classifies success, failure, and interruption terminals", () => {
    expect(SessionExecution.terminal(Exit.succeed(undefined))).toEqual({ type: "succeeded" })
    expect(SessionExecution.terminal(Exit.die(new Error("failed")))).toEqual({
      type: "failed",
      error: { type: "unknown", message: "failed" },
    })
    const interrupted = Effect.runSyncExit(Effect.interrupt)
    expect(SessionExecution.terminal(interrupted)).toEqual({ type: "interrupted", reason: "shutdown" })
    expect(SessionExecution.terminal(interrupted, "user")).toEqual({ type: "interrupted", reason: "user" })
  })

  test("does not classify interruption mixed with a defect as a user stop", () => {
    const exit = Effect.runSyncExit(Effect.interrupt.pipe(Effect.ensuring(Effect.die(new Error("cleanup failed")))))
    expect(SessionExecution.terminal(exit, "user")).toMatchObject({ type: "failed" })
  })

  it.effect("claims and releases execution without changing user-visible update time", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const sessionID = SessionSchema.ID.make("ses_execution_claim")
      yield* seedSessions(database, [sessionID])
      const updated = yield* sessionUpdated(database, sessionID)

      const token = yield* store.claim(sessionID)
      expect(token).toBeNumber()
      expect(yield* store.claim(sessionID)).toBeUndefined()
      expect(yield* suspensions(database)).toEqual({ [sessionID]: true })
      expect(yield* sessionUpdated(database, sessionID)).toBe(updated)

      expect(yield* store.release(sessionID, token! + 1)).toBe(false)
      expect(yield* store.release(sessionID, token!)).toBe(true)
      expect(yield* suspensions(database)).toEqual({ [sessionID]: false })
      expect(yield* sessionUpdated(database, sessionID)).toBe(updated)
    }),
  )

  it.effect("refuses to drain a suspended Session until explicit recovery resolves its claim", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_suspend_completed")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })

      let runs = 0
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.sync(() => runs++))
      const execution = Context.get(context, SessionExecution.Service)

      const result = yield* execution.resume(sessionID).pipe(Effect.flip)
      expect(result).toBeInstanceOf(SessionRunner.ExecutionRecoveryRequiredError)
      expect(runs).toBe(0)
      expect(yield* suspensions(database)).toEqual({ [sessionID]: true })
      expect(yield* eventTypes(database, sessionID)).toEqual([])
    }),
  )

  it.effect("preserves suspension when orderly teardown interrupts execution", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_suspend_interrupted")
      yield* seedSessions(database, [sessionID])

      const started = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkIn(scope))
      yield* Deferred.await(started)

      expect(yield* suspensions(database)).toEqual({ [sessionID]: true })
      yield* restart.suspendActiveSessions
      expect(yield* suspensions(database)).toEqual({ [sessionID]: true })
      yield* Scope.close(scope, Exit.void)

      expect(yield* suspensions(database)).toEqual({ [sessionID]: true })
      expect(yield* eventTypes(database, sessionID)).toEqual([
        EventV2.versionedType(SessionEvent.Execution.Started.type, 1),
        EventV2.versionedType(SessionEvent.Execution.Interrupted.type, 1),
      ])
    }),
  )

  it.effect("releases the write-ahead claim after an explicit user interruption", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_user_interrupted")
      yield* seedSessions(database, [sessionID])

      const started = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkIn(scope))
      yield* Deferred.await(started)

      expect(yield* suspensions(database)).toEqual({ [sessionID]: true })
      yield* execution.interrupt(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(yield* suspensions(database)).toEqual({ [sessionID]: false })
      expect(yield* eventTypes(database, sessionID)).toEqual([
        EventV2.versionedType(SessionEvent.Execution.Started.type, 1),
        EventV2.versionedType(SessionEvent.Execution.Interrupted.type, 1),
      ])
    }),
  )

  it.effect("reports suspended Sessions for explicit recovery without replaying provider work", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const first = SessionSchema.ID.make("ses_recovery_first")
      const second = SessionSchema.ID.make("ses_recovery_second")
      const claimToken = Date.now()
      yield* seedSessions(database, [first, second], { time_suspended: claimToken })
      const now = Date.now()
      yield* (yield* SessionProviderOwner.Service).register({ ownerToken: "recovery-owner", leaseMs: 60_000 })
      yield* database.db
        .insert(V2ProviderTurnReceiptTable)
        .values({
          receipt_id: "recovery-receipt",
          session_id: first,
          request_ordinal: 1,
          activity_id: "recovery-activity",
          provider_turn_seq: 1,
          user_message_id: "recovery-message",
          history_prompt_epoch: 1,
          request_input_hash: "a".repeat(64),
          provider_id: "provider-test",
          model_id: "model-test",
          protocol: "openai-chat",
          owner_mode: "v2",
          owner_token: "recovery-owner",
          state: "preparing",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)

      const providerCalls: SessionSchema.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        Effect.sync(() => {
          providerCalls.push(sessionID)
        }),
      )
      const restart = Context.get(context, SessionRestart.Service)

      expect(
        (yield* restart.pendingRecovery).toSorted((left, right) => left.sessionID.localeCompare(right.sessionID)),
      ).toEqual(
        [
          {
            sessionID: first,
            claimToken,
            turns: [
              {
                receipt: {
                  receiptId: "recovery-receipt",
                  state: "preparing" as const,
                  activityId: "recovery-activity",
                  providerTurnSeq: 1,
                  requestHash: "a".repeat(64),
                  providerId: "provider-test",
                  ownerToken: "recovery-owner",
                },
                classification: "owned_elsewhere" as const,
              },
            ],
            tools: [],
            tasks: [],
            effects: [],
            disposition: "owned_elsewhere" as const,
          },
          {
            sessionID: second,
            claimToken,
            turns: [],
            tools: [],
            tasks: [],
            effects: [],
            disposition: "claim_only" as const,
          },
        ].toSorted((left, right) => left.sessionID.localeCompare(right.sessionID)),
      )
      expect(providerCalls).toEqual([])
      expect(yield* suspensions(database)).toEqual({ [first]: true, [second]: true })
    }),
  )

  it.effect("startup redrive exact-releases safe claims and wakes pending durable inputs once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const claimed = SessionSchema.ID.make("ses_redrive_claimed")
      const unclaimed = SessionSchema.ID.make("ses_redrive_unclaimed")
      const claimToken = Date.now()
      yield* seedSessions(database, [claimed], { time_suspended: claimToken })
      yield* seedSessions(database, [unclaimed])
      yield* database.db
        .insert(SessionInputTable)
        .values([
          {
            id: SessionMessage.ID.make("msg_redrive_claimed"),
            session_id: claimed,
            prompt: new Prompt({ text: "claimed" }),
            delivery: "steer",
            admitted_seq: 1,
          },
          {
            id: SessionMessage.ID.make("msg_redrive_unclaimed"),
            session_id: unclaimed,
            prompt: new Prompt({ text: "unclaimed" }),
            delivery: "queue",
            admitted_seq: 1,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const providerCalls: SessionSchema.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        Effect.sync(() => {
          providerCalls.push(sessionID)
        }),
      )
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)

      expect(yield* restart.redriveStartup).toEqual({
        released: [claimed],
        woken: [claimed, unclaimed],
        blocked: [],
      })
      yield* Effect.forEach([claimed, unclaimed], execution.awaitIdle, { discard: true })
      expect(providerCalls.toSorted()).toEqual([claimed, unclaimed].toSorted())
      expect(yield* suspensions(database)).toEqual({ [claimed]: false, [unclaimed]: false })
    }),
  )

  // Durable shape of the packaged "kill-9 before wake" window: a turn dispatched under claim
  // token-1 that reached a TERMINAL receipt state (failed / settled / indeterminate_after_crash —
  // in the packaged scenario a user interrupt classified it indeterminate_after_crash), the
  // chain released, and a later idle drain claimed token-2 before the process was killed
  // mid-window. The token-2 claim must exact-release: the foreign-token terminal row is settled
  // history, not an ownership conflict.
  it.effect("releases a claim whose only turns are terminal history under an older claim token", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_foreign_terminal")
      const foreignToken = Date.now() - 10_000
      const claimToken = Date.now()
      yield* seedForeignClaimTurn(database, sessionID, {
        attemptToken: foreignToken,
        claimToken,
        terminal: true,
      })

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.void)
      const restart = Context.get(context, SessionRestart.Service)

      const pending = yield* restart.pendingRecovery
      expect(pending[0]?.turns[0]?.classification).toBe("terminal_consistent")
      expect(pending[0]?.disposition).toBe("terminal_consistent")
      expect(yield* restart.redriveStartup).toEqual({ released: [sessionID], woken: [], blocked: [] })
      expect(yield* suspensions(database)).toEqual({ [sessionID]: false })
    }),
  )

  // A mid-drain recovery escalation (e.g. the runner refusing to replay an indeterminate receipt)
  // owns its execution claim; the settled callback must release it instead of leaving the claim
  // lingering — the recovery fence lives in the receipt state machine, not the execution claim.
  it.effect("releases the execution claim when a drain escalates to recovery_required mid-flight", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const sessionID = SessionSchema.ID.make("ses_escalation_release")
      yield* seedSessions(database, [sessionID])

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Effect.fail(new SessionRunner.ExecutionRecoveryRequiredError({ sessionID })),
      )
      const execution = Context.get(context, SessionExecution.Service)

      const exit = yield* execution.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      yield* execution.awaitIdle(sessionID)
      expect(yield* suspensions(database)).toEqual({ [sessionID]: false })
      expect(yield* store.claimToken(sessionID)).toBeUndefined()
    }),
  )

  // The fence is preserved when the foreign-token turn is still in flight: a non-terminal row
  // under another claim means unknown ownership and must block the exact-release.
  it.effect("fences a claim when a foreign-token turn is still in flight", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_foreign_inflight")
      yield* seedForeignClaimTurn(database, sessionID, {
        attemptToken: Date.now() - 10_000,
        claimToken: Date.now(),
        terminal: false,
      })

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.void)
      const restart = Context.get(context, SessionRestart.Service)

      const pending = yield* restart.pendingRecovery
      expect(pending[0]?.turns[0]?.classification).toBe("authority_conflict")
      expect(pending[0]?.disposition).toBe("authority_conflict")
      expect(yield* restart.redriveStartup).toEqual({
        released: [],
        woken: [],
        blocked: [{ sessionID, disposition: "authority_conflict" }],
      })
      expect(yield* suspensions(database)).toEqual({ [sessionID]: true })
    }),
  )

  it.effect("keeps stale advisory wakes stopped across an execution-layer restart", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_restart_interrupt_barrier")
      yield* seedSessions(database, [sessionID])
      yield* database.db
        .update(SessionTable)
        .set({ interrupt_seq: 2 })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)

      let runs = 0
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.sync(() => runs++))
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.wake(sessionID, 2)
      expect(yield* execution.active).toEqual(new Set())
      expect(runs).toBe(0)

      yield* execution.wake(sessionID, 3)
      yield* execution.awaitIdle(sessionID)
      expect(runs).toBe(1)

      yield* execution.resume(sessionID)
      expect(runs).toBe(2)
    }),
  )

  it.effect("does not auto-redrive pending inputs admitted before a durable interrupt", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_redrive_interrupt_barrier")
      yield* seedSessions(database, [sessionID], { time_suspended: 1 })
      yield* database.db
        .update(SessionTable)
        .set({ interrupt_seq: 2 })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionInputTable)
        .values({
          id: SessionMessage.ID.make("msg_redrive_interrupted"),
          session_id: sessionID,
          prompt: new Prompt({ text: "stay stopped" }),
          delivery: "queue",
          admitted_seq: 1,
        })
        .run()
        .pipe(Effect.orDie)

      let runs = 0
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.sync(() => runs++))
      const restart = Context.get(context, SessionRestart.Service)

      expect(yield* restart.redriveStartup).toEqual({ released: [sessionID], woken: [], blocked: [] })
      expect(runs).toBe(0)
      expect(yield* suspensions(database)).toEqual({ [sessionID]: false })
    }),
  )

  it.effect("surfaces admitted and terminal V2 tool effects as recovery classification inputs", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_recovery_effects")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })
      const now = Date.now()
      yield* database.db
        .run(sql`
        INSERT INTO session_v2_tool_effect_admission (
          admission_id, session_id, provider_attempt_id, receipt_id, tool_call_id,
          tool_name, effect_kind, owner_token, time_created
        ) VALUES
          ('adm_1', ${sessionID}, 'attempt_eff', 'receipt_eff', 'call_1', 'write', 'mutating', 'owner_eff', ${now}),
          ('adm_2', ${sessionID}, 'attempt_eff', 'receipt_eff', 'call_2', 'read', 'read_only', 'owner_eff', ${now}),
          ('adm_3', ${sessionID}, 'attempt_eff', 'receipt_eff', 'call_3', 'bash', 'mutating', 'owner_eff', ${now})
      `)
        .pipe(Effect.orDie)
      // Two terminal effects: one bound to a permission grant and one grant-less. The third
      // admission intentionally has no terminal row and therefore has an unknown outcome.
      yield* database.db
        .run(sql`
        INSERT INTO session_v2_tool_effect (
          effect_id, session_id, provider_attempt_id, receipt_id, tool_call_id, tool_name,
          effect_kind, state, outcome_hash, error_code, grant_receipt_id, grant_owner_id, grant_state, grant_version,
          owner_token, time_created
        ) VALUES ${sql.raw(`(
          'eff_1', '${sessionID}', 'attempt_eff', 'receipt_eff', 'call_1', 'write',
          'mutating', 'settled', '${"a".repeat(64)}', NULL, 'grant_r', 'grant_o', 'settled', 2, 'owner_eff', ${now}
        ), (
          'eff_2', '${sessionID}', 'attempt_eff', 'receipt_eff', 'call_2', 'read',
          'read_only', 'failed', '${"b".repeat(64)}', 'tool_settlement_failed', NULL, NULL, NULL, NULL, 'owner_eff', ${now}
        )`)}
      `)
        .pipe(Effect.orDie)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.void)
      const restart = Context.get(context, SessionRestart.Service)

      const inventory = yield* restart.pendingRecovery
      expect(inventory).toHaveLength(1)
      const entry = inventory[0]!
      expect(entry.effects).toEqual([
        {
          effectId: "eff_1",
          receiptId: "receipt_eff",
          providerAttemptId: "attempt_eff",
          toolCallId: "call_1",
          toolName: "write",
          effectKind: "mutating",
          state: "settled",
          grantBound: true,
          classification: "terminal_consistent",
        },
        {
          effectId: "eff_2",
          receiptId: "receipt_eff",
          providerAttemptId: "attempt_eff",
          toolCallId: "call_2",
          toolName: "read",
          effectKind: "read_only",
          state: "failed",
          grantBound: false,
          classification: "recovery_required",
        },
        {
          effectId: "adm_3",
          receiptId: "receipt_eff",
          providerAttemptId: "attempt_eff",
          toolCallId: "call_3",
          toolName: "bash",
          effectKind: "mutating",
          state: "admitted",
          grantBound: false,
          classification: "recovery_required",
        },
      ])
      expect(entry.disposition).toBe("recovery_required")
    }),
  )

  it.effect("surfaces legacy tool receipts and task runs fail-closed in the recovery inventory", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_recovery_legacy")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })
      const now = Date.now()
      yield* (yield* SessionProviderOwner.Service).register({ ownerToken: "legacy-owner", leaseMs: 600_000 })
      // Receipt inserts demand a live released-knowledge identity chain; seed the minimal
      // namespace + project scope rows the authority insert guard checks against.
      yield* database.db
        .run(sql`
          INSERT INTO context_security_namespace (id, kind, binding_hash, created_at)
          VALUES ('ns-recovery-legacy', 'implicit_local', 'binding-recovery-legacy', ${now})
        `)
        .pipe(Effect.orDie)
      yield* database.db
        .run(sql`
          INSERT INTO context_project_scope_identity (
            security_namespace_id, project_scope_key, project_kind, project_identity_hash, created_at
          ) VALUES ('ns-recovery-legacy', 'scope-recovery-legacy', 'registered_root', 'identity-recovery-legacy', ${now})
        `)
        .pipe(Effect.orDie)
      // Receipt inserts are only admitted while `preparing` (durable admission semantics); seed
      // both receipts preparing with the minimal `unavailable` released-knowledge binding, then
      // transition the mid-stream one exactly as the production state machine would.
      yield* database.db
        .run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
            registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
            released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            provider_state, request_state, owner_token, created_at
          ) VALUES
            ('tool-receipt-preparing', 1, ${sessionID}, 'message-legacy', 'provider-test', 'model-test',
             '[]', '[]', '[]', '[]', 'ns-recovery-legacy', 'scope-recovery-legacy',
             'unavailable', '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
             'preparing', 'prepared', 'legacy-owner', ${now}),
            ('tool-receipt-streaming', 2, ${sessionID}, 'message-legacy', 'provider-test', 'model-test',
             '[]', '[]', '[]', '[]', 'ns-recovery-legacy', 'scope-recovery-legacy',
             'unavailable', '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
             'preparing', 'prepared', 'legacy-owner', ${now})
        `)
        .pipe(Effect.orDie)
      // Fixture-exempt: simulate a legacy pre-authority crash row stuck mid-stream. The V2-era
      // transition and wire guards only admit dispatches sealed by the current receipt seam, which
      // legacy rows never had, so they are dropped for this seed exactly as the
      // provider-receipt-recovery fixture does.
      yield* database.db.run(sql`DROP TRIGGER session_tool_request_receipt_provider_transition`).pipe(Effect.orDie)
      yield* database.db
        .run(sql`DROP TRIGGER IF EXISTS session_tool_request_receipt_attempt_wire_guard`)
        .pipe(Effect.orDie)
      yield* database.db
        .run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'streaming', request_state = 'dispatched',
              call_ids = '["call-1"]', dispatching_at = ${now}, streaming_at = ${now}
          WHERE receipt_id = 'tool-receipt-streaming'
        `)
        .pipe(Effect.orDie)
      // Task runs: one queued (not started), one running under a live lease, one running with a
      // dead lease, and one already terminal (must not be surfaced).
      yield* database.db
        .run(sql`
          INSERT INTO task_run (
            run_id, request_hash, parent_session_id, parent_message_id, tool_call_id, child_session_id,
            generation, delivery_mode, phase, state, execution_owner, lease_expires_at, time_created, time_updated
          ) VALUES
            ('task-queued', 'hash-queued', ${sessionID}, 'message-legacy', 'call-queued', 'ses_child_queued',
             1, 'background', 'queue', 'queued', NULL, NULL, ${now}, ${now}),
            ('task-live', 'hash-live', ${sessionID}, 'message-legacy', 'call-live', 'ses_child_live',
             1, 'background', 'research', 'running', 'task-owner-live', ${now + 600_000}, ${now}, ${now}),
            ('task-dead', 'hash-dead', ${sessionID}, 'message-legacy', 'call-dead', 'ses_child_dead',
             1, 'background', 'research', 'running', 'task-owner-dead', ${now - 600_000}, ${now}, ${now}),
            ('task-done', 'hash-done', ${sessionID}, 'message-legacy', 'call-done', 'ses_child_done',
             1, 'background', 'settled', 'completed', NULL, NULL, ${now}, ${now})
        `)
        .pipe(Effect.orDie)
      // Make the task owner lease live for the live-lease run.
      yield* (yield* SessionProviderOwner.Service).register({ ownerToken: "task-owner-live", leaseMs: 600_000 })

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.void)
      const restart = Context.get(context, SessionRestart.Service)

      const inventory = yield* restart.pendingRecovery
      expect(inventory).toHaveLength(1)
      const entry = inventory[0]!
      expect(entry.sessionID).toBe(sessionID)
      expect(entry.tools.map((tool) => [tool.receiptId, tool.classification])).toEqual([
        ["tool-receipt-preparing", "safe_before_dispatch"],
        ["tool-receipt-streaming", "recovery_required"],
      ])
      expect(entry.tasks.map((task) => [task.runId, task.classification])).toEqual([
        ["task-queued", "safe_before_dispatch"],
        ["task-live", "owned_elsewhere"],
        ["task-dead", "recovery_required"],
      ])
      // A live owner elsewhere outranks recovery in the coarse disposition: the session is
      // actively owned, so the restart process must back off; the recovery_required entries
      // stay fully enumerated above and are never hidden by the disposition.
      expect(entry.disposition).toBe("owned_elsewhere")
      expect(entry.turns).toEqual([])
    }),
  )

  it.effect("escalates the disposition to recovery_required when no live owner holds the session", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_recovery_unowned")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })
      const now = Date.now()
      // Only a dead-lease running task: no live owner anywhere, unknown outcome must surface as
      // recovery_required at the disposition level.
      yield* database.db
        .run(sql`
          INSERT INTO task_run (
            run_id, request_hash, parent_session_id, parent_message_id, tool_call_id, child_session_id,
            generation, delivery_mode, phase, state, execution_owner, lease_expires_at, time_created, time_updated
          ) VALUES
            ('task-dead-only', 'hash-dead-only', ${sessionID}, 'message-legacy', 'call-dead-only', 'ses_child_dead_only',
             1, 'background', 'research', 'running', 'task-owner-dead', ${now - 600_000}, ${now}, ${now})
        `)
        .pipe(Effect.orDie)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.void)
      const restart = Context.get(context, SessionRestart.Service)

      const inventory = yield* restart.pendingRecovery
      expect(inventory).toHaveLength(1)
      const entry = inventory[0]!
      expect(entry.tasks.map((task) => [task.runId, task.classification])).toEqual([
        ["task-dead-only", "recovery_required"],
      ])
      expect(entry.disposition).toBe("recovery_required")
    }),
  )
})

function seedSessions(
  database: Database.Interface,
  sessionIDs: ReadonlyArray<SessionSchema.ID>,
  values: { time_suspended?: number } = {},
) {
  return Effect.gen(function* () {
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values(
        sessionIDs.map((id) => ({
          id,
          project_id: Project.ID.global,
          slug: id,
          directory: "/project",
          title: id,
          version: "test",
          ...values,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

function suspensions(database: Database.Interface) {
  return database.db
    .select({ id: SessionTable.id, suspended: SessionTable.time_suspended })
    .from(SessionTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.id, row.suspended !== null]))),
    )
}

function sessionUpdated(database: Database.Interface, sessionID: SessionSchema.ID) {
  return database.db
    .select({ updated: SessionTable.time_updated })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.updated),
    )
}

function eventTypes(database: Database.Interface, sessionID: SessionSchema.ID) {
  return database.db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.type)),
    )
}

function buildExecution(scope: Scope.Closeable, run: SessionRunner.Interface["run"]) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const runner = Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({ run }))
    const locations = Layer.effect(
      LocationServiceMap,
      LayerMap.make(() => runner).pipe(
        // The lifecycle harness only needs the runner from the full Location graph.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Effect.map((service) => service as unknown as LocationServiceMap["Service"]),
      ),
    )
    return yield* Layer.buildWithScope(
      SessionRestart.layer.pipe(
        Layer.provideMerge(SessionExecutionLocal.layer),
        Layer.provide(Layer.succeed(EventV2.Service, events)),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(locations),
        Layer.provide(Delegation.delegationSlotLayer),
      ),
      scope,
    )
  })
}

function seedForeignClaimTurn(
  database: Database.Interface,
  sessionID: SessionSchema.ID,
  input: {
    readonly attemptToken: number
    readonly claimToken: number
    readonly terminal: boolean
  },
) {
  return Effect.gen(function* () {
    yield* seedSessions(database, [sessionID], { time_suspended: input.claimToken })
    const userMessageId = "msg_foreign_turn"
    yield* database.db
      .insert(SessionInputTable)
      .values({
        id: SessionMessage.ID.make(userMessageId),
        session_id: sessionID,
        prompt: new Prompt({ text: "foreign claim turn" }),
        delivery: "steer",
        admitted_seq: 0,
        promoted_seq: 0,
        time_created: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionActivityTable)
      .values({
        activity_id: "activity_foreign_turn",
        session_id: sessionID,
        ordinal: 0,
        trigger_input_id: SessionMessage.ID.make(userMessageId),
        delivery: "steer",
        state: "active",
        created_at: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SecurityNamespaceTable)
      .values({
        id: "security_foreign_turn",
        kind: "implicit_local",
        binding_hash: Hash.sha256("security_foreign_turn"),
        created_at: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(ProjectScopeIdentityTable)
      .values({
        security_namespace_id: SecurityNamespaceID.make("security_foreign_turn"),
        project_scope_key: ProjectScopeKey.make("project_scope_foreign_turn"),
        project_kind: "registered_root",
        project_identity_hash: Hash.sha256("project_foreign_turn"),
        created_at: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: SecurityNamespaceID.make("security_foreign_turn"),
        location_key: LocationKey.make("location_foreign_turn"),
        project_scope_key: ProjectScopeKey.make("project_scope_foreign_turn"),
        canonical_root: "/tmp/foreign-turn",
        created_at: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionContextSelectionTable)
      .values({
        selection_id: "selection_foreign_turn",
        session_id: sessionID,
        activity_id: "activity_foreign_turn",
        revision: 0,
        trigger_input_id: SessionMessage.ID.make(userMessageId),
        location_key: LocationKey.make("location_foreign_turn"),
        security_namespace_id: SecurityNamespaceID.make("security_foreign_turn"),
        project_scope_key: ProjectScopeKey.make("project_scope_foreign_turn"),
        query_fingerprint: "query_foreign_turn",
        authorization_fingerprint: "authorization_foreign_turn",
        authorization_epoch: 1,
        execution_fingerprint: "execution_foreign_turn",
        selected_source_fingerprint: "source_foreign_turn",
        observed_location_mutation_epoch: 0,
        next_revalidation_at: 2_000_000_000_000,
        released_knowledge_binding_state: "unavailable",
        released_knowledge_exact_refs: [],
        released_knowledge_exact_refs_fingerprint: Hash.sha256("[]"),
        graph_revisions: "{}",
        graph_statuses: "{}",
        selected_refs: "[]",
        projection: "{}",
        projection_hash: "projection_foreign_turn",
        token_count: 0,
        artifact_write_status: "degraded_unavailable",
        inline_audit: "{}",
        created_at: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const ownerService = yield* SessionProviderOwner.Service
    yield* ownerService.register({ ownerToken: "owner_foreign_turn", leaseMs: 60_000 })
    yield* database.db
      .insert(SessionProviderAttemptTable)
      .values({
        attempt_id: "attempt_foreign_turn",
        session_id: sessionID,
        activity_id: "activity_foreign_turn",
        provider_turn_seq: 1,
        selection_id: "selection_foreign_turn",
        projection_hash: "projection_foreign_turn",
        request_hash: "b".repeat(64),
        provider_id: "provider-test",
        owner_token: "owner_foreign_turn",
        execution_claim_token: input.attemptToken,
        state: "prepared",
        created_at: 1,
      })
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(V2ProviderTurnReceiptTable)
      .values({
        receipt_id: "receipt_foreign_turn",
        session_id: sessionID,
        request_ordinal: 1,
        provider_attempt_id: "attempt_foreign_turn",
        activity_id: "activity_foreign_turn",
        provider_turn_seq: 1,
        user_message_id: userMessageId,
        history_prompt_epoch: 1,
        request_input_hash: "b".repeat(64),
        provider_id: "provider-test",
        model_id: "model-test",
        protocol: "openai-chat",
        owner_mode: "v2",
        owner_token: "owner_foreign_turn",
        state: "preparing",
        created_at: 1,
      })
      .run()
      .pipe(Effect.orDie)
    if (input.terminal) {
      // The legal preparing->failed terminal transition (any non-owner_lost error code); the
      // packaged indeterminate_after_crash variant rides the same terminal set in the fix.
      yield* database.db
        .update(V2ProviderTurnReceiptTable)
        .set({ state: "failed", error_code: "consumer_stream_failed", terminal_at: 2 })
        .where(eq(V2ProviderTurnReceiptTable.receipt_id, "receipt_foreign_turn"))
        .run()
        .pipe(Effect.orDie)
    }
    // The foreign chain is dead: release its owner lease only AFTER the rows exist ( the attempt
    // insert trigger requires a live lease), so recovery reads ownedElsewhere=false.
    yield* ownerService.release({ ownerToken: "owner_foreign_turn" }).pipe(Effect.orDie)
  })
}
