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
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import {
  SessionRestart,
  classifyTaskRun,
  classifyToolReceipt,
  classifyTurn,
} from "@deepagent-code/core/session/execution/restart"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
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

  it.effect("claims and releases execution without changing user-visible update time", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const sessionID = SessionSchema.ID.make("ses_execution_claim")
      yield* seedSessions(database, [sessionID])
      const updated = yield* sessionUpdated(database, sessionID)

      yield* store.claim(sessionID)
      yield* store.claim(sessionID)
      expect(yield* suspensions(database)).toEqual({ [sessionID]: true })
      expect(yield* sessionUpdated(database, sessionID)).toBe(updated)

      yield* store.release(sessionID)
      yield* store.release(sessionID)
      expect(yield* suspensions(database)).toEqual({ [sessionID]: false })
      expect(yield* sessionUpdated(database, sessionID)).toBe(updated)
    }),
  )

  it.effect("clears suspension and records one lifecycle when execution succeeds", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_suspend_completed")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.void)
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(yield* suspensions(database)).toEqual({ [sessionID]: false })
      expect(yield* eventTypes(database, sessionID)).toEqual([
        EventV2.versionedType(SessionEvent.Execution.Started.type, 1),
        EventV2.versionedType(SessionEvent.Execution.Succeeded.type, 1),
      ])
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
      yield* seedSessions(database, [first, second], { time_suspended: Date.now() })
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
          { sessionID: second, turns: [], tools: [], tasks: [], effects: [], disposition: "claim_only" as const },
        ].toSorted((left, right) => left.sessionID.localeCompare(right.sessionID)),
      )
      expect(providerCalls).toEqual([])
      expect(yield* suspensions(database)).toEqual({ [first]: true, [second]: true })
    }),
  )

  it.effect("surfaces terminal V2 tool effects as recovery evidence without moving disposition", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_recovery_effects")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })
      const now = Date.now()
      // Two terminal effects: one bound to a permission grant, one grant-less. Both are evidence
      // of what already executed; they never move the disposition vocabulary.
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
        },
      ])
      // Terminal effects are evidence only: with no other recovery input the session stays
      // claim_only.
      expect(entry.disposition).toBe("claim_only")
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
      ),
      scope,
    )
  })
}
