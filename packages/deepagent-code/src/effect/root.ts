import { Context, Effect, Layer } from "effect"
import { LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { Database } from "@deepagent-code/core/database/database"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { makeMemoMap } from "@deepagent-code/core/effect/memo-map"
import { TaskRunDispatcher } from "@deepagent-code/core/session/task-run-dispatcher"
import { V2OwnerSeed } from "@deepagent-code/core/session/runner/v2-owner-seed"
import { MCP } from "@/mcp"
import { ToolRegistry } from "@/tool/registry"
import { InstanceRegistry } from "@/effect/instance-registry"
import { V2McpBridge } from "@/session/v2-mcp-bridge"
import { V2PluginToolsBridge } from "@/session/v2-plugin-tools-bridge"
import { V2RunnerFrame } from "@/session/v2-runner-frame"
import { PromptEpoch } from "@/session/prompt-epoch"
import { DurableLearningRuntime } from "@/deepagent/learning-runtime"
import { RecoveryExecutor } from "@/server/recovery-executor"
import { TaskWorktreeReclamation } from "@/effect/task-worktree-reclamation"
import { productionSourcesLayer } from "@/context-federation/production-sources"
import { EventV2Bridge } from "@/event-v2-bridge"

/** Shared by both production roots. Settings and Work use the same original
 * Native capture; their factories complete before merged consumers are built. */
export const windowsStorageLayer = Layer.effectContext(Effect.gen(function* () {
  if (process.platform !== "win32") return Context.empty()
  const { NativeInstallation } = yield* Effect.promise(() => import("@/installation/native-installation"))
  const { NativeWindowsBootstrap } = yield* Effect.promise(() => import("@/installation/windows-native-bootstrap"))
  const { WindowsSettingsStorage } = yield* Effect.promise(() => import("@/installation/windows-settings-storage"))
  const { NativeWindowsWorkFactory } = yield* Effect.promise(() => import("@/installation/windows-work-factory"))
  const { WindowsWorkCommandRuntime } = yield* Effect.promise(() => import("@/installation/windows-work-command-runtime"))
  const { WindowsPrivateStorage } = yield* Effect.promise(() => import("@/installation/windows-private-storage"))
  const { McpWindowsStorage } = yield* Effect.promise(() => import("@/mcp/windows-storage"))
  const { Global } = yield* Effect.promise(() => import("@deepagent-code/core/global"))
  if (!(yield* NativeWindowsBootstrap.Registered)) return Context.empty()
  const bootstrap = yield* NativeWindowsBootstrap.make(yield* NativeInstallation.current())
  const native = Context.make(NativeWindowsBootstrap.Service, bootstrap)
  const settings = yield* Layer.build(WindowsSettingsStorage.layer.pipe(
    Layer.provide(Layer.succeed(NativeWindowsBootstrap.Service, bootstrap))))
  // Only this trusted startup phase may create the fixed new private MCP
  // directory. Ordinary reads/writes never prepare or adopt existing custody.
  // A refused MCP-only store does not prevent unrelated Desktop use.
  yield* WindowsPrivateStorage.make("mcp_secret_envelopes", true).pipe(Effect.asVoid, Effect.scoped,
    Effect.provideService(NativeWindowsBootstrap.Service, bootstrap),
    Effect.catchTag("WindowsPrivateStorageError", () => Effect.void))
  const work = yield* Layer.build(NativeWindowsWorkFactory.layer.pipe(
    Layer.provide(Layer.succeed(NativeWindowsBootstrap.Service, bootstrap))))
  const mcp = yield* Layer.build(McpWindowsStorage.layer.pipe(
    Layer.provide(Layer.succeed(NativeWindowsBootstrap.Service, bootstrap)),
    Layer.provide(Layer.succeedContext(work))))
  const images = yield* Layer.build(NativeWindowsWorkFactory.imageRegistry.pipe(Layer.provide(Layer.succeedContext(work))))
  const workspace = yield* Layer.build(WindowsWorkCommandRuntime.layer.pipe(
    Layer.provide(Layer.succeedContext(work)), Layer.provide(Global.defaultLayer)))
  const ports = Context.merge(work, workspace)
  const custody = yield* Effect.gen(function* () {
    if (!Context.get(work, NativeWindowsWorkFactory.Service).commandAvailable) return Context.empty()
    const { WindowsWorkCommandCustody } = yield* Effect.promise(() => import("@/installation/windows-work-command-custody"))
    // This Layer identity is memoized by the production Root's original map.
    // Custody shares that database and the exact captured Native ports.
    return yield* Layer.build(WindowsWorkCommandCustody.layer.pipe(
      Layer.provide(Layer.succeedContext(ports)), Layer.provide(Database.defaultLayer)))
  })
  return Context.merge(Context.merge(Context.merge(native, settings), mcp), Context.merge(ports, Context.merge(images, custody)))
}))

// Both production roots must use these exact Layer objects. Effect memoizes by Layer identity,
// including the ApplicationTools instance captured by the V2 Location map and its bridges.
export const layer = V2RunnerFrame.sessionRuntimeLayer
export const applicationToolsLayer = ApplicationTools.layer
export const gatewayClientLayer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))
export const taskDispatcherLayer = TaskRunDispatcher.runtimeLayer().pipe(
  // Capture the same durable input/event runtime in both production roots. Optional outbox
  // continuation services must be available while the dispatcher layer is constructed.
  Layer.provide(layer),
  Layer.provide(EventV2Bridge.defaultLayer),
)
export const ownerSeedLayer = V2OwnerSeed.layer({
  env: process.env,
  appRoot: V2OwnerSeed.defaultOwnerAuthorizationAppRoot(),
})
export const mcpBridgeLayer = V2McpBridge.layer.pipe(
  Layer.provide(applicationToolsLayer),
  Layer.provide(InstanceRegistry.layer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provideMerge(MCP.defaultLayer),
)
export const pluginBridgeLayer = V2PluginToolsBridge.layer.pipe(
  Layer.provide(applicationToolsLayer),
  Layer.provide(InstanceRegistry.layer),
  Layer.provideMerge(ToolRegistry.productionLayer),
)

export const routesProvideStack = {
  productionSources: productionSourcesLayer({ workspaceDirectory: process.cwd() }),
  promptEpoch: PromptEpoch.v2RunnerSeamLayer.pipe(Layer.provide(Database.defaultLayer)),
  onSessionSettled: DurableLearningRuntime.onSessionSettledSeamLayer.pipe(Layer.provide(Database.defaultLayer)),
  recoveryExecutor: RecoveryExecutor.layer.pipe(Layer.provide(Database.defaultLayer)),
  worktreeReclamation: TaskWorktreeReclamation.layer.pipe(Layer.provide(Database.defaultLayer)),
  ownerReferences: V2RunnerFrame.ownerQualificationReferencesLayer,
} as const

export { authoritySurface } from "./composition-digest"

const rootMemoMap = makeMemoMap()
export const embeddedServerMemoMap = () => rootMemoMap

export async function compositionDigest() {
  const { AppRuntime } = await import("./app-runtime")
  const { CompositionDigest } = await import("./composition-digest")
  return AppRuntime.runPromise(CompositionDigest.current)
}

export * as Root from "./root"
