export * as WorkAuthorityFixture from "./work-authority"

import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import { migrations } from "../../src/database/migration.gen"
import { WorkAuthority } from "../../src/session/work-authority"
import { WorkAuthorityPolicy } from "../../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../../src/session/work-authority.schema"
import { Hash } from "../../src/util/hash"

export const TEXT = "review this text"
export const NOW = 1_000
export const binding = (suffix = "one"): WorkAuthoritySchema.Binding => ({
  schemaVersion: "work-execution.v1",
  workID: `work-${suffix}`,
  rootWorkID: `work-${suffix}`,
  attemptKey: `attempt-${suffix}`,
  source: {
    kind: "server_operator",
    authorityID: "operator-one",
    authorityRevision: 1,
    sourceID: `event-${suffix}`,
    requestID: `request-${suffix}`,
    requestHash: "a".repeat(64),
  },
  envelopeHash: "b".repeat(64),
  scope: {
    actorID: "actor-one",
    workspaceID: "workspace-one",
    securityNamespaceID: "namespace-one",
    projectScopeKey: "project-one",
  },
  location: { directory: "/tmp/work-authority-project" },
  agentID: "build",
  sessionID: `ses_work_${suffix}`,
  inputID: `msg_work_${suffix}`,
  profile: {
    id: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.id,
    version: 1,
    hash: WorkAuthorityPolicy.TEXT_ONLY_PROFILE_HASH,
  },
  auditedText: { hash: Hash.sha256(TEXT), utf8Bytes: Buffer.byteLength(TEXT), snapshotRef: `audited://${suffix}` },
  contextPolicy: "static_instructions_and_audited_text",
  toolPolicy: "deny_all",
  childPolicy: "deny_all",
  provider: {
    providerID: "test-provider",
    modelID: "deterministic",
    protocol: "openai-chat",
    routeID: "route-one",
    configurationHash: "c".repeat(64),
    endpoint: "https://example.test/v1/chat/completions",
    evidenceID: "route-one",
    evidenceHash: "d".repeat(64),
    endpointPinned: true,
    redirectsDenied: true,
    transportRetriesDenied: true,
    completion: { parameter: "max_completion_tokens", hardLimit: true, includesReasoning: true, maxTokens: 4_096 },
  },
  budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, maxTotalTokens: 8_000 },
  deadline: NOW + 100_000,
})

// The verifier is a controlled HOST boundary backed by actual local SQL records. This does not
// claim production operator/rule management or a real provider capability resolver is implemented.
export const verifier = Layer.succeed(WorkAuthority.Verifier, {
  authorizeSource: (tx, input) =>
    Effect.gen(function* () {
      const rows = yield* tx
        .all<{
          revision: number
          record_hash: string
          enabled: number
        }>(sql`SELECT revision, record_hash, enabled FROM test_work_source WHERE id = ${input.source.authorityID}`)
        .pipe(Effect.orDie)
      if (!rows[0]?.enabled)
        return yield* new WorkAuthoritySchema.Error({ code: "WORK_REVOKED", message: "Source authority was revoked" })
      return { authorityID: input.source.authorityID, revision: rows[0].revision, recordHash: rows[0].record_hash }
    }),
  resolveRoute: (tx, input) =>
    Effect.gen(function* () {
      const rows = yield* tx
        .all<{
          evidence_hash: string
          configuration_hash: string
          enabled: number
        }>(sql`SELECT evidence_hash, configuration_hash, enabled FROM test_work_route WHERE id = ${input.provider.evidenceID}`)
        .pipe(Effect.orDie)
      if (!rows[0]?.enabled)
        return yield* new WorkAuthoritySchema.Error({
          code: "PROFILE_UNAVAILABLE",
          message: "Route evidence is unavailable",
        })
      return {
        evidenceID: input.provider.evidenceID,
        evidenceHash: rows[0].evidence_hash,
        configurationHash: rows[0].configuration_hash,
      }
    }),
})

export function database(filename: string) {
  // Direct actual SQLite/Drizzle reopening isolates this store oracle from application bootstrap
  // recovery. Full SessionExecution/provider recovery is the separately owned integration slice.
  return Layer.effect(Database.Service, EffectDrizzleSqlite.makeWithDefaults().pipe(Effect.map((db) => ({ db })))).pipe(
    Layer.provide(SqliteClient.layer({ filename })),
  )
}

export const initialize = Effect.fn("WorkAuthorityFixture.initialize")(function* () {
  const db = (yield* Database.Service).db
  yield* db.run("PRAGMA foreign_keys=ON")
  yield* DatabaseMigration.applyOnly(db, migrations)
  yield* db.run("PRAGMA journal_mode=WAL")
  yield* db.run("PRAGMA synchronous=FULL")
  yield* db.run(
    "CREATE TABLE test_work_source (id text PRIMARY KEY, revision integer, record_hash text, enabled integer)",
  )
  yield* db.run(sql`INSERT INTO test_work_source VALUES ('operator-one', 1, ${"f".repeat(64)}, 1)`)
  yield* db.run(
    "CREATE TABLE test_work_route (id text PRIMARY KEY, evidence_hash text, configuration_hash text, enabled integer)",
  )
  yield* db.run(sql`INSERT INTO test_work_route VALUES ('route-one', ${"d".repeat(64)}, ${"c".repeat(64)}, 1)`)
})

/** Populate the real Session/inbox/Context/attempt/receipt tables. These fixture rows represent
 * the caller transaction contracts; the store tests do not claim to execute a Session runner. */
export const materialize = Effect.fn("WorkAuthorityFixture.materialize")(function* (
  input: WorkAuthoritySchema.Binding,
  prompt: Record<string, unknown> = { text: TEXT },
) {
  const db = (yield* Database.Service).db
  yield* db.run(
    sql`INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('project-work', ${input.location.directory}, '[]', ${NOW}, ${NOW})`,
  )
  yield* db.run(
    sql`INSERT INTO session (id,project_id,slug,directory,title,version,v2_authority,agent,model,execution_claim_token,time_created,time_updated) VALUES (${input.sessionID},'project-work',${input.sessionID},${input.location.directory},'Work fixture','2',1,${input.agentID},${JSON.stringify({ id: input.provider.modelID, providerID: input.provider.providerID })},7,${NOW},${NOW})`,
  )
  yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* tx.run(
          sql`INSERT INTO session_input (id,session_id,prompt,delivery,admitted_seq,time_created) VALUES (${input.inputID},${input.sessionID},${JSON.stringify(prompt)},'queue',1,${NOW})`,
        )
        yield* WorkAuthority.bindInputInTransaction(tx, {
          workID: input.workID,
          inputID: input.inputID,
          sessionID: input.sessionID,
          promptHash: input.auditedText.hash,
          admittedSeq: 1,
          expectedRevision: 1,
          now: NOW,
        })
      }),
    { behavior: "immediate" },
  )
  const activity = `activity-${input.workID}`
  const selection = `selection-${input.workID}`
  const owner = `owner-${input.workID}`
  yield* db.run(
    sql`INSERT INTO session_activity (activity_id,session_id,ordinal,trigger_input_id,delivery,state,created_at) VALUES (${activity},${input.sessionID},1,${input.inputID},'queue','active',${NOW})`,
  )
  yield* db.run(
    sql`INSERT OR IGNORE INTO context_security_namespace (id,kind,binding_hash,created_at) VALUES (${input.scope.securityNamespaceID},'implicit_local',${input.scope.securityNamespaceID},${NOW})`,
  )
  yield* db.run(
    sql`INSERT OR IGNORE INTO context_project_scope_identity (security_namespace_id,project_scope_key,project_kind,project_identity_hash,created_at) VALUES (${input.scope.securityNamespaceID},${input.scope.projectScopeKey},'registered_root','fixture-project',${NOW})`,
  )
  yield* db.run(
    sql`INSERT OR IGNORE INTO context_location_identity (security_namespace_id,location_key,project_scope_key,canonical_root,created_at) VALUES (${input.scope.securityNamespaceID},${input.location.directory},${input.scope.projectScopeKey},${input.location.directory},${NOW})`,
  )
  yield* db.run(
    sql`INSERT INTO session_context_selection (selection_id,session_id,activity_id,revision,trigger_input_id,location_key,query_fingerprint,authorization_fingerprint,authorization_epoch,execution_fingerprint,selected_source_fingerprint,observed_location_mutation_epoch,next_revalidation_at,graph_revisions,graph_statuses,selected_refs,projection,projection_hash,token_count,artifact_write_status,inline_audit,security_namespace_id,project_scope_key,released_knowledge_binding_state,released_knowledge_exact_refs,released_knowledge_exact_refs_fingerprint,created_at) VALUES (${selection},${input.sessionID},${activity},1,${input.inputID},${input.location.directory},'query','auth',1,'execution','source',0,1000000,'{}','{}','[]','{}',${"e".repeat(64)},100,'degraded_unavailable','{}',${input.scope.securityNamespaceID},${input.scope.projectScopeKey},'unavailable','[]',${Hash.sha256("[]")},${NOW})`,
  )
  yield* db.run(
    sql`INSERT INTO session_provider_owner_lease (owner_token,registered_at,heartbeat_at,lease_expires_at) VALUES (${owner},CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)+600000)`,
  )
  yield* db.run(
    sql`INSERT INTO session_provider_attempt (attempt_id,session_id,activity_id,provider_turn_seq,execution_claim_token,selection_id,projection_hash,request_hash,provider_id,owner_token,state,created_at) VALUES (${input.attemptKey},${input.sessionID},${activity},1,7,${selection},${"e".repeat(64)},'request',${input.provider.providerID},${owner},'prepared',${NOW})`,
  )
  yield* db.run(
    sql`INSERT INTO session_v2_provider_turn_receipt (receipt_id,session_id,request_ordinal,activity_id,provider_turn_seq,provider_attempt_id,user_message_id,history_prompt_epoch,request_input_hash,provider_id,model_id,protocol,owner_mode,owner_token,state,created_at) VALUES (${`receipt-${input.workID}`},${input.sessionID},1,${activity},1,${input.attemptKey},${input.inputID},1,'request',${input.provider.providerID},${input.provider.modelID},${input.provider.protocol},'v2',${owner},'preparing',${NOW})`,
  )
})

export const dispatch = (input: WorkAuthoritySchema.Binding): WorkAuthority.ReserveDispatchInput => ({
  workID: input.workID,
  dispatchKey: "turn-one",
  receiptID: `receipt-${input.workID}`,
  attemptID: input.attemptKey,
  sessionClaimToken: 7,
  ownerToken: `owner-${input.workID}`,
  contextSelectionID: `selection-${input.workID}`,
  contextProjectionHash: "e".repeat(64),
  inputUpperBound: { tokens: 1_024, kind: "conservative", evidenceID: "input-bound-one", evidenceHash: "e".repeat(64) },
  completionTokens: 4_096,
  expectedRevision: 1,
  now: NOW,
})

export const seal = (reservation: WorkAuthority.Reservation) => ({
  reservationID: reservation.reservation_id,
  expectedRevision: reservation.control_revision,
  wireHash: "a".repeat(64),
  method: "POST",
  endpoint: "https://example.test/v1/chat/completions",
  contextSelectionID: reservation.context_selection_id,
  contextProjectionHash: reservation.context_projection_hash,
  now: NOW,
})
