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
import { Cause, Duration, Effect, Exit, Fiber, Option, Schedule, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { and, desc, eq } from "drizzle-orm"
import { Worktree } from "@/worktree"
import { Git } from "@/git"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { ensureSessionBranch } from "../agent/pr-collaboration"
import { PRQueue } from "../agent/pr-queue"
import { Orchestration } from "../agent/schema/orchestration"
import { Orchestration as CoreOrchestration } from "@deepagent-code/core/deepagent/orchestration"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { downgradeOneLevel, type AgentMode } from "@deepagent-code/core/deepagent/mode"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { TaskConcurrency } from "./task-concurrency"
import { TaskDispatcher } from "@/session/task-dispatcher" // L10: durable queue
import { SessionToolCapability, type ToolCapabilitySnapshot } from "@/session/tool-capability" // P0-10
import { ToolRegistry } from "@/tool/registry" // P0-10
import { MCP } from "@/mcp" // P0-10
import { Plugin } from "@/plugin" // P0-10
import Ajv from "ajv"
import { KeyedMutex } from "@deepagent-code/core/effect/keyed-mutex"
import { Log } from "@deepagent-code/core/util/log"
import { FSUtil } from "@deepagent-code/core/fs-util"
import {
  admitTaskRun,
  claimTaskProvisioning,
  deliverTaskNotifications,
  failAdmittedTaskRun,
  getActiveTaskRunByChild,
  getTaskRun,
  isQuiescent,
  isTerminal,
  markTaskFinalized,
  markTaskFinalizing,
  markTaskResearchCompleted,
  renewTaskRunLease,
  settleTaskRun,
  transitionToAdmitting,
  startTaskRun,
  type ErrorData,
  type Run as DurableTaskRun,
} from "./task-run"
import { LegacyTaskInput } from "@/session/task-input"
import { TaskWorkspacePreflight } from "@/session/workspace-preflight"
import { SessionBranchProvisioner } from "@/session/branch-provisioner"
import { TaskWorktree } from "@/session/task-worktree"
import { submitAutomaticWorktree, type SubmittedPR } from "@/session/task-pr-submission"

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
// Token usage is provider- and cache-dependent, so it is deliberately not a hard task boundary. The
// step, wall-time, no-progress, and output bounds remain the operational safety limits.
export const DEFAULT_SUBAGENT_RESEARCH_BUDGET = {
  maxSteps: 64,
  maxWallMs: 30 * 60_000,
  maxNoProgress: 6,
} as const

export type SubagentResearchBudget = {
  readonly maxSteps: number
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
  directStructuredOutput?: boolean
  finalizerInstructions?: readonly string[]
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
  | "attempt_timeout"
  | "budget_exhausted"
  | "execution_lease_expired"
  | "runtime_error"
const subagentSettlementLocks = KeyedMutex.makeUnsafe<SessionID>()
const sharedWriteFallbackLocks = KeyedMutex.makeUnsafe<string>()

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

/**
 * P1-11: Project a durable executor's terminal state into the child session metadata.
 *
 * Called from the dispatcher's onClaimed callback (prompt.ts) after
 * LegacySubagentExecutor.runFromClaim completes (or fails). Looks up the
 * most-recently settled TaskRun row for the given child session and writes
 * `deepagent.subagent.{finished, state, reason, settled_at}` so the parent's
 * task-status polling sees a terminal state without depending on the legacy
 * in-process settlement path.
 *
 * Idempotent: if `subagent.finished === true` for the matching run, it no-ops.
 */
export function projectDurableSettledRun(sessions: Session.Interface, childSessionID: SessionID) {
  return subagentSettlementLocks.withLock(childSessionID)(
    Effect.gen(function* () {
      const database = yield* Database.Service
      // Find the highest-generation settled run for this child session.
      const row = yield* database.db
        .select({
          run_id: TaskRunTable.run_id,
          generation: TaskRunTable.generation,
          state: TaskRunTable.state,
          reason: TaskRunTable.reason,
          time_settled: TaskRunTable.time_settled,
        })
        .from(TaskRunTable)
        .where(and(eq(TaskRunTable.child_session_id as any, childSessionID as any), eq(TaskRunTable.phase, "settled")))
        .orderBy(desc(TaskRunTable.generation))
        .limit(1)
        .get()
        .pipe(Effect.orElseSucceed(() => undefined))
      if (!row) return
      const current = yield* sessions.get(childSessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!current) return
      const { deepagent, subagent } = subagentMetadata(current.metadata)
      // Guard: only update if run_id matches and not already finished
      if (subagent.run_id !== row.run_id || subagent.finished === true) return
      const terminalStates = ["completed", "error", "cancelled", "interrupted"] as const
      type TerminalState = (typeof terminalStates)[number]
      const state: TerminalState = (terminalStates as ReadonlyArray<string>).includes(row.state)
        ? (row.state as TerminalState)
        : "error"
      yield* sessions.setMetadata({
        sessionID: childSessionID,
        metadata: {
          ...current.metadata,
          deepagent: {
            ...deepagent,
            subagent: {
              ...subagent,
              finished: true,
              state,
              phase: "settled",
              settled_at: row.time_settled ?? Date.now(),
              reason: row.reason ?? "unknown",
            },
          },
        },
      })
      taskLog.info("subagent.durable-settled-projected", {
        run_id: row.run_id,
        child_session_id: childSessionID,
        state,
        reason: row.reason,
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
  return Effect.scoped(
    Effect.gen(function* () {
      const execution = yield* Effect.forkScoped(effect)
      const renewal = yield* Effect.forkScoped(heartbeat)
      return yield* Effect.raceFirst(Fiber.join(execution), Fiber.join(renewal)).pipe(
        Effect.ensuring(Effect.all([Fiber.interrupt(execution), Fiber.interrupt(renewal)], { discard: true })),
      )
    }),
  )
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
    if (input.directStructuredOutput) {
      if (!input.outputSchema) {
        return yield* Effect.fail(new Error("Direct structured output requires an output schema"))
      }
      taskLog.info("subagent.structured.started", {
        run_id: input.runID,
        child_session_id: input.sessionID,
      })
      const result = yield* input.ops
        .prompt({
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
              structured_direct: true,
            },
          },
          tools: input.tools,
          parts: [...parts, ...(input.finalizerInstructions ?? []).map((text) => ({ type: "text" as const, text }))],
        })
        .pipe(
          Effect.timeout(Duration.millis(budget.maxWallMs)),
          Effect.catchIf(Cause.isTimeoutError, () =>
            Effect.fail(
              taskError({
                code: "budget_exhausted",
                message: `Structured output wall-time budget exhausted (${budget.maxWallMs}ms).`,
                sessionID: input.sessionID,
                phase: "finalize",
              }),
            ),
          ),
        )
      const error = assistantError(result)
      if (error) {
        return yield* Effect.fail(
          taskError({
            code: error.name === "APIError" ? "provider_error" : "structured_output_invalid",
            message: `${error.name}: ${error.message}`,
            sessionID: input.sessionID,
            phase: "finalize",
            attempts: 1,
          }),
        )
      }

      const structured = result.info.role === "assistant" ? result.info.structured : undefined
      if (structured === undefined) {
        return yield* Effect.fail(
          taskError({
            code: "structured_output_missing",
            message: "Model did not call StructuredOutput.",
            sessionID: input.sessionID,
            phase: "finalize",
            attempts: 1,
          }),
        )
      }
      const validationError = validateStructuredOutput(input.outputSchema, structured)
      if (validationError) {
        return yield* Effect.fail(
          taskError({
            code: "structured_output_invalid",
            message: validationError.slice(0, 1_000),
            sessionID: input.sessionID,
            phase: "finalize",
            attempts: 1,
          }),
        )
      }
      if (input.onFinalized) yield* input.onFinalized(result.info.id)
      taskLog.info("subagent.structured.completed", {
        run_id: input.runID,
        child_session_id: input.sessionID,
        result_message_id: result.info.id,
      })
      return JSON.stringify(structured)
    }
    taskLog.info("subagent.research.started", {
      run_id: input.runID,
      child_session_id: input.sessionID,
      max_steps: budget.maxSteps,
      max_wall_ms: budget.maxWallMs,
    })
    const leafInstruction =
      input.tools.task === false
        ? [
            {
              type: "text" as const,
              text: "You are a leaf subagent. Do not call task or task_status and do not delegate further; perform the assigned work directly with the tools available in this session.",
            },
          ]
        : []
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
                max_wall_ms: budget.maxWallMs,
                max_no_progress: budget.maxNoProgress,
              },
            },
            ...(input.agentModeOverride ? { agent_mode_override: input.agentModeOverride } : {}),
          },
        },
        tools: input.tools,
        parts: [
          ...(input.worktreeInfo
            ? [
                {
                  type: "text" as const,
                  text:
                    `You are running in an ISOLATED git worktree at ${input.worktreeInfo.directory} (branch ${input.worktreeInfo.branch ?? "detached"}). ` +
                    `You inherited context from the parent session, but your working directory is this worktree. ` +
                    `Re-read files before editing (do not trust remembered paths/contents), and know your changes stay isolated until merged back.`,
                },
              ]
            : []),
          ...leafInstruction,
          ...parts,
        ],
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
              "Preserve exact evidence identifiers, literals, paths, and values when the research result says they must appear in a schema field.",
              ...(input.finalizerInstructions ?? []),
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
  prepareTaskInput?(input: SessionPrompt.PromptInput, timeCreated: number): Effect.Effect<SessionV1.WithParts, unknown>
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

// L10: durable dispatch — returned when background task is enqueued to the durable queue
const BACKGROUND_DISPATCHED = [
  "Background task has been enqueued in the durable control plane.",
  "It will be picked up and executed automatically. You will be notified when it finishes.",
  "DO NOT duplicate this task or poll for status — use task_status to check on it.",
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
  state: "running" | "completed" | "error" | "interrupted"
  summary?: string
  text: string
  maxChars?: number
}) {
  const tag = input.state === "error" || input.state === "interrupted" ? "task_error" : "task_result"
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

function withPRSubmission(output: string, pr: SubmittedPR | undefined) {
  if (!pr) return output
  return [
    output,
    `<pr id="${pr.id}" state="awaiting_review" implementation_commit_sha="${pr.workerCommit}">`,
    "Call pr_finalize after every foreground write task in this batch has returned.",
    "</pr>",
  ].join("\n")
}

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
  readonly inject: (state: "completed" | "error" | "interrupted", text: string) => Effect.Effect<unknown, unknown>
  readonly automaticWriteIsolation: boolean
  readonly submitWorktree: () => Effect.Effect<SubmittedPR | undefined, unknown>
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
    const git = Option.getOrUndefined(yield* Effect.serviceOption(Git.Service))
    const queue = Option.getOrUndefined(yield* Effect.serviceOption(PRQueue.Service))
    const flock = Option.getOrUndefined(yield* Effect.serviceOption(EffectFlock.Service))
    const worktree = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
    // P0-10: optional capability services — present when TaskTool runs inside the full session context
    const toolRegistrySvc = Option.getOrUndefined(yield* Effect.serviceOption(ToolRegistry.Service))
    const mcpSvc = Option.getOrUndefined(yield* Effect.serviceOption(MCP.Service))
    const pluginSvc = Option.getOrUndefined(yield* Effect.serviceOption(Plugin.Service))

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
      const childPermission = [
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
      ]

      // Runtime tool calls always carry callID. Direct programmatic callers (primarily tests and
      // embedded integrations) predate that contract, so give those invocations a unique identity;
      // exact-retry semantics are available only when the caller supplies the stable callID.
      const toolCallID = ctx.callID ?? Identifier.ascending("tool")
      const reviewerSessionID = SessionID.make(`ses_pr_reviewer_${ctx.messageID}`)
      const prID = `pr:${ctx.sessionID}:${toolCallID}`
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
        maxWallMs: flags.subagentResearchWallMs ?? DEFAULT_SUBAGENT_RESEARCH_BUDGET.maxWallMs,
        maxNoProgress: flags.subagentNoProgressLimit ?? DEFAULT_SUBAGENT_RESEARCH_BUDGET.maxNoProgress,
      }
      let capSnap: ToolCapabilitySnapshot | undefined
      if (toolRegistrySvc && mcpSvc && pluginSvc) {
        capSnap = yield* SessionToolCapability.snapshot().pipe(
          Effect.provideService(ToolRegistry.Service, toolRegistrySvc),
          Effect.provideService(MCP.Service, mcpSvc),
          Effect.provideService(Plugin.Service, pluginSvc),
        )
      }
      const agentIsWriteCapable = capSnap
        ? capSnap.tools.some(
            (tool) =>
              capSnap.enabledToolIDs.includes(tool.toolID) &&
              tool.workspaceMutation === "possible" &&
              evaluatePermission(tool.toolID, "*", childPermission).action === "allow",
          ) || capSnap.interceptors.some((hook) => hook.taskReachable && hook.workspaceMutation === "possible")
        : subagentIsWriteType(next)
      const workspaceMode = params.isolation === "worktree" || agentIsWriteCapable ? "worktree" : "shared"
      // B-9 (P1-14): ensureSessionBranch moved AFTER admitTaskRun.
      // Branch creation is a Git side effect that must not precede admission — if admission
      // fails (conflict, DB error) there must be no orphaned branch with no ledger entry.
      const activeRun = session
        ? yield* getActiveTaskRunByChild(session.id).pipe(Effect.provideService(Database.Service, database))
        : undefined
      const activeJob = activeRun ? yield* background.get(activeRun.childSessionID) : undefined
      // P0-8: find the active task run for the PARENT session (ctx.sessionID) so we can link the new
      // child run into the causal graph with the correct parent_run_id and root_run_id.
      // Only exists when the parent session is itself a subagent (depth > 1).
      const parentActiveRun = yield* getActiveTaskRunByChild(ctx.sessionID).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orElseSucceed(() => undefined),
      )
      const admission = yield* admitTaskRun({
        parentSessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        toolCallID,
        childSessionID: session?.id,
        joinRunID: activeRun?.runID,
        // P0-8: propagate parent run ID for causal graph linkage + ancestor-open check
        parentRunID: parentActiveRun?.runID,
        request: params,
        deliveryMode: runInBackground ? "background" : "foreground",
        mutationCapability: agentIsWriteCapable ? "write" : "read_only",
        toolCapabilityHash: capSnap?.hash ?? "static-write-type",
        inputState: flags.subagentControlPlane === "durable" ? "pending" : "legacy",
        workspaceMode,
        workspaceOwner: params.isolation === "worktree" ? "caller" : workspaceMode === "worktree" ? "run" : "parent",
        workspaceVisibility: workspaceMode === "worktree" ? "base_commit" : "live",
        parentDirtyPolicy: workspaceMode === "worktree" ? (session ? "exclude" : "reject") : "allow_live",
        workspacePreflightState: flags.subagentControlPlane === "durable" ? "pending" : "legacy",
        sessionMode: session ? "resume" : "new",
        // L3d: freeze the execution spec so prepare() can build the V1 message without re-reading params
        executionSpec: {
          description: params.description,
          prompt: { text: params.prompt ?? params.description ?? "" },
          agent: next.name,
          model: {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(variant ? { variant } : {}),
          },
          ...(capSnap
            ? {
                tools: Object.fromEntries(capSnap.enabledToolIDs.toSorted().map((toolID) => [toolID, true] as const)),
              }
            : {}),
          permission: childPermission,
        },
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

      const admittedSession =
        session ??
        (yield* sessions.get(admission.run.childSessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined))))
      if (
        flags.subagentControlPlane === "durable" &&
        admission.run.workspaceOwner === "run" &&
        !queue &&
        admission.run.state === "admitted"
      ) {
        const message = "Durable automatic writers require the PR queue service before provider execution"
        yield* failAdmittedTaskRun({
          run: admission.run,
          reason: "pr_queue_unavailable",
          error: { code: "pr_queue_unavailable", message },
        }).pipe(Effect.provideService(Database.Service, database))
        return yield* Effect.fail(
          taskError({
            code: "pr_queue_unavailable",
            message,
            sessionID: admission.run.childSessionID,
            phase: "research",
            attempts: 0,
          }),
        )
      }
      const collaborationPR =
        admittedSession && queue
          ? (yield* queue.list().pipe(
              Effect.catchCause((cause) =>
                flags.subagentControlPlane === "durable" && admission.run.state === "admitted"
                  ? failAdmittedTaskRun({
                      run: admission.run,
                      reason: "pr_queue_unavailable",
                      error: { code: "pr_queue_unavailable", message: Cause.pretty(cause) },
                    }).pipe(Effect.provideService(Database.Service, database), Effect.andThen(Effect.failCause(cause)))
                  : Effect.failCause(cause),
              ),
            ))
              .filter((entry) => entry.parentID === ctx.sessionID && entry.workerID === admittedSession.id)
              .toSorted((left, right) => right.updatedAt - left.updatedAt)[0]
          : undefined
      if (session && collaborationPR && collaborationPR.status !== "changes_requested") {
        const message =
          `Cannot resume task "${session.id}" while PR ${collaborationPR.id} is ${collaborationPR.status}. ` +
          (collaborationPR.status === "awaiting_review" || collaborationPR.status === "approved"
            ? "Call pr_finalize before asking the author to revise it."
            : "Only a PR in changes_requested may resume its author worktree.")
        if (admission.run.state === "admitted") {
          yield* failAdmittedTaskRun({
            run: admission.run,
            reason: "pr_resume_blocked",
            error: { code: "pr_resume_blocked", message },
          }).pipe(Effect.provideService(Database.Service, database))
        }
        return yield* Effect.fail(new Error(message))
      }

      // -----------------------------------------------------------------------
      // L3a: Freeze mutation_capability at admission time (design §2.2.1)
      // L3b: Workspace preflight — automatic writers must reject dirty workspaces (design §3.2, §15.3.3)
      // -----------------------------------------------------------------------
      // BUG-001-405 Fix-D: separate capability classification from isolation policy.
      //   agentIsWriteCapable — does the agent's permission ruleset allow file mutation?
      //     Drives mutation_capability in the DB and the preflight dirty-workspace check.
      //
      // The old single `isReadOnly` mixed in params.isolation, so an explicitly isolated
      // read-only agent appeared write-capable and triggered a spurious workspace check.
      // The two concepts are orthogonal and must be tested independently:
      //   capability  → agentIsWriteCapable (below)
      //   isolation   → params.isolation === "worktree" || agentIsWriteCapable
      //                 (computed at the worktree-provisioning call site when that is wired up)
      const workspaceReceipt =
        flags.subagentControlPlane === "durable" && admission.run.state === "admitted"
          ? yield* (
              session && admission.run.workspaceMode === "worktree"
                ? TaskWorkspacePreflight.reuse({
                    runID: admission.run.runID,
                    childSessionID: admission.run.childSessionID,
                    childDirectory: session.directory,
                    git,
                    flock,
                  })
                : TaskWorkspacePreflight.ensure({
                    runID: admission.run.runID,
                    parentDirectory: parent.directory,
                    mutationCapability: admission.run.mutationCapability,
                    workspaceMode: admission.run.workspaceMode,
                    git,
                    flock,
                  })
            ).pipe(
              Effect.provideService(Database.Service, database),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (!(error instanceof TaskWorkspacePreflight.WorkspacePreflightError)) {
                    return yield* Effect.fail(error)
                  }
                  const current = yield* getTaskRun(admission.run.runID).pipe(
                    Effect.provideService(Database.Service, database),
                  )
                  if (current?.state === "admitted") {
                    yield* failAdmittedTaskRun({
                      run: current,
                      reason: `workspace_preflight_${error.code}`,
                      error: { code: error.code, message: error.message },
                    }).pipe(Effect.provideService(Database.Service, database))
                  }
                  return yield* Effect.fail(
                    taskError({
                      code: error.code,
                      message: error.message,
                      sessionID: admission.run.childSessionID,
                      phase: "research",
                      attempts: 0,
                    }),
                  )
                }),
              ),
            )
          : undefined

      // Branch creation is the first workspace side effect. It must happen only after durable
      // admission and the dirty-workspace preflight have both succeeded.
      if (
        flags.subagentControlPlane === "durable" &&
        admission.run.state === "admitted" &&
        admission.run.mutationCapability === "write" &&
        admission.run.workspaceOwner === "run" &&
        !session &&
        workspaceReceipt &&
        git &&
        flock
      ) {
        const current = yield* getTaskRun(admission.run.runID).pipe(Effect.provideService(Database.Service, database))
        if (!current) return yield* Effect.die(new Error(`Task run ${admission.run.runID} disappeared`))
        yield* SessionBranchProvisioner.ensureExact({
          runID: admission.run.runID,
          runVersion: current.version,
          parentSessionID: parent.id,
          repositoryRoot: workspaceReceipt.repositoryRoot,
          baseCommit: workspaceReceipt.baseCommit,
          parentDirectory: parent.directory,
        }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.provideService(Git.Service, git),
          Effect.provideService(EffectFlock.Service, flock),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const diagnostic = String(Cause.squash(cause))
              const latest = yield* getTaskRun(admission.run.runID).pipe(
                Effect.provideService(Database.Service, database),
              )
              if (!latest || latest.state !== "admitted") return yield* Effect.failCause(cause)
              yield* failAdmittedTaskRun({
                run: latest,
                reason: "workspace_preflight_failed",
                error: { code: "workspace_preflight_failed", message: diagnostic },
              }).pipe(
                Effect.provideService(Database.Service, database),
                Effect.catchCause((dbErr) =>
                  Effect.logWarning("Failed to settle task after workspace preflight error", {
                    runID: admission.run.runID,
                    cause: Cause.pretty(dbErr),
                  }),
                ),
              )
              return yield* Effect.failCause(cause)
            }),
          ),
        )
      }

      if (
        flags.subagentControlPlane !== "durable" &&
        admission.runCreated &&
        params.isolation !== "worktree" &&
        agentIsWriteCapable &&
        git &&
        queue
      ) {
        yield* ensureSessionBranch({ git, directory: parent.directory, sessionID: parent.id }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* failAdmittedTaskRun({
                run: admission.run,
                reason: "workspace_preflight_failed",
                error: { code: "workspace_preflight_failed", message: String(Cause.squash(cause)) },
              }).pipe(Effect.provideService(Database.Service, database), Effect.ignore)
              return yield* Effect.failCause(cause)
            }),
          ),
        )
      }

      const durableWorktreeInfo =
        flags.subagentControlPlane === "durable" &&
        admission.run.state === "admitted" &&
        admission.run.workspaceMode === "worktree" &&
        workspaceReceipt
          ? session
            ? git && flock
              ? yield* TaskWorktree.reuseExact({
                  runID: admission.run.runID,
                  childSessionID: admission.run.childSessionID,
                  childDirectory: session.directory,
                  repositoryRoot: workspaceReceipt.repositoryRoot,
                  git,
                  flock,
                }).pipe(
                  Effect.provideService(Database.Service, database),
                  Effect.catch((error) =>
                    error instanceof TaskWorktree.TaskWorktreeError
                      ? Effect.fail(
                          taskError({
                            code: error.code,
                            message: error.message,
                            sessionID: admission.run.childSessionID,
                            phase: "research",
                            attempts: 0,
                          }),
                        )
                      : Effect.fail(error),
                  ),
                )
              : yield* Effect.die("Workspace continuation passed preflight without Git and lock services")
            : worktree && flock
              ? yield* TaskWorktree.ensureExact({
                  runID: admission.run.runID,
                  repositoryRoot: workspaceReceipt.repositoryRoot,
                  baseCommit: workspaceReceipt.baseCommit,
                  worktree,
                  flock,
                }).pipe(
                  Effect.provideService(Database.Service, database),
                  Effect.catch((error) =>
                    error instanceof TaskWorktree.TaskWorktreeError
                      ? Effect.fail(
                          taskError({
                            code: error.code,
                            message: error.message,
                            sessionID: admission.run.childSessionID,
                            phase: "research",
                            attempts: 0,
                          }),
                        )
                      : Effect.fail(error),
                  ),
                )
              : yield* Effect.gen(function* () {
                  const current = yield* getTaskRun(admission.run.runID).pipe(
                    Effect.provideService(Database.Service, database),
                  )
                  if (current?.state === "admitted") {
                    yield* failAdmittedTaskRun({
                      run: current,
                      reason: "worktree_unavailable",
                      error: {
                        code: "worktree_unavailable",
                        message: "Durable isolated tasks require Worktree and repository lock services",
                      },
                    }).pipe(Effect.provideService(Database.Service, database))
                  }
                  return yield* Effect.fail(
                    taskError({
                      code: "worktree_unavailable",
                      message: "Durable isolated tasks require Worktree and repository lock services",
                      sessionID: admission.run.childSessionID,
                      phase: "research",
                      attempts: 0,
                    }),
                  )
                })
          : undefined

      // -----------------------------------------------------------------------
      // L10: Durable control plane routing
      // Design: subagent-control-plane-design.zh-CN.md §13.3, §10.1, §10.2
      // -----------------------------------------------------------------------
      // Only activate durable path when explicitly set to "durable".
      // "shadow" intentionally routes through legacy path until §4 cutover protocol is complete.
      if (flags.subagentControlPlane === "durable") {
        // Move admitted → queued so the dispatcher can pick it up
        if (admission.runCreated || admission.run.state === "admitted") {
          // L3d: Input projection — only for newly created or admitted runs without input yet
          if (admission.run.inputState !== "ready") {
            const frozenAgent = admission.run.executionSpec?.agent ?? next.name
            const frozenModel = admission.run.executionSpec?.model ?? {
              providerID: model.providerID,
              modelID: model.modelID,
              ...(variant ? { variant } : {}),
            }
            const frozenPermission = admission.run.executionSpec?.permission ?? childPermission
            const childDirectory = durableWorktreeInfo?.directory ?? parent.directory
            const existingChild =
              session ??
              (yield* sessions
                .get(admission.run.childSessionID)
                .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined))))

            if (existingChild) {
              const exactAdoption =
                existingChild.parentID === ctx.sessionID &&
                existingChild.directory === childDirectory &&
                existingChild.agent === frozenAgent &&
                existingChild.model?.providerID === frozenModel.providerID &&
                existingChild.model.id === frozenModel.modelID &&
                existingChild.model.variant === frozenModel.variant &&
                JSON.stringify(existingChild.permission ?? []) === JSON.stringify(frozenPermission)
              if (!exactAdoption) {
                yield* failAdmittedTaskRun({
                  run: admission.run,
                  reason: "child_session_conflict",
                  error: {
                    code: "child_session_conflict",
                    message: `Child session ${admission.run.childSessionID} exists with a conflicting durable identity.`,
                  },
                }).pipe(Effect.provideService(Database.Service, database))
                return yield* Effect.fail(
                  new Error(`Child session ${admission.run.childSessionID} conflicts with the frozen execution spec`),
                )
              }
            } else {
              yield* sessions.create({
                id: admission.run.childSessionID,
                parentID: ctx.sessionID,
                title: params.description + ` (@${frozenAgent} subagent)`,
                agent: frozenAgent,
                model: {
                  id: ModelV2.ID.make(frozenModel.modelID),
                  providerID: ProviderV2.ID.make(frozenModel.providerID),
                  ...(frozenModel.variant ? { variant: frozenModel.variant } : {}),
                },
                metadata: { deepagent: { [SUBAGENT_DEPTH_META_KEY]: childDepth } },
                permission: frozenPermission,
                directory: childDirectory,
              })
            }

            // The terminal projector is fenced by run_id/generation so an older run cannot overwrite
            // a newer continuation. Initialize that identity before input admission for both newly
            // created and exactly adopted child Sessions.
            yield* projectSubagentRun(sessions, admission.run)

            // Step 1: CAS admitted → admitting (marks projection start; idempotent if already admitting)
            const latestRun = yield* getTaskRun(admission.run.runID).pipe(
              Effect.provideService(Database.Service, database),
            )
            if (!latestRun) return yield* Effect.die(new Error(`Task run ${admission.run.runID} disappeared`))
            const admittingRun = yield* transitionToAdmitting({
              runID: admission.run.runID,
              version: latestRun.version,
            }).pipe(Effect.provideService(Database.Service, database))

            if (admittingRun) {
              // Step 2: run reference/file/plugin/image preparation exactly once after the durable
              // admitting marker, without writing V1 rows. Tests and older embedders without the
              // preparation API retain the deterministic plain-text fallback.
              const preparedEnvelope = ops.prepareTaskInput
                ? yield* ops
                    .prepareTaskInput(
                      {
                        messageID: admittingRun.childMessageID,
                        sessionID: admittingRun.childSessionID,
                        model: {
                          providerID: ProviderV2.ID.make(frozenModel.providerID),
                          modelID: ModelV2.ID.make(frozenModel.modelID),
                        },
                        variant: frozenModel.variant,
                        agent: frozenAgent,
                        tools: admittingRun.executionSpec?.tools,
                        metadata: {
                          deepagent: {
                            task_admission: {
                              run_id: admittingRun.runID,
                              origin_key: admittingRun.originKey ?? null,
                              request_hash: admittingRun.requestHash,
                            },
                          },
                        },
                        parts: yield* ops.resolvePromptParts(
                          admittingRun.executionSpec?.prompt?.text ?? params.prompt ?? params.description,
                        ),
                      },
                      admittingRun.timeCreated,
                    )
                    .pipe(Effect.orDie)
                : undefined
              const prepared = yield* LegacyTaskInput.prepare(admittingRun, preparedEnvelope).pipe(Effect.orDie)

              // Step 3: atomically write V1 message/parts and CAS input_state: admitting → ready
              yield* LegacyTaskInput.projectExact({
                prepared,
                runID: admission.run.runID,
                expectedRunVersion: admittingRun.version,
              }).pipe(Effect.provideService(Database.Service, database))
            } else {
              const current = yield* getTaskRun(admission.run.runID).pipe(
                Effect.provideService(Database.Service, database),
              )
              if (current?.inputState === "admitting") {
                return yield* Effect.fail(
                  new Error(
                    `Task input admission for ${current.runID} already started; hooks will not be replayed until startup classification or explicit recovery resolves the unknown outcome`,
                  ),
                )
              }
            }
          }

          // Step 4: re-read run for current version, then enqueue (ready → queued)
          const currentRun = yield* getTaskRun(admission.run.runID).pipe(
            Effect.provideService(Database.Service, database),
          )
          if (currentRun && (currentRun.inputState === "ready" || currentRun.inputState === "legacy")) {
            yield* TaskDispatcher.enqueueRun({
              runID: admission.run.runID,
              runVersion: currentRun.version,
            }).pipe(Effect.provideService(Database.Service, database))
          }
        }

        if (runInBackground) {
          // Background durable: return immediately; delivery daemon notifies parent
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
              summary: `Background task enqueued: ${params.description}`,
              text: BACKGROUND_DISPATCHED,
              maxChars: flags.subagentOutputMaxChars,
            }),
          }
        }

        // Foreground durable: poll task_run.state until terminal
        const pollMs = 500
        const maxWaitMs = flags.subagentTimeoutMs ?? 1_800_000
        const maxPolls = Math.ceil(maxWaitMs / pollMs) + 1

        let polledRun: DurableTaskRun | undefined
        for (let i = 0; i <= maxPolls; i++) {
          const cur = yield* getTaskRun(admission.run.runID).pipe(Effect.provideService(Database.Service, database))
          if (cur && (isTerminal(cur) || isQuiescent(cur))) {
            polledRun = cur
            break
          }
          if (i < maxPolls) yield* Effect.sleep(Duration.millis(pollMs))
        }

        if (!polledRun) {
          // Timed out waiting for durable run to complete
          return yield* Effect.fail(
            taskError({
              code: "timeout",
              message:
                `Durable foreground task timed out after ${maxWaitMs}ms. ` +
                `Call task_read({ task_id: "${admission.run.childSessionID}" }) to inspect state.`,
              sessionID: admission.run.childSessionID,
              phase: "research",
              attempts: 1,
            }),
          )
        }
        const terminalRun = polledRun

        if (terminalRun.state === "completed") {
          return {
            title: params.description,
            metadata: {
              parentSessionId: ctx.sessionID,
              sessionId: terminalRun.childSessionID,
              subagentType: params.subagent_type,
              model,
            },
            output: renderOutput({
              sessionID: terminalRun.childSessionID,
              state: "completed",
              summary: params.description,
              text: terminalRun.output ?? "",
              maxChars: flags.subagentOutputMaxChars,
            }),
          }
        }

        return yield* Effect.fail(
          taskError({
            code: terminalRun.state ?? "unknown",
            message:
              terminalRun.error?.message ??
              `Subagent settled as ${terminalRun.state}${terminalRun.reason ? `: ${terminalRun.reason}` : ""}. ` +
                `Call task_read({ task_id: "${terminalRun.childSessionID}" }) to inspect partial work.`,
            sessionID: terminalRun.childSessionID,
            phase: "research",
            attempts: terminalRun.startAttempts ?? 1,
          }),
        )
      }
      // ── End durable routing — legacy path continues below ─────────────────

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
      const resumedWorktreeInfo =
        admittedSession &&
        collaborationPR?.status === "changes_requested" &&
        typeof collaborationPR.metadata?.workerDirectory === "string" &&
        FSUtil.resolve(admittedSession?.directory ?? "") === FSUtil.resolve(collaborationPR.metadata.workerDirectory)
          ? {
              name: `agent-${params.subagent_type}-${admittedSession.id}`,
              directory: FSUtil.resolve(admittedSession.directory),
              ...(git ? { branch: yield* git.branch(admittedSession.directory) } : {}),
            }
          : undefined
      const ownsActiveRun = (run: DurableTaskRun) =>
        (run.state === "researching" || run.state === "running" || run.state === "finalizing") &&
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

      // A finite attempt wall limit prevents a hung child from blocking the parent forever. Expiry
      // interrupts the same child and preserves its transcript/worktree for explicit recovery. Provider
      // work is never replayed automatically because timeout is not evidence that its side effects are safe.
      if (flags.subagentTimeoutMs !== undefined) {
        const timeoutMs = flags.subagentTimeoutMs

        const spawnAttempt = Effect.fn("TaskTool.spawnAttempt")(function* (runState: DurableTaskRun) {
          const resumed = admittedSession
          const isolate = !resumed && (params.isolation === "worktree" || subagentIsWriteType(next))
          const worktreeOpt =
            isolate || resumedWorktreeInfo
              ? yield* Effect.serviceOption(Worktree.Service)
              : Option.none<Worktree.Interface>()
          const worktreeInfo =
            resumedWorktreeInfo ??
            (isolate && Option.isSome(worktreeOpt)
              ? yield* worktreeOpt.value
                  .createReady({ name: `agent-${params.subagent_type}-${Identifier.ascending("tool")}` })
                  .pipe(Effect.catchTag("WorktreeNotGitError", () => Effect.succeed(undefined)))
              : undefined)
          const nextSession =
            resumed ??
            (yield* sessions.create({
              id: runState.childSessionID,
              parentID: ctx.sessionID,
              title: params.description + ` (@${next.name} subagent)`,
              agent: next.name,
              ...(worktreeInfo ? { directory: FSUtil.resolve(worktreeInfo.directory) } : {}),
              // F5: write normalised depth into metadata so future resolveSessionDepth calls for this
              // session return the correct value without needing to walk the full parentID chain.
              metadata: {
                deepagent: { [SUBAGENT_DEPTH_META_KEY]: childDepth },
              },
              permission: childPermission,
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
                effect:
                  subagentIsWriteType(next) && !a.worktreeInfo
                    ? sharedWriteFallbackLocks.withLock(FSUtil.resolve(parent.directory))(runTaskInner())
                    : runTaskInner(),
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
            _state: "completed" | "error" | "interrupted",
            _text: string,
          ) {
            yield* dispatchNotifications()
          })

          // Explicit isolation is caller-owned. Automatic isolation is only removed through safeRemove
          // after a normal terminal path; timeout never calls this helper, so partial work is preserved.
          const automaticWriteIsolation = params.isolation !== "worktree" && !!a.worktreeInfo
          const teardownWorktree = Effect.fn("TaskTool.teardownWorktree")(function* (force: boolean) {
            if (!a.worktreeInfo || (!automaticWriteIsolation && !force)) return
            const worktreeOpt = yield* Effect.serviceOption(Worktree.Service)
            if (Option.isNone(worktreeOpt)) return
            yield* (
              force
                ? worktreeOpt.value.remove({ directory: a.worktreeInfo.directory })
                : worktreeOpt.value.safeRemove({ directory: a.worktreeInfo.directory })
            ).pipe(Effect.ignore)
          })

          // Automatically isolated write agents submit a scoped commit to the durable PR queue.
          // Explicit isolation stays detached and never enters the automatic collaboration flow.
          const parentDir = parent.directory
          const submitWorktree = Effect.fn("TaskTool.submitWorktree")(function* () {
            if (!a.worktreeInfo || !automaticWriteIsolation) return undefined
            if (!parentDir || !git || !queue) {
              return yield* Effect.fail(
                new Error(`Automatic PR submission unavailable; worker preserved at ${a.worktreeInfo.directory}`),
              )
            }
            return yield* submitAutomaticWorktree({
              git,
              queue,
              info: a.worktreeInfo,
              parentDirectory: parentDir,
              parentSessionID: ctx.sessionID,
              workerSessionID: a.nextSession.id,
              reviewerSessionID,
              batchID: ctx.messageID,
              prID,
              description: params.description,
              prompt: params.prompt,
            })
          })

          const bundle: AttemptBundle = {
            worktreeInfo: a.worktreeInfo,
            worktree: a.worktree,
            nextSession: a.nextSession,
            metadata,
            automaticWriteIsolation,
            markFinished,
            inject,
            submitWorktree,
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
                driveBackground(bundle),
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

        const driveForeground = (b: AttemptBundle): Effect.Effect<AttemptResult, unknown> =>
          Effect.gen(function* () {
            const runCancel = yield* EffectBridge.make()
            const cancel = Effect.all(
              [
                background.cancel(b.nextSession.id).pipe(Effect.ignore),
                ops.cancel(b.nextSession.id).pipe(Effect.ignore),
              ],
              { concurrency: "unbounded", discard: true },
            )
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
                  if (result.timedOut) return { kind: "timeout" as const }
                  if (result.info?.status === "error")
                    return { kind: "error" as const, reason: result.info.error ?? "Task failed" }
                  if (result.info?.status === "cancelled") return { kind: "cancelled" as const }
                  return { kind: "completed" as const, output: result.info?.output ?? "" }
                }),
              (_, exit) =>
                Effect.gen(function* () {
                  if (Exit.hasInterrupts(exit)) yield* cancel
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
              const pr = yield* b.submitWorktree().pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const diagnostic = Cause.squash(cause)
                    yield* b.markFinished("error", "runtime_error", {
                      error: { code: "runtime_error", message: String(diagnostic) },
                    })
                    yield* b.inject("error", `PR submission failed: ${String(diagnostic)}`)
                    yield* b.teardownWorktree(false)
                    return yield* Effect.fail(new Error(`PR submission failed: ${String(diagnostic)}`))
                  }),
                ),
              )
              const output = withPRSubmission(outcome.output, pr)
              yield* b.markFinished(
                "completed",
                resolvedOutputSchema ? "structured_output_valid" : "text_output_valid",
                { output },
              )
              if (!pr) yield* b.teardownWorktree(b.automaticWriteIsolation)
              return {
                title: params.description,
                metadata: { ...b.metadata, ...(pr ? { prId: pr.id, workerCommit: pr.workerCommit } : {}) },
                output: renderOutput({
                  sessionID: b.nextSession.id,
                  state: "completed",
                  text: output,
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
            if (outcome.kind === "error") {
              const reason = terminalReason(outcome.reason)
              yield* b.markFinished("error", reason, { error: { code: reason, message: outcome.reason } })
              yield* b.teardownWorktree(false)
              return yield* Effect.fail(
                taskError({
                  code: reason,
                  message: `The subagent failed and was not automatically retried: ${outcome.reason}`,
                  sessionID: b.nextSession.id,
                  phase: outcome.reason.includes("Phase: finalize") ? "finalize" : "research",
                }),
              )
            }
            yield* cancel
            taskLog.warn("subagent.attempt_timeout", {
              run_id: admission.run.runID,
              child_session_id: b.nextSession.id,
              timeout_ms: timeoutMs,
              automatic_retry: false,
            })
            yield* b.markFinished("interrupted", "attempt_timeout", {
              error: { code: "attempt_timeout", message: `timed out after ${timeoutMs}ms` },
            })
            return yield* Effect.fail(
              taskError({
                code: "attempt_timeout",
                message: `The subagent attempt timed out after ${timeoutMs}ms. Automatic retry is disabled.`,
                sessionID: b.nextSession.id,
                phase: "research",
              }),
            )
          })

        const driveBackground = (b: AttemptBundle): Effect.Effect<void> =>
          Effect.gen(function* () {
            const waited = yield* background.wait({ id: b.nextSession.id, timeout: timeoutMs })
            const status = waited.info?.status
            if (!waited.timedOut && status === "completed") {
              const pr = yield* b.submitWorktree().pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const diagnostic = Cause.squash(cause)
                    const text = `PR submission failed: ${String(diagnostic)}`
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
                    yield* b.inject("error", text)
                    yield* b.teardownWorktree(false)
                    return yield* Effect.fail(new Error(text))
                  }),
                ),
              )
              const output = withPRSubmission(waited.info?.output ?? "", pr)
              yield* b.markFinished(
                "completed",
                resolvedOutputSchema ? "structured_output_valid" : "text_output_valid",
                {
                  output,
                  notifyText: renderOutput({
                    sessionID: b.nextSession.id,
                    state: "completed",
                    summary: `Background task completed: ${params.description}`,
                    text: output,
                    maxChars: flags.subagentOutputMaxChars,
                  }),
                },
              )
              if (!pr) yield* b.teardownWorktree(b.automaticWriteIsolation)
              yield* b.inject("completed", output)
              return
            }
            if (!waited.timedOut && status === "cancelled") {
              yield* b.markFinished("interrupted", "parent_interrupted")
              yield* b.teardownWorktree(false)
              return
            }
            if (waited.timedOut) {
              yield* background.cancel(b.nextSession.id).pipe(Effect.ignore)
              const text = `The subagent attempt timed out after ${timeoutMs}ms. Automatic retry is disabled. Partial work is preserved in subagent session ${b.nextSession.id}. Call task_read({ task_id: "${b.nextSession.id}" }) before continuing.`
              taskLog.warn("subagent.attempt_timeout", {
                run_id: admission.run.runID,
                child_session_id: b.nextSession.id,
                timeout_ms: timeoutMs,
                automatic_retry: false,
                background: true,
              })
              yield* b.markFinished("interrupted", "attempt_timeout", {
                error: { code: "attempt_timeout", message: `timed out after ${timeoutMs}ms` },
                notifyText: renderOutput({
                  sessionID: b.nextSession.id,
                  state: "interrupted",
                  summary: `Background task interrupted: ${params.description}`,
                  text,
                  maxChars: flags.subagentOutputMaxChars,
                }),
              })
              yield* b.inject("interrupted", text)
              return
            }
            if (status === "error") {
              const error = waited.info?.error ?? "Task failed"
              const reason = terminalReason(error)
              const guarded = reason === "budget_exhausted" || reason === "doom_loop"
              const text = guarded
                ? `The subagent stopped because its execution budget or loop guard was exhausted: ${error}`
                : `The subagent failed and was not automatically retried: ${error}`
              yield* b.markFinished("error", reason, {
                error: { code: reason, message: error },
                notifyText: renderOutput({
                  sessionID: b.nextSession.id,
                  state: "error",
                  summary: `Background task stopped: ${params.description}`,
                  text,
                  maxChars: flags.subagentOutputMaxChars,
                }),
              })
              yield* b.teardownWorktree(false)
              yield* b.inject("error", text)
              return
            }
          }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

        const initialRun = claimedRun ?? admission.run
        const started = yield* startAttempt(yield* spawnAttempt(initialRun), initialRun, true)
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
          yield* driveBackground(started.bundle)
          return backgroundResult(started.bundle)
        }
        return yield* driveForeground(started.bundle)
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
      const worktreeOpt =
        isolate || resumedWorktreeInfo
          ? yield* Effect.serviceOption(Worktree.Service)
          : Option.none<Worktree.Interface>()
      const worktreeInfo =
        resumedWorktreeInfo ??
        (isolate && Option.isSome(worktreeOpt)
          ? yield* worktreeOpt.value
              .createReady({ name: `agent-${params.subagent_type}-${Identifier.ascending("tool")}` })
              .pipe(Effect.catchTag("WorktreeNotGitError", () => Effect.succeed(undefined)))
          : undefined)

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
          permission: childPermission,
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
            effect:
              subagentIsWriteType(next) && !worktreeInfo
                ? sharedWriteFallbackLocks.withLock(FSUtil.resolve(parent.directory))(runTaskInner())
                : runTaskInner(),
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

      const automaticWriteIsolation = params.isolation !== "worktree" && !!worktreeInfo
      const teardownWorktree = Effect.fn("TaskTool.teardownWorktree")(function* (force: boolean) {
        if (!worktreeInfo || (!automaticWriteIsolation && !force) || Option.isNone(worktreeOpt)) return
        yield* (
          force
            ? worktreeOpt.value.remove({ directory: worktreeInfo.directory })
            : worktreeOpt.value.safeRemove({ directory: worktreeInfo.directory })
        ).pipe(Effect.ignore)
      })
      const submitWorktree = Effect.fn("TaskTool.submitWorktree")(function* () {
        if (!worktreeInfo || !automaticWriteIsolation) return undefined
        if (!parent.directory || !git || !queue) {
          return yield* Effect.fail(
            new Error(`Automatic PR submission unavailable; worker preserved at ${worktreeInfo.directory}`),
          )
        }
        return yield* submitAutomaticWorktree({
          git,
          queue,
          info: worktreeInfo,
          parentDirectory: parent.directory,
          parentSessionID: ctx.sessionID,
          workerSessionID: nextSession.id,
          reviewerSessionID,
          batchID: ctx.messageID,
          prID,
          description: params.description,
          prompt: params.prompt,
        })
      })
      const complete = Effect.fn("TaskTool.complete")(function* (output: string, notifyParent: boolean) {
        const pr = yield* submitWorktree().pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const diagnostic = String(Cause.squash(cause))
              const text = `PR submission failed: ${diagnostic}`
              yield* markFinished("error", "runtime_error", {
                error: { code: "runtime_error", message: diagnostic },
                ...(notifyParent
                  ? {
                      notifyText: renderOutput({
                        sessionID: nextSession.id,
                        state: "error",
                        summary: `Background task failed: ${params.description}`,
                        text,
                        maxChars: flags.subagentOutputMaxChars,
                      }),
                    }
                  : {}),
              })
              yield* teardownWorktree(false)
              if (notifyParent) yield* inject("error", text)
              return yield* Effect.fail(new Error(text))
            }),
          ),
        )
        const completedOutput = withPRSubmission(output, pr)
        yield* markFinished("completed", resolvedOutputSchema ? "structured_output_valid" : "text_output_valid", {
          output: completedOutput,
          ...(notifyParent
            ? {
                notifyText: renderOutput({
                  sessionID: nextSession.id,
                  state: "completed",
                  summary: `Background task completed: ${params.description}`,
                  text: completedOutput,
                  maxChars: flags.subagentOutputMaxChars,
                }),
              }
            : {}),
        })
        if (!pr) yield* teardownWorktree(automaticWriteIsolation)
        if (notifyParent) yield* inject("completed", completedOutput)
        return pr
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return complete(result.info.output ?? "", true)
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
              }).pipe(Effect.andThen(teardownWorktree(false)), Effect.andThen(inject("error", result.info.error ?? "")))
            if (result.info?.status === "cancelled")
              return markFinished("cancelled", "parent_interrupted").pipe(Effect.andThen(teardownWorktree(false)))
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
      const cancel = Effect.all(
        [background.cancel(nextSession.id).pipe(Effect.ignore), ops.cancel(nextSession.id).pipe(Effect.ignore)],
        { concurrency: "unbounded", discard: true },
      )

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
              yield* teardownWorktree(false)
              return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            }
            if (result?.status === "cancelled") {
              yield* markFinished("interrupted", "human")
              yield* teardownWorktree(false)
              return yield* Effect.fail(
                new Error(
                  `Task interrupted by the user. Partial work is preserved in subagent session ${nextSession.id}. ` +
                    `Call task_read({ task_id: "${nextSession.id}" }) before retrying or duplicating the task.`,
                ),
              )
            }
            const pr = yield* complete(result?.output ?? "", false)
            return {
              title: params.description,
              metadata: { ...metadata, ...(pr ? { prId: pr.id, workerCommit: pr.workerCommit } : {}) },
              output: renderOutput({
                sessionID: nextSession.id,
                state: "completed",
                text: withPRSubmission(result?.output ?? "", pr),
                maxChars: flags.subagentOutputMaxChars,
              }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) {
              yield* cancel
              yield* teardownWorktree(false)
            }
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
