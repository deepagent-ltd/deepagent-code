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
import { deriveSubagentSessionPermission, filterPrimaryToolsForSubagent, subagentIsWriteType } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@deepagent-code/core/database/database"
import { Worktree } from "@/worktree"
import { Git } from "@/git"
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

interface AttemptBundle {
  readonly worktreeInfo: Worktree.Info | undefined
  readonly worktree: Worktree.Interface | undefined
  readonly nextSession: Session.Info
  readonly metadata: AttemptMetadata
  readonly markFinished: (state: "completed" | "error" | "cancelled" | "interrupted", reason?: "human" | "parent_interrupted" | "timeout" | "takeover" | "runtime_error") => Effect.Effect<void, unknown>
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
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined

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

        // A fresh attempt gets its own worktree (same fork base as the discarded one) and a brand-new
        // child session; the resumed session (task_id) is only reused by the FIRST attempt.
        const spawnAttempt = Effect.fn("TaskTool.spawnAttempt")(function* (first: boolean) {
          const resumed = first ? session : undefined
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
          a: { worktree: Worktree.Interface | undefined; worktreeInfo: Worktree.Info | undefined; nextSession: Session.Info },
          takeovers: number,
          allowExtend: boolean,
        ) {
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
            const parts = yield* ops.resolvePromptParts(params.prompt)
            const promptParts = a.worktreeInfo
              ? [
                  {
                    type: "text" as const,
                    text:
                      `You are running in an ISOLATED git worktree at ${a.worktreeInfo.directory} (branch ${a.worktreeInfo.branch ?? "detached"}). ` +
                      `You inherited context from the parent session, but your working directory is this worktree. ` +
                      `Re-read files before editing (do not trust remembered paths/contents), and know your changes stay isolated until merged back.`,
                  },
                  ...parts,
                ]
              : parts
            const result = yield* ops.prompt({
              messageID: MessageID.ascending(),
              sessionID: a.nextSession.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              variant: next.model ? undefined : variant,
              agent: next.name,
              ...(childAgentModeOverride
                ? { metadata: { deepagent: { agent_mode_override: childAgentModeOverride } } }
                : {}),
              ...(resolvedOutputSchema
                ? {
                    format: new SessionV1.OutputFormatJsonSchema({
                      type: "json_schema",
                      schema: resolvedOutputSchema,
                    }),
                  }
                : {}),
              tools: {
                ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
                // task_status inspects the PARENT session's dispatched-subagent list, so it is a
                // task-management capability: gate it on the same `task` permission. A subagent that
                // cannot dispatch tasks has no sibling list to inspect, and (like `task`) must not be
                // able to reach into task orchestration unless explicitly granted.
                ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false, task_status: false }),
                ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
              },
              parts: promptParts,
            })
            if (resolvedOutputSchema) {
              const structured = result.info.role === "assistant" ? result.info.structured : undefined
              if (structured !== undefined) return JSON.stringify(structured)
            }
            return result.parts.findLast((item) => item.type === "text")?.text ?? ""
          })

          const runTask = Effect.fn("TaskTool.runTask")(function* () {
            return yield* TaskConcurrency.withTaskSlot({
              parentSessionID: ctx.sessionID,
              subagentType: params.subagent_type,
              agentMaxConcurrency,
              caps,
              effect: runTaskInner(),
            })
          })

          const markFinished = Effect.fn("TaskTool.markSubagentFinished")(function* (
            state: "completed" | "error" | "cancelled" | "interrupted",
            reason?: "human" | "parent_interrupted" | "timeout" | "takeover" | "runtime_error",
          ) {
            const current = yield* sessions.get(a.nextSession.id).pipe(Effect.orDie)
            yield* sessions
              .setMetadata({
                sessionID: a.nextSession.id,
                metadata: {
                  ...(current.metadata ?? {}),
                  deepagent: {
                    ...((current.metadata?.["deepagent"] as Record<string, unknown> | undefined) ?? {}),
                    // §4.3 SubagentRunMetadata: state is the durable authority for terminal state.
                    // Compat: old data using `finished: true` with state is still readable unchanged.
                    subagent: { finished: true, state, at: Date.now(), ...(reason ? { reason } : {}) },
                  },
                },
              })
              .pipe(Effect.ignore)
          })

          const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
            state: "completed" | "error",
            text: string,
            doneTakeovers: number,
          ) {
            const currentParent = yield* sessions.get(ctx.sessionID)
            const suffix =
              doneTakeovers > 0 ? ` (after ${doneTakeovers} takeover${doneTakeovers === 1 ? "" : "s"})` : ""
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
                      sessionID: a.nextSession.id,
                      state,
                      summary:
                        state === "completed"
                          ? `Background task completed: ${params.description}${suffix}`
                          : `Background task failed: ${params.description}${suffix}`,
                      text,
                      maxChars: flags.subagentOutputMaxChars,
                    }),
                  },
                ],
              })
              .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
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
            yield* (force
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
                : result.diagnostic ?? result.type
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
            onPromote: Effect.all([
              ctx.metadata({
                title: params.description,
                metadata: { ...metadata, background: true, jobId: a.nextSession.id },
              }),
              driveBackground(bundle, takeovers),
            ]),
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
                    yield* b.markFinished("error")
                    yield* b.inject("error", `Worktree merge-back failed: ${String(diagnostic)}`, takeovers)
                    yield* b.teardownWorktree(false)
                    return false
                  }),
                ),
              )
              if (!merged && b.automaticWriteIsolation) return yield* Effect.fail(new Error("Worktree merge-back failed"))
              yield* b.markFinished("completed")
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
              yield* b.markFinished("error")
              yield* b.teardownWorktree(false)
              return {
                title: params.description,
                metadata: b.metadata,
                output: renderOutput({
                  sessionID: b.nextSession.id,
                  state: "error",
                  summary: `Background task failed: ${params.description} (after ${takeovers} takeover${takeovers === 1 ? "" : "s"})`,
                  text: `The subagent was retried ${takeovers} time(s) after timeout/crash and still did not complete. Last failure: ${outcome.reason}. The half-finished attempt was cancelled and its worktree discarded.`,
                  maxChars: flags.subagentOutputMaxChars,
                }),
              }
            }
            yield* background.cancel(b.nextSession.id).pipe(Effect.ignore)
            yield* b.markFinished("cancelled")
            yield* b.teardownWorktree(true)
            const next = yield* startAttempt(yield* spawnAttempt(false), takeovers + 1, false)
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
                    yield* b.markFinished("error")
                    yield* b.inject("error", `Worktree merge-back failed: ${String(diagnostic)}`, takeovers)
                    yield* b.teardownWorktree(false)
                    return false
                  }),
                ),
              )
              if (!merged && b.automaticWriteIsolation) return
              yield* b.markFinished("completed")
              yield* b.teardownWorktree(merged)
              yield* b.inject("completed", waited.info?.output ?? "", takeovers)
              return
            }
            if (!waited.timedOut && status === "cancelled") {
              yield* b.markFinished("cancelled")
              yield* b.teardownWorktree(false)
              return
            }
            if (takeovers >= takeoverLimit) {
              yield* background.cancel(b.nextSession.id).pipe(Effect.ignore)
              yield* b.markFinished("error")
              yield* b.teardownWorktree(false)
              const reason = waited.timedOut
                ? `timed out after ${timeoutMs}ms`
                : (waited.info?.error ?? "Task failed")
              yield* b.inject(
                "error",
                `The subagent was retried ${takeovers} time(s) after timeout/crash and still did not complete. Last failure: ${reason}. The half-finished attempt was cancelled and its worktree discarded.`,
                takeovers,
              )
              return
            }
            yield* background.cancel(b.nextSession.id).pipe(Effect.ignore)
            yield* b.markFinished("cancelled")
            yield* b.teardownWorktree(true)
            const next = yield* startAttempt(yield* spawnAttempt(false), takeovers + 1, false)
            if (next.kind === "extended")
              return yield* Effect.die(new Error("unreachable: extend on a fresh takeover attempt"))
            yield* driveBackground(next.bundle, takeovers + 1)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

        const started = yield* startAttempt(yield* spawnAttempt(true), 0, true)
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
      const isolate = !session && (params.isolation === "worktree" || subagentIsWriteType(next))
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
        // 1c: see the takeover-path metadata above — task_status reads subagentType to name the
        // running subagent instead of the generic BackgroundJob type ("task").
        subagentType: params.subagent_type,
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
            // task_status is gated on the same `task` permission (see the takeover-path block above).
            ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false, task_status: false }),
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
          // B3 fix: when the retry cap fired, the assistant message carries a StructuredOutputError.
          // Silently returning "" here would make the parent agent see an empty success result and
          // lose all signal that the subagent failed to produce structured output. Surface the error
          // explicitly so the task tool's error path propagates it correctly to the parent.
          const msgError = result.info.role === "assistant" ? result.info.error : undefined
          if (msgError && SessionV1.StructuredOutputError.isInstance(msgError)) {
            return yield* Effect.fail(
              new Error(
                // U1: include the child session ID so the parent agent can recover partial work via
                // task_read({ task_id: nextSession.id }) before retrying or duplicating the task.
                `StructuredOutput failed (${msgError.data.retries} attempt(s)): ${msgError.data.message}. ` +
                  `Partial research is preserved in subagent session ${nextSession.id}. ` +
                  `Call task_read({ task_id: "${nextSession.id}" }) to recover completed work before retrying.`,
              ),
            )
          }
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
                  maxChars: flags.subagentOutputMaxChars,
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
        state: "completed" | "error" | "cancelled" | "interrupted",
        reason?: "human" | "parent_interrupted" | "timeout" | "takeover" | "runtime_error",
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
                // §4.3: state is the durable terminal-state authority; reason narrows the cause.
                subagent: { finished: true, state, at: Date.now(), ...(reason ? { reason } : {}) },
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
            maxChars: flags.subagentOutputMaxChars,
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
              yield* markFinished("error")
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
            yield* markFinished("completed")
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
