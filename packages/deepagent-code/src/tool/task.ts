import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionSchema, SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionID, MessageID } from "../session/schema"
import { Agent } from "../agent/agent"
import {
  deriveSubagentSessionPermission,
  filterPrimaryToolsForSubagent,
  subagentIsWriteType,
  admitChildOrFail,
  MAX_SUBAGENT_DEPTH,
} from "../agent/subagent-permissions"
import { evaluate as evaluatePermission } from "../permission"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Cause, Duration, Effect, Exit, Option, Schema } from "effect"
import { Orchestration } from "../agent/schema/orchestration"
import { Orchestration as CoreOrchestration } from "@deepagent-code/core/deepagent/orchestration"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { TaskConcurrency } from "./task-concurrency"
import { TaskTool as CoreTaskTool } from "@deepagent-code/core/tool/task"
import { Log } from "@deepagent-code/core/util/log"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Identifier } from "@/id/id"
import { extractStructuredText, validateStructuredOutput } from "./task-structured-output"

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
 * default schema is applied automatically. Precedence: an EXPLICIT schema (named / alias / raw
 * object) always wins over the auto-mounted default. Any other subagent with no registered default
 * keeps the unchanged free-text extraction path (returns undefined).
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
type FinalizerAttempt = 1 | 2

function isFinalizerAttempt(attempt: number): attempt is FinalizerAttempt {
  return attempt === 1 || attempt === 2
}
// W6 (fail-closed write authorization): the single V2 durable authority runs children in the
// PARENT's shared workspace — there is no worktree isolation — so a write-capable fresh spawn or an
// explicit worktree request must fail closed instead of silently un-isolating writes into the
// parent checkout. The typed failure keeps the `isolation_unavailable` reason vocabulary used
// across runtimes so operators can grep one token.
export class TaskWriteAuthorizationError extends Schema.TaggedErrorClass<TaskWriteAuthorizationError>()(
  "TaskWriteAuthorizationError",
  {
    code: Schema.Literal("isolation_unavailable"),
    detail: Schema.String,
  },
) {}

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

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")

// Durable dispatch — returned when a background task is admitted to the durable V2 control plane.
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
  // L3 (v3.8.0 §L3): when set, the subagent's FINAL turn is forced through the structured-output
  // path so the result parses deterministically instead of scraping its last text part. Accepts a
  // named orchestration schema ("ReviewResult" / "ResearchResult" / "ReviewFinding"), the alias
  // "default"/"auto" (⇒ the subagent's natural default), or a raw JSON Schema object.
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
  // I33-4: when a bound is configured, the parent receives a bounded excerpt with a pointer to the
  // subagent session (full text stays queryable there). Codepoint-safe: slice on the codepoint
  // array so a multibyte character is never cut mid-unit. The truncation notice ALWAYS survives so
  // the pointer to the full subagent session never gets dropped.
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

// ── V2 session helpers (mirror core/src/tool/task.ts) ────────────────────────────────────────

const v2LastAssistantText = (messages: readonly SessionMessage.Message[]) =>
  messages
    .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
    .flatMap((message) => message.content)
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .at(-1)?.text ?? ""

// A failed child drain surfaces with its message populated so the parent sees why it stopped.
const drainMessage = (error: unknown) => {
  const message = error instanceof Error && error.message.trim() ? error.message : String(error)
  return message.slice(0, 300)
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
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

      // G3 — runtime fan-out gate. A FRESH researcher/reviewer spawn on a session the runtime
      // classified as simple (complexity 0) is rejected before admission: the model was told not to
      // orchestrate, and this is the enforcement half. Resume (task_id) always passes.
      if (
        params.task_id === undefined &&
        (params.subagent_type === "researcher" || params.subagent_type === "reviewer")
      ) {
        const parentState = AgentGateway.DeepAgentSessionState.get(ctx.sessionID)
        if (parentState != null) {
          const signals = CoreOrchestration.estimateSignalsFromText({ userRequest: parentState.userRequest })
          const complexity = CoreOrchestration.estimateComplexity(signals)
          if (complexity === 0) {
            return yield* Effect.fail(
              new Error(
                "Orchestration gate: the runtime classified this session's task as simple " +
                  "(single-scope, mechanical, or quick). Do not fan out researcher/reviewer subagents; " +
                  "complete the task yourself. If the task genuinely requires multi-module analysis or " +
                  "review, state that explicitly to the user first.",
              ),
            )
          }
        }
      }
      const resolvedOutputSchema = resolveOutputSchema(params.output_schema, params.subagent_type)
      if (typeof params.output_schema === "string" && resolvedOutputSchema === undefined) {
        return yield* Effect.fail(new Error(`Unknown output schema: ${params.output_schema}.`))
      }

      // Write isolation fail-closed (W6): the authority's children share the parent workspace, so a
      // fresh write-capable spawn or an explicit worktree request must refuse instead of silently
      // un-isolating writes into the parent checkout. Resume of an existing child is NOT gated.
      if (params.task_id === undefined && (params.isolation === "worktree" || subagentIsWriteType(next))) {
        return yield* Effect.fail(
          new TaskWriteAuthorizationError({
            code: "isolation_unavailable",
            detail:
              params.isolation === "worktree"
                ? "worktree-isolated tasks are not available on the V2 task authority yet; run the write work in the primary session"
                : `write-capable agent type "${params.subagent_type}" cannot run in the shared workspace of the V2 task authority; run the write work in the primary session`,
          }),
        )
      }

      // The single durable owner: the Core V2 TaskRunAuthority. The V2 services are resolved per
      // call: the tool registry builds before sibling layers are visible, so the composition is
      // read at execute time from the fully-built root context. The delegation-slot fallback
      // covers context-narrowed fibers (RI-24 pattern) — the app root fills it via
      // V2RunnerFrame.sessionRuntimeLayer.
      const events =
        Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service)) ??
        Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
      const v2Sessions =
        Option.getOrUndefined(yield* Effect.serviceOption(SessionV2.Service)) ??
        Option.getOrUndefined(yield* Effect.serviceOption(CoreTaskTool.DelegationSlot))?.service
      if (!events || !v2Sessions)
        return yield* Effect.fail(
          new Error(
            "task is unavailable: the V2 session runtime is missing from this composition " +
              `(events: ${events ? "ok" : "missing"}, sessions: ${v2Sessions ? "ok" : "missing"}); ` +
              "durable task execution requires the single V2 authority",
          ),
        )
      const parent = yield* v2Sessions.get(ctx.sessionID).pipe(
        Effect.mapError(
          () => new Error(`Parent session ${ctx.sessionID} is not visible to the V2 session store`),
        ),
      )

      // Resume target lookup through the SAME V2 store (SessionTable is shared: V1-era children
      // remain resolvable for their parent/agent identity).
      const session = params.task_id
        ? yield* v2Sessions.get(SessionSchema.ID.make(params.task_id)).pipe(
            Effect.option,
            Effect.map(Option.getOrUndefined),
          )
        : undefined

      const parentAgent = yield* agent
        .get(String(parent.agent ?? ctx.agent))
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))

      // Depth by parentID chain walk (V1 resolveSessionDepth parity, fail-closed): unknown
      // session, cycles, or an over-long chain all read as MAX so the next spawn refuses.
      const sessionDepth = (sessionID: SessionSchema.ID) =>
        Effect.gen(function* () {
          const current = yield* v2Sessions.get(sessionID).pipe(Effect.option)
          if (Option.isNone(current)) return MAX_SUBAGENT_DEPTH
          const visited = new Set<string>([sessionID])
          let cursor = current.value.parentID
          let chainDepth = 0
          const chainLimit = MAX_SUBAGENT_DEPTH + 4
          for (let i = 0; i < chainLimit && cursor !== undefined; i++) {
            if (visited.has(cursor)) return MAX_SUBAGENT_DEPTH
            visited.add(cursor)
            const hop = yield* v2Sessions.get(cursor).pipe(Effect.option)
            if (Option.isNone(hop)) break
            chainDepth++
            cursor = hop.value.parentID
          }
          if (cursor !== undefined) return MAX_SUBAGENT_DEPTH
          return chainDepth
        })

      if (session !== undefined) {
        // Resume validation: the target session must be a direct child of THIS session with the
        // expected agent type and a valid depth. Guards against cross-tree resume or injected IDs.
        if (String(session.parentID ?? "") !== String(ctx.sessionID)) {
          return yield* Effect.fail(
            new Error(
              `Cannot resume task "${params.task_id}": it is not a direct child of the current session. ` +
                `Use a task_id returned by a task you launched in this session.`,
            ),
          )
        }
        if (session.agent !== undefined && String(session.agent) !== params.subagent_type) {
          return yield* Effect.fail(
            new Error(
              `Cannot resume task "${params.task_id}": its agent type is "${session.agent}" ` +
                `but this call requests "${params.subagent_type}". Omit task_id to start a fresh subagent.`,
            ),
          )
        }
        const resumedDepth = yield* sessionDepth(session.id)
        if (resumedDepth > MAX_SUBAGENT_DEPTH) {
          return yield* Effect.fail(
            new Error(
              `Cannot resume task "${params.task_id}": resolved depth ${resumedDepth} exceeds ` +
                `the hard limit (MAX_SUBAGENT_DEPTH=${MAX_SUBAGENT_DEPTH}).`,
            ),
          )
        }
      } else if (params.task_id !== undefined) {
        return yield* Effect.fail(new Error(`Cannot resume task "${params.task_id}": unknown session.`))
      } else {
        // New session: full admission gate — depth ceiling then delegation permission. The parent
        // session's V2 denies forward as V1 deny rules so delegation can never widen permissions.
        const parentDenyRules = (parent.permissions ?? [])
          .filter((rule) => rule.effect === "deny")
          .map((rule) => ({ permission: rule.action, pattern: rule.resource, action: "deny" as const }))
        const admission = admitChildOrFail({
          callerDepth: yield* sessionDepth(ctx.sessionID),
          callerAgentPermission: parentAgent?.permission ?? [],
          callerSessionPermission: parentDenyRules,
          targetAgentType: params.subagent_type,
        })
        if ("error" in admission) {
          return yield* Effect.fail(new Error(admission.error))
        }
      }
      const childPermission = [
        ...deriveSubagentSessionPermission({
          parentSessionPermission: (parent.permissions ?? [])
            .filter((rule) => rule.effect === "deny")
            .map((rule) => ({ permission: rule.action, pattern: rule.resource, action: "deny" as const })),
          parentAgent,
          subagent: next,
        }),
        ...filterPrimaryToolsForSubagent(cfg.experimental?.primary_tools).map((item) => ({
          pattern: "*",
          action: "allow" as const,
          permission: item,
        })),
      ]


      // Runtime tool calls always carry callID. Direct programmatic callers (tests, embedded
      // integrations) predate that contract, so those invocations get a unique identity; exact-retry
      // semantics are available only when the caller supplies the stable callID.
      const toolCallID = ctx.callID ?? Identifier.ascending("tool")
      const model = next.model
      const deadline = Date.now() + (flags.subagentTimeoutMs ?? 30 * 60_000)
      let timedOut = false

      // Follow-up turns (resume-by-task_id, structured-output finalizer prompts) stay with the tool
      // layer: admit-only prompt + explicit awaited drain through the SAME V2 authority runtime.
      const drive = (childID: SessionID, text: string) =>
        Effect.gen(function* () {
          if (Date.now() >= deadline) {
            timedOut = true
            return `[task ended before completion: timed out — resume with task_id "${childID}" to continue.]`
          }
          // Admit-only, then an EXPLICIT awaited drain: an advisory wake (resume: true) races the
          // drain scheduler and can silently return an empty result.
          yield* v2Sessions
            .prompt({ sessionID: childID, prompt: new Prompt({ text }), resume: false })
            .pipe(Effect.orDie)
          const drain = yield* v2Sessions
            .resume(childID)
            .pipe(Effect.exit, Effect.timeoutOption(Math.max(1, deadline - Date.now())))
          const transcript = yield* v2Sessions.messages({ sessionID: childID, order: "asc" }).pipe(Effect.orDie)
          const research = v2LastAssistantText(transcript)
          if (Option.isNone(drain)) {
            timedOut = true
            yield* v2Sessions.interrupt(childID).pipe(Effect.ignore)
            return `${research}\n\n[task ended before completion: timed out — resume with task_id "${childID}" to continue.]`
          }
          if (Exit.isSuccess(drain.value)) return research
          const cause = Option.getOrUndefined(Cause.findErrorOption(drain.value.cause))
          return `${research}\n\n[task ended before completion: ${drainMessage(cause)} — resume with task_id "${childID}" to continue.]`
        }).pipe(
          // An interrupted parent turn must not leave the child draining unsupervised; an idle
          // child interrupt is a no-op per the V2 contract.
          Effect.onInterrupt(() => v2Sessions.interrupt(childID).pipe(Effect.ignore)),
        )

      const baseMetadata = {
        parentSessionId: ctx.sessionID,
        subagentType: params.subagent_type,
        model,
        ...(runInBackground ? { background: true } : {}),
      }
      const taskMetadata = (childID: SessionID) => ({ ...baseMetadata, sessionId: childID })

      // Structured contract (finalizer parity): the schema rides the prompt text — V2 has no
      // provider-side format — with one bounded correction attempt through the same V2 drive path.
      const finalizeStructured = (childID: SessionID, research: string, outputSchema: Record<string, unknown>) =>
        Effect.gen(function* () {
          // Once the shared deadline wins, never enqueue doomed finalizer prompts into the child.
          if (timedOut)
            return yield* Effect.fail(
              new Error(
                `Subagent timed out before it could satisfy the output schema. Task id ${childID} holds the partial turns.`,
              ),
            )
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
            if (!error)
              return {
                title: params.description,
                metadata: taskMetadata(childID),
                output: renderOutput({
                  sessionID: childID,
                  state: "completed",
                  summary: params.description,
                  text: JSON.stringify(candidate),
                  maxChars: flags.subagentOutputMaxChars,
                }),
              }
            correction = error.slice(0, 1_000)
          }
          return yield* Effect.fail(
            new Error(
              `Subagent completed but its final answer never validated against the output schema${correction ? `: ${correction}` : ""}. Task id ${childID} holds the raw turns.`,
            ),
          )
        })

      // Resume contract: continue an existing child with one more admitted turn. No new durable
      // run — the first input of the original launch stays the single durable admission.
      if (session !== undefined) {
        const childID = session.id
        yield* ctx.metadata({ title: params.description, metadata: taskMetadata(childID) })
        const text = yield* drive(childID, params.prompt)
        if (!resolvedOutputSchema) {
          if (timedOut)
            return yield* Effect.fail(
              taskError({
                code: "attempt_timeout",
                message: `The subagent continuation timed out after ${flags.subagentTimeoutMs ?? 30 * 60_000}ms. Automatic retry is disabled.`,
                sessionID: childID,
                phase: "research",
              }),
            )
          return {
            title: params.description,
            metadata: taskMetadata(childID),
            output: renderOutput({
              sessionID: childID,
              state: "completed",
              summary: "Task continuation",
              text,
              maxChars: flags.subagentOutputMaxChars,
            }),
          }
        }
        return yield* finalizeStructured(childID, text, resolvedOutputSchema)
      }

      // Fresh launch: ONE durable TaskRunAuthority submission. The ledger transaction (task_run +
      // task_admission + task_run_event) precedes every external side effect, the child session
      // identity is deterministic, and the single first input lands atomically with the run's
      // input_state pending→ready CAS.
      // The app V1 MessageID and the core SessionMessage.ID are both `msg_`-prefixed strings
      // (app Identifier.create writes `msg_<hex>`), so the wire conversion is a checked make.
      const submission = yield* TaskRunAuthority.submit(database.db, events, v2Sessions, {
        parentSessionID: ctx.sessionID,
        parentMessageID: SessionMessage.ID.make(String(ctx.messageID)),
        toolCallID,
        deliveryMode: runInBackground ? "background" : "foreground",
        prompt: new Prompt({ text: params.prompt }),
        agent: next.name,
        ...(resolvedOutputSchema === undefined ? {} : { outputSchema: resolvedOutputSchema }),
        child: {
          title: `task: ${params.description}`,
          location: parent.location,
          permissions: SessionV2.permissionsFromLegacy(childPermission),
        },
      }).pipe(
        Effect.mapError(
          (error) =>
            new Error(
              error._tag === "TaskRunAuthority.AdmissionConflict"
                ? "Cannot launch task: this tool call was already admitted with a different request."
                : `Cannot launch task: ${error._tag}`,
            ),
        ),
      )
      const childID = submission.run.childSessionID
      taskLog.info("task.admitted", {
        run_id: submission.run.runID,
        child_session_id: childID,
        delivery_mode: submission.run.deliveryMode,
        exact_retry: submission.exactRetry,
      })

      // Exact retry of an already-settled run replays the durable outcome; no second execution.
      const replayStates = ["completed", "failed", "interrupted", "cancelled", "closed", "recovery_required", "error"]
      if (submission.exactRetry && replayStates.includes(submission.run.state)) {
        if (submission.run.state === "completed")
          return {
            title: params.description,
            metadata: taskMetadata(childID),
            output: renderOutput({
              sessionID: childID,
              state: "completed",
              summary: "Task result replayed from durable settlement",
              text: submission.run.output ?? "",
              maxChars: flags.subagentOutputMaxChars,
            }),
          }
        return yield* Effect.fail(
          new Error(
            `Task ${childID} previously settled as ${submission.run.state} (${submission.run.reason ?? "unknown"}). ` +
              `Call task_read({ task_id: "${childID}" }) to inspect partial work.`,
          ),
        )
      }

      if (runInBackground) {
        // Background durable: the process-global TaskRunDispatcher claims and drains the run; the
        // settle transaction enqueues the outbox notification that wakes the parent.
        yield* ctx.metadata({
          title: params.description,
          metadata: { ...taskMetadata(childID), background: true, jobId: childID },
        })
        return {
          title: params.description,
          metadata: { ...taskMetadata(childID), background: true, jobId: childID },
          output: renderOutput({
            sessionID: childID,
            state: "running",
            summary: `Background task enqueued: ${params.description}`,
            text: BACKGROUND_DISPATCHED,
            maxChars: flags.subagentOutputMaxChars,
          }),
        }
      }

      yield* ctx.metadata({ title: params.description, metadata: taskMetadata(childID) })

      // Foreground durable: claim → resume-join → settle, inside the parent-session concurrency
      // slot (the §5a chokepoint — bounds parallel subagents per parent session).
      const result = yield* TaskConcurrency.withTaskSlot({
        parentSessionID: ctx.sessionID,
        subagentType: params.subagent_type,
        agentMaxConcurrency: next.limits?.maxConcurrency,
        caps: {
          maxFanout: cfg.experimental?.orchestration?.max_fanout,
          maxConcurrency: cfg.experimental?.orchestration?.max_concurrency,
        },
        effect: TaskRunAuthority.execute({
          db: database.db,
          run: submission.run,
          sessions: v2Sessions,
          timeoutMs: Math.max(1, deadline - Date.now()),
        }),
      }).pipe(
        Effect.mapError(() =>
          taskError({
            code: "execution_lease_lost",
            message: `Task run ${submission.run.runID} lost its durable execution lease to a competing owner.`,
            sessionID: childID,
            phase: "research",
          }),
        ),
      )
      if (result.outcome === "timeout") timedOut = true
      if (result.outcome !== "completed") {
        return yield* Effect.fail(
          taskError({
            code: result.outcome === "timeout" ? "attempt_timeout" : "runtime_error",
            message:
              result.outcome === "timeout"
                ? "The subagent attempt timed out. Automatic retry is disabled."
                : `The subagent failed and was not automatically retried: ${"failureMessage" in result ? result.failureMessage : "unknown failure"}`,
            sessionID: childID,
            phase: "research",
          }),
        )
      }
      if (!resolvedOutputSchema) {
        return {
          title: params.description,
          metadata: taskMetadata(childID),
          output: renderOutput({
            sessionID: childID,
            state: "completed",
            summary: params.description,
            text: result.research,
            maxChars: flags.subagentOutputMaxChars,
          }),
        }
      }
      return yield* finalizeStructured(childID, result.research, resolvedOutputSchema)
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
