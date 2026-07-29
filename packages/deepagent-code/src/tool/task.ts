import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { Identifier } from "@/id/id"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import {
  deriveSubagentSessionPermission,
  filterPrimaryToolsForSubagent,
  subagentIsWriteType,
  resolveSessionDepth,
  admitChildOrFail,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_DEPTH_META_KEY,
} from "../agent/subagent-permissions"
import { evaluate as evaluatePermission } from "../permission"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Duration, Effect, Exit, Option, Schedule, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@deepagent-code/core/database/database"
import { Worktree } from "@/worktree"
import { Git } from "@/git"
import { Orchestration } from "../agent/schema/orchestration"
import { Orchestration as CoreOrchestration } from "@deepagent-code/core/deepagent/orchestration"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { downgradeOneLevel, type AgentMode } from "@deepagent-code/core/deepagent/mode"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { TaskConcurrency } from "./task-concurrency"
import Ajv from "ajv"
import { KeyedMutex } from "@deepagent-code/core/effect/keyed-mutex"
import { Log } from "@deepagent-code/core/util/log"
import { FSUtil } from "@deepagent-code/core/fs-util"
import {
  admitTaskRun,
  claimTaskProvisioning,
  deliverTaskNotifications,
  getActiveTaskRunByChild,
  getTaskRun,
  isTerminal,
  markTaskFinalized,
  markTaskFinalizing,
  markTaskResearchCompleted,
  renewTaskRunLease,
  settleTaskRun,
  spawnTaskTakeover,
  startTaskRun,
  type ErrorData,
  type Run as DurableTaskRun,
} from "./task-run"

const taskLog = Log.create({ service: "tool.task" })

/**
 * L3 (v3.8.0 §L3): resolve the task tool's optional `output_schema` param into a raw JSON Schema
 * object suitable for the structured-output path (PromptInput.format json_schema).
 *
 * Accepts: a named orchestration schema, the alias "default"/"auto" (mapped to the subagent's
 * natural default schema), or a raw JSON Schema object passed through verbatim.
 *
 * Task 6 (§5 auto-mount): when the caller does NOT pass an explicit `output_schema` AND the
 * subagent is one of the native orchestration subagents that has a natural default
 * (`DEFAULT_OUTPUT_SCHEMA_BY_AGENT` — reviewer→ReviewResult, researcher→ResearchResult), the
 * default schema is applied automatically. This makes the native research/review subagents return
 * a structured, deterministically-parsed result by default instead of depending on the model to
 * remember to pass a schema. Precedence: an EXPLICIT schema (named / alias / raw object) always
 * wins over the auto-mounted default. Any other subagent with no registered default keeps the
 * unchanged free-text extraction path (returns undefined).
 */
export function resolveOutputSchema(
  outputSchema: string | Record<string, unknown> | undefined,
  subagentType: string,
): Record<string, unknown> | undefined {
  if (outputSchema === undefined) {
    // Auto-mount: native researcher/reviewer default to their structured schema even when the
    // model omitted `output_schema`. Subagents without a registered default stay free-text.
    const autoName = Orchestration.DEFAULT_OUTPUT_SCHEMA_BY_AGENT[subagentType]
    if (!autoName) return undefined
    const autoSchema = Orchestration.OrchestrationSchemas[autoName]
    if (!autoSchema) return undefined
    return ToolJsonSchema.fromSchema(autoSchema) as unknown as Record<string, unknown>
  }
  if (typeof outputSchema === "object") return outputSchema
  const key = outputSchema.trim()
  const named =
    key === "default" || key === "auto"
      ? Orchestration.DEFAULT_OUTPUT_SCHEMA_BY_AGENT[subagentType]
      : (key as Orchestration.OrchestrationSchemaName)
  if (!named) return undefined
  const schema = Orchestration.OrchestrationSchemas[named]
  if (!schema) return undefined
  return ToolJsonSchema.fromSchema(schema) as unknown as Record<string, unknown>
}

const FINALIZER_ATTEMPTS = 2
const FINALIZER_RAW_RESULT_MAX_CHARS = 80_000
export const DEFAULT_SUBAGENT_RESEARCH_BUDGET = {
  maxSteps: 64,
  maxTokens: 200_000,
  maxWallMs: 30 * 60_000,
  maxNoProgress: 6,
} as const

export type SubagentResearchBudget = {
  readonly maxSteps: number
  readonly maxTokens: number
  readonly maxWallMs: number
  readonly maxNoProgress: number
}

export type SubagentPromptInput = {
  ops: TaskPromptOps
  prompt: string
  sessionID: SessionID
  model: { modelID: ModelV2.ID; providerID: ProviderV2.ID }
  variant: string | undefined
  agent: string
  agentModeOverride: AgentMode | undefined
  outputSchema: Record<string, unknown> | undefined
  runID?: string
  budget?: SubagentResearchBudget
  tools: Record<string, boolean>
  worktreeInfo: Worktree.Info | undefined
  onResearchCompleted?: (sourceMessageID: MessageID) => Effect.Effect<void, unknown>
  onFinalizing?: (input: { attempt: number; sourceMessageID: MessageID }) => Effect.Effect<void, unknown>
  onFinalized?: (messageID: MessageID) => Effect.Effect<void, unknown>
}

type SubagentTerminalReason =
  | "structured_output_valid"
  | "text_output_valid"
  | "provider_error"
  | "structured_output_missing"
  | "structured_output_invalid"
  | "doom_loop"
  | "assistant_error"
  | "human"
  | "parent_interrupted"
  | "timeout"
  | "takeover"
  | "budget_exhausted"
  | "execution_lease_expired"
  | "runtime_error"
const subagentSettlementLocks = KeyedMutex.makeUnsafe<SessionID>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function subagentMetadata(metadata: Session.Info["metadata"]) {
  const deepagent = isRecord(metadata?.deepagent) ? metadata.deepagent : {}
  return {
    deepagent,
    subagent: isRecord(deepagent.subagent) ? deepagent.subagent : {},
  }
}

function stringField(value: unknown, key: string) {
  if (!isRecord(value)) return undefined
  return typeof value[key] === "string" ? value[key] : undefined
}

function terminalReason(error: string | undefined): SubagentTerminalReason {
  const code = error?.match(/^\[([^\]]+)\]/)?.[1]
  if (code === "provider_error") return code
  if (code === "structured_output_missing") return code
  if (code === "structured_output_invalid") return code
  if (code === "doom_loop") return code
  if (code === "assistant_error") return code
  if (code === "budget_exhausted") return code
  return "runtime_error"
}

function projectSubagentRun(sessions: Session.Interface, run: DurableTaskRun, continueActive = false) {
  const sessionID = run.childSessionID
  return subagentSettlementLocks.withLock(sessionID)(
    Effect.gen(function* () {
      const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const { deepagent, subagent: previous } = subagentMetadata(current.metadata)
      if (
        continueActive &&
        previous.finished !== true &&
        typeof previous.run_id === "string" &&
        typeof previous.generation === "number"
      ) {
        return { runID: previous.run_id, generation: previous.generation }
      }
      yield* sessions.setMetadata({
        sessionID,
        metadata: {
          ...current.metadata,
          deepagent: {
            ...deepagent,
            subagent: {
              finished: false,
              state: "researching",
              phase: "research",
              run_id: run.runID,
              generation: run.generation,
              attempts: 0,
              started_at: Date.now(),
            },
          },
        },
      })
      return run
    }),
  )
}

function lostTaskRunLease(run: DurableTaskRun) {
  return new Error(`Task run ${run.runID} lost its execution lease or terminal settlement race`)
}

function markSubagentResearchCompleted(run: DurableTaskRun, owner: string, sourceMessageID: MessageID) {
  return markTaskResearchCompleted(run, owner, sourceMessageID).pipe(
    Effect.flatMap((updated) => (updated ? Effect.void : Effect.fail(lostTaskRunLease(run)))),
  )
}

function markSubagentFinalized(run: DurableTaskRun, owner: string, messageID: MessageID) {
  return markTaskFinalized(run, owner, messageID).pipe(
    Effect.flatMap((updated) => (updated ? Effect.void : Effect.fail(lostTaskRunLease(run)))),
  )
}

function markSubagentFinalizing(
  sessions: Session.Interface,
  run: DurableTaskRun,
  owner: string,
  input: { attempt: number; sourceMessageID: MessageID },
) {
  const sessionID = run.childSessionID
  return subagentSettlementLocks.withLock(sessionID)(
    Effect.gen(function* () {
      const updated = yield* markTaskFinalizing(run, owner, input.attempt, input.sourceMessageID)
      if (!updated) yield* Effect.fail(lostTaskRunLease(run))
      const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const { deepagent, subagent } = subagentMetadata(current.metadata)
      if (subagent.run_id !== run.runID || subagent.generation !== run.generation || subagent.finished === true) return
      yield* sessions.setMetadata({
        sessionID,
        metadata: {
          ...current.metadata,
          deepagent: {
            ...deepagent,
            subagent: {
              ...subagent,
              state: "finalizing",
              phase: "finalize",
              attempts: input.attempt,
              raw_result_ref: input.sourceMessageID,
            },
          },
        },
      })
    }),
  )
}

function settleSubagentRun(
  sessions: Session.Interface,
  run: DurableTaskRun,
  owner: string,
  state: "completed" | "error" | "cancelled" | "interrupted",
  reason: SubagentTerminalReason,
  input?: {
    output?: string
    error?: ErrorData
    structuredResultMessageID?: MessageID
    notification?: { directory: string; agent: string; variant?: string; text: string }
  },
) {
  const sessionID = run.childSessionID
  return subagentSettlementLocks.withLock(sessionID)(
    Effect.gen(function* () {
      const settled = yield* settleTaskRun({
        run,
        owner,
        state,
        reason,
        output: input?.output,
        error: input?.error,
        structuredResultMessageID: input?.structuredResultMessageID,
        notification: input?.notification
          ? {
              directory: input.notification.directory,
              payload: {
                agent: input.notification.agent,
                variant: input.notification.variant,
                text: input.notification.text,
              },
            }
          : undefined,
      })
      if (!settled.won) return false
      const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const { deepagent, subagent } = subagentMetadata(current.metadata)
      if (subagent.run_id !== run.runID || subagent.generation !== run.generation || subagent.finished === true)
        return true
      yield* sessions.setMetadata({
        sessionID,
        metadata: {
          ...current.metadata,
          deepagent: {
            ...deepagent,
            subagent: {
              ...subagent,
              finished: true,
              state,
              phase: "settled",
              settled_at: Date.now(),
              reason,
            },
          },
        },
      })
      taskLog.info("subagent.settled", {
        run_id: run.runID,
        child_session_id: sessionID,
        state,
        reason,
        parent_notification: input?.notification !== undefined,
      })
      return settled.won
    }),
  )
}

export function projectRecoveredSubagentRun(sessions: Session.Interface, run: DurableTaskRun) {
  const sessionID = run.childSessionID
  return subagentSettlementLocks.withLock(sessionID)(
    Effect.gen(function* () {
      const current = yield* sessions.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!current) return
      const { deepagent, subagent } = subagentMetadata(current.metadata)
      if (subagent.run_id !== run.runID || subagent.generation !== run.generation || subagent.finished === true) return
      yield* sessions.setMetadata({
        sessionID,
        metadata: {
          ...current.metadata,
          deepagent: {
            ...deepagent,
            subagent: {
              ...subagent,
              finished: true,
              state: "error",
              phase: "settled",
              settled_at: run.timeSettled ?? Date.now(),
              reason: "execution_lease_expired",
            },
          },
        },
      })
    }),
  )
}

function withTaskRunLease<A, E, R>(run: DurableTaskRun, owner: string, effect: Effect.Effect<A, E, R>) {
  const heartbeat = renewTaskRunLease({ run, owner }).pipe(
    Effect.flatMap((renewed) =>
      renewed ? Effect.void : Effect.fail(new Error(`Task run ${run.runID} lost its execution lease`)),
    ),
    Effect.repeat(Schedule.spaced(Duration.seconds(10))),
    Effect.flatMap(() => Effect.never),
  )
  return Effect.raceFirst(effect, heartbeat)
}

function taskError(input: {
  code: string
  message: string
  sessionID: SessionID
  phase: "research" | "finalize"
  attempts?: number
}) {
  return new Error(
    `[${input.code}] ${input.message} ` +
      `Child session: ${input.sessionID}. Phase: ${input.phase}.` +
      (input.attempts === undefined ? "" : ` Attempts: ${input.attempts}.`) +
      ` Partial work is preserved; call task_read({ task_id: "${input.sessionID}" }) before retrying.`,
  )
}

function assistantError(result: SessionV1.WithParts): { name: string; message: string } | undefined {
  if (result.info.role !== "assistant" || !result.info.error) return undefined
  return {
    name: result.info.error.name ?? "UnknownError",
    message: stringField(result.info.error.data, "message") ?? result.info.error.name ?? "Assistant failed",
  }
}

function assistantText(result: SessionV1.WithParts) {
  return result.parts
    .filter((item): item is SessionV1.TextPart => item.type === "text" && !item.synthetic && !item.ignored)
    .map((item) => item.text)
    .join("\n")
    .trim()
}

function validateStructuredOutput(schema: Record<string, unknown>, value: unknown): string | undefined {
  const { $schema: _, ...document } = schema
  const validate = new Ajv({ allErrors: true, strict: false }).compile(document)
  if (validate(value)) return undefined
  return (
    validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ??
    "schema validation failed"
  )
}

export function runSubagentPrompt(input: SubagentPromptInput): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const parts = yield* input.ops.resolvePromptParts(input.prompt)
    const startedAt = Date.now()
    const budget = input.budget ?? DEFAULT_SUBAGENT_RESEARCH_BUDGET
    taskLog.info("subagent.research.started", {
      run_id: input.runID,
      child_session_id: input.sessionID,
      max_steps: budget.maxSteps,
      max_tokens: budget.maxTokens,
      max_wall_ms: budget.maxWallMs,
    })
    const research = yield* input.ops
      .prompt({
        messageID: MessageID.ascending(),
        sessionID: input.sessionID,
        model: input.model,
        variant: input.variant,
        agent: input.agent,
        metadata: {
          deepagent: {
            task_activity: {
              interactive: false,
              run_id: input.runID,
              started_at: startedAt,
              budget: {
                max_steps: budget.maxSteps,
                max_tokens: budget.maxTokens,
                max_wall_ms: budget.maxWallMs,
                max_no_progress: budget.maxNoProgress,
              },
            },
            ...(input.agentModeOverride ? { agent_mode_override: input.agentModeOverride } : {}),
          },
        },
        tools: input.tools,
        parts: input.worktreeInfo
          ? [
              {
                type: "text" as const,
                text:
                  `You are running in an ISOLATED git worktree at ${input.worktreeInfo.directory} (branch ${input.worktreeInfo.branch ?? "detached"}). ` +
                  `You inherited context from the parent session, but your working directory is this worktree. ` +
                  `Re-read files before editing (do not trust remembered paths/contents), and know your changes stay isolated until merged back.`,
              },
              ...parts,
            ]
          : parts,
      })
      .pipe(
        Effect.timeout(Duration.millis(budget.maxWallMs)),
        Effect.catchIf(Cause.isTimeoutError, () =>
          Effect.sync(() => {
            taskLog.warn("subagent.research.failed", {
              run_id: input.runID,
              child_session_id: input.sessionID,
              reason: "wall_time_budget_exhausted",
            })
          }).pipe(
            Effect.andThen(
              Effect.fail(
                taskError({
                  code: "budget_exhausted",
                  message: `Research wall-time budget exhausted (${budget.maxWallMs}ms).`,
                  sessionID: input.sessionID,
                  phase: "research",
                }),
              ),
            ),
          ),
        ),
      )
    const researchError = assistantError(research)
    if (researchError) {
      taskLog.warn("subagent.research.failed", {
        run_id: input.runID,
        child_session_id: input.sessionID,
        reason: researchError.name,
      })
      return yield* Effect.fail(
        taskError({
          code:
            researchError.name === "APIError"
              ? "provider_error"
              : researchError.name === "DoomLoopError"
                ? "doom_loop"
                : researchError.name === "TaskBudgetExceededError"
                  ? "budget_exhausted"
                  : "assistant_error",
          message: `${researchError.name}: ${researchError.message}`,
          sessionID: input.sessionID,
          phase: "research",
        }),
      )
    }
    taskLog.info("subagent.research.completed", {
      run_id: input.runID,
      child_session_id: input.sessionID,
      result_message_id: research.info.id,
    })
    if (input.onResearchCompleted) yield* input.onResearchCompleted(research.info.id)
    if (!input.outputSchema) return research.parts.findLast((item) => item.type === "text")?.text ?? ""
    const raw = assistantText(research)
    if (!raw) {
      taskLog.warn("subagent.research.failed", {
        run_id: input.runID,
        child_session_id: input.sessionID,
        reason: "research_output_missing",
      })
      return yield* Effect.fail(
        taskError({
          code: "research_output_missing",
          message: "Research completed without a textual result to finalize.",
          sessionID: input.sessionID,
          phase: "research",
        }),
      )
    }

    const boundedRaw = Array.from(raw).slice(0, FINALIZER_RAW_RESULT_MAX_CHARS).join("")
    let correction: string | undefined
    taskLog.info("subagent.finalize.started", {
      run_id: input.runID,
      child_session_id: input.sessionID,
      max_attempts: FINALIZER_ATTEMPTS,
    })
    for (let attempt = 1; attempt <= FINALIZER_ATTEMPTS; attempt++) {
      taskLog.info("subagent.finalize.attempted", {
        run_id: input.runID,
        child_session_id: input.sessionID,
        attempt,
      })
      if (input.onFinalizing) yield* input.onFinalizing({ attempt, sourceMessageID: research.info.id })
      const finalized = yield* input.ops.prompt({
        messageID: MessageID.ascending(),
        sessionID: input.sessionID,
        model: input.model,
        variant: input.variant,
        agent: input.agent,
        format: new SessionV1.OutputFormatJsonSchema({
          type: "json_schema",
          schema: input.outputSchema,
          retryCount: 1,
        }),
        metadata: {
          deepagent: {
            ...(input.agentModeOverride ? { agent_mode_override: input.agentModeOverride } : {}),
            structured_finalizer: {
              attempt,
              source_message_id: research.info.id,
            },
          },
        },
        parts: [
          {
            type: "text",
            text: [
              "Convert the persisted research result below into the requested StructuredOutput schema.",
              "Do not continue research and do not add facts that are absent from the result.",
              correction ? `Previous validation error: ${correction}` : "",
              "<research_result>",
              boundedRaw,
              "</research_result>",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      })
      const error = assistantError(finalized)
      if (error) {
        correction = `${error.name}: ${error.message}`.slice(0, 1_000)
        if (error.name === "StructuredOutputError" && attempt < FINALIZER_ATTEMPTS) continue
        taskLog.warn("subagent.finalize.failed", {
          run_id: input.runID,
          child_session_id: input.sessionID,
          attempt,
          reason: error.name,
        })
        return yield* Effect.fail(
          taskError({
            code: error.name === "APIError" ? "provider_error" : "structured_output_invalid",
            message: correction,
            sessionID: input.sessionID,
            phase: "finalize",
            attempts: attempt,
          }),
        )
      }
      const structured = finalized.info.role === "assistant" ? finalized.info.structured : undefined
      if (structured === undefined) {
        correction = "Model did not call StructuredOutput."
        if (attempt < FINALIZER_ATTEMPTS) continue
        taskLog.warn("subagent.finalize.failed", {
          run_id: input.runID,
          child_session_id: input.sessionID,
          attempt,
          reason: "structured_output_missing",
        })
        return yield* Effect.fail(
          taskError({
            code: "structured_output_missing",
            message: correction,
            sessionID: input.sessionID,
            phase: "finalize",
            attempts: attempt,
          }),
        )
      }
      const validationError = validateStructuredOutput(input.outputSchema, structured)
      if (!validationError) {
        if (input.onFinalized) yield* input.onFinalized(finalized.info.id)
        taskLog.info("subagent.finalize.completed", {
          run_id: input.runID,
          child_session_id: input.sessionID,
          attempt,
          result_message_id: finalized.info.id,
        })
        return JSON.stringify(structured)
      }
      const boundedValidationError = validationError.slice(0, 1_000)
      correction = boundedValidationError
      if (attempt < FINALIZER_ATTEMPTS) continue
      taskLog.warn("subagent.finalize.failed", {
        run_id: input.runID,
        child_session_id: input.sessionID,
        attempt,
        reason: "structured_output_invalid",
      })
      return yield* Effect.fail(
        taskError({
          code: "structured_output_invalid",
          message: boundedValidationError,
          sessionID: input.sessionID,
          phase: "finalize",
          attempts: attempt,
        }),
      )
    }
    return yield* Effect.die(new Error("unreachable: structured finalizer exhausted without settlement"))
  })
}

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  // E is unknown, not never: the real prompt fails (provider errors) — takeover (1a+1b) relies on
  // that failure channel to judge a crashed attempt, and mock ops in tests must be able to throw.
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts, unknown>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  // L3 (v3.8.0 §L3, 路 B hard constraint): when set, the subagent's FINAL turn is forced through
  // the structured-output path (a `StructuredOutput` tool call gated by `toolChoice: "required"` —
  // the in-session equivalent of `generateObject`) so the result parses deterministically, instead
  // of scraping its last text part. Accepts a named orchestration schema ("ReviewResult" /
  // "ResearchResult" / "ReviewFinding"), the alias "default"/"auto" (⇒ the subagent's natural
  // default: reviewer→ReviewResult, researcher→ResearchResult), or a raw JSON Schema object. When
  // omitted, the existing free-text extraction is used unchanged.
  output_schema: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Any)])).annotate({
    description:
      'Optional. Force the subagent to return a structured result matching this schema. Pass a named schema ("ReviewResult", "ResearchResult", "ReviewFinding"), "default" to use the subagent\'s natural schema (reviewer→ReviewResult, researcher→ResearchResult), or a raw JSON Schema object. Omit for a free-text result.',
  }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
  isolation: Schema.optional(Schema.Literal("worktree")).annotate({
    description:
      'Set to "worktree" to run this subagent in its own isolated git worktree so it cannot collide with other parallel subagents. Its changes stay isolated until you merge them back. Omit for subagents that should operate directly in the current working directory.',
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
  maxChars?: number
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  // I33-4 (v4.0.4 块1 1e): when a bound is configured, the parent receives a bounded excerpt with a
  // pointer to the subagent session (full text stays queryable there) instead of the full text.
  // maxChars === undefined ⇒ byte-identical to the pre-flag behavior.
  // Codepoint-safe: slice on the codepoint array, not the UTF-16 string, so a multibyte character
  // (emoji, CJK surrogate pair) is never cut mid-unit into a replacement char. Bound is measured and
  // reported in codepoints for the same reason. The truncation notice ALWAYS survives (it is appended
  // after the slice, never itself truncated) so the pointer to the full subagent session never gets
  // dropped. A non-positive maxChars (0) yields an empty excerpt + pointer — degenerate but safe.
  let text = input.text
  if (input.maxChars !== undefined) {
    const cps = Array.from(input.text)
    if (cps.length > input.maxChars) {
      const kept = cps.slice(0, Math.max(0, input.maxChars)).join("")
      text = `${kept}\n…[truncated ${cps.length - input.maxChars} chars; full output available in subagent session ${input.sessionID}]`
    }
  }
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

// v4.0.4 块1 (1a+1b): the per-attempt bundle the takeover drivers thread through spawn → drive →
// recycle. Each takeover respawn mints a fresh one (new child session, new worktree).
type AttemptMetadata = Record<string, unknown> & {
  readonly parentSessionId: SessionID
  readonly sessionId: SessionID
  readonly background?: boolean
}

type SettlementDetails = {
  readonly output?: string
  readonly error?: ErrorData
  readonly notifyText?: string
}

interface AttemptBundle {
  readonly worktreeInfo: Worktree.Info | undefined
  readonly worktree: Worktree.Interface | undefined
  readonly nextSession: Session.Info
  readonly metadata: AttemptMetadata
  readonly markFinished: (
    state: "completed" | "error" | "cancelled" | "interrupted",
    reason?: SubagentTerminalReason,
    details?: SettlementDetails,
  ) => Effect.Effect<void, unknown>
  readonly inject: (state: "completed" | "error", text: string, takeovers: number) => Effect.Effect<unknown, unknown>
  readonly automaticWriteIsolation: boolean
  readonly mergeWorktree: () => Effect.Effect<boolean, unknown>
  readonly teardownWorktree: (force: boolean) => Effect.Effect<unknown, unknown>
}

type AttemptResult = {
  readonly title: string
  readonly metadata: AttemptMetadata
  readonly output: string
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require DEEPAGENT_CODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      const parentAgent = yield* agent
        .get(parent.agent ?? ctx.agent)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))

      // F5: unified child admission — resolves depth once and validates for ALL creation paths
      // (takeover and default). Resume (task_id present) takes the validation-only branch; a fresh
      // spawn takes the full admission-check branch. Both share `childDepth` for metadata writes.
      const parentDepth = yield* resolveSessionDepth(sessions, ctx.sessionID)

      if (session !== undefined) {
        // Resume validation: the target session must be a direct child of THIS session with the
        // expected agent type and a valid depth. Guards against cross-tree resume or injected IDs.
        if (session.parentID !== ctx.sessionID) {
          return yield* Effect.fail(
            new Error(
              `Cannot resume task "${params.task_id}": it is not a direct child of the current session. ` +
                `Use a task_id returned by a task you launched in this session.`,
            ),
          )
        }
        if (session.agent && session.agent !== params.subagent_type) {
          return yield* Effect.fail(
            new Error(
              `Cannot resume task "${params.task_id}": its agent type is "${session.agent}" ` +
                `but this call requests "${params.subagent_type}". Omit task_id to start a fresh subagent.`,
            ),
          )
        }
        const resumedDepth = yield* resolveSessionDepth(sessions, session.id)
        if (resumedDepth > MAX_SUBAGENT_DEPTH) {
          return yield* Effect.fail(
            new Error(
              `Cannot resume task "${params.task_id}": resolved depth ${resumedDepth} exceeds ` +
                `the hard limit (MAX_SUBAGENT_DEPTH=${MAX_SUBAGENT_DEPTH}).`,
            ),
          )
        }
      } else {
        // New session: full admission gate — depth ceiling then delegation permission.
        const admission = admitChildOrFail({
          callerDepth: parentDepth,
          callerAgentPermission: parentAgent?.permission ?? [],
          callerSessionPermission: parent.permission ?? [],
          targetAgentType: params.subagent_type,
        })
        if ("error" in admission) {
          return yield* Effect.fail(new Error(admission.error))
        }
      }
      // childDepth is used by BOTH the takeover path and the default path when writing metadata.
      const childDepth = parentDepth + 1

      // Runtime tool calls always carry callID. Direct programmatic callers (primarily tests and
      // embedded integrations) predate that contract, so give those invocations a unique identity;
      // exact-retry semantics are available only when the caller supplies the stable callID.
      const toolCallID = ctx.callID ?? Identifier.ascending("tool")
      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant
      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      const resolvedOutputSchema = resolveOutputSchema(params.output_schema, params.subagent_type)
      const subagentIntensity =
        (cfg.provider?.deepagent?.options?.subagentIntensity as string | undefined) === "downgrade"
          ? "downgrade"
          : "inherit"
      const childAgentModeOverride =
        subagentIntensity === "downgrade" ? downgradeOneLevel(AgentGateway.snapshot().agentMode) : undefined
      const caps: CoreOrchestration.OrchestrationCaps = {
        maxFanout: cfg.experimental?.orchestration?.max_fanout,
        maxConcurrency: cfg.experimental?.orchestration?.max_concurrency,
      }
      const agentMaxConcurrency = next.limits?.maxConcurrency
      const researchBudget: SubagentResearchBudget = {
        maxSteps: flags.subagentResearchStepLimit ?? DEFAULT_SUBAGENT_RESEARCH_BUDGET.maxSteps,
        maxTokens: flags.subagentResearchTokenLimit ?? DEFAULT_SUBAGENT_RESEARCH_BUDGET.maxTokens,
        maxWallMs: flags.subagentResearchWallMs ?? DEFAULT_SUBAGENT_RESEARCH_BUDGET.maxWallMs,
        maxNoProgress: flags.subagentNoProgressLimit ?? DEFAULT_SUBAGENT_RESEARCH_BUDGET.maxNoProgress,
      }
      const activeRun = session
        ? yield* getActiveTaskRunByChild(session.id).pipe(Effect.provideService(Database.Service, database))
        : undefined
      const activeJob = activeRun ? yield* background.get(activeRun.childSessionID) : undefined
      const admission = yield* admitTaskRun({
        parentSessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        toolCallID,
        childSessionID: session?.id,
        joinRunID: activeRun?.runID,
        request: params,
        deliveryMode: runInBackground ? "background" : "foreground",
      }).pipe(Effect.provideService(Database.Service, database))
      const executionOwner =
        activeJob?.status === "running" &&
        activeRun?.executionOwner !== undefined &&
        activeRun.leaseExpiresAt !== undefined &&
        activeRun.leaseExpiresAt > Date.now()
          ? activeRun.executionOwner
          : `${process.pid}:${Identifier.ascending("job")}`
      if (admission.exactRetry && isTerminal(admission.run)) {
        if (admission.run.state === "completed") {
          return {
            title: params.description,
            metadata: {
              parentSessionId: ctx.sessionID,
              sessionId: admission.run.childSessionID,
              subagentType: params.subagent_type,
              model,
            },
            output: renderOutput({
              sessionID: admission.run.childSessionID,
              state: "completed",
              summary: "Task result replayed from durable settlement",
              text: admission.run.output ?? "",
              maxChars: flags.subagentOutputMaxChars,
            }),
          }
        }
        return yield* Effect.fail(
          new Error(
            admission.run.error?.message ??
              `Task ${admission.run.childSessionID} previously settled as ${admission.run.state} (${admission.run.reason ?? "unknown"})`,
          ),
        )
      }
      const shouldProvision =
        admission.runCreated || (admission.exactRetry && ["admitted", "provisioning"].includes(admission.run.state))
      const claimedRun = shouldProvision
        ? yield* claimTaskProvisioning({ run: admission.run, owner: executionOwner }).pipe(
            Effect.provideService(Database.Service, database),
          )
        : undefined
      if (admission.exactRetry && !claimedRun) {
        return {
          title: params.description,
          metadata: {
            parentSessionId: ctx.sessionID,
            sessionId: admission.run.childSessionID,
            subagentType: params.subagent_type,
            model,
            background: true,
            jobId: admission.run.childSessionID,
          },
          output: renderOutput({
            sessionID: admission.run.childSessionID,
            state: "running",
            summary: "Task admission replayed without duplicate execution",
            text: BACKGROUND_UPDATED,
            maxChars: flags.subagentOutputMaxChars,
          }),
        }
      }
      if (shouldProvision && !claimedRun)
        return yield* Effect.fail(new Error(`Task run ${admission.run.runID} lost its provisioning claim`))
      const admittedSession =
        session ??
        (yield* sessions.get(admission.run.childSessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined))))
      const ownsActiveRun = (run: DurableTaskRun) =>
        (run.state === "researching" || run.state === "finalizing") &&
        run.executionOwner === executionOwner &&
        run.leaseExpiresAt !== undefined &&
        run.leaseExpiresAt > Date.now()
      const activateRun = (run: DurableTaskRun) =>
        ownsActiveRun(run)
          ? projectSubagentRun(sessions, run, true).pipe(Effect.as(run))
          : startTaskRun(run, executionOwner).pipe(
              Effect.provideService(Database.Service, database),
              Effect.flatMap((started) =>
                started
                  ? projectSubagentRun(sessions, started).pipe(Effect.as(started))
                  : getTaskRun(run.runID).pipe(
                      Effect.provideService(Database.Service, database),
                      Effect.flatMap((current) =>
                        current && ownsActiveRun(current)
                          ? projectSubagentRun(sessions, current, true).pipe(Effect.as(current))
                          : Effect.fail(new Error(`Task run ${run.runID} could not enter researching state`)),
                      ),
                    ),
              ),
            )
      const notification = (text: string) => ({
        directory: parent.directory,
        agent: parent.agent ?? ctx.agent,
        variant,
        text,
      })
      const dispatchNotifications = () =>
        deliverTaskNotifications({
          owner: `${executionOwner}:notification`,
          directory: parent.directory,
          deliver: (item) =>
            ops
              .prompt({
                messageID: item.messageID,
                sessionID: item.parentSessionID,
                agent: item.payload.agent,
                variant: item.payload.variant,
                metadata: {
                  deepagent: {
                    task_notification: { run_id: item.runID, outbox_id: item.id },
                  },
                },
                parts: [{ type: "text", synthetic: true, text: item.payload.text }],
              })
              .pipe(Effect.asVoid),
        }).pipe(Effect.provideService(Database.Service, database), Effect.asVoid)

      // v4.0.4 块1 (1a+1b): timeout + takeover — enabled ONLY when DEEPAGENT_CODE_SUBAGENT_TIMEOUT_MS
      // is set; when it is not, execution falls through to the default path below, which stays
      // byte-identical to the pre-flag behavior. timeout and takeover are an inseparable unit: a bare
      // timeout would kill legitimate long tasks, so a timed-out/failed attempt is judged crashed and
      // atomically replaced — the old attempt is cancelled and its worktree recycled BEFORE a
      // brand-new child session respawns from the same fork base (single-driver invariant: the two
      // attempts never run concurrently). Retries are bounded by subagentTakeoverLimit (default 2).
      if (flags.subagentTimeoutMs !== undefined) {
        const timeoutMs = flags.subagentTimeoutMs
        const takeoverLimit = flags.subagentTakeoverLimit ?? 2

        // A fresh attempt gets its own worktree (same fork base as the discarded one) and a brand-new
        // child session; the resumed session (task_id) is only reused by the FIRST attempt.
        const spawnAttempt = Effect.fn("TaskTool.spawnAttempt")(function* (first: boolean, runState: DurableTaskRun) {
          const resumed = first ? admittedSession : undefined
          const isolate = !resumed && (params.isolation === "worktree" || subagentIsWriteType(next))
          const worktreeOpt = isolate
            ? yield* Effect.serviceOption(Worktree.Service)
            : Option.none<Worktree.Interface>()
          const worktreeInfo =
            isolate && Option.isSome(worktreeOpt)
              ? yield* worktreeOpt.value
                  .create({ name: `agent-${params.subagent_type}-${Identifier.ascending("tool")}` })
                  .pipe(Effect.catchTag("WorktreeNotGitError", () => Effect.succeed(undefined)))
              : undefined
          const nextSession =
            resumed ??
            (yield* sessions.create({
              id: runState.childSessionID,
              parentID: ctx.sessionID,
              title: params.description + ` (@${next.name} subagent)`,
              agent: next.name,
              ...(worktreeInfo ? { directory: worktreeInfo.directory } : {}),
              // F5: write normalised depth into metadata so future resolveSessionDepth calls for this
              // session return the correct value without needing to walk the full parentID chain.
              metadata: {
                deepagent: { [SUBAGENT_DEPTH_META_KEY]: childDepth },
              },
              permission: [
                ...deriveSubagentSessionPermission({
                  parentSessionPermission: parent.permission ?? [],
                  parentAgent,
                  subagent: next,
                }),
                ...filterPrimaryToolsForSubagent(cfg.experimental?.primary_tools).map((item) => ({
                  pattern: "*",
                  action: "allow" as const,
                  permission: item,
                })),
              ],
            }))
          return { worktree: Option.getOrUndefined(worktreeOpt), worktreeInfo, nextSession }
        })

        const startAttempt = Effect.fn("TaskTool.startAttempt")(function* (
          a: {
            worktree: Worktree.Interface | undefined
            worktreeInfo: Worktree.Info | undefined
            nextSession: Session.Info
          },
          runState: DurableTaskRun,
          takeovers: number,
          allowExtend: boolean,
        ) {
          const activeRunState = yield* activateRun(runState)
          const activeOwner = activeRunState.executionOwner ?? executionOwner
          const metadata = {
            parentSessionId: ctx.sessionID,
            sessionId: a.nextSession.id,
            // 1c: carry the real subagent type so task_status can name WHICH kind of subagent is
            // running (researcher/reviewer/…). BackgroundJob.start records type=id ("task") for every
            // dispatch, so without this the parent's task list cannot tell one subagent from another —
            // defeating the "spot the hung subagent" purpose of the tool.
            subagentType: params.subagent_type,
            model,
            ...(runInBackground ? { background: true } : {}),
          }
          yield* ctx.metadata({
            title: params.description,
            metadata,
          })

          const runTaskInner = Effect.fn("TaskTool.runTaskInner")(function* () {
            return yield* runSubagentPrompt({
              ops,
              prompt: params.prompt,
              sessionID: a.nextSession.id,
              model,
              variant: next.model ? undefined : variant,
              agent: next.name,
              agentModeOverride: childAgentModeOverride,
              outputSchema: resolvedOutputSchema,
              runID: activeRunState.runID,
              budget: researchBudget,
              worktreeInfo: a.worktreeInfo,
              onResearchCompleted: (messageID) =>
                markSubagentResearchCompleted(activeRunState, activeOwner, messageID).pipe(
                  Effect.provideService(Database.Service, database),
                ),
              onFinalizing: (progress) =>
                markSubagentFinalizing(sessions, activeRunState, activeOwner, progress).pipe(
                  Effect.provideService(Database.Service, database),
                ),
              onFinalized: (messageID) =>
                markSubagentFinalized(activeRunState, activeOwner, messageID).pipe(
                  Effect.provideService(Database.Service, database),
                ),
              tools: {
                ...(evaluatePermission("todowrite", "*", next.permission).action === "allow"
                  ? {}
                  : { todowrite: false }),
                ...(evaluatePermission(id, "*", next.permission).action === "allow"
                  ? {}
                  : { task: false, task_status: false }),
                ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
              },
            })
          })

          const runTask = Effect.fn("TaskTool.runTask")(function* () {
            return yield* withTaskRunLease(
              activeRunState,
              activeOwner,
              TaskConcurrency.withTaskSlot({
                parentSessionID: ctx.sessionID,
                subagentType: params.subagent_type,
                agentMaxConcurrency,
                caps,
                effect: runTaskInner(),
              }),
            ).pipe(Effect.provideService(Database.Service, database))
          })

          const markFinished = Effect.fn("TaskTool.markSubagentFinished")(function* (
            state: "completed" | "error" | "cancelled" | "interrupted",
            reason?: SubagentTerminalReason,
            details?: SettlementDetails,
          ) {
            const won = yield* settleSubagentRun(
              sessions,
              activeRunState,
              activeOwner,
              state,
              reason ?? "runtime_error",
              {
                output: details?.output,
                error: details?.error,
                notification: details?.notifyText ? notification(details.notifyText) : undefined,
              },
            ).pipe(Effect.provideService(Database.Service, database))
            if (!won) yield* Effect.fail(lostTaskRunLease(activeRunState))
          })

          const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
            _state: "completed" | "error",
            _text: string,
            _doneTakeovers: number,
          ) {
            yield* dispatchNotifications()
          })

          // 1d: worktree teardown hangs off the completion points (only in this flag-gated path; the
          // default path intentionally keeps the status quo). Completion/cancellation uses the
          // fail-closed safeRemove (refuses to destroy unmerged work — a dirty worktree leaks rather
          // than losing changes); takeover recycling force-removes because the old attempt's
          // half-finished state is explicitly superseded by the redo from the same fork base.
          const teardownWorktree = Effect.fn("TaskTool.teardownWorktree")(function* (force: boolean) {
            if (!a.worktreeInfo) return
            const worktreeOpt = yield* Effect.serviceOption(Worktree.Service)
            if (Option.isNone(worktreeOpt)) return
            yield* (
              force
                ? worktreeOpt.value.remove({ directory: a.worktreeInfo.directory })
                : worktreeOpt.value.safeRemove({ directory: a.worktreeInfo.directory })
            ).pipe(Effect.ignore)
          })

          // 2c (Block 2): automatic write-isolation merge-back. When the worktree was created
          // automatically (not via explicit isolation:"worktree"), integrate the worker's committed
          // changes back into the PARENT checkout via Git.mergeInto rather than Worktree.mergeBack.
          // Worktree.mergeBack targets the repo default branch with --no-commit, which is wrong here:
          // the parent may be on any branch and the merge must be a committed --no-ff. We also check
          // the parent HEAD hasn't advanced since spawn (baseline guard) so we don't silently merge
          // onto a moved target. On any failure we abort the merge state and preserve the worker
          // worktree for recovery; teardownWorktree(false) is then called by the caller to keep it.
          //
          // We resolve Git.Service here (at bundle-build time inside startAttempt) so that
          // mergeWorktree itself can be typed without service requirements: the service is captured
          // in the closure. `true` reports a successful automatic merge, whose worker may be removed.
          // `false` means no automatic merge was applicable and therefore must keep fail-closed cleanup.
          const automaticWriteIsolation = params.isolation !== "worktree" && !!a.worktreeInfo
          const parentDir = parent.directory
          const gitOpt = yield* Effect.serviceOption(Git.Service)
          const parentBaselineHead =
            parentDir && Option.isSome(gitOpt)
              ? yield* gitOpt.value.resolveRef(parentDir).pipe(Effect.orElseSucceed(() => undefined))
              : undefined
          const mergeWorktree = Effect.fn("TaskTool.mergeWorktree")(function* () {
            if (!a.worktreeInfo || !automaticWriteIsolation || !parentDir || Option.isNone(gitOpt)) return false
            const git = gitOpt.value
            const workerBranch = a.worktreeInfo.branch
            if (!workerBranch) return false // detached HEAD on worker — nothing to merge
            const currentParentHead = yield* git.resolveRef(parentDir).pipe(Effect.orElseSucceed(() => undefined))
            if (currentParentHead !== parentBaselineHead) {
              // Parent advanced — preserve worker for human resolution; caller treats this as merge failure.
              return yield* Effect.fail(
                new Error(
                  `Automatic worktree merge skipped: parent HEAD advanced since task spawn ` +
                    `(baseline ${parentBaselineHead ?? "none"}, current ${currentParentHead ?? "none"}). ` +
                    `Worker branch ${workerBranch} preserved for manual review.`,
                ),
              )
            }
            const result = yield* git.mergeInto(parentDir, workerBranch)
            if (result.type === "merged") return true
            // On conflict or failure: abort merge state so parent checkout is usable, then re-throw
            // so the caller knows to preserve the worker worktree.
            yield* git.abortMerge(parentDir).pipe(Effect.ignore)
            const diag =
              result.type === "conflict"
                ? `conflicts in ${result.paths.join(", ")}`
                : (result.diagnostic ?? result.type)
            return yield* Effect.fail(
              new Error(
                `Automatic worktree merge failed (${diag}). ` +
                  `Worker branch ${workerBranch} preserved at ${a.worktreeInfo.directory}.`,
              ),
            )
          })

          const bundle: AttemptBundle = {
            worktreeInfo: a.worktreeInfo,
            worktree: a.worktree,
            nextSession: a.nextSession,
            metadata,
            automaticWriteIsolation,
            markFinished,
            inject,
            mergeWorktree,
            teardownWorktree,
          }

          if (allowExtend && (yield* background.extend({ id: a.nextSession.id, run: runTask() }))) {
            return { kind: "extended" as const, bundle }
          }
          yield* background.start({
            id: a.nextSession.id,
            type: id,
            title: params.description,
            metadata,
            onPromote: Effect.all(
              [
                ctx.metadata({
                  title: params.description,
                  metadata: { ...metadata, background: true, jobId: a.nextSession.id },
                }),
                driveBackground(bundle, takeovers),
              ],
              { discard: true },
            ),
            run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(a.nextSession.id))),
          })
          return { kind: "started" as const, bundle }
        })

        const backgroundResult = (b: AttemptBundle): AttemptResult => ({
          title: params.description,
          metadata: { ...b.metadata, background: true, jobId: b.nextSession.id },
          output: renderOutput({
            sessionID: b.nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
            maxChars: flags.subagentOutputMaxChars,
          }),
        })

        const driveForeground = (b: AttemptBundle, takeovers: number): Effect.Effect<AttemptResult, unknown> =>
          Effect.gen(function* () {
            const runCancel = yield* EffectBridge.make()
            const cancel = ops.cancel(b.nextSession.id)
            const onAbort = () => runCancel.fork(cancel)
            const outcome = yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                ctx.abort.addEventListener("abort", onAbort)
              }),
              () =>
                Effect.gen(function* () {
                  const result = yield* Effect.raceFirst(
                    background.wait({ id: b.nextSession.id, timeout: timeoutMs }),
                    background
                      .waitForPromotion(b.nextSession.id)
                      .pipe(Effect.map((info) => ({ info, timedOut: false }))),
                  )
                  if (result.info?.metadata?.background === true) return { kind: "promoted" as const }
                  if (result.timedOut) return { kind: "retry" as const, reason: `timed out after ${timeoutMs}ms` }
                  if (result.info?.status === "error")
                    return { kind: "retry" as const, reason: result.info.error ?? "Task failed" }
                  if (result.info?.status === "cancelled") return { kind: "cancelled" as const }
                  return { kind: "completed" as const, output: result.info?.output ?? "" }
                }),
              (_, exit) =>
                Effect.gen(function* () {
                  if (Exit.hasInterrupts(exit))
                    yield* Effect.all([cancel, background.cancel(b.nextSession.id)], { discard: true })
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      ctx.abort.removeEventListener("abort", onAbort)
                    }),
                  ),
                ),
            )
            if (outcome.kind === "promoted") return backgroundResult(b)
            if (outcome.kind === "completed") {
              const merged = yield* b.mergeWorktree().pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const diagnostic = Cause.squash(cause)
                    yield* b.markFinished("error", "runtime_error", {
                      error: { code: "runtime_error", message: String(diagnostic) },
                    })
                    yield* b.inject("error", `Worktree merge-back failed: ${String(diagnostic)}`, takeovers)
                    yield* b.teardownWorktree(false)
                    return false
                  }),
                ),
              )
              if (!merged && b.automaticWriteIsolation)
                return yield* Effect.fail(new Error("Worktree merge-back failed"))
              yield* b.markFinished(
                "completed",
                resolvedOutputSchema ? "structured_output_valid" : "text_output_valid",
                { output: outcome.output },
              )
              yield* b.teardownWorktree(merged)
              return {
                title: params.description,
                metadata: b.metadata,
                output: renderOutput({
                  sessionID: b.nextSession.id,
                  state: "completed",
                  text: outcome.output,
                  maxChars: flags.subagentOutputMaxChars,
                }),
              }
            }
            if (outcome.kind === "cancelled") {
              // §4.3/4.6: "cancelled" from the abort signal means human interrupted the task.
              // Write "interrupted" (not "cancelled") so parent agent and supervision UI can
              // distinguish voluntary human stop with preserved work from a runtime failure.
              // Do NOT force-remove the worktree — partial work may be worth recovering.
              yield* b.markFinished("interrupted", "human")
              yield* b.teardownWorktree(false)
              return yield* Effect.fail(
                new Error(
                  `Task interrupted by the user. Partial work is preserved in subagent session ${b.nextSession.id}. ` +
                    `Call task_read({ task_id: "${b.nextSession.id}" }) before retrying or duplicating the task.`,
                ),
              )
            }
            if (takeovers >= takeoverLimit) {
              yield* background.cancel(b.nextSession.id).pipe(Effect.ignore)
              const reason = outcome.reason.startsWith("timed out") ? "timeout" : terminalReason(outcome.reason)
              yield* b.markFinished("error", reason, { error: { code: reason, message: outcome.reason } })
              yield* b.teardownWorktree(false)
              return yield* Effect.fail(
                taskError({
                  code: reason,
                  message: `The subagent failed after ${takeovers} bounded takeover attempt(s). Last failure: ${outcome.reason}`,
                  sessionID: b.nextSession.id,
                  phase: outcome.reason.includes("Phase: finalize") ? "finalize" : "research",
                  attempts: takeovers + 1,
                }),
              )
            }
            yield* background.cancel(b.nextSession.id).pipe(Effect.ignore)
            yield* b.markFinished("cancelled", "takeover")
            yield* b.teardownWorktree(true)
            const childSessionID = SessionID.create()
            const takeoverRun = yield* spawnTaskTakeover({ root: admission.run, childSessionID }).pipe(
              Effect.provideService(Database.Service, database),
            )
            const claimedTakeover = yield* claimTaskProvisioning({ run: takeoverRun, owner: executionOwner }).pipe(
              Effect.provideService(Database.Service, database),
            )
            if (!claimedTakeover)
              return yield* Effect.die(new Error(`Takeover run ${takeoverRun.runID} lost its provisioning claim`))
            const next = yield* startAttempt(
              yield* spawnAttempt(false, claimedTakeover),
              claimedTakeover,
              takeovers + 1,
              false,
            )
            if (next.kind === "extended")
              return yield* Effect.die(new Error("unreachable: extend on a fresh takeover attempt"))
            return yield* driveForeground(next.bundle, takeovers + 1)
          })

        const driveBackground = (b: AttemptBundle, takeovers: number): Effect.Effect<void> =>
          Effect.gen(function* () {
            const waited = yield* background.wait({ id: b.nextSession.id, timeout: timeoutMs })
            const status = waited.info?.status
            if (!waited.timedOut && status === "completed") {
              const merged = yield* b.mergeWorktree().pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const diagnostic = Cause.squash(cause)
                    const text = `Worktree merge-back failed: ${String(diagnostic)}`
                    yield* b.markFinished("error", "runtime_error", {
                      error: { code: "runtime_error", message: text },
                      notifyText: renderOutput({
                        sessionID: b.nextSession.id,
                        state: "error",
                        summary: `Background task failed: ${params.description}`,
                        text,
                        maxChars: flags.subagentOutputMaxChars,
                      }),
                    })
                    yield* b.inject("error", text, takeovers)
                    yield* b.teardownWorktree(false)
                    return false
                  }),
                ),
              )
              if (!merged && b.automaticWriteIsolation) return
              const output = waited.info?.output ?? ""
              yield* b.markFinished(
                "completed",
                resolvedOutputSchema ? "structured_output_valid" : "text_output_valid",
                {
                  output,
                  notifyText: renderOutput({
                    sessionID: b.nextSession.id,
                    state: "completed",
                    summary: `Background task completed: ${params.description}${takeovers === 0 ? "" : ` (after ${takeovers} takeover${takeovers === 1 ? "" : "s"})`}`,
                    text: output,
                    maxChars: flags.subagentOutputMaxChars,
                  }),
                },
              )
              yield* b.teardownWorktree(merged)
              yield* b.inject("completed", output, takeovers)
              return
            }
            if (!waited.timedOut && status === "cancelled") {
              yield* b.markFinished("cancelled", "parent_interrupted")
              yield* b.teardownWorktree(false)
              return
            }
            if (takeovers >= takeoverLimit) {
              yield* background.cancel(b.nextSession.id).pipe(Effect.ignore)
              const reason = waited.timedOut ? `timed out after ${timeoutMs}ms` : (waited.info?.error ?? "Task failed")
              yield* b.markFinished("error", waited.timedOut ? "timeout" : terminalReason(waited.info?.error), {
                error: {
                  code: waited.timedOut ? "timeout" : terminalReason(waited.info?.error),
                  message: reason,
                },
                notifyText: renderOutput({
                  sessionID: b.nextSession.id,
                  state: "error",
                  summary: `Background task failed: ${params.description}`,
                  text: `The subagent was retried ${takeovers} time(s) after timeout/crash and still did not complete. Last failure: ${reason}. The half-finished attempt was cancelled and its worktree discarded.`,
                  maxChars: flags.subagentOutputMaxChars,
                }),
              })
              yield* b.teardownWorktree(false)
              yield* b.inject(
                "error",
                `The subagent was retried ${takeovers} time(s) after timeout/crash and still did not complete. Last failure: ${reason}. The half-finished attempt was cancelled and its worktree discarded.`,
                takeovers,
              )
              return
            }
            yield* background.cancel(b.nextSession.id).pipe(Effect.ignore)
            yield* b.markFinished("cancelled", "takeover")
            yield* b.teardownWorktree(true)
            const childSessionID = SessionID.create()
            const takeoverRun = yield* spawnTaskTakeover({ root: admission.run, childSessionID }).pipe(
              Effect.provideService(Database.Service, database),
            )
            const claimedTakeover = yield* claimTaskProvisioning({ run: takeoverRun, owner: executionOwner }).pipe(
              Effect.provideService(Database.Service, database),
            )
            if (!claimedTakeover)
              return yield* Effect.die(new Error(`Takeover run ${takeoverRun.runID} lost its provisioning claim`))
            const next = yield* startAttempt(
              yield* spawnAttempt(false, claimedTakeover),
              claimedTakeover,
              takeovers + 1,
              false,
            )
            if (next.kind === "extended")
              return yield* Effect.die(new Error("unreachable: extend on a fresh takeover attempt"))
            yield* driveBackground(next.bundle, takeovers + 1)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

        const initialRun = claimedRun ?? admission.run
        const started = yield* startAttempt(yield* spawnAttempt(true, initialRun), initialRun, 0, true)
        if (started.kind === "extended") {
          return {
            title: params.description,
            metadata: { ...started.bundle.metadata, background: true, jobId: started.bundle.nextSession.id },
            output: renderOutput({
              sessionID: started.bundle.nextSession.id,
              state: "running",
              summary: "Background task updated",
              text: BACKGROUND_UPDATED,
              maxChars: flags.subagentOutputMaxChars,
            }),
          }
        }
        if (runInBackground) {
          yield* driveBackground(started.bundle, 0)
          return backgroundResult(started.bundle)
        }
        return yield* driveForeground(started.bundle, 0)
      }

      // U5: per-subagent worktree isolation. When isolation:"worktree" and this is a fresh subagent
      // (not a resume), allocate a dedicated worktree so parallel subagents can't collide on the same
      // files. The Worktree service is resolved OPTIONALLY (serviceOption) so the task tool does not
      // add it to the registry's requirement set — when it's absent (e.g. minimal test layers) we fall
      // back to the shared directory rather than failing.
      //
      // P5 (C7): the worktree name MUST be unique per task invocation. The old code hardcoded
      // `agent-${subagent_type}`, so two concurrent subagents of the SAME type raced on one name — and
      // on the resulting collision the create was silently swallowed, dropping BOTH agents into the
      // shared parent checkout where they'd corrupt each other's edits. A fresh monotonic identifier
      // (unique even within the same millisecond) guarantees no two invocations request the same name.
      // Only the non-git degradation (NotGitError) is tolerated as a shared-directory fallback; any
      // other create failure now FAILS the task loudly instead of silently un-isolating it.
      const isolate = !admittedSession && (params.isolation === "worktree" || subagentIsWriteType(next))
      const worktreeOpt = isolate ? yield* Effect.serviceOption(Worktree.Service) : Option.none<Worktree.Interface>()
      const worktreeInfo =
        isolate && Option.isSome(worktreeOpt)
          ? yield* worktreeOpt.value
              .create({ name: `agent-${params.subagent_type}-${Identifier.ascending("tool")}` })
              .pipe(Effect.catchTag("WorktreeNotGitError", () => Effect.succeed(undefined)))
          : undefined

      const nextSession =
        admittedSession ??
        (yield* sessions.create({
          id: admission.run.childSessionID,
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          ...(worktreeInfo ? { directory: FSUtil.resolve(worktreeInfo.directory) } : {}),
          // F5: write normalised depth into metadata so future resolveSessionDepth calls for this
          // session return the correct value without needing to walk the full parentID chain.
          metadata: {
            deepagent: { [SUBAGENT_DEPTH_META_KEY]: childDepth },
          },
          permission: [
            ...deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              parentAgent,
              subagent: next,
            }),
            // §E: primary_tools is a PRIMARY-agent escape hatch; on a SUBAGENT it must NOT be able to
            // force-allow the capability-governed permissions (plan/todowrite) and thereby bypass the
            // plan-write capability gate. Filter those out; every other primary_tool passes through.
            ...filterPrimaryToolsForSubagent(cfg.experimental?.primary_tools).map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })),
          ],
        }))

      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        // 1c: see the takeover-path metadata above — task_status reads subagentType to name the
        // running subagent instead of the generic BackgroundJob type ("task").
        subagentType: params.subagent_type,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })
      const runState = yield* activateRun(claimedRun ?? admission.run)
      const runOwner = runState.executionOwner ?? executionOwner

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        // §5a chokepoint: BOTH the foreground and background dispatch paths route the subagent's
        // actual work through `runTask`, so acquiring the concurrency slot HERE bounds how many
        // subagents of this parent session execute in parallel — regardless of how many the model
        // fanned out in one message. Ordinary tools never reach this code path.
        return yield* withTaskRunLease(
          runState,
          runOwner,
          TaskConcurrency.withTaskSlot({
            parentSessionID: ctx.sessionID,
            subagentType: params.subagent_type,
            agentMaxConcurrency,
            caps,
            effect: runTaskInner(),
          }),
        ).pipe(Effect.provideService(Database.Service, database))
      })

      const runTaskInner = Effect.fn("TaskTool.runTaskInner")(function* () {
        return yield* runSubagentPrompt({
          ops,
          prompt: params.prompt,
          sessionID: nextSession.id,
          model,
          variant: next.model ? undefined : variant,
          agent: next.name,
          agentModeOverride: childAgentModeOverride,
          outputSchema: resolvedOutputSchema,
          runID: runState.runID,
          budget: researchBudget,
          worktreeInfo,
          onResearchCompleted: (messageID) =>
            markSubagentResearchCompleted(runState, runOwner, messageID).pipe(
              Effect.provideService(Database.Service, database),
            ),
          onFinalizing: (progress) =>
            markSubagentFinalizing(sessions, runState, runOwner, progress).pipe(
              Effect.provideService(Database.Service, database),
            ),
          onFinalized: (messageID) =>
            markSubagentFinalized(runState, runOwner, messageID).pipe(
              Effect.provideService(Database.Service, database),
            ),
          tools: {
            ...(evaluatePermission("todowrite", "*", next.permission).action === "allow" ? {} : { todowrite: false }),
            ...(evaluatePermission(id, "*", next.permission).action === "allow"
              ? {}
              : { task: false, task_status: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
        })
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        _state: "completed" | "error",
        _text: string,
      ) {
        yield* dispatchNotifications()
      })

      // Mark the subagent session as FINISHED once it completes a run. A subagent does exactly one
      // turn and is then done — but the runtime only drops it back to `idle` (an in-memory status that
      // never persists), so the panel showed every completed subagent as merely "idle" forever, as if
      // it were still available to talk to. We persist a terminal marker in the session's own metadata
      // (`deepagent.subagent.finished`) instead of archiving it: archived sessions are filtered out of
      // the app's session store, which would remove the subagent from the panel entirely — but the
      // requirement is that it stays listed and its full reasoning/output remain viewable. This marker
      // only flips the UI to "已完成" and disables the composer; it touches no message/part data.
      // Read-merge because setMetadata replaces the whole metadata object.
      const markFinished = Effect.fn("TaskTool.markSubagentFinished")(function* (
        state: "completed" | "error" | "cancelled" | "interrupted",
        reason?: SubagentTerminalReason,
        details?: SettlementDetails,
      ) {
        const won = yield* settleSubagentRun(sessions, runState, runOwner, state, reason ?? "runtime_error", {
          output: details?.output,
          error: details?.error,
          notification: details?.notifyText ? notification(details.notifyText) : undefined,
        }).pipe(Effect.provideService(Database.Service, database))
        if (!won) yield* Effect.fail(lostTaskRunLease(runState))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed")
              return markFinished("completed", resolvedOutputSchema ? "structured_output_valid" : "text_output_valid", {
                output: result.info.output ?? "",
                notifyText: renderOutput({
                  sessionID: nextSession.id,
                  state: "completed",
                  summary: `Background task completed: ${params.description}`,
                  text: result.info.output ?? "",
                  maxChars: flags.subagentOutputMaxChars,
                }),
              }).pipe(Effect.andThen(inject("completed", result.info.output ?? "")))
            if (result.info?.status === "error")
              return markFinished("error", terminalReason(result.info.error), {
                error: {
                  code: terminalReason(result.info.error),
                  message: result.info.error ?? "Task failed",
                },
                notifyText: renderOutput({
                  sessionID: nextSession.id,
                  state: "error",
                  summary: `Background task failed: ${params.description}`,
                  text: result.info.error ?? "Task failed",
                  maxChars: flags.subagentOutputMaxChars,
                }),
              }).pipe(Effect.andThen(inject("error", result.info.error ?? "")))
            if (result.info?.status === "cancelled") return markFinished("cancelled", "parent_interrupted")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
            maxChars: flags.subagentOutputMaxChars,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all(
          [
            ctx.metadata({
              title: params.description,
              metadata: { ...metadata, background: true, jobId: nextSession.id },
            }),
            notify(nextSession.id),
          ],
          { discard: true },
        ),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
            maxChars: flags.subagentOutputMaxChars,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            // Promoted to background: `notify` (registered via onPromote) owns the finish marker.
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") {
              yield* markFinished("error", terminalReason(result.error), {
                error: { code: terminalReason(result.error), message: result.error ?? "Task failed" },
              })
              return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            }
            if (result?.status === "cancelled") {
              yield* markFinished("interrupted", "human")
              return yield* Effect.fail(
                new Error(
                  `Task interrupted by the user. Partial work is preserved in subagent session ${nextSession.id}. ` +
                    `Call task_read({ task_id: "${nextSession.id}" }) before retrying or duplicating the task.`,
                ),
              )
            }
            yield* markFinished("completed", resolvedOutputSchema ? "structured_output_valid" : "text_output_valid", {
              output: result?.output ?? "",
            })
            return {
              title: params.description,
              metadata,
              output: renderOutput({
                sessionID: nextSession.id,
                state: "completed",
                text: result?.output ?? "",
                maxChars: flags.subagentOutputMaxChars,
              }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
