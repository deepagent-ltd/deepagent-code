import * as Tool from "./tool"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { and, desc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { SessionID } from "@/session/schema"

const id = "task_read"

const DESCRIPTION = [
  "Read the transcript of a subagent task you dispatched via the task tool.",
  "Parameters: task_id (the session ID from task_status output), limit (default 20, max 100), before (message ID cursor for pagination).",
  "Returns up to `limit` messages from the subagent's conversation, newest-first.",
  "Also returns the durable structured, validated-text, or raw result in a separate task_result block when available.",
  "Use this to recover partial work when a subagent was interrupted or failed to produce structured output.",
  "IMPORTANT: Only reads sessions you directly spawned (child sessions of the current session).",
  "Never returns hidden reasoning content.",
].join(" ")

const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The subagent session ID (from task_status output)" }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max messages to return (default 20, max 100)",
  }),
  before: Schema.optional(Schema.String).annotate({
    description: "Message ID cursor for pagination (from the 'before' hint in a previous call)",
  }),
})

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20
const MAX_RESULT_CHARS = 80_000

/** Render a single tool part into the transcript. */
function renderToolPart(part: SessionV1.ToolPart): string {
  const state = part.state.status
  const name = part.tool ?? "unknown"
  if (state === "running" || state === "pending") {
    return `  <tool name="${name}" state="${state}"/>`
  }
  if (state === "error") {
    const err = part.state.error ?? "error"
    return `  <tool name="${name}" state="error">${truncate(String(err), 200)}</tool>`
  }
  if (state === "completed") {
    const output = part.state.output ?? part.state.metadata?.output ?? ""
    return `  <tool name="${name}" state="completed">${truncate(String(output), 400)}</tool>`
  }
  return `  <tool name="${name}" state="${state}"/>`
}

function renderTextPart(part: SessionV1.TextPart): string | undefined {
  // Skip synthetic parts (system injections) and ignored parts from the transcript.
  if (part.synthetic || part.ignored) return undefined
  const text = part.text?.trim()
  if (!text) return undefined
  return `  <text>${truncate(text, 600)}</text>`
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + "…"
}

function durableResultText(message: SessionV1.WithParts | undefined) {
  if (!message) return undefined
  if (message.info.role === "assistant" && message.info.structured !== undefined) {
    return JSON.stringify(message.info.structured)
  }
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join("\n")
    .trim()
  return text || undefined
}

/**
 * §4.5: task_read — parent-session-constrained child transcript reader.
 *
 * Security boundary: ONLY reads sessions whose parentID equals the calling session's ID.
 * This prevents using a known session ID to read arbitrary other sessions.
 */
export const TaskReadTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const childSessionID = params.task_id as SessionID
      const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)

      // §4.5 security boundary: verify the requested session is a direct child of the calling session.
      const child = yield* sessions
        .get(childSessionID)
        .pipe(Effect.catchCause(() => Effect.fail(new Error(`task_read: session not found: ${params.task_id}`))))
      if (child.parentID !== ctx.sessionID) {
        return yield* Effect.fail(
          new Error(
            `task_read: session ${params.task_id} is not a direct subagent of the current session. ` +
              `Only direct subagent sessions may be read.`,
          ),
        )
      }

      // Session owns the database binding; using its page API avoids reading from an unrelated
      // ambient Database service when this tool is composed into a larger runtime Layer.
      const result = yield* sessions
        .messagesPage({
          sessionID: childSessionID,
          limit,
          before: params.before,
        })
        .pipe(
          Effect.catchCause(() =>
            Effect.succeed({
              items: [] as SessionV1.WithParts[],
              more: false,
              cursor: undefined as string | undefined,
            }),
          ),
        )
      const page = result.items
      const nextCursor: string | undefined = result.cursor
      // A cursor is the only valid continuation token. Never advertise another page when a
      // storage implementation reports `more` without one: callers would resend `undefined`
      // and restart from the newest messages.
      const hasMore = result.more && nextCursor !== undefined

      const latestRun = yield* database.db
        .select({
          state: TaskRunTable.state,
          generation: TaskRunTable.generation,
          output: TaskRunTable.output,
          rawResultMessageID: TaskRunTable.raw_result_message_id,
          structuredResultMessageID: TaskRunTable.structured_result_message_id,
        })
        .from(TaskRunTable)
        .where(
          and(eq(TaskRunTable.child_session_id, childSessionID), eq(TaskRunTable.parent_session_id, ctx.sessionID)),
        )
        .orderBy(desc(TaskRunTable.generation))
        .get()
        .pipe(Effect.orDie)

      const resultMessageID = latestRun?.structuredResultMessageID ?? latestRun?.rawResultMessageID
      const resultMessage = resultMessageID
        ? yield* MessageV2.get({ sessionID: childSessionID, messageID: resultMessageID }).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
          )
        : undefined
      const durableResult = durableResultText(resultMessage) ?? latestRun?.output?.trim() ?? ""
      const boundedResult = Array.from(durableResult).slice(0, MAX_RESULT_CHARS).join("")
      const resultTruncated = boundedResult.length < durableResult.length
      const resultSource = latestRun?.structuredResultMessageID
        ? resultMessage?.info.role === "assistant" && resultMessage.info.structured !== undefined
          ? "structured"
          : "validated_text"
        : latestRun?.rawResultMessageID
          ? "raw"
          : latestRun?.output
            ? "task_run"
            : undefined

      // Read durable state from task_run; metadata is only a legacy fallback.
      const deepagent = child.metadata?.["deepagent"] as Record<string, unknown> | undefined
      const subagent = deepagent?.["subagent"] as Record<string, unknown> | undefined
      const durableState = latestRun
        ? latestRun.state
        : subagent
          ? ((subagent["state"] as string | undefined) ?? (subagent["finished"] === true ? "completed" : "unknown"))
          : "running"

      // Format transcript lines.
      const lines: string[] = []
      for (const msg of page) {
        const role = msg.info.role
        if (role === "user") {
          const textParts = msg.parts
            .filter((p): p is SessionV1.TextPart => p.type === "text" && !p.synthetic && !p.ignored)
            .map((p) => p.text?.trim())
            .filter(Boolean)
          if (textParts.length > 0) {
            lines.push(`<message role="user">${truncate(textParts.join(" "), 600)}</message>`)
          }
        } else if (role === "assistant") {
          for (const part of msg.parts) {
            if (part.type === "text") {
              const rendered = renderTextPart(part)
              if (rendered) lines.push(`<message role="assistant">${truncate(part.text?.trim() ?? "", 600)}</message>`)
            } else if (part.type === "tool") {
              lines.push(renderToolPart(part))
            }
          }
          // Mark interrupted/error assistant messages.
          const msgInfo = msg.info
          if (msgInfo.role === "assistant" && msgInfo.error) {
            const name = msgInfo.error.name ?? "error"
            const data = msgInfo.error.data
            const msg_text =
              name === "StructuredOutputError" && data
                ? `StructuredOutput failed after ${(data as Record<string, unknown>)["retries"] ?? "?"} attempt(s)`
                : String(name)
            lines.push(`  <interruption>${truncate(msg_text, 200)}</interruption>`)
          }
        }
      }

      // Pagination hint at the end.
      const moreHint = hasMore && nextCursor ? ` more="true" before="${nextCursor}"` : ""
      const transcript = [
        `<task_transcript id="${childSessionID}" state="${durableState}"${moreHint}>`,
        ...lines.map((l) => `  ${l}`),
        `</task_transcript>`,
      ].join("\n")
      const resultBlock = boundedResult
        ? [
            `<task_result source="${resultSource ?? "unknown"}"${resultMessageID ? ` message_id="${resultMessageID}"` : ""}${resultTruncated ? ` truncated="true"` : ""}>`,
            boundedResult,
            `</task_result>`,
          ].join("\n")
        : ""

      // Pagination instruction when truncated.
      const paginationHint =
        hasMore && nextCursor
          ? `\n[Truncated. Older messages available. Call task_read({ task_id: "${childSessionID}", before: "${nextCursor}" }) for the previous page.]`
          : ""
      const recoveryHint =
        durableState === "recovery_required"
          ? `\n[Recovery resolution required for generation ${latestRun?.generation ?? "?"}. The old run cannot continue. After explicit user approval, call task_recovery with resolution "failed" or "closed"; to continue afterward, invoke task with the same task_id.]`
          : ""

      return {
        title: `Task transcript: ${child.title ?? childSessionID}`,
        metadata: {
          sessionID: childSessionID,
          state: durableState,
          messageCount: page.length,
          hasMore,
          ...(resultSource ? { resultSource } : {}),
          ...(resultMessageID ? { resultMessageID } : {}),
          ...(boundedResult ? { resultTruncated } : {}),
          ...(nextCursor !== undefined ? { before: nextCursor } : {}),
        },
        output: [resultBlock, transcript].filter(Boolean).join("\n") + paginationHint + recoveryHint,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(
          Effect.catchCause((cause) => Effect.die(cause)),
        ) as unknown as Effect.Effect<Tool.ExecuteResult>,
    }
  }),
)
