import { Layer } from "effect"
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

// Both production roots must use these exact Layer objects. Effect memoizes by Layer identity,
// including the ApplicationTools instance captured by the V2 Location map and its bridges.
export const layer = V2RunnerFrame.sessionRuntimeLayer
export const applicationToolsLayer = ApplicationTools.layer
export const taskDispatcherLayer = TaskRunDispatcher.runtimeLayer()
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
