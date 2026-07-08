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
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@deepagent-code/core/database/database"
import { Worktree } from "@/worktree"
import { Orchestration } from "../agent/schema/orchestration"
import { Orchestration as CoreOrchestration } from "@deepagent-code/core/deepagent/orchestration"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { downgradeOneLevel } from "@deepagent-code/core/deepagent/mode"
import { TaskConcurrency } from "./task-concurrency"

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

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
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
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
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
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined

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
      const isolate = params.isolation === "worktree" && !session
      const worktreeOpt = isolate ? yield* Effect.serviceOption(Worktree.Service) : Option.none<Worktree.Interface>()
      const worktreeInfo =
        isolate && Option.isSome(worktreeOpt)
          ? yield* worktreeOpt.value
              .create({ name: `agent-${params.subagent_type}-${Identifier.ascending("tool")}` })
              .pipe(Effect.catchTag("WorktreeNotGitError", () => Effect.succeed(undefined)))
          : undefined

      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          ...(worktreeInfo ? { directory: worktreeInfo.directory } : {}),
          permission: [
            ...deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              parentAgent,
              subagent: next,
            }),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

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
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      // Subagent work-intensity: "downgrade" runs each child exactly one strength below the parent's
      // EFFECTIVE agentMode (ultra→max→…→general; general stays general); "inherit" (default) leaves
      // the child on the process-global mode. The chosen mode is injected ONLY as this child session's
      // first user-message metadata (`deepagent.agent_mode_override`) — a per-request channel that
      // request.ts reads per prompt and never touches the process-global agentMode, so concurrent
      // subagents stay isolated from each other. "inherit" injects nothing (natural global inheritance).
      const subagentIntensity =
        (cfg.provider?.deepagent?.options?.subagentIntensity as string | undefined) === "downgrade"
          ? "downgrade"
          : "inherit"
      const childAgentModeOverride =
        subagentIntensity === "downgrade" ? downgradeOneLevel(AgentGateway.snapshot().agentMode) : undefined

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      // L3 (路 B): when the caller supplied output_schema, drive the subagent's final turn through
      // the structured-output path so the result parses deterministically. Undefined ⇒ free-text.
      const resolvedOutputSchema = resolveOutputSchema(params.output_schema, params.subagent_type)

      // §5a: resolve the CODE-layer orchestration caps (configurable, lenient defaults). The
      // per-parent-session semaphore below is the hard concurrency gate for parallel `task` calls;
      // §C.3 agent `limits.maxConcurrency` tightens it further (min) when the subagent declares one.
      const caps: CoreOrchestration.OrchestrationCaps = {
        maxFanout: cfg.experimental?.orchestration?.max_fanout,
        maxConcurrency: cfg.experimental?.orchestration?.max_concurrency,
      }
      const agentMaxConcurrency = next.limits?.maxConcurrency

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        // §5a chokepoint: BOTH the foreground and background dispatch paths route the subagent's
        // actual work through `runTask`, so acquiring the concurrency slot HERE bounds how many
        // subagents of this parent session execute in parallel — regardless of how many the model
        // fanned out in one message. Ordinary tools never reach this code path.
        return yield* TaskConcurrency.withTaskSlot({
          parentSessionID: ctx.sessionID,
          subagentType: params.subagent_type,
          agentMaxConcurrency,
          caps,
          effect: runTaskInner(),
        })
      })

      const runTaskInner = Effect.fn("TaskTool.runTaskInner")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        // U5: when isolated in a worktree, tell the subagent it inherited the parent's context but
        // operates in a separate checkout — paths translate, and it must re-read files before editing.
        const promptParts = worktreeInfo
          ? [
              {
                type: "text" as const,
                text:
                  `You are running in an ISOLATED git worktree at ${worktreeInfo.directory} (branch ${worktreeInfo.branch ?? "detached"}). ` +
                  `You inherited context from the parent session, but your working directory is this worktree. ` +
                  `Re-read files before editing (do not trust remembered paths/contents), and know your changes stay isolated until merged back.`,
              },
              ...parts,
            ]
          : parts
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          ...(childAgentModeOverride
            ? { metadata: { deepagent: { agent_mode_override: childAgentModeOverride } } }
            : {}),
          // Build a Format INSTANCE (not a plain literal): OutputFormatJsonSchema is a Schema.Class
          // whose encoder is instanceof-gated, so a plain object would fail when the message Info is
          // serialized onto the MessageUpdated sync event. prompt() also normalizes defensively.
          ...(resolvedOutputSchema
            ? { format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: resolvedOutputSchema }) }
            : {}),
          tools: {
            ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
            ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
          parts: promptParts,
        })
        // L3 (路 B): with output_schema, the structured object is surfaced on the assistant message's
        // `structured` field (via the forced StructuredOutput tool). Return it as JSON so the parent
        // agent parses a guaranteed-conformant result. Fall back to the free-text extraction only when
        // no schema was requested — that path (the brittle `findLast(text)`) is UNCHANGED for callers
        // that don't pass output_schema.
        if (resolvedOutputSchema) {
          const structured = result.info.role === "assistant" ? result.info.structured : undefined
          if (structured !== undefined) return JSON.stringify(structured)
        }
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
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
        state: "completed" | "error" | "cancelled",
      ) {
        // Resume (`params.task_id`) reuses an existing session; a fresh finish marker is still correct
        // (the reused session just completed another turn), so no special-casing is needed.
        const current = yield* sessions.get(nextSession.id).pipe(Effect.orDie)
        yield* sessions
          .setMetadata({
            sessionID: nextSession.id,
            metadata: {
              ...(current.metadata ?? {}),
              deepagent: {
                ...((current.metadata?.["deepagent"] as Record<string, unknown> | undefined) ?? {}),
                subagent: { finished: true, state, at: Date.now() },
              },
            },
          })
          .pipe(Effect.ignore)
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed")
              return markFinished("completed").pipe(Effect.andThen(inject("completed", result.info.output ?? "")))
            if (result.info?.status === "error")
              return markFinished("error").pipe(Effect.andThen(inject("error", result.info.error ?? "")))
            if (result.info?.status === "cancelled") return markFinished("cancelled")
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
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
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
              yield* markFinished("error")
              return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            }
            if (result?.status === "cancelled") {
              yield* markFinished("cancelled")
              return yield* Effect.fail(new Error("Task cancelled"))
            }
            yield* markFinished("completed")
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
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
