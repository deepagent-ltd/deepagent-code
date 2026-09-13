import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  LLMRequest,
  Message,
  SystemPart,
  ToolDefinition,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@deepagent-code/llm"
import { AgentGateway } from "../../agent-gateway"
import { desc, eq } from "drizzle-orm"
import { Cause, DateTime, Duration, Effect, Exit, FiberSet, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { Catalog } from "../../catalog"
import { CapabilityCatalog } from "../../system-context/capability-catalog"
import { DeepAgentCodeToolInventory } from "../../system-context/capability-manifest"
import { PermissionV2 } from "../../permission"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { CompactionRequest } from "../compaction-request"
import { SessionContext } from "../../context-federation/session-context"
import { ContextQueryAuthorization } from "../../context-federation/query-authorization"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { GoalLoop } from "../../deepagent/goal-loop"
import { getActiveGoal } from "../../deepagent/session-state"
import { DocumentStore } from "../../deepagent/document-store"
import { planStoreRoot } from "../../deepagent/plan-store"
import { type RunError, Service, StepLimitExceededError, CurrentOnSessionSettled, CurrentToolSettleGate } from "./index"
import { SessionRunnerModel } from "./model"
import { PreparedProviderTurn } from "./prepared-provider-turn"
import { buildDeepAgentPrompt, buildGovernedPlanContext } from "./deepagent-prompt"
import { V2ToolEffect } from "./v2-tool-effect"
import { createLLMEventPublisher } from "./publish-llm-event"
import { normalizeAttachments } from "./attachments"
import { toLLMMessages } from "./to-llm-message"
import { SessionHistoryProjection } from "./session-history-projection"
import { ModelPromptProfile } from "../../deepagent/model-prompt-profile"
import { SessionRunnerCanonical } from "./canonical-turn"
import { productionAdaptersEnabled, ProductionV2Sources } from "../../context-federation/production-adapters"
import { CurrentRuntimeFeatures } from "../../flag/runtime-features"
import { V2ProviderTurn } from "./v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "./v2-provider-turn.sql"
import { CanonicalJson } from "../../util/canonical-json"
import { Hash } from "../../util/hash"
import { Token } from "../../util/token"
import { CapabilitySnapshot } from "../../system-context/capability-snapshot"
// W4.1/P1-1: the snapshot restore reads the DURABLE `session_capability_load` table
// (the in-process kernel cache is process-local only — a restart would lose it).
import { capabilityLoadFactOf, recordedCapabilityLoadsForSession } from "../../system-context/capability-load-adapter"
import { ProjectDocsSync } from "../../deepagent/project-docs-sync"
import { flipFlagValueOn } from "../../deepagent/flip-flag"
import * as turnObservability from "../../deepagent/turn-observability"
import { FSUtil } from "../../fs-util"
import { Git } from "../../git"
import {
  buildCapabilityEvidence,
  configDrift,
  protocolAttemptIdentityFor,
  protocolAttemptIdentityHash,
  resolveModelProtocol,
} from "../../model-protocol"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Bound model steps.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Keep V1 runtime-context parity enforced by the production runner tests and Context Epoch invariants.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@deepagent-code/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, plugins, and cancellation settlement.
 *     (Prompt attachments are normalized into wire shape at request construction — text/* inlined,
 *     directories listed, binary media materialized or capability-gated; see
 *     `normalizeAttachments` in ./attachments.)
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [x] Continue after compaction: pre-turn budget compaction rebuilds the prepared turn
 *     (RebuildPreparedTurn); a post-dispatch context overflow runs one compaction and the
 *     ContinueAfterOverflowCompaction transition re-runs the turn on the compacted history (one
 *     recovery per turn; a second overflow fails the turn). Manual compaction stays
 *     typed-unavailable on SessionV2.compact until the legacy compaction state machine
 *     (continuation state / soft-landing / remote artifacts) is ported. Other continuation
 *     conditions beyond MAX_STEPS and overflow are not implemented.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable activity recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and a
 * bounded explicit loop starts the next provider turn after local settlement.
 */

const MAX_STEPS = 25
// The durable provider stream seals one physical request, so it disables the executor's own retry
// budget (`RequestExecutor.CurrentRetryLimit = 0`) rather than silently multiplying sealed sends.
// Without a runner-level replacement, a provider that REJECTS a request before generation — HTTP
// 429/5xx, or a transport failure proven to predate dispatch — ended the whole drain and the run.
// Those are known rejections, not the unknown-outcome state RI-11 fences, so re-open them as a
// bounded fresh attempt (the same-owner indeterminate quarantine admits the next receipt ordinal).
const MAX_PROVIDER_ATTEMPT_RETRIES = 3
const PROVIDER_RETRY_BASE_DELAY_MS = 1_000
const PROVIDER_RETRY_MAX_DELAY_MS = 10_000
// Die-defect messages from the filesystem and edit layers that are tool-argument validation, not
// defects: the model passed a path/reference the location cannot contain, paged past the end of a
// file, or an edit whose old text does not match. These settle as tool error results (V1 parity)
// instead of killing the drain.
const TOOL_PATH_DEFECT =
  /^(Absolute path escapes the location|Path escapes the location|Path escapes managed tool output|Absolute paths cannot use a project reference|Absolute path is not managed tool output|Path is not a file or directory|Path is not a file|Path is not a directory|Unknown project reference|Path does not exist|Offset \d+ is out of range|Failed to find expected lines in |No changes to apply: |oldString cannot be empty when editing an existing file|filePath is required|File .* not found|Path is a directory, not a file: |Cannot read binary file: |Media exceeds \d+ byte ingestion limit: )/

const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

Summarize the work completed so far, list any remaining tasks, and recommend what should happen next. Do not make any tool calls.`

// V4.0.1 P0b OUTPUT soft-landing (legacy loop parity): a response cut off at the output-token
// ceiling (finish "length") with no local tool call gets a bounded "continue from the cutoff"
// synthetic nudge and one more provider turn instead of ending the turn mid-sentence. The
// continuation budget derives from the durable history itself (trailing assistant-"length" +
// synthetic-nudge pairs), so no separate durable counter exists and a natural stop automatically
// resets the run. Env knobs mirror the legacy overflow.ts semantics (kill-switch default ON).
const OUTPUT_CONTINUATION_MAX = 3

const outputContinuationMax = () => {
  const raw = Number(process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"])
  return Number.isInteger(raw) && raw >= 0 ? raw : OUTPUT_CONTINUATION_MAX
}

const outputSoftLandingEnabled = () => flipFlagValueOn(process.env["DEEPAGENT_CODE_OUTPUT_SOFT_LANDING"], true)

const OUTPUT_CONTINUE_TAIL_TEXT = [
  "<system-reminder>",
  "你上一轮的输出因达到输出长度上限被截断（未自然结束）。请直接从被截断处继续，",
  "不要重复已经输出的内容，也不要重新开头。若已实质完成，简短收尾即可。",
  "</system-reminder>",
].join("\n")

const TOOL_INPUT_CONTINUE_TAIL_TEXT = [
  "<system-reminder>",
  "你上一轮的工具输入因达到输出长度上限而被截断，系统没有执行该工具，也没有应用其中的文件修改。",
  "不要原样重发同一个大型 JSON 工具调用。将修改拆小；对于大型 write/edit/apply_patch，改用 `apply_patch_chunk`，",
  "每个 patchText 块不超过 12000 UTF-8 字节（中文建议不超过约 4000 字）。begin 使用 offset 0；之后每次 append 和最终 commit 都使用上一结果返回的 nextOffset。",
  "</system-reminder>",
].join("\n")

const isOutputContinuationNudge = (text: string) =>
  text === OUTPUT_CONTINUE_TAIL_TEXT || text === TOOL_INPUT_CONTINUE_TAIL_TEXT

// Continuations already consumed by the CURRENT length run: walk the trailing chain of
// (assistant finish "length" ← synthetic nudge) pairs. Any other tail message breaks the run.
const countOutputContinuations = (messages: readonly SessionMessage.Message[]) => {
  let count = 0
  let index = messages.length - 1
  while (index >= 0) {
    const message = messages[index]
    if (message?.type === "assistant" && message.finish === "length") {
      index--
      continue
    }
    if (message?.type === "synthetic" && isOutputContinuationNudge(message.text)) {
      count++
      index--
      continue
    }
    break
  }
  return count
}

// BUG-010 / RI-127 plan protocol termination budget (legacy SessionProcessor
// PlanProtocolTracker parity): a malformed, conflicting, or no-progress model plan is
// recoverable once; the SECOND consecutive violation terminates the turn with a typed
// assistant error instead of opening another provider turn. Like the output-continuation
// budget above, the consecutive count derives from durable history (the plan leaf's
// structured `plan_protocol` outcome on projected tool parts), so no separate counter is
// persisted across turns.
const PLAN_PROTOCOL_MAX_ATTEMPTS = 2

type PlanProtocolViolationOutcome = "invalid" | "conflict" | "no_progress"

const planProtocolOutcomeOf = (structured: unknown): PlanProtocolViolationOutcome | "success" | undefined => {
  if (typeof structured !== "object" || structured === null) return undefined
  const protocol = (structured as Record<string, unknown>)["plan_protocol"]
  return protocol === "invalid" || protocol === "conflict" || protocol === "no_progress" || protocol === "success"
    ? protocol
    : undefined
}

const planErrorCodeOf = (structured: unknown) => {
  if (typeof structured !== "object" || structured === null) return undefined
  const code = (structured as Record<string, unknown>)["plan_error_code"]
  return typeof code === "string" ? code : undefined
}

// Consecutive plan protocol violations at the tail of the CURRENT activity: walk history
// backwards counting violation-outcome plan parts; a committed plan (success) or the user
// message that opened the activity ends the run. Non-plan calls neither increment nor reset
// the count, and a plan part without a settled outcome (pending/running) is skipped — both
// legacy tracker semantics.
const countPlanProtocolViolations = (messages: readonly SessionMessage.Message[]) => {
  let count = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type === "user") break
    if (message?.type !== "assistant") continue
    let committed = false
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex]
      if (part?.type !== "tool" || part.name !== "plan") continue
      if (part.state.status === "error") {
        count++
        continue
      }
      if (part.state.status !== "completed") continue
      const outcome = planProtocolOutcomeOf(part.state.structured)
      if (outcome === undefined || outcome === "success") {
        committed = true
        break
      }
      count++
    }
    if (committed) break
  }
  return count
}

// UPD-002/RI-126 structured output (legacy loop parity): a prompt-admitted json_schema format
// is delivered either through the wire (`responseFormat` lowered onto Responses `text.format`
// for Responses-family + format-capable routes) or through a synthesized StructuredOutput
// tool the model must call exactly once (all other routes). The captured value persists on
// the assistant through SessionEvent.StructuredCaptured. Copy below is verbatim legacy
// (prompt.ts STRUCTURED_OUTPUT_DESCRIPTION / buildStructuredOutput*).
const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput"

const STRUCTURED_OUTPUT_SUCCESS_TEXT = "Structured output captured successfully."

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const schemaTopLevelFields = (schema: Record<string, unknown>): string[] => {
  const props = schema["properties"]
  if (typeof props !== "object" || props === null) return []
  return Object.keys(props)
}

const structuredOutputSystemPrompt = (schema: Record<string, unknown>): string => {
  const fields = schemaTopLevelFields(schema)
  const fieldHint =
    fields.length > 0
      ? `\nThe StructuredOutput tool requires these top-level fields: ${fields.join(", ")}. Use ONLY these exact field names.`
      : ""
  return `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.${fieldHint}`
}

// Wire mode: the provider enforces the schema via text.format, so the tail must NOT reference
// the (absent) StructuredOutput tool.
const STRUCTURED_OUTPUT_WIRE_TAIL =
  "IMPORTANT: The user has requested structured output. Your final response text is schema-constrained by the provider. Reply with ONLY a single JSON value matching the required schema - no Markdown fences, prose, or wrapping."

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const gateway = yield* AgentGateway.Runtime
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const config = yield* Config.Service
    const catalog = yield* Catalog.Service
    // Capture Location filesystem/project metadata dependencies at layer construction. Optional
    // lookups here previously made docs_sync appear wired while the production Location runner had
    // no Git service and silently dropped branch metadata.
    const fs = yield* FSUtil.Service
    const gitService = yield* Git.Service
    // W10: after a drain chain settles, best-effort project docs maintenance. Writes are opt-in
    // (DEEPAGENT_CODE_PROJECT_DOCS_SYNC or `docs_sync` config, default false).
    const docsSyncEnabled = ProjectDocsSync.writingEnabled(Config.latest(yield* config.entries(), "docs_sync"))
    // W7: host-injectable settle hook (durable-learning admission in the deepagent-code
    // composition); unwired = no-op.
    const onSessionSettled = yield* CurrentOnSessionSettled
    const toolSettleGate = yield* CurrentToolSettleGate
    // Runtime feature authority: captured once at layer construction (default: the process-start
    // global), so every forked drain fiber reads the SAME registry and tests inject an explicit
    // one at the layer instead of flipping process.env mid-process.
    const runtimeFeatures = yield* CurrentRuntimeFeatures
    const providerTurns = yield* V2ProviderTurn.Service
    const runtimeIntegrityIdentity = yield* V2ProviderTurn.CurrentRuntimeIntegrityIdentity
    const toolEffects = yield* V2ToolEffect.Service
    const permissionGrantLookup = yield* V2ToolEffect.CurrentPermissionGrantLookup
    // §16.3 order 4 history-epoch bridge: resolved once at layer scope (like the grant lookup) so
    // the captured value reaches every forked drain fiber; undefined keeps the pre-seam identity.
    const historyEpochLookup = yield* V2ProviderTurn.CurrentHistoryEpochLookup
    const contexts = yield* SessionContext.Service
    // Location host seams are required production dependencies. Missing wiring must fail the
    // Location build instead of silently turning graph selection and authorization into no-ops.
    const queryAuthorization = yield* ContextQueryAuthorization.Controller
    const selectionSources = yield* ProductionV2Sources
    const ownerAuthorization = yield* V2ProviderTurn.OwnerAuthorization
    const db = (yield* Database.Service).db
    const remoteCompaction = yield* SessionCompaction.CurrentRemoteCompaction
    const compaction = SessionCompaction.make({
      events,
      llm,
      providerTurns,
      db,
      contexts,
      config: yield* config.entries(),
      ...(remoteCompaction ? { remoteCompaction } : {}),
    })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: dismissing a question halts the loop instead of becoming model-facing tool output.
    const isQuestionRejected = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof QuestionV2.RejectedError)

    // Matches both the fetch-abort DOMException and the hand-built AbortErrors used across the
    // codebase (process.ts, filesystem/ripgrep.ts).
    const isAbortError = (defect: unknown) => defect instanceof Error && defect.name === "AbortError"

    // Cancel reaches this boundary as a transport AbortError defect: interrupting the drain while it
    // hangs on the provider body stream aborts the fetch (`InterruptibleResponse` ensures
    // `controller.abort()`), the body reader teardown then rejects with an AbortError DOMException,
    // and `Stream.fromReadableStream` (via `Effect.promise`) surfaces that rejection as a defect
    // that replaces the fiber's interrupt cause outright. The request AbortController is private to
    // the HTTP client and is only ever aborted by consumption teardown, so an AbortError defect here
    // IS the interruption artifact — reclassify it as interrupts-only to keep the cancel contract.
    // Causes that carry any other signal (a typed failure or a non-abort defect alongside) pass
    // through untouched, so an AbortError outside the interruption context keeps its semantics.
    const classifyProviderStreamAbort = <A, E>(exit: Exit.Exit<A, E>): Exit.Exit<A, E> => {
      if (exit._tag !== "Failure") return exit
      const remaining = exit.cause.reasons.filter(
        (reason) => !(Cause.isDieReason(reason) && isAbortError(reason.defect)),
      )
      if (remaining.length === exit.cause.reasons.length) return exit
      if (remaining.some((reason) => !Cause.isInterruptReason(reason))) return exit
      return Exit.failCause(remaining.length === 0 ? Cause.interrupt() : Cause.fromReasons(remaining))
    }

    type TurnTransition =
      // Request preparation observed a concurrent Session change and must restart from durable state.
      | { readonly _tag: "RebuildPreparedTurn"; readonly promotion?: SessionInput.Delivery; readonly step?: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }
      // A known-before-generation failure — a provider rejection, or a lease-fenced attempt whose
      // owner never reached the provider — re-dispatches as a fresh attempt within a bounded budget
      // instead of ending the run.
      | {
          readonly _tag: "RetryAttempt"
          readonly step: number
          readonly retry: number
          readonly cause: "provider_rejection" | "owner_fenced"
          readonly retryAfterMs?: number | undefined
        }
    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const rebuildPreparedTurn = (promotion?: SessionInput.Delivery, step?: number) =>
      new TurnTransitionError({ _tag: "RebuildPreparedTurn", promotion, step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({
        _tag: "ContinueAfterOverflowCompaction",
        step,
      })
    const retryAttempt = (
      step: number,
      retry: number,
      cause: "provider_rejection" | "owner_fenced",
      retryAfterMs?: number,
    ) => new TurnTransitionError({ _tag: "RetryAttempt", step, retry, cause, retryAfterMs })
    const retryAgentMismatch = (promotion: SessionInput.Delivery | undefined, step?: number) =>
      Effect.catchDefect((defect) =>
        defect instanceof SessionContextEpoch.AgentMismatch
          ? Effect.die(rebuildPreparedTurn(promotion, step))
          : Effect.die(defect),
      )

    const sameModel = Schema.toEquivalence(Schema.UndefinedOr(ModelV2.Ref))
    const loadSystemContext = (
      agent: AgentV2.Selection,
      session: SessionSchema.Info,
      modelSupportsTools: boolean | undefined,
    ) =>
      Effect.gen(function* () {
        const rulesets = [agent.info?.permissions ?? [], session.permissions]
        const availableToolNames = new Set(
          modelSupportsTools === false
            ? []
            : (yield* tools.materialize({ rulesets })).definitions.map((definition) => definition.name),
        )
        return yield* Effect.all([systemContext.load(), skillGuidance.load(agent)], { concurrency: 2 }).pipe(
          Effect.map(SystemContext.combine),
          Effect.provideService(CapabilityCatalog.CurrentAvailableToolNames, availableToolNames),
          Effect.provideService(
            CapabilityCatalog.CurrentGrantedPermissions,
            new Set(
              modelSupportsTools === false
                ? []
                : [...DeepAgentCodeToolInventory.permissionActions].filter(
                    (permission) => !PermissionV2.isActionWhollyDenied(permission, ...rulesets),
                  ),
            ),
          ),
        )
      })

    // W1.1 — goal_steer delivery (design W1 §1). Each pending goal-directed steer is handed to the
    // ACTIVE goal's durable runtime state via GoalLoop.enqueueGoalSteer; without an active goal (or a
    // stale pointer whose runtime state is gone/terminal) the row stays pending (no loss) and one
    // deterministic "waiting for a goal" notice is published. Delivered rows are stamped consumed
    // (idempotent by row id) — crash-safe at-least-once, mirroring the goal driver's steer semantics.
    const drainGoalSteers = Effect.fn("SessionRunner.drainGoalSteers")(function* (
      sessionID: SessionSchema.ID,
      steers: ReadonlyArray<SessionInput.Admitted>,
    ) {
      const pointer = getActiveGoal(sessionID)
      const delivered: SessionMessage.ID[] = []
      for (const steer of steers) {
        if (pointer !== null && (pointer.phase === "running" || pointer.phase === "paused")) {
          const outcome = yield* Effect.sync(() =>
            GoalLoop.enqueueGoalSteer(
              DocumentStore.shared(planStoreRoot(sessionID)),
              { goalId: pointer.goalId, planDocId: pointer.planDocId, sessionId: sessionID },
              { id: steer.id, text: steer.prompt.text },
            ),
          ).pipe(Effect.catchCause(() => Effect.succeed("no_goal" as const)))
          if (outcome === "enqueued") {
            delivered.push(steer.id)
            continue
          }
        }
        yield* SessionInput.publishGoalSteerPendingNotice(db, events, sessionID, steer.id)
      }
      if (delivered.length > 0) yield* SessionInput.consumeGoalSteers(db, sessionID, delivered)
    })

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
      providerRetry = 0,
    ) {
      const parityCampaign = (yield* V2ProviderTurn.CurrentCampaign) ?? V2ProviderTurn.campaignFromEnv()
      const ownerCampaign = (yield* V2ProviderTurn.CurrentOwnerCampaign) ?? V2ProviderTurn.ownerCampaignFromEnv()
      if (!(yield* ownerAuthorization.authorize(db, ownerCampaign)))
        return yield* new V2ProviderTurn.ConflictError({ reason: "v2_owner_campaign_not_verified" })
      const integrityIdentity = runtimeIntegrityIdentity
        ? yield* runtimeIntegrityIdentity.resolve(yield* Effect.context())
        : undefined
      // W0.5 (blocker-1): the parity exclusion compares the operator's EXPLICIT owner campaign
      // only — the runtime's auto-default (v2-owner-<InstallationVersion>) is the NORMAL production
      // posture and must not disable the shadow-parity verification run that intentionally sets
      // parity envs without an owner env.
      if (parityCampaign && V2ProviderTurn.ownerCampaignFromEnv())
        return yield* new V2ProviderTurn.ConflictError({ reason: "v2_owner_cannot_record_shadow_parity" })
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const pendingToolEffects = yield* toolEffects.listPendingForSession(session.id)
      if (pendingToolEffects.length > 0)
        return yield* new V2ToolEffect.RecoveryRequiredError({
          sessionId: session.id,
          pending: pendingToolEffects.length,
        })
      const agent = yield* agents.select(session.agent)
      if (session.agent !== undefined && agent.info === undefined)
        return yield* new AgentV2.NotFoundError({ id: session.agent })
      const { model, info: modelInfo, provider: modelProvider } = yield* models.resolve(session)
      const modelProtocolSelection = modelInfo ? resolveModelProtocol(modelInfo, modelProvider) : undefined
      const modelProtocol = modelProtocolSelection?.protocol
      const initialized = yield* SessionContextEpoch.initialize(
        db,
        loadSystemContext(agent, session, modelInfo?.capabilities.tools),
        session.id,
        session.location,
        agent.id,
      ).pipe(retryAgentMismatch(promotion))
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      const promoted = yield* Effect.gen(function* () {
        // W1.1 — only `steer`/`queue` are transcript promotions. A `goal_steer` promotion is the
        // goal channel's drain-only turn: it must NOT promote chat steers/queued input (the goal
        // driver reads a DISJOINT buffer), and it dispatches no provider turn of its own.
        if (promotion !== "steer" && promotion !== "queue") return [] as readonly string[]
        const cutoff = yield* SessionInput.latestSeq(db, session.id)
        if (promotion === "steer") return yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        const queued = yield* SessionInput.promoteNextQueued(db, events, session.id)
        const steers = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        return queued === undefined ? steers : [queued, ...steers]
      })
      const currentStep = promoted.length > 0 ? 1 : step
      // W1.1 — goal_steer drain (after the promoted-inputs read; the goal channel is DISJOINT from
      // the steer/queue promotions above). Pending goal-directed steers are delivered to the ACTIVE
      // goal's durable runtime state (the next goal tick threads them into its step prompt); without
      // an active goal they stay pending (no loss) and one deterministic notice reaches the user.
      // A `goal_steer` drain-only turn returns here WITHOUT a provider dispatch — the goal's own
      // tick drives the model, so the drain itself never spends a turn.
      const goalSteers = yield* SessionInput.pendingGoalSteers(db, session.id)
      if (goalSteers.length > 0) {
        yield* drainGoalSteers(session.id, goalSteers)
        if (promotion === "goal_steer") return { needsContinuation: false, step: currentStep }
      }
      const system =
        initialized ??
        (yield* SessionContextEpoch.prepare(
          db,
          events,
          loadSystemContext(agent, session, modelInfo?.capabilities.tools),
          session.id,
          session.location,
          agent.id,
        ).pipe(retryAgentMismatch(undefined, currentStep)))
      const current = yield* getSession(sessionID)
      if ((yield* agents.select(current.agent)).id !== agent.id || !sameModel(current.model, session.model))
        return yield* Effect.die(rebuildPreparedTurn(undefined, currentStep))
      // C2-04/B2 residual — bind the protocol attempt identity (route/protocol/origin/capability/
      // lowering) onto the prepared attempt from the already-resolved catalog config, so an exact
      // retry never changes the model protocol/context/capability body mid-attempt (design §2.3,
      // §4.1 step 8). This evidence is a pure canonical projection of the exact Location catalog
      // snapshot. Business turns never consult or mutate the optional process-local probe cache.
      const protocolIdentity =
        modelInfo === undefined
          ? undefined
          : protocolAttemptIdentityFor(modelInfo, modelProvider, buildCapabilityEvidence(modelInfo, modelProvider))
      const protocolIdentityHash =
        protocolIdentity === undefined ? undefined : protocolAttemptIdentityHash(protocolIdentity)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      // UPD-002/RI-126: the active structured-output format rides the latest user message
      // (legacy lastUser.format parity). Wire mode requires BOTH a Responses-family route AND
      // the declared structuredOutput capability — never assumed from the family alone; every
      // other route keeps the synthesized StructuredOutput tool.
      const requestedFormat = context.findLast((message) => message.type === "user")?.format
      const jsonSchemaFormat = requestedFormat?.type === "json_schema" ? requestedFormat : undefined
      const wireStructuredOutput =
        jsonSchemaFormat?.schema !== undefined &&
        (modelProtocol === "openai.responses" || modelProtocol === "openai-compatible.responses") &&
        modelProtocolSelection?.capabilities.structuredOutput === true
      const syntheticStructuredOutput = jsonSchemaFormat?.schema !== undefined && !wireStructuredOutput
      const currentUserMessageID = context.findLast((message) => message.type === "user")?.id
      const latestReceipt = currentUserMessageID
        ? undefined
        : yield* db
            .select({
              userMessageID: V2ProviderTurnReceiptTable.user_message_id,
              state: V2ProviderTurnReceiptTable.state,
            })
            .from(V2ProviderTurnReceiptTable)
            .where(eq(V2ProviderTurnReceiptTable.session_id, session.id))
            .orderBy(desc(V2ProviderTurnReceiptTable.request_ordinal))
            .get()
            .pipe(Effect.orDie)
      if (
        latestReceipt &&
        ["preparing", "dispatching", "streaming", "indeterminate_after_crash"].includes(latestReceipt.state)
      )
        return yield* new V2ProviderTurn.UnsafeRetryError({ state: latestReceipt.state })
      // Compaction can replace the visible user prefix with a summary. Until the canonical V2 turn-id
      // schema lands, bind that continuation to the latest settled/failed durable receipt identity.
      // A truly empty imported Session still has no identity and must not dispatch.
      const receiptUserMessageID = currentUserMessageID ?? latestReceipt?.userMessageID
      if (!receiptUserMessageID) return { needsContinuation: false, step: currentStep }
      const toolMaterialization = yield* tools.materialize({
        rulesets: [agent.info?.permissions ?? [], session.permissions],
      })
      const toolDefinitions = [
        ...(modelInfo?.capabilities.tools === false ? [] : toolMaterialization.definitions),
        // RI-126: the synthesized StructuredOutput tool is advertised but never registered —
        // its call is intercepted before registry settlement and captured as the final answer.
        ...(syntheticStructuredOutput && jsonSchemaFormat.schema !== undefined
          ? [
              ToolDefinition.make({
                name: STRUCTURED_OUTPUT_TOOL_NAME,
                description: STRUCTURED_OUTPUT_DESCRIPTION,
                inputSchema: jsonSchemaFormat.schema,
              }),
            ]
          : []),
      ]
      const stepLimitReached = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const deepagentPrompt = gateway.active
        ? yield* buildDeepAgentPrompt({
            runtime: gateway,
            sessionID: session.id,
            userMessageID: receiptUserMessageID,
            providerID: model.provider,
            modelID: model.id,
            directory: location.directory,
            messages: context,
            tools: toolDefinitions,
            ...(gitService === undefined ? {} : { git: gitService }),
          })
        : undefined
      // Governed plan-status fallback (V1 parity, session/llm/request.ts non-managed branch): when
      // the gateway is enabled but not model-managed (agentMode "general" — `runtime.active` is
      // false and buildDeepAgentPrompt is skipped), EVERY non-compaction agent with a committed plan
      // still needs the plan write precondition to advance/replan: the V2 plan gate forces a seeded
      // session's plan to "high" regardless of agent, so gating on goal-worker alone stranded
      // general-mode Sessions that were forced to create a plan but could never see plan-status.
      // V2 compaction (SessionCompaction) dispatches its summary outside this prepare path; the
      // roster's hidden compaction agent is excluded explicitly for V1 parity.
      // buildGovernedPlanContext returns undefined without a committed plan — nothing to inject.
      const governedPlanContext =
        deepagentPrompt === undefined && agent.id !== AgentV2.ID.make("compaction")
          ? buildGovernedPlanContext({ runtime: gateway, sessionID: session.id, messages: context })
          : undefined
      const stableSystemParts = PreparedProviderTurn.mergeSystemParts(
        [agent.info?.system],
        deepagentPrompt?.stableSystemParts ?? [],
        [system.baseline],
      )
      const volatileSystemParts: string[] = []
      // G3 history projection — durable rows lower to the model-facing view with graded
      // tool-output budgets. Errors and the resent tail survive verbatim (pure function of
      // content ⇒ byte-stable projection ⇒ prompt cache holds). Disabled or no-op projection
      // returns the same array reference.
      const projectedContext = SessionHistoryProjection.projectForModel(context)
      const historyRequestMessages = yield* normalizeAttachments(projectedContext, modelInfo?.capabilities.input).pipe(
        Effect.provideService(FSUtil.Service, fs),
      )
      const requestMessages = [
        ...toLLMMessages(historyRequestMessages, model),
        ...(deepagentPrompt?.volatileRoundContext
          ? [Message.user(deepagentPrompt.volatileRoundContext)]
          : governedPlanContext
            ? [Message.user(governedPlanContext)]
            : []),
        ...(stepLimitReached ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
      ]
      // G3 model profile channel 3 (runtime params): clamp the activation policy's suggested
      // reasoning effort by the profile cap (e.g. deepseek — over-thinking simple repair turns).
      // Never sent as prompt text; lowers onto the provider option the SDK already knows. Only
      // models with declared reasoning capability receive it (non-reasoning models reject the
      // parameter, and provider-merged user config still wins over this runtime default).
      const modelProfile = ModelPromptProfile.profileFor(model.provider, model.id)
      turnObservability.recordModelProfile(ModelPromptProfile.profileKeyFor(model.provider, model.id), sessionID)
      const reasoningEffort = modelInfo?.api.protocolCapabilities?.reasoningItems
        ? ModelPromptProfile.clampReasoningEffort(
            deepagentPrompt?.context.activation.suggestedReasoningEffort ?? "medium",
            modelProfile.params.maxReasoningEffort,
          )
        : undefined
      let request = LLM.request({
        model,
        providerOptions: {
          openai: { promptCacheKey, ...(reasoningEffort ? { reasoningEffort } : {}) },
        },
        system: stableSystemParts.map(SystemPart.make),
        messages: requestMessages,
        tools: toolDefinitions,
        toolChoice: stepLimitReached ? "none" : syntheticStructuredOutput ? "required" : undefined,
        // RI-126 wire mode: the Responses protocol lowers this onto `text.format` json_schema;
        // `strict` stays unset (session schemas are not authored against OpenAI strict mode).
        ...(wireStructuredOutput && jsonSchemaFormat.schema !== undefined
          ? { responseFormat: { type: "json" as const, schema: jsonSchemaFormat.schema } }
          : {}),
        metadata: {
          "deepagent-code": {
            callKind: "session_turn",
            feature: "v2_session_chat",
            sessionID: session.id,
            messageID: receiptUserMessageID,
            agent: agent.id,
          },
        },
      })
      // Canonical activity/selection admission: the runner takes its durable identity from the
      // promoted inputs (or the surrounding turn identity for continuations), never from derived keys.
      const selectionAdmission = yield* SessionRunnerCanonical.admitSelection({
        db,
        contexts,
        sessionID: session.id,
        agent: agent.id,
        location: session.location,
        promotedInputIds: promoted,
        fallbackUserInputId: receiptUserMessageID,
        system: { baseline: system.baseline, revision: system.revision, baselineSeq: system.baselineSeq },
        historyEndMessageId: context.at(-1)?.id,
        ...(modelProtocol
          ? {
              model: {
                id: model.id,
                providerID: model.provider,
                protocol: modelProtocol,
                contextWindow: modelInfo?.limit.context ?? 0,
                structuredOutput: modelInfo?.api.protocolCapabilities?.structuredOutput ?? false,
              },
            }
          : {}),
        sources: selectionSources,
        queryAuthorization,
        runtimeFeatures,
      })
      // An interrupted turn must terminalize the activity it admitted; otherwise the leftover
      // `active` activity blocks every future queued admission on this Session. The per-turn scope
      // closes on interruption too, and settleActivity is idempotent. Explicit query authority is
      // released on every exit; a continuation admits and binds its own selection before tools run.
      yield* Effect.addFinalizer((exit) =>
        (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? contexts
              .settleActivity({ activityId: selectionAdmission.activityId, state: "interrupted" })
              .pipe(Effect.ignore)
          : Effect.void
        ).pipe(Effect.ensuring(queryAuthorization.remove(session.id).pipe(Effect.ignore))),
      )
      // W3.6 — after the selection is admitted, the selection graph evidence (refs + brief
      // revision/summary) is appended to the VOLATILE system tail (`deepagentSystem` + the request
      // system). `system.baseline` is never touched, so the cache prefix stays stable; the evidence
      // sits after the cache breakpoint and is also recorded in the prepared turn's volatile parts.
      // Gated by the W3 production flag: an explicit `=false` keeps the pre-W3 request byte-identical
      // (staged adapters + no evidence tail).
      const selectionEvidence = productionAdaptersEnabled(runtimeFeatures)
        ? yield* SessionRunnerCanonical.selectionGraphEvidence(db, selectionAdmission.selectionId)
        : undefined
      if (selectionEvidence !== undefined) {
        volatileSystemParts.push(selectionEvidence)
        request = LLM.updateRequest(request, { system: [...request.system, SystemPart.make(selectionEvidence)] })
      }
      // RI-126: the structured-output contract rides the volatile runtime tail (legacy
      // buildStructuredOutputRuntimeTail parity) — wire mode references the provider-enforced
      // schema, synthetic mode the StructuredOutput tool.
      if (jsonSchemaFormat?.schema !== undefined) {
        const structuredTail = wireStructuredOutput
          ? STRUCTURED_OUTPUT_WIRE_TAIL
          : structuredOutputSystemPrompt(jsonSchemaFormat.schema)
        volatileSystemParts.push(structuredTail)
        request = LLM.updateRequest(request, { system: [...request.system, SystemPart.make(structuredTail)] })
      }
      // §16.3 order 4: the receipt's history-window identity comes from the optional epoch bridge;
      // unwired compositions (or a lookup fault) keep the ContextEpoch revision exactly as before.
      // Identity stability: the read happens BEFORE compactIfNeeded and is replayed in the same
      // order after a crash, so the value is stable across exact retries; a compaction committed
      // within this turn rebuilds the prepared turn (new request input) rather than reusing this
      // identity, and the single-owner invariant rules out a concurrent epoch advance.
      const historyPromptEpoch =
        (historyEpochLookup
          ? yield* historyEpochLookup(session.id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined) ?? system.revision
      if (
        yield* compaction.compactIfNeeded({
          sessionID: session.id,
          entries,
          model,
          request,
          userMessageID: receiptUserMessageID,
          historyPromptEpoch,
          ownerMode: parityCampaign ? "shadow_v2" : "v2",
          admission: selectionAdmission,
        })
      )
        return yield* Effect.die(rebuildPreparedTurn(undefined, currentStep))
      // Unknown-context-limit host guard (legacy `requestBudget` parity): with no physical limit the
      // estimate is the only budget line; with a known limit, pre-turn compaction above already gated.
      const requestBudget = PreparedProviderTurn.budget(
        model,
        Token.estimate(
          JSON.stringify({
            system: request.system,
            messages: request.messages,
            tools: toolDefinitions,
            toolChoice: request.toolChoice,
          }),
        ),
      )
      // One recoverable boundary: canonical attempt + V2 receipt are created and bound atomically.
      const requestInputHash = Hash.sha256(
        CanonicalJson.stringify({
          ...LLMRequest.input(request),
          model: {
            id: request.model.id,
            provider: request.model.provider,
          },
        }),
      )
      const providerReceipt = (yield* SessionRunnerCanonical.commitTurn({
        db,
        contexts,
        sessionID: session.id,
        admission: selectionAdmission,
        receipt: {
          sessionId: session.id,
          userMessageId: receiptUserMessageID,
          historyPromptEpoch,
          historySourceEndMessageId: context.at(-1)?.id,
          requestInputHash,
          providerId: model.provider,
          modelId: model.id,
          protocol: model.route.protocol,
          ownerMode: parityCampaign ? "shadow_v2" : "v2",
        },
        ownerToken: yield* providerTurns.currentOwnerToken(),
      })).receipt
      // R4 — pricing belongs to the Location catalog and is an explicit runner dependency. A
      // missing catalog model keeps cost 0 rather than guessing, but a composition can no longer
      // silently omit the catalog service and disable accounting for every turn.
      const pricing = yield* catalog.model.get(ProviderV2.ID.make(model.provider), ModelV2.ID.make(model.id)).pipe(
        Effect.map((info) => info.cost[0]),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        ...(pricing
          ? {
              costOf: (stepTokens: { input: number; output: number; cache: { read: number; write: number } }) => {
                const per = (count: number, rate: number) => (Math.max(0, count) / 1e6) * rate
                return (
                  per(stepTokens.input, pricing.input) +
                  per(stepTokens.output, pricing.output) +
                  per(stepTokens.cache.read, pricing.cache.read) +
                  per(stepTokens.cache.write, pricing.cache.write)
                )
              },
            }
          : {}),
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      const baseSettleTool: ToolRegistry.Materialization["settle"] = stepLimitReached
        ? () =>
            Effect.succeed({
              result: { type: "error", value: "Tools are disabled after the maximum agent steps" },
            })
        : toolMaterialization.settle
      // Durable tool-effect authority: admission is committed before the tool body can run. A
      // matching terminal row is appended only after settlement. Therefore a crash between the
      // two leaves durable unknown-outcome evidence that startup recovery can quarantine without
      // replaying the call. The registry classifies a closed read-only allowlist; unknown/custom
      // actions remain mutating so recovery never undercounts a newly registered side effect.
      const admitToolEffect = (input: Parameters<ToolRegistry.Materialization["settle"]>[0]) => {
        const attemptId = providerReceipt.providerAttemptId
        if (attemptId === undefined) return Effect.die("tool effect admission requires a bound provider attempt")
        return toolEffects
          .admit({
            sessionId: input.sessionID,
            providerAttemptId: attemptId,
            receiptId: providerReceipt.receiptId,
            toolCallId: input.call.id,
            toolName: input.call.name,
            effectKind: toolMaterialization.effectKind(input.call.name),
            ownerToken: providerReceipt.ownerToken,
            now: Date.now(),
          })
          .pipe(Effect.orDie)
      }
      const recordToolEffect = (
        input: Parameters<ToolRegistry.Materialization["settle"]>[0],
        state: "settled" | "failed",
        result: unknown,
        errorCode: string | undefined,
      ) => {
        const attemptId = providerReceipt.providerAttemptId
        if (attemptId === undefined) return Effect.die("tool effect requires a bound provider attempt")
        // Permission grant evidence: when the composition wires the V2 permission capability,
        // bind the first grant for this call onto the effect row. A lookup failure records the
        // effect grant-less rather than losing the settlement evidence (fail-closed but not
        // evidence-destroying).
        const lookupGrant = permissionGrantLookup
          ? permissionGrantLookup({
              sessionID: input.sessionID,
              toolCallID: input.call.id,
              toolName: input.call.name,
            }).pipe(
              Effect.map((grants) => {
                const first = grants[0]
                return first === undefined
                  ? {}
                  : {
                      grant: {
                        receiptId: first.receiptID,
                        ownerId: first.ownerID,
                        state: first.state,
                        version: first.version,
                      },
                    }
              }),
              // The seam's error channel is never, so a wired lookup can only fail by defect;
              // catch the full cause so a broken lookup degrades to grant-less evidence instead
              // of destroying the settlement record.
              Effect.catchCause(() => Effect.succeed({})),
            )
          : Effect.succeed({})
        return lookupGrant.pipe(
          Effect.flatMap((grantEvidence) =>
            toolEffects.record({
              sessionId: input.sessionID,
              providerAttemptId: attemptId,
              receiptId: providerReceipt.receiptId,
              toolCallId: input.call.id,
              toolName: input.call.name,
              effectKind: toolMaterialization.effectKind(input.call.name),
              state,
              outcomeHash: Hash.sha256(CanonicalJson.stringify(result)),
              ...(errorCode === undefined ? {} : { errorCode }),
              ...grantEvidence,
              ownerToken: providerReceipt.ownerToken,
              now: Date.now(),
            }),
          ),
          Effect.orDie,
        )
      }
      // Only typed settlement failures record a `failed` row. Defects and interrupts leave no
      // row: the enclosing turn receipt quarantines indeterminate, which is the recovery
      // authority for unknown outcomes (`tapError` observes typed errors only and never
      // captures defects or interrupts).
      // BUG-010/RI-127: consecutive plan protocol violations already durable in history seed
      // this turn's budget (legacy restorePlanProtocolFailures parity); in-turn plan
      // settlements keep counting from there, and the second consecutive violation arms turn
      // termination below.
      let planConsecutiveViolations = countPlanProtocolViolations(context)
      let planProtocolTerminal: { readonly ordinal: number; readonly code: string } | undefined
      const planResultMetadata = new Map<string, Record<string, unknown>>()
      const observePlanSettlement = (
        call: { readonly id: string; readonly name: string },
        settlement: Effect.Success<ReturnType<ToolRegistry.Materialization["settle"]>>,
      ): Effect.Success<ReturnType<ToolRegistry.Materialization["settle"]>> => {
        if (call.name !== "plan") return settlement
        const failed = settlement.result.type === "error"
        const structured = "output" in settlement ? settlement.output?.structured : undefined
        const outcome = failed ? ("invalid" as const) : planProtocolOutcomeOf(structured)
        if (outcome === undefined || outcome === "success") {
          planConsecutiveViolations = 0
          return settlement
        }
        planConsecutiveViolations += 1
        const ordinal = planConsecutiveViolations
        const code = failed ? undefined : planErrorCodeOf(structured)
        planResultMetadata.set(call.id, {
          protocol: outcome,
          attempt_ordinal: ordinal,
          ...(code === undefined ? {} : { error_code: code }),
        })
        if (ordinal >= PLAN_PROTOCOL_MAX_ATTEMPTS)
          planProtocolTerminal = { ordinal, code: code ?? outcome }
        // §7.5 contract: the model sees which attempt this was (first error is correctable,
        // second terminates) — append the ordinal to the result text exactly like the legacy
        // processor's "[Plan attempt N of 2]" suffix.
        const suffix = `\n\n[Plan attempt ${ordinal} of ${PLAN_PROTOCOL_MAX_ATTEMPTS}]`
        if (failed)
          return typeof settlement.result.value === "string"
            ? { ...settlement, result: { ...settlement.result, value: settlement.result.value + suffix } }
            : settlement
        if (!("output" in settlement) || settlement.output === undefined) return settlement
        const lastText = settlement.output.content.findLastIndex((item) => item.type === "text")
        if (lastText === -1) return settlement
        return {
          ...settlement,
          result:
            settlement.result.type === "text" && typeof settlement.result.value === "string"
              ? { ...settlement.result, value: settlement.result.value + suffix }
              : settlement.result,
          output: {
            ...settlement.output,
            content: settlement.output.content.map((item, index) =>
              index === lastText && item.type === "text" ? { ...item, text: item.text + suffix } : item,
            ),
          },
        }
      }
      const settleTool: ToolRegistry.Materialization["settle"] = (input) =>
        Effect.gen(function* () {
          yield* admitToolEffect(input)
          // W2-V2: the plan gate runs BEFORE the tool executes — a block returns a synthetic
          // settled result carrying the correction template (mirroring the V1 wrapper's soft
          // tool-result block), a grace-release pass prepends the reminder to the real output.
          if (toolSettleGate) {
            const gate = yield* toolSettleGate({
              sessionID: input.sessionID,
              toolName: input.call.name,
              args: input.call.input,
            })
            // G0: consult/block/release counters ride the same gate decision (the reminder text is
            // the release signal — a block never carries one).
            turnObservability.recordGateConsult(
              gate.kind === "block",
              gate.kind === "pass" && gate.reminder !== undefined,
              input.sessionID,
            )
            if (gate.kind === "block") {
              // A gated call settles as a typed error RESULT carrying the correction template —
              // the model sees the block text as the tool's outcome, exactly like the V1 wrapper's
              // soft block (never a typed settlement failure, which would poison effect evidence).
              const blocked = { result: { type: "error" as const, value: gate.output } }
              yield* recordToolEffect(input, "settled", blocked.result, undefined)
              return blocked
            }
            if (gate.reminder) {
              const settlement = yield* baseSettleTool(input)
              yield* recordToolEffect(input, "settled", settlement.result, undefined)
              // ToolOutput is {structured, content[]}; prepend the reminder as the leading text
              // part so the model sees it ahead of the real output in the same tool result.
              if ("output" in settlement && settlement.output) {
                const content = settlement.output.content
                const firstText = content.findIndex((item) => item.type === "text")
                return {
                  ...settlement,
                  output: {
                    ...settlement.output,
                    content:
                      firstText === -1
                        ? [{ type: "text" as const, text: gate.reminder }, ...content]
                        : content.flatMap((item, index) =>
                            index === firstText && item.type === "text"
                              ? [{ type: "text" as const, text: gate.reminder + "\n\n" + item.text }]
                              : [item],
                          ),
                  },
                }
              }
              return settlement
            }
          }
          // Tool bodies surface path-argument validation as die defects (path escapes the
          // location, not-a-file, unknown reference...); V1 always surfaced those to the model as
          // tool error results. Convert exactly those — by message prefix, so control-flow
          // defects (question rejection, turn transitions) keep their interrupt semantics — and
          // record the failure evidence like the typed-error path.
          return yield* baseSettleTool(input).pipe(
            Effect.tap((settlement) => recordToolEffect(input, "settled", settlement.result, undefined)),
            Effect.tapError(() =>
              recordToolEffect(
                input,
                "failed",
                { type: "error", value: "settlement_failed" },
                "tool_settlement_failed",
              ),
            ),
            Effect.catchDefect((defect) =>
              defect instanceof Error && TOOL_PATH_DEFECT.test(defect.message)
                ? recordToolEffect(
                    input,
                    "failed",
                    { type: "error", value: defect.message },
                    "tool_settlement_failed",
                  ).pipe(Effect.as({ result: { type: "error" as const, value: defect.message } }))
                : Effect.die(defect),
            ),
            Effect.map((settlement) => observePlanSettlement(input.call, settlement)),
          )
        })
      let overflowFailure: ProviderErrorEvent | undefined
      let structuredCapture: { readonly callID: string; readonly value: unknown } | undefined
      const providerEvents: LLMEvent[] = []
      // Any rebuild after admit must terminalize the admitted receipt first: an epoch that is no
      // longer current invalidates the prepared request, and a leftover `preparing` receipt would
      // otherwise survive the rebuild as an orphan the recovery classifier cannot attribute. The
      // abandon is CAS-bound to `preparing`, so losing it means the receipt already moved; a failed
      // terminalize is logged but must not block the rebuild itself.
      const terminalizePreDispatch = (errorCode: string) =>
        providerTurns.abandon(providerReceipt, errorCode).pipe(
          Effect.tapCause((cause) =>
            Effect.logWarning("failed to terminalize preparing receipt before rebuild", {
              cause: Cause.pretty(cause),
              errorCode,
            }),
          ),
          Effect.ignore,
          Effect.uninterruptible,
        )
      // RI-132: the pre-dispatch host guard is the runner's only `budget.decision` consumption
      // point. An unknown/invalid context limit never reaches the provider when the estimated
      // request crosses the guard — the receipt terminalizes failed (no prepared turn, no
      // dispatch) and the turn ends with a typed assistant error instead of a provider 4xx.
      if (requestBudget.decision === "unavailable") {
        const reason = requestBudget.reason ?? "context_limit_unknown"
        yield* terminalizePreDispatch(reason)
        yield* publish(
          LLMEvent.providerError({
            message:
              reason === "context_limit_invalid"
                ? "Provider context limit is invalid; correct the endpoint/model configuration before continuing."
                : "Provider context limit is unknown; configure an endpoint/model override before continuing this long request.",
            retryable: false,
          }),
        )
        return { needsContinuation: false, step: currentStep, activityId: selectionAdmission.activityId }
      }
      const epochCurrent = yield* SessionContextEpoch.current(db, session.id, agent.id, system.revision).pipe(
        Effect.onInterrupt(() => terminalizePreDispatch("turn_aborted_before_dispatch")),
      )
      if (!epochCurrent) {
        yield* terminalizePreDispatch("epoch_mismatch_rebuild")
        return yield* Effect.die(rebuildPreparedTurn(undefined, currentStep))
      }
      // C2-04/B2 residual dispatch seam: never dispatch a drifted attempt. When the receipt already
      // carries a bound protocol attempt identity (an exact-retry re-seal), the CURRENT config must
      // still resolve to the SAME identity; a mismatch means route/protocol/origin/capability/lowering
      // changed after the attempt was bound, so a dispatch would violate design §2.3. Rebuild from the
      // current config (the established turnaround) and leave the stale attempt un-dispatched.
      const boundIdentityHash = providerReceipt.preparedTurn?.protocol_attempt_identity_hash
      if (
        protocolIdentity !== undefined &&
        boundIdentityHash !== undefined &&
        configDrift(protocolIdentity, boundIdentityHash)
      ) {
        yield* terminalizePreDispatch("config_drift_rebuild_required")
        return yield* Effect.die(rebuildPreparedTurn(undefined, currentStep))
      }
      // C4-08 session-side assembly (design §4.1 step 5): the prepared attempt carries the
      // capability catalog/load snapshot restored from the DURABLE load receipts of THIS
      // session, so the attempt identity (attemptIdentityHash) covers the loaded-body facts
      // even though bodies are not kept in the system prefix (design §7.5). W4.1/P1-1: the
      // durable table is the restoration authority (the in-process kernel cache is
      // process-local, so it would lose the loaded facts on a restart); `capabilityLoadFactOf`
      // derives the snapshot fact from the frozen receipt, matching the kernel record shape.
      // W15 (P4): the durable restore is snapshot-scoped — only receipts recorded under the
      // CURRENT catalog snapshot belong to this epoch's loaded facts (mixed-epoch rows would
      // rebuild a snapshot digest that never existed).
      const sessionLoadFacts = (yield* recordedCapabilityLoadsForSession(
        db,
        session.id,
        CapabilitySnapshot.defaultCatalogSnapshotId(),
      )).map(capabilityLoadFactOf)
      const providerStream = V2ProviderTurn.stream({
        service: providerTurns,
        receipt: providerReceipt,
        prepare: (wireRequestHash) => {
          // G0: record the Gamma prompt-composition breakdown at the one place every dispatched
          // turn passes through. Char-estimated (no LLM call), bounded logging, zero behavior change.
          // REVIEW FIX (double counting): the control message is measured ONCE, as controlMessage —
          // historyMessages below is the durable-history lowering WITHOUT the appended control tail,
          // and volatileSystemParts excludes it too (it rides the message array, not the system).
          const controlMessage = deepagentPrompt?.volatileRoundContext ?? governedPlanContext
          turnObservability.recordPrepared(
            providerReceipt.providerTurnSeq,
            turnObservability.preparedParts({
              stableSystemParts,
              volatileSystemParts,
              historyMessages: toLLMMessages(historyRequestMessages, model),
              controlMessage,
            }),
            sessionID,
          )
          return V2ProviderTurn.prepare(
            {
              receipt: providerReceipt,
              stableSystemParts,
              volatileSystemParts: PreparedProviderTurn.mergeSystemParts(
                [deepagentPrompt?.volatileRoundContext ?? governedPlanContext],
                volatileSystemParts,
              ),
              historyMessages: requestMessages,
              toolDefinitions,
              toolIDs: toolDefinitions.map((tool) => tool.name),
              toolRegistryIDs: toolMaterialization.registeredIDs,
              toolPermissionFilteredIDs: toolMaterialization.permissionFilteredIDs,
              toolFinalOfferedIDs: toolDefinitions.map((tool) => tool.name),
              toolChoice: stepLimitReached ? "none" : syntheticStructuredOutput ? "required" : null,
              toolResultReferences: context.flatMap((message) =>
                message.type === "assistant"
                  ? message.content.flatMap((part) =>
                      part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")
                        ? [part.id]
                        : [],
                    )
                  : [],
              ),
              samplingMaxOutputTokens: request.generation?.maxTokens,
              budget: requestBudget,
              userMessageID: receiptUserMessageID,
              activityID: providerReceipt.activityId,
              providerTurnSeq: providerReceipt.providerTurnSeq,
              contextSelectionID: selectionAdmission.selectionId,
              contextProjectionHash: selectionAdmission.projectionHash,
              contextReadiness: selectionAdmission.readiness ?? "unavailable",
              contextSelectedRefs: selectionAdmission.selectedRefs ?? [],
              toolCapability:
                modelInfo === undefined ? "unknown" : modelInfo.capabilities.tools ? "supported" : "unsupported",
              toolLoweringOutcome: modelInfo?.capabilities.tools === false ? "omitted_no_support" : "ok",
              ...(protocolIdentity === undefined ? {} : { protocolAttemptIdentity: protocolIdentity }),
              ...(protocolIdentityHash === undefined ? {} : { protocolAttemptIdentityHash: protocolIdentityHash }),
              // W4.1/P1-1: the snapshot facts are read from the DURABLE table once per
              // dispatch (before the prepare callback runs) — same-process loads converge on
              // the same rows they wrote, and a restarted process restores them from the table.
              capabilitySnapshot: CapabilitySnapshot.capabilitySnapshotRefFor(sessionLoadFacts),
            },
            wireRequestHash,
          )
        },
        stream: llm.stream(request).pipe(Stream.tap((event) => Effect.sync(() => providerEvents.push(event)))),
        outcomeArtifact: () => providerEvents,
        errorCode: (error) => `provider_stream_failed:${Hash.sha256(String(error)).slice(0, 16)}`,
        ...(integrityIdentity === undefined ? {} : { integrityIdentity }),
        // Context overflow is rejected by the provider before any generation or tool call, so it is a
        // proven-terminal failure that may settle as `failed` and drive overflow compaction recovery.
        // Any other post-dispatch typed failure cannot prove a terminal outcome and stays
        // indeterminate/recovery_required.
        terminalProviderFailure: isContextOverflowFailure,
      })
      const settledProviderStream = providerStream.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            // RI-126: the synthesized StructuredOutput call IS the turn's final answer — capture
            // its input as the structured value and acknowledge it with the legacy success text
            // instead of settling through the registry (it is advertised, never registered).
            if (syntheticStructuredOutput && event.name === STRUCTURED_OUTPUT_TOOL_NAME) {
              structuredCapture = { callID: event.id, value: event.input }
              yield* publish(
                LLMEvent.toolResult({
                  id: event.id,
                  name: event.name,
                  result: { type: "text", value: STRUCTURED_OUTPUT_SUCCESS_TEXT },
                  output: { structured: {}, content: [{ type: "text", text: STRUCTURED_OUTPUT_SUCCESS_TEXT }] },
                }),
              )
              return
            }
            if (!stepLimitReached) needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                settleTool({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) => {
                  const planMetadata = planResultMetadata.get(event.id)
                  return publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                      // The plan protocol outcome rides the provider-metadata channel onto the
                      // durable Tool.Success/Failed event (and from there onto the V1 wire part
                      // metadata), mirroring the legacy plan part metadata contract.
                      ...(planMetadata === undefined ? {} : { providerMetadata: { plan: planMetadata } }),
                    }),
                    settlement.outputPaths ?? [],
                  )
                }),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(settledProviderStream).pipe(Effect.exit, Effect.map(classifyProviderStreamAbort))
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(
              recoverOverflow({
                sessionID: session.id,
                entries,
                model,
                request,
                userMessageID: receiptUserMessageID,
                historyPromptEpoch,
                ownerMode: parityCampaign ? "shadow_v2" : "v2",
                admission: selectionAdmission,
              }),
            ))
          ) {
            turnObservability.recordCompaction(sessionID)
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          }
          const llmFailure = failure instanceof LLMError ? failure : undefined
          // The executor's own retryable contract is the proof that re-sending is safe: 429/5xx are
          // definite provider rejections (no generation), and a transport failure counts only when
          // it predates dispatch. Anything user-visible already published would duplicate output,
          // and every other failure keeps the terminal path (an unknown post-dispatch outcome stays
          // quarantined for recovery rather than being silently replayed).
          if (
            llmFailure !== undefined &&
            llmFailure.retryable &&
            !publisher.hasAssistantStarted() &&
            providerRetry < MAX_PROVIDER_ATTEMPT_RETRIES
          )
            return yield* Effect.die(
              retryAttempt(currentStep, providerRetry, "provider_rejection", llmFailure.retryAfterMs),
            )
          // A transport failure after dispatch has an unknown provider outcome even when no local
          // assistant event was observed. The receipt is already quarantined indeterminate by the
          // provider-turn boundary; never hide that uncertainty by opening a fresh physical attempt.
          if (overflowFailure) yield* publish(overflowFailure)
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(
              events.publish(SessionEvent.Step.Failed, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                error: { type: "unknown", message: llmFailure.reason.message },
              }),
            )
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
          // UPD-002/RI-126: a captured StructuredOutput call ends the turn — the value persists
          // on the assistant (StructuredCaptured) and the drain stops without another provider
          // turn (legacy "no further actions are taken after calling it" parity; finish stays
          // the provider's "tool-calls").
          if (structuredCapture) {
            yield* withPublication(
              events.publish(SessionEvent.StructuredCaptured, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                value: structuredCapture.value,
              }),
            )
            return { needsContinuation: false, step: currentStep, activityId: selectionAdmission.activityId }
          }
          // BUG-010/RI-127 plan protocol termination (legacy PlanProtocolViolationError
          // parity): the second consecutive model plan failure ends the turn with a typed
          // assistant error instead of opening another provider turn. V2 folds the name/code
          // into the UnknownError message on the wire.
          if (planProtocolTerminal) {
            yield* withPublication(
              events.publish(SessionEvent.Step.Failed, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                error: {
                  type: "unknown",
                  message:
                    `PlanProtocolViolation: plan protocol violation budget exhausted after ` +
                    `${PLAN_PROTOCOL_MAX_ATTEMPTS} consecutive model plan failures ` +
                    `(attempt ${planProtocolTerminal.ordinal} of ${PLAN_PROTOCOL_MAX_ATTEMPTS}, code: ${planProtocolTerminal.code}).`,
                },
              }),
            )
            return { needsContinuation: false, step: currentStep, activityId: selectionAdmission.activityId }
          }
          // OUTPUT soft-landing (V4.0.1 P0b, legacy loop parity): a length-capped turn with no
          // local tool call continues instead of ending — a truncated local tool input is first
          // terminalized as a typed error part (never executed), then a synthetic nudge is
          // appended and the drain runs one more provider turn. At the continuation cap the turn
          // simply ends with the length-finished assistant (no failure finalization in V2).
          if (
            stream._tag === "Success" &&
            !publisher.hasProviderError() &&
            !needsContinuation &&
            outputSoftLandingEnabled() &&
            providerEvents.findLast((event) => event.type === "step-finish")?.reason === "length" &&
            countOutputContinuations(context) < outputContinuationMax()
          ) {
            const truncatedInput = publisher.hasUnsettledLocalTool()
            if (truncatedInput)
              yield* withPublication(publisher.failUnsettledTools("Tool input was incomplete and was not executed"))
            yield* events.publish(SessionEvent.Synthetic, {
              sessionID: session.id,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              text: truncatedInput ? TOOL_INPUT_CONTINUE_TAIL_TEXT : OUTPUT_CONTINUE_TAIL_TEXT,
            })
            return {
              needsContinuation: true,
              step: currentStep,
              activityId: selectionAdmission.activityId,
            }
          }
          // UPD-002/RI-126 wire mode: the provider enforced the schema via text.format, so the
          // final assistant TEXT carries the JSON value. Parse and capture it; an invalid body
          // ends the turn with a typed error (legacy retried with a correction reminder up to
          // format.retryCount — that retry loop is a documented residual gap in V2).
          if (wireStructuredOutput && stream._tag === "Success" && !publisher.hasProviderError() && !needsContinuation) {
            const wireText = providerEvents
              .flatMap((event) => (event.type === "text-delta" ? [event.text] : []))
              .join("")
              .trim()
            const parsed =
              wireText.length > 0 ? Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(wireText) : Option.none()
            if (Option.isSome(parsed)) {
              yield* withPublication(
                events.publish(SessionEvent.StructuredCaptured, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: yield* publisher.startAssistant(),
                  value: parsed.value,
                }),
              )
              return { needsContinuation: false, step: currentStep, activityId: selectionAdmission.activityId }
            }
            if (wireText.length > 0) {
              yield* withPublication(
                events.publish(SessionEvent.Step.Failed, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: yield* publisher.startAssistant(),
                  error: { type: "unknown", message: "StructuredOutputError: wire structured output is not valid JSON." },
                }),
              )
              return { needsContinuation: false, step: currentStep, activityId: selectionAdmission.activityId }
            }
          }
          if (parityCampaign && providerReceipt)
            yield* providerTurns.recordParityForReceipt({ campaign: parityCampaign, receipt: providerReceipt })
          // G0: settle the turn report from the provider's own events — usage and finish from the
          // step-finish, tool calls counted from the emitted tool-call events. Same data the
          // publisher persisted; recording it here keeps observability in one place per turn.
          const stepFinish = providerEvents.findLast((event): event is Extract<LLMEvent, { type: "step-finish" }> =>
            event.type === "step-finish",
          )
          const reason = stepFinish?.reason
          const finish: "stop" | "tool-calls" | "error" | "other" = publisher.hasProviderError()
            ? "error"
            : reason === "stop"
              ? "stop"
              : reason === "tool-calls"
                ? "tool-calls"
                : "other"
          turnObservability.recordTurn(
            {
              seq: providerReceipt.providerTurnSeq,
              finish,
              toolCalls: providerEvents.filter((event) => event.type === "tool-call").length,
              usage: {
                input: stepFinish?.usage?.nonCachedInputTokens ?? 0,
                output: stepFinish?.usage?.visibleOutputTokens ?? 0,
                reasoning: stepFinish?.usage?.reasoningTokens ?? 0,
                cacheRead: stepFinish?.usage?.cacheReadInputTokens ?? 0,
                cacheWrite: stepFinish?.usage?.cacheWriteInputTokens ?? 0,
              },
            },
            sessionID,
          )
          // G3: fold this turn's history-projection deltas into the drain rollup, then rearm
          // the counters for the next turn's assembly.
          const projection = SessionHistoryProjection.projectionSummary()
          if (projection.truncated > 0 || projection.savedChars > 0) {
            turnObservability.recordProjection(projection.truncated, projection.savedChars, sessionID)
            SessionHistoryProjection.projectionStats.reset()
          }
          return {
            needsContinuation: !publisher.hasProviderError() && needsContinuation,
            step: currentStep,
            activityId: selectionAdmission.activityId,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      providerRetry?: number,
    ) => Effect.Effect<
      { readonly needsContinuation: boolean; readonly step: number; readonly activityId?: string },
      RunError
    >

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            // A retryable failure after a compaction-recovering attempt still retries through the
            // plain path (fresh attempt, shared budget) rather than leaking the transition defect.
            if (defect.transition._tag === "RetryAttempt")
              return yield* runTurn(sessionID, promotion, defect.transition.step, defect.transition.retry + 1)
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(
              sessionID,
              defect.transition.promotion,
              defect.transition.step ?? step,
            )
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, providerRetry = 0) {
      return yield* runTurnAttempt(
        sessionID,
        promotion,
        step,
        compaction.compactAfterOverflow,
        providerRetry,
      ).pipe(
        // A lease-fenced attempt is a rotation artefact: the fenced owner stalled past its lease, so
        // the successor generation owns the session now. Re-open a fresh attempt instead of ending
        // the run — the admission guard admits it only when the fenced attempt provably never
        // reached the provider, so an unknown post-dispatch outcome still stops for recovery.
        Effect.catch((error) =>
          error instanceof V2ProviderTurn.ConflictError &&
          error.reason === "v2_provider_owner_lease_not_live" &&
          providerRetry < MAX_PROVIDER_ATTEMPT_RETRIES
            ? Effect.die(retryAttempt(step, providerRetry, "owner_fenced"))
            : Effect.fail(error),
        ),
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "RetryAttempt") {
              const delay = Math.min(
                defect.transition.retryAfterMs ?? PROVIDER_RETRY_BASE_DELAY_MS * 2 ** defect.transition.retry,
                PROVIDER_RETRY_MAX_DELAY_MS,
              )
              yield* Effect.logWarning(
                defect.transition.cause === "owner_fenced"
                  ? "provider owner lease fenced this attempt before dispatch; retrying on a fresh attempt"
                  : "provider rejected the attempt before generating; retrying",
                {
                  retry: defect.transition.retry + 1,
                  maxRetries: MAX_PROVIDER_ATTEMPT_RETRIES,
                  delayMs: delay,
                },
              )
              yield* Effect.sleep(Duration.millis(delay))
              turnObservability.recordRetry(sessionID)
              return yield* runTurn(sessionID, promotion, defect.transition.step, defect.transition.retry + 1)
            }
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, defect.transition.promotion, defect.transition.step ?? step, providerRetry)
          }),
        ),
      )
    })

    // RI-18 native manual compaction: drain-only work driven by a durable request row. The summary
    // provider turn (one physical dispatch, full receipt contract) runs inside SessionCompaction;
    // this attempt owns admission, the request lifecycle, and the activity settle.
    const runManualCompaction = Effect.fn("SessionRunner.runManualCompaction")(function* (
      request: CompactionRequest.Request,
    ) {
      const parityCampaign = (yield* V2ProviderTurn.CurrentCampaign) ?? V2ProviderTurn.campaignFromEnv()
      const ownerCampaign = (yield* V2ProviderTurn.CurrentOwnerCampaign) ?? V2ProviderTurn.ownerCampaignFromEnv()
      if (!(yield* ownerAuthorization.authorize(db, ownerCampaign)))
        return yield* new V2ProviderTurn.ConflictError({ reason: "v2_owner_campaign_not_verified" })
      // Another drain already picked the request up (dispatched): the coordinator serializes
      // same-session drains, but a restarted process could observe a stale dispatched row — leave
      // it to recovery instead of dispatching a second summary.
      if (request.status !== "pending") return false
      const session = yield* getSession(request.session_id as SessionSchema.ID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const { model, info: modelInfo, provider: modelProvider } = yield* models.resolveRef(
        session,
        ProviderV2.ID.make(request.provider_id),
        ModelV2.ID.make(request.model_id),
      )
      const modelProtocolSelection = modelInfo ? resolveModelProtocol(modelInfo, modelProvider) : undefined
      const system = yield* SessionContextEpoch.prepare(
        db,
        events,
        loadSystemContext(agent, session, modelInfo?.capabilities.tools),
        session.id,
        session.location,
        agent.id,
      )
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const currentUserMessageID = context.findLast((message) => message.type === "user")?.id
      const latestReceipt = currentUserMessageID
        ? undefined
        : yield* db
            .select({ userMessageID: V2ProviderTurnReceiptTable.user_message_id, state: V2ProviderTurnReceiptTable.state })
            .from(V2ProviderTurnReceiptTable)
            .where(eq(V2ProviderTurnReceiptTable.session_id, session.id))
            .orderBy(desc(V2ProviderTurnReceiptTable.request_ordinal))
            .get()
            .pipe(Effect.orDie)
      if (
        latestReceipt &&
        ["preparing", "dispatching", "streaming", "indeterminate_after_crash"].includes(latestReceipt.state)
      )
        return yield* new V2ProviderTurn.UnsafeRetryError({ state: latestReceipt.state })
      const receiptUserMessageID = currentUserMessageID ?? latestReceipt?.userMessageID
      if (!receiptUserMessageID) {
        yield* CompactionRequest.settle(db, request.request_id, { status: "failed", outcome: "no_durable_identity" })
        return false
      }
      const historyPromptEpoch =
        (historyEpochLookup
          ? yield* historyEpochLookup(session.id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined) ?? system.revision
      const selectionAdmission = yield* SessionRunnerCanonical.admitSelection({
        db,
        contexts,
        sessionID: session.id,
        agent: agent.id,
        location: session.location,
        promotedInputIds: [],
        fallbackUserInputId: receiptUserMessageID,
        system: { baseline: system.baseline, revision: system.revision, baselineSeq: system.baselineSeq },
        historyEndMessageId: context.at(-1)?.id,
        ...(modelProtocolSelection?.protocol
          ? {
              model: {
                id: model.id,
                providerID: model.provider,
                protocol: modelProtocolSelection.protocol,
                contextWindow: modelInfo?.limit.context ?? 0,
                structuredOutput: modelInfo?.api.protocolCapabilities?.structuredOutput ?? false,
              },
            }
          : {}),
        sources: selectionSources,
        queryAuthorization,
        runtimeFeatures,
      })
      // An interrupted or failed attempt must terminalize its activity AND its request — a stale
      // `dispatched` row would block every later compaction on the session.
      yield* Effect.addFinalizer((exit) =>
        (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.all([
              contexts.settleActivity({ activityId: selectionAdmission.activityId, state: "interrupted" }),
              CompactionRequest.settle(db, request.request_id, { status: "recovery_required", outcome: "interrupted" }),
            ]).pipe(Effect.ignore)
          : Effect.void
        ).pipe(Effect.ensuring(queryAuthorization.remove(session.id).pipe(Effect.ignore))),
      )
      yield* CompactionRequest.markDispatched(db, request.request_id)
      const compacted = yield* compaction.compactAfterOverflow({
        sessionID: session.id,
        entries,
        model,
        request: LLM.request({ model, messages: [] }),
        userMessageID: receiptUserMessageID,
        historyPromptEpoch,
        ownerMode: parityCampaign ? "shadow_v2" : "v2",
        admission: selectionAdmission,
        reason: "manual",
      })
      yield* CompactionRequest.settle(db, request.request_id, {
        status: "settled",
        outcome: compacted === false ? "nothing_to_compact" : "compacted",
        ...(compacted === false || compacted.receiptID === null ? {} : { summaryReceiptID: compacted.receiptID }),
      })
      yield* contexts.settleActivity({ activityId: selectionAdmission.activityId, state: "settled" }).pipe(Effect.ignore)
      return compacted !== false
    })

    const run: typeof runDrain = (input) =>
      // G0: one rollup per drain chain. Effect.ensuring covers every exit — settled, failed, and
      // interrupted alike — so the report script always finds a summary for the drain it replays.
      // REVIEW FIX: the summary is emitted for THIS drain's session (state is session-scoped), and
      // pendingParts is cleared even when a turn early-returned without a provider receipt
      // (structured-output capture, plan terminal, soft-landing) so nothing leaks across drains.
      runDrain(input).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            turnObservability.emitTurnSummary(input.sessionID)
            turnObservability.clearPendingParts(input.sessionID)
          }),
        ),
      )

    const runDrain = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force?: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      // W1.1 — a goal_steer admission wakes the drain but is NOT a chat activity: it opens a
      // DRAIN-ONLY turn (no provider dispatch) that delivers the guidance to the active goal.
      const hasGoalSteer = !hasSteer && !hasQueue && (yield* SessionInput.hasPending(db, input.sessionID, "goal_steer"))
      // RI-18: a pending manual compaction request drives its own drain — the summary provider
      // turn runs inside SessionCompaction with the full receipt contract.
      const hasManualCompaction =
        !hasSteer && !hasQueue && !hasGoalSteer && (yield* CompactionRequest.pendingForSession(db, input.sessionID)) !== undefined
      if (input.force !== true && !hasSteer && !hasQueue && !hasGoalSteer && !hasManualCompaction) return
      const parityCampaign = (yield* V2ProviderTurn.CurrentCampaign) ?? V2ProviderTurn.campaignFromEnv()
      const ownerCampaign = (yield* V2ProviderTurn.CurrentOwnerCampaign) ?? V2ProviderTurn.ownerCampaignFromEnv()
      if (!(yield* ownerAuthorization.authorize(db, ownerCampaign)))
        return yield* new V2ProviderTurn.ConflictError({ reason: "v2_owner_campaign_not_verified" })
      // W0.5 (blocker-1): the parity exclusion compares the operator's EXPLICIT owner campaign
      // only — the runtime's auto-default (v2-owner-<InstallationVersion>) is the NORMAL production
      // posture and must not disable the shadow-parity verification run that intentionally sets
      // parity envs without an owner env.
      if (parityCampaign && V2ProviderTurn.ownerCampaignFromEnv())
        return yield* new V2ProviderTurn.ConflictError({ reason: "v2_owner_cannot_record_shadow_parity" })
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer
        ? "steer"
        : hasQueue
          ? "queue"
          : hasGoalSteer
            ? "goal_steer"
            : undefined
      let openActivity = input.force === true || hasSteer || hasQueue || hasGoalSteer || hasManualCompaction
      // W7: the settle hook references the PRIMARY activity of this drain chain (the trigger input),
      // so a multi-activity drain admits one learning run anchored on the prompt that opened it.
      let settledActivityId: string | undefined
      while (openActivity) {
        // RI-18: a pending manual compaction request is drain-only work — it runs its own summary
        // turn (one provider dispatch inside SessionCompaction) and never promotes chat inputs.
        const manualRequest = yield* CompactionRequest.pendingForSession(db, input.sessionID)
        if (manualRequest === undefined) yield* CompactionRequest.settleOrphaned(db, input.sessionID)
        if (manualRequest !== undefined) {
          yield* runManualCompaction(manualRequest).pipe(Effect.scoped)
          openActivity = yield* SessionInput.hasPending(db, input.sessionID, "queue")
          promotion = openActivity ? "queue" : undefined
          continue
        }
        let needsContinuation = true
        let step = 1
        let activityId: string | undefined
        // The drain ceiling honors the session agent's configured step budget; the constant is
        // only the fallback. A configured budget that the loop ignored killed long serial-agent
        // runs (one tool per turn) at the default 25 regardless of `agent.steps`. The AgentV2
        // registry is populated only by embedded compositions (the app runtime registers no
        // agents there), so the config layer is the production source of the budget.
        const runSession = yield* store.get(input.sessionID)
        const runAgent = runSession === undefined ? undefined : yield* agents.select(runSession.agent)
        const configAgents = Config.latest(yield* config.entries(), "agents")
        const configSteps = configAgents?.[runSession?.agent ?? "auto"]?.steps
        const stepCeiling = runAgent?.info?.steps ?? configSteps ?? MAX_STEPS
        let attempts = 0
        while (attempts < stepCeiling) {
          const result = yield* runTurn(input.sessionID, promotion, step)
          needsContinuation = result.needsContinuation
          // A steer promotion restarts the chain's step numbering; the budget restarts with it
          // (the pre-configured-era loop's MAX_STEPS headroom made this implicit; an explicit
          // budget must reset on promotion, not just on new activities).
          if (result.step < step) attempts = 0
          step = result.step + 1
          promotion = "steer"
          activityId = result.activityId ?? activityId
          attempts += 1
          if (needsContinuation) continue
          if (yield* SessionInput.hasPending(db, input.sessionID, "steer")) {
            needsContinuation = true
            attempts = 0
          }
          if (!needsContinuation) break
        }
        if (needsContinuation)
          return yield* new StepLimitExceededError({ sessionID: input.sessionID, limit: stepCeiling })
        // One activity's turn chain is complete: settle it so a queued input may open the next
        // activity. Settle is idempotent and best-effort; recovery owns activities a drain never
        // settles. Interrupted turns settle their own activity through the per-turn scope
        // finalizer in runTurnAttempt.
        if (activityId !== undefined) {
          settledActivityId = settledActivityId ?? activityId
          yield* Effect.uninterruptible(contexts.settleActivity({ activityId, state: "settled" })).pipe(Effect.ignore)
        }
        openActivity = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = openActivity ? "queue" : undefined
      }
      if (docsSyncEnabled)
        yield* ProjectDocsSync.afterSessionNow({
          sessionID: input.sessionID,
          root: location.project.directory,
          enabled: true,
          store,
          fs,
          git: gitService,
        })
      // W7: settle-triggered learning. Best-effort and non-blocking for the turn: a hook failure
      // must never fail a settled drain (same posture as the docs sync tail).
      if (onSessionSettled !== undefined)
        yield* onSessionSettled(
          {
            sessionID: input.sessionID,
            workspacePath: location.project.directory,
            ...(settledActivityId === undefined ? {} : { activityId: settledActivityId }),
          },
          gateway,
        ).pipe(Effect.ignore)
    })

    return Service.of({
      run,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(V2ProviderTurn.ownerAuthorizationLayer))
