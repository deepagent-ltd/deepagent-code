import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { RecoveryCommandContract } from "@deepagent-code/core/contract/recovery-command"
import {
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { eq } from "drizzle-orm"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionLegacyProviderResolution } from "@/session/legacy-provider-resolution"
import { SessionProviderResolution } from "@/session/provider-resolution"

// K-01 R-1 — the unified facade's Context-Federation route. The CF-only authority (a durable
// provider attempt + v2 turn receipt, NO legacy receipt) routes through the durable recovery
// store: classify → record → applyExactAbandon / applyExactSettled, all zero provider calls.
// The legacy-receipt routes (abandon + fork) are covered end-to-end by
// test/server/httpapi-provider-recovery.test.ts.

const H64 = (c: string) => c.repeat(64)

/** Seed the complete CF-only authority a kill-9 leaves behind (no legacy receipt anywhere). */
const seedFederationAuthority = (
  db: Database.Interface["db"],
  ids: { readonly session: string; readonly attempt: string; readonly requestHash: string },
) => {
  const ownerToken = `owner_${ids.attempt}`
  const claimToken = 424_242
  const inputId = `msg_${ids.attempt}`
  const receiptId = `receipt_${ids.attempt}`
  const activityId = `activity_${ids.attempt}`
  const selectionId = `selection_${ids.attempt}`
  const namespaceId = `namespace_${ids.attempt}`
  const scopeKey = `scope_${ids.attempt}`
  const projectId = `project_${ids.attempt}`
  const preparedTurnHash = H64("a")
  const wireRequestHash = H64("b")
  const dbNow = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`

  const seed: Effect.Effect<{ readonly ownerToken: string; readonly receiptId: string }, never> = Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES (${projectId}, '/tmp/facade-recovery', '[]', ${dbNow}, ${dbNow})
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session
        (id, project_id, slug, directory, title, version, execution_claim_token, time_created, time_updated)
      VALUES (
        ${ids.session}, ${projectId}, 'facade', '/tmp/facade-recovery', 'facade',
        'test', ${claimToken}, ${dbNow}, ${dbNow}
      )
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
      VALUES (${inputId}, ${ids.session}, '{"text":"recover"}', 'steer', 0, 0, ${dbNow})
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session_activity
        (activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at)
      VALUES (${activityId}, ${ids.session}, 0, ${inputId}, 'steer', 'active', ${dbNow})
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
      VALUES (${namespaceId}, 'local', ${scopeKey}, '/tmp/facade-recovery', ${projectId}, ${dbNow})
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
        ${selectionId}, ${ids.session}, ${activityId}, 0, ${inputId}, 'local',
        ${namespaceId}, ${scopeKey}, 'query', 'authorization', 0, 'execution', 'sources',
        0, ${sql`${dbNow} + 60000`}, 'unavailable', '[]',
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        '{}', '[]', '[]', '', ${H64("p")}, 0,
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
        ${ids.attempt}, ${ids.session}, ${activityId}, 1, 0,
        ${claimToken}, ${selectionId}, ${H64("p")}, ${ids.requestHash}, 'provider-test',
        ${ownerToken}, 'prepared', ${dbNow}
      )
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO session_v2_provider_turn_receipt (
        receipt_id, session_id, request_ordinal, activity_id, provider_turn_seq,
        user_message_id, history_prompt_epoch, request_input_hash, provider_id, model_id,
        protocol, owner_mode, owner_token, state, created_at
      ) VALUES (
        ${receiptId}, ${ids.session}, 1, ${activityId}, 1,
        ${inputId}, 0, ${ids.requestHash}, 'provider-test', 'model-test',
        'chat', 'v2', ${ownerToken}, 'preparing', ${dbNow}
      )
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_provider_attempt
      SET prepared_turn_hash = ${preparedTurnHash}, wire_request_hash = ${wireRequestHash}, attempt_version = 1
      WHERE attempt_id = ${ids.attempt}
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_v2_provider_turn_receipt
      SET provider_attempt_id = ${ids.attempt}
      WHERE receipt_id = ${receiptId}
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_provider_attempt SET state = 'dispatching', attempt_version = 2
      WHERE attempt_id = ${ids.attempt}
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      UPDATE session_v2_provider_turn_receipt
      SET state = 'dispatching', prepared_turn_hash = ${preparedTurnHash},
          wire_request_hash = ${wireRequestHash},
          prepared_turn = ${JSON.stringify({
            request_hash: ids.requestHash,
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
      WHERE attempt_id = ${ids.attempt}
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
    return { ownerToken, receiptId }
  })
  return seed
}

/** The facade service over ONE database file (all dependencies share the same connection). */
const facadeOver = (database: Database.Interface) =>
  Effect.gen(function* () {
    return yield* SessionProviderResolution.Service.pipe(
      Effect.provide(
        yield* Layer.build(
          SessionProviderResolution.layer.pipe(
            Layer.provide(Layer.succeed(Database.Service, database)),
            Layer.provide(
              SessionLegacyProviderResolution.layer.pipe(
                Layer.provide(Layer.succeed(Database.Service, database)),
                Layer.provide(EventV2Bridge.defaultLayer),
              ),
            ),
            Layer.provide(
              Session.defaultLayer.pipe(
                Layer.provide(Layer.succeed(Database.Service, database)),
                Layer.provide(EventV2Bridge.defaultLayer),
                Layer.provide(RuntimeFlags.defaultLayer),
                Layer.provide(BackgroundJob.defaultLayer),
              ),
            ),
          ),
        ),
      ),
    )
  })

const openDatabase = (file: string) =>
  Effect.gen(function* () {
    const built = yield* Layer.build(Database.layerFromPath(file))
    return yield* Database.Service.pipe(Effect.provide(built))
  })

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

describe("SessionProviderResolution facade (K-01 R-1)", () => {
  test("abandon_exact on a CF-only attempt routes to the durable federation authority", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-facade-abandon-"))
    const file = join(dir, "facade.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const ids = { session: "ses_facade_abandon", attempt: "att_facade_abandon", requestHash: H64("r") }
            yield* seedFederationAuthority(database.db, ids)
            const facade = yield* facadeOver(database)
            const outcome = yield* facade.execute({
              commandKind: "abandon_exact",
              sessionID: ids.session as never,
              attemptID: ids.attempt,
              actorID: "operator",
            })
            expect(outcome).toMatchObject({
              commandKind: "abandon_exact",
              authority: "context_federation_attempt",
              commandState: "abandoned",
              attemptState: "resolved_abandoned",
            })
            if (outcome.commandKind !== "abandon_exact" || outcome.authority !== "context_federation_attempt")
              return
            expect(
              yield* database.db.get(sql`
                SELECT state, attempt_version FROM session_provider_attempt WHERE attempt_id = ${ids.attempt}
              `),
            ).toEqual({ state: "resolved_abandoned", attempt_version: 4 })
            expect(
              yield* database.db.get(sql`
                SELECT state FROM session_activity WHERE activity_id = ${`activity_${ids.attempt}`}
              `),
            ).toEqual({ state: "interrupted" })
            // Zero provider invocation: the receipt keeps its incident evidence untouched.
            expect(
              yield* database.db.get(sql`
                SELECT state, outcome_hash FROM session_v2_provider_turn_receipt
                WHERE provider_attempt_id = ${ids.attempt}
              `),
            ).toEqual({ state: "indeterminate_after_crash", outcome_hash: null })
            const resolution = yield* database.db.get(sql`
              SELECT decision FROM session_provider_attempt_resolution WHERE attempt_id = ${ids.attempt}
            `)
            expect(resolution).toEqual({ decision: "abandoned" })
            expect(
              yield* database.db.get(sql`
                SELECT execution_claim_token FROM session WHERE id = ${ids.session}
              `),
            ).toEqual({ execution_claim_token: null })
            // The exact retry converges on the same applied exit (durable idempotency).
            const retry = yield* facade.execute({
              commandKind: "abandon_exact",
              sessionID: ids.session as never,
              attemptID: ids.attempt,
              actorID: "operator",
            })
            expect(retry).toMatchObject({ commandID: outcome.commandID, commandState: "abandoned" })
            expect(
              yield* database.db.get(sql`
                SELECT count(*) AS count FROM session_provider_attempt_resolution WHERE attempt_id = ${ids.attempt}
              `),
            ).toEqual({ count: 1 })
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("confirm_settled on a CF-only attempt applies the typed evidence durably", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-facade-settled-"))
    const file = join(dir, "facade.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const ids = { session: "ses_facade_settled", attempt: "att_facade_settled", requestHash: H64("s") }
            yield* seedFederationAuthority(database.db, ids)
            const facade = yield* facadeOver(database)
            const evidence = settledEvidence("provider-test")
            const outcome = yield* facade.execute({
              commandKind: "confirm_settled",
              sessionID: ids.session as never,
              attemptID: ids.attempt,
              actorID: "operator",
              evidence,
            })
            expect(outcome).toMatchObject({
              commandKind: "confirm_settled",
              authority: "context_federation_attempt",
              commandState: "settled",
              attemptState: "resolved_settled",
              evidenceDigest: RecoveryCommandContract.recoveryEvidenceDigest(evidence),
            })
            const resolution = yield* database.db
              .select({
                decision: SessionProviderAttemptResolutionTable.decision,
                providerEvidence: SessionProviderAttemptResolutionTable.provider_evidence,
              })
              .from(SessionProviderAttemptResolutionTable)
              .where(eq(SessionProviderAttemptResolutionTable.attempt_id, ids.attempt))
              .get()
              .pipe(Effect.orDie)
            expect(resolution?.decision).toBe("settled")
            expect(JSON.parse(resolution!.providerEvidence!)).toEqual(evidence)
            expect(
              yield* database.db
                .select({ state: SessionProviderAttemptTable.state })
                .from(SessionProviderAttemptTable)
                .where(eq(SessionProviderAttemptTable.attempt_id, ids.attempt))
                .get()
                .pipe(Effect.orDie),
            ).toEqual({ state: "resolved_settled" })
            expect(
              yield* database.db.get(sql`
                SELECT state, outcome_hash FROM session_v2_provider_turn_receipt
                WHERE provider_attempt_id = ${ids.attempt}
              `),
            ).toEqual({ state: "indeterminate_after_crash", outcome_hash: null })
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
