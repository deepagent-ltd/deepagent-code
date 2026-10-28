import { expect } from "bun:test"
import { Effect, Exit, Layer, Cause, Scope } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import { migrations } from "../../src/database/migration.gen"
import { EventV2 } from "../../src/event"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionStore } from "../../src/session/store"
import { SessionTable } from "../../src/session/sql"
import { SessionProjector } from "../../src/session/projector"
import { SessionContext } from "../../src/context-federation/session-context"
import { PreparedProviderTurn } from "../../src/session/runner/prepared-provider-turn"
import { SessionRunnerCanonical } from "../../src/session/runner/canonical-turn"
import { LocalOperator } from "../../src/im/local-operator"
import { WorkAuthority } from "../../src/session/work-authority"
import { WorkAuthorityPolicy } from "../../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../../src/session/work-authority.schema"
import { WorkAdmission } from "../../src/session/work-admission"
import { EventWorkRule } from "../../src/deepagent/event-work-rule"
import { EventWorkSource } from "../../src/deepagent/event-work-source"
import { EventWorkAdmission } from "../../src/deepagent/event-work-admission"
import { EventWorkDagSchema } from "../../src/deepagent/event-work-dag.schema"
import { EventWorkDagPolicy } from "../../src/deepagent/event-work-dag.policy"
import { EventWorkResult } from "../../src/deepagent/event-work-result"
import { EventAdmission } from "../../src/deepagent/event-admission"
import { CanonicalJson } from "../../src/util/canonical-json"
import { Hash } from "../../src/util/hash"
import { WorkAuthorityFixture } from "./work-authority"
import { WorkRouteApprovalFixture } from "./work-route-approval"
import { EventInvestigationFixture } from "./event-investigation"
import { projectLayer } from "./project-layer"

type Services = Database.Service | SessionV2.Service | EventV2.Service | SessionContext.Service | Scope.Scope
const runtime = WorkRouteApprovalFixture.runtime
const ruleID = "rule-explicit-single"
const sourceID = "ses_ordinary_event_source"
export const code = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return error && typeof error === "object" && "code" in error ? error.code : "unexpected"
}
const verifier = Layer.effect(WorkAuthority.Verifier, Effect.gen(function* () {
  const original = yield* WorkAuthority.Verifier
  return { ...original, authorizeSource: (tx, binding) => EventWorkAdmission.authorizeSource(tx, binding)
    .pipe(Effect.mapError(() => new WorkAuthoritySchema.Error({ code: "WORK_REVOKED", message: "Controlled original source unavailable" }))) }
})).pipe(Layer.provide(WorkAuthorityFixture.verifier))

// Actual file SQLite, official migrations, LocalOperator commands, Work reservation and original
// Session/Input admission. Source terminal/provider rows and route approval are controlled durable
// fixtures, never claims of Native/external LLM execution; this module starts no runner/provider.
export async function isolated(body: (f: { run: <A,E>(effect: Effect.Effect<A,E,Services>) => Promise<A>; filename: string; directory: string }) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-event-work-dag-")))
  const directory = path.join(root, "project")
  await fs.mkdir(directory)
  const filename = path.join(root, "authority.sqlite")
  const database = WorkAuthorityFixture.database(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const sessions = SessionV2.layer.pipe(Layer.provide(Layer.mergeAll(database, events, store, SessionExecution.noopLayer, projectLayer(database))))
  const projector = SessionProjector.layer.pipe(Layer.provide(Layer.mergeAll(database, events)))
  const contexts = SessionContext.layer.pipe(Layer.provide(Layer.mergeAll(database, SessionRunnerCanonical.degradedArtifactStore)))
  const services = Layer.mergeAll(database, events, sessions, projector, contexts, verifier)
  const run = <A,E>(effect: Effect.Effect<A,E,Services>) => Effect.runPromise(Effect.gen(function* () {
    yield* (yield* Database.Service).db.run("PRAGMA foreign_keys=ON")
    return yield* effect
  }).pipe(
    Effect.provideService(LocalOperator.Runtime, runtime), Effect.provide(services), Effect.scoped))
  try {
    await run(WorkRouteApprovalFixture.initialize)
    await body({ run, filename, directory })
  } finally {
    await fs.rm(root, { recursive: true })
    expect(await Bun.file(filename).exists()).toBe(false)
  }
}
export const configure = (directory: string, plan: EventWorkDagSchema.Plan) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
  const base = actor.policy.targets[0]!
  const candidate = EventInvestigationFixture.binding()
  const targetAgent = base.target.agentID
  const nodeBudget = { ...WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.budget, maxProviderDispatches: 1, maxToolCalls: 1, maxTotalTokens: 1_052_672, hourTokensMax: 1_052_672, maxChildren: 0 }
  const target = { ...base.target, version: 2 as const, location: { directory },
    scope: { ...base.target.scope, workspaceID: directory },
    profile: { id: "event_deepseek_dag_v1" as const, version: 1 as const, hash: WorkAuthorityPolicy.EVENT_DAG_PROFILE_HASH },
    provider: { ...base.target.provider, providerID: "deepseek", modelID: "deepseek-flash", protocol: "openai-responses",
      endpoint: "https://api.deepseek.com/responses", completion: { parameter: "max_output_tokens", maxTokens: 4096, hardLimit: true, includesReasoning: true } },
    budget: { ...WorkAuthorityPolicy.EVENT_DAG_PROFILE.budget, maxProviderDispatches: 4, maxChildren: 4,
      maxTotalTokens: 4_210_688, hourTokensMax: 4_210_688 }, durationMs: 300_000,
    projectScope: { ...candidate.projectScope, projectID: "global", locationKey: directory, canonicalRoot: directory,
      namespaceBindingHash: base.namespaceBindingHash }, contextPolicy: candidate.contextPolicy,
    toolPolicy: candidate.toolPolicy, childPolicy: { kind: "event_dag_v1" as const, maxConcurrent: 2, agents: [...new Set(plan.nodes.map((node) => node.agentID))], toolIDs: ["read"], budget: nodeBudget } }
  yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('global',${directory},'[]',1,1)`)
  yield* db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,v2_authority,time_created,time_updated)
    VALUES(${sourceID},'global',${sourceID},${SessionTable.directory.mapToDriverValue(directory)},'Ordinary source','2',1,1,1)`)
  yield* db.run(sql`UPDATE context_location_identity SET location_key=${directory},canonical_root=${directory},observed_project_id='global'`)
  yield* db.run("UPDATE context_project_scope_identity SET observed_project_id='global'")
  const origin = { id: "ordinary-terminal", targetID: base.id, source: "ordinary_session_activity_terminal_v1" as const, sourceSessionID: sourceID, execution: { kind: "dag" as const, plan } }
  yield* db.transaction((tx) => LocalOperator.updatePolicyInTransaction(tx, { expectedRevision: actor.revision,
    now: Date.now(), policy: { version: 4, targets: [{ ...base, locationKey: directory, target }], eventOrigins: [origin] } }))
    .pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(actor)))
  const current = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
  const witness = LocalOperator.mutationWitness(current)
  const created = yield* EventWorkRule.command(db, { ruleID, requestID: "create", expectedRevision: 0, action: "create",
    originID: origin.id, instruction: "Review input.ts only. Report the result. 观察🙂", expiresAt: Date.now() + 600_000 })
    .pipe(Effect.provideService(LocalOperator.Mutation, witness))
  expect(created.rule.state).toBe("disabled")
  const enabled = yield* EventWorkRule.command(db, { ruleID, requestID: "enable", expectedRevision: 1, action: "enable" })
    .pipe(Effect.provideService(LocalOperator.Mutation, witness))
  expect(enabled.rule.enabledAfterOrdinal).toBe(-1)
  yield* db.run(sql`UPDATE test_work_route SET configuration_hash=${target.provider.configurationHash},evidence_hash=${target.provider.evidenceHash},id=${target.provider.evidenceID}`)
  return { db, witness, rule: enabled.rule }
})
export const terminal = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const now = Date.now()
  yield* db.run(sql`INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created)
    VALUES('msg_source_input',${sourceID},'{"text":"ordinary source"}','queue',1,2,${now})`)
  yield* db.run(sql`INSERT INTO session_activity(activity_id,session_id,ordinal,trigger_input_id,delivery,state,created_at)
    VALUES('activity_source',${sourceID},1,'msg_source_input','queue','active',${now})`)
  yield* db.run(sql`INSERT INTO session_activity_input(activity_id,input_id,ordinal,admitted_seq,role,promoted_at)
    VALUES('activity_source','msg_source_input',1,1,'trigger',${now})`)
  yield* db.run(sql`INSERT INTO session_message(id,session_id,type,seq,data,time_created,time_updated)
    VALUES('msg_source_final',${sourceID},'assistant',3,${JSON.stringify({ finish: "stop", error: null, text: "Original completed result🙂" })},${now},${now})`)
  yield* db.run(sql`INSERT INTO session_context_selection(selection_id,session_id,activity_id,revision,trigger_input_id,location_key,
    query_fingerprint,authorization_fingerprint,authorization_epoch,execution_fingerprint,selected_source_fingerprint,
    observed_location_mutation_epoch,next_revalidation_at,graph_revisions,graph_statuses,selected_refs,projection,projection_hash,token_count,
    artifact_write_status,inline_audit,security_namespace_id,project_scope_key,released_knowledge_binding_state,released_knowledge_exact_refs,released_knowledge_exact_refs_fingerprint,created_at) SELECT 'selection_source',${sourceID},'activity_source',1,'msg_source_input',directory,
      'query','auth',1,'execution','source',0,${now+10000},'{}','{}','[]','{}',${"e".repeat(64)},2,'degraded_unavailable','{}','task-namespace','task-project','unavailable','[]',${Hash.sha256("[]")},${now}
      FROM session WHERE id=${sourceID}`)
  yield* db.run("INSERT INTO session_provider_owner_lease(owner_token,registered_at,heartbeat_at,lease_expires_at) VALUES('source_owner',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+600000)")
  const prepared = PreparedProviderTurn.prepare({ sessionID: sourceID, requestOrdinal: 1, activityID: "activity_source", providerTurnSeq: 1,
    owner: "v2", stableSystemParts: [], volatileSystemParts: [], historyMessages: [], historyPromptEpoch: 1, historySourceEndMessageID: null,
    contextSelectionID: "selection_source", contextProjectionHash: "e".repeat(64), contextReadiness: "ready", contextSelectedRefs: [],
    toolRegistryIDs: [], toolPermissionFilteredIDs: [], toolFinalOfferedIDs: [], toolDefinitions: {}, toolChoice: "none", toolCapability: "supported",
    toolLoweringOutcome: "ok", toolResultReferences: [], samplingModelID: "deepseek-flash", samplingProviderID: "deepseek",
    budget: { decision: "ok", estimatedFullRequestTokens: 1, physicalInputBudget: 100, reservedOutputTokens: 10, safetyMargin: 0, provenance: "host_guard" },
    wireRequest: {}, wireRequestHash: "f".repeat(64), receiptID: "source_receipt", providerAttemptID: "source_attempt", userMessageID: "msg_source_input", preparedAt: now })
  yield* db.run(sql`INSERT INTO session_provider_attempt(attempt_id,session_id,activity_id,provider_turn_seq,selection_id,
    projection_hash,request_hash,provider_id,owner_token,state,created_at)
    VALUES('source_attempt',${sourceID},'activity_source',1,'selection_source',${"e".repeat(64)},${prepared.request_hash},'deepseek','source_owner','prepared',${now})`)
  yield* db.run(sql`INSERT INTO session_v2_provider_turn_receipt(receipt_id,session_id,request_ordinal,activity_id,provider_turn_seq,
    provider_attempt_id,user_message_id,history_prompt_epoch,request_input_hash,provider_id,model_id,protocol,owner_mode,owner_token,state,created_at)
    VALUES('source_receipt',${sourceID},1,'activity_source',1,'source_attempt','msg_source_input',1,${prepared.request_hash},'deepseek','deepseek-flash','openai-responses','v2','source_owner','preparing',${now})`)
  yield* db.run(sql`UPDATE session_provider_attempt SET prepared_turn_hash=${prepared.prepared_turn_hash},wire_request_hash=${prepared.wire_request_hash} WHERE attempt_id='source_attempt'`)
  yield* db.run("UPDATE session_provider_attempt SET state='dispatching' WHERE attempt_id='source_attempt'")
  yield* db.run(sql`UPDATE session_v2_provider_turn_receipt SET state='dispatching',prepared_turn_hash=${prepared.prepared_turn_hash},
    wire_request_hash=${prepared.wire_request_hash},prepared_turn=${CanonicalJson.stringify(prepared)},dispatching_at=${now} WHERE receipt_id='source_receipt'`)
  yield* db.run(sql`UPDATE session_provider_attempt SET state='settled',settled_at=${now} WHERE attempt_id='source_attempt'`)
  yield* db.run(sql`UPDATE session_v2_provider_turn_receipt SET state='settled',outcome_hash=${"a".repeat(64)},outcome_artifact='[]',terminal_at=${now} WHERE receipt_id='source_receipt'`)
  // Original production terminal commit also captures the data-only occurrence.
  yield* (yield* SessionContext.Service).settleActivity({ activityId: "activity_source", state: "settled", finalMessageId: "msg_source_final" })
  const row = yield* db.get<{ receipt_id: string }>("SELECT receipt_id FROM event_work_receipt")
  if (!row) throw new Error("Expected original terminal observation")
  return row.receipt_id
})
