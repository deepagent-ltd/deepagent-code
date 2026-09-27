import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Cause, Context, Effect, Exit, Latch, Layer, Schema } from "effect"
import { Command } from "../command"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { NamedError } from "@deepagent-code/core/util/error"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import { Plugin } from "../plugin"
import { Shell } from "@/shell/shell"
import { ShellID } from "@/tool/shell/id"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionID, MessageID, PartID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { SessionRevert } from "./revert"
import { SessionRunState } from "./run-state"
import { CommandEffectReceipt } from "./command-effect-receipt"
import { Process } from "@/util/process"
import * as DateTime from "effect/DateTime"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { LegacyExecutionUnavailable } from "./legacy-execution-zero"
import { SessionPromptIntent } from "./prompt-intent"
import { SessionPromptV2 } from "./prompt-v2"
import * as EffectLogger from "@deepagent-code/core/effect/logger"

// v2w-l2 prompt monolith teardown: the live command/shell surfaces moved here verbatim from
// session/prompt.ts (the deleted V1 monolith). command() expands the command template — the F-slice
// P0-4 CommandEffectReceipt guards wrap BOTH the embedded `!`-shell blocks and the
// command.execute.before plugin hook (intent row first, execute, settle; duplicates reuse the
// settled outcome, quarantines fail closed, force re-runs) — and then delegates execution to the
// V2 prompt admission (SessionPromptV2.prompt routes to the V2 owner; subtask part kinds keep
// failing typed via requireV2PromptText). shell() is the W0-2 projection-layer surface: child
// spawn + V1 wire mirror through sessions.updateMessage/updatePart, no legacy durable rows, no
// provider call. The `init` HTTP route is this same command() surface with Command.Default.INIT.

const elog = EffectLogger.create({ service: "session.prompt" })

const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export interface Interface {
  readonly shell: (
    input: ShellInput,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (
    input: CommandInput,
  ) => Effect.Effect<
    SessionV1.WithParts,
    | SessionPromptIntent.Error
    | Session.BusyError
    | LegacyExecutionUnavailable
    | CommandEffectReceipt.Error
  >
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionCommandV2") {}

export * as SessionCommandV2 from "./command-v2"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const revert = yield* SessionRevert.Service
    const state = yield* SessionRunState.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const promptV2 = yield* SessionPromptV2.Service

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* promptV2.currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Shell.Started, {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: DateTime.makeUnsafe(started),
                callID: part.callID,
                command: input.command,
              })
            }
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Shell.Ended, {
                  sessionID: input.sessionID,
                  timestamp: DateTime.makeUnsafe(completed),
                  callID: part.callID,
                  output,
                })
              }
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output, description: "" },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output, description: "" }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const shell: (
      input: ShellInput,
    ) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      // W0-2 — the shell route is a PROJECTION-LAYER surface, not legacy execution: it spawns a
      // child process and mirrors the turn as V1 wire rows via sessions.updateMessage/updatePart
      // (EventV2 publishes, the same projection class the F-17 mirror uses). It writes no
      // session_intent / session_steer / session_tool_request_receipt rows and never calls the
      // provider, so the LEGACY-EXECUTION-ZERO firewall does not apply (D2 classification:
      // projection adapter). This restores the `!` shell mode under the V2-only profile.
      const ready = yield* Latch.make()
      return yield* state.startShell(
        input.sessionID,
        promptV2.lastAssistant(input.sessionID),
        shellImpl(input, ready),
        ready,
      )
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      // 1.4.8.r0: template expansion happens here (may run embedded !-shell blocks / plugin hooks —
      // no legacy durable writes); execution delegates to prompt(), which routes to the V2 owner under
      // the profile (subtask part kinds keep failing typed via requireV2PromptText).
      yield* elog.info("command", { sessionID: input.sessionID, command: input.command, agent: input.agent })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        // P0-4: `!`-shell blocks are write-class OS side effects that run BEFORE the durable
        // prompt admission (the admission needs the interpolated prompt text). Each block now
        // commits its own command_side_effect_receipt intent row FIRST and settles the outcome
        // after; a crash between the two leaves a queryable UNKNOWN the next delivery quarantines
        // instead of blindly re-executing. Duplicate deliveries reuse the settled output.
        const results = yield* Effect.forEach(
          shellMatches,
          ([, cmd]) =>
            CommandEffectReceipt.run({
              db: database.db,
              operationKey: CommandEffectReceipt.operationKey({
                sessionID: input.sessionID,
                command: input.command,
                arguments: input.arguments,
                kind: "shell",
                payload: cmd,
              }),
              sessionID: input.sessionID,
              kind: "shell",
              payload: cmd,
              force: input.force === true,
              execute: () =>
                Effect.promise(async () => {
                  const text = await Process.text([cmd], { shell: sh, nothrow: true })
                  return { output: text.text, exitCode: text.code }
                }),
            }),
          // Finite backpressure: blocks beyond the cap queue (forEach preserves result order); a
          // command template's `!`-block count is small, so 8 never serializes realistic input.
          { concurrency: 8 },
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++]?.output ?? "")
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* promptV2.currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* promptV2.resolvePromptParts(template)
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...templateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* promptV2.currentModel(input.sessionID)
        : taskModel

      // P0-4: the command.execute.before plugin trigger is a write-class side effect that
      // shapes the admitted parts BEFORE the durable prompt admission, so it runs under the
      // same receipt guard as the `!`-shell blocks: intent row first, trigger, settle. A
      // duplicate delivery reuses the settled outcome without re-triggering; an unsettled
      // prior attempt quarantines fail-closed.
      yield* CommandEffectReceipt.run({
        db: database.db,
        operationKey: CommandEffectReceipt.operationKey({
          sessionID: input.sessionID,
          command: input.command,
          arguments: input.arguments,
          kind: "plugin_hook",
          payload: "command.execute.before",
        }),
        sessionID: input.sessionID,
        kind: "plugin_hook",
        payload: "command.execute.before",
        force: input.force === true,
        execute: () =>
          plugin
            .trigger(
              "command.execute.before",
              { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
              { parts },
            )
            .pipe(Effect.as({ output: null })),
      })

      const result = yield* promptV2.prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({ shell, command })
  }),
)

export const productionLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionPromptV2.productionLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
  ),
)

/** Standalone default. Production roots must provide one shared SessionV2 runtime to productionLayer. */
export const testLayer = productionLayer.pipe(Layer.provide(SessionV2.liveLayer))

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // P0-4: explicit re-run for receipted side effects. A duplicate delivery of the same
  // command reuses the settled shell/plugin outcome; force starts the next receipt
  // attempt (and re-runs quarantined UNKNOWN effects) instead of failing closed.
  force: Schema.optional(Schema.Boolean),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>
