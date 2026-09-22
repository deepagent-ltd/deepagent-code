export * as TaskTool from "./task"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import Ajv from "ajv"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Cause, Effect, Exit, Option } from "effect"
import { Context, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { ConflictArbiter } from "../deepagent/conflict-arbiter"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { SessionSchema, SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { TaskRunTable, type TaskStructuredOutputReceipt } from "../session/sql"
import { TaskRunAuthority } from "../session/task-run"
import { Delegation } from "./delegation"
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  MAX_SUBAGENT_FANOUT,
  admitTaskCall,
  inheritedTaskPermissions,
  resolveOutputSchema,
  resolveWorkspaceMode,
  taskLaunchRestriction,
  withTaskConcurrency,
} from "./task-policy"
import { Tool } from "./tool"
import { Tools } from "./tools"
import DESCRIPTION from "./task.txt"

export const name = "task"

/**
 * Delegation slot (see tool/delegation.ts for the pattern rationale): the V2 session service
 * lives in the process root and Location-scoped settle fibers cannot see root services. The
 * execution coordinator provides the per-root holder into every drain fiber; the tool reads
 * through it.
 */
export const { DelegationSlot, delegationSlotLayer } = Delegation

/** Root-side capture: requires both the slot and the live SessionV2 service, wires them together. */
export const captureDelegationServiceLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const slot = yield* DelegationSlot
    slot.service = yield* SessionV2.Service
  }),
)

/** V1 parity (deepagent-code subagent-permissions): hard delegation depth ceiling. */
export const MAX_SUBAGENT_DEPTH = 3

/** Bounded structured-output finalizer budget: one conversion prompt + one correction attempt. */
const FINALIZER_ATTEMPTS = [1, 2] as const

const Input = Schema.Struct({
  description: Schema.String.annotate({
    description: "A short (3-5 words) description of the task. Keep it unique — the user sees it.",
  }),
  prompt: Schema.String.annotate({
    description:
      "The task for the agent to perform. For a fresh start this must be a highly detailed description of what the agent should do autonomously, including exactly what information it must return in its final message.",
  }),
  subagent_type: Schema.String.annotate({
    description: "The agent type to launch (e.g. general, explore, researcher, reviewer).",
  }),
  output_schema: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])).annotate({
    description:
      "Optional named schema (ReviewResult or ResearchResult) or raw JSON schema. reviewer/researcher receive their named default automatically.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "Resume a prior subagent session (it continues with its previous messages and tool outputs). Must be a task_id returned by a task launched in THIS session; omit to start a fresh subagent.",
  }),
  file_scope: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional declared file scope (globs or directory prefixes) this task expects to touch. Recorded on the durable run; overlapping scopes across active sibling write tasks raise a non-blocking warning.",
  }),
})

const RunInfo = Schema.Struct({
  agent_type: Schema.String,
  workspace_mode: Schema.Literals(["shared", "worktree"]),
  branch: Schema.optional(Schema.String),
  worktree_state: Schema.optional(Schema.String),
})

const Output = Schema.Struct({
  task_id: Schema.String,
  text: Schema.String,
  run: Schema.optional(RunInfo),
  warnings: Schema.optional(Schema.Array(Schema.String)),
})
export type Output = typeof Output.Type

const toolFailure = (message: string) => new ToolFailure({ message })

/** Port of deepagent-code's task-structured-output extractor (fenced/raw JSON recovery). */
function extractStructuredText(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const objectStart = trimmed.indexOf("{")
  const objectEnd = trimmed.lastIndexOf("}")
  const arrayStart = trimmed.indexOf("[")
  const arrayEnd = trimmed.lastIndexOf("]")
  return [
    trimmed,
    fenced,
    objectStart !== -1 && objectEnd > objectStart ? trimmed.slice(objectStart, objectEnd + 1) : undefined,
    arrayStart !== -1 && arrayEnd > arrayStart ? trimmed.slice(arrayStart, arrayEnd + 1) : undefined,
  ]
    .filter((candidate): candidate is string => candidate !== undefined)
    .map((candidate) => Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(candidate)))
    .find((candidate) => candidate !== undefined)
}

/** Port of deepagent-code's Ajv validation (allErrors, $schema stripped). */
function validateStructuredOutput(schema: Record<string, unknown>, value: unknown) {
  const { $schema: _, ...document } = schema
  const validate = new Ajv({ allErrors: true, strict: false }).compile(document)
  if (validate(value)) return undefined
  return (
    validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ??
    "schema validation failed"
  )
}

/**
 * Port of deepagent-code's degraded structured-output settlement (task-structured-output-evidence):
 * same payload shape (`_degraded`/`_reason`/`_attempts`/`_raw`) so both frontends read one
 * contract. `_raw` is codepoint-safe bounded.
 */
const DEGRADED_RAW_RESULT_MAX_CHARS = 80_000
function makeDegradedStructuredOutput(
  raw: string,
  receipt: Extract<TaskStructuredOutputReceipt, { readonly transport: "degraded_text" }>,
) {
  return JSON.stringify({
    _degraded: true,
    _reason: receipt.reason,
    _attempts: receipt.attempt,
    _raw: Array.from(raw).slice(0, DEGRADED_RAW_RESULT_MAX_CHARS).join(""),
  })
}

/**
 * Depth by parentID chain walk (V1 resolveSessionDepth parity, fail-closed): unknown session,
 * cycles, or an over-long chain all read as MAX so the next spawn refuses.
 */
const sessionDepth = (sessions: SessionV2.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const session = yield* sessions.get(sessionID).pipe(Effect.option)
    if (Option.isNone(session)) return MAX_SUBAGENT_DEPTH
    const visited = new Set<string>([sessionID])
    let cursor = session.value.parentID
    let chainDepth = 0
    const chainLimit = MAX_SUBAGENT_DEPTH + 4
    for (let i = 0; i < chainLimit && cursor !== undefined; i++) {
      if (visited.has(cursor)) return MAX_SUBAGENT_DEPTH
      visited.add(cursor)
      const parent = yield* sessions.get(cursor).pipe(Effect.option)
      if (Option.isNone(parent)) break
      chainDepth++
      cursor = parent.value.parentID
    }
    if (cursor !== undefined) return MAX_SUBAGENT_DEPTH
    return chainDepth
  })

const lastAssistantText = (messages: readonly SessionMessage.Message[]) =>
  messages
    .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
    .flatMap((message) => message.content)
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .at(-1)?.text ?? ""

const lastAssistantMessageID = (messages: readonly SessionMessage.Message[]) =>
  messages
    .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
    .at(-1)?.id

// A failed child drain surfaces as a typed RunError (step budget, model error...); its message is
// populated (R3) so the parent sees why the subagent stopped.
const drainMessage = (error: unknown) => {
  const message = error instanceof Error && error.message.trim() ? error.message : String(error)
  return message.slice(0, 300)
}

// WS4b-S3: task-specific bound for the injected child final text. Core has no RuntimeFlags
// service (that is an app-side module), so the bound is a module constant with the legacy env
// override, read at access time so tests and operators can tune it without a rebuild.
const DEFAULT_SUBAGENT_OUTPUT_MAX_CHARS = 8_000
const subagentOutputMaxChars = () => {
  const raw = process.env["DEEPAGENT_CODE_SUBAGENT_OUTPUT_MAX_CHARS"]
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SUBAGENT_OUTPUT_MAX_CHARS
}

/**
 * The honest timeout notice (WS4b-S2): the timeout settle RETAINS the worktree, so the resume
 * pointer is real — the child's worktree directory and branch still exist; task_close owns the
 * cleanup path. Exported for the tool tests.
 */
export const timeoutNoticeText = (input: { readonly timeoutMs: number; readonly childID: string; readonly branch?: string }) =>
  `[task ended before completion: timed out after ${input.timeoutMs}ms — ${
    input.branch !== undefined ? `worktree retained on branch ${input.branch}` : "partial work retained"
  }; resume with task_id "${input.childID}" to continue, or close it with task_close.]`

/**
 * Tail-biased bound: the conclusion of a subagent result lives at the end, so the kept window is
 * the LAST maxChars codepoints (codepoint-safe — a multibyte character is never cut mid-unit). The
 * truncation notice ALWAYS survives, carrying the task_read pointer and branch so the full result
 * stays reachable.
 */
const boundResultText = (text: string, input: { maxChars: number; taskID: string; branch?: string }) => {
  const cps = Array.from(text)
  if (cps.length <= input.maxChars) return text
  const kept = cps.slice(cps.length - input.maxChars).join("")
  return (
    `${kept}\n\nOutput truncated (${cps.length} chars). Full transcript: task_read(task_id="${input.taskID}"). ` +
    `Branch: ${input.branch ?? "n/a"}`
  )
}

type RunRow = {
  readonly workspace_mode: "shared" | "worktree"
  readonly worktree_branch: string | null
  readonly worktree_state: string
}

const runInfoOf = (row: RunRow | undefined, agentType: string): typeof RunInfo.Type | undefined =>
  row === undefined
    ? undefined
    : {
        agent_type: agentType,
        workspace_mode: row.workspace_mode,
        ...(row.worktree_branch === null ? {} : { branch: row.worktree_branch }),
        worktree_state: row.worktree_state,
      }

const ACTIVE_RUN_STATES = ["admitted", "provisioning", "running", "researching", "finalizing"] as const

/**
 * WS4b-S4 declare-warn-merge arbitration, warn layer: a fresh write-type run whose declared
 * file_scope intersects an ACTIVE sibling run's declared scope earns a non-blocking warning (the
 * physical isolation is the worktree; semantic conflicts land at pr_finalize's typed
 * merge_conflict). Empty/undisclosed scopes are "cannot judge" here — NO warning (the ConflictArbiter
 * module's conservative empty-is-broad rule applies to lock arbitration, not to advisory warnings).
 */
const scopeOverlapWarnings = Effect.fn("task.scopeOverlapWarnings")(function* (
  db: Database.Interface["db"],
  input: {
    readonly parentSessionID: SessionSchema.ID
    readonly fileScope: readonly string[]
    readonly selfChildSessionID: SessionSchema.ID
  },
) {
  const siblings = yield* db
    .select({
      run_id: TaskRunTable.run_id,
      child_session_id: TaskRunTable.child_session_id,
      execution_spec: TaskRunTable.execution_spec,
    })
    .from(TaskRunTable)
    .where(
      and(
        eq(TaskRunTable.parent_session_id, input.parentSessionID),
        eq(TaskRunTable.execution_runtime, "v2"),
        eq(TaskRunTable.mutation_capability, "write"),
        eq(TaskRunTable.control_state, "open"),
        inArray(TaskRunTable.state, [...ACTIVE_RUN_STATES]),
      ),
    )
    .all()
    .pipe(Effect.orDie)

  const claim = (taskID: string, files: readonly string[]): ConflictArbiter.Claim => ({
    taskID,
    agentID: taskID,
    files: [...files],
    symbols: [],
    priority: "normal",
    origin: "human",
  })
  return siblings.flatMap((sibling) => {
    if (sibling.child_session_id === input.selfChildSessionID) return []
    const declared = sibling.execution_spec?.["fileScope"]
    const siblingScope = Array.isArray(declared) ? declared.filter((item): item is string => typeof item === "string") : []
    if (siblingScope.length === 0) return []
    if (!ConflictArbiter.conflicts(claim("incoming", input.fileScope), claim(sibling.run_id, siblingScope))) return []
    const common = input.fileScope.filter((file) => siblingScope.includes(file))
    return [
      `Scope overlaps with active task ${sibling.child_session_id} (${common.join(", ")}); consider sequencing or disjoint scopes.`,
    ]
  })
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentV2.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description: DESCRIPTION,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => {
              const lines = [output.text]
              if (output.warnings !== undefined) lines.push(...output.warnings)
              if (output.run?.branch !== undefined)
                lines.push(
                  `Write-type subagent output is on branch \`${output.run.branch}\`; finalize with pr_finalize, inspect with task_read.`,
                )
              lines.push(`task_id: "${output.task_id}"`)
              return [toolText({ type: "text", text: lines.join("\n") })]
            },
            execute: (params, context) =>
              withTaskConcurrency(
                String(context.sessionID),
                Effect.gen(function* () {
                  yield* permission
                    .assert({
                      action: name,
                      resources: [params.subagent_type],
                      save: [params.subagent_type],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    .pipe(
                      Effect.mapError((error) => {
                        const refusal = PermissionV2.permissionToolFailure(error)
                        if (refusal !== null) return refusal
                        return toolFailure(
                          `Permission denied: task cannot launch agent type "${params.subagent_type}".`,
                        )
                      }),
                    )
                  // Durable fan-out admission (C-P2-08): the ledger lives in the database, so the
                  // service is required BEFORE the cap decision — missing authority is an honest
                  // refusal, never a silent bypass of the cap.
                  const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
                  if (!database)
                    return yield* toolFailure(
                      "task is unavailable: the database service is missing from the runner context (durable fan-out admission)",
                    )
                  const admittedCall = yield* admitTaskCall(database.db, {
                    sessionID: context.sessionID,
                    assistantMessageID: context.assistantMessageID,
                    toolCallID: context.toolCallID,
                  })
                  if (!admittedCall)
                    return yield* toolFailure(
                      `Cannot launch task: one assistant message may start at most ${MAX_SUBAGENT_FANOUT} subagents. Split additional work into a later round.`,
                    )
                  // Root service access flows through the delegation slot (see DelegationSlot):
                  // Location-scoped settle fibers cannot see the process-root SessionV2 service.
                  const slot = Option.getOrUndefined(yield* Effect.serviceOption(DelegationSlot))
                  const sessions = slot?.service
                  if (!sessions)
                    return yield* toolFailure(
                      "task is unavailable: the root composition did not capture the V2 session service for delegation",
                    )
                  const resolved = yield* agents.resolve(params.subagent_type)
                  if (resolved === undefined)
                    return yield* toolFailure(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
                  const restriction = taskLaunchRestriction(resolved)
                  if (restriction === "hidden")
                    return yield* toolFailure(`Cannot launch hidden agent type: ${params.subagent_type}.`)
                  if (restriction === "primary")
                    return yield* toolFailure(`Cannot launch primary agent type: ${params.subagent_type}.`)
                  // Write-capable agents no longer refuse: they resolve to an isolated run-owned
                  // worktree (workspace_mode='worktree'), whose durable preflight receipt settles
                  // BEFORE the child session starts; read-only agents keep the shared parent.
                  const workspaceMode = resolveWorkspaceMode(resolved)
                  const outputSchema = resolveOutputSchema(params.output_schema, params.subagent_type)
                  if (typeof params.output_schema === "string" && outputSchema === undefined)
                    return yield* toolFailure(`Unknown output schema: ${params.output_schema}.`)
                  const parent = yield* sessions.get(context.sessionID).pipe(Effect.orDie)
                  const parentAgent = yield* agents.resolve(parent.agent ?? context.agent)
                  const callerDepth = yield* sessionDepth(sessions, context.sessionID)
                  if (callerDepth >= MAX_SUBAGENT_DEPTH)
                    return yield* toolFailure(
                      `Cannot launch task: subagent depth ${callerDepth} is at the hard limit (MAX_SUBAGENT_DEPTH=${MAX_SUBAGENT_DEPTH}).`,
                    )

                  // Resume contract (V1 parity): only a DIRECT child of this session with the same
                  // agent type may be continued by task_id.
                  if (params.task_id !== undefined) {
                    const target = yield* sessions.get(SessionSchema.ID.make(params.task_id)).pipe(Effect.option)
                    if (Option.isNone(target))
                      return yield* toolFailure(`Cannot resume task "${params.task_id}": unknown session.`)
                    if (String(target.value.parentID ?? "") !== String(context.sessionID))
                      return yield* toolFailure(
                        `Cannot resume task "${params.task_id}": it is not a direct child of the current session.`,
                      )
                    if (target.value.agent !== undefined && String(target.value.agent) !== params.subagent_type)
                      return yield* toolFailure(
                        `Cannot resume task "${params.task_id}": its agent type is "${target.value.agent}" but this call requests "${params.subagent_type}".`,
                      )
                  }
                  const deadline = Date.now() + DEFAULT_SUBAGENT_TIMEOUT_MS
                  let timedOut = false

                  // Follow-up turns (resume-by-task_id first turns, structured-output finalizer
                  // prompts) stay with the tool layer: admit-only prompt + explicit awaited drain.
                  const drive = (childID: SessionSchema.ID, text: string) =>
                    Effect.gen(function* () {
                      if (Date.now() >= deadline) {
                        timedOut = true
                        return `[task ended before completion: timed out after ${DEFAULT_SUBAGENT_TIMEOUT_MS}ms — resume with task_id "${childID}" to continue.]`
                      }
                      // P1-1 contract: admit-only, then an EXPLICIT awaited drain. An advisory wake
                      // (resume: true) races `wait` — the forked drain may not have started when
                      // awaitIdle observes the still-idle child, silently returning an empty result.
                      yield* sessions
                        .prompt({ sessionID: childID, prompt: new Prompt({ text }), resume: false })
                        .pipe(Effect.orDie)
                      // A typed drain failure (step budget exhausted, model error) is the CHILD's
                      // outcome, not a process fault: it degrades into the task result with the
                      // partial transcript so the parent can continue or resume via task_id.
                      // Effect.orDie here killed the whole CLI when a subagent hit its budget.
                      const drain = yield* sessions
                        .resume(childID)
                        .pipe(Effect.exit, Effect.timeoutOption(Math.max(1, deadline - Date.now())))
                      const transcript = yield* sessions
                        .messages({ sessionID: childID, order: "asc" })
                        .pipe(Effect.orDie)
                      const research = lastAssistantText(transcript)
                      if (Option.isNone(drain)) {
                        timedOut = true
                        yield* sessions.interrupt(childID).pipe(Effect.ignore)
                        return `${research}\n\n[task ended before completion: timed out after ${DEFAULT_SUBAGENT_TIMEOUT_MS}ms — resume with task_id "${childID}" to continue.]`
                      }
                      if (Exit.isSuccess(drain.value)) return research
                      const cause = Option.getOrUndefined(Cause.findErrorOption(drain.value.cause))
                      return `${research}\n\n[task ended before completion: ${drainMessage(cause)} — resume with task_id "${childID}" to continue.]`
                    }).pipe(
                      // An interrupted parent turn must not leave the child draining unsupervised; an
                      // idle child interrupt is a no-op per the V2 contract.
                      Effect.onInterrupt(() => sessions.interrupt(childID).pipe(Effect.ignore)),
                    )

                  // Fresh launches are durable TaskRun submissions: the ONE ledger transaction
                  // (task_run + task_admission + task_run_event) precedes every external side
                  // effect, the child session identity is deterministic (crash between ledger and
                  // create converges by adoption), and the single first input lands atomically
                  // with the run's input_state pending→ready CAS. The executor only claims and
                  // resumes the child; it NEVER admits another first prompt.
                  const runRowByID = (runID: string) =>
                    database === undefined
                      ? Effect.succeed(undefined)
                      : database.db
                          .select({
                            workspace_mode: TaskRunTable.workspace_mode,
                            worktree_branch: TaskRunTable.worktree_branch,
                            worktree_state: TaskRunTable.worktree_state,
                          })
                          .from(TaskRunTable)
                          .where(eq(TaskRunTable.run_id, runID))
                          .get()
                          .pipe(Effect.orDie)
                  const latestRunRow = (childID: SessionSchema.ID) =>
                    database === undefined
                      ? Effect.succeed(undefined)
                      : database.db
                          .select({
                            workspace_mode: TaskRunTable.workspace_mode,
                            worktree_branch: TaskRunTable.worktree_branch,
                            worktree_state: TaskRunTable.worktree_state,
                          })
                          .from(TaskRunTable)
                          .where(
                            and(
                              eq(TaskRunTable.parent_session_id, context.sessionID),
                              eq(TaskRunTable.child_session_id, childID),
                            ),
                          )
                          .orderBy(desc(TaskRunTable.generation))
                          .get()
                          .pipe(Effect.orDie)
                  const durableLaunch = Effect.gen(function* () {
                    const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
                    if (!database || !events)
                      return yield* toolFailure(
                        `task is unavailable: durable authority services missing from the runner context (database: ${database ? "ok" : "missing"}, events: ${events ? "ok" : "missing"})`,
                      )
                    // S4 warn layer (fresh launches only): declared-scope overlap with ACTIVE
                    // write-type siblings. Computed BEFORE admission; advisory only, never blocks.
                    const warnings =
                      workspaceMode === "worktree" && params.file_scope !== undefined && params.file_scope.length > 0
                        ? yield* scopeOverlapWarnings(database.db, {
                            parentSessionID: context.sessionID,
                            fileScope: params.file_scope,
                            selfChildSessionID: TaskRunAuthority.deterministicChildSessionID({
                              parentSessionID: context.sessionID,
                              parentMessageID: context.assistantMessageID,
                              toolCallID: context.toolCallID,
                            }),
                          })
                        : []
                    const admitted = yield* TaskRunAuthority.submit(database.db, events, sessions, {
                      parentSessionID: context.sessionID,
                      parentMessageID: context.assistantMessageID,
                      toolCallID: context.toolCallID,
                      deliveryMode: "foreground",
                      prompt: new Prompt({ text: params.prompt }),
                      agent: resolved.id,
                      ...(outputSchema === undefined ? {} : { outputSchema }),
                      ...(params.file_scope === undefined ? {} : { fileScope: params.file_scope }),
                      child: {
                        title: `task: ${params.description}`,
                        location: parent.location,
                        permissions: inheritedTaskPermissions(parentAgent?.permissions ?? [], parent.permissions),
                        ...(workspaceMode === "worktree" ? { workspace: { mode: "worktree" as const } } : {}),
                      },
                    }).pipe(
                      Effect.mapError((error) =>
                        toolFailure(
                          error._tag === "TaskRunAuthority.AdmissionConflict"
                            ? "Cannot launch task: this tool call was already admitted with a different request."
                            : error._tag === "TaskWorkspace.Error"
                              ? `Cannot launch task: workspace isolation failed (${error.code}): ${error.message}`
                              : `Cannot launch task: ${error._tag}`,
                        ),
                      ),
                    )
                    const result = yield* TaskRunAuthority.execute({
                      db: database.db,
                      run: admitted.run,
                      sessions,
                      timeoutMs: Math.max(1, deadline - Date.now()),
                    }).pipe(Effect.mapError(() =>
                      toolFailure(
                        `Task ${admitted.run.childSessionID} lost its durable execution lease; it can be resumed by task_id.`,
                      ),
                    ))
                    if (result.outcome === "timeout") timedOut = true
                    const run = runInfoOf(yield* runRowByID(admitted.run.runID), params.subagent_type)
                    return {
                      childID: admitted.run.childSessionID,
                      runID: admitted.run.runID,
                      warnings,
                      run,
                      text:
                        result.outcome === "completed"
                          ? result.research
                          : result.outcome === "timeout"
                            ? `${result.research}\n\n${timeoutNoticeText({
                                timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
                                childID: admitted.run.childSessionID,
                                ...(run?.branch === undefined ? {} : { branch: run.branch }),
                              })}`
                            : `${result.research}\n\n[task ended before completion: ${result.failureMessage} — resume with task_id "${admitted.run.childSessionID}" to continue.]`,
                    }
                  })
                  const resumeLaunch = Effect.gen(function* () {
                    const childID = SessionSchema.ID.make(params.task_id!)
                    const text = yield* drive(childID, params.prompt)
                    return {
                      childID,
                      runID: undefined,
                      warnings: [] as string[],
                      run: runInfoOf(yield* latestRunRow(childID), params.subagent_type),
                      text,
                    }
                  })
                  const launch = yield* (params.task_id === undefined ? durableLaunch : resumeLaunch)
                  const childID = launch.childID
                  const research = launch.text
                  const warnings = launch.warnings
                  const runInfo = launch.run
                  if (!outputSchema)
                    return {
                      task_id: childID,
                      text: boundResultText(research, {
                        maxChars: subagentOutputMaxChars(),
                        taskID: childID,
                        ...(runInfo?.branch === undefined ? {} : { branch: runInfo.branch }),
                      }),
                      ...(runInfo === undefined ? {} : { run: runInfo }),
                      ...(warnings.length === 0 ? {} : { warnings }),
                    }
                  // `prompt` is a durable admission. Once the shared deadline wins, never enqueue
                  // one or two doomed 1ms finalizer prompts into the child inbox.
                  if (timedOut)
                    return yield* toolFailure(
                      `Subagent timed out before it could satisfy the output schema. Task id ${childID} holds the partial turns.`,
                    )

                  // Structured contract (V1 finalizer parity): the schema rides the prompt text — V2
                  // has no provider-side format — with one bounded correction attempt. Budget
                  // exhaustion settles DEGRADED (bug-V2.0-003, e829ebf5a parity): a receipt-stamped
                  // {_degraded,_reason,_attempts,_raw} payload, never a hard failure of the parent
                  // turn. A shared-deadline timeout stays a hard failure.
                  //
                  // Structured evidence authority: a durable run that settled COMPLETED records its
                  // finalizer verdict exactly once through the V2 authority (fail-closed — a
                  // validated candidate without a sealed evidence row is a typed tool failure).
                  // Runs that settled failed/interrupted carry the 'unvalidated' evidence their
                  // settle transaction already sealed, so the finalizer never re-records; a
                  // resume-by-task_id continuation has no live run row and is skipped.
                  const schemaName =
                    typeof params.output_schema === "string"
                      ? params.output_schema.trim()
                      : params.output_schema === undefined
                        ? `default:${params.subagent_type}`
                        : "inline"
                  const recordEvidence = (
                    validationOutcome: "validated" | "validation_failed",
                    rawOutput: string,
                    outputMessageID?: SessionMessage.ID,
                  ) =>
                    Effect.gen(function* () {
                      if (launch.runID === undefined) return
                      if (!database) return yield* Effect.die("task finalizer evidence requires the database service")
                      const run = yield* TaskRunAuthority.get(database.db, launch.runID)
                      if (run?.state !== "completed") return
                      yield* TaskRunAuthority.recordStructuredEvidence(database.db, {
                        runId: launch.runID,
                        schemaName,
                        schema: outputSchema,
                        validationOutcome,
                        rawOutput,
                        ...(outputMessageID === undefined ? {} : { outputMessageID }),
                        ownerToken: `core-v2-finalizer:${childID}`,
                      })
                    })

                  const boundedRaw = research.slice(0, 24_000)
                  let correction: string | undefined
                  // The last attempt's failure kind becomes the degraded receipt's reason. The
                  // timeout break below leaves it unset: only an exhausted schema budget degrades.
                  let exhausted: "structured_output_missing" | "structured_output_invalid" | undefined
                  for (const attempt of FINALIZER_ATTEMPTS) {
                    const finalizerText = [
                      attempt === 1
                        ? "Convert the persisted research result below into the requested StructuredOutput schema."
                        : "Return exactly one JSON value matching the output schema below. Do not use Markdown or explanatory prose.",
                      "Do not continue research and do not add facts that are absent from the result.",
                      ...(correction ? [`Previous validation error: ${correction}`] : []),
                      `<output_schema>${JSON.stringify(outputSchema)}</output_schema>`,
                      "<research_result>",
                      boundedRaw,
                      "</research_result>",
                    ].join("\n")
                    const response = yield* drive(childID, finalizerText)
                    if (timedOut) {
                      correction = "Subagent timed out while finalizing structured output."
                      break
                    }
                    const candidate = extractStructuredText(response)
                    if (candidate === undefined) {
                      correction = "Model did not return a JSON value."
                      exhausted = "structured_output_missing"
                      continue
                    }
                    const error = validateStructuredOutput(outputSchema, candidate)
                    if (!error) {
                      // Bind the evidence to the child session_message that carries the final
                      // answer — the finalizer turn just drained, so it is the last assistant
                      // message (the documented fallback binding when the exact id is unavailable).
                      const transcript = yield* sessions
                        .messages({ sessionID: childID, order: "asc" })
                        .pipe(Effect.orDie)
                      yield* recordEvidence("validated", JSON.stringify(candidate).slice(0, 24_000), lastAssistantMessageID(transcript)).pipe(
                        Effect.mapError((failure) =>
                          toolFailure(
                            `Task ${childID} produced a schema-valid structured output, but recording its durable evidence failed (${failure._tag}); retry the task call to seal the result.`,
                          ),
                        ),
                      )
                      return {
                        task_id: childID,
                        text: JSON.stringify(candidate),
                        ...(runInfo === undefined ? {} : { run: runInfo }),
                        ...(warnings.length === 0 ? {} : { warnings }),
                      }
                    }
                    correction = error.slice(0, 1_000)
                    exhausted = "structured_output_invalid"
                  }
                  if (exhausted === undefined)
                    return yield* toolFailure(
                      `Subagent completed but its final answer never validated against the output schema${correction ? `: ${correction}` : ""}. Task id ${childID} holds the raw turns.`,
                    )
                  const degraded = makeDegradedStructuredOutput(boundedRaw, {
                    attempt: FINALIZER_ATTEMPTS.length,
                    transport: "degraded_text",
                    reason: exhausted,
                  })
                  const exhaustedTranscript = yield* sessions.messages({ sessionID: childID, order: "asc" }).pipe(Effect.orDie)
                  yield* recordEvidence("validation_failed", degraded, lastAssistantMessageID(exhaustedTranscript)).pipe(
                    // Evidence is best-effort (e829ebf5a parity): the degraded payload is the
                    // settlement, and a missing row reads as explicit-recovery on status surfaces.
                    Effect.ignoreCause({ log: "Warn", message: "task finalizer degraded evidence unavailable" }),
                  )
                  return {
                    task_id: childID,
                    text: degraded,
                    ...(runInfo === undefined ? {} : { run: runInfo }),
                    ...(warnings.length === 0 ? {} : { warnings }),
                  }
                }),
              ),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)
