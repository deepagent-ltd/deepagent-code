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
import { FileLock } from "@deepagent-code/core/file-lock"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Command } from "@/command"
import * as Observability from "@deepagent-code/core/effect/observability"
import { Ripgrep } from "@deepagent-code/core/filesystem/ripgrep"
import { Format } from "@/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
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
import { SessionPrompt } from "@/session/prompt"
import { GoalManager } from "@/session/goal-manager"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"
import { Database } from "@deepagent-code/core/database/database"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { lazy } from "@/util/lazy"
import { Vcs } from "@/project/vcs"
import { Worktree } from "@/worktree"
import { Workspace } from "@/control-plane/workspace"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { AgentContextBuilderLive } from "@deepagent-code/core/im/context-builder"
import { ServerAgentExecutorLive, ServerAgentListProviderLive } from "@/im/agent-executor-server"
import { ServerAgentReplySinkLive } from "@/im/agent-reply-sink-server"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
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
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { WorkspaceConcurrency } from "@deepagent-code/core/deepagent/workspace-concurrency"
import { SecurityResolvers } from "@deepagent-code/core/deepagent/security-resolvers"
import { V4EventRuntime } from "@/session/v4-event-runtime"
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
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { handlers } from "@deepagent-code/server/handlers"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@deepagent-code/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@deepagent-code/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"

export const context = Context.makeUnsafe<unknown>(new Map())

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
const oversightServicesLayer = Layer.mergeAll(OversightObservability.layer, ApprovalQueue.layer).pipe(
  Layer.provide(Database.defaultLayer),
)
// IM agent execution is driven by the deepagent-code session stack (Session +
// SessionPrompt), NOT core SessionV2 (which binds a no-op execution layer and
// never runs an agent). ServerAgentExecutorLive / ServerAgentListProviderLive
// require Session/SessionPrompt/Agent, which are provided by the instance
// runtime graph at the bottom of createRoutes — so these are declared here
// WITHOUT their session deps and resolved against that shared graph.
const imRuntimeLayer = Layer.mergeAll(
  imRepositoryLayer,
  IMBroadcasterLive,
  ServerAgentExecutorLive,
  ServerAgentListProviderLive,
  // Server Edition: reports agent outcomes back to the gateway hub. No-op when
  // GATEWAY_CALLBACK_URL is unset (standalone/desktop), so behavior is unchanged.
  ServerAgentReplySinkLive,
  AgentContextBuilderLive.pipe(Layer.provide(imRepositoryLayer)),
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
  // §E1 — the PRODUCTION four-layer security resolvers. Providing this makes the MultiAgentRuntime gate
  // evaluate REAL facts (L1 event-source trust per workspace, L2 actor workspace membership, L4 runtime
  // pre-gate) and FAIL CLOSED, instead of the default-open lenient stubs. Its deps (WorkspaceConfig +
  // AgentListProvider + IMRepository) are satisfied by the same provide stack below, so it shares the ONE
  // instance the runtime + IM double-write use — no split-brain.
  Layer.provide(SecurityResolvers.layer),
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
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    debugHandlers,
    profileHandlers,
    deepagentHandlers,
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
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
  Layer.provide(imRuntimeLayer),
  Layer.provide(oversightServicesLayer),
  // §B1 — the IM handler double-writes im.message.created onto the bus (flag-gated). Provide the bus
  // service to the instance route graph.
  Layer.provide(DeepAgentEventBus.defaultLayer),
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

export function createRoutes(
  corsOptions?: CorsOptions,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  return Layer.mergeAll(
    rootApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    imWebSocketApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    uiRoute,
    // §A4/§C — start the V4 event-runtime daemons with the server (inert unless V4 flags are on). Draws
    // the session stack + RuntimeFlags from the provide stack below.
    v4EventRuntimeLayer,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer.pipe(Layer.provide(Database.defaultLayer)),
      cors(corsOptions),
      Database.defaultLayer,
      Account.defaultLayer,
      Agent.defaultLayer,
      Auth.defaultLayer,
      BackgroundJob.defaultLayer,
      Command.defaultLayer,
      Config.defaultLayer,
      Format.defaultLayer,
      LSP.defaultLayer,
      LLM.defaultLayer,
      Installation.defaultLayer,
      MCP.defaultLayer,
      ModelsDev.defaultLayer,
      Permission.defaultLayer,
      Plugin.defaultLayer,
      Project.defaultLayer,
      ProjectV2.defaultLayer,
      ProjectCopy.defaultLayer,
      MoveSession.defaultLayer,
      ProviderAuth.defaultLayer,
      Provider.defaultLayer,
      PtyTicket.defaultLayer,
      Question.defaultLayer,
      Reference.defaultLayer,
      Ripgrep.defaultLayer,
      RuntimeFlags.defaultLayer,
      Session.defaultLayer,
      SessionCompaction.defaultLayer,
      SessionPrompt.defaultLayer,
      GoalManager.defaultLayer,
      SessionRevert.defaultLayer,
      SessionShare.defaultLayer,
      SessionRunState.defaultLayer,
      SessionStatus.defaultLayer,
      SessionSummary.defaultLayer,
      ShareNext.defaultLayer,
      Snapshot.defaultLayer,
      EventV2Bridge.defaultLayer,
      EventV2.defaultLayer,
      Skill.defaultLayer,
      Todo.defaultLayer,
      ToolRegistry.defaultLayer,
      Vcs.defaultLayer,
      Workspace.defaultLayer,
      Worktree.appLayer,
      FSUtil.defaultLayer,
      FileLock.layer,
      FetchHttpClient.layer,
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provide(InstanceLayer.layer),
    Layer.provide(Observability.layer),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
