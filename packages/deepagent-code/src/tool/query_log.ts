import { Effect, Schema } from "effect"
import path from "node:path"
import { Global } from "@deepagent-code/core/global"
import { DeepAgentContext } from "@deepagent-code/core/deepagent/index"
import * as Tool from "./tool"
import DESCRIPTION from "./query_log.txt"

// V3.8 Appendix-A C2.5 (Stage 5) — the query_log tool. The Conversation Log is the complete,
// append-only archive of EVERYTHING (messages incl. edited/withdrawn originals, full reasoning, full
// tool IO, system events). It is NOT sent to the model by default; this tool lets the agent "翻旧账"
// on demand — retrieve a slice by time / message id / keyword / event type — and the caller admits
// that small slice into the Working Set under budget. Reads are non-throwing (a missing log yields an
// empty result), so an agent querying a session with no log yet gets a clean "no entries" answer.

const { ConversationLog, ContextConfig } = DeepAgentContext

const config = ContextConfig.resolveContextConfig()

export const Parameters = Schema.Struct({
  keyword: Schema.optional(Schema.String).annotate({
    description: "Case-insensitive keyword to match against entry text or structured data.",
  }),
  messageId: Schema.optional(Schema.String).annotate({
    description: "Return only entries for this message id.",
  }),
  event: Schema.optional(
    Schema.Literals([
      "user_message",
      "assistant_message",
      "reasoning",
      "tool_call",
      "tool_result",
      "edited",
      "withdrawn",
      "compaction",
      "ledger_change",
      "model_switch",
      "fork",
      "revert",
      "bridge_handoff",
    ]),
  ).annotate({ description: "Filter by a single event type (e.g. 'reasoning' to recall past thinking)." }),
  since: Schema.optional(Schema.Number).annotate({ description: "Only entries at/after this epoch-ms timestamp." }),
  until: Schema.optional(Schema.Number).annotate({ description: "Only entries at/before this epoch-ms timestamp." }),
  limit: Schema.optional(Schema.Number).annotate({
    description: `Max entries to return, most-recent first (default ${config.queryLogDefaultLimit}, max ${config.queryLogMaxLimit}).`,
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

// The conventional per-session log location under the agent state dir. The write side (Stage 5
// wiring in the session loop) appends here; this tool reads it. Kept in one helper so both sides
// agree on the path.
const logFileFor = (sessionID: string): string =>
  ConversationLog.sessionLogFile(path.join(Global.Path.agent.data, "state"), sessionID)

export const QueryLogTool = Tool.define(
  "query_log",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "query_log", patterns: ["*"], always: ["*"], metadata: {} })

          const limit = Math.min(params.limit ?? config.queryLogDefaultLimit, config.queryLogMaxLimit)
          const file = logFileFor(ctx.sessionID)

          // Read is non-throwing (ConversationLog tolerates a missing/corrupt file). Wrap in
          // Effect.sync and recover any defect to an empty result so a log query never fails a turn.
          const entries = yield* Effect.sync(() => {
            const log = new ConversationLog.ConversationLog(file)
            return log.query({
              ...(params.since !== undefined ? { since: params.since } : {}),
              ...(params.until !== undefined ? { until: params.until } : {}),
              ...(params.messageId !== undefined ? { messageId: params.messageId } : {}),
              ...(params.event !== undefined ? { events: [params.event] } : {}),
              ...(params.keyword !== undefined ? { keyword: params.keyword } : {}),
              limit,
            })
          }).pipe(Effect.matchCauseEffect({
            onFailure: () => Effect.succeed([] as DeepAgentContext.ConversationLog.LogEntry[]),
            onSuccess: (e) => Effect.succeed(e),
          }))

          if (entries.length === 0) {
            return {
              title: "query_log",
              output: "No matching log entries.",
              metadata: { count: 0 },
            }
          }

          const lines = entries.map((e) => {
            const when = new Date(e.ts).toISOString()
            const head = `#${e.seq} [${when}] ${e.event}${e.messageId ? ` (${e.messageId})` : ""}`
            const text = e.text ? `\n  ${e.text.replace(/\n/g, "\n  ")}` : ""
            const data = e.data ? `\n  data: ${JSON.stringify(e.data)}` : ""
            return head + text + data
          })

          return {
            title: `query_log (${entries.length})`,
            output: [`<log_entries count="${entries.length}">`, ...lines, "</log_entries>"].join("\n"),
            metadata: { count: entries.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
