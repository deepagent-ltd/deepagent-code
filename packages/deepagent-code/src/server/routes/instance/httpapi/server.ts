import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import {
  FetchHttpClient,
  HttpClient,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { FileLock } from "@deepagent-code/core/file-lock"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Command } from "@/command"
import { Env } from "@/env"
import * as Observability from "@deepagent-code/core/effect/observability"
import { Ripgrep } from "@deepagent-code/core/filesystem/ripgrep"
import { Format } from "@/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
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
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { GatewayHttpApi } from "./groups/gateway"
import { gatewayHandlers } from "./handlers/gateway"
import { gatewayServiceTags } from "./handlers/gateway-chat"
import { gatewayAdminHandlers } from "./handlers/gateway-admin"
import { GatewayAdminApi } from "./groups/gateway-admin"
import { authorizeProxyKey, proxyAuthorizationLayer, proxyError, proxyStartupGate } from "./middleware/proxy-authorization"
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
import { imHandlers } from "./handlers/im"
import { imWebSocketHandlers } from "./handlers/im-websocket"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers } from "./handlers/mcp"
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
import { handlers } from "@deepagent-code/server/handlers"
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
import { LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
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
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const imRepositoryLayer = IMRepositoryLive.pipe(Layer.provide(Database.defaultLayer))
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
// V2 IM durable-only: @mentions are admitted by the IM handler directly as durable SessionV2
// work (src/im/im-agent-execution.ts) on the SHARED V2 runtime graph (V2RunnerFrame.sessionRuntimeLayer —
// the real SessionExecutionLocal owner, not the noop-execution standalone default). The terminal
// assistant reply returns through the im_reply_outbox daemon (IMReplyOutbox.layer), which draws
// Database/SessionV2/EventV2Bridge from the shared graph and IMRepository/broadcaster from here.
// ServerAgentListProviderLive still requires Agent/InstanceStore from the shared instance graph,
// so it stays declared here WITHOUT those deps and resolved against that graph.
const imRuntimeLayer = Layer.mergeAll(
  imRepositoryLayer,
  IMBroadcasterLive,
  ServerAgentListProviderLive,
  IMReplyOutbox.layer.pipe(Layer.provide(imRepositoryLayer), Layer.provide(IMBroadcasterLive)),
)
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

const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const gatewayApiRoutes = HttpApiBuilder.layer(GatewayHttpApi).pipe(
  Layer.provide(gatewayHandlers),
  Layer.provide(proxyAuthorizationLayer),
)
const gatewayAdminRoutes = HttpApiBuilder.layer(GatewayAdminApi).pipe(
  Layer.provide(gatewayAdminHandlers),
  Layer.provide(httpApiAuthLayer),
)
const gatewayClientLayer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))
const gatewayServiceSubsetGate = Layer.effectDiscard(Effect.gen(function* () {
  if (!(yield* RuntimeFlags.Service).gateway) return
  // Resolve the handler's actual service inventory from this server root before any gateway
  // request can be admitted. The scoped composition test checks the same root's live digest.
  yield* Effect.all(gatewayServiceTags, { discard: true })
}))
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const ptyConnectApiRoutes = HttpApiBuilder.layer(PtyConnectApi).pipe(
  Layer.provide(ptyConnectHandlers),
  Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const imWebSocketApiRoutes = HttpApiBuilder.layer(IMWebSocketApi).pipe(
  Layer.provide(imWebSocketHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
  Layer.provide(imRuntimeLayer),
)
const maintenanceApiRoutes = HttpApiBuilder.layer(MaintenanceApi).pipe(
  Layer.provide(maintenanceHandlers),
  Layer.provide([httpApiAuthLayer, schemaErrorLayer]),
  Layer.provide(maintenanceRegistryLayer),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    debugHandlers,
    profileHandlers,
    deepagentHandlers.pipe(Layer.provide(V2RunnerFrame.gatewayRuntimeLayer)),
    oversightHandlers,
    webhookHandlers,
    experimentalHandlers,
    fileHandlers,
    imHandlers,
    instanceHandlers,
    mcpHandlers,
    projectHandlers,
    projectCopyHandlers,
    ptyHandlers,
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

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
  Layer.provide(imRuntimeLayer),
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
const serverRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlers),
  Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

const gatewayFallback = HttpRouter.use((router) =>
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

const uiRoute = HttpRouter.use((router) =>
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

export function createRoutes(corsOptions?: CorsOptions, runtimeFlagsLayer = RuntimeFlags.defaultLayer) {
  const baseRoutes = Layer.mergeAll(
    rootApiRoutes,
    gatewayApiRoutes,
    gatewayAdminRoutes,
    proxyStartupGate,
    gatewayServiceSubsetGate,
    eventApiRoutes,
    ptyConnectApiRoutes,
    imWebSocketApiRoutes,
    maintenanceApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    gatewayFallback,
    uiRoute,
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
      gatewayClientLayer,
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
      HttpServer.layerServices,
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
    )
    .pipe(Layer.orDie)
}

/**
 * Pre-business incident shell. It opens the store physically read-only and serves only the
 * authenticated maintenance contract; no Session/provider/tool/event runtime is constructed.
 */
export function createMaintenanceRoutes(filename: string, state: BootstrapState, corsOptions?: CorsOptions, onRestored?: () => void) {
  return HttpApiBuilder.layer(MaintenanceApi).pipe(
    Layer.provide(maintenanceOnlyHandlersFor(filename, state, onRestored)),
    Layer.provide([httpApiAuthLayer, schemaErrorLayer]),
    Layer.provide([errorLayer, compressionLayer, corsVaryFix, cors(corsOptions)]),
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
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  })

export * as HttpApiApp from "./server"
