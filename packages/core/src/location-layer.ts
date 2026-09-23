import { Context, Effect, Layer, LayerMap } from "effect"
import { Location } from "./location"
import { Policy } from "./policy"
import { Config } from "./config"
import { PluginV2 } from "./plugin"
import { Catalog } from "./catalog"
import { CommandV2 } from "./command"
import { AgentV2 } from "./agent"
import { PluginBoot } from "./plugin/boot"
import { Project } from "./project"
import { EventV2 } from "./event"
import { Auth } from "./auth"
import { Npm } from "./npm"
import { ModelsDev } from "./models-dev"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Database } from "./database/database"
import { PermissionV2 } from "./permission"
import { PermissionSaved } from "./permission/saved"
import { FileSystem } from "./filesystem"
import { Watcher } from "./filesystem/watcher"
import { LocationMutation } from "./location-mutation"
import { LocationSearch } from "./location-search"
import { FileMutation } from "./file-mutation"
import { ProjectReference } from "./project-reference"
import { RepositoryCache } from "./repository-cache"
import { Pty } from "./pty"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { BuiltInTools } from "./tool/builtins"
import { Image } from "./image"
import { ToolRegistry } from "./tool/registry"
import { ApplicationTools } from "./tool/application-tools"
import { ToolOutputStore } from "./tool-output-store"
import { AppProcess } from "./process"
import { Ripgrep } from "./ripgrep"
import { EffectFlock } from "./util/effect-flock"
import { SessionStore } from "./session/store"
import { SessionTodo } from "./session/todo"
import { QuestionV2 } from "./question"
import { ClientMiddlewareService, LLMClient } from "@deepagent-code/llm"
import { AgentGateway } from "./agent-gateway"
import { RequestExecutor } from "@deepagent-code/llm/route"
import * as SessionRunnerLLM from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { SystemContextBuiltIns } from "./system-context/builtins"
import { CapabilityCatalog } from "./system-context/capability-catalog"
import { ProjectDocs } from "./system-context/project-docs"
import { SystemContextRegistry } from "./system-context/registry"
import { SessionProviderOwner } from "./context-federation/provider-owner"
import { SessionContext } from "./context-federation/session-context"
import { ProductionV2Sources } from "./context-federation/production-adapters"
import { ContextQueryAuthorization } from "./context-federation/query-authorization"
import { ContextToolRuntime } from "./context-federation/tool-runtime"
import { SessionRunnerCanonical } from "./session/runner/canonical-turn"
import { V2ProviderTurn } from "./session/runner/v2-provider-turn"
import { SessionRunner } from "./session/runner"
import { V2ToolEffect } from "./session/runner/v2-tool-effect"
import { FetchHttpClient } from "effect/unstable/http"

const deepagentEnabledFromEnv = () => process.env.DEEPAGENT_ENABLED !== "false" && process.env.DEEPAGENT_ENABLED !== "0"

export interface LocationRuntimeHostInterface {
  /** Supplies the host-owned query/runtime seams for one cached Location tree. The query-authority
   * store is part of the seam because the host-captured graph facades resolve session envelopes
   * from the store THEY were built with: a tree-private store would make every runner bind
   * invisible to them (code_intel / context_query then answer `authorization_unavailable`). */
  readonly layer: (
    ref: Location.Ref,
  ) => Layer.Layer<
    | ProductionV2Sources
    | ContextToolRuntime.Service
    | ContextQueryAuthorization.Service
    | ContextQueryAuthorization.Controller,
    never,
    AgentGateway.Runtime
  >
}

/**
 * Explicit host boundary for services that Core cannot implement by itself. The value is captured
 * when the LocationServiceMap is built, then invoked for each ref before that keyed tree starts.
 * This prevents a self-contained Core default from shadowing a production host override.
 */
export class LocationRuntimeHost extends Context.Service<LocationRuntimeHost, LocationRuntimeHostInterface>()(
  "@deepagent-code/v2/LocationRuntimeHost",
) {}

export const defaultLocationRuntimeHost = Layer.effect(
  LocationRuntimeHost,
  Effect.gen(function* () {
    const buildIdentity = yield* V2ProviderTurn.CurrentBuildIdentity
    const ownerAuthorizationPublicKey = yield* V2ProviderTurn.CurrentOwnerAuthorizationPublicKey
    return LocationRuntimeHost.of({
      layer: () =>
        Layer.mergeAll(
          Layer.succeed(ProductionV2Sources, {}),
          ContextToolRuntime.unavailableLayer,
          // Bare-core fallback: one process-local authority store per keyed tree, matching the
          // pre-seam behavior where the tree self-provided `ContextQueryAuthorization.defaultLayer`.
          ContextQueryAuthorization.defaultLayer,
          Layer.succeed(SessionRunner.CurrentToolSettleGate, undefined),
          Layer.succeed(SessionRunner.CurrentOnSessionSettled, undefined),
          Layer.succeed(V2ProviderTurn.CurrentBuildIdentity, buildIdentity),
          Layer.succeed(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, ownerAuthorizationPublicKey),
        ),
    })
  }),
)

/** Default dependencies are exported so an enhanced host can replace only the host boundary. */
export const locationServiceMapDependencies = <HE, HR, DE, DR, EE, ER, GE, GR>(
  runtimeHost: Layer.Layer<LocationRuntimeHost, HE, HR>,
  database: Layer.Layer<Database.Service, DE, DR>,
  events: Layer.Layer<EventV2.Service, EE, ER>,
  gateway: Layer.Layer<AgentGateway.Runtime | ClientMiddlewareService, GE, GR>,
) => {
  const fs = FSUtil.defaultLayer
  const global = Global.defaultLayer
  const flock = EffectFlock.layer.pipe(Layer.provide(fs), Layer.provide(global))
  const ownerReferences = V2ProviderTurn.ownerReferencesLayer.pipe(Layer.provide(global))
  return [
    Project.layer.pipe(Layer.provide(database), Layer.provide(fs), Layer.provide(Git.defaultLayer)),
    events,
    Auth.layer.pipe(Layer.provide(fs), Layer.provide(global), Layer.provide(events)),
    Npm.defaultLayer,
    ModelsDev.layer.pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(fs),
      Layer.provide(events),
      Layer.provide(global),
      Layer.provide(flock),
    ),
    fs,
    AppProcess.defaultLayer,
    global,
    database,
    SessionStore.layer.pipe(Layer.provide(database)),
    PermissionSaved.layer.pipe(Layer.provide(database)),
    RepositoryCache.defaultLayer,
    Layer.mergeAll(
      gateway,
      LLMClient.managedLayer.pipe(Layer.provide(gateway), Layer.provide(RequestExecutor.defaultLayer)),
    ),
    FetchHttpClient.layer,
    ToolOutputStore.defaultCleanupLayer,
    ApplicationTools.layer,
    runtimeHost.pipe(Layer.provide(ownerReferences)),
  ] as const
}

export class LocationServiceMap extends LayerMap.Service<LocationServiceMap>()(
  "@deepagent-code/example/LocationServiceMap",
  {
    lookup: (ref: Location.Ref) => {
      const location = Location.layer(ref)
      const runtimeHost = Layer.unwrap(Effect.map(LocationRuntimeHost, (host) => host.layer(ref)))
      // Production System Context stack (design §7.3 L0): the host-local builtins +
      // ambient instructions, the stably-loaded `deepagent/capability-catalog`
      // source (so the boot catalog is part of every V2 session context), and the
      // W10 project docs source (`deepagent/project-docs`) over the worksetted
      // four-document suite.
      const systemContext = Layer.mergeAll(
        SystemContextBuiltIns.locationLayer,
        CapabilityCatalog.layer,
        ProjectDocs.layer,
      ).pipe(Layer.provideMerge(SystemContextRegistry.layer))
      const base = Layer.mergeAll(
        location,
        Policy.locationLayer,
        Config.locationLayer,
        ProjectReference.locationLayer,
        PluginV2.locationLayer,
        Catalog.locationLayer,
        CommandV2.locationLayer,
        AgentV2.locationLayer,
        PluginBoot.locationLayer,
        FileSystem.locationLayer,
        Watcher.locationLayer,
        Pty.locationLayer,
        SkillV2.locationLayer,
        systemContext,
        LocationMutation.locationLayer.pipe(Layer.orDie),
      ).pipe(Layer.provideMerge(location))
      const resources = ToolOutputStore.layer.pipe(Layer.provide(base))
      const permissionsAndTools = ToolRegistry.layer.pipe(
        Layer.provideMerge(PermissionV2.locationLayer),
        Layer.provide(resources),
        Layer.provide(base),
      )
      // The query-authority store is NOT self-provided here: the runner's session binds must land
      // in the store the host's graph facades resolve from, so it travels through the
      // LocationRuntimeHost seam (provided by `runtimeHost` below).
      const services = Layer.mergeAll(base, resources, permissionsAndTools)
      const image = Image.layer.pipe(Layer.provide(services))
      const mutation = FileMutation.locationLayer.pipe(Layer.provide(services))
      const searches = LocationSearch.layer.pipe(Layer.provide(Ripgrep.layer), Layer.provide(services))
      const skillGuidance = SkillGuidance.locationLayer.pipe(Layer.provide(services))
      const todos = SessionTodo.layer.pipe(Layer.provide(services))
      const questions = QuestionV2.locationLayer.pipe(Layer.provide(services))
      const builtInTools = BuiltInTools.locationLayer.pipe(
        Layer.provide(services),
        Layer.provide(mutation),
        Layer.provide(searches),
        Layer.provide(resources),
        Layer.provide(todos),
        Layer.provide(questions),
        Layer.provide(image),
      )
      const model = SessionRunnerModel.locationLayer.pipe(Layer.provide(services))
      const sessionContext = SessionContext.layer.pipe(
        Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
        Layer.provide(services),
      )
      const runner = SessionRunnerLLM.defaultLayer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(Git.defaultLayer),
        Layer.provide(services),
        Layer.provide(model),
        Layer.provide(skillGuidance),
        Layer.provide(sessionContext),
        Layer.provide(V2ProviderTurn.layer.pipe(Layer.provide(SessionProviderOwner.layer), Layer.provide(services))),
        Layer.provide(V2ToolEffect.layer.pipe(Layer.provide(services))),
      )
      return Layer.mergeAll(
        services,
        image,
        mutation,
        searches,
        resources,
        todos,
        questions,
        model,
        runner,
        builtInTools,
      ).pipe(Layer.provide(runtimeHost), Layer.fresh)
    },
    idleTimeToLive: "60 minutes",
    dependencies: locationServiceMapDependencies(
      defaultLocationRuntimeHost,
      Database.defaultLayer,
      EventV2.layer.pipe(Layer.provide(Database.defaultLayer)),
      AgentGateway.runtimeLayer({
        enabled: deepagentEnabledFromEnv(),
        runsDir: Global.Path.agent.runs,
        durableLearning: false,
      }),
    ),
  },
) {}
