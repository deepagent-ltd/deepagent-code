import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { RecoveryCommandContract } from "@deepagent-code/core/contract/recovery-command"
import { SessionProviderRecovery, SessionProviderRecoveryDurable } from "@deepagent-code/core/session/runner"
import { RecoveryExecutor } from "@/server/recovery-executor"

// W2.2 — production-level tests for the C1B recovery executor wiring (design §W2/W2.1 +
// §10.7 recovery order): a kill-9 restart leaves the committed-but-unapplied recovery
// commands as `pending` rows; the startup drain (executor layer build) applies the exit
// the descriptor class authorizes via the durable store, idempotently, and a command
// that cannot be applied stays pending without blocking the boot.

const H64 = (c: string) => c.repeat(64)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_prod",
  attemptId: "att_prod",
  activityId: "act_prod",
  providerTurnSeq: 1,
  selectionId: "sel_1",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  ...overrides,
})

const classifyInput = (
  attempt: SessionProviderRecovery.AttemptIdentity,
  kind: "exact" | "repairable" | "fork" | "coordination" | "resolved",
  authority: { readonly ownerToken?: string; readonly expectedVersion?: number } = {},
): SessionProviderRecovery.ClassifyInput => {
  const base = {
    attempt,
    attemptState: "indeterminate_after_crash",
    expectedAttemptState: "indeterminate_after_crash",
    ownerToken: authority.ownerToken ?? "",
    expectedVersion: authority.expectedVersion ?? 0,
    historyVerified: true,
    providerLookupComplete: true,
    placementUnresolved: false,
    permissionIncomplete: false,
    workspaceConflict: false,
  } satisfies SessionProviderRecovery.ClassifyInput
  if (kind === "exact") return { ...base, baseline: { baselineHash: H64("b"), verified: true, state: "present" } }
  if (kind === "repairable") return { ...base, baseline: { verified: false, state: "missing", sourceSnapshotRef: "snap:1" } }
  if (kind === "fork") {
    return { ...base, baseline: { verified: false, state: "present" }, safeBoundary: { safeBoundaryRef: "boundary:1", safeBoundaryHash: H64("sb") } }
  }
  if (kind === "coordination") return { ...base, baseline: { verified: false, state: "present" } }
  return { ...base, resolution: { resolutionRef: "resolution:1", bridgeRef: "bridge:1", terminal: "settled" } }
}

/** Seed a pending command bound to a classified descriptor (the durable record shape). */
const seedPending = (
  db: Database.Interface["db"],
  attempt: SessionProviderRecovery.AttemptIdentity,
  kind: "exact" | "repairable" | "fork" | "coordination" | "resolved",
  command: {
    readonly actorType?: "user" | "administrator" | "system"
    readonly actorId?: string
    readonly withDescriptor?: boolean
    readonly expectedOwnerToken?: string
    readonly expectedVersion?: number
    readonly commandKind?: "abandon_exact" | "confirm_settled"
    readonly evidence?: RecoveryCommandContract.RecoveryEvidence
  } = {},
) =>
  Effect.gen(function* () {
    const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
    const descriptor = SessionProviderRecovery.classify(
      classifyInput(attempt, kind, {
        ownerToken: command.expectedOwnerToken,
        expectedVersion: command.expectedVersion,
      }),
    )
    const descriptorWrite = yield* store.putDescriptor({
      descriptor,
      sessionId: attempt.sessionId,
      activityId: attempt.activityId,
      turnId: "1",
      createdAt: 1,
    })
    const cas = yield* store.putCommand({
      requestHash: attempt.requestHash,
      attemptIdentity: attempt,
      ...(command.withDescriptor === false ? {} : { descriptorId: descriptorWrite.descriptorId }),
      ...(command.actorType ? { actorType: command.actorType } : {}),
      ...(command.actorId ? { actorId: command.actorId } : {}),
      ...(command.expectedOwnerToken ? { expectedOwnerToken: command.expectedOwnerToken } : {}),
      ...(command.commandKind ? { commandKind: command.commandKind } : {}),
      ...(command.evidence ? { evidence: command.evidence } : {}),
      createdAt: 1,
    })
    return { commandId: cas.commandId }
  })

/** A typed provider-settled evidence body bound to a seeded attempt (frozen contract shape). */
const settledEvidence = (providerId: string): RecoveryCommandContract.RecoveryEvidence => ({
  schemaVersion: "recovery-evidence.v1",
  providerId,
  externalRequestId: `ext_${H64("x")}`,
  idempotencyKey: `idem_${H64("i")}`,
  terminalState: "settled",
  payloadHash: H64("p"),
  responseFingerprint: H64("f"),
  retrievalRef: `lookup:${H64("r")}`,
  metadata: { provider_response_status: 200 },
  verifiedAt: 1,
})

/**
 * Seed the complete provider authority that a kill-9 leaves behind. This deliberately
 * walks the legal prepared → dispatching → indeterminate transitions while the owner
 * is live, then releases that owner. The recovery executor therefore has to satisfy
 * the same database triggers and fences as production; a command-only fixture cannot
 * prove that the real attempt, receipt, activity and Session claim converge.
 */
const seedIndeterminateAuthority = (
  db: Database.Interface["db"],
  overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {},
) =>
  Effect.gen(function* () {
    const attempt = identity(overrides)
    const ownerToken = `owner_${attempt.attemptId}`
    const claimToken = 918_273
    const inputId = `msg_${attempt.attemptId}`
    const receiptId = `receipt_${attempt.attemptId}`
    const projectId = `project_${attempt.attemptId}`
    const namespaceId = `namespace_${attempt.attemptId}`
    const scopeKey = `scope_${attempt.attemptId}`
    const preparedTurnHash = H64("a")
    const wireRequestHash = H64("b")
    const dbNow = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`

    yield* db.run(sql`
      INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES (${projectId}, '/tmp/recovery-executor', '[]', ${dbNow}, ${dbNow})
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session
        (id, project_id, slug, directory, title, version, execution_claim_token, time_created, time_updated)
      VALUES (
        ${attempt.sessionId}, ${projectId}, 'recovery', '/tmp/recovery-executor', 'recovery',
        'test', ${claimToken}, ${dbNow}, ${dbNow}
      )
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
      VALUES (${inputId}, ${attempt.sessionId}, '{"text":"recover"}', 'steer', 0, 0, ${dbNow})
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session_activity
        (activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at)
      VALUES (${attempt.activityId}, ${attempt.sessionId}, 0, ${inputId}, 'steer', 'active', ${dbNow})
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO context_security_namespace (id, kind, binding_hash, created_at)
      VALUES (${namespaceId}, 'implicit_local', ${H64("n")}, ${dbNow})
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO context_project_scope_identity
        (security_namespace_id, project_scope_key, project_kind, project_identity_hash, observed_project_id, created_at)
      VALUES (${namespaceId}, ${scopeKey}, 'registered_root', ${H64("j")}, ${projectId}, ${dbNow})
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO context_location_identity
        (security_namespace_id, location_key, project_scope_key, canonical_root, observed_project_id, created_at)
      VALUES (${namespaceId}, 'local', ${scopeKey}, '/tmp/recovery-executor', ${projectId}, ${dbNow})
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session_context_selection (
        selection_id, session_id, activity_id, revision, trigger_input_id, location_key,
        security_namespace_id, project_scope_key, query_fingerprint, authorization_fingerprint,
        authorization_epoch, execution_fingerprint, selected_source_fingerprint,
        observed_location_mutation_epoch, next_revalidation_at, released_knowledge_binding_state,
        released_knowledge_exact_refs, released_knowledge_exact_refs_fingerprint,
        graph_revisions, graph_statuses, selected_refs, projection, projection_hash, token_count,
        artifact_write_status, inline_audit, created_at
      ) VALUES (
        ${attempt.selectionId}, ${attempt.sessionId}, ${attempt.activityId}, 0, ${inputId}, 'local',
        ${namespaceId}, ${scopeKey}, 'query', 'authorization', 0, 'execution', 'sources',
        0, ${sql`${dbNow} + 60000`}, 'unavailable', '[]',
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        '{}', '[]', '[]', '', ${attempt.projectionHash}, 0,
        'degraded_unavailable', '{}', ${dbNow}
      )
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session_provider_owner_lease
        (owner_token, registered_at, heartbeat_at, lease_expires_at, released_at)
      VALUES (${ownerToken}, ${dbNow}, ${dbNow}, ${sql`${dbNow} + 3600000`}, NULL)
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session_provider_attempt (
        attempt_id, session_id, activity_id, provider_turn_seq, attempt_version,
        execution_claim_token, selection_id, projection_hash, request_hash, provider_id,
        owner_token, state, created_at
      ) VALUES (
        ${attempt.attemptId}, ${attempt.sessionId}, ${attempt.activityId}, ${attempt.providerTurnSeq}, 0,
        ${claimToken}, ${attempt.selectionId}, ${attempt.projectionHash}, ${attempt.requestHash},
        ${attempt.providerId}, ${ownerToken}, 'prepared', ${dbNow}
      )
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session_v2_provider_turn_receipt (
        receipt_id, session_id, request_ordinal, activity_id, provider_turn_seq,
        user_message_id, history_prompt_epoch, request_input_hash, provider_id, model_id,
        protocol, owner_mode, owner_token, state, created_at
      ) VALUES (
        ${receiptId}, ${attempt.sessionId}, 1, ${attempt.activityId}, ${attempt.providerTurnSeq},
        ${inputId}, 0, ${attempt.requestHash}, ${attempt.providerId}, 'model-test',
        'chat', 'v2', ${ownerToken}, 'preparing', ${dbNow}
      )
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_provider_attempt
      SET prepared_turn_hash = ${preparedTurnHash}, wire_request_hash = ${wireRequestHash}, attempt_version = 1
      WHERE attempt_id = ${attempt.attemptId}
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_v2_provider_turn_receipt
      SET provider_attempt_id = ${attempt.attemptId}
      WHERE receipt_id = ${receiptId}
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_provider_attempt SET state = 'dispatching', attempt_version = 2
      WHERE attempt_id = ${attempt.attemptId}
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_v2_provider_turn_receipt
      SET state = 'dispatching', prepared_turn_hash = ${preparedTurnHash},
          wire_request_hash = ${wireRequestHash},
          prepared_turn = ${JSON.stringify({
            request_hash: attempt.requestHash,
            prepared_turn_hash: preparedTurnHash,
            wire_request_hash: wireRequestHash,
          })},
          dispatching_at = ${dbNow}
      WHERE receipt_id = ${receiptId}
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_provider_attempt
      SET state = 'indeterminate_after_crash', attempt_version = 3,
          error_code = 'consumer_cancelled_after_dispatch'
      WHERE attempt_id = ${attempt.attemptId}
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_v2_provider_turn_receipt
      SET state = 'indeterminate_after_crash', error_code = 'consumer_cancelled_after_dispatch',
          terminal_at = ${dbNow}
      WHERE receipt_id = ${receiptId}
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_provider_owner_lease SET released_at = ${dbNow}
      WHERE owner_token = ${ownerToken}
    `).pipe(Effect.orDie)
    return { attempt, ownerToken, claimToken, receiptId }
  })

const allDescriptors = (db: Database.Interface["db"], sessionId: string) =>
  SessionProviderRecoveryDurable.makeDurableRecoveryStore(db).listDescriptorsBySession(sessionId)

const commandState = (db: Database.Interface["db"], commandId: string) =>
  Effect.map(SessionProviderRecoveryDurable.makeDurableRecoveryStore(db).getCommand(commandId), (row) => row?.state)

/** Open the business Database over a file (full migration + startup-inventory post-verify). */
const openDatabase = (file: string) =>
  Effect.gen(function* () {
    const built = yield* Layer.build(Database.layerFromPath(file))
    return yield* Database.Service.pipe(Effect.provide(built))
  })

/**
 * "Boot": build the production executor layer over an open database. Building it runs
 * the startup drain (process boot = post-crash resume); the executor applies commands
 * through the durable store (`makeDurableRecoveryStore`) over the same db handle.
 */
const bootExecutor = (database: Database.Interface) =>
  Effect.gen(function* () {
    return yield* RecoveryExecutor.Service.pipe(
      Effect.provide(
        yield* Layer.build(
          RecoveryExecutor.layer.pipe(
            Layer.provide(Layer.succeed(Database.Service, database)),
          ),
        ),
      ),
    )
  })

describe("C1B recovery executor production wiring (W2.2)", () => {
  test("startup drain (executor layer build) applies a pending resolvable_exact command — state transition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const authority = yield* seedIndeterminateAuthority(database.db)
            const attempt = authority.attempt
            // Record the committed exit decision (pending command, user actor).
            const seeded = yield* seedPending(database.db, attempt, "exact", {
              actorType: "user",
              actorId: "operator",
              expectedOwnerToken: authority.ownerToken,
              expectedVersion: 3,
            })
            // Boot: the executor layer build runs the startup drain (the real production path).
            const executor = yield* bootExecutor(database)
            // The command moved pending → abandoned (durable state transition).
            expect(yield* commandState(database.db, seeded.commandId)).toBe("abandoned")
            // The abandon wrote its resolved(abandoned) terminal descriptor next to the original.
            const descriptors = yield* allDescriptors(database.db, attempt.sessionId)
            expect(descriptors.map((row) => row.kind).sort()).toEqual(["resolvable_exact", "resolved"])
            expect(descriptors.find((row) => row.kind === "resolved")?.payload.descriptorKind).toBe("resolved")
            // Provenance invariants of the applyExactAbandon terminal write (one transaction):
            // the terminal descriptor names its full authority chain — attempt/receipt/command
            // source refs, the resolution row as the terminal bridge, the post-CAS attempt
            // version — and is content-addressed by the authoritative descriptor digest.
            const original = descriptors.find((row) => row.payload.descriptorKind === "resolvable_exact")
            const terminal = descriptors.find((row) => row.payload.descriptorKind === "resolved")
            if (!original || !terminal) throw new Error("expected the resolvable_exact + resolved descriptor pair")
            const resolution = yield* database.db.get<
              | {
                  resolution_id: string
                  attempt_id: string
                  actor_type: string
                  actor_id: string
                  decision: string
                  reason: string
                }
              | undefined
            >(sql`
              SELECT resolution_id, attempt_id, actor_type, actor_id, decision, reason
              FROM session_provider_attempt_resolution WHERE attempt_id = ${attempt.attemptId}
            `)
            if (!resolution) throw new Error("attempt resolution row missing")
            expect({
              attempt_id: resolution.attempt_id,
              actor_type: resolution.actor_type,
              actor_id: resolution.actor_id,
              decision: resolution.decision,
              reason: resolution.reason,
            }).toEqual({
              attempt_id: attempt.attemptId,
              actor_type: "user",
              actor_id: "operator",
              decision: "abandoned",
              reason: "network_unknown",
            })
            expect(terminal.payload).toEqual({
              schemaVersion: "recovery-descriptor.v1",
              requestHash: attempt.requestHash,
              provenance: {
                origin: "recorded",
                sourceRefs: [attempt.attemptId, authority.receiptId, seeded.commandId],
              },
              baseline: original.payload.baseline,
              terminalBridge: {
                bridgeId: resolution.resolution_id,
                bridgeType: "terminal_bridge",
                terminalRef: "abandoned",
              },
              casTokens: {
                expectedState: "resolved_abandoned",
                expectedVersion: 4,
                ownerToken: authority.ownerToken,
              },
              descriptorKind: "resolved",
              resolved: {
                resolutionRef: resolution.resolution_id,
                bridgeRef: resolution.resolution_id,
                terminal: "abandoned",
              },
            })
            expect(terminal.contentHash).toBe(RecoveryCommandContract.recoveryDescriptorDigest(terminal.payload))
            expect(terminal.descriptorId).toBe(SessionProviderRecoveryDurable.recoveryDescriptorId(terminal.payload))
            expect(yield* database.db.get(sql`
              SELECT state, attempt_version, owner_token FROM session_provider_attempt
              WHERE attempt_id = ${attempt.attemptId}
            `)).toEqual({ state: "resolved_abandoned", attempt_version: 4, owner_token: authority.ownerToken })
            expect(yield* database.db.get(sql`
              SELECT state FROM session_activity WHERE activity_id = ${attempt.activityId}
            `)).toEqual({ state: "interrupted" })
            expect(yield* database.db.get(sql`
              SELECT resolution_id, attempt_id, receipt_id FROM session_v2_provider_recovery_bridge
              WHERE command_id = ${seeded.commandId}
            `)).toEqual({
              resolution_id: resolution.resolution_id,
              attempt_id: attempt.attemptId,
              receipt_id: authority.receiptId,
            })
            expect(yield* database.db.get(sql`
              SELECT execution_claim_token FROM session WHERE id = ${attempt.sessionId}
            `)).toEqual({ execution_claim_token: null })
            // Idempotence: a re-run drains nothing (the slot is terminal), and a direct
            // store re-apply reports "already" without writing new rows.
            const report = yield* executor.drain
            expect(report.scanned).toBe(0)
            expect(report.applied).toBe(0)
            const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(database.db)
            expect(yield* store.applyExactAbandon({ commandId: seeded.commandId, reason: "network_unknown" })).toBe("already")
            expect(yield* database.db.get(sql`
              SELECT count(*) AS count FROM session_provider_attempt_resolution
              WHERE attempt_id = ${attempt.attemptId}
            `)).toEqual({ count: 1 })
            expect(yield* database.db.get(sql`
              SELECT count(*) AS count FROM session_v2_provider_recovery_bridge
              WHERE command_id = ${seeded.commandId}
            `)).toEqual({ count: 1 })
            expect((yield* allDescriptors(database.db, attempt.sessionId)).map((row) => row.kind).sort()).toEqual([
              "resolvable_exact",
              "resolved",
            ])
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("kill-9 restart: a NEW connection + executor applies the pending command committed by the dead process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-crash-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      const attemptOverrides = { attemptId: "att_crash", requestHash: H64("c") }
      // Process A commits the exit decision then dies (scope closes = connection gone).
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const authority = yield* seedIndeterminateAuthority(database.db, attemptOverrides)
            yield* seedPending(database.db, authority.attempt, "exact", {
              actorType: "user",
              actorId: "operator",
              expectedOwnerToken: authority.ownerToken,
              expectedVersion: 3,
            })
          }),
        ),
      )
      // Process B boots over the same file (fresh migration-ready connection + fresh
      // in-memory recovery state) — the layer build drain applies the pending command.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const attempt = identity(attemptOverrides)
            expect(yield* database.db.get(sql`
              SELECT state, attempt_version, owner_token, execution_claim_token
              FROM session_provider_attempt WHERE attempt_id = ${attempt.attemptId}
            `)).toEqual({
              state: "indeterminate_after_crash",
              attempt_version: 3,
              owner_token: `owner_${attempt.attemptId}`,
              execution_claim_token: 918_273,
            })
            expect(yield* database.db.get(sql`
              SELECT execution_claim_token FROM session WHERE id = ${attempt.sessionId}
            `)).toEqual({ execution_claim_token: 918_273 })
            expect(yield* database.db.get(sql`
              SELECT state, owner_token, provider_attempt_id FROM session_v2_provider_turn_receipt
              WHERE provider_attempt_id = ${attempt.attemptId}
            `)).toEqual({
              state: "indeterminate_after_crash",
              owner_token: `owner_${attempt.attemptId}`,
              provider_attempt_id: attempt.attemptId,
            })
            const expected = SessionProviderRecovery.recoveryCommandContentAddress({
              requestHash: attempt.requestHash,
              attemptIdentity: attempt,
            })
            expect(yield* SessionProviderRecoveryDurable.makeDurableRecoveryStore(database.db).getCommand(expected)).toMatchObject({
              state: "pending",
              expectedOwnerToken: `owner_${attempt.attemptId}`,
              actorType: "user",
              actorId: "operator",
            })
            yield* bootExecutor(database)
            expect(yield* commandState(database.db, expected)).toBe("abandoned")
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a successor Session claim fences stale recovery without partial authority writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-claim-fence-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const authority = yield* seedIndeterminateAuthority(database.db, {
              attemptId: "att_claim_fence",
              requestHash: H64("d"),
            })
            const seeded = yield* seedPending(database.db, authority.attempt, "exact", {
              actorType: "administrator",
              actorId: "operator",
              expectedOwnerToken: authority.ownerToken,
              expectedVersion: 3,
            })
            yield* database.db.run(sql`
              UPDATE session SET execution_claim_token = 918274 WHERE id = ${authority.attempt.sessionId}
            `).pipe(Effect.orDie)

            const executor = yield* bootExecutor(database)
            const report = yield* executor.drain
            expect(report).toEqual({
              scanned: 1,
              applied: 0,
              keptPending: [
                {
                  commandId: seeded.commandId,
                  reason: "abandon_conflict:authority_conflict",
                },
              ],
              failed: [],
            })
            expect(yield* commandState(database.db, seeded.commandId)).toBe("pending")
            expect(yield* database.db.get(sql`
              SELECT state, attempt_version FROM session_provider_attempt
              WHERE attempt_id = ${authority.attempt.attemptId}
            `)).toEqual({ state: "indeterminate_after_crash", attempt_version: 3 })
            expect(yield* database.db.get(sql`
              SELECT state FROM session_activity WHERE activity_id = ${authority.attempt.activityId}
            `)).toEqual({ state: "active" })
            expect(yield* database.db.get(sql`
              SELECT count(*) AS count FROM session_v2_provider_recovery_bridge
              WHERE attempt_id = ${authority.attempt.attemptId}
            `)).toEqual({ count: 0 })
            expect(yield* database.db.get(sql`
              SELECT execution_claim_token FROM session WHERE id = ${authority.attempt.sessionId}
            `)).toEqual({ execution_claim_token: 918_274 })
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a command that cannot be applied stays pending and never blocks the boot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-keep-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const system = yield* seedPending(database.db, { ...identity(), attemptId: "att_system", requestHash: H64("s") }, "exact", { actorType: "system", actorId: "kernel" })
            const unowned = yield* seedPending(database.db, { ...identity(), attemptId: "att_unowned", requestHash: H64("u") }, "exact", {})
            const repairable = yield* seedPending(database.db, { ...identity(), attemptId: "att_repair", requestHash: H64("p") }, "repairable", { actorType: "user", actorId: "operator" })
            const fork = yield* seedPending(database.db, { ...identity(), attemptId: "att_fork", requestHash: H64("f") }, "fork", { actorType: "user", actorId: "operator" })
            const coordination = yield* seedPending(database.db, { ...identity(), attemptId: "att_coord", requestHash: H64("o") }, "coordination", { actorType: "user", actorId: "operator" })
            const resolved = yield* seedPending(database.db, { ...identity(), attemptId: "att_resolved", requestHash: H64("e") }, "resolved", { actorType: "user", actorId: "operator" })
            const orphan = yield* seedPending(database.db, { ...identity(), attemptId: "att_orphan", requestHash: H64("q") }, "exact", { actorType: "user", actorId: "operator", withDescriptor: false })
            // Boot with these rows present: no throw, no half-application.
            const executor = yield* bootExecutor(database)
            const report = yield* executor.drain
            expect(report.applied).toBe(0)
            expect(report.failed).toEqual([])
            expect(report.keptPending.map((item) => item.reason).sort()).toEqual(
              [
                "pending_command_without_actor",
                "pending_command_without_descriptor",
                "requires_admin_coordination",
                "requires_baseline_reconstruction",
                "requires_safe_boundary_history",
                "resolved_descriptor_no_exit",
                "system_actor_exit_refused",
              ].sort(),
            )
            // Every row is still pending (state preserved).
            const states = yield* Effect.all(
              [system, unowned, repairable, fork, coordination, resolved, orphan].map((row) => commandState(database.db, row.commandId)),
            )
            expect(states).toEqual(["pending", "pending", "pending", "pending", "pending", "pending", "pending"])
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("no pending commands → the drain is a no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-empty-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const executor = yield* bootExecutor(database)
            const report = yield* executor.drain
            expect(report).toEqual({ scanned: 0, applied: 0, keptPending: [], failed: [] })
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("startup drain applies a pending confirm_settled command with typed evidence — the settled exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-settled-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const authority = yield* seedIndeterminateAuthority(database.db, {
              attemptId: "att_settled",
              requestHash: H64("t"),
            })
            const attempt = authority.attempt
            const evidence = settledEvidence(attempt.providerId)
            const seeded = yield* seedPending(database.db, attempt, "exact", {
              actorType: "user",
              actorId: "operator",
              expectedOwnerToken: authority.ownerToken,
              expectedVersion: 3,
              commandKind: "confirm_settled",
              evidence,
            })
            const executor = yield* bootExecutor(database)
            expect(yield* commandState(database.db, seeded.commandId)).toBe("settled")
            // The settled resolution carries the command's typed evidence verbatim.
            const resolution = yield* database.db.get<
              | { resolution_id: string; decision: string; provider_evidence: string | null; actor_type: string; actor_id: string }
              | undefined
            >(sql`
              SELECT resolution_id, decision, provider_evidence, actor_type, actor_id
              FROM session_provider_attempt_resolution WHERE attempt_id = ${attempt.attemptId}
            `)
            expect(resolution).toMatchObject({
              decision: "settled",
              actor_type: "user",
              actor_id: "operator",
            })
            expect(JSON.parse(resolution!.provider_evidence!)).toEqual(evidence)
            // Attempt → resolved_settled (the DB trigger allows exactly this terminal move);
            // activity → settled (the CF authority's settled coordination record).
            expect(yield* database.db.get(sql`
              SELECT state, attempt_version FROM session_provider_attempt
              WHERE attempt_id = ${attempt.attemptId}
            `)).toEqual({ state: "resolved_settled", attempt_version: 4 })
            expect(yield* database.db.get(sql`
              SELECT state FROM session_activity WHERE activity_id = ${attempt.activityId}
            `)).toEqual({ state: "settled" })
            // Zero-provider property: the receipt keeps its incident evidence — the settle
            // path never fabricates a provider terminal and never dispatches anything.
            expect(yield* database.db.get(sql`
              SELECT state, outcome_hash, outcome_artifact FROM session_v2_provider_turn_receipt
              WHERE provider_attempt_id = ${attempt.attemptId}
            `)).toEqual({ state: "indeterminate_after_crash", outcome_hash: null, outcome_artifact: null })
            expect(yield* database.db.get(sql`
              SELECT resolution_id, attempt_id, receipt_id FROM session_v2_provider_recovery_bridge
              WHERE command_id = ${seeded.commandId}
            `)).toEqual({
              resolution_id: resolution!.resolution_id,
              attempt_id: attempt.attemptId,
              receipt_id: authority.receiptId,
            })
            // The terminal descriptor records terminal:"settled" with the post-CAS authority.
            const terminal = (yield* allDescriptors(database.db, attempt.sessionId)).find(
              (row) => row.payload.descriptorKind === "resolved",
            )
            if (!terminal || terminal.payload.descriptorKind !== "resolved")
              throw new Error("expected the resolved terminal descriptor")
            expect(terminal.payload.resolved.terminal).toBe("settled")
            expect(terminal.payload.casTokens).toEqual({
              expectedState: "resolved_settled",
              expectedVersion: 4,
              ownerToken: authority.ownerToken,
            })
            expect(terminal.contentHash).toBe(RecoveryCommandContract.recoveryDescriptorDigest(terminal.payload))
            expect(yield* database.db.get(sql`
              SELECT execution_claim_token FROM session WHERE id = ${attempt.sessionId}
            `)).toEqual({ execution_claim_token: null })
            // Idempotence: a re-run drains nothing; a direct store re-apply reports "already".
            const report = yield* executor.drain
            expect(report).toEqual({ scanned: 0, applied: 0, keptPending: [], failed: [] })
            const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(database.db)
            expect(yield* store.applyExactSettled({ commandId: seeded.commandId })).toBe("already")
            expect(yield* database.db.get(sql`
              SELECT count(*) AS count FROM session_provider_attempt_resolution
              WHERE attempt_id = ${attempt.attemptId}
            `)).toEqual({ count: 1 })
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a confirm_settled command without a decodable evidence body stays pending (typed reason)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-settled-evidence-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const authority = yield* seedIndeterminateAuthority(database.db, {
              attemptId: "att_settled_no_evidence",
              requestHash: H64("v"),
            })
            const seeded = yield* seedPending(database.db, authority.attempt, "exact", {
              actorType: "user",
              actorId: "operator",
              expectedOwnerToken: authority.ownerToken,
              expectedVersion: 3,
              commandKind: "confirm_settled",
            })
            const executor = yield* bootExecutor(database)
            const report = yield* executor.drain
            expect(report).toEqual({
              scanned: 1,
              applied: 0,
              keptPending: [{ commandId: seeded.commandId, reason: "confirm_settled_evidence_missing" }],
              failed: [],
            })
            expect(yield* commandState(database.db, seeded.commandId)).toBe("pending")
            expect(yield* database.db.get(sql`
              SELECT state FROM session_provider_attempt WHERE attempt_id = ${authority.attempt.attemptId}
            `)).toEqual({ state: "indeterminate_after_crash" })
            expect(yield* database.db.get(sql`
              SELECT count(*) AS count FROM session_provider_attempt_resolution
              WHERE attempt_id = ${authority.attempt.attemptId}
            `)).toEqual({ count: 0 })
            expect(yield* database.db.get(sql`
              SELECT execution_claim_token FROM session WHERE id = ${authority.attempt.sessionId}
            `)).toEqual({ execution_claim_token: 918_273 })
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a confirm_settled evidence bound to a different provider is refused without any write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-settled-binding-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const authority = yield* seedIndeterminateAuthority(database.db, {
              attemptId: "att_settled_misbound",
              requestHash: H64("w"),
            })
            const seeded = yield* seedPending(database.db, authority.attempt, "exact", {
              actorType: "user",
              actorId: "operator",
              expectedOwnerToken: authority.ownerToken,
              expectedVersion: 3,
              commandKind: "confirm_settled",
              evidence: settledEvidence("provider-someone-else"),
            })
            const executor = yield* bootExecutor(database)
            const report = yield* executor.drain
            expect(report).toEqual({
              scanned: 1,
              applied: 0,
              keptPending: [{ commandId: seeded.commandId, reason: "confirm_settled_evidence_missing" }],
              failed: [],
            })
            expect(yield* database.db.get(sql`
              SELECT state FROM session_provider_attempt WHERE attempt_id = ${authority.attempt.attemptId}
            `)).toEqual({ state: "indeterminate_after_crash" })
            expect(yield* database.db.get(sql`
              SELECT count(*) AS count FROM session_provider_attempt_resolution
              WHERE attempt_id = ${authority.attempt.attemptId}
            `)).toEqual({ count: 0 })
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
