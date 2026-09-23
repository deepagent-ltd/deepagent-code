export * as TaskReadTool from "./task-read"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { and, desc, eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import type { SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { V2StructuredOutputEvidenceTable } from "../session/runner/v2-structured-output-evidence.sql"
import { SessionSchema } from "../session/schema"
import { TaskRunTable } from "../session/sql"
import { tolerantNumber } from "../schema"
import { Delegation } from "./delegation"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "task_read"

const DESCRIPTION = [
  "Read the transcript of a subagent task you dispatched via the task tool.",
  "Parameters: task_id (the session ID from task_status output), limit (default 20, max 100), before (message ID cursor for pagination).",
  "Returns up to `limit` messages from the subagent's conversation, newest-first.",
  "Also returns the durable structured, validated-text, or raw result in a separate task_result block when available.",
  "Use this to recover partial work when a subagent was interrupted or failed to produce structured output.",
  "IMPORTANT: Only reads sessions you directly spawned (child sessions of the current session).",
  "Never returns hidden reasoning content.",
].join(" ")

export const Input = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The subagent session ID (from task_status output)" }),
  // Tolerant number arm (F-1): GLM-class providers send stringified numbers; a malformed or
  // "null" string rejects at the schema instead of poisoning the Math.min clamp with NaN.
  limit: Schema.optional(tolerantNumber()).annotate({
    description: "Max messages to return (default 20, max 100)",
  }),
  before: Schema.optional(Schema.String).annotate({
    description: "Message ID cursor for pagination (from the 'before' hint in a previous call)",
  }),
})

const Output = Schema.Struct({
  output: Schema.String,
  state: Schema.String,
  messageCount: Schema.Number,
  hasMore: Schema.Boolean,
  resultSource: Schema.optional(Schema.String),
  resultTruncated: Schema.optional(Schema.Boolean),
  before: Schema.optional(Schema.String),
})

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20
const MAX_RESULT_CHARS = 80_000

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + "…"
}

/** Render a single V2 assistant tool part into the transcript. */
function renderToolPart(part: SessionMessage.AssistantTool): string {
  const state = part.state.status
  if (state === "running" || state === "pending") {
    return `  <tool name="${part.name}" state="${state}"/>`
  }
  if (state === "error") {
    return `  <tool name="${part.name}" state="error">${truncate(part.state.error.message, 200)}</tool>`
  }
  const text = part.state.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
  return `  <tool name="${part.name}" state="completed">${truncate(text, 400)}</tool>`
}

/**
 * What the transcript skips (WS4b-S1 port note): V1 hid system injections via a per-part
 * `synthetic`/`ignored` flag. V2 instead projects those notices as standalone `synthetic` and
 * `system` MESSAGES, and V2 assistant text parts carry no synthetic flag — so the faithful
 * equivalent of the legacy skip is dropping the synthetic/system message types. Those notices
 * (interruption/context updates) are user-visible in the child's own view, but the parent already
 * gets the same facts from the run state and the <interruption> marker; rendering them again here
 * would double-report. Reasoning parts stay hidden ("Never returns hidden reasoning content").
 * shell/compaction/agent_switched/model_switched have no legacy rendering and stay skipped.
 */
function renderMessage(msg: SessionMessage.Message): string[] {
  if (msg.type === "user") {
    const text = msg.text.trim()
    return text ? [`<message role="user">${truncate(text, 600)}</message>`] : []
  }
  if (msg.type !== "assistant") return []
  const lines: string[] = []
  for (const part of msg.content) {
    if (part.type === "text") {
      const text = part.text.trim()
      if (text) lines.push(`<message role="assistant">${truncate(text, 600)}</message>`)
      continue
    }
    if (part.type === "tool") lines.push(renderToolPart(part))
  }
  if (msg.error) lines.push(`  <interruption>${truncate(msg.error.message, 200)}</interruption>`)
  return lines
}

function durableResultText(message: SessionMessage.Message | undefined) {
  if (!message) return undefined
  if (message.type === "assistant" && message.structured !== undefined) return JSON.stringify(message.structured)
  if (message.type !== "assistant") return undefined
  const text = message.content
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  return text || undefined
}

const requireSessions = Effect.gen(function* () {
  const slot = Option.getOrUndefined(yield* Effect.serviceOption(Delegation.DelegationSlot))
  if (!slot?.service)
    return yield* new ToolFailure({
      message: "task_read is unavailable: the root composition did not capture the V2 session service for delegation",
    })
  return slot.service
})

/**
 * WS4b-S1 port of the legacy task_read: parent-session-constrained child transcript reader.
 * Security boundary: ONLY reads sessions whose parentID equals the calling session's ID — a known
 * session ID cannot read arbitrary other sessions.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [toolText({ type: "text", text: output.output })],
          execute: (input, context) =>
            Effect.gen(function* () {
              const sessions: SessionV2.Interface = yield* requireSessions
              const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
              if (!database)
                return yield* new ToolFailure({
                  message: "task_read is unavailable: the database service is missing from the runner context",
                })
              const db = database.db
              const childSessionID = Option.getOrUndefined(
                Schema.decodeUnknownOption(SessionSchema.ID)(input.task_id),
              )
              if (!childSessionID)
                return yield* new ToolFailure({ message: `task_read: session not found: ${input.task_id}` })
              const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)

              // Security boundary: the requested session must be a direct child of the caller.
              const child = yield* sessions.get(childSessionID).pipe(
                Effect.mapError(() => new ToolFailure({ message: `task_read: session not found: ${input.task_id}` })),
              )
              if (String(child.parentID ?? "") !== String(context.sessionID))
                return yield* new ToolFailure({
                  message:
                    `task_read: session ${input.task_id} is not a direct subagent of the current session. ` +
                    "Only direct subagent sessions may be read.",
                })

              // Newest-first page; fetch one extra row to detect the next page honestly. A cursor
              // is the only valid continuation token — never advertise another page without one.
              const page = yield* sessions
                .messages({
                  sessionID: childSessionID,
                  limit: limit + 1,
                  order: "desc",
                  ...(input.before === undefined
                    ? {}
                    : { cursor: { id: SessionMessage.ID.make(input.before), direction: "next" as const } }),
                })
                .pipe(Effect.orDie)
              const items = page.slice(0, limit)
              const nextCursor = page.length > limit ? items.at(-1)?.id : undefined
              const hasMore = nextCursor !== undefined

              const latestRun = yield* db
                .select({
                  run_id: TaskRunTable.run_id,
                  state: TaskRunTable.state,
                  generation: TaskRunTable.generation,
                  output: TaskRunTable.output,
                  rawResultMessageID: TaskRunTable.raw_result_message_id,
                })
                .from(TaskRunTable)
                .where(
                  and(
                    eq(TaskRunTable.child_session_id, childSessionID),
                    eq(TaskRunTable.parent_session_id, context.sessionID),
                  ),
                )
                .orderBy(desc(TaskRunTable.generation))
                .get()
                .pipe(Effect.orDie)

              // The V2 structured-evidence authority binds the validated verdict message; only a
              // validated row is result evidence (unvalidated/validation_failed rows fall through
              // to the raw settle binding).
              const evidence = latestRun
                ? yield* db
                    .select({
                      output_message_id: V2StructuredOutputEvidenceTable.output_message_id,
                      validation_outcome: V2StructuredOutputEvidenceTable.validation_outcome,
                    })
                    .from(V2StructuredOutputEvidenceTable)
                    .where(eq(V2StructuredOutputEvidenceTable.run_id, latestRun.run_id))
                    .get()
                    .pipe(Effect.orDie)
                : undefined
              const evidenceMessageID =
                evidence?.validation_outcome === "validated" ? (evidence.output_message_id ?? undefined) : undefined

              const resultMessageID = evidenceMessageID ?? latestRun?.rawResultMessageID ?? undefined
              const resultMessage = resultMessageID
                ? yield* sessions
                    .message({ sessionID: childSessionID, messageID: SessionMessage.ID.make(resultMessageID) })
                    .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
                : undefined
              const durableResult = durableResultText(resultMessage) ?? latestRun?.output?.trim() ?? ""
              const boundedResult = Array.from(durableResult).slice(0, MAX_RESULT_CHARS).join("")
              const resultTruncated = boundedResult.length < durableResult.length
              const resultSource =
                evidenceMessageID !== undefined
                  ? resultMessage?.type === "assistant" && resultMessage.structured !== undefined
                    ? "structured"
                    : "validated_text"
                  : latestRun?.rawResultMessageID
                    ? "raw"
                    : latestRun?.output
                      ? "task_run"
                      : undefined

              // Durable state from the task_run row; a run-less child reads as running (legacy
              // metadata fallback does not exist for V2 sessions).
              const durableState = latestRun?.state ?? "running"

              const lines = items.flatMap(renderMessage)

              const moreHint = hasMore ? ` more="true" before="${nextCursor}"` : ""
              const transcript = [
                `<task_transcript id="${childSessionID}" state="${durableState}"${moreHint}>`,
                ...lines.map((line) => `  ${line}`),
                `</task_transcript>`,
              ].join("\n")
              const resultBlock = boundedResult
                ? [
                    `<task_result source="${resultSource ?? "unknown"}"${resultMessageID ? ` message_id="${resultMessageID}"` : ""}${resultTruncated ? ` truncated="true"` : ""}>`,
                    boundedResult,
                    `</task_result>`,
                  ].join("\n")
                : ""

              const paginationHint = hasMore
                ? `\n[Truncated. Older messages available. Call task_read({ task_id: "${childSessionID}", before: "${nextCursor}" }) for the previous page.]`
                : ""
              const recoveryHint =
                durableState === "recovery_required"
                  ? `\n[Recovery resolution required for generation ${latestRun?.generation ?? "?"}. The old run cannot continue. After explicit user approval, call task_recovery with resolution "failed" or "closed"; to continue afterward, invoke task with the same task_id.]`
                  : ""

              return {
                output: [resultBlock, transcript].filter(Boolean).join("\n") + paginationHint + recoveryHint,
                state: durableState,
                messageCount: items.length,
                hasMore,
                ...(resultSource === undefined ? {} : { resultSource }),
                ...(boundedResult ? { resultTruncated } : {}),
                ...(nextCursor === undefined ? {} : { before: nextCursor }),
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
