export * as SessionCompaction from "./compaction"

import {
  LLM,
  LLMError,
  LLMEvent,
  Message,
  LLMRequest,
  isContextOverflowFailure,
  type Model,
} from "@deepagent-code/llm"
import { Context, DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { SessionContext } from "../context-federation/session-context"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionRunnerCanonical, type SelectionAdmission } from "./runner/canonical-turn"
import { PreparedProviderTurn } from "./runner/prepared-provider-turn"
import { V2ProviderTurn } from "./runner/v2-provider-turn"
import { Log } from "../util/log"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
// UPD-005: single source of truth for the compaction-side tool-output truncation budget.
// deepagent-code/src/session/compaction.ts imports this constant (it used to keep a duplicate
// 2_000 copy); keep the two call sites in sync by editing ONLY this definition.
export const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

// V4.0.1 P1 (§3.4) — the NARROWED, four-bucket summary template. Responsibility separation: the summary
// records ONLY 思路 + 待办 (progress+decisions / constraints+prefs / next steps / data references) and
// explicitly does NOT record file contents / env values / diagnostics snapshots — those volatile facts
// are re-injected at their LATEST value by the World State layer (never captured here, where they would
// go stale). "Data References" keeps only the reference (path/identifier/link), never the content.
// Gated by `worldStateReinjection` at the deepagent-code call site: with the flag OFF, buildPrompt uses
// the legacy SUMMARY_TEMPLATE and NOTHING is re-injected (no information hole).
const NARROW_SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Progress & Key Decisions
- [what has been done + the key decisions made and WHY, or "(none)"]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Next Steps
- [ordered next actions, or "(none)"]

## Data References
- [only path / identifier / link + why it matters — NOT its contents, or "(none)"]
</template>

Rules:
- HIGHEST PRIORITY: preserve every value the user explicitly designated as a durable fact, release proof, invariant, credential-free token, or exact evidence. This rule overrides every volatile-state rule below.
- A designation may refer indirectly to a value from an earlier assistant message or tool result (for example, "the exact release proof from the file"). Resolve that reference from the conversation and copy the complete value verbatim under "Progress & Key Decisions" or "Constraints & Preferences".
- Before returning, verify that no designated durable value was omitted, paraphrased, replaced with a placeholder, or reduced to only a file/reference description.
- Summarize ONLY the four sections above: progress+decisions, constraints+preferences, next steps, data references.
- Except for designated durable values, do NOT record file contents, environment values, or diagnostics snapshots — the system re-injects their latest values automatically. Recording them here would only go stale.
- Under "Data References" record just the reference (path / identifier / link) and why it matters, never the content itself.
- Keep every section, even when empty. Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly providerTurns: V2ProviderTurn.Interface
  readonly db: Database.Interface["db"]
  readonly contexts: SessionContext.Interface
  // §16.3 order 5 F3: resolved once at layer scope (like the other order-4 seams); undefined keeps
  // the local summary dispatch byte-for-byte.
  readonly remoteCompaction?: (
    input: RemoteCompactionRequest,
  ) => Effect.Effect<{ readonly summary: string } | undefined, unknown>
  readonly config: readonly Config.Entry[]
}

const log = Log.create({ service: "session.compaction" })

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
  // Durable turn identity of the surrounding session turn. The summary request has no user message of
  // its own, so its receipt binds to the latest durable identity exactly like a continuation turn.
  readonly userMessageID: string
  readonly historyPromptEpoch: number
  readonly ownerMode: "shadow_v2" | "v2"
  readonly admission: SelectionAdmission
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

export const inputBudget = (context: number, buffer: number) => Math.max(0, context - buffer)

const modelInputLimit = (model: Model) => model.route.defaults.limits?.input ?? model.route.defaults.limits?.context

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) {
      const remaining = Math.max(0, tokens - total) * 4
      if (remaining <= 0)
        return {
          head: conversation.slice(0, index + 1).join("\n\n"),
          recent: conversation.slice(index + 1).join("\n\n"),
        }
      const boundary = conversation[index].length - remaining
      const splitAt =
        boundary > 0 &&
        boundary < conversation[index].length &&
        /[\uD800-\uDBFF]/.test(conversation[index][boundary - 1]) &&
        /[\uDC00-\uDFFF]/.test(conversation[index][boundary])
          ? boundary - 1
          : boundary
      return {
        head: [...conversation.slice(0, index), conversation[index].slice(0, splitAt)].filter(Boolean).join("\n\n"),
        recent: [conversation[index].slice(splitAt), ...conversation.slice(index + 1)].filter(Boolean).join("\n\n"),
      }
    }
    total = next
  }
  return {
    head: "",
    recent: conversation.join("\n\n"),
  }
}

export const buildPrompt = (input: {
  readonly previousSummary?: string
  readonly context: readonly string[]
  // V4.0.1 P1 — when true, use the four-bucket NARROW template (no file/env/diagnostics snapshots; those
  // are World-State re-injected). Default false ⇒ legacy SUMMARY_TEMPLATE (byte-for-byte pre-V4.0.1).
  readonly narrow?: boolean
}) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    input.narrow ? NARROW_SUMMARY_TEMPLATE : SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

// §16.3 order 4 package B — rebuild the summary outcome from a settled receipt's recorded artifact
// for crash replay. Returns undefined when the evidence is absent or fails the same integrity guard
// the convergence path applies (fail-closed: the caller then keeps the pre-seam skip behavior).
export const reconstructSettledSummary = (existing: {
  readonly state: string
  readonly outcome_hash: string | null
  readonly outcome_artifact: readonly unknown[] | null
}): { readonly chunks: readonly string[]; readonly failed: boolean } | undefined => {
  if (existing.state !== "settled" || !existing.outcome_artifact) return undefined
  if (existing.outcome_hash !== Hash.sha256(CanonicalJson.stringify(existing.outcome_artifact))) return undefined
  const chunks: string[] = []
  let failed = false
  for (const event of existing.outcome_artifact) {
    if (LLMEvent.is.providerError(event)) failed = true
    if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
  }
  return { chunks, failed }
}

// §16.3 order 5 F3 — remote compaction seam. When provided, the overflow pipeline first offers the
// summary to a REMOTE compaction authority (typed command → typed result adapter); a produced
// summary short-circuits the local provider dispatch. The remote authority keeps its own durable
// state (plan §5: the remote state machine stays an independent authority exchanging typed
// command/result), so no local V2ProviderTurn receipt is created for a remote-produced summary.
// Unwired (default) or a remote fault degrades to the local summary dispatch — that is the V2-native
// local path, NOT a fallback to legacy orchestration. Delivery is at-least-once: a crash between the
// remote result and the Compaction.Ended publish re-sends the same deterministic command, so the
// remote authority MUST be idempotent / dedupe by command content.
export type RemoteCompactionRequest = {
  readonly sessionID: SessionSchema.ID
  readonly summaryPrompt: string
  readonly model: Model
}
export const CurrentRemoteCompaction = Context.Reference<
  ((input: RemoteCompactionRequest) => Effect.Effect<{ readonly summary: string } | undefined, unknown>) | undefined
>("@deepagent-code/v2/SessionCompaction/CurrentRemoteCompaction", { defaultValue: () => undefined })

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = modelInputLimit(input.model)
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (Token.estimate(summaryPrompt) > Math.max(0, context - summaryOutput)) return false
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    const remote = dependencies.remoteCompaction
    const remoteSummary = remote
      ? yield* remote({ sessionID: input.sessionID, summaryPrompt, model: input.model }).pipe(
          // A remote fault degrades to the local dispatch (V2-native), never fails the turn:
          // typed failures first, then adapter defects — both logged so a broken adapter cannot
          // hide as "remote never works". Interrupts are caught by NEITHER stage, so cancellation
          // always propagates (the order-4 seams' catchCause swallowed them; this one must not).
          Effect.catch(() => {
            log.warn("remote compaction degraded to local dispatch", { sessionID: input.sessionID })
            return Effect.succeed(undefined)
          }),
          Effect.catchDefect(() => {
            log.warn("remote compaction adapter defect, degraded to local dispatch", {
              sessionID: input.sessionID,
            })
            return Effect.succeed(undefined)
          }),
        )
      : undefined
    // An empty remote summary is untrusted input: degrade to the local dispatch instead of
    // publishing an empty Compaction.Ended (the local path has the same non-empty guard).
    if (remoteSummary !== undefined && remoteSummary.summary.trim().length > 0) {
      yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason: "auto",
        text: remoteSummary.summary,
        recent: selected.recent,
      })
      return true
    }

    const summaryRequest = LLM.request({
      model: input.model,
      messages: [Message.user(summaryPrompt)],
      tools: [],
      generation: { maxTokens: summaryOutput },
    })
    const summaryRequestInputHash = Hash.sha256(
      CanonicalJson.stringify({
        ...LLMRequest.input(summaryRequest),
        model: {
          id: summaryRequest.model.id,
          provider: summaryRequest.model.provider,
        },
      }),
    )
    const summaryEvents: LLMEvent[] = []
    const chunks: string[] = []
    let failed = false
    // The summary provider request is a physical dispatch: it must own the same durable receipt
    // contract (admit -> wire seal -> settle/quarantine) as every other provider turn so a crash or
    // stream failure cannot bypass the recovery classifier. Receipt-seam refusals before dispatch
    // (owner unhealthy, exact-retry conflict against an already-terminal identical receipt) mean the
    // summary request never ran; skip compaction instead of failing the surrounding turn.
    const summarized = yield* Effect.gen(function* () {
      // Same recoverable boundary as the surrounding turn: canonical attempt + receipt, bound.
      const summaryReceipt = (
        yield* SessionRunnerCanonical.commitTurn({
          db: dependencies.db,
          contexts: dependencies.contexts,
          sessionID: input.sessionID,
          admission: input.admission,
          receipt: {
            sessionId: input.sessionID,
            userMessageId: input.userMessageID,
            historyPromptEpoch: input.historyPromptEpoch,
            requestInputHash: summaryRequestInputHash,
            providerId: input.model.provider,
            modelId: input.model.id,
            protocol: input.model.route.protocol,
            ownerMode: input.ownerMode,
          },
          ownerToken: dependencies.providerTurns.ownerToken,
        })
      ).receipt
      return yield* V2ProviderTurn.stream({
        service: dependencies.providerTurns,
        receipt: summaryReceipt,
        prepare: (wireHash) =>
          V2ProviderTurn.prepare(
            {
              receipt: summaryReceipt,
              stableSystemParts: [],
              volatileSystemParts: [],
              historyMessages: [Message.user(summaryPrompt)],
              toolDefinitions: [],
              toolIDs: [],
              toolChoice: null,
              toolResultReferences: [],
              samplingMaxOutputTokens: summaryOutput,
              budget: PreparedProviderTurn.budget(input.model),
              userMessageID: input.userMessageID,
              activityID: summaryReceipt.activityId,
              providerTurnSeq: summaryReceipt.providerTurnSeq,
              contextSelectionID: input.admission.selectionId,
              contextProjectionHash: input.admission.projectionHash,
            },
            wireHash,
          ),
        stream: dependencies.llm
          .stream(summaryRequest)
          .pipe(Stream.tap((event) => Effect.sync(() => summaryEvents.push(event)))),
        outcomeArtifact: () => summaryEvents,
        errorCode: (error) => `compaction_stream_failed:${Hash.sha256(String(error)).slice(0, 16)}`,
        // The summary request carries no tools, so an intake-time context-overflow refusal is the only
        // failure that provably terminates before any side effect.
        terminalProviderFailure: isContextOverflowFailure,
      }).pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
      )
    }).pipe(
      // §16.3 order 4 package B — receipt-aware replay: an UnsafeRetryError whose same-identity
      // receipt is SETTLED means the summary request already ran and settled before the crash.
      // Reuse its recorded outcome artifact (never re-dispatch — indeterminate no-replay) instead
      // of skipping; the blanket skip left such sessions uncompactable until the next user message
      // changed the identity. Non-settled states (dispatching/streaming/failed/indeterminate)
      // remain fail-closed skips.
      Effect.catchTag("V2ProviderTurn.UnsafeRetryError", (error) =>
        Effect.gen(function* () {
          if (error.state !== "settled") return false
          const existing = yield* V2ProviderTurn.receiptByIdentity(dependencies.db, {
            sessionId: input.sessionID,
            userMessageId: input.userMessageID,
            historyPromptEpoch: input.historyPromptEpoch,
            requestInputHash: summaryRequestInputHash,
          }).pipe(Effect.orDie)
          if (!existing) return false
          const replayed = reconstructSettledSummary(existing)
          if (!replayed) return false
          failed = replayed.failed
          chunks.push(...replayed.chunks)
          return true
        }),
      ),
      // Typed refusals from the receipt seam or canonical admission (owner unhealthy, exact-retry
      // conflict, blocked attempt seq, expired validation) all mean the summary request never ran;
      // skip compaction instead of failing the surrounding turn. Unexpected failures stay defects.
      Effect.catch(() => Effect.succeed(false)),
    )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: selected.recent,
    })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = modelInputLimit(input.model)
    if (context === undefined || context <= 0) return false
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      inputBudget(context, config.buffer)
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
