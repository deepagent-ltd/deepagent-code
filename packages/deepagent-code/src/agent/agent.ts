import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { serviceUse } from "@deepagent-code/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_RESEARCHER from "./prompt/researcher.txt"
import PROMPT_REVIEWER from "./prompt/reviewer.txt"
import PROMPT_GOAL_WORKER from "./prompt/goal-worker.txt"
import PROMPT_LOOP_MODE from "./prompt/loop-mode.txt"
import PROMPT_DESIGN_MODE from "./prompt/design-mode.txt"
import { PLAN_WRITE_OWN_GOAL } from "./subagent-permissions"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@deepagent-code/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { type DeepMutable } from "@deepagent-code/core/schema"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { type LLMError } from "@deepagent-code/llm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { configureGateway } from "@/deepagent/config"
import * as AgentMeta from "@deepagent-code/core/im/mention-parser"

/**
 * Canonical agent definition for the PRODUCTION runtime (the CLI/server code
 * path, `Agent.Service` in this package). This is DELIBERATELY a separate entity
 * from core's `AgentV2.Info` (`packages/core/src/agent.ts`), which is the
 * canonical definition for the core embedded runtime + core session stack. The
 * two overlap in intent but differ in shape and validation:
 *   - identity: here a plain `name: string`; there a branded `AgentV2.ID`.
 *   - permission: here `PermissionV1.Ruleset`; there `permissions:
 *     PermissionSchema.Ruleset` (different permission systems).
 *   - This type carries the V3.8.1 §C.3 registry metadata below (triggers /
 *     capabilities / autonomy / context_sources / approval_required / limits)
 *     plus options / variant / native / prompt / topP / temperature; core's
 *     `AgentV2.Info` has none of those.
 * There is intentionally NO converter between the two `Info` types, and none is
 * needed: each is projected independently onto the shared IM `AgentDescriptor`
 * (this one via `ServerAgentListProvider` in
 * `packages/deepagent-code/src/im/agent-executor-server.ts`; core's via
 * `AgentListProviderImpl`). Changing this `Info` does NOT require changing
 * core's — keep them separate on purpose.
 */
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
  // --- V3.8.1 §C.3: optional, backward-compatible agent registry metadata,
  // consumed by V4.0 (Event Router / Task Partitioner / autonomy gates). Unset
  // ⇒ V3.8 behavior exactly (not event-triggerable, no declared capabilities,
  // autonomy level_0, no extra limits). Declaration/registration only — V3.8.1
  // does NOT dispatch on triggers. `limits` provides configurable ceilings with
  // lenient/unlimited defaults (an unset field imposes no limit).
  triggers: Schema.optional(Schema.Array(AgentMeta.Trigger)),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  autonomy: Schema.optional(AgentMeta.AutonomyLevel),
  context_sources: Schema.optional(Schema.Array(Schema.String)),
  approval_required: Schema.optional(Schema.Boolean),
  limits: Schema.optional(AgentMeta.AgentLimits),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError | LLMError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          // AUTO mode (mode redesign; renamed from "build"). The default collaboration mode: the agent
          // autonomously sets the objective, produces design/plan as needed, and executes it end-to-end.
          auto: {
            name: "auto",
            description: "Autonomous mode. The agent sets the objective, designs and plans as needed, then executes to completion.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          // PLAN — hidden from the mode switcher in the redesign (auto/loop/design are the visible
          // collaboration modes). Retained as the read-only "produce a plan, don't edit" permission
          // set, reused internally by loop mode's plan-generation phase and still selectable via config
          // / API for callers that want a pure planning turn.
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".deepagent-code", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          // LOOP + DESIGN modes (mode redesign) — the two supervised-autonomous collaboration modes,
          // both powered by the Goal Loop engine. They differ only in WHO authors the goal+plan:
          //   - loop:   the agent turns the user's request into `.deepagent-code/plans/goal+plan.md`,
          //             then the loop drives it. (This replaces the old "goal" mode.)
          //   - design: the USER authored goal+plan.md; the agent reads it and executes faithfully.
          // Same working permission ruleset as auto. Registered unless the goal-loop kill-switch is off
          // (default ON) — the goal.start route also fail-closes when the flag is off.
          ...(flags.experimentalGoalLoop
            ? {
                loop: {
                  name: "loop",
                  description:
                    "Goal loop. Describe what you want; the agent writes goal+plan.md, then a supervised loop drives it to completion (plan→execute→verify per tick). You can edit the plan before it runs.",
                  permission: Permission.merge(
                    defaults,
                    Permission.fromConfig({ question: "allow", plan_enter: "allow" }),
                    user,
                  ),
                  prompt: PROMPT_LOOP_MODE,
                  options: {},
                  mode: "primary" as const,
                  native: true,
                },
                design: {
                  name: "design",
                  description:
                    "Design-driven. You author goal+plan.md yourself; the agent reads it and executes your plan faithfully under the supervised loop, without redefining the goal.",
                  permission: Permission.merge(
                    defaults,
                    Permission.fromConfig({ question: "allow", plan_enter: "allow" }),
                    user,
                  ),
                  prompt: PROMPT_DESIGN_MODE,
                  options: {},
                  mode: "primary" as const,
                  native: true,
                },
              }
            : {}),
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          // L1 (v3.8.0 §L1): native research/review subagents for multi-agent orchestration.
          // Both are subagents (so ToolRegistry.describeTask surfaces them to the primary agent's
          // `task` tool) and read-only: `"*": "deny"` allow-lists only the read/analysis tools.
          // `task: "deny"` and edit/write staying denied prevents recursive fan-out and mutation —
          // they read and report, they do not delegate or change files. (deriveSubagentSessionPermission
          // already denies `task` by default; the explicit deny here is belt-and-suspenders.)
          researcher: {
            name: "researcher",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                task: "deny",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Deep sub-module research agent. Use this when you need a decidable explanation of HOW a specific sub-module or subsystem works (not just where it is): its mechanism, key files, outward interfaces, risks, and open questions. Prefer this over "explore" when the task is to understand and report on one module in depth so you can synthesize a plan; prefer "explore" for quick file/keyword location. Returns a structured research result.`,
            prompt: PROMPT_RESEARCHER,
            options: {},
            mode: "subagent",
            native: true,
          },
          reviewer: {
            name: "reviewer",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                read: "allow",
                task: "deny",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Independent, adversarial review agent. Use this to critique a plan or a set of changes from a skeptical, outside perspective — its default stance is that the change has problems. It hunts for correctness bugs, security issues, edge cases, convention conflicts, and missing tests, and reports reproducible failure scenarios. Read-only. Returns structured findings with an overall verdict.`,
            prompt: PROMPT_REVIEWER,
            options: {},
            mode: "subagent",
            native: true,
          },
          // V3.9 §D/§E: Goal Loop worker. Unlike explore/researcher/reviewer (read-only, no side
          // effects), a Goal Loop worker CARRIES OUT the active plan step — so it gets read + edit +
          // bash (a working ruleset), while `task: deny` prevents recursive fan-out. The load-bearing
          // bit is `capabilities: [PLAN_WRITE_OWN_GOAL]`: deriveSubagentSessionPermission grants this
          // worker a session-level `plan: allow` so it can maintain its OWN goal's plan step status
          // (§E.2 controlled relaxation), bounded to its own goal by run:<sessionId> scope isolation.
          // Ordinary subagents declare no capability and stay plan-write denied. Edits still flow
          // through the normal tool-permission gate — the Loop never elevates privilege (§D.6 不越权).
          "goal-worker": {
            name: "goal-worker",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                edit: "allow",
                write: "allow",
                patch: "allow",
                bash: "allow",
                webfetch: "allow",
                plan: "allow",
                task: "deny",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Goal Loop worker (V3.9 §D). A long-running, supervised worker that executes ONE plan step per tick against an objectively-graded goal and maintains its own goal's plan (step status). Read + edit capable; delegates nothing (task denied). Used by the Goal Loop controller, not invoked directly for one-off tasks.`,
            prompt: PROMPT_GOAL_WORKER,
            capabilities: [PLAN_WRITE_OWN_GOAL],
            options: {},
            mode: "subagent",
            native: true,
            // §E F4: HIDDEN so the `task` tool's describeTask does NOT surface goal-worker as a directly
            // spawnable subagent_type. It is driven ONLY by the Goal-Loop controller (makeTaskSubagentRunner,
            // which fetches it by name). Hiding it prevents a primary agent from spawning a plan-write-capable
            // worker outside a governed goal loop; combined with allowPlanWriteCapability gating, even if it
            // WERE spawned via task it would get no plan grant.
            hidden: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
          // V3.8.1 §C.3: carry per-agent resource ceilings from config into the authoritative
          // Agent.Info. Without this, `next.limits` at the task-tool consumption point
          // (task.ts §5a → next.limits?.maxConcurrency) was permanently undefined, so a
          // configured `agent.<name>.limits.maxConcurrency` never reached the concurrency
          // semaphore. Unset ⇒ no limit (lenient default preserved).
          if (value.limits) item.limits = value.limits
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          // Back-compat alias: "build" was renamed to "auto" in the mode redesign. Older sessions,
          // saved configs, and API callers may still pass "build" — resolve it to auto when there is
          // no explicitly-defined agent literally named "build".
          if (agent === "build" && !agents["build"] && agents["auto"]) return agents["auto"]
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "auto"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"
        configureGateway(cfg)
        const run = {
          callKind: "auxiliary_ai_call" as const,
          feature: "agent_generate",
          providerID: model.providerID,
          modelID: model.modelID,
          auxiliaryCallID: `aux_${crypto.randomUUID()}`,
          agent: "agent.generate",
          origin: {
            file: "packages/deepagent-code/src/agent/agent.ts",
            function: "Agent.generate",
          },
        }

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* AgentGateway.runAuxiliary(
            run,
            Effect.promise(async () => {
              const result = streamObject({
                ...params,
                providerOptions: ProviderTransform.providerOptions(resolved, {
                  instructions: system.join("\n"),
                  store: false,
                }),
                onError: () => {},
              })
              for await (const part of result.fullStream) {
                if (part.type === "error") throw part.error
              }
              return result.object
            }),
          )
        }

        return yield* AgentGateway.runAuxiliary(
          run,
          Effect.promise(() => generateObject(params).then((r) => r.object)),
        )
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export * as Agent from "./agent"
