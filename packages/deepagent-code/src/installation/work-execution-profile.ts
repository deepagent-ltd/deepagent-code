import { Config, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkDerivedAuthority } from "@deepagent-code/core/session/work-derived-authority"
import { WorkRouteApproval } from "@deepagent-code/core/session/work-route-approval"
import { WorkRouteApprovalSchema } from "@deepagent-code/core/session/work-route-approval.schema"
import { WorkCountAcquisition } from "@deepagent-code/core/session/work-count-acquisition"
import { WorkCountAcquisitionSchema } from "@deepagent-code/core/session/work-count-acquisition.schema"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { WorkRoutePolicy } from "@deepagent-code/core/session/work-route-policy"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { WorkFileCapability } from "@deepagent-code/core/session/work-file-capability"
import { WorkFileHelper } from "./work-file-helper"
import { WorkLeafProof } from "./work-leaf-proof"
import { NativeTaskKnownProof } from "./work-task-known-proof"
import { WorkTaskKnownProof } from "@deepagent-code/core/session/work-task-known-proof"
import { BrowserFileCapability } from "@deepagent-code/core/browser/file-capability"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { NativeRuntime } from "./native-runtime"
import { EventInvestigationSource } from "./event-investigation-source"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { EventInvestigation } from "@deepagent-code/core/deepagent/event-investigation"
import { EventInvestigationSchema } from "@deepagent-code/core/deepagent/event-investigation.schema"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { EventInvestigationRead } from "./event-investigation-read"
import { EventWorkAdmission } from "@deepagent-code/core/deepagent/event-work-admission"
import { WorkProviderContract } from "./work-provider-contract"
import { ProviderCredentialBinding } from "./provider-credential-binding"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { EventWorkPlacementHost } from "./event-work-placement"
import { EventWorkPlacement } from "@deepagent-code/core/deepagent/event-work-placement"
import { EventWorkNodeAuthority } from "@deepagent-code/core/deepagent/event-work-node-authority"
import type { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { ServerAuth } from "@/server/auth"
import type { LLMRequest } from "@deepagent-code/llm"

const unavailable = () => new WorkAuthoritySchema.Error({ code: "PROFILE_UNAVAILABLE", message: "Current installed Work source, route or native count authority is unavailable" })
const map = (error: unknown) => error instanceof WorkAuthoritySchema.Error ? error : unavailable()
const diagnostic = (stage: "profile-ready-operator" | "profile-ready-contracts" | "profile-ready-credentials" |
  "profile-ready-source" | "profile-required" | "profile-route-record" | "profile-route-contract" |
  "profile-source-prepare" | "profile-source" | "profile-placement" | "profile-route" |
  "profile-observe-native" | "profile-observe-configuration" | "profile-observe-files") => (error: unknown) => {
  const known = error instanceof WorkAuthoritySchema.Error
    ? { tag: "WorkAuthorityError", code: Schema.decodeUnknownOption(WorkAuthoritySchema.ErrorCode)(error.code) }
    : error instanceof WorkRouteApprovalSchema.Error
      ? { tag: "WorkRouteApprovalError", code: Schema.decodeUnknownOption(WorkRouteApprovalSchema.Error.fields.code)(error.code) }
      : error instanceof WorkCountAcquisitionSchema.Error
        ? { tag: "WorkCountAcquisitionError", code: Schema.decodeUnknownOption(WorkCountAcquisitionSchema.Error.fields.code)(error.code) }
        : error instanceof LocalOperatorSchema.Error
          ? { tag: "LocalOperatorError", code: Schema.decodeUnknownOption(LocalOperatorSchema.Error.fields.code)(error.code) }
          : error instanceof NativeRuntime.Error
            ? { tag: "NativeRuntimeError", code: Schema.decodeUnknownOption(NativeRuntime.Error.fields.code)(error.code) }
            : error instanceof WorkFileCapability.Error
              ? { tag: "WorkFileError", code: Schema.decodeUnknownOption(WorkFileCapability.Error.fields.code)(error.code) }
              : { tag: "unclassified", code: Option.none() }
  // The logging bridge stringifies message arguments individually. Only fixed
  // stage/tag and schema-enumerated codes are retained, never error.message.
  return Effect.logWarning(`work_profile_current_refused ${JSON.stringify({ stage, typedTag: known.tag,
    code: Option.getOrElse(known.code, () => "unclassified") })}`)
}

/** Fixed-purpose comparison with existing enrollment, NOT listener authentication or a grant.
 * No global ServerAuth override and no Mutation witness are manufactured. */
const operatorConfiguration = Effect.gen(function* () {
  const inherited = yield* Effect.serviceOption(ServerAuth.Config)
  if (Option.isSome(inherited)) return inherited.value
  return yield* Config.all({
    password: Config.string("DEEPAGENT_CODE_SERVER_PASSWORD").pipe(Config.option),
    username: Config.string("DEEPAGENT_CODE_SERVER_USERNAME").pipe(Config.withDefault("deepagent-code")),
  })
})

export class Service extends Context.Service<Service, WorkExecutionProfile.Installed & {
  readonly captureExecution: (execution: SessionExecution.Interface) => Effect.Effect<void, WorkAuthoritySchema.Error>
  readonly approveInvestigationTarget: (input: EventInvestigation.GrantApprovalInput) => Effect.Effect<NativeRuntime.PurposeReadiness, EventInvestigationSchema.Error>
  readonly investigationTargetCurrent: (readiness: NativeRuntime.PurposeReadiness) => boolean
  readonly investigationAuthority: Effect.Effect<LocalOperator.Runtime["Service"], EventInvestigationSchema.Error>
  readonly eventWorkAuthority: Effect.Effect<LocalOperator.Runtime["Service"], WorkAuthoritySchema.Error>
  readonly captureEventLocations: (locations: Context.Service.Shape<typeof LocationServiceMap>) => Effect.Effect<void, WorkAuthoritySchema.Error>
}>()("@deepagent-code/ProductionWorkExecution") {}

/** Construct one object for both global execution and cached Locations. Missing installation or
 * enrollment disables Work only. Verification/bootstrap I/O occurs here, never inside SQL. */
export const layer = Layer.effect(Service, Effect.gen(function* () {
  const database = yield* Database.Service
  const native = yield* NativeRuntime.Service
  const investigation = yield* EventInvestigationSource.make
  const eventPlacement = yield* EventWorkPlacementHost.make
  const configured = yield* operatorConfiguration.pipe(Effect.exit)
  const configurationSnapshot = Exit.isSuccess(configured) ? CanonicalJson.stringify(configured.value) : undefined
  const ready = yield* Effect.gen(function* () {
    if (Exit.isFailure(configured)) return yield* unavailable()
    const operator = yield* LocalTaskAuthority.configured(configured.value).pipe(Effect.tapError(diagnostic("profile-ready-operator")))
    const contracts = yield* WorkProviderContract.contracts.pipe(Effect.tapError(diagnostic("profile-ready-contracts")))
    const credentials = Context.get(yield* Layer.build(ProviderCredentialBinding.layer.pipe(
      Layer.provide(WorkProviderContract.layer), Layer.provide(Layer.succeed(NativeRuntime.Service, native)),
    )).pipe(Effect.tapError(diagnostic("profile-ready-credentials"))), ProviderCredentialBinding.Service)
    return { operator: operator.runtime, contracts, credentials }
  }).pipe(Effect.exit)
  const required = Effect.gen(function* () {
    if (Exit.isFailure(ready) || Exit.isFailure(configured) || CanonicalJson.stringify(configured.value) !== configurationSnapshot)
      return yield* Effect.fail(unavailable()).pipe(Effect.tapError(diagnostic("profile-required")))
    return ready.value
  })
  const withAuthority = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
    const value = yield* required
    return yield* effect.pipe(
      Effect.provideService(LocalOperator.Runtime, value.operator),
      Effect.provideService(WorkRouteApproval.Authority, value.credentials.authority),
      Effect.provideService(WorkCountAcquisition.Authority, value.credentials.countAuthority),
      Effect.provideService(EventWorkPlacement.Service, eventPlacement.placement),
    )
  })
  const turns = new WeakMap<WorkRoutePolicy.Runtime, {
    handle: NativeRuntime.ApprovedRuntime
    workID: string
    sessionID: string
    scope: WorkRouteApprovalSchema.Scope
    request?: LLMRequest
    capture?: ProviderCredentialBinding.Capture
    receiptID?: string
    root?: WorkFileCapability.Root
  }>()
  const active = new Set<WorkRoutePolicy.Runtime>()
  yield* Effect.addFinalizer(() => Effect.sync(() => { active.forEach((runtime) => turns.delete(runtime)); active.clear() }))
  const approved = (db: Parameters<typeof WorkRouteApproval.requireCurrent>[0], id: string) => withAuthority(Effect.gen(function* () {
    const current = yield* WorkRouteApproval.requireCurrent(db, id).pipe(Effect.tapError(diagnostic("profile-route-record")))
    const evidence = current.evidence
    const contract = (yield* required).contracts.find((entry) => entry.providerID === evidence.providerID && entry.modelID === evidence.modelID)
    if (!contract) return yield* Effect.fail(unavailable()).pipe(Effect.tapError(diagnostic("profile-route-contract")))
    if (evidence.providerID !== contract.providerID || evidence.modelID !== contract.modelID ||
      evidence.modelRevision !== contract.modelRevision || evidence.endpoint !== contract.endpoint ||
      evidence.counterEndpoint !== contract.counterEndpoint || evidence.providerContractID !== contract.contractID ||
      evidence.providerContractHash !== contract.contractHash || evidence.binaryHash !== contract.installation.executableHash ||
      evidence.componentsHash !== contract.installation.componentsHash || evidence.releaseID !== contract.installation.releaseID ||
      evidence.factoryHash !== contract.factoryHash || evidence.adapterHash !== contract.adapterHash ||
      evidence.loweringHash !== contract.loweringHash || evidence.framingHash !== contract.framingHash ||
      evidence.tokenizerIdentity !== contract.tokenizerIdentity || evidence.completionLimit !== contract.completionLimit) {
      const fields = [
        evidence.providerID !== contract.providerID ? "providerID" : undefined,
        evidence.modelID !== contract.modelID ? "modelID" : undefined,
        evidence.modelRevision !== contract.modelRevision ? "modelRevision" : undefined,
        evidence.endpoint !== contract.endpoint ? "endpoint" : undefined,
        evidence.counterEndpoint !== contract.counterEndpoint ? "counterEndpoint" : undefined,
        evidence.providerContractID !== contract.contractID ? "providerContractID" : undefined,
        evidence.providerContractHash !== contract.contractHash ? "providerContractHash" : undefined,
        evidence.binaryHash !== contract.installation.executableHash ? "binaryHash" : undefined,
        evidence.componentsHash !== contract.installation.componentsHash ? "componentsHash" : undefined,
        evidence.releaseID !== contract.installation.releaseID ? "releaseID" : undefined,
        evidence.factoryHash !== contract.factoryHash ? "factoryHash" : undefined,
        evidence.adapterHash !== contract.adapterHash ? "adapterHash" : undefined,
        evidence.loweringHash !== contract.loweringHash ? "loweringHash" : undefined,
        evidence.framingHash !== contract.framingHash ? "framingHash" : undefined,
        evidence.tokenizerIdentity !== contract.tokenizerIdentity ? "tokenizerIdentity" : undefined,
        evidence.completionLimit !== contract.completionLimit ? "completionLimit" : undefined,
      ].filter((field) => field !== undefined)
      yield* Effect.logWarning(`work_profile_current_refused ${JSON.stringify({ stage: "profile-route-contract", fields })}`)
      return yield* unavailable()
    }
    if (("counterSemantics" in contract) !== ("counterSemantics" in evidence) ||
      ("counterSemantics" in contract && (!("counterSemantics" in evidence) ||
        evidence.counterSemantics !== contract.counterSemantics || evidence.inputUpperBoundTokens !== contract.inputUpperBoundTokens))) {
      const fields = [
        !("counterSemantics" in contract) || !("counterSemantics" in evidence) || evidence.counterSemantics !== contract.counterSemantics ? "counterSemantics" : undefined,
        "inputUpperBoundTokens" in contract && (!("inputUpperBoundTokens" in evidence) || evidence.inputUpperBoundTokens !== contract.inputUpperBoundTokens) ? "inputUpperBoundTokens" : undefined,
      ].filter((field) => field !== undefined)
      yield* Effect.logWarning(`work_profile_current_refused ${JSON.stringify({ stage: "profile-route-contract", fields })}`)
      return yield* unavailable()
    }
    return current
  })).pipe(Effect.mapError(map))
  const readApproval = (id: string) => database.db.transaction((tx) => approved(tx, id)).pipe(Effect.mapError(map))
  const resolve = (id: string) => readApproval(id).pipe(Effect.map(projection))
  const verifier: WorkAuthority.Verification = {
    authorizeSource: (tx, binding) => {
      if (binding.parentWorkID) return Effect.gen(function* () {
        const child = yield* WorkAuthority.get(tx, binding.workID)
        if (!child || child.binding_hash !== Hash.sha256(CanonicalJson.stringify(binding))) return yield* unavailable()
        yield* WorkDerivedAuthority.requireCurrent(tx, child)
        const parent = yield* WorkAuthority.get(tx, child.root_work_id)
        if (!parent || parent.work_id !== child.parent_work_id) return yield* unavailable()
        return yield* verifier.authorizeSource(tx, parent.binding)
      }).pipe(Effect.mapError(map))
      if (binding.source.kind === "server_operator")
        return Effect.fail(unavailable())
      if (binding.source.kind === "server_rule" && binding.source.authorityID.startsWith("evwork_"))
        return withAuthority(EventWorkAdmission.authorizeSource(tx, binding)).pipe(Effect.mapError(map))
      if (binding.source.kind === "server_rule") return Effect.gen(function* () {
        yield* investigation.requireExecution
        const value = yield* Effect.try({ try: () => EventInvestigationSource.requireBinding(binding), catch: map })
        return yield* withAuthority(EventInvestigation.authorizeWorkSource(tx, value))
      }).pipe(Effect.mapError(map))
      return Effect.fail(unavailable())
    },
    resolveRoute: (tx, binding) => approved(tx, binding.provider.evidenceID).pipe(Effect.flatMap((record) => Effect.gen(function* () {
      const value = record.evidence
      const derived = binding.parentWorkID ? yield* WorkDerivedAuthority.get(tx, binding.workID) : undefined
      const placement = derived && "kind" in derived ? derived.placement : undefined
      if (placement) {
        const witness = eventPlacement.placement.forWork(binding.workID)
        if (!witness || Hash.sha256(CanonicalJson.stringify(eventPlacement.placement.describe(witness))) !== Hash.sha256(CanonicalJson.stringify(placement))) return yield* unavailable()
        yield* eventPlacement.placement.current(witness)
      }
      if (value.operatorID !== binding.scope.actorID || value.securityNamespaceID !== binding.scope.securityNamespaceID ||
        value.projectScopeKey !== binding.scope.projectScopeKey || value.canonicalRoot !== (placement?.workspace.repositoryRoot ?? binding.location.directory) ||
        value.providerID !== binding.provider.providerID || value.modelID !== binding.provider.modelID ||
        value.routeID !== binding.provider.routeID || value.configurationStamp !== binding.provider.configurationHash ||
        record.evidenceHash !== binding.provider.evidenceHash || value.endpoint !== binding.provider.endpoint)
        return yield* unavailable()
      return { evidenceID: record.approvalID, evidenceHash: record.evidenceHash, configurationHash: value.configurationStamp }
    })), Effect.mapError(map)),
  }
  const prepareSource = (work: WorkAuthority.Work, options?: { readonly fresh?: boolean }) => withAuthority(Effect.gen(function* () {
    if (work.parent_work_id && work.source_kind === "server_rule" && work.authority_id.startsWith("evwork_"))
      yield* eventPlacement.preparePlacement(work.work_id)
    const source = !work.parent_work_id ? work : yield* database.db.transaction((tx) => Effect.gen(function* () {
      yield* work.outcome === "succeeded"
        ? WorkDerivedAuthority.requireTerminalProofControl(tx, { workID: work.work_id, expectedRevision: work.control_revision })
        : WorkDerivedAuthority.requireCurrent(tx, work)
      const parent = yield* WorkAuthority.get(tx, work.root_work_id)
      if (!parent || parent.work_id !== work.parent_work_id) return yield* unavailable()
      return parent
    }))
    // The root's original source is prepared outside SQL; the durable derived grant
    // and current parent control are checked again by the child's consumption gate.
    if (source.source_kind === "server_rule" && source.authority_id.startsWith("evwork_")) {
      yield* database.db.transaction((tx) => EventWorkAdmission.requireSource(tx, source.authority_id))
      return
    }
    // Retired IM Work remains readable history and cannot acquire new execution
    // authority. Event/Investigation server_rule sources keep their own checks.
    if (source.source_kind === "server_operator") return yield* unavailable()
  })).pipe(Effect.tapError(diagnostic("profile-source-prepare")), Effect.mapError(map))
  const currentRuntime = (runtime: WorkRoutePolicy.Runtime) => Effect.gen(function* () {
    const entry = turns.get(runtime)
    if (!entry || !active.has(runtime) || !entry.capture) return yield* unavailable()
    const value = yield* required
    const captured = yield* value.credentials.authority.captured(entry.capture)
    if (captured.configurationStamp !== runtime.configurationHash || captured.providerID !== runtime.providerID || captured.modelID !== runtime.modelID)
      return yield* unavailable()
  }).pipe(Effect.mapError(map))
  const evidence: WorkRoutePolicy.Interface = {
    resolve,
    readCount: (query) => withAuthority(Effect.gen(function* () {
      const route = yield* resolve(query.routeEvidenceID)
      const record = query.dispatch.project
        ? yield* WorkCountAcquisition.getTurn(database.db, query.dispatch.workID, query.dispatch.project.turn.key)
        : yield* WorkCountAcquisition.get(database.db, query.dispatch.workID)
      if (!record || record.state !== "settled" || !record.result || record.binding.approvalID !== route.id ||
        record.binding.approvalRevision !== route.revision || record.binding.inputTupleHash !== query.inputTupleHash ||
        record.binding.generationBodyHash !== query.bodyHash || record.binding.wireHash !== query.wireHash ||
        Object.entries(query.dispatch).filter(([key]) => key !== "project").some(([key, value]) => Reflect.get(record.binding, key) !== value) ||
        (query.dispatch.project && (record.version !== 2 ||
          CanonicalJson.stringify({ rootWorkID: record.binding.rootWorkID, turn: record.binding.turn,
            predecessor: record.binding.predecessor, toolAdvertisementHash: record.binding.toolAdvertisementHash }) !== CanonicalJson.stringify(query.dispatch.project))))
        return yield* unavailable()
      const view = {
        id: record.acquisitionID, acquisitionRevision: record.revision,
        recordHash: Hash.sha256(CanonicalJson.stringify(record)),
        routeEvidenceID: record.binding.approvalID, routeRevision: record.binding.approvalRevision,
        routeHash: route.projectionHash, configurationHash: record.binding.configurationStamp,
        modelID: route.runtime.modelID, modelRevision: route.runtime.modelRevision,
        counterID: route.counter.id, counterRevision: route.counter.revision, counterEndpoint: route.counter.endpoint,
        tokenizerIdentity: route.counter.tokenizerIdentity, framingIdentity: route.counter.framingIdentity,
        counterContractHash: route.counter.contractHash, inputTupleHash: record.binding.inputTupleHash,
        bodyHash: record.binding.generationBodyHash, wireHash: record.binding.wireHash,
        responseHash: record.result.responseHash, tokens: record.result.inputTokens,
        countedAt: record.result.countedAt, expiresAt: record.result.expiresAt,
      }
      return record.version === 2
        ? { ...view, version: "native-project-count-receipt.v1" as const, binding: record.binding }
        : { ...view, version: "native-count-receipt.v2" as const, binding: record.binding }
    })).pipe(Effect.mapError(map)),
  }
  const profile: Context.Service.Shape<typeof WorkExecutionProfile.Service> = {
    prepareSource,
    preflight: (work) => withAuthority(Effect.gen(function* () {
      // Source preparation can acquire the reader lock or native I/O. The execution owner
      // performs it before its SQL claim; this consume phase is local/current SQL only.
      yield* WorkExecutionProfile.requirePlacement(database.db, work).pipe(Effect.tapError(diagnostic("profile-placement")))
      yield* database.db.transaction((tx) => verifier.authorizeSource(tx, work.binding).pipe(
        Effect.tapError(diagnostic("profile-source")), Effect.andThen(() => verifier.resolveRoute(tx, work.binding)
          .pipe(Effect.tapError(diagnostic("profile-route"))))))
    })).pipe(Effect.mapError(map)),
    observe: (input) => withAuthority(Effect.gen(function* () {
      const lookup = yield* WorkAuthority.lookupSession(database.db, input.sessionID)
      if (lookup.kind !== "bound" || active.size >= 32) return yield* unavailable()
      const record = yield* readApproval(lookup.work.binding.provider.evidenceID)
      const scope = scopeOf(record.evidence)
      if (lookup.work.binding.profile.id === WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.id) yield* investigation.requireExecution
      const handle = yield* eventPlacement.placement.forWork(lookup.work.work_id)
        ? eventPlacement.approve(lookup.work, input.resolved).pipe(Effect.tapError(diagnostic("profile-observe-native")))
        : native.approve(input.resolved, lookup.work.binding.profile.id === WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.id ? "event_investigate_v1" : undefined)
          .pipe(Effect.tapError(diagnostic("profile-observe-native")))
      const actual = yield* native.configuration(handle, scope).pipe(Effect.tapError(diagnostic("profile-observe-configuration")))
      const mismatch = WorkProviderContract.runtimeMismatch(record.evidence, actual)
      if (mismatch.length) {
        yield* Effect.logWarning(`work_profile_native_configuration_refused ${JSON.stringify({ stage: "profile-native-configuration", fields: mismatch })}`)
        return yield* unavailable()
      }
      const runtime = Object.freeze(projection(record).runtime)
      const root = lookup.work.binding.schemaVersion === "work-execution.v2"
        ? files
          ? yield* files.open({ binding: lookup.work.binding,
              controlRevision: lookup.work.control_revision }).pipe(Effect.tapError(diagnostic("profile-observe-files")))
          : yield* Effect.fail(unavailable()).pipe(Effect.tapError(diagnostic("profile-observe-files")))
        : undefined
      turns.set(runtime, { handle, scope, workID: lookup.work.work_id, sessionID: input.sessionID, root })
      active.add(runtime)
      yield* Effect.addFinalizer(() => Effect.sync(() => { turns.delete(runtime); active.delete(runtime) }))
      return runtime
    })).pipe(Effect.mapError(map)),
    bind: (runtime, request) => Effect.gen(function* () {
      const entry = turns.get(runtime)
      if (!entry || entry.request) return yield* unavailable()
      entry.request = request
      return yield* native.bind(entry.handle, request)
    }).pipe(Effect.mapError(map)),
    current: currentRuntime,
    acquireCount: (input) => withAuthority(Effect.gen(function* () {
      const entry = turns.get(input.runtime)
      if (!entry?.request || entry.workID !== input.workID || entry.receiptID || entry.capture) return yield* unavailable()
      const value = yield* required
      const record = yield* readApproval(input.route.id)
      const currentWork = yield* WorkAuthority.lookupSession(database.db, entry.sessionID)
      if (currentWork.kind !== "bound" || currentWork.work.work_id !== input.workID) return yield* unavailable()
      if (currentWork.work.binding.schemaVersion === "work-execution.v2") {
        if (!entry.root || !files) return yield* unavailable()
        yield* files.current(entry.root)
        yield* native.requireCanonicalBody(entry.handle, entry.request, input.wire)
        yield* WorkFileHelper.requireInstalled(currentWork.work.binding.projectScope.helperHash)
        yield* WorkToolPolicy.preparePrevious(database.db, entry.sessionID)
      }
      const capture = yield* value.credentials.captureNative({ runtime: entry.handle, request: entry.request,
        observation: input.wire, scope: entry.scope, snapshot: record.evidence.modelID, expiresAt: record.evidence.expiresAt })
      const captured = yield* value.credentials.authority.captured(capture)
      if (CanonicalJson.stringify(captured) !== CanonicalJson.stringify(record.evidence)) return yield* unavailable()
      entry.capture = capture
      entry.receiptID = input.receiptID
      yield* prepareSource(currentWork.work, { fresh: true })
      const prepared = yield* database.db.transaction((tx) => Effect.gen(function* () {
        const work = yield* WorkAuthority.requireContext(database.db, { sessionID: entry.sessionID })
        const receipt = yield* tx.select().from(V2ProviderTurnReceiptTable).where(eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptID)).get()
        const attempt = receipt?.provider_attempt_id ? yield* tx.select().from(SessionProviderAttemptTable).where(eq(SessionProviderAttemptTable.attempt_id, receipt.provider_attempt_id)).get() : undefined
        const owner = receipt ? yield* tx.select().from(SessionProviderOwnerLeaseTable).where(eq(SessionProviderOwnerLeaseTable.owner_token, receipt.owner_token)).get() : undefined
        const admitted = work ? yield* tx.select().from(SessionInputTable).where(eq(SessionInputTable.id, SessionMessage.ID.make(work.input_id))).get() : undefined
        if (!work || work.work_id !== input.workID || work.control_revision !== input.controlRevision || !receipt || !attempt || !owner || !admitted)
          return yield* unavailable()
        const checked = WorkRoutePolicy.inspect({ binding: work.binding, auditedText: admitted.prompt.text, runtime: input.runtime, wire: input.wire }, { allowLoopbackHTTP: work.loopback_http })
        if (!checked.ok) return yield* checked.error
        const dispatch = {
          workID: work.work_id, inputID: work.input_id, sessionID: work.session_id, bindingHash: work.binding_hash,
          controlRevision: work.control_revision, sourceAuthorityID: work.authority_id, sourceRevision: work.source_revision,
          sourceRecordHash: work.source_record_hash, providerReceiptID: receipt.receipt_id, providerAttemptID: attempt.attempt_id,
          sessionClaimToken: attempt.execution_claim_token, providerOwnerToken: receipt.owner_token,
        }
        const previous = work.binding.schemaVersion === "work-execution.v2"
          ? yield* WorkToolPolicy.previous(tx, work, receipt.receipt_id) : undefined
        const previousCount = previous
          ? yield* WorkCountAcquisition.getTurn(tx, work.work_id, Hash.sha256(CanonicalJson.stringify([
            "work-provider-turn.v1", work.work_id, previous.receipt.session_id, previous.receipt.activity_id, previous.receipt.provider_turn_seq,
          ]))) : undefined
        if (previous && (!previousCount || !previous.receipt.outcome_hash)) return yield* unavailable()
        const binding = work.binding.schemaVersion === "work-execution.v2"
          ? WorkRoutePolicy.projectCountBinding({ ...dispatch, project: {
              rootWorkID: work.root_work_id,
              turn: { key: Hash.sha256(CanonicalJson.stringify(["work-provider-turn.v1", work.work_id, receipt.session_id, receipt.activity_id, receipt.provider_turn_seq])),
                activityID: receipt.activity_id!, providerTurnSeq: receipt.provider_turn_seq!, contextSelectionID: attempt.selection_id,
                contextProjectionHash: attempt.projection_hash, historyPromptEpoch: receipt.history_prompt_epoch,
                historySourceEndMessageID: receipt.history_source_end_message_id },
              predecessor: previous && previousCount ? { acquisitionID: previousCount.acquisitionID, receiptID: previous.receipt.receipt_id,
                outcomeHash: previous.receipt.outcome_hash!, toolTerminalHash: previous.toolTerminalHash } : null,
              toolAdvertisementHash: checked.value.toolAdvertisementHash,
            } }, input.route, checked.value)
          : WorkRoutePolicy.countBinding(dispatch, input.route, checked.value)
        if (!binding) return yield* unavailable()
        return { binding, deadline: Math.min(Date.now() + 10_000, work.binding.deadline, work.created_at + work.binding.budget.maxDurationMs, record.evidence.expiresAt, owner.lease_expires_at) }
      }))
      if (Schema.is(WorkCountAcquisitionSchema.ProjectBinding)(prepared.binding)) {
        yield* value.credentials.bindProjectCount(capture, prepared.binding)
        const slot = yield* WorkCountAcquisition.prepareTurn(database.db, {
          acquisitionID: `count_${Hash.sha256(CanonicalJson.stringify([input.workID, prepared.binding.turn.key]))}`,
          binding: prepared.binding, ownerToken: prepared.binding.providerOwnerToken,
          bootID: `${process.pid}:${bootID}`, deadline: prepared.deadline,
        })
        if (slot.state === "settled") return
        const sending = yield* WorkCountAcquisition.beginSendingTurn(database.db, { workID: input.workID, turnKey: slot.binding.turn.key,
          acquisitionID: slot.acquisitionID, expectedRevision: slot.revision, ownerToken: slot.ownerToken, bootID: slot.bootID })
        const owner = { workID: input.workID, turnKey: sending.binding.turn.key, acquisitionID: sending.acquisitionID,
          expectedRevision: sending.revision, ownerToken: sending.ownerToken, bootID: sending.bootID }
        yield* value.credentials.count(capture, sending.deadline).pipe(
          Effect.flatMap((count) => count.countBodyHash !== prepared.binding.countBodyHash
            ? Effect.fail(unavailable()) : WorkCountAcquisition.settleTurn(database.db, { ...owner,
              result: { responseHash: count.responseHash, inputTokens: count.inputTokens, countedAt: count.countedAt, expiresAt: sending.deadline } })),
          Effect.onExit((exit) => Exit.isFailure(exit)
            ? WorkCountAcquisition.stopTurn(database.db, owner).pipe(Effect.catchCause(() => Effect.void), Effect.uninterruptible) : Effect.void),
        )
        if (!entry.root || !files) return yield* unavailable()
        yield* files.current(entry.root)
        return
      }
      yield* value.credentials.bindCount(capture, prepared.binding)
      const slot = yield* WorkCountAcquisition.prepare(database.db, {
        acquisitionID: `count_${Hash.sha256(CanonicalJson.stringify([input.workID, prepared.binding.inputID]))}`,
        binding: prepared.binding, ownerToken: prepared.binding.providerOwnerToken,
        bootID: `${process.pid}:${bootID}`, deadline: prepared.deadline,
      })
      if (slot.state === "settled") return
      const sending = yield* WorkCountAcquisition.beginSending(database.db, { workID: input.workID,
        acquisitionID: slot.acquisitionID, expectedRevision: slot.revision, ownerToken: slot.ownerToken, bootID: slot.bootID })
      const owner = { workID: input.workID, acquisitionID: sending.acquisitionID, expectedRevision: sending.revision, ownerToken: sending.ownerToken, bootID: sending.bootID }
      yield* value.credentials.count(capture, sending.deadline).pipe(
        Effect.flatMap((count) => {
          if (count.countBodyHash !== prepared.binding.countBodyHash || count.countedAt < sending.sendingAt! || count.countedAt > Date.now())
            return Effect.fail(unavailable())
          return WorkCountAcquisition.settle(database.db, { ...owner,
            result: { responseHash: count.responseHash, inputTokens: count.inputTokens, countedAt: count.countedAt, expiresAt: sending.deadline } })
        }),
        Effect.onExit((exit) => Exit.isFailure(exit)
          ? WorkCountAcquisition.stop(database.db, owner).pipe(Effect.catchCause(() => Effect.void), Effect.uninterruptible)
          : Effect.void),
      )
    })).pipe(Effect.provideService(WorkAuthority.Verifier, verifier), Effect.mapError(map)),
  }
  const capabilities = yield* (Exit.isSuccess(ready)
    ? Layer.build(Layer.mergeAll(WorkFileHelper.layer, WorkLeafProof.layer, NativeTaskKnownProof.layer)).pipe(
      Effect.provideService(WorkAuthority.Verifier, verifier),
      Effect.provideService(WorkExecutionProfile.Service, profile),
    )
    : Effect.fail(unavailable())).pipe(Effect.exit)
  const browserFiles = yield* Effect.serviceOption(BrowserFileCapability.Service)
  const fileError = (error: unknown) => new WorkFileCapability.Error({
    code: error instanceof EventInvestigationSchema.Error && error.code === "INVESTIGATION_SOURCE_CHANGED" ? "WORK_FILE_CHANGED" : "WORK_FILE_UNAVAILABLE",
    message: "Current investigation source is unavailable or differs from the failed version",
  })
  const files = Exit.isSuccess(capabilities) ? EventInvestigationRead.wrap(Context.get(capabilities.value, WorkFileCapability.Service), {
    manifest: (binding, revision) => investigation.requireExecution.pipe(
      Effect.andThen(() => withAuthority(database.db.transaction((tx) => EventInvestigation.readManifest(tx, binding, revision)))),
      Effect.provideService(WorkAuthority.Verifier, verifier), Effect.mapError(fileError)),
    changed: (binding) => withAuthority(EventInvestigation.sourceChanged(database.db, binding, binding.source.authorityRevision)).pipe(
      Effect.uninterruptible,
      Effect.flatMap((sessions) => Effect.forEach(sessions, (sessionID) => investigation.interruptFromLeaf(sessionID), { discard: true })),
      Effect.mapError(fileError)),
  }) : undefined
  return Service.of({ ...(Exit.isSuccess(ready) ? { eventOperator: ready.value.operator } : {}), profile, verifier, evidence, captureExecution: investigation.captureExecution,
    configuration: eventPlacement.configuration,
    eventPlacement: eventPlacement.placement, captureEventLocations: eventPlacement.captureLocations,
    eventWorkAuthority: required.pipe(Effect.map((value) => value.operator)),
    investigationAuthority: investigation.requireExecution.pipe(Effect.andThen(required), Effect.map((value) => value.operator),
      Effect.mapError(() => new EventInvestigationSchema.Error({ code: "INVESTIGATION_UNAVAILABLE", message: "Same-root investigation authority is unavailable" }))),
    investigationTargetCurrent: (readiness) => investigation.executionCurrent() && native.purposeCurrent(readiness),
    approveInvestigationTarget: (input) => withAuthority(Effect.gen(function* () {
      yield* investigation.requireExecution
      if (WorkAuthorityPolicy.profileFor(input.target.profile)?.id !== WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.id ||
        !WorkAuthorityPolicy.checkInvestigationPolicy(input.target).ok || input.expiresAt <= Date.now() ||
        input.rule.configuration.scope.instanceID !== input.principal.instanceID ||
        input.rule.configuration.scope.canonicalRoot !== input.target.location.directory ||
        input.target.projectScope.canonicalRoot !== input.rule.configuration.scope.canonicalRoot ||
        input.target.projectScope.helperHash !== input.rule.configuration.helperHash ||
        CanonicalJson.stringify(input.target.projectScope.rootIdentity) !== CanonicalJson.stringify(input.rule.configuration.scope.rootIdentity))
        return yield* unavailable()
      const purpose = yield* native.requirePurpose("event_investigate_v1")
      const route = yield* readApproval(input.target.provider.evidenceID)
      const value = route.evidence
      if (value.instanceID !== input.principal.instanceID || value.operatorID !== input.principal.actorID ||
        value.targetID !== input.targetID || value.securityNamespaceID !== input.target.scope.securityNamespaceID ||
        value.projectScopeKey !== input.target.scope.projectScopeKey || value.canonicalRoot !== input.target.location.directory ||
        value.locationKey !== input.target.projectScope.locationKey || value.namespaceBindingHash !== input.target.projectScope.namespaceBindingHash ||
        value.providerID !== input.target.provider.providerID || value.modelID !== input.target.provider.modelID ||
        value.routeID !== input.target.provider.routeID || value.configurationStamp !== input.target.provider.configurationHash ||
        route.evidenceHash !== input.target.provider.evidenceHash || value.endpoint !== input.target.provider.endpoint ||
        value.binaryHash !== purpose.installation.executableHash || value.componentsHash !== purpose.installation.componentsHash ||
        value.releaseID !== purpose.installation.releaseID || value.expiresAt <= Date.now())
        return yield* unavailable()
      const root = yield* WorkFileHelper.inspectRoot(input.rule.configuration.scope.canonicalRoot)
      if (root.helperHash !== input.rule.configuration.helperHash ||
        CanonicalJson.stringify(root.rootIdentity) !== CanonicalJson.stringify(input.rule.configuration.scope.rootIdentity) ||
        !investigation.executionCurrent() || !native.purposeCurrent(purpose.readiness)) return yield* unavailable()
      return purpose.readiness
    })).pipe(Effect.mapError(() => new EventInvestigationSchema.Error({ code: "INVESTIGATION_UNAVAILABLE", message: "Current approved investigation target or native runtime is unavailable" }))),
    ...(Exit.isSuccess(capabilities) ? { files,
      leafProof: Context.get(capabilities.value, WorkToolPolicy.LeafProof),
      taskKnownProof: Context.get(capabilities.value, WorkTaskKnownProof.Authority) } : {}),
    ...(Option.isSome(browserFiles) ? { browserFiles: browserFiles.value } : {}),
    approval: { captured: (capture) => required.pipe(Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")), Effect.flatMap((value) => value.credentials.authority.captured(capture))),
      authenticate: (record) => required.pipe(Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")), Effect.flatMap((value) => value.credentials.authority.authenticate(record))),
      verify: (record, mac) => required.pipe(Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")), Effect.flatMap((value) => value.credentials.authority.verify(record, mac))) },
    count: { requireCapture: (binding) => required.pipe(Effect.mapError(() => WorkCountAcquisition.failure("COUNT_UNAVAILABLE")), Effect.flatMap((value) => value.credentials.countAuthority.requireCapture(binding))),
      authenticate: (record) => required.pipe(Effect.mapError(() => WorkCountAcquisition.failure("COUNT_UNAVAILABLE")), Effect.flatMap((value) => value.credentials.countAuthority.authenticate(record))),
      verify: (record, mac) => required.pipe(Effect.mapError(() => WorkCountAcquisition.failure("COUNT_UNAVAILABLE")), Effect.flatMap((value) => value.credentials.countAuthority.verify(record, mac))),
      requireProjectCapture: (binding) => required.pipe(Effect.mapError(() => WorkCountAcquisition.failure("COUNT_UNAVAILABLE")), Effect.flatMap((value) =>
        value.credentials.countAuthority.requireProjectCapture?.(binding) ?? Effect.fail(WorkCountAcquisition.failure("COUNT_UNAVAILABLE")))),
      authenticateProject: (record) => required.pipe(Effect.mapError(() => WorkCountAcquisition.failure("COUNT_UNAVAILABLE")), Effect.flatMap((value) =>
        value.credentials.countAuthority.authenticateProject?.(record) ?? Effect.fail(WorkCountAcquisition.failure("COUNT_UNAVAILABLE")))),
      verifyProject: (record, mac) => required.pipe(Effect.mapError(() => WorkCountAcquisition.failure("COUNT_UNAVAILABLE")), Effect.flatMap((value) =>
        value.credentials.countAuthority.verifyProject?.(record, mac) ?? Effect.fail(WorkCountAcquisition.failure("COUNT_UNAVAILABLE")))) },
  })
}))
const bootID = crypto.randomUUID()

function scopeOf(value: WorkRouteApprovalSchema.Evidence): WorkRouteApprovalSchema.Scope {
  return { instanceID: value.instanceID, operatorID: value.operatorID, targetID: value.targetID,
    securityNamespaceID: value.securityNamespaceID, projectScopeKey: value.projectScopeKey,
    locationKey: value.locationKey, canonicalRoot: value.canonicalRoot, namespaceBindingHash: value.namespaceBindingHash }
}
function projection(record: WorkRouteApprovalSchema.Record): WorkRoutePolicy.RouteEvidence {
  const value = record.evidence
  const runtime = WorkProviderContract.projectRuntime(value)
  if (!runtime) throw WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
  const projected = {
    version: "native-route-evidence.v2" as const,
    id: record.approvalID, revision: record.revision, state: record.state, expiresAt: value.expiresAt,
    approvedRouteID: value.routeID, approvalEvidenceHash: record.evidenceHash,
    credentialGeneration: record.credentialGeneration, credentialFingerprint: value.credentialFingerprint,
    nonsecretHeadersHash: value.nonsecretHeadersHash, configuredTargetStamp: value.configuredTargetStamp,
    endpoint: value.endpoint,
    runtime,
    completion: { contractID: value.providerContractID, contractHash: value.providerContractHash,
      parameter: "max_output_tokens" as const, accounting: "all_generated_including_reasoning_and_framing" as const, maxTokens: value.completionLimit },
    counter: { id: value.providerContractID, revision: record.credentialGeneration, endpoint: value.counterEndpoint,
      tokenizerIdentity: value.tokenizerIdentity, framingIdentity: value.framingHash, contractHash: value.providerContractHash,
      semantics: "counterSemantics" in value ? value.counterSemantics : "exact_model_input_including_framing" as const,
      ...("counterSemantics" in value ? { inputUpperBoundTokens: value.inputUpperBoundTokens } : {}) },
  }
  return { ...projected, projectionHash: WorkRoutePolicy.fingerprint(projected) }
}

export * as ProductionWorkExecution from "./work-execution-profile"
