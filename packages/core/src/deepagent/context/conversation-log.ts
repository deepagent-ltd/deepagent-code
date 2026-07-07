import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"

// V3.8 Appendix-A C2.5 (Stage 5) — the Conversation Log: the complete, time-ordered, append-only,
// IMMUTABLE archive. Orthogonal to Working Set (curated per-turn context) and Ledger (structured
// authoritative state). The Log records EVERYTHING, including material that never reaches the model:
//  - user/assistant text, INCLUDING pre-edit originals and withdrawn messages (as edited/withdrawn
//    events — append, never overwrite),
//  - reasoning/thinking FULL TEXT (even though C1 excludes it from the Working Set — "代入上下文=否,
//    留档=是"),
//  - tool call input/output (full, untruncated — truncation only happens in the Working Set),
//  - system events: compaction, ledger changes, model/mode switch, fork, revert, bridge handoff.
//
// It is append-only jsonl (one JSON object per line). It is NOT sent to the model by default (does not
// dilute attention); an agent pulls slices on demand via the query_log tool (see tool/query_log.ts),
// which then admits a small slice into the Working Set under budget. Disk reclaim (C4) targets the
// model window, NOT this cold archive.

export type LogEventType =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "edited" // a prior message was edited; payload keeps the original + new text
  | "withdrawn" // a prior message was withdrawn/deleted
  | "compaction"
  | "ledger_change"
  | "model_switch"
  | "fork"
  | "revert"
  | "bridge_handoff"

export type LogEntry = {
  readonly seq: number
  readonly ts: number
  readonly event: LogEventType
  readonly messageId?: string
  readonly text?: string
  // Free-form structured payload (tool args, edited-from text, event details). Kept full — never
  // truncated in the Log.
  readonly data?: Readonly<Record<string, unknown>>
}

export type LogQuery = {
  // Inclusive time range (epoch ms).
  readonly since?: number
  readonly until?: number
  // Filter by message id.
  readonly messageId?: string
  // Filter by event type(s).
  readonly events?: readonly LogEventType[]
  // Case-insensitive keyword; matches text OR stringified data.
  readonly keyword?: string
  // Cap results (most-recent first). Caller clamps to config.queryLogMaxLimit.
  readonly limit?: number
}

// An append-only conversation log backed by a jsonl file. Construction is cheap (no read); appends
// are line-appends; queries stream the file. All methods are synchronous and NON-THROWING for reads
// (a corrupt/missing file yields []) so a log read can never crash a turn; appends surface IO errors
// to the caller (which should wrap best-effort).
export class ConversationLog {
  private seq = 0

  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    // Recover the next seq from the existing file (max seq + 1) so appends stay monotonic across
    // process restarts. Read-only; tolerant of a partially-written last line.
    this.seq = this.readAll().reduce((m, e) => Math.max(m, e.seq), 0)
  }

  // Append an entry. Assigns a monotonic seq + ts if not supplied. Returns the stored entry.
  append(entry: Omit<LogEntry, "seq" | "ts"> & { ts?: number }): LogEntry {
    const stored: LogEntry = { seq: ++this.seq, ts: entry.ts ?? Date.now(), event: entry.event }
    const full: LogEntry = {
      ...stored,
      ...(entry.messageId !== undefined ? { messageId: entry.messageId } : {}),
      ...(entry.text !== undefined ? { text: entry.text } : {}),
      ...(entry.data !== undefined ? { data: entry.data } : {}),
    }
    appendFileSync(this.file, JSON.stringify(full) + "\n")
    return full
  }

  // Read the whole log (tolerant of a corrupt trailing line). Empty when the file is missing.
  readAll(): LogEntry[] {
    if (!existsSync(this.file)) return []
    let content: string
    try {
      content = readFileSync(this.file, "utf8")
    } catch {
      return []
    }
    const out: LogEntry[] = []
    for (const line of content.split("\n")) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as LogEntry)
      } catch {
        // Skip a partially-written / corrupt line rather than throwing (immutable archive; a bad
        // tail line must not poison reads).
      }
    }
    return out
  }

  // Query the log. Filters by time/messageId/events/keyword, returns most-recent-first, capped.
  query(q: LogQuery): LogEntry[] {
    const events = q.events ? new Set(q.events) : null
    const kw = q.keyword?.toLowerCase()
    const matches = this.readAll().filter((e) => {
      if (q.since !== undefined && e.ts < q.since) return false
      if (q.until !== undefined && e.ts > q.until) return false
      if (q.messageId !== undefined && e.messageId !== q.messageId) return false
      if (events && !events.has(e.event)) return false
      if (kw) {
        const hay = `${e.text ?? ""} ${e.data ? JSON.stringify(e.data) : ""}`.toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    })
    matches.sort((a, b) => b.seq - a.seq)
    return q.limit !== undefined ? matches.slice(0, q.limit) : matches
  }
}

// Default log location for a session (run-scoped, alongside the ledger). Callers that already have a
// SessionPaths/RunPaths can pass any path; this is the convention when they don't.
export const sessionLogFile = (root: string, sessionId: string): string =>
  path.join(root, "conversation-log", `${sessionId}.jsonl`)
