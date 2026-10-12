// Test-only signed CLI overlay. The original enrolled policy must already contain one reviewed
// DeepSeek write -> managed_command -> readonly origin and its ordinary source Session.
// Darwin run mode retains its historical scoped qualification availability. Windows runs use
// the original product gate. Native/configuration/count/permissions/budgets/Runner remain original.
import fs from "node:fs/promises"
import { Cause, Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventWorkController } from "@deepagent-code/core/deepagent/event-work-controller"
import { EventWorkResult } from "@deepagent-code/core/deepagent/event-work-result"
import { EventWorkDagPolicy } from "@deepagent-code/core/deepagent/event-work-dag.policy"
import { EventWorkNodeAuthority } from "@deepagent-code/core/deepagent/event-work-node-authority"
import { EventWorkRuleSchema } from "@deepagent-code/core/deepagent/event-work-rule.schema"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { SessionRunCoordinator } from "@deepagent-code/core/session/run-coordinator"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { WorkProviderContract } from "@/installation/work-provider-contract"
import { WorkRouteApproval } from "@deepagent-code/core/session/work-route-approval"
import { NativeInstallation } from "@/installation/native-installation"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { AgentV2 } from "@deepagent-code/core/agent"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { Service } from "@/installation/work-execution-profile"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { Server } from "@/server/server"
import { ServerAuth } from "@/server/auth"
import { EventWorkDagRuntime } from "@/session/event-work-dag-runtime"
import { cmd } from "@/cli/cmd/cmd"

const Input = Schema.Union([Schema.Struct({ mode: Schema.Literal("operator-context") }),
  Schema.Struct({ mode: Schema.Literals(["terminal-preflight", "known-turn-preflight"]), workID: Schema.String, expectedAccept: Schema.Boolean,
    expectedProviderCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.Struct({ mode: Schema.Literal("setup-source"), directory: Schema.String }), Schema.Struct({ originID: Schema.String, ruleID: Schema.String,
  mode: Schema.Literals(["run", "cold-read", "collect-known", "route-config", "product-readiness"]),
  triggerText: Schema.String, instruction: Schema.String,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(900_000)),
  expectedProviderCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})])

export async function runQualification() {
  const output = process.env.DAC_EVENT_DAG_RESULT
  const descriptor = process.env.DAC_EVENT_DAG_INPUT
  if (!output || !descriptor) throw new Error("Private qualification input and result paths are required")
  const progress: Record<string, unknown> = { scope: "actual-installed-root-test-only-availability-gate",
    productReadinessAccepted: false, stage: "input" }
  const lifecycle: { current?: () => boolean } = {}
  const streamed: { sessionID: string; messageID: string; partID: string; delta: string }[] = []
  const streamState = { overflow: false }
  const outcome = await AppRuntime.runPromise(Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Input))(
      yield* Effect.promise(() => fs.readFile(descriptor, "utf8")))
    if (input.mode === "setup-source") {
      const source = yield* (yield* SessionV2.Service).create({
        title: "Actual DeepSeek ordinary dirty source for full Event DAG", agent: AgentV2.ID.make("auto"),
        model: { providerID: ProviderV2.ID.make("deepseek"), id: ModelV2.ID.make("deepseek-flash") },
        location: { directory: AbsolutePath.make(input.directory) },
        permissions: [{ action: "*", resource: "*", effect: "deny" },
          ...["read", "write", "edit"].map((action) => ({ action, resource: "*", effect: "allow" as const }))],
      })
      progress.stage = "ordinary-source-created-no-provider"
      progress.sourceSessionID = source.id
      progress.projectID = source.projectID
      return
    }
    const database = yield* Database.Service
    const installed = yield* Service
    if ("workID" in input) {
      if (!installed.leafProof) throw new Error("Original installed Native leaf proof service is unavailable")
      const observe = () => database.db.get<{ providers: number; work: string; workspace: string }>(sql`SELECT
        (SELECT count(*) FROM session_provider_attempt) providers,
        (SELECT json_group_array(json_object('id',work_id,'outcome',outcome,'revision',control_revision,'binding',binding_hash)) FROM work_execution) work,
        (SELECT json_group_array(json_object('event',event_id,'task',task_id,'state',state,'error',error,'ref',continuation_ref)) FROM event_task_workspace) workspace`)
      const before = yield* observe()
      if (!before || before.providers !== input.expectedProviderCount) throw new Error("Original known provider census differs before classification")
      const classified = yield* Effect.gen(function* () {
        if (input.mode === "known-turn-preflight") {
          const authority = yield* EventWorkNodeAuthority.get(database.db, input.workID)
          if (!authority?.terminal || !authority.placement || !authority.artifactCustody)
            throw new Error("Known turn preflight requires the original sealed terminal and Native placement")
          const controller = yield* EventWorkController.read(database.db, { eventID: authority.placement.eventID })
          const node = controller?.controller.plan.nodes.find((node) => node.id === authority.nodeID)
          if (!controller || !node) throw new Error("Original known node lacks its exact controller plan")
          progress.consumerStage = "original-known-turn-and-dependency-continuation"
          const result = yield* (yield* EventWorkDagRuntime.make).run({ eventID: controller.receipt.eventID,
            taskID: authority.nodeID, agentType: node.agentID, prompt: authority.inputText,
            parentSessionID: authority.rootSessionID, requiresWriteIsolation: node.requiresWriteIsolation })
          if (!result.ok || result.sessionID !== authority.childSessionID || result.continuationRef !== authority.terminal.workspaceRef ||
            result.continuationRef !== authority.artifactCustody.commit || !result.artifacts?.includes(`git-ref:${result.continuationRef}`))
            throw new Error("The original known turn did not transport its exact immutable artifact to the dependency consumer")
          progress.knownTurn = { continuationRef: result.continuationRef, originalTerminalRef: authority.terminal.workspaceRef,
            originalArtifactCommit: authority.artifactCustody.commit, sessionID: result.sessionID, providerRequests: 0 }
          return
        }
        progress.consumerStage = "original-native-terminal-authentication"
        yield* EventWorkResult.prepareTerminal(database.db, input.workID)
        progress.consumerStage = "original-known-execution-sql-consumption"
        yield* database.db.transaction((tx) => EventWorkResult.requireKnownExecution(tx, input.workID))
      }).pipe(Effect.provideService(WorkToolPolicy.LeafProof, installed.leafProof), Effect.exit)
      const after = yield* observe()
      if (EventWorkDagPolicy.hash(before) !== EventWorkDagPolicy.hash(after)) throw new Error("Read-only classification altered original Work/workspace/provider facts")
      progress.accepted = Exit.isSuccess(classified)
      if (Exit.isFailure(classified)) {
        const error = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.optional(Schema.String), code: Schema.optional(Schema.String) }))(Cause.squash(classified.cause))
        progress.classification = Option.isSome(error) ? error.value : { _tag: "UNCLASSIFIED" }
      }
      progress.providerIncrement = 0
      progress.workWorkspaceUnchanged = true
      progress.stage = "original-native-terminal-classification-complete"
      if (Exit.isSuccess(classified) !== input.expectedAccept) throw new Error("Original known terminal consumer classification differs from expected acceptance")
      return
    }
    if (input.mode === "operator-context") {
      if (!installed.eventOperator) throw new Error("The original installed factory did not capture an operator")
      const original = yield* Layer.build(WorkExecutionProfile.servicesLayer(installed))
      if (Context.getOption(original, LocalOperator.Runtime)._tag !== "Some" ||
        Context.getOption(original, LocalOperator.Runtime).pipe(Option.getOrUndefined) !== installed.eventOperator)
        throw new Error("Services registration changed the original Host identity")
      const consume = (context: Context.Context<never>) => Effect.gen(function* () {
        const coordinator = yield* SessionRunCoordinator.make({
          started: () => database.db.transaction((tx) => LocalOperator.requireCurrent(tx)).pipe(Effect.asVoid),
          drain: () => Effect.succeed("original-started-consumer-accepted"),
        })
        return yield* coordinator.run("operator-capture-only")
      }).pipe(Effect.updateContext((ambient: Context.Context<Scope.Scope>) => Context.merge(ambient.pipe(Context.omit(LocalOperator.Runtime)), context)), Effect.scoped, Effect.exit)
      const captured = yield* consume(original)
      const missing = yield* consume(original.pipe(Context.omit(LocalOperator.Runtime)))
      const foreign = yield* consume(Context.add(original, LocalOperator.Runtime,
        { ...installed.eventOperator, installationKeyHash: "0".repeat(64) }))
      const code = (result: typeof missing) => {
        if (Exit.isSuccess(result)) return "ACCEPTED"
        const error = Cause.squash(result.cause)
        return error instanceof LocalOperatorSchema.Error ? error.code : "UNCLASSIFIED"
      }
      progress.captureProbe = { captured: code(captured), missing: code(missing), foreign: code(foreign), providerRequests: 0 }
      if (Exit.isFailure(captured) || captured.value !== "original-started-consumer-accepted" ||
        code(missing) !== "LOCAL_OPERATOR_UNAVAILABLE" || code(foreign) !== "LOCAL_OPERATOR_INSTALLATION_MISMATCH")
        throw new Error("Original captured coordinator identity consumer did not preserve exact acceptance and denial")
      progress.stage = "original-installed-operator-coordinator-capture-complete"
      progress.operatorContext = { exactFactoryIdentity: true, originalCoordinatorStarted: true,
        missing: code(missing), foreign: code(foreign), mutationProvided: Context.getOption(original, LocalOperator.Mutation)._tag === "Some",
        providerRequests: 0 }
      if (Context.getOption(original, LocalOperator.Mutation)._tag === "Some") throw new Error("Runtime registration must not provide a Mutation")
      return
    }
    const operatorRuntime = yield* installed.eventWorkAuthority
    const actor = yield* database.db.transaction((tx) => LocalOperator.requireCurrent(tx))
      .pipe(Effect.provideService(LocalOperator.Runtime, operatorRuntime))
    if (actor.policy.version !== 4 || !installed.eventPlacement) throw new Error("Original DAG policy/factory is unavailable")
    const origin = actor.policy.eventOrigins.find((value) => value.id === input.originID)
    const target = actor.policy.targets.find((value) => value.id === origin?.targetID)?.target
    if (!origin || !Schema.is(EventWorkRuleSchema.DagOrigin)(origin) || !target || !("version" in target) ||
      target.provider.providerID !== "deepseek" || target.provider.modelID !== "deepseek-flash" ||
      target.profile.id !== "event_deepseek_dag_v1" || target.location.workspaceID !== undefined ||
      !["darwin", "linux", "win32"].includes(process.platform)) throw new Error("Qualification requires the original supported DeepSeek DAG target")
    const plan = origin.execution.plan
    if (plan.nodes.length !== 3 || !plan.nodes[0]!.requiresWriteIsolation || !plan.nodes[0]!.toolIDs.includes("write") ||
      !plan.nodes[1]!.requiresWriteIsolation || !plan.nodes[1]!.toolIDs.includes("managed_command") || plan.nodes[1]!.dependencies.length !== 1 ||
      plan.nodes[1]!.dependencies[0] !== plan.nodes[0]!.id || plan.nodes[2]!.requiresWriteIsolation ||
      plan.nodes[2]!.toolIDs.some((id) => id !== "read") || plan.nodes[2]!.dependencies.length !== 1 ||
      plan.nodes[2]!.dependencies[0] !== plan.nodes[1]!.id) throw new Error("Qualification requires the complete reviewed three-node graph")
    const source = yield* (yield* SessionV2.Service).get(SessionSchema.ID.make(origin.sourceSessionID))
    if (source.parentID || source.location.workspaceID !== undefined || source.location.directory !== target.location.directory || source.projectID !== target.projectScope.projectID)
      throw new Error("The original ordinary source Session does not match the enrolled target")
    if (source.model?.providerID !== "deepseek" || source.model.id !== "deepseek-flash")
      throw new Error("The ordinary source must explicitly select DeepSeek before qualification")
    if (input.mode === "route-config") {
      const route = yield* database.db.transaction((tx) => WorkRouteApproval.requireCurrent(tx, target.provider.evidenceID))
        .pipe(Effect.provideService(LocalOperator.Runtime, operatorRuntime), Effect.provideService(WorkRouteApproval.Authority, installed.approval))
      const location = yield* (yield* LocationServiceMap).contextEffect(source.location)
      const resolved = yield* Context.get(location, SessionRunnerModel.Service).resolve(source).pipe(Effect.provideContext(location))
      const expected = WorkProviderContract.projectRuntime(route.evidence)
      if (!expected || resolved.model.provider !== "deepseek" || resolved.model.id !== "deepseek-flash" ||
        resolved.model.route.id !== expected.routeID || expected.routeID !== "openai-compatible-responses" ||
        resolved.model.route.protocol !== expected.protocol || expected.protocol !== "openai-responses")
        throw new Error("Original model construction and actual Native-approved provider contract adapters differ")
      progress.stage = "original-installed-model-approved-route-consumer-complete"
      progress.routeConfiguration = { providerID: resolved.model.provider, modelID: resolved.model.id,
        actualAdapterID: resolved.model.route.id, approvedAdapterID: expected.routeID, protocol: resolved.model.route.protocol,
        originalCurrentNativeApproval: true, providerRequests: 0 }
      return
    }
    progress.planHash = EventWorkDagPolicy.hash(plan)
    progress.mode = input.mode
    const before = yield* census(database.db, input.ruleID)
    progress.before = before
    if (input.mode !== "run" && (input.expectedProviderCount === undefined || before.providers !== input.expectedProviderCount))
      throw new Error("Cold qualification requires the prior process's exact provider census; startup must not replay")
    if (input.mode === "run" || input.mode === "product-readiness") {
      const existing = yield* database.db.get(sql`SELECT rule_id FROM event_work_rule WHERE rule_id=${input.ruleID}`)
      if (existing) throw new Error("Qualification runs once; existing/unknown Work must be read without replay")
      const original = installed.eventPlacement
      if (input.mode === "run" && process.platform !== "win32") {
        const available = Object.getOwnPropertyDescriptor(original, "available")
        const availableCurrent = Object.getOwnPropertyDescriptor(original, "availableCurrent")
        if (!available?.configurable || !availableCurrent?.configurable) throw new Error("Test-only gate cannot be scoped safely")
        const exact = (candidate: Parameters<typeof original.available>[0], graph: Parameters<typeof original.available>[1]) =>
          EventWorkDagPolicy.hash(candidate) === EventWorkDagPolicy.hash(target) && EventWorkDagPolicy.hash(graph) === EventWorkDagPolicy.hash(plan)
        yield* Effect.acquireRelease(Effect.sync(() => {
          Object.defineProperties(original, {
            available: { ...available, value: (candidate: Parameters<typeof original.available>[0], graph: Parameters<typeof original.available>[1]) => Effect.succeed(exact(candidate, graph)) },
            availableCurrent: { ...availableCurrent, value: exact },
          })
        }), () => Effect.sync(() => Object.defineProperties(original, { available, availableCurrent })))
      }
      if (input.mode === "run" && process.platform === "win32") {
        progress.scope = "original-windows-product-gate-and-public-dag-control"
        lifecycle.current = () => original.availableCurrent(target, plan)
      }
      if (input.mode === "product-readiness") {
        progress.scope = "original-production-readiness-and-public-rule-control"
        const wrongProfile = { ...target, profile: { ...target.profile, hash: "0".repeat(64) } }
        const wrongModel = { ...target, provider: { ...target.provider, modelID: "unapproved-model" } }
        const wrongTools = { ...target, toolPolicy: { ...target.toolPolicy,
          capabilities: target.toolPolicy.capabilities.filter((capability) => capability.toolID !== "write") } }
        const wrongHelper = { ...target, projectScope: { ...target.projectScope, helperHash: "0".repeat(64) } }
        const rejected = yield* Effect.forEach([wrongProfile, wrongModel, wrongTools, wrongHelper],
          (candidate) => original.available(candidate, plan))
        const foreignPlanCurrent = original.availableCurrent(target, { ...plan, id: `${plan.id}-unprepared` })
        const accepted = yield* original.available(target, plan)
        if (rejected.some(Boolean) || foreignPlanCurrent || !accepted || !original.availableCurrent(target, plan))
          throw new Error("Original signed production readiness did not preserve profile/model/tools/helper/plan fences")
        progress.readiness = { accepted, rejected, foreignPlanCurrent, exactCurrent: true, platform: process.platform,
          availabilityOverride: false, providerRequests: 0 }
        lifecycle.current = () => original.availableCurrent(target, plan)
      }
      progress.stage = "current-approved-native-route-preflight"
      const route = yield* database.db.transaction((tx) => WorkRouteApproval.requireCurrent(tx, target.provider.evidenceID))
        .pipe(Effect.provideService(LocalOperator.Runtime, operatorRuntime), Effect.provideService(WorkRouteApproval.Authority, installed.approval))
      const verified = yield* NativeInstallation.current()
      const installation = yield* NativeInstallation.describe(verified)
      if (route.evidence.configurationStamp !== target.provider.configurationHash || route.evidenceHash !== target.provider.evidenceHash ||
        route.evidence.binaryHash !== installation.executableHash || route.evidence.componentsHash !== installation.componentsHash ||
        route.evidence.releaseID !== installation.releaseID || route.evidence.expiresAt < Date.now() + input.timeoutMs)
        throw new Error("Approve the current signed module's exact Native route before creating a rule or dispatching a model")
      progress.preflight = { originalCurrentRoute: true, signedInstallation: true, configurationStampMatched: true,
        binaryHash: installation.executableHash, componentsHash: installation.componentsHash, releaseID: installation.releaseID,
        testOnlyQualificationAvailability: input.mode === "run" && process.platform !== "win32",
        availabilityOverride: input.mode === "run" && process.platform !== "win32", providerRequestsBeforePreflight: 0 }
      progress.stage = "original-http-rule-control"
      const config = yield* ServerAuth.Config
      const configured = yield* LocalTaskAuthority.configured(config)
      yield* LocalTaskAuthority.authenticatePassword(database.db, configured.runtime, config.username, configured.password)
      const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
        (listener) => Effect.promise(() => listener.stop(true)))
      const control = (body: unknown) => Effect.tryPromise({ try: async () => {
        const route = new URL("/api/v1/event-work/rules/control", listener.url)
        route.searchParams.set("directory", target.location.directory)
        const response = await fetch(route, { method: "POST", headers: { "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${config.username}:${configured.password}`).toString("base64")}` }, body: JSON.stringify(body) })
        if (response.status !== 200) throw new Error(`Original event rule control refused (${response.status})`)
        await response.arrayBuffer()
      }, catch: (error) => error instanceof Error ? error : new Error("Original event rule control failed") })
      const candidateRoute = new URL("/api/v1/event-work/candidates", listener.url)
      candidateRoute.searchParams.set("directory", target.location.directory)
      const availableCandidates = yield* Effect.tryPromise({ try: async () => {
        const response = await fetch(candidateRoute, { method: "POST", headers: { "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${config.username}:${configured.password}`).toString("base64")}` },
          body: JSON.stringify({ sourceSessionID: source.id }) })
        if (response.status !== 200) throw new Error(`Original candidate validation refused (${response.status})`)
        return await response.json() as unknown
      }, catch: (error) => error instanceof Error ? error : new Error("Original candidate validation failed") })
      if (!Array.isArray(availableCandidates) || !availableCandidates.some((candidate) => candidate.originID === origin.id && candidate.available &&
        candidate.providerID === "deepseek" && candidate.modelID === "deepseek-flash" && candidate.planHash === progress.planHash))
        throw new Error("Original public candidate validation did not approve this exact qualification target and plan")
      progress.publicCandidateValidation = true
      yield* NativeInstallation.requireCurrent(verified)
      yield* control({ sourceSessionID: source.id, ruleID: input.ruleID, requestID: `${input.ruleID}:create`,
        action: "create", expectedRevision: 0, originID: origin.id, instruction: input.instruction,
        expiresAt: Date.now() + input.timeoutMs })
      yield* control({ sourceSessionID: source.id, ruleID: input.ruleID, requestID: `${input.ruleID}:enable`,
        action: "enable", expectedRevision: 1 })
      if (input.mode === "product-readiness") {
        const enabled = yield* database.db.get<{ state: string }>(sql`SELECT state FROM event_work_rule WHERE rule_id=${input.ruleID}`)
        const after = yield* census(database.db, input.ruleID)
        if (enabled?.state !== "enabled" || after.providers !== before.providers || after.receipts !== 0 || after.nodes !== 0)
          throw new Error("Normal product rule control created execution or failed to enable the original approved origin")
        progress.after = after
        progress.productReadinessAccepted = true
        progress.stage = "normal-production-candidate-create-enable-complete"
        return
      }
      if (process.platform === "win32") {
        const { EventV2Bridge } = yield* Effect.promise(() => import("@/event-v2-bridge"))
        const { SessionV1 } = yield* Effect.promise(() => import("@deepagent-code/core/v1/session"))
        yield* Effect.acquireRelease((yield* EventV2Bridge.Service).listen((event) => Effect.sync(() => {
          if (!Schema.is(SessionV1.Event.PartDelta)(event) || event.data.field !== "text") return
          if (streamed.length >= 64 || Buffer.byteLength(event.data.delta) > 4096) { streamState.overflow = true; return }
          streamed.push(event.data)
        })), (unsubscribe) => unsubscribe)
      }
      progress.stage = "ordinary-source-trigger"
      const sessions = yield* SessionV2.Service
      yield* sessions.prompt({ sessionID: source.id, prompt: Prompt.fromUserMessage({ text: input.triggerText }), delivery: "queue", resume: false })
      yield* sessions.resume(source.id)
      progress.stage = "original-cadence-dispatch-and-runner"
      const deadline = Date.now() + input.timeoutMs
      while (Date.now() < deadline) {
        const row = yield* database.db.get<{ state: string }>(sql`SELECT c.state FROM event_work_controller c
          JOIN event_work_receipt r ON r.receipt_id=c.receipt_id WHERE r.rule_id=${input.ruleID}`)
        if (row?.state === "succeeded") break
        if (row?.state === "failed" || row?.state === "unknown") throw new Error(`Original DAG ended ${row.state}; no replay`)
        const blocked = yield* database.db.get<{ reason: string }>(sql`SELECT json_extract(e.payload,'$.reason') reason
          FROM deepagent_event e JOIN event_work_receipt r ON r.event_id=e.causation_id
          WHERE r.rule_id=${input.ruleID} AND (e.type='agent.task.needs_human' OR e.type='agent.task.blocked'
            AND json_extract(e.payload,'$.reason') IN ('event_node_execution_unavailable','event_node_terminal_unavailable',
              'dependency_continuation_missing','dependency_not_met')) LIMIT 1`)
        if (blocked) throw new Error(`Original graph requires human recovery (${blocked.reason}); no replay`)
        yield* Effect.sleep(250)
      }
    }
    const receipt = yield* database.db.get<{ event_id: string }>(sql`SELECT event_id FROM event_work_receipt WHERE rule_id=${input.ruleID}`)
    if (!receipt) throw new Error("Original ordinary terminal produced no event receipt")
    const value = yield* EventWorkController.read(database.db, { eventID: receipt.event_id })
    if (!value) throw new Error("Original cadence produced no formal controller")
    progress.controllerState = value.controller.state
    progress.stage = "original-known-terminal-read"
    const dag = yield* EventWorkDagRuntime.make
    const terminals = yield* Effect.forEach(plan.nodes, (node) => dag.readKnown(receipt.event_id, node.id))
    if (value.controller.state !== "succeeded" || terminals.some((terminal) => !terminal || terminal.terminal.outcome !== "succeeded"))
      throw new Error("Original complete graph has no three known successful terminal proofs")
    progress.nodes = terminals.map((terminal) => ({ nodeID: terminal!.terminal.nodeID, workID: terminal!.terminal.workID,
      sessionID: terminal!.terminal.sessionID, outcome: terminal!.terminal.outcome, commit: terminal!.terminal.workspaceCommit,
      resultHash: terminal!.terminal.resultHash, terminalHash: EventWorkDagPolicy.hash(terminal!.terminal), chargedTokens: terminal!.terminal.chargedTokens }))
    const rootProvider = yield* database.db.get<{ count: number }>(sql`SELECT count(*) count FROM session_v2_provider_turn_receipt
      WHERE session_id=${value.controller.rootSessionID}`)
    if (rootProvider?.count !== 0) throw new Error("The controller incorrectly executed a provider turn")
    if (input.mode === "collect-known") {
      progress.stage = "original-known-retention-collection"
      progress.collected = yield* Effect.forEach(terminals, (terminal) => originalCollect(installed, terminal!.terminal.workID))
    }
    const after = yield* census(database.db, input.ruleID)
    progress.after = after
    if (input.mode !== "run" && after.providers !== before.providers) throw new Error("Cold accounting/read must not create provider work")
    const commands = yield* database.db.get<{ count: number }>(sql`SELECT count(*) count FROM work_command_intent
      WHERE root_work_id=${value.controller.rootWorkID} AND work_id=${terminals[1]!.terminal.workID} AND state='settled'
        AND json_extract(record,'$.outcome')='exited' AND json_extract(record,'$.exitCode')=0
        AND json_extract(record,'$.stopConfirmed')=1`)
    const writes = yield* database.db.get<{ count: number }>(sql`SELECT count(*) count FROM work_write_stage
      WHERE root_work_id=${value.controller.rootWorkID} AND work_id=${terminals[0]!.terminal.workID} AND state='published'`)
    if (!commands?.count || !writes?.count) throw new Error("Graph lacks actual managed-command and published-write results")
    const wrongProvider = yield* database.db.get<{ count: number }>(sql`SELECT count(*) count FROM session_v2_provider_turn_receipt p
      JOIN work_execution w ON w.session_id=p.session_id WHERE w.root_work_id=${value.controller.rootWorkID}
        AND (p.provider_id<>'deepseek' OR p.model_id<>'deepseek-flash' OR p.state<>'settled' OR p.error_code IS NOT NULL)`)
    if (wrongProvider?.count !== 0) throw new Error("Graph contains non-DeepSeek or unsettled provider work")
    progress.actualManagedCommands = commands.count
    progress.actualPublishedWrites = writes.count
    if (process.platform === "win32") {
      const originalWorks = yield* database.db.all<{ workID: string; sessionID: string; role: string; parentWorkID: string | null;
        profile: string; outcome: string; parentSessionID: string | null; providers: number; effects: number; reads: number; writes: number; commands: number }>(sql`SELECT
        w.work_id workID,w.session_id sessionID,w.execution_role role,w.parent_work_id parentWorkID,
        json_extract(w.binding,'$.profile.id') profile,w.outcome,s.parent_id parentSessionID,
        (SELECT count(*) FROM session_v2_provider_turn_receipt p WHERE p.session_id=w.session_id) providers,
        (SELECT count(*) FROM session_v2_tool_effect e WHERE e.session_id=w.session_id) effects,
        (SELECT count(*) FROM session_v2_tool_effect e WHERE e.session_id=w.session_id AND e.known_read_proof IS NOT NULL) reads,
        (SELECT count(*) FROM session_v2_tool_effect e WHERE e.session_id=w.session_id AND e.known_write_proof IS NOT NULL) writes,
        (SELECT count(*) FROM session_v2_tool_effect e WHERE e.session_id=w.session_id AND e.known_command_proof IS NOT NULL) commands
        FROM work_execution w LEFT JOIN session s ON s.id=w.session_id WHERE w.root_work_id=${value.controller.rootWorkID}`)
      const controller = originalWorks.find((work) => work.workID === value.controller.rootWorkID)
      if (originalWorks.length !== 4 || !controller || controller.role !== "dag_controller" || controller.parentWorkID !== null ||
        controller.parentSessionID !== null || controller.providers !== 0 || controller.effects !== 0 || controller.outcome !== "succeeded")
        throw new Error("Windows original zero-provider controller lineage differs")
      for (const terminal of terminals) {
        const child = originalWorks.find((work) => work.workID === terminal!.terminal.workID)
        if (!child || child.sessionID !== terminal!.terminal.sessionID || child.role !== "agent" || child.parentWorkID !== controller.workID ||
          child.parentSessionID !== controller.sessionID || child.profile !== "event_deepseek_dag_v1" || child.outcome !== "succeeded")
          throw new Error("Windows original child Work and Session lineage differs")
      }
      const unresolved = yield* database.db.get<{ count: number }>(sql`SELECT
        (SELECT count(*) FROM session_v2_tool_effect e JOIN work_execution w ON w.session_id=e.session_id
          WHERE w.root_work_id=${controller.workID} AND (e.state<>'settled' OR e.error_code IS NOT NULL))+
        (SELECT count(*) FROM work_count_acquisition a WHERE a.root_work_id=${controller.workID} AND a.state<>'settled')+
        (SELECT count(*) FROM work_dispatch_reservation d WHERE d.root_work_id=${controller.workID} AND d.state<>'settled') count`)
      if (unresolved?.count !== 0) throw new Error("Windows original graph retains unresolved dispatch/count/effect debt")
      progress.windowsOriginalLineage = originalWorks
      if (input.mode === "run") {
        if (streamState.overflow) throw new Error("Windows live projection exceeded its fixed observation bound")
        progress.windowsFinalStreams = yield* Effect.forEach(terminals, (terminal) => Effect.gen(function* () {
          const parts = streamed.filter((entry) => entry.sessionID === terminal!.terminal.sessionID)
          const partID = parts[0]?.partID
          const selected = parts.filter((entry) => entry.partID === partID)
          const final = partID && (yield* database.db.get<{ text: string; ended: number | null }>(sql`SELECT
            json_extract(data,'$.text') text,json_extract(data,'$.time.end') ended FROM part
            WHERE id=${partID} AND session_id=${terminal!.terminal.sessionID}`))
          if (!final || selected.length < 2 || final.ended === null || final.text !== selected.map((entry) => entry.delta).join(""))
            throw new Error("Windows live same-part text deltas differ from their durable final")
          return { sessionID: terminal!.terminal.sessionID, partID, deltas: selected.length,
            finalBytes: Buffer.byteLength(final.text), finalHash: EventWorkDagPolicy.hash(final.text), samePartCanonical: true }
        }))
      }
      progress.windowsCustody = yield* Effect.forEach(terminals, (terminal) => Effect.gen(function* () {
        const known = yield* EventWorkNodeAuthority.get(database.db, terminal!.terminal.workID)
        if (!known?.artifactCustody || known.artifactCustody.commit !== terminal!.terminal.workspaceCommit ||
          input.mode === "collect-known" && known.artifactCustody.cleanup?.state !== "collected")
          throw new Error("Windows immutable artifact or explicit known collection differs")
        return { nodeID: known.nodeID, commit: known.artifactCustody.commit, cleanup: known.artifactCustody.cleanup?.state ?? "retained",
          worktreeAllocatedBytes: known.artifactCustody.worktreeAllocatedBytes, gitAllocatedBytes: known.artifactCustody.gitAllocatedBytes,
          indexAllocatedBytes: known.artifactCustody.indexAllocatedBytes }
      }))
    }
    progress.stage = process.platform === "win32" ? "complete-original-windows-dag" : "complete-qualification-only"
  }).pipe(Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped, Effect.exit))
  if (Exit.isFailure(outcome)) { progress.error = Cause.pretty(outcome.cause); process.exitCode = 1 }
  await AppRuntime.dispose()
  if (lifecycle.current) {
    progress.rootRetiredRefused = !lifecycle.current()
    if (!progress.rootRetiredRefused) { progress.error = "Retired original Root retained advertised availability"; process.exitCode = 1 }
  }
  await fs.writeFile(output, JSON.stringify(progress, null, 2), { mode: 0o600 })
}
export const DebugCommand = cmd({ command: "debug", handler: runQualification })

function census(db: Database.Interface["db"], ruleID: string) {
  return Effect.gen(function* () {
    return {
      receipts: (yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM event_work_receipt WHERE rule_id=${ruleID}`))!.count,
      nodes: (yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM event_work_node_authority n
        JOIN event_work_receipt r ON r.receipt_id=n.receipt_id WHERE r.rule_id=${ruleID}`))!.count,
      providers: (yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM session_v2_provider_turn_receipt`))!.count,
    }
  })
}

function originalCollect(installed: Service["Service"], workID: string) {
  return Effect.gen(function* () {
    const authority = yield* EventWorkNodeAuthority.get((yield* Database.Service).db, workID)
    if (!authority?.terminal || !installed.eventPlacement || !installed.leafProof) throw new Error("Original known custody is unavailable")
    return yield* installed.eventPlacement.collectKnown(workID)
  })
}
