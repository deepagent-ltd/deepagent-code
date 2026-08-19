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
import {
  MessageTable,
  PartTable,
  SessionHistoryStateTable,
  SessionTable,
  SessionWorldStateBaselineTable,
} from "@deepagent-code/core/session/sql"
import { PromptEpoch } from "./prompt-epoch"
import {
  CompactionArtifactTable,
  CompactionRunTable,
  CompactionSummaryAttemptTable,
  type SummaryAttemptState,
} from "./compaction-sql"
import { eq, and, inArray, isNull } from "drizzle-orm"

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
import { buildPrompt, TOOL_OUTPUT_MAX_CHARS } from "@deepagent-code/core/session/compaction"
import {
  updateLedgerFromSummaryRequired,
  carryOverToBridgeRequired,
  collectSessionWorldStateBaseline,
  type SessionWorldStateBaseline,
} from "./context-ledger"
import { Hash } from "@deepagent-code/core/util/hash"
import { LLM } from "./llm"
import { HistoryAuthority } from "./history-authority"
import { Identifier } from "@/id/id"
import { Project } from "@deepagent-code/core/project"
import { SessionPromptEpochTable } from "./prompt-epoch.sql"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: EventV2.define({
    type: "session.compacted",
    sync: { aggregate: "sessionID", version: 1 },
    schema: {
      sessionID: SessionID,
    },
  }),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
// UPD-005 (micro-compact, safe subset): the protect window used when the soft-landing fallback
// phase triggers an early prune. Smaller than PRUNE_PROTECT so the fallback phase truncates MORE
// of the older (white-list-excluded) tool results in place, buying headroom before the hard line.
// Never wired into the hard phase — hard keeps PRUNE_PROTECT semantics unchanged.
export const MICRO_COMPACT_PROTECT = 10_000
// UPD-005: TOOL_OUTPUT_MAX_CHARS is defined once in core (packages/core/src/session/compaction.ts)
// and imported above — do NOT re-introduce a local copy here.
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000

// =============================================================================
// UPD-005 (structured compaction summary, claude-code parity, safe subset).
// =============================================================================
// DETERMINISM CONTRACT: the template constants and the pure helpers below
// (stripSummaryAnalysis / selectPostCompactFileCandidates) are pure functions —
// same input, same output. The durable summary-attempt requestHash covers the
// rendered prompt, so the template MUST stay a module-level constant.
//
// Scope: the structured nine-section template replaces the legacy anchored
// summary ONLY on the worldStateReinjection=false compatibility path. With
// worldStateReinjection=true the V4.0.1 four-bucket NARROW template stays
// byte-for-byte unchanged — its responsibility separation (files / env /
// diagnostics are World State re-injected at their LATEST value, never
// summarized) is an information-hole invariant (§3.4/§3.5).
//
// The model drafts inside an <analysis> scratchpad first; stripSummaryAnalysis
// removes that scratchpad and unwraps the <summary> envelope BEFORE the text
// reaches any durable or projected surface. The text-only / no-tools protocol
// (toolChoice:"none" + SummaryProtocolViolation enforcement) is unchanged.
export const STRUCTURED_SUMMARY_TEMPLATE = `Your task is to create a detailed, structured summary of the conversation history above, paying close attention to the user's explicit requests and your previous actions. This summary must capture enough technical detail — decisions, code patterns, file context, and error history — for the work to continue without losing context.

Respond with TEXT ONLY. Do not call any tools. Your entire response must be an <analysis> block followed by a <summary> block.

Before writing the final summary, wrap your drafting analysis in <analysis> tags to organize your thoughts and verify coverage. In the analysis:
1. Walk the conversation chronologically and identify the user's explicit requests, your approach, key decisions, technical concepts, file names, code snippets, errors and their fixes, and any user feedback — especially feedback that changed your direction.
2. Note every security-relevant instruction or constraint the user stated (sensitive files or data to avoid, forbidden operations, credential/secret handling rules). These MUST be preserved VERBATIM in the final summary so they keep applying after compaction.
3. Double-check technical accuracy and completeness. The <analysis> block is discarded after compaction — only the <summary> block survives.

Inside <summary>, output exactly these nine numbered sections in this order:

1. Primary Request and Intent: all of the user's explicit requests and intents, in detail.
2. Key Technical Concepts: important concepts, technologies, and frameworks discussed.
3. Files and Code Sections: files examined, modified, or created — why each matters, what changed, and important code snippets verbatim.
4. Errors and Fixes: every error encountered and how it was fixed, including corrective user feedback.
5. Problem Solving: problems solved and ongoing troubleshooting.
6. All User Messages: every genuine user message (user-role turns only, never tool results or quoted assistant text), with security-relevant instructions preserved verbatim.
7. Pending Tasks: tasks explicitly requested but not yet complete.
8. Current Work: precisely what was in progress immediately before this summary request, with file names and code snippets where applicable.
9. Next Steps: the next action, only when directly in line with the user's most recent explicit request; include a verbatim quote showing where the work left off. Write "(none)" if the last task concluded.

Rules:
- Keep every section, using "(none)" when a section is empty.
- Preserve exact file paths, commands, error strings, identifiers, and user-designated durable facts verbatim.
- Never attribute assistant-generated text to the user.
- Do not mention the summary process or that context was compacted.

<example>
<analysis>
[Drafting scratchpad: chronological coverage check]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]

3. Files and Code Sections:
   - [File path]
     - Why it matters / changes made
     - [Important code snippet]

4. Errors and Fixes:
   - [Error and the fix applied]

5. Problem Solving:
   - [Solved problems and ongoing troubleshooting]

6. All User Messages:
   - [User message content]

7. Pending Tasks:
   - [Task]

8. Current Work:
   - [Precise description]

9. Next Steps:
   - [Next step or "(none)"]
</summary>
</example>`

// Mirrors the core buildPrompt composition (packages/core/src/session/compaction.ts)
// with the structured template swapped in. Keep the preamble wording in sync with
// the core builder — the anchored-summary update contract depends on it.
export const buildStructuredSummaryPrompt = (input: {
  readonly previousSummary?: string
  readonly context: readonly string[]
}) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    STRUCTURED_SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

// Post-processing: strip the <analysis> drafting scratchpad and unwrap the
// <summary> envelope. Pure and conservative — text without any <analysis> /
// <summary> marker is returned byte-for-byte unchanged (legacy summaries and
// NARROW outputs are untouched).
export const stripSummaryAnalysis = (text: string): string => {
  if (!/<\/?(?:analysis|summary)>/.test(text)) return text
  let out = text.replace(/<analysis>[\s\S]*?<\/analysis>/g, "")
  out = out.replace(/<summary>([\s\S]*?)<\/summary>/g, (_match, content: string) => `Summary:\n${content.trim()}`)
  out = out.replace(/\n{3,}/g, "\n\n")
  return out.trim()
}

// UPD-005 (post-compact re-injection hook, conservative version): claude-code
// re-injects the most recently read files after compaction
// (POST_COMPACT_MAX_FILES_TO_RESTORE = 5). The committed-history chain here has
// NO injection point yet, so this module only SELECTS candidates — a pure
// function of the compacted messages (same input ⇒ same output) — recorded for
// future wiring. Never adds an injection path.
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_MAX_CHARS_PER_FILE = 20_000
const POST_COMPACT_READ_TOOLS = new Set(["read"])

export type PostCompactFileCandidate = {
  readonly filePath: string
  readonly tool: string
  readonly messageID: MessageID
}

// Scans backwards (most recent read wins), deduplicates by path, caps at
// POST_COMPACT_MAX_FILES_TO_RESTORE. Only completed reads count; a pending /
// errored read does not prove the file content ever entered context.
export const selectPostCompactFileCandidates = (
  messages: readonly SessionV1.WithParts[],
): readonly PostCompactFileCandidate[] => {
  const seen = new Set<string>()
  const candidates: PostCompactFileCandidate[] = []
  for (let index = messages.length - 1; index >= 0 && candidates.length < POST_COMPACT_MAX_FILES_TO_RESTORE; index--) {
    const message = messages[index]
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      if (candidates.length >= POST_COMPACT_MAX_FILES_TO_RESTORE) break
      const part = message.parts[partIndex]
      if (part.type !== "tool" || part.state.status !== "completed") continue
      if (!POST_COMPACT_READ_TOOLS.has(part.tool)) continue
      const input: unknown = part.state.input
      let filePath: string | undefined
      if (typeof input === "object" && input !== null) {
        const value = (input as Record<string, unknown>).filePath
        if (typeof value === "string" && value.length > 0) filePath = value
      }
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      candidates.push({ filePath, tool: part.tool, messageID: message.info.id })
    }
  }
  return candidates
}
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

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID; protect?: number }) => Effect.Effect<void>
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
    activityID?: string
  }) => Effect.Effect<void>
  readonly recover: (sessionID: SessionID) => Effect.Effect<void>
  readonly recoverableContinuations: (projectID: Project.ID) => Effect.Effect<
    readonly {
      runID: string
      sessionID: SessionID
      messageID: MessageID
    }[]
  >
  readonly hasPending: (sessionID: SessionID) => Effect.Effect<boolean>
}

export const validateReplacementTargetInTransaction = Effect.fn(
  "SessionCompaction.validateReplacementTargetInTransaction",
)(function* (input: {
  tx: Database.Interface["db"]
  sessionID: SessionID
  replacementMessageIDs: readonly MessageID[]
  checkpointUserID: MessageID
  checkpointAssistantID: MessageID
  markerMessageID: MessageID
  markerPartID: PartID
  retainedTailStartID?: MessageID
  contextTokens: number
  checkpointHash: string
  effectiveHistoryHash: string
}) {
  const replacement = yield* MessageV2.messagesInTransaction(input.tx, input.sessionID, input.replacementMessageIDs)
  if (!replacement) return false
  const checkpointUser = replacement.find((message) => message.info.id === input.checkpointUserID)
  const checkpointAssistant = replacement.find((message) => message.info.id === input.checkpointAssistantID)
  if (
    checkpointUser?.info.role !== "user" ||
    checkpointAssistant?.info.role !== "assistant" ||
    checkpointAssistant.info.parentID !== checkpointUser.info.id ||
    !checkpointAssistant.info.summary ||
    !checkpointAssistant.info.finish ||
    checkpointAssistant.info.error
  )
    return false
  const target = replacement.map((message) => {
    if (message.info.id !== input.markerMessageID) return message
    const markerPart = message.parts.find(
      (part): part is SessionV1.CompactionPart => part.id === input.markerPartID && part.type === "compaction",
    )
    if (!markerPart) return message
    return {
      info: message.info,
      parts: message.parts.map((part) =>
        part.id === markerPart.id
          ? {
              ...markerPart,
              tail_start_id: input.retainedTailStartID,
              context_tokens: input.contextTokens,
            }
          : part,
      ),
    }
  })
  return (
    target.some((message) => message.parts.some((part) => part.id === input.markerPartID)) &&
    HistoryAuthority.hash(target) === input.effectiveHistoryHash &&
    input.checkpointHash === input.effectiveHistoryHash
  )
})

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
    const activeCompactions = new Set<SessionID>()

    const registerArtifact = (input: {
      runID: string
      sessionID: SessionID
      messageID: MessageID
      partID?: PartID
      kind: typeof CompactionArtifactTable.$inferInsert.kind
    }) =>
      db
        .insert(CompactionArtifactTable)
        .values({
          artifact_id: Hash.sha256(
            `compaction-artifact:v1:${input.runID}:${input.kind}:${input.messageID}:${input.partID ?? "message"}`,
          ),
          run_id: input.runID,
          session_id: input.sessionID,
          message_id: input.messageID,
          part_id: input.partID ?? null,
          kind: input.kind,
          state: "pending",
          created_at: Date.now(),
          committed_at: null,
          published_at: null,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

    const publishCommittedRun = Effect.fn("SessionCompaction.publishCommittedRun")(function* (runID: string) {
      const run = yield* db
        .select()
        .from(CompactionRunTable)
        .where(eq(CompactionRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      if (!run || run.state !== "committed") return

      const artifacts = yield* db
        .select()
        .from(CompactionArtifactTable)
        // Older builds may have committed replay artifacts. They remain publishable for recovery,
        // but current compaction runs only create synthetic continuation artifacts.
        .where(
          and(
            eq(CompactionArtifactTable.run_id, runID),
            eq(CompactionArtifactTable.state, "committed"),
            inArray(CompactionArtifactTable.kind, ["marker", "replay", "continue"] as const),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      for (const artifact of artifacts) {
        if (artifact.published_at) continue
        const message = yield* MessageV2.get({
          sessionID: SessionID.make(run.session_id),
          messageID: MessageID.make(artifact.message_id),
        }).pipe(Effect.provideService(Database.Service, { db }), Effect.orDie)
        const parts = message.parts.filter((part) => !artifact.part_id || artifact.part_id === part.id)
        if (artifact.kind === "replay" || artifact.kind === "continue") {
          const messageEventID = EventV2.ID.make(
            `evt_${Hash.sha256(`compaction-artifact-event:v1:${runID}:message:${message.info.id}`).slice(0, 26)}`,
          )
          yield* events.publish(
            SessionV1.Event.MessageUpdated,
            { sessionID: message.info.sessionID, info: message.info },
            {
              id: messageEventID,
              idempotent: true,
              ...(parts.length === 0
                ? {
                    commit: () =>
                      db
                        .update(CompactionArtifactTable)
                        .set({ published_at: Date.now() })
                        .where(
                          and(
                            eq(CompactionArtifactTable.artifact_id, artifact.artifact_id),
                            isNull(CompactionArtifactTable.published_at),
                          ),
                        )
                        .run()
                        .pipe(Effect.orDie, Effect.asVoid),
                  }
                : {}),
            },
          )
        }
        for (const [index, part] of parts.entries()) {
          const partEventID = EventV2.ID.make(
            `evt_${Hash.sha256(`compaction-artifact-event:v1:${runID}:part:${part.id}`).slice(0, 26)}`,
          )
          yield* events.publish(
            SessionV1.Event.PartUpdated,
            {
              sessionID: part.sessionID,
              part,
              time: part.type === "text" ? (part.time?.start ?? message.info.time.created) : message.info.time.created,
            },
            {
              id: partEventID,
              idempotent: true,
              ...(index === parts.length - 1
                ? {
                    commit: () =>
                      db
                        .update(CompactionArtifactTable)
                        .set({ published_at: Date.now() })
                        .where(
                          and(
                            eq(CompactionArtifactTable.artifact_id, artifact.artifact_id),
                            isNull(CompactionArtifactTable.published_at),
                          ),
                        )
                        .run()
                        .pipe(Effect.orDie, Effect.asVoid),
                  }
                : {}),
            },
          )
        }
        if (artifact.kind === "marker" && parts.length === 0)
          return yield* Effect.die(new Error(`compaction marker artifact is incomplete: ${artifact.artifact_id}`))
      }
      yield* db
        .update(CompactionRunTable)
        .set({ continuation_published_at: Date.now() })
        .where(eq(CompactionRunTable.run_id, runID))
        .run()
        .pipe(Effect.orDie)

      if (run.context_ledger_required && run.summary_text) {
        if (!run.ledger_mirrored_at) {
          yield* updateLedgerFromSummaryRequired({
            sessionID: SessionID.make(run.session_id),
            summary: run.summary_text,
            operationID: run.run_id,
          })
          yield* db
            .update(CompactionRunTable)
            .set({ ledger_mirrored_at: Date.now() })
            .where(and(eq(CompactionRunTable.run_id, runID), isNull(CompactionRunTable.ledger_mirrored_at)))
            .run()
            .pipe(Effect.orDie)
        }
        if (!run.bridge_carried_at) {
          const owner = yield* db
            .select({ directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionID.make(run.session_id)))
            .get()
            .pipe(Effect.orDie)
          if (!owner) return yield* Effect.die(new Error(`compaction session is missing: ${run.session_id}`))
          yield* carryOverToBridgeRequired({
            sessionID: SessionID.make(run.session_id),
            workspacePath: owner.directory,
          })
          yield* db
            .update(CompactionRunTable)
            .set({ bridge_carried_at: Date.now() })
            .where(and(eq(CompactionRunTable.run_id, runID), isNull(CompactionRunTable.bridge_carried_at)))
            .run()
            .pipe(Effect.orDie)
        }
      }

      if (!run.terminal_events_published_at && run.summary_text && run.marker_message_id && run.completion_reason) {
        if (flags.experimentalEventSystem) {
          const endedID = EventV2.ID.make(`evt_${Hash.sha256(`compaction-ended:v1:${runID}`).slice(0, 26)}`)
          yield* events.publish(
            SessionEvent.Compaction.Ended,
            {
              sessionID: SessionID.make(run.session_id),
              messageID: SessionMessage.ID.make(run.marker_message_id),
              timestamp: DateTime.makeUnsafe(run.committed_at ?? Date.now()),
              reason: run.completion_reason,
              text: run.summary_text,
              recent: run.recent_context ?? "",
            },
            { id: endedID, idempotent: true },
          )
        }
        const compactedID = EventV2.ID.make(`evt_${Hash.sha256(`compaction-completed:v1:${runID}`).slice(0, 26)}`)
        yield* events.publish(
          Event.Compacted,
          { sessionID: SessionID.make(run.session_id) },
          {
            id: compactedID,
            idempotent: true,
            commit: () =>
              db
                .update(CompactionRunTable)
                .set({ terminal_events_published_at: Date.now() })
                .where(
                  and(eq(CompactionRunTable.run_id, runID), isNull(CompactionRunTable.terminal_events_published_at)),
                )
                .run()
                .pipe(Effect.orDie, Effect.asVoid),
          },
        )
      }
    })

    const recover = Effect.fn("SessionCompaction.recover")(function* (sessionID: SessionID) {
      const committed = yield* db
        .select({ run_id: CompactionRunTable.run_id })
        .from(CompactionRunTable)
        .where(and(eq(CompactionRunTable.session_id, sessionID), eq(CompactionRunTable.state, "committed")))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(committed, (run) => publishCommittedRun(run.run_id), { discard: true })
      if (activeCompactions.has(sessionID)) return
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
          yield* failRun(run.run_id, "marker_write_incomplete")
        }),
      )
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const sessionRuns = tx
                .select({ run_id: CompactionRunTable.run_id })
                .from(CompactionRunTable)
                .where(eq(CompactionRunTable.session_id, sessionID))
              yield* tx
                .update(CompactionSummaryAttemptTable)
                .set({
                  state: "indeterminate_after_crash",
                  failure_kind: "process_restart",
                  completed_at: Date.now(),
                })
                .where(
                  and(
                    inArray(CompactionSummaryAttemptTable.run_id, sessionRuns),
                    inArray(CompactionSummaryAttemptTable.state, ["dispatching", "streaming"] as const),
                  ),
                )
                .run()
              yield* tx
                .update(CompactionRunTable)
                .set({ state: "indeterminate", terminal_failure_kind: "process_restart" })
                .where(and(eq(CompactionRunTable.session_id, sessionID), eq(CompactionRunTable.state, "summarizing")))
                .run()
              yield* tx
                .update(CompactionArtifactTable)
                .set({ state: "orphaned" })
                .where(
                  and(
                    eq(CompactionArtifactTable.session_id, sessionID),
                    eq(CompactionArtifactTable.state, "pending"),
                    inArray(
                      CompactionArtifactTable.run_id,
                      tx
                        .select({ run_id: CompactionRunTable.run_id })
                        .from(CompactionRunTable)
                        .where(
                          and(
                            eq(CompactionRunTable.session_id, sessionID),
                            inArray(CompactionRunTable.state, ["failed", "indeterminate"] as const),
                          ),
                        ),
                    ),
                  ),
                )
                .run()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const ensureRun = Effect.fn("SessionCompaction.ensureRun")(function* (input: {
      sessionID: SessionID
      markerMessageID: MessageID
      markerPartID?: PartID
      fromEpoch: number
      trigger: "turn_start" | "provider_overflow" | "manual"
      sourceWindowID: string
      sourceEffectiveHistoryHash: string
      sourceMessageCount: number
      sourceProjectionVersion: number
    }) {
      const existing = yield* db
        .select()
        .from(CompactionRunTable)
        .where(
          and(
            eq(CompactionRunTable.session_id, input.sessionID),
            inArray(CompactionRunTable.state, ["requested", "summarizing"] as const),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        if (existing.marker_message_id !== input.markerMessageID) return undefined
        if (
          existing.from_prompt_epoch !== input.fromEpoch ||
          existing.source_window_id !== input.sourceWindowID ||
          existing.source_effective_history_hash !== input.sourceEffectiveHistoryHash ||
          existing.source_message_count !== input.sourceMessageCount ||
          existing.source_projection_version !== input.sourceProjectionVersion
        )
          return undefined
        return existing
      }
      const row = {
        run_id: Hash.sha256(
          `compaction-run:v2:${input.sessionID}:${input.markerMessageID}:${Identifier.ascending("job")}`,
        ),
        session_id: input.sessionID,
        from_prompt_epoch: input.fromEpoch,
        trigger: input.trigger,
        marker_message_id: input.markerMessageID,
        marker_part_id: input.markerPartID,
        source_window_id: input.sourceWindowID,
        source_effective_history_hash: input.sourceEffectiveHistoryHash,
        source_message_count: input.sourceMessageCount,
        source_projection_version: input.sourceProjectionVersion,
        context_ledger_required: flags.experimentalContextLedger,
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

    const failRun = (runID: string, kind: string, recoverySessionID?: SessionID) =>
      db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(CompactionRunTable)
                .set({ state: "failed", terminal_failure_kind: kind })
                .where(
                  and(
                    eq(CompactionRunTable.run_id, runID),
                    inArray(CompactionRunTable.state, ["requested", "summarizing"] as const),
                  ),
                )
                .run()
              yield* tx
                .update(CompactionArtifactTable)
                .set({ state: "orphaned" })
                .where(and(eq(CompactionArtifactTable.run_id, runID), eq(CompactionArtifactTable.state, "pending")))
                .run()
              if (recoverySessionID) {
                const now = Date.now()
                const reason = `compaction ${runID} failed with ${kind}; deterministic history recovery is required`
                yield* tx
                  .update(SessionPromptEpochTable)
                  .set({ authority_state: "recovery_required", recovery_reason: reason })
                  .where(
                    and(
                      eq(SessionPromptEpochTable.session_id, recoverySessionID),
                      eq(SessionPromptEpochTable.state, "active"),
                    ),
                  )
                  .run()
                yield* tx
                  .insert(SessionHistoryStateTable)
                  .values({
                    session_id: recoverySessionID,
                    state: "recovery_required",
                    reason,
                    time_created: now,
                    time_updated: now,
                  })
                  .onConflictDoUpdate({
                    target: SessionHistoryStateTable.session_id,
                    set: { state: "recovery_required", reason, time_updated: now },
                  })
                  .run()
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)

    const commitRun = Effect.fn("SessionCompaction.commitRun")(function* (input: {
      runID: string
      sessionID: SessionID
      fromEpoch: number
      markerMessageID: MessageID
      markerPartID: PartID
      checkpointUserID: MessageID
      checkpointAssistantID: MessageID
      retainedTailStartID?: MessageID
      sourceEndMessageID?: MessageID
      checkpointHash: string
      baseMessageCount: number
      effectiveHistoryHash: string
      replacementMessageIDs: readonly MessageID[]
      contextTokens: number
      summary: string
      recent: string
      reason: "auto" | "manual"
      worldStateBaseline: SessionWorldStateBaseline
      continuation?: {
        readonly message: SessionV1.WithParts
        readonly kind: "continue"
      }
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
              if (!run || run.state !== "summarizing") return false
              const currentSource = yield* MessageV2.promptHistoryProjectionInTransaction(
                tx as unknown as Database.Interface["db"],
                input.sessionID,
                input.markerMessageID,
              )
              if (
                !currentSource ||
                currentSource.epoch !== run.from_prompt_epoch ||
                currentSource.window.windowID !== run.source_window_id ||
                currentSource.effectiveHistoryHash !== run.source_effective_history_hash ||
                currentSource.messages.length !== run.source_message_count ||
                currentSource.projectionVersion !== run.source_projection_version
              )
                return false
              // The summary/checkpoint is assembled outside this transaction because it may require
              // provider and filesystem work. Re-hydrate and hash the durable target under the commit
              // lock so a concurrent Part mutation cannot legalize a stale PromptEpoch.
              if (
                !(yield* validateReplacementTargetInTransaction({
                  tx: tx as unknown as Database.Interface["db"],
                  ...input,
                }))
              )
                return false
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
              const epoch = yield* PromptEpoch.activateInTransaction(tx, {
                ...input,
                worldStateBaselineHash: input.worldStateBaseline.hash,
              })
              if (!epoch) return false
              yield* tx
                .insert(SessionWorldStateBaselineTable)
                .values(
                  input.worldStateBaseline.sections.map((section) => ({
                    session_id: input.sessionID,
                    prompt_epoch: epoch.epoch,
                    section_id: section.sectionID,
                    snapshot: section.snapshot,
                    fragment: section.fragment,
                    fragment_hash: section.fragmentHash,
                    provenance: "native" as const,
                    created_at: epoch.created_at,
                  })),
                )
                .run()
              const marker = yield* tx
                .select({ data: PartTable.data })
                .from(PartTable)
                .where(
                  and(
                    eq(PartTable.id, input.markerPartID),
                    eq(PartTable.message_id, input.markerMessageID),
                    eq(PartTable.session_id, input.sessionID),
                  ),
                )
                .get()
              if (!marker || marker.data.type !== "compaction") {
                return yield* Effect.die(new Error(`compaction marker missing during commit: ${input.runID}`))
              }
              yield* tx
                .update(PartTable)
                .set({
                  data: {
                    ...marker.data,
                    tail_start_id: input.retainedTailStartID,
                    context_tokens: input.contextTokens,
                  } as typeof PartTable.$inferInsert.data,
                  provenance: {
                    source: "compaction_marker",
                    owner_session_id: input.sessionID,
                    owner_prompt_epoch: epoch.epoch,
                    owner_run_id: input.runID,
                    durable: true,
                  },
                })
                .where(eq(PartTable.id, input.markerPartID))
                .run()
              const committed = yield* tx
                .update(CompactionRunTable)
                .set({
                  state: "committed",
                  committed_summary_message_id: input.checkpointAssistantID,
                  checkpoint_hash: input.checkpointHash,
                  target_prompt_epoch: epoch.epoch,
                  summary_text: input.summary,
                  recent_context: input.recent,
                  completion_reason: input.reason,
                  committed_at: Date.now(),
                  continuation_state: input.continuation ? "pending" : null,
                })
                .where(and(eq(CompactionRunTable.run_id, input.runID), eq(CompactionRunTable.state, "summarizing")))
                .returning({ run_id: CompactionRunTable.run_id })
                .get()
              if (!committed) return yield* Effect.die(new Error(`compaction commit CAS lost: ${input.runID}`))
              const continuation = input.continuation
              if (continuation) {
                const committedAt = Date.now()
                yield* tx
                  .insert(MessageTable)
                  .values({
                    id: continuation.message.info.id,
                    session_id: continuation.message.info.sessionID,
                    time_created: continuation.message.info.time.created,
                    time_updated: continuation.message.info.time.created,
                    data: Object.fromEntries(
                      Object.entries(MessageV2.stripActivityProgress(continuation.message.info)).filter(
                        ([key]) => key !== "id" && key !== "sessionID",
                      ),
                    ) as typeof MessageTable.$inferInsert.data,
                  })
                  .run()
                yield* tx
                  .insert(PartTable)
                  .values(
                    continuation.message.parts.map((part) => ({
                      id: part.id,
                      message_id: continuation.message.info.id,
                      session_id: continuation.message.info.sessionID,
                      provenance: {
                        source: "compaction_continue" as const,
                        owner_session_id: input.sessionID,
                        owner_prompt_epoch: epoch.epoch,
                        owner_run_id: input.runID,
                        durable: true as const,
                      },
                      time_created: continuation.message.info.time.created,
                      time_updated: continuation.message.info.time.created,
                      data: Object.fromEntries(
                        Object.entries(part).filter(
                          ([key]) => key !== "id" && key !== "messageID" && key !== "sessionID",
                        ),
                      ) as typeof PartTable.$inferInsert.data,
                    })),
                  )
                  .run()
                yield* tx
                  .insert(CompactionArtifactTable)
                  .values({
                    artifact_id: Hash.sha256(
                      `compaction-artifact:v1:${input.runID}:${continuation.kind}:${continuation.message.info.id}:message`,
                    ),
                    run_id: input.runID,
                    session_id: continuation.message.info.sessionID,
                    message_id: continuation.message.info.id,
                    part_id: null,
                    kind: continuation.kind,
                    state: "committed",
                    created_at: committedAt,
                    committed_at: committedAt,
                    published_at: null,
                  })
                  .run()
              }
              yield* tx
                .update(CompactionArtifactTable)
                .set({ state: "committed", committed_at: Date.now() })
                .where(
                  and(eq(CompactionArtifactTable.run_id, input.runID), eq(CompactionArtifactTable.state, "pending")),
                )
                .run()
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
        if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are `protect` tokens worth of tool
    // calls, then erases output of older tool calls to free context space.
    // UPD-005: `protect` is parameterized (default PRUNE_PROTECT = pre-existing behavior) so the
    // soft-landing fallback phase can run a micro-compact with a smaller window. DETERMINISM
    // CONTRACT: the truncated set is a pure function of (messages, protect, PRUNE_MINIMUM) — the
    // scan is strictly backwards, Token.estimate is pure, and only `Date.now()` (the persisted
    // time.compacted stamp) varies between runs without ever changing WHICH parts get truncated.
    // The durable summary-attempt requestHash is computed over the compacted projection, so any
    // non-determinism here would desync compaction replays. Idempotency: parts already stamped
    // with time.compacted break the scan, so a repeated prune never double-truncates.
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: {
      sessionID: SessionID
      protect?: number
    }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      const protect = input.protect ?? PRUNE_PROTECT
      log.info("pruning", { protect })

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
          if (total <= protect) continue
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

    const processCompactionAttempt = Effect.fn("SessionCompaction.processAttempt")(function* (input: {
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
      const existingCompactionPart = parent.parts.find(
        (part): part is SessionV1.CompactionPart => part.type === "compaction",
      )
      const projection = yield* (
        existingCompactionPart
          ? MessageV2.promptHistoryBeforeCompactionEffect({
              sessionID: input.sessionID,
              markerMessageID: input.parentID,
            })
          : MessageV2.promptHistoryProjectionEffect(input.sessionID)
      ).pipe(Effect.provideService(Database.Service, { db }), Effect.orDie)
      const activeEpoch = yield* promptEpoch.getActive(input.sessionID)
      if (!activeEpoch || activeEpoch.authority_state !== "ready" || activeEpoch.epoch !== projection.epoch) {
        return yield* Effect.die(new Error(`compaction history authority is unavailable for ${input.sessionID}`))
      }
      const userMessage = parent.info
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
      const authorityInput = existingCompactionPart
        ? input.messages.flatMap((message) => {
            if (message.info.id !== input.parentID) return [message]
            const parts = message.parts.filter((part) => part.type !== "compaction")
            return parts.length === 0 ? [] : [{ info: message.info, parts }]
          })
        : input.messages
      if (HistoryAuthority.hash(authorityInput) !== projection.effectiveHistoryHash) {
        return yield* Effect.die(new Error(`compaction input does not match active history for ${input.sessionID}`))
      }
      const run = yield* ensureRun({
        sessionID: input.sessionID,
        markerMessageID: input.parentID,
        markerPartID: compactionPart.id,
        fromEpoch: activeEpoch.epoch,
        trigger: input.overflow ? "provider_overflow" : input.auto ? "turn_start" : "manual",
        sourceWindowID: projection.window.windowID,
        sourceEffectiveHistoryHash: projection.effectiveHistoryHash,
        sourceMessageCount: projection.messages.length,
        sourceProjectionVersion: projection.projectionVersion,
      })
      if (!run) return "stop"
      if (existingCompactionPart) {
        yield* registerArtifact({
          runID: run.run_id,
          sessionID: input.sessionID,
          messageID: input.parentID,
          partID: compactionPart.id,
          kind: "marker",
        })
      }
      if (!existingCompactionPart) {
        yield* events.publish(
          SessionV1.Event.PartUpdated,
          { sessionID: compactionPart.sessionID, part: compactionPart, time: Date.now() },
          {
            commit: () =>
              registerArtifact({
                runID: run.run_id,
                sessionID: input.sessionID,
                messageID: input.parentID,
                partID: compactionPart.id,
                kind: "marker",
              }),
          },
        )
      }

      // Compaction is a history projection boundary, not a second user submission.
      // Keep the original history for summarization and use the synthetic continuation below when
      // the provider overflow was caused by media. This avoids durable `compaction_replay` user
      // messages, which are indistinguishable from a real repeated prompt in the UI and history.
      const messages = input.messages

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
      // opens an information hole. Flag OFF ⇒ UPD-005 structured nine-section template (the pre-UPD-005
      // legacy SUMMARY_TEMPLATE lived in core buildPrompt; the structured template supersedes it on this
      // compatibility path only). Flag ON ⇒ NARROW template, byte-for-byte unchanged.
      const nextPrompt =
        compacting.prompt ??
        (flags.worldStateReinjection
          ? buildPrompt({ previousSummary, context: compacting.context, narrow: true })
          : buildStructuredSummaryPrompt({ previousSummary, context: compacting.context }))
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
      yield* events.publish(
        SessionV1.Event.MessageUpdated,
        { sessionID: input.sessionID, info: msg },
        {
          commit: () =>
            registerArtifact({
              runID: run.run_id,
              sessionID: input.sessionID,
              messageID: msg.id,
              kind: "summary_attempt",
            }),
        },
      )

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
      let result: SessionProcessor.ProcessorDecision = {
        action: "stop",
        reason: { code: "assistant_error", errorName: "CompactionNotStarted" },
      }

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
          if (result.action === "stop") {
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
        yield* events.publish(
          SessionV1.Event.MessageUpdated,
          { sessionID: input.sessionID, info: retryMsg },
          {
            commit: () =>
              registerArtifact({
                runID: run.run_id,
                sessionID: input.sessionID,
                messageID: retryMsg.id,
                kind: "summary_attempt",
              }),
          },
        )
        currentProcessor = yield* processors.create({ assistantMessage: retryMsg, sessionID: input.sessionID, model })
      }

      if (result.action === "compact") {
        currentProcessor.message.error = new SessionV1.ContextOverflowError({
          message: "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        currentProcessor.message.finish = "error"
        yield* session.updateMessage(currentProcessor.message)
        yield* failRun(run.run_id, "summary_context_overflow", input.sessionID)
        return "stop"
      }

      const continuation = yield* Effect.gen(function* () {
        if (result.action !== "continue" || !input.auto) return
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
          const continueMsg: SessionV1.User = {
            id: MessageID.make(
              `${currentProcessor.message.id}_continue_${Hash.sha256(`compaction-continue:v2:${run.run_id}`).slice(0, 12)}`,
            ),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: userMessage.agent,
            model: userMessage.model,
            metadata: SessionProcessor.withPlanProtocolActivity(
              {
                deepagent: {
                  contextProvenance: {
                    source: "compaction_continue",
                    ownerSessionID: input.sessionID,
                    ownerPromptEpoch: activeEpoch.epoch + 1,
                    ownerRunID: run.run_id,
                    durable: true,
                  },
                },
              },
              SessionProcessor.planProtocolActivityID(userMessage.metadata) ?? userMessage.id,
            ),
          }
          const text =
            (input.overflow
              ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
              : "") +
            "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
          const continueMessage: SessionV1.WithParts = {
            info: continueMsg,
            parts: [
              {
                id: PartID.make(`prt_${Hash.sha256(`compaction-continue-part:v1:${run.run_id}`).slice(0, 26)}`),
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
              },
            ],
          }
          return { message: continueMessage, kind: "continue" as const }
        }
      })

      if (currentProcessor.message.error) {
        yield* failRun(run.run_id, "summary_provider_error")
        return "stop"
      }
      if (result.action === "continue") {
        const persisted = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
        const checkpointIndex = persisted.findIndex((item) => item.info.id === currentProcessor.message.id)
        let checkpoint = persisted[checkpointIndex] ?? {
          info: msg,
          parts: [],
        }
        // UPD-005: strip the <analysis> drafting scratchpad before the summary enters ANY durable or
        // projected surface. The persisted text parts are rewritten FIRST so HistoryAuthority hashes,
        // the commit validation (which re-hydrates from the DB), and the post-compaction projection all
        // see the stripped text. stripSummaryAnalysis is a pure function and returns tag-free input
        // byte-for-byte unchanged, so pre-UPD-005 summaries are unaffected.
        const rawSummary = summaryText(checkpoint)
        const summary = rawSummary ? stripSummaryAnalysis(rawSummary) : undefined
        if (!summary) {
          yield* failRun(run.run_id, "summary_text_missing")
          return "stop"
        }
        if (summary !== rawSummary) {
          const textParts = checkpoint.parts.filter((part): part is SessionV1.TextPart => part.type === "text")
          const strippedParts = checkpoint.parts.map((part) => {
            if (part.type !== "text") return part
            return part.id === textParts[0]?.id ? { ...part, text: summary } : { ...part, text: "" }
          })
          for (const part of strippedParts) {
            if (part.type !== "text") continue
            const original = checkpoint.parts.find((item): item is SessionV1.TextPart => item.id === part.id)
            if (original && original.text === part.text) continue
            yield* session.updatePart(part)
          }
          checkpoint = { info: checkpoint.info, parts: strippedParts }
        }
        if (summary) {
          const contextModel = yield* provider
            .getModel(userMessage.model.providerID, userMessage.model.modelID)
            .pipe(Effect.orDie)
          const baselineExit = yield* Effect.exit(collectSessionWorldStateBaseline({ workspacePath: ctx.directory }))
          if (Exit.isFailure(baselineExit)) {
            yield* failRun(run.run_id, "world_state_baseline_failed")
            return "stop"
          }
          const worldStateBaseline = baselineExit.value
          const replacementParent = {
            info: parent.info,
            parts: [
              ...parent.parts.filter((part) => part.type !== "compaction"),
              { ...compactionPart, tail_start_id: selected.tail_start_id },
            ],
          }
          const projected = yield* MessageV2.toModelMessagesEffect(
            MessageV2.appendPromptWorldState({
              messages: [
                replacementParent,
                checkpoint,
                ...(tailIndex < 0 ? [] : history.slice(tailIndex)),
                ...(checkpointIndex < 0 ? [] : persisted.slice(checkpointIndex + 1)),
                ...(continuation ? [continuation.message] : []),
              ],
              sessionID: input.sessionID,
              epoch: activeEpoch.epoch + 1,
              baselineHash: worldStateBaseline.hash,
              rendered: worldStateBaseline.rendered,
              agent: userMessage.agent,
              model: userMessage.model,
            }),
            contextModel,
          )
          const estimated = Token.estimate(JSON.stringify(projected))
          const estimatedSummary = Token.estimate(summary)
          const reportedSummary = currentProcessor.message.tokens.output
          const contextTokens = Math.max(
            0,
            estimated - estimatedSummary + (reportedSummary > 0 ? reportedSummary : estimatedSummary),
          )
          const replacement = [
            {
              info: replacementParent.info,
              parts: [
                ...replacementParent.parts.filter((part) => part.type !== "compaction"),
                {
                  ...compactionPart,
                  tail_start_id: selected.tail_start_id,
                  context_tokens: contextTokens,
                },
              ],
            },
            checkpoint,
            ...(tailIndex < 0 ? [] : history.slice(tailIndex)),
          ]
          const effectiveHistoryHash = HistoryAuthority.hash(replacement)
          const committed = yield* commitRun({
            runID: run.run_id,
            sessionID: input.sessionID,
            fromEpoch: run.from_prompt_epoch,
            markerMessageID: input.parentID,
            markerPartID: compactionPart.id,
            checkpointUserID: input.parentID,
            checkpointAssistantID: currentProcessor.message.id,
            checkpointHash: effectiveHistoryHash,
            baseMessageCount: replacement.length,
            effectiveHistoryHash,
            replacementMessageIDs: replacement.map((message) => message.info.id),
            retainedTailStartID: selected.tail_start_id as MessageID | undefined,
            sourceEndMessageID: currentProcessor.message.id,
            contextTokens,
            summary,
            recent,
            reason: input.auto ? "auto" : "manual",
            worldStateBaseline,
            continuation,
          })
          if (!committed) {
            yield* failRun(run.run_id, "compaction_commit_conflict")
            return "stop"
          }
          // UPD-005 (post-compact re-injection hook, conservative version): record the candidate list of
          // recently-read files from the compacted head ONLY. There is no injection point in the committed
          // chain yet, so nothing is re-injected here. Persisting the list on compaction_run would require
          // a core-owned schema migration (out of scope) — recorded as a report item for future wiring.
          const postCompactCandidates = selectPostCompactFileCandidates(selected.head)
          if (postCompactCandidates.length > 0)
            log.info("post-compact file candidates", {
              runID: run.run_id,
              count: postCompactCandidates.length,
              maxFiles: POST_COMPACT_MAX_FILES_TO_RESTORE,
              maxCharsPerFile: POST_COMPACT_MAX_CHARS_PER_FILE,
              files: postCompactCandidates.map((candidate) => candidate.filePath),
            })
          yield* publishCommittedRun(run.run_id)
        }
      }
      return result.action
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (
      input: Parameters<Interface["process"]>[0],
    ) {
      if (activeCompactions.has(input.sessionID)) return "stop" as const
      yield* recover(input.sessionID)
      if (activeCompactions.has(input.sessionID)) return "stop" as const
      activeCompactions.add(input.sessionID)
      return yield* processCompactionAttempt(input).pipe(
        Effect.ensuring(Effect.sync(() => activeCompactions.delete(input.sessionID))),
      )
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
      trigger?: "turn_start" | "provider_overflow" | "manual"
      activityID?: string
    }) {
      yield* recover(input.sessionID)
      const projection = yield* MessageV2.promptHistoryProjectionEffect(input.sessionID).pipe(
        Effect.provideService(Database.Service, { db }),
        Effect.orDie,
      )
      const activeEpoch = yield* promptEpoch.getActive(input.sessionID)
      if (!activeEpoch || activeEpoch.authority_state !== "ready" || activeEpoch.epoch !== projection.epoch) {
        return yield* Effect.die(new Error(`compaction history authority is unavailable for ${input.sessionID}`))
      }

      const markerMessageID = MessageID.ascending()
      const markerPartID = PartID.ascending()
      const run = yield* ensureRun({
        sessionID: input.sessionID,
        markerMessageID,
        markerPartID,
        fromEpoch: activeEpoch.epoch,
        trigger: input.trigger ?? (input.overflow ? "provider_overflow" : input.auto ? "turn_start" : "manual"),
        sourceWindowID: projection.window.windowID,
        sourceEffectiveHistoryHash: projection.effectiveHistoryHash,
        sourceMessageCount: projection.messages.length,
        sourceProjectionVersion: projection.projectionVersion,
      })
      if (!run) return

      const marker = yield* Effect.exit(
        Effect.gen(function* () {
          const msg = {
            id: markerMessageID,
            role: "user",
            model: input.model,
            sessionID: input.sessionID,
            agent: input.agent,
            time: { created: Date.now() },
            metadata: SessionProcessor.withPlanProtocolActivity(undefined, input.activityID ?? markerMessageID),
          } satisfies SessionV1.User
          yield* events.publish(
            SessionV1.Event.MessageUpdated,
            { sessionID: input.sessionID, info: msg },
            {
              commit: () =>
                registerArtifact({
                  runID: run.run_id,
                  sessionID: input.sessionID,
                  messageID: msg.id,
                  kind: "marker",
                }),
            },
          )
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

    const hasPending = Effect.fn("SessionCompaction.hasPending")(function* (sessionID: SessionID) {
      const row = yield* db
        .select({ run_id: CompactionRunTable.run_id })
        .from(CompactionRunTable)
        .where(
          and(
            eq(CompactionRunTable.session_id, sessionID),
            inArray(CompactionRunTable.state, ["requested", "summarizing"] as const),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row !== undefined
    })

    const recoverableContinuations = Effect.fn("SessionCompaction.recoverableContinuations")(function* (
      projectID: Project.ID,
    ) {
      const rows = yield* db
        .select({
          runID: CompactionRunTable.run_id,
          sessionID: CompactionRunTable.session_id,
          messageID: CompactionArtifactTable.message_id,
        })
        .from(CompactionRunTable)
        .innerJoin(CompactionArtifactTable, eq(CompactionArtifactTable.run_id, CompactionRunTable.run_id))
        .innerJoin(SessionTable, eq(SessionTable.id, CompactionRunTable.session_id))
        .where(
          and(
            eq(SessionTable.project_id, projectID),
            eq(CompactionRunTable.state, "committed"),
            eq(CompactionRunTable.continuation_state, "pending"),
            eq(CompactionArtifactTable.state, "committed"),
            inArray(CompactionArtifactTable.kind, ["replay", "continue"] as const),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        runID: row.runID,
        sessionID: SessionID.make(row.sessionID),
        messageID: MessageID.make(row.messageID),
      }))
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
      recover,
      recoverableContinuations,
      hasPending,
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
