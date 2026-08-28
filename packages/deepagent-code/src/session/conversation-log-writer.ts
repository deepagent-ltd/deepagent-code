import path from "node:path"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"
import { DeepAgentContext } from "@deepagent-code/core/deepagent/index"
import { SessionV1 } from "@deepagent-code/core/v1/session"

// V3.8 Appendix-A C2.5 (Stage 5) — the Conversation Log WRITE side. The read side (tool/query_log.ts)
// streams an append-only per-session jsonl archive; this module is the missing writer that the session
// loop drives so the log is actually populated (before this, query_log always returned "no entries").
//
// It records EVERYTHING that reaches a persisted message part: user/assistant text, full reasoning,
// and full (untruncated) tool call IO. It is deliberately best-effort and NON-THROWING — a write
// failure must never crash a turn (the ConversationLog constructor + appendFileSync throw
// synchronously, so callers wrap construction/record in Effect.matchCauseEffect, and each per-part
// append is additionally try/caught so one bad part cannot drop the rest).

const { ConversationLog } = DeepAgentContext

type LogEventType = DeepAgentContext.ConversationLog.LogEventType
type LogEntry = DeepAgentContext.ConversationLog.LogEntry

// The per-session log baseDir. MUST stay in sync with tool/query_log.ts `logFileFor`, which reads
// `ConversationLog.sessionLogFile(path.join(Global.Path.agent.data, "state"), sessionID)`. Both sides
// derive the file the same way so the writer appends exactly where the reader looks.
const logBaseDir = (): string => path.join(Global.Path.agent.data, "state")

export interface SessionLogWriter {
  readonly record: (msgs: readonly SessionV1.WithParts[]) => void
}

// A writer that silently drops everything — used when construction fails so the capability spins down
// (query_log stays empty) instead of crashing the session.
const NOOP: SessionLogWriter = { record: () => {} }

// Content-derived dedup key. It is NOT stored in the log (no artificial field pollutes the
// agent-facing query_log output); instead it is re-derivable from a persisted entry so the seen-set
// can be rebuilt on construction (cross-restart / re-entry) from the exact same identity the live path
// uses. text/reasoning key on (event|messageId|text); tool_call/result key on (event|messageId|callID)
// using the callID that is legitimately recorded in `data`.
const dedupKeyFor = (event: LogEventType, messageId: string | undefined, text: string | undefined, callID?: string) =>
  callID !== undefined ? `${event}|${messageId ?? ""}|${callID}` : `${event}|${messageId ?? ""}|${text ?? ""}`

const dedupKeyForEntry = (entry: LogEntry): string | undefined => {
  switch (entry.event) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return dedupKeyFor(entry.event, entry.messageId, entry.text)
    case "tool_call":
    case "tool_result": {
      const callID = typeof entry.data?.callID === "string" ? entry.data.callID : undefined
      return dedupKeyFor(entry.event, entry.messageId, entry.text, callID)
    }
    default:
      return undefined
  }
}

class Impl implements SessionLogWriter {
  private readonly log: DeepAgentContext.ConversationLog.ConversationLog
  private readonly seen = new Set<string>()

  constructor(sessionID: string) {
    const file = ConversationLog.sessionLogFile(logBaseDir(), sessionID)
    this.log = new ConversationLog.ConversationLog(file)
    // Rebuild the seen-set from what is already on disk so a restart / re-entry does not re-append
    // entries already logged (monotonic seq is separately recovered by the ConversationLog ctor).
    for (const entry of this.log.readAll()) {
      const key = dedupKeyForEntry(entry)
      if (key !== undefined) this.seen.add(key)
    }
  }

  private emit(
    event: LogEventType,
    payload: { messageId?: string; text?: string; data?: Record<string, unknown>; callID?: string },
  ): void {
    const key = dedupKeyFor(event, payload.messageId, payload.text, payload.callID)
    if (this.seen.has(key)) return
    this.log.append({
      event,
      ...(payload.messageId !== undefined ? { messageId: payload.messageId } : {}),
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      ...(payload.data !== undefined ? { data: payload.data } : {}),
    })
    this.seen.add(key)
  }

  record(msgs: readonly SessionV1.WithParts[]): void {
    for (const m of msgs) {
      const isUser = m.info.role === "user"
      // Only log FINAL content: user messages are complete on arrival; an assistant message may still
      // be streaming (partial text/reasoning), and since we dedup by content we must not capture a
      // partial body. Tool parts are additionally gated on `completed`.
      const complete = isUser || Boolean((m.info as { time?: { completed?: number } }).time?.completed)
      for (const part of m.parts) {
        try {
          if (part.type === "text") {
            if (part.synthetic || part.ignored || !complete) continue
            const text = part.text?.trim()
            if (!text) continue
            this.emit(isUser ? "user_message" : "assistant_message", { messageId: m.info.id, text })
          } else if (part.type === "reasoning") {
            if (!complete) continue
            const text = part.text?.trim()
            if (!text) continue
            this.emit("reasoning", { messageId: m.info.id, text })
          } else if (part.type === "tool") {
            // Record a tool part exactly once, only when it has completed with full IO available.
            if (part.state.status !== "completed") continue
            this.emit("tool_call", {
              messageId: m.info.id,
              callID: part.callID,
              data: { tool: part.tool, callID: part.callID, input: part.state.input },
            })
            this.emit("tool_result", {
              messageId: m.info.id,
              callID: part.callID,
              text: part.state.output,
              data: { tool: part.tool, callID: part.callID, metadata: part.state.metadata },
            })
          }
        } catch {
          // Per-part best-effort: a single malformed part must not stop the rest of the batch.
        }
      }
    }
  }
}

// Construct a writer for a session. Construction touches the filesystem (mkdir + read-to-recover-seq)
// and can throw synchronously, so we wrap in Effect.matchCauseEffect (NOT catch — a sync throw is a
// defect that catch would miss) and fall back to a no-op writer, keeping the turn alive.
export const make = (sessionID: string): Effect.Effect<SessionLogWriter> =>
  Effect.sync(() => new Impl(sessionID) as SessionLogWriter).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(NOOP),
      onSuccess: (writer) => Effect.succeed(writer),
    }),
  )

// Append a batch of messages, default-safe. appendFileSync can throw (EACCES/ENOSPC); recover any
// defect to a no-op so a log write never fails the session turn.
export const record = (writer: SessionLogWriter, msgs: readonly SessionV1.WithParts[]): Effect.Effect<void> =>
  Effect.sync(() => writer.record(msgs)).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Effect.void,
      onSuccess: () => Effect.void,
    }),
  )

export * as ConversationLogWriter from "./conversation-log-writer"
