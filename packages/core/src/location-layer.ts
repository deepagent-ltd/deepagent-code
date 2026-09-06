import { Layer, LayerMap } from "effect"
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
import { SessionStore } from "./session/store"
import { SessionTodo } from "./session/todo"
import { QuestionV2 } from "./question"
import { LLMClient } from "@deepagent-code/llm"
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
import { productionV2SourcesLayer } from "./context-federation/production-adapters"
import { ContextQueryAuthorization } from "./context-federation/query-authorization"
import { ContextToolRuntime } from "./context-federation/tool-runtime"
import { SessionRunnerCanonical } from "./session/runner/canonical-turn"
import { V2ProviderTurn } from "./session/runner/v2-provider-turn"
import { SessionRunnerLLMToolGateSeam } from "./session/runner/llm"
import { V2ToolEffect } from "./session/runner/v2-tool-effect"
import { FetchHttpClient } from "effect/unstable/http"

const deepagentEnabledFromEnv = () => process.env.DEEPAGENT_ENABLED !== "false" && process.env.DEEPAGENT_ENABLED !== "0"

export class LocationServiceMap extends LayerMap.Service<LocationServiceMap>()(
  "@deepagent-code/example/LocationServiceMap",
  {
    lookup: (ref: Location.Ref) => {
      const location = Location.layer(ref)
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
      const services = Layer.mergeAll(base, resources, permissionsAndTools, ContextQueryAuthorization.defaultLayer)
      const image = Image.layer.pipe(Layer.provide(services))
      const mutation = FileMutation.locationLayer.pipe(Layer.provide(services))
      const searches = LocationSearch.layer.pipe(Layer.provide(Ripgrep.layer), Layer.provide(services))
      const skillGuidance = SkillGuidance.locationLayer.pipe(Layer.provide(services))
      const todos = SessionTodo.layer.pipe(Layer.provide(services))
      const questions = QuestionV2.locationLayer.pipe(Layer.provide(services))
      const builtInTools = BuiltInTools.locationLayer.pipe(
        Layer.provide(ContextToolRuntime.seam),
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
        Layer.provide(SessionRunnerLLMToolGateSeam),
        Layer.provide(services),
        Layer.provide(model),
        Layer.provide(skillGuidance),
        Layer.provide(sessionContext),
        // W3.1 production-sources seam: the V2 runner reads `ProductionV2Sources` when it admits a
        // selection. The default is EMPTY (no live sources wired) — the four production adapters then
        // degrade honestly. A deepagent-code composition replaces this layer with the live inputs
        // (LiveCodeQuery / LocationIndexCoordinator / DurableKnowledgeStore + released-snapshot
        // picker) so the default path resolves real graph data.
        Layer.provide(productionV2SourcesLayer),
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
      ).pipe(Layer.fresh)
    },
    idleTimeToLive: "60 minutes",
    dependencies: [
      Project.defaultLayer,
      EventV2.defaultLayer,
      Auth.defaultLayer,
      Npm.defaultLayer,
      ModelsDev.defaultLayer,
      FSUtil.defaultLayer,
      AppProcess.defaultLayer,
      Global.defaultLayer,
      Database.defaultLayer,
      SessionStore.layer.pipe(Layer.provide(Database.defaultLayer)),
      PermissionSaved.defaultLayer,
      RepositoryCache.defaultLayer,
      Layer.mergeAll(
        AgentGateway.layer({
          enabled: deepagentEnabledFromEnv(),
          runsDir: Global.Path.agent.runs,
        }),
        LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer)),
      ),
      FetchHttpClient.layer,
      ToolOutputStore.defaultCleanupLayer,
      ApplicationTools.layer,
    ],
  },
) {}
