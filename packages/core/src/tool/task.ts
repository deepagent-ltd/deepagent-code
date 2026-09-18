export * as TaskTool from "./task"

import { ToolFailure } from "@deepagent-code/llm"
import Ajv from "ajv"
import { Cause, Effect, Exit, Option } from "effect"
import { Context, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { SessionSchema, SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { TaskRunAuthority } from "../session/task-run"
import { Delegation } from "./delegation"
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  MAX_SUBAGENT_FANOUT,
  admitTaskCall,
  inheritedTaskPermissions,
  resolveOutputSchema,
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
})

const Output = Schema.Struct({
  task_id: Schema.String,
  text: Schema.String,
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

// A failed child drain surfaces as a typed RunError (step budget, model error...); its message is
// populated (R3) so the parent sees why the subagent stopped.
const drainMessage = (error: unknown) => {
  const message = error instanceof Error && error.message.trim() ? error.message : String(error)
  return message.slice(0, 300)
}

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
                      Effect.mapError(() =>
                        toolFailure(`Permission denied: task cannot launch agent type "${params.subagent_type}".`),
                      ),
                    )
                  if (!admitTaskCall(context.sessionID, context.assistantMessageID, context.toolCallID))
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
                  if (restriction === "shared_workspace_write")
                    return yield* toolFailure(
                      `Cannot launch write-capable agent type "${params.subagent_type}" in Core V2: task worktree isolation is not available yet. Use a read-only subagent or run the work in the primary session.`,
                    )
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
                  const durableLaunch = Effect.gen(function* () {
                    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
                    const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
                    if (!database || !events)
                      return yield* toolFailure(
                        `task is unavailable: durable authority services missing from the runner context (database: ${database ? "ok" : "missing"}, events: ${events ? "ok" : "missing"})`,
                      )
                    const admitted = yield* TaskRunAuthority.submit(database.db, events, sessions, {
                      parentSessionID: context.sessionID,
                      parentMessageID: context.assistantMessageID,
                      toolCallID: context.toolCallID,
                      deliveryMode: "foreground",
                      prompt: new Prompt({ text: params.prompt }),
                      agent: resolved.id,
                      ...(outputSchema === undefined ? {} : { outputSchema }),
                      child: {
                        title: `task: ${params.description}`,
                        location: parent.location,
                        permissions: inheritedTaskPermissions(parentAgent?.permissions ?? [], parent.permissions),
                      },
                    }).pipe(
                      Effect.mapError((error) =>
                        toolFailure(
                          error._tag === "TaskRunAuthority.AdmissionConflict"
                            ? "Cannot launch task: this tool call was already admitted with a different request."
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
                    return {
                      childID: admitted.run.childSessionID,
                      text:
                        result.outcome === "completed"
                          ? result.research
                          : `${result.research}\n\n[task ended before completion: ${result.outcome === "timeout" ? `timed out after ${DEFAULT_SUBAGENT_TIMEOUT_MS}ms` : result.failureMessage} — resume with task_id "${admitted.run.childSessionID}" to continue.]`,
                    }
                  })
                  const resumeLaunch = Effect.gen(function* () {
                    const childID = SessionSchema.ID.make(params.task_id!)
                    return { childID, text: yield* drive(childID, params.prompt) }
                  })
                  const launch = yield* (params.task_id === undefined ? durableLaunch : resumeLaunch)
                  const childID = launch.childID
                  const research = launch.text
                  if (!outputSchema) return { task_id: childID, text: research }
                  // `prompt` is a durable admission. Once the shared deadline wins, never enqueue
                  // one or two doomed 1ms finalizer prompts into the child inbox.
                  if (timedOut)
                    return yield* toolFailure(
                      `Subagent timed out before it could satisfy the output schema. Task id ${childID} holds the partial turns.`,
                    )

                  // Structured contract (V1 finalizer parity): the schema rides the prompt text — V2
                  // has no provider-side format — with one bounded correction attempt.
                  const boundedRaw = research.slice(0, 24_000)
                  let correction: string | undefined
                  for (const attempt of [1, 2] as const) {
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
                    const candidate = extractStructuredText(yield* drive(childID, finalizerText))
                    if (timedOut) {
                      correction = "Subagent timed out while finalizing structured output."
                      break
                    }
                    if (candidate === undefined) {
                      correction = "Model did not return a JSON value."
                      continue
                    }
                    const error = validateStructuredOutput(outputSchema, candidate)
                    if (!error) return { task_id: childID, text: JSON.stringify(candidate) }
                    correction = error.slice(0, 1_000)
                  }
                  return yield* toolFailure(
                    `Subagent completed but its final answer never validated against the output schema${correction ? `: ${correction}` : ""}. Task id ${childID} holds the raw turns.`,
                  )
                }),
              ),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)
