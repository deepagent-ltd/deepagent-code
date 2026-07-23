import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import path from "path"
import { randomUUID } from "node:crypto"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "@deepagent-code/core/util/log"
import { Global } from "@deepagent-code/core/global"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Auth } from "@/auth"
import { configureGateway } from "@/deepagent/config"

import { type Tool as AITool, tool, jsonSchema, streamText, type ModelMessage } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import {
  overflowStatus,
  tokensUsed,
  softLandingDecision,
  outputContinuationMax,
  initialSoftLandingState,
  CompactionSoftLandingState,
} from "./overflow"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { Snapshot } from "@/snapshot"
import { NamedError } from "@deepagent-code/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import * as MultiRound from "./deepagent-multiround"
import { runValidationCommands } from "../deepagent/validation-exec"
import { gitGroundTruth } from "../deepagent/git-groundtruth"
import { DeepAgentWorkspace } from "../deepagent/workspace-context"
import { Shell } from "@/shell/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Data, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import * as EffectLogger from "@deepagent-code/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { SessionSteer } from "./steer"
import { writeGovernanceAudit } from "./goal-governance-audit"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { archiveSessionOnCompletion } from "@/wiki/session-archive"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@deepagent-code/core/database/database"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import {
  AgentAttachment,
  FileAttachment,
  Prompt,
  ReferenceAttachment,
  Source,
} from "@deepagent-code/core/session/prompt"
import { Reference } from "@/reference/reference"
import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { referencePromptMetadata, referenceTextPart } from "./prompt/reference"
import { SessionReminders } from "./reminders"
import { SessionTools } from "./tools"
import { LLMEvent } from "@deepagent-code/llm"
import { ConversationLogWriter } from "./conversation-log-writer"
import { collectVolatileFacts, refreshWorldState } from "./context-ledger"
import { CodeIndexTrigger } from "./code-index-trigger"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
// Coerce a structurally-valid Format value into a Format INSTANCE (see the call site in prompt()).
const decodeFormatSync = Schema.decodeUnknownSync(SessionV1.Format)

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

// P1: Build a schema-aware system prompt that injects the required field names so the model
// knows the exact schema even during extended-thinking (xhigh) reasoning, without relying
// solely on the tool definition which may not be visible during the thinking phase.
function buildStructuredOutputSystemPrompt(schema: Record<string, any>): string {
  const fields = extractSchemaTopLevelFields(schema)
  const fieldHint =
    fields.length > 0
      ? `\nThe StructuredOutput tool requires these top-level fields: ${fields.join(", ")}. Use ONLY these exact field names.`
      : ""
  return `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.${fieldHint}`
}

function extractSchemaTopLevelFields(schema: Record<string, any>): string[] {
  if (!schema || typeof schema !== "object") return []
  const props = schema.properties
  if (!props || typeof props !== "object") return []
  return Object.keys(props)
}

const log = Log.create({ service: "session.prompt" })
const elog = EffectLogger.create({ service: "session.prompt" })

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

// §S1.2 — a goal in one of these phases is no longer ticking, so a "goal_steer" would never be drained.
// promptOrSteer routes to the plain "steer" channel (or a fresh turn) instead. Mirrors goal-manager's
// isTerminalGoalPhase (kept as a local const to avoid a circular import: goal-manager imports this file).
const TERMINAL_GOAL_PHASES: ReadonlySet<string> = new Set(["done", "needs_human", "rolled_back", "stopped"])

class InvalidInput extends Data.TaggedError("SessionPrompt.InvalidInput")<{ readonly message: string }> {}

// §S1.2 — convert PromptInput parts to the durable Prompt model used by the steer buffer.
// All part types that have a Prompt equivalent are preserved; subtask parts are explicitly rejected
// so they never produce a silent empty steer. The steer caller should surface this as a client error.
const promptInputToPrompt = (
  parts: PromptInput["parts"],
): Effect.Effect<Prompt, InvalidInput> => {
  if (parts.some((p) => p.type === "subtask"))
    return Effect.fail(
      new InvalidInput({ message: "Subtask prompt parts cannot be steered while a session is busy" }),
    )
  const text = parts
    .filter((p): p is Extract<PromptInput["parts"][number], { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim()
  const files = parts
    .filter((p): p is Extract<PromptInput["parts"][number], { type: "file" }> => p.type === "file")
    .map(
      (p) =>
        new FileAttachment({
          uri: p.url,
          mime: p.mime,
          ...(p.filename !== undefined ? { name: p.filename } : {}),
        }),
    )
  const agents = parts
    .filter((p): p is Extract<PromptInput["parts"][number], { type: "agent" }> => p.type === "agent")
    .map((p) => new AgentAttachment({ name: p.name }))
  if (text.length === 0 && files.length === 0 && agents.length === 0)
    return Effect.fail(
      new InvalidInput({ message: "Steer prompt must contain at least one supported part" }),
    )
  return Effect.succeed(
    Prompt.fromUserMessage({
      text,
      ...(files.length === 0 ? {} : { files }),
      ...(agents.length === 0 ? {} : { agents }),
    }),
  )
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  // V4.1 §S1.1: buffer a mid-turn user message into the durable steer queue for absorption at the next
  // model-request boundary of the live turn loop. This is the admit() API; S1.2 wires the busy-session
  // ingress that decides WHEN to route a message here vs. the normal prompt() path. Idempotent on `id`.
  readonly steer: (input: {
    sessionID: SessionID
    prompt: Prompt
    delivery?: SessionSteer.Delivery
    messageID?: SessionMessage.ID
  }) => Effect.Effect<SessionSteer.Admitted>
  // V4.1 §S1.2: the busy-session ingress decision. If the session is IDLE (no live turn) → run a normal
  // turn (prompt). If it is BUSY (mid-turn) and steering is enabled → buffer the message as a steer so
  // the running turn absorbs it at its next boundary (delivery="goal_steer" when a non-terminal goal is
  // active — drained by the goal driver between ticks; else "steer" — drained by the session's own
  // runLoop). Returns a discriminated ack so the caller knows whether a turn ran or the message was
  // accepted as steering. With steering disabled it falls back to prompt() (which enforces the runner's
  // own busy semantics), preserving pre-steering behavior exactly.
  readonly promptOrSteer: (input: PromptInput) => Effect.Effect<PromptOrSteerResult, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  readonly refineIntelligenceDraft: (input: {
    sessionID: SessionID
    rawInput: string
    outputLanguage?: AgentGateway.DeepAgentPromptPipeline.IntelligenceRefinementOutputLanguage
    onProgress?: (preview: string) => void
  }) => Effect.Effect<
    {
      prompt_draft_id: string
      context_plan_id: string
      state: string
      mode: "intelligence"
      route: "code" | "general"
      goal: string
      preview: string
    },
    AgentGateway.DeepAgentPromptPipeline.PromptRefinerModelError
  >
  // A3 macro-round: read the latest persisted next-round suggestion ({status, body}) so the UI can
  // surface it for human approval (high/max). Returns null when no suggestion has been produced.
  readonly latestSuggestion: (input: { sessionID: SessionID }) => Effect.Effect<{ status: string; body: string } | null>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const steerBuffer = yield* SessionSteer.Service
    const revert = yield* SessionRevert.Service
    const snapshot = yield* Snapshot.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const references = yield* Reference.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const { db } = database
    // V3.8 Phase 3: sessions that already had their one lightweight code-index pass this process, so a
    // re-prompt does not re-walk the tree (content-sha gating makes re-indexing idempotent regardless,
    // but this avoids the redundant fs walk entirely).
    const indexedSessions = new Set<SessionID>()
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* elog.info("cancel", { sessionID })
      yield* state.cancel(sessionID)
    })

    const resolveReferenceParts = Effect.fnUntraced(function* (template: string) {
      const parts: Types.DeepMutable<PromptInput["parts"]> = []
      const seen = new Set<string>()
      yield* Effect.forEach(
        ConfigMarkdown.files(template),
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          const alias = name.split("/")[0]
          if (!alias || seen.has(alias)) return
          const reference = yield* references.get(alias)
          if (!reference) return
          seen.add(alias)

          const start = match.index ?? 0
          const source = { value: match[0], start, end: start + match[0].length }
          if (reference.kind === "invalid") {
            parts.push(referenceTextPart({ reference, source }))
            return
          }

          yield* references.ensure(reference.path)
          parts.push({
            type: "file",
            url: pathToFileURL(reference.path).href,
            filename: alias,
            mime: "application/x-directory",
            source: { type: "file", text: source, path: alias },
          })
        }),
        { concurrency: 1, discard: true },
      )
      return parts
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [
        { type: "text", text: template },
        ...(yield* resolveReferenceParts(template)),
      ]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const slash = name.indexOf("/")
          const alias = slash === -1 ? name : name.slice(0, slash)
          if (yield* references.get(alias)) return

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => elog.error("failed to generate title", { error: Cause.squash(cause) })))
    })

    // Snapshot the first user message text into the session `preview` column so an archived-session
    // list can show a content snippet without loading the conversation. Piggy-backs on the same
    // first-turn hook as title generation. setPreview is write-once (server-side guard), so re-runs
    // and later prompts are no-ops. Cheap + local: no LLM call, just the persisted user parts.
    const PREVIEW_MAX = 200
    const preview = Effect.fn("SessionPrompt.ensurePreview")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
    }) {
      if (input.session.parentID) return
      if (input.session.preview) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const firstUser = input.history.find(real)
      if (!firstUser) return

      const text = firstUser.parts
        .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text)
        .join(" ")
      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const source = text.trim() ? text : subtasks.map((p) => p.prompt).join(" ")

      const snippet = source.replace(/\s+/g, " ").trim()
      if (!snippet) return
      const truncated = snippet.length > PREVIEW_MAX ? snippet.substring(0, PREVIEW_MAX - 1) + "…" : snippet

      yield* sessions
        .setPreview({ sessionID: input.session.id, preview: truncated })
        .pipe(Effect.catchCause((cause) => elog.error("failed to set session preview", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies SessionV1.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
            return Effect.void
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

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
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
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

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const intelligenceRefinementModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const opts = (yield* config.get()).provider?.deepagent?.options
      // Legacy-compat: `wishModel` is the pre-rename option key. Prefer the new `intelligenceModel`
      // key but still read `wishModel` so an existing user's configured model keeps resolving.
      // Do NOT drop the `wishModel` read.
      const value = opts?.intelligenceModel ?? opts?.wishModel
      if (typeof value === "string") {
        const separator = value.indexOf("/")
        if (separator > 0 && separator < value.length - 1) {
          const candidate = {
            providerID: ProviderV2.ID.make(value.slice(0, separator)),
            modelID: ModelV2.ID.make(value.slice(separator + 1)),
          }
          // Graceful fallback: a syntactically valid but non-existent intelligenceModel (unknown provider
          // or model) must fall back to the session model rather than fail the intelligence refinement.
          // Probe getModel; only use the configured model if it actually resolves.
          const resolved = yield* provider.getModel(candidate.providerID, candidate.modelID).pipe(Effect.option)
          if (Option.isSome(resolved)) return candidate
        }
      }
      return yield* currentModel(sessionID)
    })

    const deepagentModelAuthProviderID = (model: Provider.Model) => {
      if (model.providerID !== "deepagent") return
      const value = model.options?.authProviderID
      return typeof value === "string" && value.length > 0 ? value : undefined
    }

    // Intelligence refinement asks the model for a JSON object describing the refined prompt, but we do
    // NOT force a structured/tool-call output: LLMs are non-deterministic, and a hard schema gate
    // makes weaker models (e.g. small/flash variants) fail the whole turn instead of producing a
    // usable result. We generate plain text and extract the JSON leniently — the goal is a clear,
    // readable refinement, not strict format compliance. If parsing fails, the caller fails soft.
    const extractIntelligenceJson = (text: string): unknown => {
      const trimmed = text.trim()
      // Prefer a fenced ```json block when present, else the first balanced-looking {...} span.
      const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
      const candidates: string[] = []
      if (fence?.[1]) candidates.push(fence[1].trim())
      const first = trimmed.indexOf("{")
      const last = trimmed.lastIndexOf("}")
      if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1))
      candidates.push(trimmed)
      for (const c of candidates) {
        try {
          return JSON.parse(c)
        } catch {
          /* try next candidate */
        }
      }
      return undefined
    }

    const partialIntelligencePrompt = (text: string) => {
      const match = /"refined_prompt"\s*:\s*"/.exec(text)
      if (!match) return
      const escapes: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      }
      let preview = ""
      for (let index = match.index + match[0].length; index < text.length; index++) {
        const character = text[index]!
        if (character === '"') return preview
        if (character !== "\\") {
          preview += character
          continue
        }
        const escaped = text[index + 1]
        if (!escaped) return preview
        if (escaped !== "u") {
          preview += escapes[escaped] ?? escaped
          index++
          continue
        }
        const code = text.slice(index + 2, index + 6)
        if (!/^[0-9a-f]{4}$/i.test(code)) return preview
        preview += String.fromCharCode(Number.parseInt(code, 16))
        index += 5
      }
      return preview
    }

    const generateIntelligenceRefinement = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      rawInput: string
      outputLanguage?: AgentGateway.DeepAgentPromptPipeline.IntelligenceRefinementOutputLanguage
      onProgress?: (preview: string) => void
    }) {
      const cfg = yield* config.get()
      const model = yield* intelligenceRefinementModel(input.sessionID)
      const resolved = yield* provider.getModel(model.providerID, model.modelID)
      const language = yield* provider.getLanguage(resolved)
      const modelAuthID = deepagentModelAuthProviderID(resolved)
      const providerAuth = yield* auth.get(model.providerID).pipe(Effect.orDie)
      const modelAuth = modelAuthID ? yield* auth.get(modelAuthID).pipe(Effect.orDie) : undefined
      const authInfo = model.providerID === "deepagent" ? (modelAuth ?? providerAuth) : providerAuth
      const isOpenaiOauth = (model.providerID === "openai" || modelAuthID === "openai") && authInfo?.type === "oauth"
      const system = AgentGateway.DeepAgentPromptPipeline.intelligenceRefinementSystemPrompt(
        input.outputLanguage ?? "english",
      )

      // Feed the refiner the recent conversation so it reuses already-stated facts (target
      // directory, paths, prior decisions) instead of guessing them and emitting misleading
      // assumptions. Best-effort: history failures must not block refinement (first turn => none).
      const recent = yield* sessions
        .messages({ sessionID: input.sessionID, limit: 8 })
        .pipe(Effect.orElseSucceed(() => [] as SessionV1.WithParts[]))
      const turns: AgentGateway.DeepAgentPromptPipeline.IntelligenceContextTurn[] = recent
        .filter((m) => m.info.role === "user" || m.info.role === "assistant")
        .map((m) => ({
          role: m.info.role as "user" | "assistant",
          text: m.parts
            .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text" && !p.synthetic && !p.ignored)
            .map((p) => p.text)
            .join("\n")
            .trim(),
        }))
        .filter((t) => t.text.length > 0)
      const briefing = AgentGateway.DeepAgentPromptPipeline.buildIntelligenceContextBriefing(turns)
      const contextMessages: ModelMessage[] = briefing
        ? [{ role: "user", content: AgentGateway.DeepAgentPromptPipeline.intelligenceContextMessage(briefing) }]
        : []

      const params = {
        temperature: 0.2,
        messages: [
          ...(isOpenaiOauth ? [] : ([{ role: "system", content: system }] satisfies ModelMessage[])),
          ...contextMessages,
          { role: "user", content: input.rawInput },
        ],
        model: language,
      } satisfies Parameters<typeof streamText>[0]
      const run = {
        callKind: "auxiliary_ai_call" as const,
        feature: "intelligence_prompt_prepare",
        providerID: model.providerID,
        modelID: model.modelID,
        sessionID: input.sessionID,
        auxiliaryCallID: `intelligence_${randomUUID()}`,
        agent: "intelligence.prepare",
        origin: {
          file: "packages/deepagent-code/src/session/prompt.ts",
          function: "SessionPrompt.refineIntelligenceDraft",
        },
      }

      if (!isOpenaiOauth) configureGateway(cfg)
      return yield* AgentGateway.runAuxiliary(
        run,
        Effect.tryPromise(async (signal) => {
          const result = streamText({
            ...params,
            ...(isOpenaiOauth
              ? {
                  providerOptions: ProviderTransform.providerOptions(resolved, { instructions: system, store: false }),
                  onError: () => {},
                }
              : {}),
            abortSignal: signal,
          })
          let text = ""
          let preview = ""
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
            if (part.type !== "text-delta") continue
            text += part.text
            const next = partialIntelligencePrompt(text)
            if (!next || next === preview) continue
            preview = next
            input.onProgress?.(preview)
          }
          return extractIntelligenceJson(text)
        }),
      )
    })

    // A2: model-driven intelligence first-turn refinement. Calls the user-specified model to turn a raw
    // request into a complete, directly-executable prompt with explicit assumptions, persists a
    // draft, and returns its id/preview. The draft is NOT submitted here — the client shows the
    // preview in the input box for review and only later confirms via confirmedDraftID. General
    // chat can bypass DeepAgent when refinement is unavailable; code tasks fail closed instead of
    // pretending intelligence produced a useful prompt.
    const refineIntelligenceDraft = Effect.fn("SessionPrompt.refineIntelligenceDraft")(function* (input: {
      sessionID: SessionID
      rawInput: string
      outputLanguage?: AgentGateway.DeepAgentPromptPipeline.IntelligenceRefinementOutputLanguage
      onProgress?: (preview: string) => void
    }) {
      const ctx = yield* InstanceState.context
      const home = new AgentGateway.DeepAgentWorkspace.DeepAgentCodeHome(Global.Path.agent.data)
      const sessionPath = home.ensureSession(projectIDForDirectory(ctx.directory), input.sessionID)
      const store = new AgentGateway.DeepAgentPromptPipeline.PromptDraftStore(sessionPath)
      const fallbackRoute = AgentGateway.DeepAgentPromptPipeline.classifyIntelligenceRoute(input.rawInput)

      const built = yield* Effect.gen(function* () {
        const output = AgentGateway.DeepAgentPromptPipeline.normalizeIntelligenceRefinementOutput(
          yield* generateIntelligenceRefinement(input),
          input.rawInput,
        )
        if (!output) {
          return yield* Effect.fail(
            new AgentGateway.DeepAgentPromptPipeline.PromptRefinerModelError("invalid intelligence refinement output"),
          )
        }
        if (fallbackRoute === "code" && output.route === "general") {
          return yield* Effect.fail(
            new AgentGateway.DeepAgentPromptPipeline.PromptRefinerModelError(
              "code intelligence refinement was routed as general",
            ),
          )
        }
        if (output.route === "general") {
          return {
            route: "general" as const,
            prompt_draft_id: "",
            context_plan_id: "",
            state: "general_ready",
            mode: "intelligence" as const,
            goal: output.goal.trim() || input.rawInput,
            preview: input.rawInput,
          }
        }
        if (!AgentGateway.DeepAgentPromptPipeline.isUsefulIntelligenceRefinement(input.rawInput, output)) {
          return yield* Effect.fail(
            new AgentGateway.DeepAgentPromptPipeline.PromptRefinerModelError(
              "intelligence refinement did not improve the prompt",
            ),
          )
        }
        return {
          route: "code" as const,
          ...AgentGateway.DeepAgentPromptPipeline.draftFromIntelligenceRefinement(store, input.rawInput, output),
        }
      }).pipe(
        // Fail-soft only for obvious general chat. Code tasks need a real, useful refinement.
        Effect.catch(() =>
          fallbackRoute === "general"
            ? Effect.succeed({
                route: "general" as const,
                prompt_draft_id: "",
                context_plan_id: "",
                state: "general_ready",
                mode: "intelligence" as const,
                goal: input.rawInput,
                preview: input.rawInput,
              })
            : Effect.fail(
                new AgentGateway.DeepAgentPromptPipeline.PromptRefinerModelError(
                  "intelligence refinement failed for code task",
                ),
              ),
        ),
      )

      if (built.route === "general") return built
      return {
        prompt_draft_id: built.draft.id,
        context_plan_id: built.draft.context_plan_id,
        state: built.draft.state,
        mode: "intelligence" as const,
        route: "code" as const,
        goal: built.draft.goal,
        preview: AgentGateway.DeepAgentPromptPipeline.renderDraftMarkdown(built.draft),
      }
    })

    const latestSuggestion = Effect.fn("SessionPrompt.latestSuggestion")(function* (input: { sessionID: SessionID }) {
      const ctx = yield* InstanceState.context
      return yield* Effect.sync(() => {
        const home = new AgentGateway.DeepAgentWorkspace.DeepAgentCodeHome(Global.Path.agent.data)
        const sessionPath = home.ensureSession(projectIDForDirectory(ctx.directory), input.sessionID)
        const store = new AgentGateway.DeepAgentPromptPipeline.PromptDraftStore(sessionPath)
        return store.loadLatestSuggestion()
      })
    })

    const buildPromptPipelineSubmission = Effect.fn("SessionPrompt.buildPromptPipelineSubmission")(function* (
      input: PromptInput,
    ) {
      const ctx = yield* InstanceState.context
      return yield* Effect.sync(() => {
        const home = new AgentGateway.DeepAgentWorkspace.DeepAgentCodeHome(Global.Path.agent.data)
        const session = home.ensureSession(projectIDForDirectory(ctx.directory), input.sessionID)
        const store = new AgentGateway.DeepAgentPromptPipeline.PromptDraftStore(session)
        const request = promptPipelineRequest(input.metadata)
        const mode = request.mode
        const rawInput = rawInputFromPromptParts(input.parts)

        if (request.confirmedDraftID) {
          store.confirm(request.confirmedDraftID, request.editedGoal)
          const submitted = store.submitConfirmed(request.confirmedDraftID)
          return {
            action: "submit" as const,
            parts: replacePromptText(input.parts, submitted.task_prompt),
            metadata: { mode: mode ?? "confirmed", confirmed: true, ...submitted },
          }
        }

        // Draft creation + review live in the real production entrypoint
        // (POST /session/{sessionID}/prompt_prepare). The client prepares a draft there, shows it
        // for review, and resubmits with confirmedDraftID (handled above). There is no
        // server-side requires_confirmation round-trip on the prompt submission path.
        const submitted = store.directOverride(rawInput)
        return {
          action: "submit" as const,
          parts: input.parts,
          metadata: {
            mode: mode ?? "direct_override",
            explicit: request.mode === "direct_override",
            ...submitted,
          },
        }
      })
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const current = yield* db
        .select({ agent: SessionTable.agent, model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        // `format` must be a decoded Format INSTANCE, not a plain object literal. `Format`'s
        // json_schema member is a `Schema.Class`, whose encoder is `instanceof`-gated — a plain
        // `{ type: "json_schema", schema }` (e.g. from the task tool) passes TS structural typing
        // but fails at encode time when this message Info is serialized onto the MessageUpdated
        // sync event ("Expected OutputFormatJsonSchema, got {...}"). Normalizing here — the single
        // choke point every caller flows through — makes any structurally-valid format safe, and
        // is idempotent for callers that already pass an instance. `withDecodingDefault` also fills
        // retryCount. `format` is validated on the way in (PromptInput), so this decode never fails.
        format: input.format === undefined ? undefined : decodeFormatSync(input.format),
        metadata: input.metadata,
      }

      if (current?.agent !== info.agent) {
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(info.time.created),
          agent: info.agent,
        })
      }
      if (
        current?.model?.providerID !== info.model.providerID ||
        current.model.id !== info.model.modelID ||
        (current.model.variant === "default" ? undefined : current.model.variant) !== info.model.variant
      ) {
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(info.time.created),
          model: {
            id: ModelV2.ID.make(info.model.modelID),
            providerID: ProviderV2.ID.make(info.model.providerID),
            variant: ModelV2.VariantID.make(info.model.variant ?? "default"),
          },
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if ("text" in c && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && c.blob) {
                  const mime = "mimeType" in c ? c.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mime}]`,
                  })
                }
              }
              pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
            } else {
              const error = Cause.squash(exit.cause)
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              log.info("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read directory", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const submittedParts: Types.DeepMutable<PromptInput["parts"]> = [...input.parts]
      const attachedReferences = new Set(
        input.parts.flatMap((part) =>
          part.type === "file" && part.mime === "application/x-directory" ? [part.url] : [],
        ),
      )
      for (const part of input.parts) {
        if (part.type !== "text" || part.synthetic) continue
        for (const reference of yield* resolveReferenceParts(part.text)) {
          if (reference.type === "file" && attachedReferences.has(reference.url)) continue
          if (reference.type === "file") attachedReferences.add(reference.url)
          submittedParts.push(reference)
        }
      }

      const resolvedParts = yield* Effect.forEach(submittedParts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        log.error("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      parts.forEach((part, index) => {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) return
        log.error("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      })

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)
      const nextPrompt = parts.reduce(
        (result, part) => {
          if (part.type === "text") {
            if (part.synthetic) result.synthetic.push(part.text)
            else result.text.push(part.text)
            const reference = referencePromptMetadata(part.metadata?.reference)
            if (reference) {
              result.references.push(
                new ReferenceAttachment({
                  name: reference.name,
                  kind: reference.kind,
                  uri: reference.path ? pathToFileURL(reference.path).href : undefined,
                  repository: reference.repository,
                  branch: reference.branch,
                  target: reference.target,
                  targetUri: reference.targetPath ? pathToFileURL(reference.targetPath).href : undefined,
                  problem: reference.problem,
                  source: new Source({
                    start: reference.source.start,
                    end: reference.source.end,
                    text: reference.source.value,
                  }),
                }),
              )
            }
          }
          if (part.type === "file") {
            result.files.push(
              new FileAttachment({
                uri: part.url,
                mime: part.mime,
                name: part.filename,
                source: part.source
                  ? new Source({
                      start: part.source.text.start,
                      end: part.source.text.end,
                      text: part.source.text.value,
                    })
                  : undefined,
              }),
            )
          }
          if (part.type === "agent") {
            result.agents.push(
              new AgentAttachment({
                name: part.name,
                source: part.source
                  ? new Source({
                      start: part.source.start,
                      end: part.source.end,
                      text: part.source.value,
                    })
                  : undefined,
              }),
            )
          }
          return result
        },
        {
          text: [] as string[],
          files: [] as FileAttachment[],
          agents: [] as AgentAttachment[],
          references: [] as ReferenceAttachment[],
          synthetic: [] as string[],
        },
      )
      // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(info.time.created),
          delivery: "steer",
          prompt: new Prompt({
            text: nextPrompt.text.join("\n"),
            files: nextPrompt.files,
            agents: nextPrompt.agents,
            references: nextPrompt.references,
          }),
        })
      }
      for (const text of nextPrompt.synthetic) {
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Synthetic, {
            sessionID: input.sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(info.time.created),
            text,
          })
        }
      }

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const pipeline = yield* buildPromptPipelineSubmission(input)
      const message = yield* createUserMessage({
        ...input,
        parts: pipeline.parts,
        metadata: {
          ...(input.metadata ?? {}),
          deepagent: {
            ...(isRecord(input.metadata?.deepagent) ? input.metadata.deepagent : {}),
            prompt_pipeline: pipeline.metadata,
          },
        },
      })
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      const first = yield* loop({ sessionID: input.sessionID })
      // V3 Plan A: mode-driven multi-round autonomous loop for high/max/ultra. It remains
      // fail-closed (any error -> the single-turn result). Real validation (A3),
      // git rollback (A5), revise turn, and the A3 macro-round suggestion are wired.
      const agentMode = AgentGateway.snapshot().agentMode ?? "high"
      if (!MultiRound.multiRoundEnabled()) {
        if (agentMode !== "general") {
          yield* events.publish(Session.Event.Error, {
            sessionID: input.sessionID,
            error: new NamedError.Unknown({
              message:
                "DeepAgent multi-round workflow is disabled by DEEPAGENT_MULTIROUND; high/max/ultra will run as a single turn.",
            }).toObject(),
          })
        }
        return first
      }
      if (agentMode === "general") return first
      return yield* Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const ws = yield* Effect.promise(() => DeepAgentWorkspace.detect(ctx.directory))
        // P2-6: a managed mode with NO inferred validation commands runs every micro-round with an
        // empty validation gate — the loop accepts the first turn and the stopHookGate passes (no
        // required validations to run). That is correct behavior, but it silently degrades high/max/
        // ultra to a single unvalidated turn, which can read as "validated" downstream. Surface it.
        if (ws.validationCommands.length === 0) {
          log.warn(
            "deepagent multi-round: no validation commands inferred for workspace; validation gate is inactive this run",
            {
              sessionID: input.sessionID,
              directory: ctx.directory,
              agentMode,
            },
          )
        }
        // ultra requires the intelligence scenario: its supervisor advances macro-rounds by seeding the
        // next turn with the intelligence next-round suggestion, which only exists under intelligence. Under
        // `direct` the contract forbids ultra autonomy, so we fall back to a single human-approved
        // macro pass (high/max behavior) even when the strength is ultra.
        const isIntelligence = (() => {
          const req = promptPipelineRequest(input.metadata)
          if (req.mode === "intelligence" || req.confirmedDraftID) return true
          if (req.mode === "direct_override") return false
          // P2-E: fail CLOSED on ambiguous metadata. ultra autonomy (up to ultraMaxRounds with no
          // human in the loop) must require positive evidence of the intelligence scenario; absent an
          // explicit intelligence mode or a confirmed draft we treat it as NON-intelligence, so ultra degrades to a
          // single human-approved macro pass instead of looping unattended on a request that never
          // opted into autonomy.
          return false
        })()
        const autonomous = AgentGateway.DeepAgentMode.isAutonomous(agentMode) && isIntelligence
        if (AgentGateway.DeepAgentMode.isAutonomous(agentMode) && !isIntelligence) {
          yield* events
            .publish(Session.Event.Error, {
              sessionID: input.sessionID,
              error: new NamedError.Unknown({
                message:
                  "DeepAgent ultra requires the intelligence scenario; under direct it runs a single human-approved macro pass.",
              }).toObject(),
            })
            .pipe(Effect.catch(() => Effect.void))
        }
        // ultra has no human in the macro loop, so cap its auto-advanced macro-rounds. high/max
        // do one macro pass and surface the continuation suggestion for human approval, but do
        // not impose a DeepAgent micro-round cap inside that pass.
        const ultraMaxRounds = AgentGateway.DeepAgentMode.defaultMaxRounds(agentMode) ?? 8
        const macroCap = autonomous ? ultraMaxRounds : 1

        const persistSuggestion = (suggestion: { status: string; body: string }, report?: Record<string, unknown>) =>
          // P2-D: a persist failure (EACCES/ENOSPC) must NOT become an Effect defect — Effect.sync
          // would surface it as a defect that the outer fail-closed `Effect.catch` does not catch,
          // crashing the turn and losing the "degrade to first turn" guarantee. Effect.try maps it to
          // a recoverable error; the catch handler logs and continues so the round still completes
          // (the suggestion is lost but visible in the log, not silently dropped).
          Effect.try({
            try: () => {
              const home = new AgentGateway.DeepAgentWorkspace.DeepAgentCodeHome(Global.Path.agent.data)
              const sessionPath = home.ensureSession(projectIDForDirectory(ctx.directory), input.sessionID)
              const store = new AgentGateway.DeepAgentPromptPipeline.PromptDraftStore(sessionPath)
              store.saveSuggestion(suggestion)
              // A4: persist the structured round report (dual-provenance reconciliation) alongside
              // the suggestion so the contract is auditable after the run.
              if (report && typeof report.round === "number")
                store.saveRoundReport(report as { round: number } & Record<string, unknown>)
            },
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                log.warn("deepagent: failed to persist round suggestion/report", {
                  sessionID: input.sessionID,
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            ),
            // V3.9 §B.6: on a terminal round (done / needs_human), aggregate this session's Document
            // Graph trajectory (plan + worklog + diagnosis + decision) into a read-only execution
            // archive page. Session-INTERNAL (not event-driven — that is V4.0). Gated by
            // flags.experimentalWiki and fully default-safe (archiveSessionOnCompletion never throws
            // and is a pure read-projection — it never mutates the graph), so a failure here can never
            // affect the round. Non-terminal `continue` rounds are skipped — the trajectory is not yet
            // complete.
            Effect.tap(() =>
              flags.experimentalWiki && suggestion.status !== "continue"
                ? archiveSessionOnCompletion({ workspacePath: ctx.directory, sessionID: input.sessionID }).pipe(
                    Effect.asVoid,
                  )
                : Effect.void,
            ),
          )

        let result = first
        let macro = 0
        // P1-B: resolve the git repo root ONCE so the claimed change surface is relativized against
        // the SAME base git uses for ground truth (repo-root-relative). Falls back to the session
        // cwd outside a git repo. Without this, when ctx.directory is a repo subdirectory, claimed
        // files (relative to cwd) never matched the real diff (relative to repo root) and every
        // round was falsely escalated to needs_human.
        const changeSurfaceBase =
          (yield* Effect.promise(() => gitGroundTruth(ctx.directory))).repo_root ?? ctx.directory
        // The change surface the model CLAIMS it touched, derived from its actual edit/write/patch
        // tool calls on the just-finished turn. Reconciled against the real git diff so a claim of
        // a file the model never actually wrote (or a silent no-op turn) is caught objectively.
        const claimedChangeSurface = (turn: SessionV1.WithParts): readonly string[] => {
          const files = new Set<string>()
          for (const part of turn.parts ?? []) {
            if (part.type !== "tool") continue
            if (part.tool !== "edit" && part.tool !== "write" && part.tool !== "apply_patch") continue
            const input = (part.state as { input?: unknown }).input
            const fp = input && typeof input === "object" ? (input as { filePath?: unknown }).filePath : undefined
            if (typeof fp === "string" && fp.length > 0) {
              files.add(path.isAbsolute(fp) ? path.relative(changeSurfaceBase, fp) : fp)
            }
          }
          return [...files].map((f) => f.split(path.sep).join("/")).sort()
        }
        // P2-4: the claimed change surface must include edits from EVERY turn in this macro-round,
        // including revise turns run inside maybeRunRounds — not just the first turn. Accumulate
        // into a set that reviseTurn updates as each revised turn completes.
        const accumulatedChangeSurface = new Set<string>(claimedChangeSurface(result))
        // Macro-round loop. Each iteration runs the micro-round loop, then inspects the A3
        // suggestion. ultra auto-advances on `continue` (supervisor); everyone stops on `done`
        // or `needs_human` (escalate to the human), or when the macro cap / budget is hit.
        while (macro < macroCap) {
          macro++
          let suggestion: { status: string; body: string } | undefined
          result = yield* MultiRound.maybeRunRounds<SessionV1.WithParts>({
            sessionID: input.sessionID,
            agentMode,
            enabled: true,
            maxRounds: autonomous ? ultraMaxRounds : null,
            // T3 (S1-v3.4): yellow-stall narrowing budget before escalating to red (default 1).
            narrowLimit: flags.microbatchNarrowLimit ?? 1,
            first: result,
            validationCommands: ws.validationCommands,
            ensureSession: () => AgentGateway.DeepAgentOrchestrator.ensureSession(input.sessionID, agentMode),
            runValidation: (cmds) => Effect.promise(() => runValidationCommands(cmds, ctx.directory)),
            track: () => snapshot.track(),
            restore: (checkpoint) => snapshot.restore(checkpoint),
            reviseTurn: (text, action) =>
              Effect.gen(function* () {
                yield* createUserMessage({
                  sessionID: input.sessionID,
                  // T3 (S1-v3.4): tag the injected revise turn with the triage action ("revise"/"narrow")
                  // for frontend folding into "auto-fixing round N". Defaults to "continue" (legacy).
                  metadata: { deepagent: { round_control: { action: action ?? "continue" } } },
                  parts: [{ type: "text", text }],
                })
                const revised = yield* loop({ sessionID: input.sessionID })
                // P2-4: fold this revise turn's edits into the macro-round's claimed change surface.
                for (const f of claimedChangeSurface(revised)) accumulatedChangeSurface.add(f)
                return revised
              }).pipe(Effect.catch(() => Effect.succeed(result))),
            onMacroRound: (s, report) =>
              persistSuggestion(s, report as unknown as Record<string, unknown>).pipe(
                Effect.map(() => void (suggestion = s)),
              ),
            // Runner ground truth (real git diff) + the model's claimed change surface, so the
            // round report reconciles claims against reality instead of echoing ground truth.
            gitGroundTruth: () => Effect.promise(() => gitGroundTruth(ctx.directory)),
            claimedChangeSurface: () => [...accumulatedChangeSurface].sort(),
            macroRound: macro,
            // No-progress gate: fingerprint the working tree via the real diff stat so a revise
            // turn that changes nothing is detected and the thrash loop stops.
            diffFingerprint: () => Effect.promise(() => gitGroundTruth(ctx.directory).then((g) => g.diff_stat ?? "")),
          })

          // Non-autonomous (high/max): one pass, suggestion persisted for human approval. Stop.
          if (!autonomous || !suggestion || suggestion.status !== "continue") break

          // ultra supervisor approved another macro-round: seed the next turn with the suggestion
          // body (the intelligence next-goal prose) and continue. Budget exhaustion stops the loop.
          if (input.sessionID && AgentGateway.DeepAgentSessionState.isBudgetExhausted(input.sessionID)) break
          result = yield* Effect.gen(function* () {
            yield* createUserMessage({
              sessionID: input.sessionID,
              parts: [{ type: "text", text: suggestion!.body }],
              metadata: { deepagent: { round_control: { action: "continue" } } },
            })
            return yield* loop({ sessionID: input.sessionID })
          }).pipe(Effect.catch(() => Effect.succeed(result)))
        }
        return result
      }).pipe(Effect.catch(() => Effect.succeed(first)))
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    // V4.1 §S1.1: drain the durable steer buffer and PERSIST each pending steer as an ordinary V1 user
    // message at the TAIL of history — exactly the append path a normal prompt uses (updateMessage +
    // updatePart). This is codex's "drain pendingInput into history as a role:user tail message". Because
    // the steer lands as a plain history message BEFORE the single volatile round-context tail assembled
    // in llm/request.ts, the cached system prefix and the single trailing volatile message are both
    // untouched — cache-safe (see request.ts applyCaching slice(-2)). Returns the count drained so the
    // caller can decide whether the freshly-read history now includes new tail user messages.
    //
    // EXACTLY-ONCE, PERSIST-FIRST (no loss + no duplicate). We (1) read the pending steers non-
    // consumingly, (2) materialize each as a history message, THEN (3) mark them consumed. If the process
    // crashes between (2) and (3) the row stays pending, so the next drain re-materializes it — a no-op
    // because BOTH the message id AND its text part id are DERIVED FROM THE STEER ID (stable across
    // replays), and the V1 projector upserts on those ids (MessageUpdated/PartUpdated →
    // onConflictDoUpdate on the id). So re-persisting hits the same row (idempotent), never a duplicate
    // turn. The steer id is an ascending SessionMessage.ID minted at admit time, so tail-sorting (Check 3)
    // is preserved. This replaces the earlier stamp-then-persist ordering, whose crash window between the
    // consume stamp and the message write could lose a steer permanently.
    const steerPartID = (messageID: MessageID, suffix?: string) =>
      PartID.make("prt_" + messageID.slice("msg_".length) + (suffix ?? ""))
    const drainSteers = Effect.fn("SessionPrompt.drainSteers")(function* (sessionID: SessionID) {
      if (!flags.v4Steering) return 0
      const pending = yield* steerBuffer.pending(sessionID)
      if (pending.length === 0) return 0
      const current = yield* db
        .select({ agent: SessionTable.agent, model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const defaultAgent = current?.agent ?? (yield* agents.defaultInfo())?.name ?? "build"
      const resolved = current?.model
        ? {
            providerID: ProviderV2.ID.make(current.model.providerID),
            modelID: ModelV2.ID.make(current.model.id),
            variant:
              current.model.variant && current.model.variant !== "default" ? current.model.variant : undefined,
          }
        : yield* currentModel(sessionID)
      const variant = "variant" in resolved ? resolved.variant : undefined
      const persisted: SessionMessage.ID[] = []
      for (const admitted of pending) {
        const agentName = admitted.prompt.agents?.[0]?.name ?? defaultAgent
        const info: SessionV1.User = {
          id: MessageID.make(admitted.id),
          role: "user",
          sessionID,
          time: { created: admitted.timeCreated },
          agent: agentName,
          model: {
            providerID: resolved.providerID,
            modelID: resolved.modelID,
            ...(variant ? { variant } : {}),
          },
        }
        // PERSIST-FIRST: materialize the history message and all durable parts before stamping consumed.
        // Part IDs are derived from the steer id so post-crash replays are idempotent upserts.
        yield* sessions.updateMessage(info)
        if (admitted.prompt.text.length > 0)
          yield* sessions.updatePart({
            id: steerPartID(info.id),
            messageID: info.id,
            sessionID,
            type: "text",
            text: admitted.prompt.text,
          })
        for (const [i, file] of (admitted.prompt.files ?? []).entries())
          yield* sessions.updatePart({
            id: steerPartID(info.id, `_f${i}`),
            messageID: info.id,
            sessionID,
            type: "file",
            url: file.uri,
            mime: file.mime,
            filename: file.name ?? file.uri,
          })
        for (const [i, agent] of (admitted.prompt.agents ?? []).entries())
          yield* sessions.updatePart({
            id: steerPartID(info.id, `_a${i}`),
            messageID: info.id,
            sessionID,
            type: "agent",
            name: agent.name,
          })
        persisted.push(admitted.id)
        yield* elog.info("steer absorbed at boundary", { sessionID, messageID: info.id, seq: admitted.seq })
      }
      // Only AFTER every steer is durably in history do we mark them consumed. A crash before this leaves
      // them pending → re-materialized (idempotently) on the next drain. No loss, no double-apply.
      yield* steerBuffer.markConsumed(sessionID, persisted)
      return pending.length
    })

    // ── V4.0.1 P0: three-layer SOFT-LANDING compaction ─────────────────────────────────────────────
    // The durable soft-landing state lives on session metadata (survives cold recovery, same store as
    // every other durable session field). This key namespaces it so it never collides with other
    // metadata producers.
    const SOFT_LANDING_METADATA_KEY = "compactionSoftLanding"
    const decodeSoftLanding = Schema.decodeUnknownOption(CompactionSoftLandingState)

    const readSoftLandingState: (sessionID: SessionID) => Effect.Effect<CompactionSoftLandingState> = Effect.fn(
      "SessionPrompt.readSoftLandingState",
    )(function* (sessionID: SessionID) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
      const raw = session?.metadata?.[SOFT_LANDING_METADATA_KEY]
      return Option.getOrElse(decodeSoftLanding(raw), () => initialSoftLandingState)
    })

    const writeSoftLandingState: (
      sessionID: SessionID,
      state: CompactionSoftLandingState,
    ) => Effect.Effect<void> = Effect.fn("SessionPrompt.writeSoftLandingState")(function* (sessionID, state) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
      // Merge into existing metadata so we never clobber a co-tenant key.
      const metadata = { ...(session?.metadata ?? {}), [SOFT_LANDING_METADATA_KEY]: state }
      yield* sessions.setMetadata({ sessionID, metadata }).pipe(Effect.ignore)
    })

    // reminder (soft line): a lightweight, non-compacting tail nudge asking the model to persist key
    // decisions/findings into the plan's evidence/worklog. Reuses the SAME tail-user-message channel as
    // steering (never mutates the static system prefix → prompt cache stays intact). `synthetic` marks
    // it internal so it doesn't leak into previews/archives; it still reaches the model as a user text.
    const REMINDER_TAIL_TEXT = [
      "<system-reminder>",
      "上下文接近上限。请把关键决策 / 发现 / 下一步意图写进 plan 的 evidence 或 worklog，避免压缩时丢失。",
      "文件与环境的当前值无需复述，系统会自动重注入。",
      "</system-reminder>",
    ].join("\n")

    const injectTailReminder: (
      sessionID: SessionID,
      text: string,
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID },
      agentName: string,
    ) => Effect.Effect<void> = Effect.fn("SessionPrompt.injectTailReminder")(function* (
      sessionID,
      text,
      model,
      agentName,
    ) {
      const msg = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: agentName,
        model,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        synthetic: true,
        text,
      })
    })

    // fallback ("临终笔记" line): the last chance before a hard compaction. All tools stay available so
    // the model can call the plan-edit tool to固化 un-persisted state. Under a goal (loop/design) mode we
    // additionally name the plan tool. §2.4 template — short, natural language.
    const fallbackTailText = (sessionID: SessionID) => {
      const goalActive = AgentGateway.DeepAgentSessionState.getActiveGoal(sessionID) != null
      return [
        "<system-reminder>",
        "上下文即将压缩。这是压缩前最后一次机会。",
        "请立刻把以下内容写入持久状态，不要开始新的探索：",
        "- 尚未记录的关键决策与理由",
        "- 已经得到但未落盘的中间结论 / 数据引用",
        "- 明确的下一步意图（写进 plan 的 next / worklog）",
        goalActive ? "用 `plan` 工具更新 goal+plan，把上述内容落进 evidence/worklog。" : "",
        "完成落盘后停止本轮。文件与环境的当前值无需复述，系统会自动重注入。",
        "</system-reminder>",
      ]
        .filter(Boolean)
        .join("\n")
    }

    // V4.0.1 P0b OUTPUT soft-landing — the "continue from the cutoff" nudge injected when a response was
    // truncated at the output-token ceiling (finish === "length") with no pending tool call. Unlike Codex
    // (which re-sends the identical request and re-hits the same cap), we append the model's already-
    // streamed partial text as history and ask it to RESUME — so the pieces stitch by continuation.
    const OUTPUT_CONTINUE_TAIL_TEXT = [
      "<system-reminder>",
      "你上一轮的输出因达到输出长度上限被截断（未自然结束）。请直接从被截断处继续，",
      "不要重复已经输出的内容，也不要重新开头。若已实质完成，简短收尾即可。",
      "</system-reminder>",
    ].join("\n")

    // V4.0.1 P1 (§3.3) — post-hard-compaction World State re-injection. After a hard compaction the
    // (now-narrowed) summary deliberately dropped file/env/diagnostics; this re-injects their LATEST
    // values as a TAIL user block (reuses the SAME injectTailReminder primitive — never the static system
    // prefix, so prompt cache is preserved) so the model sees current truth, not a stale summary value.
    // Gated by worldStateReinjection (the same flag that narrowed the summary — no information hole).
    // Bounded IO: git + env only, collected once per compaction. Default-safe: any defect ⇒ no-op.
    const injectWorldStateTail: (
      sessionID: SessionID,
      workspacePath: string | undefined,
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID },
      agentName: string,
    ) => Effect.Effect<void> = Effect.fn("SessionPrompt.injectWorldStateTail")(function* (
      sessionID,
      workspacePath,
      model,
      agentName,
    ) {
      if (!workspacePath) return
      const facts = yield* collectVolatileFacts(workspacePath)
      const rendered = yield* refreshWorldState({ workspacePath, facts })
      if (rendered.trim().length > 0) yield* injectTailReminder(sessionID, rendered, model, agentName)
    })

    const runLoop: (sessionID: SessionID, drainFirst?: boolean) => Effect.Effect<SessionV1.WithParts> = Effect.fn(
      "SessionPrompt.run",
    )(
      // §S1.2: `drainFirst` — a PURE-DRAIN turn (started to absorb a steer that landed in the isBusy→admit
      // race, with no initiating user message of its own) must drain on step 0 too; otherwise the step-0
      // skip + the immediate finish check would break before the steer is ever consumed. A normal turn
      // leaves it false so the initiating message samples first (S1.1).
      function* (sessionID: SessionID, drainFirst = false) {
        const ctx = yield* InstanceState.context
        const slog = elog.with({ sessionID })
        let structured: unknown
        let step = 0
        // P0: count StructuredOutput tool-call attempts that did NOT produce a valid structured
        // result (schema validation rejected the arguments). When this reaches the format's
        // retryCount ceiling we inject a corrective hint and exit — preventing the infinite loop
        // that occurs when the model repeatedly guesses wrong field names (e.g. "summary" instead
        // of "module" for ResearchResult) and the AI SDK silently rejects them before execute().
        let structuredFailedAttempts = 0
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

        // V3.8 App-A C2.5 (Stage 5): the Conversation Log writer. Constructed ONCE per run so its
        // in-memory seq + seen-set persist across the loop's iterations (dedup by content identity).
        // default-safe: a construction defect (fs error) yields a no-op writer, never a turn crash.
        const logWriter = yield* ConversationLogWriter.make(sessionID)

        // F1: one tracker per durable user activity; shared by every provider step (processor
        // instance) created in this runLoop call so cross-message ABABAB/ABCABC/... patterns
        // are detectable.  Reset implicitly on the next runLoop invocation (new variable).
        const toolSequenceTracker = new SessionProcessor.ToolSequenceTracker()

        // V3.8 Phase 3 (v3.8.1 §B.3): fire ONE lightweight code-index pass for this workspace, the real
        // trigger that finally puts code_symbol nodes on the graph (indexFiles had zero prod callers).
        // Gated to once-per-session-per-process (indexedSessions) so re-prompts don't re-walk; forked
        // into the run scope so it never blocks the turn; fully default-safe inside indexWorkspace.
        // V3.9 §A: `lsp` enables the AST symbol pass (symbol nodes + imports/calls edges) over the
        // content-sha-changed files; a language with no LSP client degrades to the file-level view.
        // SEAM: incremental mtime-gated fs-walking is the remaining follow-up (see code-index-trigger.ts).
        if (!indexedSessions.has(sessionID)) {
          indexedSessions.add(sessionID)
          yield* CodeIndexTrigger.indexWorkspace({ workspacePath: ctx.directory, fsys, lsp }).pipe(
            Effect.asVoid,
            Effect.forkIn(scope),
          )
        }

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* slog.info("loop", { step })

          // V4.1 §S1.1 STEER DRAIN POINT — absorb-at-boundary, NOT abort. Drain the durable steer buffer
          // at the TOP of each iteration and persist each pending steer as a tail user message BEFORE we
          // re-read history below, so the fresh read picks it up at the end of history (codex's
          // drain-at-turn-top). SKIP the FIRST iteration (step === 0): the initiating user message must
          // sample first, matching codex. The in-flight model stream + tool loop of the PREVIOUS
          // iteration have already completed by the time we re-enter here, so nothing is interrupted.
          // A drained steer's id (MessageID.ascending) sorts after the last assistant, which flips the
          // top-of-loop finish check (`lastUser.id < lastAssistant.id`) to keep looping — so a steer that
          // arrived after the model said "done" is naturally absorbed on this next pass.
          if (step > 0 || drainFirst) yield* drainSteers(sessionID)

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )

          // Archive everything settled so far (user turn + any completed assistant/tool parts from the
          // prior iteration). Deduped by content, so re-scanning the same messages each loop is cheap
          // and idempotent. Wrapped default-safe (matchCauseEffect inside record) — never fails a turn.
          yield* ConversationLogWriter.record(logWriter, msgs)

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains
          // tool calls. Keep the loop running so tool results can be sent back to
          // the model, but ignore cleanup-marked interrupted orphans.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          if (
            lastAssistant?.finish &&
            !["tool-calls"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastUser.id < lastAssistant.id
          ) {
            // V4.0.1 P0b OUTPUT soft-landing — a response cut off at the output-token ceiling finishes with
            // "length" (never "tool-calls", so it reaches here). Instead of ending the turn mid-sentence,
            // inject a bounded "continue from the cutoff" nudge and loop once more so the model resumes; the
            // already-streamed partial is in history, so the continuation stitches on. Bounded by
            // OUTPUT_CONTINUATION_MAX consecutive continuations (a fresh count each turn once a natural stop
            // resets it) to prevent an infinite loop — the knob Codex lacks. Context growth from the extra
            // turn is caught by the top-of-loop overflow check on the next pass (compaction stays separate).
            if (flags.outputSoftLanding && lastAssistant.finish === "length") {
              const sls = yield* readSoftLandingState(sessionID)
              const done = sls.outputContinuationCount ?? 0
              if (done < outputContinuationMax()) {
                yield* writeSoftLandingState(sessionID, { ...sls, outputContinuationCount: done + 1 })
                yield* injectTailReminder(sessionID, OUTPUT_CONTINUE_TAIL_TEXT, lastUser.model, lastUser.agent)
                yield* slog.info("output soft-landing: continuing after length cutoff", {
                  continuation: done + 1,
                  max: outputContinuationMax(),
                })
                continue
              }
              yield* slog.warn("output soft-landing: continuation cap reached, ending turn", { max: outputContinuationMax() })
            }
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* slog.warn("loop exit with orphaned interrupted tool", {
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            yield* slog.info("exiting loop")
            break
          }
          // Output soft-landing: a natural stop (or any non-length finish that keeps looping via tool
          // calls) resets the consecutive-continuation run so a later length cutoff gets the full budget.
          if (flags.outputSoftLanding && lastAssistant?.finish && lastAssistant.finish !== "length") {
            const sls = yield* readSoftLandingState(sessionID)
            if ((sls.outputContinuationCount ?? 0) !== 0)
              yield* writeSoftLandingState(sessionID, { ...sls, outputContinuationCount: 0 })
          }

          step++
          if (step === 1) {
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))
            yield* preview({ session, history: msgs }).pipe(Effect.ignore, Effect.forkIn(scope))
          }

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          if (task?.type === "compaction") {
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
            })
            if (result === "stop") break
            continue
          }

          // V4.0.1 P0 — turn-start soft-landing / overflow check. With softLandingCompaction OFF this is
          // byte-for-byte the pre-V4.0.1 single-threshold path (isOverflow → compaction.create). With it
          // ON, overflowStatus layers ok → reminder → fallback → hard: warn (tail nudge), then one forced
          // "临终笔记" fallback (all tools retained), then the SAME hard compaction. `phase === "hard"` is
          // exactly `isOverflow`, and the reminder/fallback layers never move the hard line, so the
          // compaction trigger is unchanged.
          if (lastFinished && lastFinished.summary !== true) {
            if (!flags.softLandingCompaction) {
              if (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model })) {
                yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
                continue
              }
            } else {
              const cfg = yield* config.get()
              const slState0 = yield* readSoftLandingState(sessionID)
              // BodyAfterPrefix (§2.3, Codex core/src/state/auto_compact_window.rs): latch a per-window
              // input-token BASELINE from the provider-reported input side of the FIRST response of this
              // window (input + cached read/write = the full billed input, matching the goal ledger's
              // carriedPrefix). Once set it is pinned for the window (cleared on the epoch bump at a hard
              // compaction) — server-observed only, no tokenizer. `overflowStatus` subtracts it so the
              // lines fire on body growth; a full-window safety cap still guards the raw total.
              const billedInput =
                lastFinished.tokens.input + lastFinished.tokens.cache.read + lastFinished.tokens.cache.write
              const slState =
                slState0.prefillInputTokens === undefined && billedInput > 0
                  ? { ...slState0, prefillInputTokens: billedInput }
                  : slState0
              if (slState !== slState0) yield* writeSoftLandingState(sessionID, slState)
              const status = overflowStatus({
                cfg,
                model,
                outputTokenMax: flags.outputTokenMax,
                tokens: tokensUsed(lastFinished.tokens),
                prefixTokens: slState.prefillInputTokens ?? 0,
                softLanding: true,
              })
              const { action, nextState } = softLandingDecision({ status, state: slState, step })
              if (action === "reminder") {
                yield* writeSoftLandingState(sessionID, nextState)
                yield* injectTailReminder(sessionID, REMINDER_TAIL_TEXT, lastUser.model, lastUser.agent)
                yield* slog.info("soft-landing reminder injected", { used: status.used, softLine: status.softLine })
                continue
              }
              if (action === "fallback") {
                yield* writeSoftLandingState(sessionID, nextState)
                yield* injectTailReminder(sessionID, fallbackTailText(sessionID), lastUser.model, lastUser.agent)
                yield* slog.info("soft-landing fallback injected", {
                  used: status.used,
                  fallbackLine: status.fallbackLine,
                })
                continue
              }
              if (action === "hard") {
                // Bump the generation + reset flags BEFORE compaction so a mid-compaction crash still
                // recovers into the fresh window (the durable write is the世代 marker).
                yield* writeSoftLandingState(sessionID, nextState)
                yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
                // P1 §3.3: re-inject the latest World State as a TAIL block right after the hard compaction
                // so the model sees current file/env values, not the summary's (now-narrowed) stale ones.
                // Ordered after compaction.create ⇒ higher message id ⇒ sits at the tail after the summary.
                if (flags.worldStateReinjection)
                  yield* injectWorldStateTail(sessionID, ctx.directory, lastUser.model, lastUser.agent)
                continue
              }
              // action === "none": fallback already delivered this epoch (still under hard line), reminder
              // debounced, or below the soft line — proceed with the turn normally.
            }
          }

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps = agent.steps ?? Infinity
          const isLastStep = step >= maxSteps
          msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(FSUtil.Service, fsys),
            Effect.provideService(Session.Service, sessions),
          )

          const msg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)

          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
              sequenceTracker: toolSequenceTracker,
            })
            .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            const promptOps = yield* ops()

            const tools = yield* SessionTools.resolve({
              agent,
              session,
              model,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              promptOps,
            }).pipe(
              Effect.provideService(Plugin.Service, plugin),
              Effect.provideService(Permission.Service, permission),
              Effect.provideService(ToolRegistry.Service, registry),
              Effect.provideService(MCP.Service, mcp),
              Effect.provideService(Truncate.Service, truncate),
              Effect.provideService(RuntimeFlags.Service, flags),
            )

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            if (step > 1 && lastFinished) {
              for (const m of msgs) {
                if (m.info.role !== "user" || m.info.id <= lastFinished.id) continue
                for (const p of m.parts) {
                  if (p.type !== "text" || p.ignored || p.synthetic) continue
                  if (!p.text.trim()) continue
                  p.text = [
                    "<system-reminder>",
                    "The user sent the following message:",
                    p.text,
                    "",
                    "Please address this message and continue with your tasks.",
                    "</system-reminder>",
                  ].join("\n")
                }
              }
            }

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            // PR-1: Compute terminal boundary for reasoning model-view projection.
            // The most recent settled assistant message (has finish, no pending tool calls)
            // defines the boundary — reasoning from all messages at or before this ID is
            // stripped from the model view. Provider replay constraints (signed thinking)
            // only apply to the active continuation chain, not settled history.
            let terminalBoundaryID: MessageID | undefined
            for (const msg of msgs) {
              if (msg.info.role !== "assistant") continue
              if (!msg.info.finish) continue
              const hasPendingToolCalls = msg.parts.some(
                (part): part is SessionV1.ToolPart =>
                  part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
              )
              if (hasPendingToolCalls) continue
              if (!terminalBoundaryID || msg.info.id > terminalBoundaryID) {
                terminalBoundaryID = msg.info.id
              }
            }

            const [skills, env, instructions, modelMsgs] = yield* Effect.all([
              sys.skills(agent),
              sys.environment(model),
              instruction.system().pipe(Effect.orDie),
              MessageV2.toModelMessagesEffect(msgs, model, { terminalBoundaryID }),
            ])
            const system = [...env, ...instructions, ...(skills ? [skills] : [])]
            const format = lastUser.format ?? { type: "text" as const }
            // P1: inject schema-aware prompt so the model knows the exact field names even
            // during extended-thinking (xhigh) reasoning where the tool definition may not
            // be immediately visible when the model starts generating its thinking tokens.
            if (format.type === "json_schema") system.push(buildStructuredOutputSystemPrompt(format.schema))
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
              tools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
            })

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              if (format.type === "json_schema") {
                handle.message.error = new SessionV1.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            // P0: StructuredOutput retry-cap. Only fires when:
            //   1. format is json_schema (structured-output mode)
            //   2. the model made tool-calls (finish === "tool-calls")
            //   3. structured is still undefined (StructuredOutput was NOT successfully captured)
            //   4. the current turn's parts actually contain a StructuredOutput call
            //      (B1 fix: filter to ONLY StructuredOutput failures, not any tool call)
            //
            // When the model called StructuredOutput but AI SDK schema-validation rejected the
            // arguments (wrong field names like "summary" instead of "module"), execute() never
            // runs, onSuccess never fires, and structured stays undefined — causing an infinite
            // loop. The retry-cap truncates this loop.
            if (format.type === "json_schema" && handle.message.finish === "tool-calls") {
              // Re-read the latest message parts to detect if StructuredOutput was attempted
              // this step. We check the CURRENT assistant message's parts (by handle.message.id).
              const latestMsgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
                Effect.provideService(Database.Service, database),
              )
              const currentAssistantMsg = latestMsgs.findLast(
                (m) => m.info.role === "assistant" && m.info.id === handle.message.id,
              )
              const hadStructuredOutputCall = currentAssistantMsg?.parts.some(
                (p) => p.type === "tool" && p.tool === "StructuredOutput",
              ) ?? false

              if (hadStructuredOutputCall) {
                const retryMax = format.retryCount ?? 2
                structuredFailedAttempts++
                const fields = extractSchemaTopLevelFields(format.schema)
                const fieldList = fields.length > 0 ? fields.join(", ") : "(see schema)"
                if (structuredFailedAttempts >= retryMax) {
                  handle.message.error = new SessionV1.StructuredOutputError({
                    message: `StructuredOutput schema validation failed after ${structuredFailedAttempts} attempt(s). Required fields: ${fieldList}`,
                    retries: structuredFailedAttempts,
                  }).toObject()
                  yield* sessions.updateMessage(handle.message)
                  yield* slog.warn("structured-output retry cap reached", {
                    attempts: structuredFailedAttempts,
                    retryMax,
                    fields: fieldList,
                  })
                  return "break" as const
                }
                // B2 fix: inject via injectTailReminder (user-side synthetic message) so the
                // correction text appears as a user instruction in the next model context —
                // not as assistant output (which the model treats with lower compliance).
                if (fields.length > 0) {
                  yield* injectTailReminder(
                    sessionID,
                    `[structured-output correction] Your StructuredOutput call did not match the required schema. Required top-level fields: ${fieldList}. Please call StructuredOutput again using EXACTLY these field names.`,
                    lastUser.model,
                    lastUser.agent,
                  )
                }
              }
            }

            if (result === "stop") return "break" as const
            if (result === "compact") {
              // V4.0.1 P0 — a turn-internal hard compaction (the provider signalled overflow mid-stream).
              // This IS a hard rollover, so bump the soft-landing generation + reset its flags so the next
              // window can warn + flush again. Gated by softLandingCompaction; OFF ⇒ unchanged behavior.
              if (flags.softLandingCompaction) {
                const slState = yield* readSoftLandingState(sessionID)
                yield* writeSoftLandingState(sessionID, {
                  windowEpoch: slState.windowEpoch + 1,
                  autoCompactFallbackDelivered: false,
                })
              }
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
              // P1 §3.3: re-inject the latest World State as a TAIL block right after this hard rollover
              // (same responsibility-separation intent as the turn-start branch). Gated by the same flag.
              if (flags.worldStateReinjection)
                yield* injectWorldStateTail(sessionID, ctx.directory, lastUser.model, lastUser.agent)
            }
            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
          // V4.1 §S1.1 needsFollowUp: the model finished this step (outcome === "break"), but if a steer
          // arrived while it was running, do NOT exit — loop once more so the top-of-loop drain absorbs
          // it (codex: needsFollowUp = modelSaidContinue || pendingInput-nonempty). A non-consuming peek;
          // the actual drain (consume-once) happens at the next iteration's top. Gated by the flag.
          if (outcome === "break") {
            if (flags.v4Steering && (yield* steerBuffer.hasPending(sessionID))) {
              yield* slog.info("steer pending at model boundary, continuing to absorb")
              continue
            }
            break
          }
          continue
        }

        // Final archive pass: the last assistant turn only completes AFTER the loop's final iteration,
        // so re-scan once more to capture its now-settled text/reasoning/tool parts. Deduped, so any
        // already-logged parts are skipped. default-safe.
        const finalMsgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
          Effect.provideService(Database.Service, database),
          Effect.orElseSucceed(() => [] as SessionV1.WithParts[]),
        )
        yield* ConversationLogWriter.record(logWriter, finalMsgs)

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    // V4.1 §S1.1: admit a mid-turn user message into the durable steer buffer.
    // The canonical durable ID is always server-minted by admit(); the caller's messageID is used
    // only as an optional correlationID for idempotent retries.
    const steer: (input: {
      sessionID: SessionID
      prompt: Prompt
      delivery?: SessionSteer.Delivery
      messageID?: SessionMessage.ID
    }) => Effect.Effect<SessionSteer.Admitted> = Effect.fn(
      "SessionPrompt.steer",
    )(function* (input) {
      if (!flags.v4Steering)
        return yield* Effect.die(new NamedError.Unknown({ message: "Steering is disabled (v4Steering=false)" }))
      const delivery = input.delivery ?? "steer"
      const admitted = yield* steerBuffer.admit({
        sessionID: input.sessionID,
        prompt: input.prompt,
        delivery,
        correlationID: input.messageID,
      }).pipe(
        Effect.catchTag("SessionSteer.CorrelationConflict", () =>
          Effect.die(new NamedError.Unknown({ message: "Steer correlation conflict: duplicate follow-up" })),
        ),
      )
      yield* elog.info("steer admitted", {
        sessionID: input.sessionID,
        messageID: admitted.id,
        seq: admitted.seq,
        delivery,
      })
      return admitted
    })

    // V4.1 §S1.2 — the ingress decision. Both the HTTP prompt route and the IM agent executor call THIS
    // instead of prompt() directly, so the steer-vs-turn choice lives in exactly one place.
    //
    // Routing (in priority order):
    //   1. steering OFF → prompt() (exact pre-steering behavior; the runner enforces its own busy policy).
    //   2. a NON-terminal active GOAL on this session → "goal_steer". A goal runs as a detached background
    //      job in CHILD sessions and does NOT busy the parent runner, so we must key off the active-goal
    //      pointer, NOT isBusy (an earlier version gated goal_steer behind isBusy and it was unreachable in
    //      the pure-goal case). The goal driver drains "goal_steer" between ticks (§S1.3); paused → drained
    //      on resume; terminal phases never buffer (the goalActive check below excludes them).
    //   3. else, the parent runner is BUSY (a live chat turn) → "steer", absorbed at that turn's next
    //      boundary (§S1.1). Race: if the turn ends between the isBusy read and the admit, the steer is
    //      durable but the still-running loop won't see it — so we start a PURE-DRAIN turn (drainFirst)
    //      that drains on step 0. ensureRunning makes this a no-op await if a turn is (still) running, so
    //      there is no double-turn; if idle, it runs one drain turn. Forked so the ingress returns promptly.
    //   4. else idle, no goal → prompt() runs a normal turn.
    const promptOrSteer: (input: PromptInput) => Effect.Effect<PromptOrSteerResult, Image.Error> = Effect.fn(
      "SessionPrompt.promptOrSteer",
    )(function* (input: PromptInput) {
      if (!flags.v4Steering) {
        const message = yield* prompt(input)
        return { kind: "turn" as const, message }
      }
      // (2) Active-goal check FIRST — independent of the parent runner's busy flag.
      const goal = AgentGateway.DeepAgentSessionState.getActiveGoal(input.sessionID)
      const goalActive = goal != null && !TERMINAL_GOAL_PHASES.has(goal.phase)
      if (goalActive) {
        const steerPrompt = yield* promptInputToPrompt(input.parts).pipe(
          Effect.catchTag("SessionPrompt.InvalidInput", (e) =>
            Effect.die(e),
          ),
        )
        const admitted = yield* steer({
          sessionID: input.sessionID,
          prompt: steerPrompt,
          delivery: "goal_steer",
          messageID: input.messageID as unknown as SessionMessage.ID | undefined,
        })
        // V4.1 governance audit — this is the REAL user goal-steer path (the ingress every busy-goal
        // steer flows through). Record the human intervention into the goal's Document Graph alongside
        // the per-tick worklog trail. Length only (not free-text) to keep the body bounded + PII-light;
        // best-effort (never blocks the steer). goal!.goalId is safe here: goalActive ⇒ goal != null.
        writeGovernanceAudit(input.sessionID, goal!.goalId, "steer", { textChars: steerPrompt.text.trim().length })
        return { kind: "steer" as const, delivery: "goal_steer" as const, admitted }
      }
      // (3) No active goal → a parent chat turn in flight becomes a chat steer.
      const busy = yield* state.isBusy(input.sessionID)
      if (!busy) {
        // (4) idle, no goal → normal turn.
        const message = yield* prompt(input)
        return { kind: "turn" as const, message }
      }
      const steerPrompt = yield* promptInputToPrompt(input.parts).pipe(
        Effect.catchTag("SessionPrompt.InvalidInput", (e) =>
          Effect.die(e),
        ),
      )
      const admitted = yield* steer({
        sessionID: input.sessionID,
        prompt: steerPrompt,
        delivery: "steer",
        messageID: input.messageID as unknown as SessionMessage.ID | undefined,
      })
      // Race guard (see header): a pure-drain turn absorbs a steer stranded by the isBusy→admit window.
      yield* loop({ sessionID: input.sessionID, drainFirst: true }).pipe(Effect.ignore, Effect.forkIn(scope))
      return { kind: "steer" as const, delivery: "steer" as const, admitted }
    })

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(
        input.sessionID,
        lastAssistant(input.sessionID),
        runLoop(input.sessionID, input.drainFirst ?? false),
      )
    })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
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
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
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

      const templateParts = yield* resolvePromptParts(template)
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
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
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

    return Service.of({
      cancel,
      prompt,
      steer,
      promptOrSteer,
      loop,
      shell,
      command,
      resolvePromptParts,
      refineIntelligenceDraft,
      latestSuggestion,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        Agent.defaultLayer,
        Auth.defaultLayer,
        Database.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        Reference.defaultLayer,
        Snapshot.defaultLayer,
        CrossSpawnSpawner.defaultLayer,
        RuntimeFlags.defaultLayer,
        EventV2Bridge.defaultLayer,
        SessionSteer.defaultLayer,
      ),
    ),
  ),
)
const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

// V4.1 §S1.1: the shape a mid-turn steer is admitted with. Deliberately the reduced Prompt payload (a
// steer is a plain user turn) — file/agent/reference attachments carry through so a steered @mention or
// attachment is preserved. `messageID` is optional so an at-least-once ingress (S1.2) can supply a
// stable idempotency id; when omitted, admit generates one.
export const SteerInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(SessionMessage.ID),
  text: Schema.String,
  files: Schema.optional(Schema.Array(FileAttachment)),
  agents: Schema.optional(Schema.Array(AgentAttachment)),
  references: Schema.optional(Schema.Array(ReferenceAttachment)),
  // §S1.3 delivery channel: "steer" (default, drained by the session runLoop) or "goal_steer" (drained
  // by the goal driver between ticks). Omitted ⇒ "steer".
  delivery: Schema.optional(Schema.Literals(["steer", "goal_steer"])),
})
export type SteerInput = Schema.Schema.Type<typeof SteerInput>

// §S1.2 the discriminated ack returned by promptOrSteer: either a completed turn (the session was idle)
// or an accepted steer (the session was mid-turn; the running/next turn absorbs it). The `delivery` tells
// the caller which channel absorbed it ("steer" = this session's turn, "goal_steer" = the active goal).
export type PromptOrSteerResult =
  | { readonly kind: "turn"; readonly message: SessionV1.WithParts }
  | { readonly kind: "steer"; readonly delivery: "steer" | "goal_steer"; readonly admitted: SessionSteer.Admitted }

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
  // §S1.2: start a pure-drain turn that absorbs a pending steer on step 0 (no initiating message). Only
  // set by promptOrSteer's race guard; a normal loop() leaves it unset (false).
  drainFirst: Schema.optional(Schema.Boolean),
}) {}

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

const rawInputFromPromptParts = (parts: readonly PromptInput["parts"][number][]): string => {
  const text = parts
    .filter(
      (part): part is Extract<PromptInput["parts"][number], { type: "text" }> =>
        part.type === "text" && !part.synthetic,
    )
    .map((part) => part.text)
    .join("\n")
    .trim()
  return text || `[non-text prompt parts: ${parts.length}]`
}

const promptPipelineRequest = (
  metadata: unknown,
): {
  mode?: "intelligence" | "direct_override"
  confirmedDraftID?: string
  editedGoal?: string
} => {
  const deepagent = isRecord(metadata) && isRecord(metadata.deepagent) ? metadata.deepagent : {}
  const raw = isRecord(deepagent.prompt_pipeline) ? deepagent.prompt_pipeline : deepagent
  // Legacy-compat: "wish" is the pre-rename wire/metadata literal for "intelligence". Normalize it
  // so an older client (or a session persisted before the rename) whose mode is "wish" still
  // resolves to the intelligence pipeline.
  const rawMode = raw.mode === "wish" ? "intelligence" : raw.mode
  const mode = rawMode === "intelligence" || rawMode === "direct_override" ? rawMode : undefined
  return {
    mode,
    confirmedDraftID:
      typeof raw.confirmedDraftID === "string"
        ? raw.confirmedDraftID
        : typeof raw.confirmed_draft_id === "string"
          ? raw.confirmed_draft_id
          : undefined,
    editedGoal:
      typeof raw.editedGoal === "string"
        ? raw.editedGoal
        : typeof raw.edited_goal === "string"
          ? raw.edited_goal
          : undefined,
  }
}

const replacePromptText = (parts: readonly PromptInput["parts"][number][], text: string): PromptInput["parts"] => {
  let replaced = false
  const next = parts.map((part) => {
    if (part.type !== "text" || part.synthetic || replaced) return part
    replaced = true
    return { ...part, text }
  })
  return (replaced ? next : [{ type: "text" as const, text }, ...next]) as PromptInput["parts"]
}

// docs/34 §8: single canonical workspace-id derivation (shared with the gateway/retriever write+read
// sides). Delegates to the durable-knowledge-store helper so a project's durable knowledge tags and
// its retrieval filter agree on the same id.
const projectIDForDirectory = (directory: string): string =>
  AgentGateway.DeepAgentDurableKnowledgeStore.projectIdForWorkspace(directory)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** @internal Exported for testing */
/** @internal Exported for testing */
export { buildStructuredOutputSystemPrompt, extractSchemaTopLevelFields }

export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export * as SessionPrompt from "./prompt"
