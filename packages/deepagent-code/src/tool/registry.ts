import { PlanExitTool } from "./plan"
import { PlanTool } from "./plan-write"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TaskStatusTool } from "./task_status"
import { TaskReadTool } from "./task_read"
import { TaskCloseTool } from "./task_close"
import { TaskRecoveryTool } from "./task_recovery"
import { PRFinalizeTool } from "./pr_finalize"
import {
  ActivityStartTool,
  ActivityStatusTool,
  ActivityResultTool,
  ActivityControlTool,
  ACTIVITY_FACADE_TOOL_IDS,
} from "./activity_facade"
import { FacadeActivity } from "@/session/facade-activity"
import { DismissValidationTool } from "./dismiss_validation"
import { Database } from "@deepagent-code/core/database/database"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@deepagent-code/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema } from "effect"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"

import { WebSearchTool } from "./websearch"
import * as Log from "@deepagent-code/core/util/log"
import { LspTool } from "./lsp"
import { CodeIntelTool } from "./code_intel"
import { CodeIntelV2Tool } from "./code_intel_v2"
import { CodeIntelFacade } from "@/code-intelligence/facade"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { ContextQueryTool } from "./context_query"
import { ContextQueryFacade } from "@/context-federation/context-query-facade"
import { ContextFederationReadiness } from "@/context-federation/readiness"
import { ProfileTool } from "./profile"
import { DebugTool } from "./debug"
import { QueryLogTool } from "./query_log"
import { DebugService } from "@/debug/service"
import { RuntimeBase } from "@/runtime/base"
import { Worktree } from "@/worktree"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { ApplyPatchChunkTool } from "./apply_patch_chunk"
import { GitReadTool } from "./git_read"
import { Glob } from "@deepagent-code/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Search } from "@deepagent-code/core/filesystem/search"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "../question"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { Reference } from "@/reference/reference"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { Git } from "@/git"
import { PRQueue } from "@/agent/pr-queue"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"

const log = Log.create({ service: "tool.registry" })

export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) {
  return providerID === ProviderV2.ID.make("deepagent-code") || flags.exa || flags.parallel
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
  codeIntelV1: Tool.Def
  codeIntelV2: Tool.Def
  contextQuery: Tool.Def
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    projectScopeKey?: string
    contextFederationRollout?: ContextFederationRollout.Decision
  }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ToolRegistry") {}

const layerWithFacades: Layer.Layer<
  Service,
  never,
  | Config.Service
  | Plugin.Service
  | Question.Service
  | Agent.Service
  | Skill.Service
  | Session.Service
  | BackgroundJob.Service
  | Provider.Service
  | Reference.Service
  | LSP.Service
  | Instruction.Service
  | FSUtil.Service
  | EventV2Bridge.Service
  | HttpClient.HttpClient
  | ChildProcessSpawner
  | Search.Service
  | Format.Service
  | Truncate.Service
  | RuntimeFlags.Service
  | Database.Service
  | DebugService.Service
  | RuntimeBase.Service
  | CodeIntelFacade.Service
  | ContextQueryFacade.Service
  | EffectFlock.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const parityCampaign = yield* V2ProviderTurn.CurrentCampaign
    const database = (yield* Database.Service).db
    const coreV2ParityVerified = parityCampaign
      ? yield* V2ProviderTurn.campaignVerified(database, parityCampaign.id)
      : yield* V2ProviderTurn.ownerQualified(database, V2ProviderTurn.ownerCampaignFromEnv())
    const federationReadiness = Option.getOrUndefined(yield* Effect.serviceOption(ContextFederationReadiness.Service))
    yield* EffectFlock.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const taskstatus = yield* TaskStatusTool
    const taskread = yield* TaskReadTool
    const taskclose = yield* TaskCloseTool
    const taskrecovery = yield* TaskRecoveryTool
    const prfinalize = yield* PRFinalizeTool
    const dismissvalidation = yield* DismissValidationTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const planwrite = yield* PlanTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const patchchunk = yield* ApplyPatchChunkTool
    const gitreadtool = yield* GitReadTool
    const skilltool = yield* SkillTool
    const rollout = ContextFederationRollout.resolve(
      {
        contextFederationShadow: flags.contextFederationShadow,
        locationIndexesV2Shadow: flags.locationIndexesV2Shadow,
        contextProjectionV2: flags.contextProjectionV2,
        contextQueryToolsV2: flags.contextQueryToolsV2,
        coreV2ExecutionOwner: flags.coreV2ExecutionOwner,
      },
      { coreV2ParityVerified },
    )
    const codeIntelV1 = yield* Tool.init(yield* CodeIntelTool)
    const codeIntelV2 = yield* Tool.init(yield* CodeIntelV2Tool)
    const contextQuery = yield* Tool.init(yield* ContextQueryTool)
    const profiletool = yield* ProfileTool
    const debugtool = yield* DebugTool
    const querylog = yield* QueryLogTool
    const agent = yield* Agent.Service

    // FEAT-011 T3/T4 — the unified activity facade (activity_start/status/result/control). Staged
    // OFF by flag; the flag is the single visibility gate (flag off ⇒ zero tools even if an outer
    // graph provides the dispatcher). When ON the dispatcher is resolved from the environment if
    // an outer graph already provides it, otherwise built inline (hard requirements are only
    // Database + RuntimeFlags — both already in this layer's requirement list — and every runner
    // dependency resolves via serviceOption, so no caller of ToolRegistry.layer gains a new
    // requirement).
    const facadeActivityProvided = yield* Effect.serviceOption(FacadeActivity.Service)
    const facadeActivity = !flags.activityFacade
      ? undefined
      : Option.isSome(facadeActivityProvided)
        ? facadeActivityProvided.value
        : yield* FacadeActivity.build
    const activityFacadeTools = facadeActivity
      ? yield* Effect.all({
          activity_start: Tool.init(
            yield* ActivityStartTool.pipe(Effect.provideService(FacadeActivity.Service, facadeActivity)),
          ),
          activity_status: Tool.init(
            yield* ActivityStatusTool.pipe(Effect.provideService(FacadeActivity.Service, facadeActivity)),
          ),
          activity_result: Tool.init(
            yield* ActivityResultTool.pipe(Effect.provideService(FacadeActivity.Service, facadeActivity)),
          ),
          activity_control: Tool.init(
            yield* ActivityControlTool.pipe(Effect.provideService(FacadeActivity.Service, facadeActivity)),
          ),
        })
      : undefined

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          // Plugin tools still expose Zod args publicly; keep that compatibility
          // boxed at the registry boundary and give the LLM the original JSON Schema.
          // Normalize missing args to `{}` once — pre-1.14.49 the code was
          // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
          const args = def.args ?? {}
          const entries = Object.entries(args)
          const allZod = entries.every((entry) => isZodType(entry[1]))
          const zodParams = allZod ? z.object(args) : undefined
          const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
          const parameters = zodParams
            ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
            : Schema.Unknown
          return {
            id,
            parameters,
            jsonSchema,
            description: def.description,
            provenance: { source: "custom" as const },
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                // SessionTools records the outer admission before plugin hooks. Direct registry
                // callers do not have that marker and must still fail closed here.
                if (!toolCtx.hostPermissionAdmissions?.has(id)) {
                  yield* toolCtx.ask({
                    permission: id,
                    patterns: ["*"],
                    metadata: { args },
                    always: ["*"],
                  })
                }
                // Bridge the host's Effect-based `ask` into a Promise-returning
                // function for the plugin to make sure context persists
                const bridge = yield* EffectBridge.make()
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => bridge.promise(toolCtx.ask(req)),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const attachments = typeof result === "string" ? undefined : result.attachments
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: typeof result === "string" ? "" : (result.title ?? ""),
                  output: out.truncated ? out.content : output,
                  attachments,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          // A broken tool file (bad import, syntax error, unresolved dependency) must never take
          // down the whole prompt: catch the failure, log it, and skip just that file. Under the
          // desktop sidecar (Electron/Node) a `.js`-specifier import that only resolves under Bun
          // would otherwise surface as a Die defect inside prompt_async -> silent no-reply.
          const mod = yield* Effect.promise(() =>
            import(pathToFileURL(match).href).catch((error: unknown) => {
              log.error("failed to load custom tool; skipping", { path: match, error })
              return undefined
            }),
          )
          if (!mod) continue
          for (const [id, def] of Object.entries(mod)) {
            if (!isPluginTool(def)) continue
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
          }
        }

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          task_status: Tool.init(taskstatus),
          task_read: Tool.init(taskread),
          task_close: Tool.init(taskclose),
          task_recovery: Tool.init(taskrecovery),
          pr_finalize: Tool.init(prfinalize),
          dismiss_validation: Tool.init(dismissvalidation),
          fetch: Tool.init(webfetch),
          search: Tool.init(websearch),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          patch_chunk: Tool.init(patchchunk),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          // BUG-009 §6.4: v2 code_intel switches on contextQueryToolsV2, but only when the
          // CodeIntelV2 facade is actually available.  If v2 initialization fails (empty/cold
          // code graph, CodeQueryService unavailable), fall back to v1 silently so the tool
          // remains useful.  v1 removal requires explicit parity evidence — not done here.
          code_intel: Effect.succeed(rollout.enabled.contextQueryToolsV2 ? codeIntelV2 : codeIntelV1),
          profile: Tool.init(profiletool),
          debug: Tool.init(debugtool),
          plan: Tool.init(plan),
          planwrite: Tool.init(planwrite),
          query_log: Tool.init(querylog),
          git_read: Tool.init(gitreadtool),
        })

        return {
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.task_status,
            tool.task_read,
            tool.task_close,
            tool.task_recovery,
            tool.pr_finalize,
            tool.dismiss_validation,
            tool.fetch,
            tool.search,
            tool.skill,
            tool.patch,
            tool.patch_chunk,
            tool.git_read,
            tool.planwrite,
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.codeIntelTool ? [tool.code_intel] : []),
            ...(rollout.enabled.contextQueryToolsV2 ? [contextQuery] : []),
            ...(flags.profileTool ? [tool.profile] : []),
            ...(flags.debugTool ? [tool.debug] : []),
            ...(flags.experimentalQueryLogTool ? [tool.query_log] : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
            ...(activityFacadeTools
              ? [
                  activityFacadeTools.activity_start,
                  activityFacadeTools.activity_status,
                  activityFacadeTools.activity_result,
                  activityFacadeTools.activity_control,
                ]
              : []),
          ],
          task: tool.task,
          read: tool.read,
          codeIntelV1,
          codeIntelV2,
          contextQuery,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const registryState = yield* InstanceState.get(state)
      const projectRollout =
        input.contextFederationRollout ??
        ContextFederationRollout.activate(
          ContextFederationRollout.resolveProject(rollout, input.projectScopeKey ?? "project_scope_unbound", {
            stage: flags.contextFederationRolloutStage,
            percentage: flags.contextFederationRolloutPercent,
            internalProjectScopeKeys: flags.contextFederationInternalProjects,
            killSwitch: flags.contextFederationKillSwitch,
          }),
          yield* federationReadiness?.snapshot() ?? Effect.succeed(ContextFederationReadiness.unavailableSnapshot()),
        )
      const filtered = [...registryState.builtin, ...registryState.custom].flatMap((tool) => {
        if (tool.id === PRFinalizeTool.id && input.agent.mode !== "primary") return []
        // FEAT-011 T4: the activity facade tools are a PRIMARY-agent control surface — subagents
        // never spawn/control activities through the facade (mirrors the pr_finalize gate).
        if (ACTIVITY_FACADE_TOOL_IDS.has(tool.id) && input.agent.mode !== "primary") return []
        if (tool.id === CodeIntelTool.id) {
          return [projectRollout.enabled.contextQueryToolsV2 ? registryState.codeIntelV2 : registryState.codeIntelV1]
        }
        if (tool.id === ContextQueryTool.id && !projectRollout.enabled.contextQueryToolsV2) return []
        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled(input.providerID, { exa: flags.enableExa, parallel: flags.enableParallel })
            ? [tool]
            : []
        }
        return [tool]
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          using _ = log.time(tool.id)
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: tool.jsonSchema,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
              ? output.jsonSchema
              : undefined
          return {
            id: tool.id,
            description: [output.description, tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema,
            // M2 (S1-v3.4): the projection previously dropped provenance, forcing
            // request.ts to guess the source from the tool name. Pass it through —
            // this is the single source of truth. Builtin tools carry no explicit
            // provenance, so default to `builtin`; custom plugin tools already set
            // `custom` in fromPlugin. MCP tools are merged downstream, not here.
            provenance: tool.provenance ?? { source: "builtin" as const },
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools })
  }),
)

export const layer = layerWithFacades

/**
 * InstanceStore backed by a NO-OP InstanceBootstrap — used only to satisfy the
 * Worktree dependency for debug/profile `withIsolation`. The real InstanceBootstrap
 * (FFF warm + eager config.get + service init) is provided by the app-runtime at the
 * top level; wiring it here would eagerly freeze config.directories() at instance
 * creation and race tools that read files written after the instance starts.
 */
const noopBootstrapInstanceStore = InstanceStore.defaultLayer.pipe(
  Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        CodeIntelFacade.defaultLayer,
        ContextQueryFacade.defaultLayer,
        ContextFederationReadiness.defaultLayer,
      ),
    ),
    // Ordered dependency chain (must stay explicit so instances are SHARED):
    // DebugService.layer needs RuntimeBase.Service + EventV2Bridge.Service; RuntimeBase.layer
    // needs Worktree.Service. Providing them outermost-last means the EventV2Bridge in the
    // merged block below is the SAME instance DebugService publishes debug.* events onto, and
    // RuntimeBase is shared between the profile tool's gate and DebugService's gate.
    Layer.provide(DebugService.layer),
    Layer.provide(RuntimeBase.layer),
    // Worktree here is used only by debug/profile withIsolation (create/safeRemove). It must
    // NOT pull in InstanceLayer's real InstanceBootstrap: that boostrap eagerly runs config.get()
    // (+ FFF warm) at instance creation, which would freeze config.directories() before a tool
    // (e.g. skill scanning) sees files written after instance start. A no-op bootstrap satisfies
    // the InstanceStore tag without that eager side effect. In production the app-runtime provides
    // the real InstanceLayer at the top level for actual instance init; this sealed one only backs
    // worktree create/remove.
    Layer.provide(Worktree.appLayer.pipe(Layer.provide(noopBootstrapInstanceStore))),
    // All remaining requirements are self-contained default layers with no ordering needs;
    // merge them into one provide (Layer.suspend's pipe caps at 20 chained args).
    Layer.provide(
      Layer.mergeAll(
        Config.defaultLayer,
        Plugin.defaultLayer,
        Question.defaultLayer,
        Skill.defaultLayer,
        Agent.defaultLayer,
        Session.defaultLayer,
        BackgroundJob.defaultLayer,
        Provider.defaultLayer,
        Reference.defaultLayer,
        LSP.defaultLayer,
        Instruction.defaultLayer,
        FSUtil.defaultLayer,
        EventV2Bridge.defaultLayer,
        FetchHttpClient.layer,
        Format.defaultLayer,
        CrossSpawnSpawner.defaultLayer,
        Search.defaultLayer,
        Truncate.configuredLayer,
        Database.defaultLayer,
        RuntimeFlags.defaultLayer,
        Git.defaultLayer,
        EffectFlock.defaultLayer,
        PRQueue.layer.pipe(Layer.orDie),
      ),
    ),
  ),
)

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as ToolRegistry from "./registry"
