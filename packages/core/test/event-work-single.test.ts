import { expect, test } from "bun:test"
import { Effect, Exit, Layer, Cause, Scope } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { EventV2 } from "../src/event"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionStore } from "../src/session/store"
import { SessionProjector } from "../src/session/projector"
import { SessionContext } from "../src/context-federation/session-context"
import { PreparedProviderTurn } from "../src/session/runner/prepared-provider-turn"
import { SessionRunnerCanonical } from "../src/session/runner/canonical-turn"
import { LocalOperator } from "../src/im/local-operator"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { WorkAdmission } from "../src/session/work-admission"
import { EventWorkRule } from "../src/deepagent/event-work-rule"
import { EventWorkSource } from "../src/deepagent/event-work-source"
import { EventWorkAdmission } from "../src/deepagent/event-work-admission"
import { EventWorkResult } from "../src/deepagent/event-work-result"
import { EventAdmission } from "../src/deepagent/event-admission"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { WorkAuthorityFixture } from "./fixture/work-authority"
import { WorkRouteApprovalFixture } from "./fixture/work-route-approval"
import { EventInvestigationFixture } from "./fixture/event-investigation"
import { projectLayer } from "./fixture/project-layer"

type Services = Database.Service | SessionV2.Service | EventV2.Service | SessionContext.Service | Scope.Scope
const runtime = WorkRouteApprovalFixture.runtime
const ruleID = "rule-explicit-single"
const sourceID = "ses_ordinary_event_source"
const code = (exit: Exit.Exit<unknown, unknown>) => {
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
async function isolated(body: (f: { run: <A,E>(effect: Effect.Effect<A,E,Services>) => Promise<A>; filename: string; directory: string }) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-event-work-single-")))
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
const configure = (directory: string, beforeEnable: Effect.Effect<unknown, unknown, Services> = Effect.void) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
  const base = actor.policy.targets[0]!
  const candidate = EventInvestigationFixture.binding()
  const target = { ...base.target, version: 2 as const, location: { directory },
    scope: { ...base.target.scope, workspaceID: directory },
    profile: { id: "project_deepseek_context_bound_v1" as const, version: 1 as const, hash: WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE_HASH },
    provider: { ...base.target.provider, providerID: "deepseek", modelID: "deepseek-flash", protocol: "openai-responses",
      endpoint: "https://api.deepseek.com/responses", completion: { parameter: "max_output_tokens", maxTokens: 4096, hardLimit: true, includesReasoning: true } },
    budget: { ...WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.budget, maxProviderDispatches: 2,
      maxTotalTokens: 2_105_344, hourTokensMax: 2_105_344 }, durationMs: 300_000,
    projectScope: { ...candidate.projectScope, projectID: "global", locationKey: directory, canonicalRoot: directory,
      namespaceBindingHash: base.namespaceBindingHash }, contextPolicy: candidate.contextPolicy,
    toolPolicy: candidate.toolPolicy, childPolicy: "deny_all" as const }
  yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('global',${directory},'[]',1,1)`)
  yield* db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,v2_authority,time_created,time_updated)
    VALUES(${sourceID},'global',${sourceID},${directory},'Ordinary source','2',1,1,1)`)
  yield* db.run(sql`UPDATE context_location_identity SET location_key=${directory},canonical_root=${directory},observed_project_id='global'`)
  yield* db.run("UPDATE context_project_scope_identity SET observed_project_id='global'")
  const origin = { id: "ordinary-terminal", targetID: base.id, source: "ordinary_session_activity_terminal_v1" as const, sourceSessionID: sourceID }
  yield* db.transaction((tx) => LocalOperator.updatePolicyInTransaction(tx, { expectedRevision: actor.revision,
    now: Date.now(), policy: { version: 3, targets: [{ ...base, locationKey: directory, target }], eventOrigins: [origin] } }))
    .pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(actor)))
  const current = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
  const witness = LocalOperator.mutationWitness(current)
  const created = yield* EventWorkRule.command(db, { ruleID, requestID: "create", expectedRevision: 0, action: "create",
    originID: origin.id, instruction: "Review input.ts only. Report the result. 观察🙂", expiresAt: Date.now() + 600_000 })
    .pipe(Effect.provideService(LocalOperator.Mutation, witness))
  expect(created.rule.state).toBe("disabled")
  yield* beforeEnable
  const enabled = yield* EventWorkRule.command(db, { ruleID, requestID: "enable", expectedRevision: 1, action: "enable" })
    .pipe(Effect.provideService(LocalOperator.Mutation, witness))
  expect(enabled.rule.enabledAfterOrdinal).toBe(beforeEnable === Effect.void ? -1 : 0)
  yield* db.run(sql`UPDATE test_work_route SET configuration_hash=${target.provider.configurationHash},evidence_hash=${target.provider.evidenceHash},id=${target.provider.evidenceID}`)
  return { db, witness, rule: enabled.rule }
})
const terminalAt = (ordinal: number, requireReceipt = true) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const now = Date.now()
  yield* db.run(sql`INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created)
    VALUES('msg_source_input',${sourceID},'{"text":"ordinary source"}','queue',1,2,${now})`)
  yield* db.run(sql`INSERT INTO session_activity(activity_id,session_id,ordinal,trigger_input_id,delivery,state,created_at)
    VALUES('activity_source',${sourceID},${ordinal},'msg_source_input','queue','active',${now})`)
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
  if (!row && requireReceipt) throw new Error("Expected original terminal observation")
  return row?.receipt_id ?? ""
})
const terminal = terminalAt(1)

test("E1 zero ordinal uses an explicit SQL activation frontier and never recaptures pre-enable or re-enabled zero", async () => {
  await isolated(async (f) => {
    await f.run(Effect.gen(function* () {
      const env = yield* configure(f.directory)
      expect(env.rule.enabledAfterOrdinal).toBe(-1)
      const id = yield* terminalAt(0)
      const receipt = yield* env.db.get<{ record: string }>(sql`SELECT record FROM event_work_receipt WHERE receipt_id=${id}`)
      expect(JSON.parse(receipt!.record).source.activityOrdinal).toBe(0)
      yield* EventWorkRule.command(env.db, { ruleID, requestID: "pause-zero", expectedRevision: 2, action: "pause" })
        .pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
      const enabled = yield* EventWorkRule.command(env.db, { ruleID, requestID: "enable-existing-zero", expectedRevision: 3, action: "enable" })
        .pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
      expect(enabled.rule.enabledAfterOrdinal).toBe(0)
      expect(code(yield* env.db.transaction((tx) => EventWorkSource.read(tx, enabled.rule, "activity_source")).pipe(Effect.exit))).toBe("EVENT_WORK_SOURCE_CHANGED")
      expect((yield* env.db.get<{ count: number }>("SELECT count(*) count FROM event_work_receipt"))!.count).toBe(1)
    }))
  })
  await isolated(async (f) => {
    await f.run(Effect.gen(function* () {
      const env = yield* configure(f.directory, terminalAt(0, false))
      expect(env.rule.enabledAfterOrdinal).toBe(0)
      expect(code(yield* env.db.transaction((tx) => EventWorkSource.read(tx, env.rule, "activity_source")).pipe(Effect.exit))).toBe("EVENT_WORK_SOURCE_CHANGED")
      expect((yield* env.db.get<{ count: number }>("SELECT count(*) count FROM event_work_receipt"))!.count).toBe(0)
    }))
  })
}, 60_000)

test("E1 official additive migration/FK/UTF8 meter and cold exact reapply", () => isolated(async (f) => {
  const saved = await f.run(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    expect(yield* db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'event_work_%'")).toHaveLength(5)
    expect(yield* db.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'event_work_%_capacity_%'")).toHaveLength(10)
    yield* configure(f.directory)
    const receiptID = yield* terminal
    const meter = yield* db.get<{ records: number; bytes: number }>(sql`SELECT sum(records) records,sum(bytes) bytes FROM (${EventWorkRule.meterQuery})`)
    const physical = yield* db.all<{ name: string; type: string }>("PRAGMA table_info(event_work_receipt)")
    const bytes = yield* db.get<{ bytes: number }>(sql`SELECT ${sql.raw(physical.map((field) => /INT/i.test(field.type)
      ? `CASE WHEN "${field.name}" IS NULL THEN 0 ELSE 8 END` : `coalesce(length(CAST("${field.name}" AS BLOB)),0)`).join("+"))} bytes FROM event_work_receipt`)
    expect(bytes?.bytes).toBeGreaterThan(2000)
    expect(meter?.records).toBe(4)
    expect(meter?.bytes).toBeGreaterThan(bytes!.bytes)
    const record = yield* db.get("SELECT * FROM event_work_receipt")
    expect(Exit.isFailure(yield* db.run(sql`DELETE FROM event_work_rule WHERE rule_id=${ruleID}`).pipe(Effect.exit))).toBe(true)
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
    return { record, receiptID }
  }))
  await f.run(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* DatabaseMigration.applyOnly(db, migrations)
    expect(yield* db.get("SELECT * FROM event_work_receipt")).toEqual(saved.record)
    expect((yield* db.transaction((tx) => EventWorkAdmission.get(tx, saved.receiptID)))?.phase).toBe("observed")
  }))
}), 60_000)

test("E1 explicit rule and original terminal produce one Work/queue input under repeated actual admission", () => isolated(async (f) => {
  const saved = await f.run(Effect.gen(function* () {
    const env = yield* configure(f.directory)
    const id = yield* terminal
    const planned = yield* env.db.transaction((tx) => EventWorkAdmission.get(tx, id))
    expect((yield* WorkAuthority.lookupSession(env.db, planned!.receipt.sessionID)).kind).toBe("legacy_unbound")
    const original = yield* env.db.transaction((tx) => EventWorkAdmission.reserveInTransaction(tx, id))
    const first = yield* WorkAdmission.admitWithState({ binding: original.binding, auditedText: original.receipt.auditedText })
    expect(first.becameReady).toBe(true)
    const again = yield* WorkAdmission.admitWithState({ binding: original.binding, auditedText: original.receipt.auditedText })
    expect(again.input).toEqual(first.input)
    expect(again.becameReady).toBe(false)
    const envelope = EventWorkAdmission.envelopeFor(original.receipt, original.rule)
    const calls = { value: 0 }
    const database = yield* Database.Service
    const sessions = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const input = { envelope, sessionID: original.receipt.sessionID, messageID: original.receipt.inputID,
      delivery: "queue" as const, resume: false, now: original.receipt.createdAt, adapter: { admit: () => Effect.gen(function* () {
        calls.value++
        const admitted = yield* WorkAdmission.admitWithState({ binding: original.binding, auditedText: original.receipt.auditedText })
        return { messageID: admitted.input.id }
      }).pipe(Effect.provideService(Database.Service, database), Effect.provideService(SessionV2.Service, sessions),
        Effect.provideService(EventV2.Service, events)) } }
    yield* EventAdmission.admit(env.db, input)
    yield* EventAdmission.admit(env.db, input)
    expect(calls.value).toBe(1)
    expect((yield* EventAdmission.admissionFor(env.db, envelope.eventRef))?.messageID).toBe(original.receipt.inputID)
    expect(yield* env.db.get("SELECT count(*) n FROM work_execution")).toEqual({ n: 1 })
    expect(yield* env.db.get(sql`SELECT count(*) n FROM session_input WHERE session_id=${original.receipt.sessionID}`)).toEqual({ n: 1 })
    expect((yield* env.db.transaction((tx) => EventWorkAdmission.get(tx, id)))?.phase).toBe("ready")
    expect(yield* env.db.transaction((tx) => EventWorkRule.observeInTransaction(tx, { sessionID: sourceID, activityID: "activity_source" }))).toEqual([])
    expect(yield* env.db.get("SELECT count(*) n FROM session_provider_attempt")).toEqual({ n: 1 })
    return original
  }))
  await f.run(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    expect((yield* db.transaction((tx) => EventWorkAdmission.requireSource(tx, saved.receipt.receiptID))).bindingHash).toBe(saved.bindingHash)
    expect((yield* db.transaction((tx) => EventWorkResult.read(tx, saved.receipt.receiptID)))?.work?.admission_state).toBe("ready")
    expect(yield* db.get("SELECT count(*) n FROM work_dispatch_reservation")).toEqual({ n: 0 })
  }))
}), 60_000)

test("E1 unknown/mismatched provider/tool/source facts cannot capture or grant an event", () => isolated(async (f) => {
  await f.run(Effect.gen(function* () {
    const env = yield* configure(f.directory)
    const id = yield* terminal
    for (const statement of ["UPDATE session_provider_attempt SET state='indeterminate_after_crash'",
      "UPDATE session_v2_provider_turn_receipt SET owner_mode='shadow_v2'"]) {
      // These terminal facts are physically immutable. Failure before the source read is
      // asserted independently; it cannot be mistaken for the source-revocation oracle.
      expect(Exit.isFailure(yield* env.db.run(statement).pipe(Effect.exit))).toBe(true)
    }
    const sourceDenied = yield* env.db.transaction((tx) => Effect.gen(function* () {
      yield* tx.run("UPDATE session SET parent_id='foreign' WHERE id='ses_ordinary_event_source'")
      expect(code(yield* EventWorkAdmission.requireSource(tx, id).pipe(Effect.exit))).toBe("EVENT_WORK_SOURCE_CHANGED")
      return yield* Effect.fail("rollback controlled negative")
    })).pipe(Effect.exit)
    expect(Exit.isFailure(sourceDenied)).toBe(true)
    yield* env.db.run("INSERT INTO session_v2_tool_effect_admission(admission_id,session_id,provider_attempt_id,receipt_id,tool_call_id,tool_name,effect_kind,owner_token,time_created) VALUES('unknown-tool','ses_ordinary_event_source','source_attempt','source_receipt','call','write','mutating','source_owner',1)")
    expect(code(yield* env.db.transaction((tx) => EventWorkAdmission.reserveInTransaction(tx, id)).pipe(Effect.exit))).toBe("EVENT_WORK_SOURCE_CHANGED")
    expect(yield* env.db.get("SELECT count(*) n FROM work_execution")).toEqual({ n: 0 })
  }))
}), 60_000)

test("E1 exact command conflict, original expiry and late revocation roll back reservation; history stays denied", () => isolated(async (f) => {
  await f.run(Effect.gen(function* () {
    const env = yield* configure(f.directory)
    const id = yield* terminal
    expect(code(yield* EventWorkRule.command(env.db, { ruleID, requestID: "enable", expectedRevision: 1, action: "pause" })
      .pipe(Effect.provideService(LocalOperator.Mutation, env.witness), Effect.exit))).toBe("EVENT_WORK_CONFLICT")
    const before = yield* env.db.get("SELECT record_hash FROM event_work_receipt")
    const closed = CanonicalJson.stringify({ ...env.rule, state: "paused" })
    const literal = "'" + closed.replaceAll("'", "''") + "'"
    yield* env.db.run(`CREATE TRIGGER late_event_revoke BEFORE INSERT ON work_execution BEGIN UPDATE event_work_rule
      SET state='paused',record=${literal},record_hash='${EventWorkSource.hash({ ...env.rule, state: "paused" })}',
      record_bytes=${Buffer.byteLength(closed, "utf8")} WHERE rule_id='${ruleID}'; END`)
    expect(Exit.isFailure(yield* env.db.transaction((tx) => EventWorkAdmission.reserveInTransaction(tx, id)).pipe(Effect.exit))).toBe(true)
    expect(yield* env.db.get("SELECT count(*) n FROM work_execution")).toEqual({ n: 0 })
    expect(yield* env.db.get("SELECT state FROM event_work_rule")).toEqual({ state: "enabled" })
    expect(yield* env.db.get("SELECT record_hash FROM event_work_receipt")).toEqual(before)
    yield* env.db.run("DROP TRIGGER late_event_revoke")
    const paused = yield* EventWorkRule.command(env.db, { ruleID, requestID: "pause", expectedRevision: 2, action: "pause" })
      .pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
    expect(paused.rule.epoch).toBe(3)
    expect(code(yield* env.db.transaction((tx) => EventWorkAdmission.reserveInTransaction(tx, id)).pipe(Effect.exit))).toBe("EVENT_WORK_SOURCE_CHANGED")
    expect((yield* env.db.transaction((tx) => EventWorkAdmission.get(tx, id)))?.phase).toBe("observed")
    expect(yield* env.db.all("PRAGMA foreign_key_check")).toEqual([])
  }))
}), 60_000)
