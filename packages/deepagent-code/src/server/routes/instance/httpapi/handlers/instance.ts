import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@deepagent-code/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiVcsApplyError } from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"
import { Config } from "@/config/config"
import { snapshotGateway } from "@/deepagent/config"

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service
    const config = yield* Config.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      const runtime = snapshotGateway(yield* config.get())
      return {
        home: Global.Path.home,
        data: Global.Path.data,
        cache: Global.Path.cache,
        state: Global.Path.state,
        tmp: Global.Path.tmp,
        log: Global.Path.log,
        repos: Global.Path.repos,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
        agent: {
          ...runtime,
          directories: Global.Path.agent,
          coverage: [
            {
              surface: "V2 core runner",
              status: "covered" as const,
              note: "LLMClient.Service is wrapped by the DeepAgent runtime and writes run bindings before model execution.",
            },
            {
              surface: "legacy/native session LLM",
              status: "covered" as const,
              note: "Legacy AI SDK streams and native LLMClient streams are both wrapped by the DeepAgent runtime.",
            },
            {
              surface: "direct AI helpers",
              status: "covered" as const,
              note: "Agent generation helpers are registered as auxiliary DeepAgent runs.",
            },
            {
              surface: "provider-executed tools",
              status: "blocked" as const,
              note: "Hosted/server-side tool events fail closed unless DEEPAGENT_ALLOW_PROVIDER_EXECUTED_TOOLS=true.",
            },
            {
              surface: "generic agent tools, files, terminal, MCP, sessions",
              status: "covered" as const,
              note: "Tool execution remains owned by the generic agent runtime; DeepAgent records policy/audit around every managed model turn.",
            },
          ],
        },
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
