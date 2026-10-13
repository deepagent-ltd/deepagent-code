export * as NativeWorkKnownRecoveryV2 from "./work-known-recovery-v2"

import { createHmac, timingSafeEqual } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { LLM, LLMClient } from "@deepagent-code/llm"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { Database } from "@deepagent-code/core/database/database"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { V2ToolEffectTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { V2ToolEffectAdmissionTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { WorkTaskKnownProof } from "@deepagent-code/core/session/work-task-known-proof"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { WorkKnownRecoveryV2 } from "@deepagent-code/core/session/work-known-recovery-v2"
import { WorkKnownRecoveryV2Table } from "@deepagent-code/core/session/work-known-recovery-v2.sql"
import { WorkKnownRecoverySchema } from "@deepagent-code/core/session/work-known-recovery.schema"
import { WorkKnownRecoveryV2Schema } from "@deepagent-code/core/session/work-known-recovery-v2.schema"
import { WorkRouteApproval } from "@deepagent-code/core/session/work-route-approval"
import { WorkRouteApprovalSchema } from "@deepagent-code/core/session/work-route-approval.schema"
import { LocalTaskAuthority } from "../im/local-task-authority"
import { NativeRuntime } from "./native-runtime"
import { ProviderCredentialBinding } from "./provider-credential-binding"
import { WorkProviderContract } from "./work-provider-contract"

const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const refused = () => WorkKnownRecoveryV2.failure("RECOVERY_UNAVAILABLE")

/** Invoked only inside the existing host Root with a real authenticated Mutation witness.
 * It creates no Root, Session, grant or provider loop. Historical retries never enter prepare. */
const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const installed = yield* WorkExecutionProfile.Services
  const native = yield* NativeRuntime.Service
  const locations = yield* LocationServiceMap
  const sessions = yield* SessionStore.Service
  const execution = yield* SessionExecution.Service
  const installation = yield* LocalTaskAuthority.readInstallation.pipe(Effect.mapError(refused))
  const secret = Buffer.from(installation.secret, "hex")
  const lifetime = { active: true }
  const entries = new WeakMap<WorkKnownRecoveryV2.Prepared, {
    request: WorkKnownRecoveryV2Schema.Request
    resume?: { recovery: WorkKnownRecoveryV2Schema.Record; request: WorkKnownRecoveryV2Schema.ResumeRequest }
    observation: WorkKnownRecoveryV2.Observation
    capture: ProviderCredentialBinding.Capture
    approval: WorkRouteApprovalSchema.Record
    startedAt: number
  }>()
  const live = new Set<WorkKnownRecoveryV2.Prepared>()
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    lifetime.active = false; live.forEach((entry) => entries.delete(entry)); live.clear(); secret.fill(0)
  }))
  const credentials = Context.get(yield* Layer.build(ProviderCredentialBinding.layer.pipe(
    Layer.provide(WorkProviderContract.layer), Layer.provide(Layer.succeed(NativeRuntime.Service, native)),
  )), ProviderCredentialBinding.Service)
  const services = yield* Layer.build(WorkExecutionProfile.servicesLayer(installed))
  const context = Context.merge(yield* Effect.context<Scope.Scope | LocalOperator.Runtime | LocalOperator.Mutation>(), services)
  const mac = (domain: string, record: WorkKnownRecoveryV2Schema.Record | WorkKnownRecoveryV2Schema.ResumeRecord) =>
    createHmac("sha256", secret).update(`${domain}\0`).update(CanonicalJson.stringify([installation.instanceID, record])).digest("hex")
  const validate = <A extends WorkKnownRecoveryV2Schema.Record | WorkKnownRecoveryV2Schema.ResumeRecord>(schema: Schema.Decoder<A>, record: A, storedMac: string, domain: string, limit: number) => Effect.gen(function* () {
    if (!lifetime.active || record.instanceID !== installation.instanceID ||
      Option.isNone(Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(record)) ||
      !Schema.is(WorkKnownRecoverySchema.Digest)(storedMac) || Buffer.byteLength(CanonicalJson.stringify(record)) > limit ||
      !timingSafeEqual(Buffer.from(mac(domain, record), "hex"), Buffer.from(storedMac, "hex")))
      return yield* WorkKnownRecoveryV2.failure("RECOVERY_INVALID_RECORD")
  })
  const principal = database.db.transaction((tx) => LocalOperator.requireMutation(tx)).pipe(Effect.map((operator) => ({
    instanceID: operator.instance_id, operatorID: operator.operator_id,
  })), Effect.provide(context), Effect.mapError(() => WorkKnownRecoveryV2.failure("RECOVERY_AUTH_REQUIRED")))
  const prepare = (request: WorkKnownRecoveryV2Schema.Request, resume?: { recovery: WorkKnownRecoveryV2Schema.Record; request: WorkKnownRecoveryV2Schema.ResumeRequest }) => Effect.gen(function* () {
    if (!lifetime.active || live.size >= 1 || !installed.files || !installed.leafProof?.authenticateHistorical ||
      Option.isNone(yield* Effect.serviceOption(WorkTaskKnownProof.Authority))) return yield* refused()
    if ((yield* execution.active).has(SessionSchema.ID.make(request.sessionID))) return yield* WorkKnownRecoveryV2.failure("RECOVERY_OWNER_ACTIVE")
    const candidate = yield* WorkAuthority.get(database.db, request.workID)
    if (!candidate || candidate.session_id !== request.sessionID || candidate.control_revision !== request.expectedControlRevision)
      return yield* refused()
    if (installed.profile.prepareSource) yield* installed.profile.prepareSource(candidate)
    const observed = yield* database.db.transaction((tx) => Effect.gen(function* () {
      const operator = yield* LocalOperator.requireMutation(tx)
      const work = yield* WorkAuthority.requireCurrentControlInTransaction(tx, { workID: request.workID, expectedRevision: request.expectedControlRevision })
      if (work.binding.schemaVersion !== "work-execution.v2" || work.session_id !== request.sessionID ||
        work.binding.scope.actorID !== operator.operator_id) return yield* refused()
      const approval = yield* WorkRouteApproval.requireCurrent(tx, work.binding.provider.evidenceID)
      return { operator, work, approval }
    }))
    if (observed.work.binding.schemaVersion !== "work-execution.v2") return yield* refused()
    yield* installed.profile.preflight(observed.work)
    const session = yield* sessions.get(SessionSchema.ID.make(request.sessionID))
    if (!session) return yield* WorkKnownRecoveryV2.failure("RECOVERY_NOT_FOUND")
    const scope = scopeOf(observed.approval.evidence)
    const currentContext = yield* locations.contextEffect(session.location)
    const currentClient = Context.getOption(currentContext, LLMClient.Service)
    if (Option.isNone(currentClient)) return yield* refused()
    const actual = yield* Effect.gen(function* () {
      const model = yield* (yield* SessionRunnerModel.Service).resolve(session)
      const handle = yield* native.approve(model)
      const request = LLM.request({ model: model.model, system: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.instructions,
        prompt: "Offline current route verification for explicit known recovery.", generation: { maxTokens: 16 },
        providerOptions: { openai: { store: false } } })
      const result: { capture?: ProviderCredentialBinding.Capture } = {}
      const seal = yield* native.bind(handle, request).pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, {
        seal: (observation) => Effect.gen(function* () {
          result.capture = yield* credentials.captureNative({ runtime: handle, request, observation, scope,
            snapshot: observed.approval.evidence.modelID, expiresAt: observed.approval.evidence.expiresAt })
          return yield* Effect.die("offline-known-recovery-sealed")
        }).pipe(Effect.provideService(Scope.Scope, Context.get(context, Scope.Scope)), Effect.orDie),
      }))
      yield* currentClient.value.generate(request).pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, seal),
        Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
        Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"), Effect.exit)
      if (!result.capture) return yield* refused()
      const capture = yield* credentials.authority.captured(result.capture)
      if (hash(capture) !== hash(observed.approval.evidence)) return yield* refused()
      return result.capture
    }).pipe(Effect.provide(Context.merge(context, currentContext)))
    const root = yield* installed.files.open({ binding: observed.work.binding, controlRevision: observed.work.control_revision })
    yield* installed.files.current(root)
    const effects = yield* database.db.select({ id: V2ToolEffectTable.effect_id, tool: V2ToolEffectTable.tool_name,
      admissionID: V2ToolEffectAdmissionTable.admission_id }).from(V2ToolEffectTable)
      .innerJoin(V2ToolEffectAdmissionTable, and(eq(V2ToolEffectAdmissionTable.receipt_id, V2ToolEffectTable.receipt_id),
        eq(V2ToolEffectAdmissionTable.tool_call_id, V2ToolEffectTable.tool_call_id)))
      .where(eq(V2ToolEffectTable.session_id, request.sessionID)).limit(129).all()
    if (effects.length > 128) return yield* WorkKnownRecoveryV2.failure("RECOVERY_CAPACITY")
    const proofs = yield* Effect.forEach(effects.filter((effect) => effect.tool!=="task"),
      (effect) => installed.leafProof!.authenticateHistorical!(effect.id, request.expectedControlRevision))
    const tasks = yield* Effect.forEach(effects.filter((effect) => effect.tool==="task"), (effect) =>
      WorkTaskKnownProof.read(database.db,effect.admissionID).pipe(Effect.provide(context),
        Effect.flatMap((value) => value ? Effect.succeed(value) : Effect.fail(refused())),
        Effect.mapError(() => WorkKnownRecoveryV2.failure("RECOVERY_EVIDENCE_UNKNOWN"))))
    if (installed.profile.prepareSource) yield* installed.profile.prepareSource(observed.work)
    const witness = Object.freeze(Object.create(null)) as WorkKnownRecoveryV2.Prepared
    entries.set(witness, { request, resume, capture: actual, approval: observed.approval, startedAt: Date.now(), observation: {
      principal: { instanceID: observed.operator.instance_id, operatorID: observed.operator.operator_id },
      operatorRevision: observed.operator.revision, approvalRevision: observed.approval.revision,
      base: { sourceID: observed.work.binding.source.sourceID, sourceRecordHash: observed.work.source_record_hash,
        approvalID: observed.approval.approvalID, approvalEvidenceHash: observed.approval.evidenceHash,
        operatorGeneration: observed.operator.credential_generation, providerGeneration: observed.approval.credentialGeneration,
        installationKeyHash: observed.operator.installation_key_hash, executableHash: observed.approval.evidence.binaryHash,
        componentsHash: observed.approval.evidence.componentsHash, releaseID: observed.approval.evidence.releaseID,
        canonicalRoot: observed.work.binding.location.directory, rootIdentity: observed.work.binding.projectScope.rootIdentity,
        helperHash: observed.work.binding.projectScope.helperHash }, proofs, tasks,
    } })
    live.add(witness)
    yield* Effect.addFinalizer(() => Effect.sync(() => { entries.delete(witness); live.delete(witness) }))
    return witness
  }).pipe(Effect.provide(context), Effect.mapError((error) => error instanceof WorkKnownRecoverySchema.Error ? error : refused()))
  const current: Context.Service.Shape<typeof WorkKnownRecoveryV2.Authority>["current"] = (tx, witness) => Effect.gen(function* () {
    const entry = entries.get(witness)
    if (!lifetime.active || !entry || !live.has(witness)) return yield* refused()
    if ((yield* execution.active).has(SessionSchema.ID.make(entry.request.sessionID))) return yield* WorkKnownRecoveryV2.failure("RECOVERY_OWNER_ACTIVE")
    const operator = yield* LocalOperator.requireMutation(tx)
    const approval = yield* WorkRouteApproval.requireCurrent(tx, entry.approval.approvalID)
    const captured = yield* credentials.authority.captured(entry.capture)
    if (operator.instance_id !== entry.observation.principal.instanceID || operator.operator_id !== entry.observation.principal.operatorID ||
      operator.revision !== entry.observation.operatorRevision || hash(approval) !== hash(entry.approval) || hash(captured) !== hash(approval.evidence)) return yield* refused()
    return entry.observation
  }).pipe(Effect.provide(context), Effect.mapError((error) => error instanceof WorkKnownRecoverySchema.Error ? error : refused()))
  const authority = WorkKnownRecoveryV2.Authority.of({ principal, prepare,
    prepareResume: (record, request) => prepare(WorkKnownRecoveryV2.requestOf(record), { recovery: record, request }),
    current,
    authenticate: (tx, witness, record) => Effect.gen(function* () {
      const entry = entries.get(witness)
      if (!entry || entry.resume || record.createdAt < entry.startedAt || record.createdAt > Date.now()) return yield* refused()
      const observed = yield* current(tx, witness)
      const facts = yield* WorkKnownRecoveryV2.facts(tx, entry.request, observed)
      const expected: WorkKnownRecoveryV2Schema.Record = { version: 2, recoveryID: `wrecover2_${WorkKnownRecoveryV2.commandHash(observed.principal, entry.request)}`,
        ...observed.principal, workID: facts.work.work_id, rootWorkID: facts.work.root_work_id, sessionID: facts.work.session_id,
        inputID: facts.work.input_id, requestID: entry.request.requestID, action: entry.request.action,
        oldClaimToken: entry.request.expectedClaimToken, controlRevision: entry.request.expectedControlRevision,
        operatorRevision: observed.operatorRevision, sourceRevision: facts.work.source_revision, approvalRevision: observed.approvalRevision,
        bindingHash: facts.work.binding_hash, requestHash: WorkKnownRecoveryV2.commandHash(observed.principal, entry.request),
        evidenceHash: hash(facts.evidence), evidence: facts.evidence, createdAt: record.createdAt }
      if (hash(expected) !== hash(record)) return yield* refused()
      return mac("dac-work-known-recovery.v2", record)
    }).pipe(Effect.provide(context), Effect.mapError((error) => error instanceof WorkKnownRecoverySchema.Error ? error : refused())),
    authenticateResume: (tx, witness, record) => Effect.gen(function* () {
      const entry = entries.get(witness)
      if (!entry?.resume || record.createdAt < entry.startedAt || record.createdAt > Date.now()) return yield* refused()
      const observed = yield* current(tx, witness)
      const facts = yield* WorkKnownRecoveryV2.facts(tx, entry.request, observed, true)
      const expected: WorkKnownRecoveryV2Schema.ResumeRecord = { version: 2, recoveryID: entry.resume.recovery.recoveryID,
        ...observed.principal, workID: facts.work.work_id, sessionID: facts.work.session_id,
        requestID: entry.resume.request.requestID, controlRevision: entry.resume.request.expectedControlRevision,
        operatorRevision: observed.operatorRevision, sourceRevision: facts.work.source_revision, approvalRevision: observed.approvalRevision,
        bindingHash: facts.work.binding_hash, recoveryRecordHash: hash(entry.resume.recovery),
        requestHash: hash({ version: 2, ...observed.principal, ...entry.resume.request }), createdAt: record.createdAt }
      if (hash(expected) !== hash(record) || hash(facts.evidence) !== entry.resume.recovery.evidenceHash) return yield* refused()
      return mac("dac-work-known-recovery-resume.v2", record)
    }).pipe(Effect.provide(context), Effect.mapError((error) => error instanceof WorkKnownRecoverySchema.Error ? error : refused())),
    verify: (record, value) => validate(WorkKnownRecoveryV2Schema.Record, record, value, "dac-work-known-recovery.v2", WorkKnownRecoveryV2Schema.MAX_RECORD_BYTES),
    verifyResume: (record, value) => validate(WorkKnownRecoveryV2Schema.ResumeRecord, record, value, "dac-work-known-recovery-resume.v2", WorkKnownRecoveryV2Schema.MAX_RESUME_RECORD_BYTES),
  })
  return { authority, database, execution, context }
})

export const recover = Effect.fn("NativeWorkKnownRecoveryV2.recover")(function* (input: WorkKnownRecoveryV2Schema.Request) {
  const host = yield* make
  return yield* Effect.gen(function* () {
    const receipt = yield* WorkKnownRecoveryV2.recover(host.database.db, input)
    if (receipt.replayed || input.action !== "recover_and_resume") return { receipt, execution: "not_started" as const }
    const outcome = yield* WorkKnownRecoveryV2.withContinuation(receipt, host.execution.resume(SessionSchema.ID.make(receipt.sessionID))).pipe(Effect.exit)
    return { receipt, execution: outcome === undefined ? "not_started" as const : Exit.isSuccess(outcome) ? "drained" as const : "attention_required" as const }
  }).pipe(Effect.provide(host.context), Effect.provideService(WorkKnownRecoveryV2.Authority, host.authority))
}, Effect.scoped)

export const resume = Effect.fn("NativeWorkKnownRecoveryV2.resume")(function* (input: WorkKnownRecoveryV2Schema.ResumeRequest, expectedWorkID?: string) {
  const host = yield* make
  return yield* Effect.gen(function* () {
    if (expectedWorkID !== undefined) {
      yield* host.authority.principal
      const record = yield* WorkKnownRecoveryV2.read(host.database.db, eq(WorkKnownRecoveryV2Table.recovery_id, input.recoveryID))
      if (!record || record.workID !== expectedWorkID) return yield* WorkKnownRecoveryV2.failure("RECOVERY_NOT_FOUND")
    }
    const receipt = yield* WorkKnownRecoveryV2.recordResume(host.database.db, input)
    const outcome = receipt.replayed ? undefined : yield* WorkKnownRecoveryV2.withContinuation(receipt, host.execution.resume(SessionSchema.ID.make(receipt.sessionID))).pipe(Effect.exit)
    return { receipt, execution: outcome === undefined ? "not_started" as const : Exit.isSuccess(outcome) ? "drained" as const : "attention_required" as const }
  }).pipe(Effect.provide(host.context), Effect.provideService(WorkKnownRecoveryV2.Authority, host.authority))
}, Effect.scoped)

function scopeOf(value: WorkRouteApprovalSchema.Evidence): WorkRouteApprovalSchema.Scope {
  return { instanceID: value.instanceID, operatorID: value.operatorID, targetID: value.targetID,
    securityNamespaceID: value.securityNamespaceID, projectScopeKey: value.projectScopeKey,
    locationKey: value.locationKey, canonicalRoot: value.canonicalRoot, namespaceBindingHash: value.namespaceBindingHash }
}
