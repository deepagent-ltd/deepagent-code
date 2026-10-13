import { Config as EffectConfig, Context, Effect, Layer, Option } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { FetchHttpClient, HttpClient, HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { FileLock } from "@deepagent-code/core/file-lock"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { InstanceStore } from "@/project/instance-store"
import { Auth } from "@/auth"
import { IMActivation } from "@/im/activation"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Command } from "@/command"
import { Env } from "@/env"
import * as Observability from "@deepagent-code/core/effect/observability"
import { Ripgrep } from "@deepagent-code/core/filesystem/ripgrep"
import { Format } from "@/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Attention } from "@deepagent-code/core/attention"
import { AttentionControl } from "@deepagent-code/server/attention-control"
import { TaskControl } from "@/attention/task-control"
import { GoalPlanRebaseAccess } from "@/session/goal-plan-rebase-access"
import { RuntimeIntegrityIdentity } from "@/effect/runtime-integrity-identity"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Root } from "@/effect/root"
import { Permission } from "@/permission"
import { Installation } from "@/installation"
import { InstanceLayer } from "@/project/instance-layer"
import { Plugin } from "@/plugin"
import { Project } from "@/project/project"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectCopy } from "@deepagent-code/core/project/copy"
import { MoveSession } from "@deepagent-code/core/control-plane/move-session"
import { ProviderAuth } from "@/provider/auth"
import { ModelsDev } from "@deepagent-code/core/models-dev"
import { Provider } from "@/provider/provider"
import { PtyTicket } from "@deepagent-code/core/pty/ticket"
import { Question } from "@/question"
import { Reference } from "@/reference/reference"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { LLM } from "@/session/llm"
import { SessionPromptV2 } from "@/session/prompt-v2"
import { SessionCommandV2 } from "@/session/command-v2"
import { DurableLearningRuntime } from "@/deepagent/learning-runtime"
import { LearningReviewerRunner } from "@/deepagent/learning-reviewer-runner"
import { DevCampaignMint, devCampaignMint } from "@/effect/dev-campaign-mint"
import { GoalManager } from "@/session/goal-manager"
import { GoalTickExecution } from "@/session/goal-tick-execution"
import { SessionRevert } from "@/session/revert"
import { SessionSteer } from "@/session/steer"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SessionProjection } from "@/session/session-projector"
import { SessionLegacyProviderResolution } from "@/session/legacy-provider-resolution"
import { SessionProviderResolution } from "@/session/provider-resolution"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { lazy } from "@/util/lazy"
import { Vcs } from "@/project/vcs"
import { Worktree } from "@/worktree"
import { Git } from "@/git"
import { PRQueue } from "@/agent/pr-queue"
import { Workspace } from "@/control-plane/workspace"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { ServerAgentListProviderLive } from "@/im/agent-executor-server"
import { IMReplyOutbox } from "@/im/im-reply-outbox"
import { IMFacade } from "@/im/facade"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { BrowserHttpApi, EventValidationHttpApi, InstanceHttpApi, RootHttpApi } from "./api"
import { GatewayHttpApi } from "./groups/gateway"
import { gatewayHandlers } from "./handlers/gateway"
import { gatewayServiceTags } from "@/effect/gateway-service-tags"
import { gatewayAdminHandlers } from "./handlers/gateway-admin"
import { GatewayAdminApi } from "./groups/gateway-admin"
import {
  authorizeProxyKey,
  proxyAuthorizationLayer,
  proxyError,
  proxyStartupGate,
} from "./middleware/proxy-authorization"
import { Api } from "@deepagent-code/server/api"
import { PublicApi } from "./public"
import {
  authorizationLayer,
  authorizationRouterMiddleware,
  ptyConnectAuthorizationLayer,
  serverAuthorizationLayer,
} from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { IMWebSocketApi } from "./groups/im-websocket"
import { PtyConnectApi } from "./groups/pty"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { browserHandlers } from "./handlers/browser"
import { eventValidationHandlers } from "./handlers/event-validation"
import { eventInvestigationHandlers } from "./handlers/event-investigation"
import { eventWorkHandlers } from "./handlers/event-work"
import { EventValidationHost } from "@/deepagent/event-validation"
import { EventInvestigationHost } from "@/deepagent/event-investigation"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { deepagentHandlers } from "./handlers/deepagent"
import { oversightHandlers } from "./handlers/oversight"
import { webhookHandlers } from "./handlers/webhook"
import { Observability as OversightObservability } from "@deepagent-code/core/deepagent/observability"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { HumanTakeover } from "@deepagent-code/core/deepagent/human-takeover"
import { RollbackAudit } from "@deepagent-code/core/deepagent/rollback-audit"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { WorkspaceConcurrency } from "@deepagent-code/core/deepagent/workspace-concurrency"
import { SecurityResolvers } from "@deepagent-code/core/deepagent/security-resolvers"
import { V4EventRuntime } from "@/session/v4-event-runtime"
import { LocationIndexRuntime } from "@/location-index/runtime"
import { experimentalHandlers } from "./handlers/experimental"
import { debugHandlers } from "./handlers/debug"
import { fileHandlers } from "./handlers/file"
import { profileHandlers } from "./handlers/profile"
import { globalHandlers } from "./handlers/global"
import { workRecoveryHandlers } from "./handlers/work-recovery"
import { imHandlers } from "./handlers/im"
import { imWebSocketHandlers } from "./handlers/im-websocket"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers, mcpMutationAuthorizationLayer } from "./handlers/mcp"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { projectCopyHandlers } from "./handlers/project-copy"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectHandlers, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { referenceHandlers } from "./handlers/reference"
import { sessionHandlers } from "./handlers/session"
import { ContextFederationDiagnostics } from "@/context-federation/diagnostics"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { createHandlers } from "@deepagent-code/server/handlers"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@deepagent-code/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { workspaceConfigHandlers } from "./handlers/workspace-config"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { makeMemoMap } from "@deepagent-code/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"
import { syncReplayBodyLimitLayer } from "./middleware/sync-replay-body-limit"
import { maintenanceHandlers, maintenanceOnlyHandlersFor } from "./handlers/maintenance"
import { MaintenanceApi } from "./groups/maintenance"
import type { BootstrapState } from "@deepagent-code/core/database/bootstrap"
import { layer as maintenanceRegistryLayer } from "./maintenance-registry"
import { capabilityHandlers } from "./handlers/capability"
import { systemContextHandlers } from "./handlers/system-context"
import { contextHandlers } from "./handlers/context"
import { V2RunnerFrame } from "@/session/v2-runner-frame"
import { V2OutboxRuntime } from "@/event/v2-outbox-runtime"
import { V2OwnerSeed } from "@deepagent-code/core/session/runner/v2-owner-seed"
import { V2OwnerDevMint } from "@deepagent-code/core/session/runner/v2-owner-dev-mint"
import { SessionRestart } from "@deepagent-code/core/session/execution/restart"

export const context = Context.empty() as Context.Context<unknown>

const v2StartupRecovery = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* DevCampaignMint
    yield* V2OwnerSeed.Service
    yield* V2OwnerDevMint.Service
    const outcome = yield* (yield* SessionRestart.Service).redriveStartup
    if (outcome.blocked.length > 0)
      yield* Effect.logWarning("V2 startup recovery left fenced Sessions", outcome.blocked)
  }),
)

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth.
// - maintenanceApiRoutes: process-admin database/recovery routes; never workspace-routed.
// - instanceApiRoutes: remaining typed instance routes.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
// These exact layer objects hold the middleware's memoized config. A listener observer must
// inspect them; constructing another defaultLayer would read a different config generation.
export const listenerAuthConfigLayers = Object.freeze({
  router: ServerAuth.Config.defaultLayer,
  http: ServerAuth.Config.defaultLayer,
  pty: ServerAuth.Config.defaultLayer,
  server: ServerAuth.Config.defaultLayer,
})
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(listenerAuthConfigLayers.router))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(listenerAuthConfigLayers.http))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(listenerAuthConfigLayers.pty))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(listenerAuthConfigLayers.server))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const imRepositoryLayer = IMRepositoryLive.pipe(Layer.provide(Database.defaultLayer))
// IM 门面（B2，design §2/§4/§7）：new-api 门面的客户端门户 + 内核引擎生命周期的唯一所有者。
// boot 时按凭据解析落状态机（disabled / claim_required / blocked / active），拿到内核坐标即建成
// 同步引擎（B1 的 boot 语义收编进 IMFacade.layer：URL 只认 env，key 优先级 auth.json(rebind 持久化)
// > DEEPAGENT_IM_FACADE_KEY；exchange 失败不阻塞启动——blocked/claim_required 由 GUI 引导恢复）。
// B1 PoC 直连 env（DEEPAGENT_IM_KERNEL_*）照跑引擎但门面功能关闭。两边都没有 ⇒ 状态 disabled——
// 单用户路径零内核足迹。门面热路径（claim/retry 后的引擎热启动）在 facade 内部用 SDK 进程单例
// 安全的串行化构建完成。Error channel is unknown: providing imRepositoryLayer pulls in
// Database.defaultLayer, whose bootstrap preflight rejects with unknown (same as every other
// consumer of imRuntimeLayer). The R channel (Agent/InstanceStore for the roster provider,
// Auth.Service for rebind persistence, HttpClient for facade calls) is satisfied by the shared
// instance graph — the same requirements the sibling ServerAgentListProviderLive declaration
// already places on it.
// V4.0 §D2/§F — Oversight services (read-only projection of the durable V4 substrate). Both need only
// the Database layer; provided independently to the oversight handler.
const oversightServicesLayer = Layer.mergeAll(
  OversightObservability.layer,
  ApprovalQueue.layer,
  // §D2/§F — the human-takeover recorder the Takeover endpoint calls + the human_takeover_total metric.
  HumanTakeover.layer,
  // §D2/§F — the rollback audit recorder the Rollback endpoint calls + the rollback_total metric. The
  // Rollback handler also uses Session + SessionRevert (the revert primitive), which are drawn from the
  // shared instance runtime graph below (Session.defaultLayer / SessionRevert.defaultLayer).
  RollbackAudit.layer,
).pipe(Layer.provide(Database.defaultLayer))
// Private /dac commands admit ordinary SessionV2 inputs on the shared runner graph.
// Ordinary communication and @mentions never admit work. The terminal
// assistant reply returns through the im_reply_outbox daemon (IMReplyOutbox.layer), which draws
// Database/SessionV2/EventV2Bridge from the shared graph and IMRepository/broadcaster/facade
// from here — mergeAll siblings are invisible to each other, so the facade edge is supplied
// directly (same pattern as ServerAgentListProviderLive in imFacadeLayer); without it
// the outbox's prefixed `[Agent·<id>]` kernel copy never leaves and only the bare pending-drain
// lane reaches the kernel.
// ServerAgentListProviderLive still requires Agent/InstanceStore from the shared instance graph,
// so it stays declared here WITHOUT those deps and resolved against that graph.
function createIMRuntimeLayer(options?: IMFacade.Options) {
  const facade = IMFacade.layer(options).pipe(
    Layer.provide(imRepositoryLayer),
    Layer.provide(IMBroadcasterLive),
    Layer.provide(ServerAgentListProviderLive),
  )
  return Layer.mergeAll(
    IMActivation.layer(options?.env),
    imRepositoryLayer,
    IMBroadcasterLive,
    ServerAgentListProviderLive,
    IMReplyOutbox.layer.pipe(
      Layer.provide(ServerAgentListProviderLive),
      Layer.provide(imRepositoryLayer),
      Layer.provide(IMBroadcasterLive),
      Layer.provide(facade),
    ),
    facade,
  )
}
const imRuntimeLayer = createIMRuntimeLayer()
// V4.0 §A4/§C — the PRODUCTION event-runtime daemons (EventDispatcher router + tick + retry pump,
// MultiAgentRuntime DispatchPort, RetentionSweeper). Without this the V4 daemons never start and
// published events are logged-then-ignored. Composed here so it shares the ONE DeepAgentEventBus +
// ApprovalQueue + Database with the IM double-write and goal-manager (module-const layers memoize to a
// single instance under the shared memoMap — publishers and the dispatcher must not split-brain). The
// session stack (Session/SessionPrompt/Agent/Provider) + RuntimeFlags are drawn from the shared graph
// below. Daemon startup is gated on the V4 flags inside V4EventRuntime.layer, so with flags off (the
// default) it is inert — nothing subscribes, ticks, or prunes.
const v4EventRuntimeLayer = V4EventRuntime.layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(PRQueue.layer.pipe(Layer.orDie)),
  Layer.provide(LocationIndexRuntime.defaultLayer),
  // §E1 — the PRODUCTION four-layer security resolvers. Providing this makes the MultiAgentRuntime gate
  // evaluate REAL facts (L1 event-source trust per workspace, L2 actor workspace membership, L4 runtime
  // pre-gate) and FAIL CLOSED, instead of the default-open lenient stubs. Its deps (WorkspaceConfig +
  // AgentListProvider + IMRepository) are satisfied by the same provide stack below, so it shares the ONE
  // instance the runtime + IM double-write use — no split-brain.
  Layer.provide(SecurityResolvers.layer),
  // §C3.1 — the process-wide file-lock singleton (Layer.succeed). Providing the SAME layer the file HTTP
  // handlers use means a human editing a file (human lock) blocks an agent subtask from touching it.
  Layer.provide(FileLock.layer),
  Layer.provide(DeepAgentEventBus.defaultLayer),
  Layer.provide(ApprovalQueue.layer.pipe(Layer.provide(Database.defaultLayer))),
  Layer.provide(Scheduler.defaultLayer),
  Layer.provide(WorkspaceConfig.defaultLayer),
  Layer.provide(WorkspaceConcurrency.defaultLayer),
  Layer.provide(ServerAgentListProviderLive),
  // §E1 layer-2 needs IM group membership; imRepositoryLayer self-provides the Database.
  Layer.provide(imRepositoryLayer),
)

const rootApiRoutes = () =>
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([
      controlHandlers,
      controlPlaneHandlers,
      globalHandlers,
      workRecoveryHandlers().pipe(Layer.provide(ServerAuth.Config.defaultLayer)),
    ]),
    Layer.provide(schemaErrorLayer),
    Layer.provide(httpApiAuthLayer),
  )
const browserApiRoutes = () =>
  HttpApiBuilder.layer(BrowserHttpApi).pipe(
    Layer.provide(browserHandlers().pipe(Layer.provide(ServerAuth.Config.defaultLayer),
      Layer.provide(LocationIdentity.defaultLayer), Layer.provide(V2RunnerFrame.browserFilesLayer))),
    Layer.provide([schemaErrorLayer, httpApiAuthLayer]),
  )
const eventValidationRuntime = Layer.effectDiscard(Effect.gen(function* () {
  const service = yield* EventValidationHost.Service
  // No installed operator means no enabled rules to restore. Startup never creates
  // an approval; an explicit authenticated command enables each rule later.
  yield* service.start.pipe(Effect.catch(() => Effect.void))
  const investigation = yield* EventInvestigationHost.Service
  yield* investigation.reconcile.pipe(Effect.catch(() => Effect.void))
})).pipe(
  Layer.provideMerge(EventValidationHost.defaultLayer),
)
const eventValidationApiRoutes = () =>
  HttpApiBuilder.layer(EventValidationHttpApi).pipe(
    Layer.provide([eventValidationHandlers(), eventInvestigationHandlers()]),
    Layer.provide(eventValidationRuntime),
    Layer.provide(currentServerAuthLayer),
    Layer.provide(currentGlobalLayer),
    Layer.provide([schemaErrorLayer, httpApiAuthLayer]),
  )
const gatewayApiRoutes = () =>
  HttpApiBuilder.layer(GatewayHttpApi).pipe(Layer.provide(gatewayHandlers), Layer.provide(proxyAuthorizationLayer))
const gatewayAdminRoutes = () =>
  HttpApiBuilder.layer(GatewayAdminApi).pipe(Layer.provide(gatewayAdminHandlers), Layer.provide(httpApiAuthLayer))
const gatewayServiceSubsetGate = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!(yield* RuntimeFlags.Service).gateway) return
    // Resolve the handler's actual service inventory from this server root before any gateway
    // request can be admitted. The scoped composition test checks the same root's live digest.
    yield* Effect.all(gatewayServiceTags, { discard: true })
  }),
)
const eventApiRoutes = () =>
  HttpApiBuilder.layer(EventApi).pipe(
    Layer.provide(eventHandlers),
    Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
  )
// Origin-aware groups are listener-local; shared services keep their memoized identity.
// Reusing a group built by the embedded app would capture its earlier CORS options.
const ptyConnectApiRoutes = () =>
  HttpApiBuilder.layer(PtyConnectApi).pipe(
    Layer.provide(ptyConnectHandlers()),
    Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
  )
const imWebSocketApiRoutes = (runtime = imRuntimeLayer) =>
  HttpApiBuilder.layer(IMWebSocketApi).pipe(
    Layer.provide(imWebSocketHandlers()),
    Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
    Layer.provide(runtime),
  )
const maintenanceApiRoutes = () =>
  HttpApiBuilder.layer(MaintenanceApi).pipe(
    Layer.provide(maintenanceHandlers),
    Layer.provide([httpApiAuthLayer, schemaErrorLayer]),
    Layer.provide(maintenanceRegistryLayer),
  )
const currentServerAuthLayer = Layer.unwrap(Effect.serviceOption(ServerAuth.Config).pipe(Effect.map((config) =>
  Option.isSome(config) ? Layer.succeed(ServerAuth.Config, config.value) : ServerAuth.Config.defaultLayer)))
const currentGlobalLayer = Layer.unwrap(Effect.serviceOption(Global.Service).pipe(Effect.map((global) =>
  Option.isSome(global) ? Layer.succeed(Global.Service, global.value) : Global.defaultLayer)))

const instanceApiRoutes = () =>
  HttpApiBuilder.layer(InstanceHttpApi).pipe(
    Layer.provide([
      configHandlers,
      debugHandlers,
      profileHandlers,
      deepagentHandlers.pipe(Layer.provide([
        V2RunnerFrame.gatewayRuntimeLayer,
        currentServerAuthLayer,
      ])),
      oversightHandlers,
      webhookHandlers,
      experimentalHandlers,
      fileHandlers,
      imHandlers.pipe(Layer.provide(ServerAuth.Config.defaultLayer)),
      eventWorkHandlers().pipe(Layer.provide(currentServerAuthLayer)),
      instanceHandlers,
      mcpHandlers.pipe(Layer.provide(currentServerAuthLayer)),
      projectHandlers,
      projectCopyHandlers,
      ptyHandlers(),
      questionHandlers,
      referenceHandlers,
      permissionHandlers,
      providerHandlers,
      sessionHandlers,
      syncHandlers,
      tuiHandlers,
      workspaceHandlers,
      workspaceConfigHandlers,
      capabilityHandlers,
      systemContextHandlers,
      contextHandlers,
    ]),
  )

const instanceRoutes = (runtime = imRuntimeLayer) =>
  instanceApiRoutes().pipe(
    Layer.provide([
      httpApiAuthLayer,
      mcpMutationAuthorizationLayer.pipe(Layer.provide(currentServerAuthLayer)),
      workspaceRoutingLive,
      instanceContextLayer,
      schemaErrorLayer,
    ]),
    Layer.provide(runtime),
    Layer.provide(oversightServicesLayer),
    // The DeepAgent Event Bus stays provided to the instance route graph for the remaining bus
    // consumers (oversight/event surfaces); the V2 IM path no longer publishes im.message.created.
    Layer.provide(DeepAgentEventBus.defaultLayer),
    // §E1 — the workspace trusted-sources config handler reads/writes WorkspaceConfig (GET+PUT
    // /workspace/:workspaceID/config/trusted-sources). Provide the default layer (Database-backed) here so
    // it shares the same Database singleton as the rest of the instance graph.
    Layer.provide(WorkspaceConfig.defaultLayer),
    Layer.provide(ContextFederationDiagnostics.defaultLayer),
  )
const serverRoutes = () =>
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(createHandlers().pipe(Layer.provide(
      Layer.effect(AttentionControl.Task, Effect.gen(function* () {
        const control = yield* TaskControl.bind
        const authentication = yield* ServerAuth.Config
        const corsPolicy = yield* CorsConfig
        const flags = yield* RuntimeFlags.Service
        return AttentionControl.Task.of({
          control,
          advertise: (request) => GoalPlanRebaseAccess.authenticateOperator(authentication, request).pipe(
            Effect.andThen((access) => GoalPlanRebaseAccess.current(access)),
            Effect.provideService(CorsConfig, corsPolicy),
            Effect.match({
              onSuccess: () => ({ task: true, goal: flags.experimentalGoalLoop }),
              onFailure: () => ({ task: false, goal: false }),
            }),
          ),
        })
      })).pipe(Layer.provide(currentServerAuthLayer)),
    ))),
    Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
    Layer.provide(
      Layer.effect(
        Attention.Access,
        Effect.gen(function* () {
          const flags = yield* RuntimeFlags.Service
          // Only trusted host configuration can enable cross-project implicit-local
          // reads. A gateway or explicitly placed workspace never gains this scope.
          const profile = yield* EffectConfig.string("DEEPAGENT_CODE_ATTENTION_PROFILE").pipe(
            EffectConfig.withDefault(""),
          )
          const workspaceID = yield* EffectConfig.string("DEEPAGENT_CODE_WORKSPACE_ID").pipe(
            EffectConfig.withDefault(""),
          )
          return Attention.localCapability({ profile, workspaceID, gateway: flags.gateway })
        }),
      ),
    ),
  )

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = () =>
  HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
    Layer.provide(authOnlyRouterLayer),
  )

const gatewayFallback = () =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const { db } = yield* Database.Service
      yield* router.add("*", "/v1/*", (request) =>
        authorizeProxyKey(db, flags.gateway, request).pipe(
          Effect.map((result) =>
            result.ok
              ? proxyError(501, "model_not_supported", "This gateway endpoint is not supported")
              : result.response,
          ),
        ),
      )
    }),
  )

const uiRoute = () =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const client = yield* HttpClient.HttpClient
      const flags = yield* RuntimeFlags.Service
      yield* router.add("*", "/*", (request) =>
        serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
      )
    }),
  ).pipe(Layer.provide(authOnlyRouterLayer))

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

export function createRoutes(
  corsOptions?: CorsOptions,
  runtimeFlagsLayer = RuntimeFlags.defaultLayer,
  composition?: { readonly imFacade?: IMFacade.Options },
) {
  // One construction-time transport choice; HTTP, WS and the outbox retain the
  // same facade generation. This is never derived from a request or Config.
  const imRuntime = composition?.imFacade ? createIMRuntimeLayer(composition.imFacade) : imRuntimeLayer
  const baseRoutes = Layer.mergeAll(
    rootApiRoutes(),
    browserApiRoutes(),
    eventValidationApiRoutes(),
    gatewayApiRoutes(),
    gatewayAdminRoutes(),
    proxyStartupGate,
    gatewayServiceSubsetGate,
    eventApiRoutes(),
    ptyConnectApiRoutes(),
    imWebSocketApiRoutes(imRuntime),
    maintenanceApiRoutes(),
    instanceRoutes(imRuntime),
    serverRoutes(),
    docRoute(),
    gatewayFallback(),
    uiRoute(),
    // §A4/§C — start the V4 event-runtime daemons with the server (inert unless V4 flags are on). Draws
    // the session stack + RuntimeFlags from the provide stack below.
    ...([v4EventRuntimeLayer, v2StartupRecovery, V2OutboxRuntime.layer] as const),
    // The ONE process-global background task runtime: the auto-started Core V2 run dispatcher
    // (durable background task runs claimed + drained through the authority executor) plus the
    // notification outbox delivery loop. Database comes from the provide stack below; SessionV2
    // from the V2RunnerFrame.sessionRuntimeLayer provided into this graph.
    Root.taskDispatcherLayer,
    // RI-24: snapshot the root context for the per-root runtime-integrity identity slot; the
    // identity derives detached on first drain use (RuntimeIntegrityIdentity.slotResolver).
    RuntimeIntegrityIdentity.captureRootContextLayer,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      syncReplayBodyLimitLayer,
      corsVaryFix,
      fenceLayer.pipe(Layer.provide(Database.defaultLayer)),
      cors(corsOptions),
      Database.defaultLayer,
      LocationIdentity.defaultLayer,
      Account.defaultLayer,
      Agent.defaultLayer,
      Auth.defaultLayer,
      BackgroundJob.defaultLayer,
      Command.defaultLayer,
      Config.defaultLayer,
      Env.defaultLayer,
      Format.defaultLayer,
      LSP.defaultLayer,
      LLM.defaultLayer,
      Root.gatewayClientLayer,
      Installation.defaultLayer,
      MCP.defaultLayer,
      Root.applicationToolsLayer,
      // RI-26 W3: the same MCP→ApplicationTools bridge as the app root, so the embedded server's
      // Location trees (built through this graph's memoized ApplicationTools) expose MCP tools.
      Root.mcpBridgeLayer,
      Root.pluginBridgeLayer,
      ModelsDev.defaultLayer,
      Permission.defaultLayer,
      Plugin.defaultLayer,
      Project.defaultLayer,
      ProjectV2.defaultLayer,
      ProjectCopy.defaultLayer,
      // Production control-plane reads the same V2 Session authority as prompt/status; the
      // standalone default closes over a noop Session execution graph and must not enter this root.
      MoveSession.layer,
      ProviderAuth.defaultLayer,
      Provider.defaultLayer,
      PtyTicket.defaultLayer,
      Question.defaultLayer,
      Reference.defaultLayer,
      Ripgrep.defaultLayer,
      runtimeFlagsLayer,
      Session.defaultLayer,
      SessionCompaction.defaultLayer,
      // v2w-l2: the routes graph assembles the LEAN V2 prompt surfaces (admission/loop/cancel +
      // command/shell receipts) instead of the deleted prompt.ts monolith's productionLayer. The
      // shared services below (Session/Compaction/RunState/Status/Revert/...) keep feeding the
      // graph's other members; the monolith-only self-provides (SessionProcessor, SystemPrompt,
      // Image, LLM, SessionSteer, SessionFederatedContext/SessionProviderOwner/Readiness merge,
      // ToolRegistry) left the composition with it — each remaining consumer self-provides its own.
      SessionPromptV2.productionLayer,
      SessionCommandV2.productionLayer,
      GoalManager.productionLayer,
      SessionRevert.defaultLayer,
      // V4.1 §N — the durable goal-steer buffer, exposed at the graph root so the v4-event-runtime's
      // GoalTickConsumer cold port can drain goal-directed steers (GoalManager self-provides its own for
      // the warm path; the daemon needs it at the shared graph root).
      SessionSteer.defaultLayer,
      SessionShare.defaultLayer,
      SessionRunState.defaultLayer,
      SessionStatus.defaultLayer,
      SessionSummary.defaultLayer,
      SessionLegacyProviderResolution.defaultLayer,
      SessionProviderResolution.defaultLayer,
      ShareNext.defaultLayer,
      Snapshot.defaultLayer,
      EventV2Bridge.defaultLayer,
      SessionProjection.defaultLayer,
      LearningReviewerRunner.defaultLayer,
      DurableLearningRuntime.layer.pipe(Layer.provide(Database.defaultLayer)),
      EventV2.defaultLayer,
      Skill.defaultLayer,
      Todo.defaultLayer,
      ToolRegistry.productionLayer,
      Vcs.defaultLayer,
      Workspace.defaultLayer,
      Worktree.appLayer,
      FSUtil.defaultLayer,
      EffectFlock.defaultLayer,
      FileLock.layer,
      FetchHttpClient.layer,
      // Multipart persistence needs a real filesystem; HttpServer.layerServices is a no-op test layer.
      NodeHttpServer.layerHttpServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provide(InstanceLayer.layer),
    Layer.provide(Observability.layer),
  )
  // §16.3 order 4: V2 turn receipts record the durable history-window boundary (PromptEpoch active
  // row) instead of the ContextEpoch revision; read-only seam, absent keeps pre-seam. The seam
  // consumes the module-level Database.defaultLayer constant — memoized per runtime object
  // identity, so it is the SAME connection the route graph builds (no split-brain).
  return baseRoutes
    .pipe(
      // The public Core handlers, legacy adapters, status surface, and every location drain share one
      // open V2 runtime. Its augmented map captures the production sources supplied immediately below.
      Layer.provide(GoalTickExecution.runtimeLayer),
      Layer.provide(Root.layer),
      // W3.7 — the ProductionV2Sources VALUE seam (same context-flow mechanism as the PromptEpoch
      // seam below): the route graph's location-layer runner subtree forwards it into the four-graph
      // adapters (real code/documents/knowledge/memory sources), and the C6 context-readiness handler
      // requires it so readiness probes the SAME adapter set the runner serves (W3.7 L5).
      Layer.provide(Root.routesProvideStack.productionSources),
      // F-14: the C6 readiness handler resolves LocationIndexRuntime for the probe-time identity —
      // the runner subtree builds its own per-location runtime, but the bare HTTP composition never
      // provided the service, so /context/readiness 500'd with "Service not found" in every embedded
      // (run/serve) process: implemented but production-unreachable, exactly the I381-1 class. The
      // default runtime degrades honestly (no attached index -> v2:local identity), which is the
      // documented probe contract.
      Layer.provide(LocationIndexRuntime.defaultLayer),
      Layer.provide(DurableLearningRuntime.reviewerRegistryLayer),
      Layer.provide(DurableLearningRuntime.lifecycleObserverLayer.pipe(Layer.provide(Database.defaultLayer))),
      Layer.provide(Root.routesProvideStack.promptEpoch),
      // W7 — settle-triggered durable learning (same INTO-the-base seam direction as above).
      Layer.provide(Root.routesProvideStack.onSessionSettled),
      // W2.2 — C1B recovery executor production wiring: the executor layer build runs the
      // startup drain (process boot = post-crash resume: applies committed pending recovery
      // commands, never fails the boot). It self-provides the module-level
      // Database.defaultLayer constant — memoized by object identity under the shared
      // memoMap, the SAME connection the route graph builds (single-instance local
      // process, one database; no clustering; no split-brain).
      Layer.provide(Root.routesProvideStack.recoveryExecutor),
      // C-P2-08 — startup reclamation of stale retained run-owned worktrees (same
      // layer-build-means-boot drain and shared Database.defaultLayer connection as the
      // recovery executor above; never fails the boot).
      Layer.provide(Root.routesProvideStack.worktreeReclamation),
      Layer.provideMerge(devCampaignMint),
      // W0.5 (blocker-2): the release pipeline ships owner-authorization.json with the install
      // product; this layer seeds ONE signed row into the local DB when the routes graph is built —
      // after the database layer initialized, before the HTTP server accepts requests. File absent
      // => no-op (local dev / mint --dev covers it); file present but unverifiable => REFUSED
      // (fail-closed, nothing written) and only logged — a seed failure never blocks startup.
      Layer.provideMerge(
        Layer.mergeAll(
          Root.ownerSeedLayer,
          // run 模式适配（2026-09-03）：dev 构建自举 owner 授权 — V2-only profile 拒绝 legacy 后，
          // dev 构建（无发布授权文件）必须能自举，否则每个 dev run 都 fail-closed 在
          // v2_owner_campaign_not_verified。生产版本不走此路径（fail-closed 合同不变）。
          // same memoized Database.defaultLayer constant the other INTO-the-base seams use, so the
          // mint shares the route graph's connection (no split-brain) and adds no requirements.
          V2OwnerDevMint.defaultLayer,
        ),
      ),
      // RI-123: request fibers must resolve the SAME owner-qualification references the runner
      // subtree captures (env override, else the persisted state-dir dev keypair, else the pinned
      // production key). The layer carries its own mint-first ordering, so a fresh-state first
      // boot qualifies instead of capturing the production key before the mint writes the keypair.
      Layer.provideMerge(Root.routesProvideStack.ownerReferences),
      // Registration belongs to this listener. Effect's built-in serve/toWebHandler otherwise
      // memoize HttpRouter.layer across the shared app root: later routes either retain the first
      // listener's options or register twice. Only the router and registration layers are new;
      // Database, LocationServiceMap, PTY tickets, Session execution and daemons keep their layers.
      Layer.provideMerge(Layer.effect(HttpRouter.HttpRouter)(HttpRouter.make)),
    )
    .pipe(Layer.provideMerge(Root.windowsStorageLayer), Layer.orDie)
}

/**
 * Pre-business incident shell. It opens the store physically read-only and serves only the
 * authenticated maintenance contract; no Session/provider/tool/event runtime is constructed.
 */
export function createMaintenanceRoutes(
  filename: string,
  state: BootstrapState,
  corsOptions?: CorsOptions,
  onRestored?: () => void,
) {
  return HttpApiBuilder.layer(MaintenanceApi).pipe(
    Layer.provide(maintenanceOnlyHandlersFor(filename, state, onRestored)),
    Layer.provide([httpApiAuthLayer, schemaErrorLayer]),
    Layer.provide([errorLayer, compressionLayer, corsVaryFix, cors(corsOptions)]),
    Layer.provideMerge(Layer.effect(HttpRouter.HttpRouter)(HttpRouter.make)),
    Layer.orDie,
  )
}

export const routes = createRoutes()

// Factory, not a singleton: `Server.Default` guards reuse and may dispose then
// re-create the handler, so every call must build a fresh handler/scope. The caller
// passes the memo map of the root the handler belongs to — production passes the
// AppRuntime root map so instances booted over HTTP share that root's InstanceStore /
// LocationServiceMap / disposal authority instead of forming a second root.
// Default is a private per-handler root, which keeps test-built handlers isolated.
export const webHandler = (memoMap: Layer.MemoMap = makeMemoMap()) =>
  HttpRouter.toWebHandler(createRoutes(), {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  })

export * as HttpApiApp from "./server"
