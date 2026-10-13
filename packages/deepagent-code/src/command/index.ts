import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { SessionID, MessageID } from "@/session/schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { EventV2 } from "@deepagent-code/core/event"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: EventV2.define({
    type: "command.executed",
    schema: {
      name: Schema.String,
      sessionID: SessionID,
      arguments: Schema.String,
      messageID: MessageID,
    },
  }),
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export const ReadInfo = Schema.Struct({
  ...Info.fields,
  template: Schema.optional(Schema.Unknown),
  availability: Schema.optional(Schema.Literals(["available", "connect_required", "unavailable"])),
}).annotate({ identifier: "CommandRead" })
export type ReadInfo = typeof ReadInfo.Type

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

type AwaitedMetadata = Effect.Success<ReturnType<NonNullable<MCP.Interface["observedMetadata"]>>>["prompts"]

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly readonlyList: (
    snapshot: Config.ReadSnapshot,
    prompts: AwaitedMetadata,
    observed?: InstanceContext,
  ) => Effect.Effect<ReadInfo[]>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    const readonlyList = Effect.fn("Command.readonlyList")(function* (
      snapshot: Config.ReadSnapshot,
      prompts: AwaitedMetadata,
      observed?: InstanceContext,
    ) {
      const result: Record<string, ReadInfo> = {
        [Default.INIT]: {
          name: Default.INIT,
          description: "guided AGENTS.md setup",
          source: "command",
          template: PROMPT_INITIALIZE.replace("${path}", snapshot.worktree),
          hints: hints(PROMPT_INITIALIZE),
          availability: "available",
        },
        [Default.REVIEW]: {
          name: Default.REVIEW,
          description: "review changes [commit|branch|pr], defaults to uncommitted",
          source: "command",
          template: PROMPT_REVIEW.replace("${path}", snapshot.worktree),
          hints: hints(PROMPT_REVIEW),
          subtask: true,
          availability: "available",
        },
      }
      for (const [name, value] of Object.entries(snapshot.config.command ?? {}))
        result[name] = {
          name,
          agent: value.agent,
          model: value.model,
          description: value.description,
          source: "command",
          template: value.template,
          subtask: value.subtask,
          hints: hints(value.template),
          availability: "available",
        }
      // Prompt display never evaluates the execution Info.template getter/Promise.
      for (const [name, value] of Object.entries(prompts))
        result[name] = {
          name,
          source: "mcp",
          description: value.description,
          hints: value.arguments?.map((_, index) => `$${index + 1}`) ?? [],
          availability: "available",
        }
      if (!skill.readonlyAt) return yield* Effect.die(new Error("Readonly skill observation unavailable"))
      for (const value of yield* skill.readonlyAt(snapshot, observed))
        if (!result[value.name])
          result[value.name] = {
            name: value.name,
            source: "skill",
            description: value.description,
            template: value.content,
            hints: [],
            availability: "available",
          }
      return Object.values(result)
    })

    return Service.of({ get, list, readonlyList })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Command from "."
