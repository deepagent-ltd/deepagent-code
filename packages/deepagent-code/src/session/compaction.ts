import { SessionV1 } from "@deepagent-code/core/v1/session"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { Log } from "@deepagent-code/core/util/log"
import { SessionProcessor, SummaryProtocolViolation } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@deepagent-code/core/database/database"
import { MessageTable, PartTable } from "@deepagent-code/core/session/sql"
import { PromptEpoch } from "./prompt-epoch"
import { CompactionRunTable, CompactionSummaryAttemptTable, type SummaryAttemptState } from "./compaction-sql"
import { eq, and, inArray } from "drizzle-orm"

import { Cause, Effect, Exit, Layer, Context, Option } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@deepagent-code/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { EventV2 } from "@deepagent-code/core/event"
import { buildPrompt } from "@deepagent-code/core/session/compaction"
import { updateLedgerFromSummary, carryOverToBridge } from "./context-ledger"
import { Hash } from "@deepagent-code/core/util/hash"
import { LLM } from "./llm"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: EventV2.define({
    type: "session.compacted",
    schema: {
      sessionID: SessionID,
    },
  }),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionCompaction") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const { db } = yield* Database.Service
    const promptEpoch = yield* PromptEpoch.Service

    const recover = Effect.fn("SessionCompaction.recover")(function* (sessionID: SessionID) {
      const requested = yield* db
        .select({
          run_id: CompactionRunTable.run_id,
          marker_message_id: CompactionRunTable.marker_message_id,
          marker_part_id: CompactionRunTable.marker_part_id,
        })
        .from(CompactionRunTable)
        .where(and(eq(CompactionRunTable.session_id, sessionID), eq(CompactionRunTable.state, "requested")))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(requested, (run) =>
        Effect.gen(function* () {
          const markerMessage = run.marker_message_id
            ? yield* db
                .select({ id: MessageTable.id })
                .from(MessageTable)
                .where(
                  and(
                    eq(MessageTable.id, MessageID.make(run.marker_message_id)),
                    eq(MessageTable.session_id, sessionID),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
            : undefined
          const markerPart =
            markerMessage && run.marker_part_id
              ? yield* db
                  .select({ data: PartTable.data })
                  .from(PartTable)
                  .where(
                    and(
                      eq(PartTable.id, PartID.make(run.marker_part_id)),
                      eq(PartTable.message_id, markerMessage.id),
                      eq(PartTable.session_id, sessionID),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
              : undefined
          if (markerPart?.data.type === "compaction") return
          yield* db
            .update(CompactionRunTable)
            .set({ state: "failed", terminal_failure_kind: "marker_write_incomplete" })
            .where(and(eq(CompactionRunTable.run_id, run.run_id), eq(CompactionRunTable.state, "requested")))
            .run()
            .pipe(Effect.orDie)
        }),
      )
      yield* db
        .update(CompactionSummaryAttemptTable)
        .set({ state: "indeterminate_after_crash", failure_kind: "process_restart", completed_at: Date.now() })
        .where(
          and(
            inArray(
              CompactionSummaryAttemptTable.run_id,
              db
                .select({ run_id: CompactionRunTable.run_id })
                .from(CompactionRunTable)
                .where(eq(CompactionRunTable.session_id, sessionID)),
            ),
            inArray(CompactionSummaryAttemptTable.state, ["dispatching", "streaming"] as const),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(CompactionRunTable)
        .set({ state: "indeterminate", terminal_failure_kind: "process_restart" })
        .where(and(eq(CompactionRunTable.session_id, sessionID), eq(CompactionRunTable.state, "summarizing")))
        .run()
        .pipe(Effect.orDie)
    })

    const ensureRun = Effect.fn("SessionCompaction.ensureRun")(function* (input: {
      sessionID: SessionID
      markerMessageID: MessageID
      markerPartID?: PartID
      fromEpoch: number
      trigger: "turn_start" | "provider_overflow" | "manual"
    }) {
      const existing = yield* db
        .select()
        .from(CompactionRunTable)
        .where(
          and(
            eq(CompactionRunTable.session_id, input.sessionID),
            inArray(CompactionRunTable.state, ["requested", "summarizing", "indeterminate"] as const),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        if (existing.marker_message_id !== input.markerMessageID) return undefined
        return existing
      }
      const row = {
        run_id: Hash.sha256(`compaction-run:${input.sessionID}:${input.markerMessageID}`),
        session_id: input.sessionID,
        from_prompt_epoch: input.fromEpoch,
        trigger: input.trigger,
        marker_message_id: input.markerMessageID,
        marker_part_id: input.markerPartID,
        state: "requested" as const,
        created_at: Date.now(),
      }
      yield* db.insert(CompactionRunTable).values(row).onConflictDoNothing().run().pipe(Effect.orDie)
      return yield* db
        .select()
        .from(CompactionRunTable)
        .where(eq(CompactionRunTable.run_id, row.run_id))
        .get()
        .pipe(Effect.orDie)
    })

    const updateAttempt = (input: {
      attemptID: string
      from: SummaryAttemptState[]
      to: SummaryAttemptState
      error?: unknown
    }) =>
      db
        .update(CompactionSummaryAttemptTable)
        .set({
          state: input.to,
          ...(input.error
            ? {
                failure_kind:
                  input.error instanceof SummaryProtocolViolation
                    ? `summary_protocol_${input.error.kind}`
                    : "provider_error",
              }
            : {}),
          ...(input.to === "dispatching" ? { dispatched_at: Date.now() } : {}),
          ...(input.to === "settled" || input.to === "failed" || input.to === "indeterminate_after_crash"
            ? { completed_at: Date.now() }
            : {}),
        })
        .where(
          and(
            eq(CompactionSummaryAttemptTable.summary_attempt_id, input.attemptID),
            inArray(CompactionSummaryAttemptTable.state, input.from),
          ),
        )
        .run()
        .pipe(Effect.orDie)

    const prepareAttempt = Effect.fn("SessionCompaction.prepareAttempt")(function* (input: {
      runID: string
      model: Provider.Model
      requestHash: string
      parentAttemptID?: string
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const run = yield* tx
                .select()
                .from(CompactionRunTable)
                .where(eq(CompactionRunTable.run_id, input.runID))
                .get()
              if (!run || (run.state !== "requested" && run.state !== "summarizing")) return undefined
              const count = yield* tx
                .select({ id: CompactionSummaryAttemptTable.summary_attempt_id })
                .from(CompactionSummaryAttemptTable)
                .where(eq(CompactionSummaryAttemptTable.run_id, input.runID))
                .all()
              if (count.length >= 2) return undefined
              const ordinal = count.length + 1
              const attemptID = Hash.sha256(`${input.runID}:summary-attempt:${ordinal}`)
              yield* tx
                .insert(CompactionSummaryAttemptTable)
                .values({
                  summary_attempt_id: attemptID,
                  run_id: input.runID,
                  ordinal,
                  parent_attempt_id: input.parentAttemptID,
                  provider_id: input.model.providerID,
                  model_id: input.model.id,
                  protocol: LLM.toolChoiceProtocol(input.model),
                  request_hash: input.requestHash,
                  idempotency_key: Hash.sha256(`${input.runID}:summary:${ordinal}`),
                  state: "prepared",
                  prepared_at: Date.now(),
                })
                .run()
              if (run.state === "requested") {
                const transitioned = yield* tx
                  .update(CompactionRunTable)
                  .set({ state: "summarizing" })
                  .where(and(eq(CompactionRunTable.run_id, input.runID), eq(CompactionRunTable.state, "requested")))
                  .returning({ run_id: CompactionRunTable.run_id })
                  .get()
                if (!transitioned) return yield* Effect.die(new Error(`compaction run transition lost: ${input.runID}`))
              }
              return {
                attemptId: attemptID,
                dispatching: updateAttempt({ attemptID, from: ["prepared"], to: "dispatching" }),
                streaming: updateAttempt({ attemptID, from: ["dispatching"], to: "streaming" }),
                settled: updateAttempt({ attemptID, from: ["dispatching", "streaming"], to: "settled" }),
                failed: (error: unknown) =>
                  updateAttempt({
                    attemptID,
                    from: ["prepared", "dispatching", "streaming"],
                    to: "failed",
                    error,
                  }),
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const failRun = (runID: string, kind: string) =>
      db
        .update(CompactionRunTable)
        .set({ state: "failed", terminal_failure_kind: kind })
        .where(
          and(
            eq(CompactionRunTable.run_id, runID),
            inArray(CompactionRunTable.state, ["requested", "summarizing"] as const),
          ),
        )
        .run()
        .pipe(Effect.orDie)

    const commitRun = Effect.fn("SessionCompaction.commitRun")(function* (input: {
      runID: string
      sessionID: SessionID
      fromEpoch: number
      checkpointUserID: MessageID
      checkpointAssistantID: MessageID
      retainedTailStartID?: MessageID
      sourceEndMessageID?: MessageID
      checkpointHash: string
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const settled = yield* tx
                .select({ id: CompactionSummaryAttemptTable.summary_attempt_id })
                .from(CompactionSummaryAttemptTable)
                .where(
                  and(
                    eq(CompactionSummaryAttemptTable.run_id, input.runID),
                    eq(CompactionSummaryAttemptTable.state, "settled"),
                  ),
                )
                .get()
              if (!settled) return false
              const epoch = yield* PromptEpoch.activateInTransaction(tx, input)
              if (!epoch) return false
              const committed = yield* tx
                .update(CompactionRunTable)
                .set({
                  state: "committed",
                  committed_summary_message_id: input.checkpointAssistantID,
                  checkpoint_hash: input.checkpointHash,
                  target_prompt_epoch: epoch.epoch,
                  committed_at: Date.now(),
                })
                .where(and(eq(CompactionRunTable.run_id, input.runID), eq(CompactionRunTable.state, "summarizing")))
                .returning({ run_id: CompactionRunTable.run_id })
                .get()
              if (!committed) return yield* Effect.die(new Error(`compaction commit CAS lost: ${input.runID}`))
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const existingCompactionPart = parent.parts.find(
        (part): part is SessionV1.CompactionPart => part.type === "compaction",
      )
      const compactionPart =
        existingCompactionPart ??
        ({
          id: PartID.ascending(),
          messageID: parent.info.id,
          sessionID: input.sessionID,
          type: "compaction",
          auto: input.auto,
          overflow: input.overflow,
        } satisfies SessionV1.CompactionPart)
      if (!existingCompactionPart) yield* session.updatePart(compactionPart)
      yield* recover(input.sessionID)
      const activeEpoch = yield* promptEpoch.bootstrap(input.sessionID)
      const run = yield* ensureRun({
        sessionID: input.sessionID,
        markerMessageID: input.parentID,
        markerPartID: compactionPart.id,
        fromEpoch: activeEpoch.epoch,
        trigger: input.overflow ? "provider_overflow" : input.auto ? "turn_start" : "manual",
      })
      if (!run || run.state === "indeterminate") return "stop"

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      // V4.0.1 P1 (§3.4/§3.5): narrow the summary to four buckets ONLY when worldStateReinjection is on —
      // it MUST be the same flag that gates re-injection, else "summary drops files, nothing re-injects"
      // opens an information hole. Flag OFF ⇒ legacy SUMMARY_TEMPLATE, byte-for-byte pre-V4.0.1.
      const nextPrompt =
        compacting.prompt ??
        buildPrompt({ previousSummary, context: compacting.context, narrow: flags.worldStateReinjection })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const tailIndex = selected.tail_start_id
        ? history.findIndex((message) => message.info.id === selected.tail_start_id)
        : -1
      const recent =
        tailIndex < 0
          ? ""
          : JSON.stringify(
              yield* MessageV2.toModelMessagesEffect(history.slice(tailIndex), model, {
                stripMedia: true,
                toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
              }),
            )
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)

      // BUG-006 §5.1: establish the explicit summary request contract.
      // toolChoice:"none" tells the adapter the model must produce text only.
      const summaryStreamInput = {
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        toolChoice: "none" as const,
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: nextPrompt }],
          },
        ],
        model,
      }

      let dispatchCount = 0
      let previousAttemptID: string | undefined
      let currentProcessor = yield* processors.create({ assistantMessage: msg, sessionID: input.sessionID, model })
      let result: "continue" | "compact" | "stop" = "stop"

      while (true) {
        dispatchCount++
        const attempt = yield* prepareAttempt({
          runID: run.run_id,
          model,
          requestHash: Hash.sha256(JSON.stringify(summaryStreamInput.messages)),
          parentAttemptID: previousAttemptID,
        })
        if (!attempt) {
          yield* failRun(run.run_id, "summary_attempt_budget_exhausted")
          return "stop"
        }
        const dispatchResult = yield* Effect.exit(currentProcessor.processSummary(summaryStreamInput, attempt))
        if (Exit.isSuccess(dispatchResult)) {
          result = dispatchResult.value
          if (result === "stop") {
            yield* failRun(run.run_id, "summary_provider_error")
            return "stop"
          }
          previousAttemptID = attempt.attemptId
          break
        }
        const failure = Option.getOrUndefined(Cause.findErrorOption(dispatchResult.cause))
        if (!(failure instanceof SummaryProtocolViolation)) {
          yield* failRun(run.run_id, "summary_provider_error")
          return "stop"
        }
        yield* session.updateMessage({
          ...currentProcessor.message,
          error: MessageV2.fromError(failure, { providerID: model.providerID }),
          finish: "error",
        })
        if (dispatchCount >= 2) {
          yield* failRun(run.run_id, `summary_protocol_${failure.kind}`)
          return "stop"
        }
        const retryMsg: SessionV1.Assistant = { ...msg, id: MessageID.ascending(), error: undefined, finish: undefined }
        yield* session.updateMessage(retryMsg)
        currentProcessor = yield* processors.create({ assistantMessage: retryMsg, sessionID: input.sessionID, model })
      }

      if (result === "compact") {
        currentProcessor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        currentProcessor.message.finish = "error"
        yield* session.updateMessage(currentProcessor.message)
        yield* failRun(run.run_id, "summary_context_overflow")
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (currentProcessor.message.error) {
        yield* failRun(run.run_id, "summary_provider_error")
        return "stop"
      }
      if (result === "continue") {
        const summary = summaryText(
          (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
            (item) => item.info.id === currentProcessor.message.id,
          ) ?? {
            info: msg,
            parts: [],
          },
        )
        if (flags.experimentalEventSystem) {
          if (summary)
            yield* events.publish(SessionEvent.Compaction.Ended, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.make(input.parentID),
              timestamp: DateTime.makeUnsafe(Date.now()),
              reason: input.auto ? "auto" : "manual",
              text: summary ?? "",
              recent,
            })
        }

        if (summary) {
          const committed = yield* commitRun({
            runID: run.run_id,
            sessionID: input.sessionID,
            fromEpoch: run.from_prompt_epoch,
            checkpointUserID: input.parentID,
            checkpointAssistantID: currentProcessor.message.id,
            checkpointHash: Hash.sha256(`${run.run_id}:${msg.id}:${summary.slice(0, 256)}`),
            retainedTailStartID: selected.tail_start_id as MessageID | undefined,
            sourceEndMessageID: selected.head.at(-1)?.info.id,
          })
          if (!committed) {
            yield* failRun(run.run_id, "compaction_commit_conflict")
            return "stop"
          }
        }

        // V3.8 App-A Stage 1 (coexist, gated, default-safe): mirror the compaction summary into the
        // structured Session Ledger. This does NOT change compaction behavior — it maintains the
        // ledger as a structured-summary candidate for the Stage 2 Curator. updateLedgerFromSummary
        // recovers the CAUSE internally and can never throw into this loop.
        if (flags.experimentalContextLedger && summary) {
          yield* updateLedgerFromSummary({ sessionID: input.sessionID, summary })
          // V3.8 App-A C3 (Stage 3): project the freshly-updated ledger into the project-level bridge
          // so a future session in this workspace opens with the cross-session handoff. Same gate as
          // the ledger mirror; carryOverToBridge recovers the CAUSE internally (never throws into this
          // loop). ctx.directory is this session's workspace dir (the project-store key).
          if (ctx.directory) {
            yield* carryOverToBridge({ sessionID: input.sessionID, workspacePath: ctx.directory })
          }
        }
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
      trigger?: "turn_start" | "provider_overflow" | "manual"
    }) {
      yield* recover(input.sessionID)
      // BUG-005: ensure Epoch 0 exists before the first compaction so PromptEpoch is always
      // the history authority even for sessions that were created before this migration.
      const activeEpoch = yield* promptEpoch.bootstrap(input.sessionID)

      const markerMessageID = MessageID.ascending()
      const markerPartID = PartID.ascending()
      const run = yield* ensureRun({
        sessionID: input.sessionID,
        markerMessageID,
        markerPartID,
        fromEpoch: activeEpoch.epoch,
        trigger: input.trigger ?? (input.overflow ? "provider_overflow" : input.auto ? "turn_start" : "manual"),
      })
      if (!run || run.state === "indeterminate") return

      const marker = yield* Effect.exit(
        Effect.gen(function* () {
          const msg = yield* session.updateMessage({
            id: markerMessageID,
            role: "user",
            model: input.model,
            sessionID: input.sessionID,
            agent: input.agent,
            time: { created: Date.now() },
          })
          yield* session.updatePart({
            id: markerPartID,
            messageID: msg.id,
            sessionID: msg.sessionID,
            type: "compaction",
            auto: input.auto,
            overflow: input.overflow,
          })
          return msg
        }),
      )
      if (Exit.isFailure(marker)) {
        yield* failRun(run.run_id, "marker_write_incomplete")
        return yield* Effect.failCause(marker.cause)
      }
      const msg = marker.value
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Compaction.Started, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.make(msg.id),
          timestamp: DateTime.makeUnsafe(Date.now()),
          reason: input.auto ? "auto" : "manual",
        })
      }
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(PromptEpoch.defaultLayer),
  ),
)

export * as SessionCompaction from "./compaction"
