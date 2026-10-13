import { Cause, Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import { WorkCommandMacX64Schema } from "@deepagent-code/core/session/work-command-mac-x64.schema"
import { WorkCommandV2Schema } from "@deepagent-code/core/session/work-command-v2.schema"
import { LLM, LLMClient } from "@deepagent-code/llm"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Global } from "@deepagent-code/core/global"
import { Location } from "@deepagent-code/core/location"
import { LocationRuntimeHost, LocationServiceMap, defaultLocationRuntimeHost, locationServiceMapDependencies } from "@deepagent-code/core/location-layer"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { ReadTool } from "@deepagent-code/core/tool/read"
import { AgentV2 } from "@deepagent-code/core/agent"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorkFileHelper } from "./work-file-helper"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkRouteApproval } from "@deepagent-code/core/session/work-route-approval"
import { WorkRouteApprovalSchema } from "@deepagent-code/core/session/work-route-approval.schema"
import { NativeRuntime } from "./native-runtime"
import { WorkProviderContract } from "./work-provider-contract"
import { ProviderCredentialBinding } from "./provider-credential-binding"
import { OfflineNativeRouteApproval } from "./native-route-approval"
import { NativeInstallationSchema } from "./native-installation.schema"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { WorkFileCapability } from "@deepagent-code/core/session/work-file-capability"

type DiagnosticStage = "operator-command" | "factory-load" | "project-select" | "contract-select" | "location-open" |
  "model-descriptor" | "model-resolve" | "runtime-approve" | "request-bind" | "credential-capture" | "encoder"
const DiagnosticError = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("NativeRuntimeError"), code: NativeRuntime.Error.fields.code }),
  Schema.Struct({ _tag: Schema.Literal("NativeInstallationError"), code: NativeInstallationSchema.Error.fields.code }),
  Schema.Struct({ _tag: Schema.Literal("WorkRouteApproval.Error"), code: WorkRouteApprovalSchema.Error.fields.code }),
  Schema.Struct({ _tag: Schema.Literal("LocalOperator.Error"), code: LocalOperatorSchema.Error.fields.code }),
  Schema.Struct({ _tag: Schema.Literal("WorkFileCapability.Error"), code: WorkFileCapability.Error.fields.code }),
  Schema.Struct({ _tag: Schema.Literals([
    "CatalogV2.ProviderNotFound", "CatalogV2.ModelNotFound", "SessionRunnerModel.ModelNotSelectedError",
    "SessionRunnerModel.UnsupportedApiError", "SessionRunnerModel.ModelProtocolDisabledError",
    "LocationIdentity.RootUnavailableError", "LocationIdentity.NotFoundError", "LocationIdentity.RetiredError",
    "LocationIdentity.ConflictError", "LocationIdentity.WorkUnsettledError",
  ]) }),
])

/** Only fixed classifications leave the process. Raw errors may contain credentials or paths. */
export function diagnostic(stage: DiagnosticStage, cause: Cause.Cause<unknown>) {
  const known = cause.reasons.flatMap((reason) => {
    const value = Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined
    const decoded = Schema.decodeUnknownOption(DiagnosticError)(value)
    return Option.isSome(decoded) ? [decoded.value] : []
  })[0]
  return { version: 1, stage, kind: Cause.hasInterruptsOnly(cause) ? "interrupted" : Cause.hasDies(cause) ? "defect" : "failure",
    tag: known?._tag ?? "unknown", code: known && "code" in known ? known.code : "UNCLASSIFIED" }
}

export const reportDiagnostic = (stage: DiagnosticStage, cause: Cause.Cause<unknown>) => Effect.try({
  try: () => process.stderr.write(`Local operator diagnostic: ${JSON.stringify(diagnostic(stage, cause))}\n`),
  catch: () => undefined,
}).pipe(Effect.ignore)

/** Private lazy construction, shared only by the fixed capture factory and credential binder.
 * The parent CLI Context/Scope is captured before the first command is reconciled. */
class Factory extends Context.Service<Factory, {
  readonly load: Effect.Effect<{
    readonly runtime: NativeRuntime.Interface
    readonly client: Context.Service.Shape<typeof LLMClient.Service>
    readonly locations: Context.Service.Shape<typeof LocationServiceMap>
    readonly contract: Context.Service.Shape<typeof ProviderCredentialBinding.Contract>
  }, WorkRouteApprovalSchema.Error>
}>()("@deepagent-code/OfflineNativeRouteCapture/Factory") {}

export const nativeLayer = Layer.effectContext(Effect.gen(function* () {
  const context = yield* Effect.context<Database.Service | Scope.Scope>()
  const database = Layer.succeed(Database.Service, Context.get(context, Database.Service))
  const load = yield* Effect.cached(Effect.gen(function* () {
    // This path is entered only after authenticated historical reconciliation found no command.
    const gateway = AgentGateway.runtimeLayer({ enabled: false, runsDir: Global.Path.agent.runs, durableLearning: false })
    const clientLayer = NativeRuntime.clientLayer.pipe(Layer.provide(gateway))
    const clients = yield* Layer.build(clientLayer)
    const client = Context.get(clients, LLMClient.Service)
    const native = yield* Layer.build(NativeRuntime.layer.pipe(Layer.provide(Layer.succeed(LLMClient.Service, client))))
    const host = Layer.effect(LocationRuntimeHost, Effect.map(LocationRuntimeHost, (value) => ({ ...value, client })))
      .pipe(Layer.provide(defaultLocationRuntimeHost))
    const locations = yield* Layer.build(LocationServiceMap.layerNoDeps.pipe(Layer.provide([...locationServiceMapDependencies(
      host, database, EventV2.layer.pipe(Layer.provide(database)), gateway, Layer.succeed(LLMClient.Service, client),
    )])))
    const contract = Context.get(yield* Layer.build(WorkProviderContract.layer), ProviderCredentialBinding.Contract)
    return { runtime: Context.get(native, NativeRuntime.Service), client, locations: Context.get(locations, LocationServiceMap), contract }
  }).pipe(Effect.provideContext(context), Effect.tapCause((cause) => reportDiagnostic("factory-load", cause)),
    Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE"))))
  return Context.make(Factory, { load }).pipe(Context.add(ProviderCredentialBinding.NativeFactory, { load }))
}))

/** No public action/DTO can create a capture. This fixed factory runs the actual catalog and
 * encoder, then deliberately terminates inside the native final seal before any HTTP send. */
export const layer = Layer.effect(OfflineNativeRouteApproval.CaptureFactory, Effect.gen(function* () {
  const factory = yield* Factory
  const credentials = yield* ProviderCredentialBinding.Service
  const parent = yield* Effect.context<Scope.Scope>()
  return OfflineNativeRouteApproval.CaptureFactory.of({
    capture: (input) => Effect.gen(function* () {
      const actual = yield* factory.load
      const contract = yield* WorkProviderContract.forModel(input.snapshot).pipe(
        Effect.tapCause((cause) => reportDiagnostic("contract-select", cause)))
      if (input.snapshot !== contract.modelID || input.expiresAt <= Date.now())
        return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
      const context = yield* actual.locations.contextEffect({ directory: AbsolutePath.make(input.scope.canonicalRoot) }).pipe(
        Effect.tapCause((cause) => reportDiagnostic("location-open", cause)))
      return yield* Effect.gen(function* () {
        const location = yield* Location.Service
        if (location.directory !== input.scope.canonicalRoot || location.workspaceID !== undefined)
          return yield* WorkRouteApproval.failure("RUNTIME_MISMATCH")
        // A resolver selection descriptor only, never persisted or admitted as a Session.
        const selected = yield* Schema.decodeUnknownEffect(SessionSchema.Info)({
          id: "ses_offline_route_capture", projectID: location.project.id, permissions: [], cost: 0,
          model: { providerID: contract.providerID, id: input.snapshot },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), updated: Date.now() }, title: "Offline route capture",
          location: { directory: location.directory },
        }).pipe(Effect.tapCause((cause) => reportDiagnostic("model-descriptor", cause)),
          Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")))
        const resolved = yield* (yield* SessionRunnerModel.Service).resolve(selected).pipe(
          Effect.tapCause((cause) => reportDiagnostic("model-resolve", cause)))
        const handle = yield* actual.runtime.approve(resolved).pipe(
          Effect.tapCause((cause) => reportDiagnostic("runtime-approve", cause)))
        const request = LLM.request({ model: resolved.model, system: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.instructions,
          prompt: "Offline native route approval capture.", generation: { maxTokens: 16 }, providerOptions: { openai: { store: false } } })
        const captured: { value?: ProviderCredentialBinding.Capture } = {}
        const stop = Object.freeze({ offlineNativeCaptureComplete: true })
        const seal = yield* actual.runtime.bind(handle, request).pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, {
          seal: (observation) => Effect.gen(function* () {
            captured.value = yield* credentials.captureNative({ runtime: handle, request, observation, ...input }).pipe(
              Effect.tapCause((cause) => reportDiagnostic("credential-capture", cause)))
            return yield* Effect.die(stop)
          }).pipe(Effect.provideService(Scope.Scope, Context.get(parent, Scope.Scope)), Effect.orDie),
        }), Effect.tapCause((cause) => reportDiagnostic("request-bind", cause)))
        const generated = yield* actual.client.generate(request).pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, seal),
          Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
          Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"), Effect.exit)
        if (!captured.value) {
          if (Exit.isFailure(generated)) yield* reportDiagnostic("encoder", generated.cause)
          return yield* WorkRouteApproval.failure("NATIVE_OBSERVATION_REQUIRED")
        }
        return captured.value
      }).pipe(Effect.provideContext(Context.merge(parent, context)), Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")))
    }),
  })
}))

export * as NativeRouteCapture from "./native-route-capture"

/** Explicit offline project enrollment observes the installed registry and native root. These
 * descriptive values are later pinned by the operator command; they are not an execution grant. */
export const projectSelection = Effect.fn("NativeRouteCapture.projectSelection")(function* (input: {
  readonly directory: string; readonly agentID: string; readonly toolIDs: readonly string[]
  readonly commandRecipes?: readonly WorkCommandV2Schema.ApprovedRecipeRequest[]
  readonly childAgentIDs?: readonly string[]
}) {
  const parent = yield* Effect.context()
  const global = yield* Effect.serviceOption(Global.Service)
  const linuxWriteData = process.platform === "linux" && input.toolIDs.includes("write")
    ? Option.isSome(global) ? global.value.data : Global.Path.data : undefined
  const actual = yield* (yield* Factory).load
  const context = yield* actual.locations.contextEffect({ directory: AbsolutePath.make(input.directory) })
  return yield* Effect.gen(function* () {
    const location = yield* Location.Service
    const agent = yield* (yield* AgentV2.Service).select(AgentV2.ID.make(input.agentID))
    if (location.directory !== input.directory || location.workspaceID !== undefined || agent.id !== input.agentID ||
      !input.toolIDs.length || new Set(input.toolIDs).size !== input.toolIDs.length)
      return yield* WorkRouteApproval.failure("RUNTIME_MISMATCH")
    const materialization = yield* (yield* ToolRegistry.Service).materialize({ rulesets: [agent.info?.permissions ?? []] })
    if (input.toolIDs.includes("task")) {
      if (!input.childAgentIDs?.length || input.childAgentIDs.length > 32 ||
        new Set(input.childAgentIDs).size !== input.childAgentIDs.length)
        return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
      const agents = yield* AgentV2.Service
      const { resolveWorkspaceMode, resolveOutputSchema } = yield* Effect.promise(
        () => import("@deepagent-code/core/tool/task-policy"),
      )
      yield* Effect.forEach(input.childAgentIDs, (id) => Effect.gen(function* () {
        const child = yield* agents.get(AgentV2.ID.make(id))
        if (!child || child.hidden || child.mode === "primary" || resolveWorkspaceMode(child) !== "shared" ||
          resolveOutputSchema(undefined, id) !== undefined)
          return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
      }))
    }
    const capabilities = yield* Effect.forEach(input.toolIDs, (id) => Effect.gen(function* () {
      const observed = ToolRegistry.inspect(materialization, id)
      const { WriteTool } = yield* Effect.promise(() => import("@deepagent-code/core/tool/write"))
      const { ManagedCommandTool } = yield* Effect.promise(() => import("@deepagent-code/core/tool/work-command"))
      const { TaskTool } = yield* Effect.promise(() => import("@deepagent-code/core/tool/task"))
      if (!observed || (id === "read" ? !ReadTool.isNativeRead(observed.tool)
        : id === "write" ? (process.platform !== "darwin" && process.platform !== "win32" && process.platform !== "linux") || !WriteTool.isNativeWrite(observed.tool)
        : id === "task" ? !input.childAgentIDs?.length || !TaskTool.isNativeTask(observed.tool)
        : id !== "managed_command" || !ManagedCommandTool.isNativeCommand(observed.tool) || !input.commandRecipes?.length))
        return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
      return { toolID: id, definitionHash: Hash.sha256(CanonicalJson.stringify(observed.definition)),
        operations: [id === "read" ? "read" as const : id === "write" ? "write" as const : id === "task" ? "delegate" as const : "run" as const] }
    }))
    const commandRecipes = input.commandRecipes ? yield* Effect.gen(function* () {
      if (!input.commandRecipes || !input.toolIDs.includes("managed_command")) return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
      const { NativeInstallation } = yield* Effect.promise(() => import("./native-installation"))
      const { WorkCommandRuntime } = yield* Effect.promise(() => import("./work-command-runtime"))
      const installation = yield* NativeInstallation.current()
      return yield* Effect.forEach(input.commandRecipes, (recipe) => Effect.gen(function* () {
        if (recipe.schemaVersion === "work-command-recipe.v1") {
          const runtime = yield* Effect.tryPromise({ try: () => WorkCommandRuntime.verifiedRuntime(installation),
            catch: () => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE") })
          return yield* Schema.decodeUnknownEffect(WorkCommandSchema.Recipe, { onExcessProperty: "error" })({ ...recipe, executable: runtime.executable })
        }
        if (recipe.schemaVersion === "work-command-recipe.mac-x64.v1") {
          const runtime = yield* Effect.tryPromise({ try: () => WorkCommandRuntime.verifiedMacX64Runtime(installation),
            catch: () => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE") })
          return yield* Schema.decodeUnknownEffect(WorkCommandMacX64Schema.Recipe, { onExcessProperty: "error" })({ ...recipe, executable: runtime.executable })
        }
        if (recipe.schemaVersion !== "work-command-recipe.v2") return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
        const { NativeWorkProcessSupervisor } = yield* Effect.promise(() => import("./work-process-supervisor"))
        yield* process.platform === "win32" ? NativeWorkProcessSupervisor.requireWindowsProvisioning
          : NativeWorkProcessSupervisor.requireProvisioning
        const runtime = yield* NativeWorkProcessSupervisor.inspectRuntime(installation)
        if (runtime.executable.platform !== recipe.target) return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
        const { target, ...approved } = recipe
        return yield* Schema.decodeUnknownEffect(WorkCommandV2Schema.Recipe, { onExcessProperty: "error" })({ ...approved, executable: runtime.executable })
      }).pipe(Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE"))))
    }) : undefined
    // Linux enrollment uses only the original Root's captured data directory. The
    // installed helper enters and joins its exact policy before advertising write.
    const project = yield* WorkFileHelper.inspectRoot(location.directory,
      linuxWriteData ? { linuxWriteData } : undefined)
    if (process.platform === "win32" && input.toolIDs.includes("write")) {
      if (project.rootIdentity.kind !== "windows") return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
      const { WindowsWorkWriteCleanup } = yield* Effect.promise(() => import("./windows-work-write-cleanup"))
      // Enrollment observes the original helper's capability and joined lifecycle;
      // it neither reserves storage nor creates a Work or write stage.
      yield* WindowsWorkWriteCleanup.capabilities(project.helperHash, location.directory, project.rootIdentity).pipe(
        Effect.scoped,
        Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")),
      )
    }
    return { ...project, projectID: location.project.id, capabilities, commandRecipes }
  // Windows file observations must retain the original Root's Native factory;
  // the Location still owns all project, model and tool registry services.
  }).pipe(Effect.provideContext(process.platform === "win32" ? Context.merge(parent, context) : context))
})
