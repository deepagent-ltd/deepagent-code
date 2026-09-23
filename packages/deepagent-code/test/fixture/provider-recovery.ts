import { Database } from "@deepagent-code/core/database/database"
import { SessionProviderRecovery } from "@deepagent-code/core/session/runner"
import { sql } from "drizzle-orm"
import { Effect } from "effect"

const hash64 = (value: string) => value.repeat(64)

/**
 * Seed the complete provider authority left by a process death. This walks the legal
 * prepared -> dispatching -> indeterminate transitions and releases the former owner,
 * so recovery tests exercise the same database fences as the production runner.
 */
export const seedIndeterminateProviderAuthority = (
  db: Database.Interface["db"],
  overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {},
) =>
  Effect.gen(function* () {
    const attempt = {
      sessionId: "ses_prod",
      attemptId: "att_prod",
      activityId: "act_prod",
      providerTurnSeq: 1,
      selectionId: "sel_1",
      projectionHash: hash64("p"),
      requestHash: hash64("r"),
      providerId: "provider-test",
      ...overrides,
    }
    const ownerToken = `owner_${attempt.attemptId}`
    const claimToken = 918_273
    const inputId = `msg_${attempt.attemptId}`
    const receiptId = `receipt_${attempt.attemptId}`
    const projectId = `project_${attempt.attemptId}`
    const namespaceId = `namespace_${attempt.attemptId}`
    const scopeKey = `scope_${attempt.attemptId}`
    const preparedTurnHash = hash64("a")
    const wireRequestHash = hash64("b")
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
      VALUES (${namespaceId}, 'implicit_local', ${hash64("n")}, ${dbNow})
    `).pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO context_project_scope_identity
        (security_namespace_id, project_scope_key, project_kind, project_identity_hash, observed_project_id, created_at)
      VALUES (${namespaceId}, ${scopeKey}, 'registered_root', ${hash64("j")}, ${projectId}, ${dbNow})
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
