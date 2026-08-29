/**
 * FEAT-011 T4 — the four model-facing activity facade tools:
 *   activity_start / activity_status / activity_result / activity_control
 *
 * T6 (有界结果面) is enforced here and in the dispatcher: status lists are capped at 20 entries,
 * result projections carry only the TERMINAL view (terminalState/reason/bounded summary/structured
 * receipt/verdict), and every free-text field passes applyResultBound + the registry's Truncate
 * wrapper. Non-terminal result queries return the live state hint instead of partial transcripts.
 *
 * Permission governance: activity_start and activity_control are MUTATING — they ask under the
 * "task" permission name (already in core MUTATING_PERMISSIONS). activity_status/activity_result
 * are read-only and never ask. Visibility: gated by DEEPAGENT_CODE_ACTIVITY_FACADE (staged off)
 * and primary-agent-only in the registry projection (mirrors pr_finalize).
 */
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { FacadeActivity } from "@/session/facade-activity"

const FacadeSubkind = Schema.Literals(["task", "goal", "panel"])

const FacadeBudgetSchema = Schema.Struct({
  maxTicks: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Max goal-loop ticks (clamped to the host policy ceiling).",
  }),
  maxTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Max tokens across the activity (clamped to the host policy ceiling).",
  }),
  maxWallclockMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Max wall-clock milliseconds (clamped to the host policy ceiling).",
  }),
})

// ── activity_start ────────────────────────────────────────────────────────────────────────────

const StartParameters = Schema.Struct({
  subkind: FacadeSubkind.annotate({
    description: "Which runner backs this activity: task (durable subagent queue), goal (long-run goal loop), panel (expert panel consult).",
  }),
  objective: Schema.String.annotate({
    description:
      "The frozen objective: task description, goal objective, or the panel question. Bounded; keep it self-contained.",
  }),
  budget: Schema.optional(FacadeBudgetSchema).annotate({
    description: "Optional model-requested limits; the host clamps them with min against policy ceilings.",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "task only: the full task prompt (defaults to the objective).",
  }),
  subagent_type: Schema.optional(Schema.String).annotate({
    description: "task only: the subagent type to dispatch (defaults to explore).",
  }),
})

export const ActivityStartTool = Tool.define(
  "activity_start",
  Effect.gen(function* () {
    const facade = yield* FacadeActivity.Service

    const run = Effect.fn("ActivityStartTool.execute")(function* (
      params: Schema.Schema.Type<typeof StartParameters>,
      ctx: Tool.Context,
    ) {
      // MUTATING: governed under the "task" permission (in core MUTATING_PERMISSIONS).
      yield* ctx.ask({
        permission: "task",
        patterns: [params.subkind],
        always: ["*"],
        metadata: { subkind: params.subkind, objective: params.objective.slice(0, 200) },
      })
      const started = yield* facade
        .start({
          sessionID: ctx.sessionID,
          subkind: params.subkind,
          objective: params.objective,
          spawnToolCallID: ctx.callID,
          parentMessageID: ctx.messageID,
          budget: params.budget,
          ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
          ...(params.subagent_type !== undefined ? { subagentType: params.subagent_type } : {}),
        })
        .pipe(Effect.mapError((error) => new Error(`${error._tag}: ${("reason" in error && error.reason) || "start failed"}`)))
      const refs = Object.entries(started.ref)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
      return {
        title: `Activity start (${params.subkind})`,
        metadata: { activityID: started.activityID, subkind: started.subkind },
        output:
          `Activity ${started.activityID} admitted (subkind=${started.subkind}, state=active). ${refs}\n` +
          `Budget applied: maxTicks=${started.budget.maxTicks}, maxTokens=${started.budget.maxTokens}, ` +
          `maxWallclockMs=${started.budget.maxWallclockMs}. Admission does not mean the child provider has started. ` +
          `Use activity_status to monitor and activity_result for the bounded terminal result.`,
      }
    })

    return {
      description:
        "Start one supervised background activity (task / goal / panel) through the unified activity facade. " +
        "Only ONE active activity per subkind is allowed per session (fail-closed). Budgets are clamped by host policy. " +
        "Returns an admission receipt; lifecycle stays with the underlying runner.",
      parameters: StartParameters,
      execute: (params: Schema.Schema.Type<typeof StartParameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

// ── activity_status ───────────────────────────────────────────────────────────────────────────

const StatusParameters = Schema.Struct({
  subkind: Schema.optional(FacadeSubkind).annotate({
    description: "Filter to one subkind; omit to list all facade activities for this session.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(20))).annotate({
    description: "Max entries to return (hard ceiling 20, newest first).",
  }),
})

export const ActivityStatusTool = Tool.define(
  "activity_status",
  Effect.gen(function* () {
    const facade = yield* FacadeActivity.Service

    const run = Effect.fn("ActivityStatusTool.execute")(function* (
      params: Schema.Schema.Type<typeof StatusParameters>,
      ctx: Tool.Context,
    ) {
      // READ-ONLY: no permission ask.
      const entries = yield* facade.status({
        sessionID: ctx.sessionID,
        ...(params.subkind !== undefined ? { subkind: params.subkind } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      })
      if (!entries.length) {
        return {
          title: "Activity status",
          metadata: { count: 0 },
          output: "No facade activities recorded for this session.",
        }
      }
      const lines = entries.map((entry) => {
        const refs = Object.entries(entry.ref)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ")
        return (
          `- ${entry.activityID} [${entry.subkind}] state=${entry.state}` +
          (entry.reason ? ` reason=${entry.reason}` : "") +
          (entry.objective ? ` objective="${entry.objective}"` : "") +
          (refs ? ` (${refs})` : "")
        )
      })
      return {
        title: "Activity status",
        metadata: { count: entries.length },
        output: `${entries.length} facade activit${entries.length === 1 ? "y" : "ies"} (newest first):\n${lines.join("\n")}`,
      }
    })

    return {
      description:
        "List bounded status for this session's facade activities (task/goal/panel). Returns refs/state/reason only — " +
        "never full child transcripts. A recovery_required state is not auto-retryable.",
      parameters: StatusParameters,
      execute: (params: Schema.Schema.Type<typeof StatusParameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

// ── activity_result (T6 bounded result surface) ───────────────────────────────────────────────

const ResultParameters = Schema.Struct({
  subkind: FacadeSubkind.annotate({
    description: "Which subkind's most recent facade activity to fetch the result for.",
  }),
})

export const ActivityResultTool = Tool.define(
  "activity_result",
  Effect.gen(function* () {
    const facade = yield* FacadeActivity.Service

    const run = Effect.fn("ActivityResultTool.execute")(function* (
      params: Schema.Schema.Type<typeof ResultParameters>,
      ctx: Tool.Context,
    ) {
      // READ-ONLY: no permission ask.
      const projection = yield* facade
        .result({ sessionID: ctx.sessionID, subkind: params.subkind })
        .pipe(
          Effect.mapError(
            (error) => new Error(`${error._tag}: no ${params.subkind} facade activity recorded for this session`),
          ),
        )
      if (!projection.terminal) {
        return {
          title: `Activity result (${params.subkind})`,
          metadata: { activityID: projection.activityID, terminal: false, truncated: false },
          output:
            `Activity ${projection.activityID} is still ${projection.state}. ` +
            `Results are only projected once the activity reaches a terminal state. Use activity_status to monitor.`,
        }
      }
      const lines: string[] = [
        `Activity ${projection.activityID} (${projection.subkind}) terminal: state=${projection.state}` +
          (projection.reason ? ` reason=${projection.reason}` : ""),
      ]
      if (projection.summary) lines.push(`Objective: ${projection.summary}`)
      if (projection.receipt) lines.push(`Receipt: ${JSON.stringify(projection.receipt)}`)
      if (projection.verdict !== undefined) lines.push(`Verdict: ${JSON.stringify(projection.verdict)}`)
      if (projection.phase !== undefined) lines.push(`Goal phase: ${projection.phase}`)
      if (projection.truncated)
        lines.push("(result bounded by host output cap; consult the child session for the full transcript)")
      return {
        title: `Activity result (${params.subkind})`,
        metadata: { activityID: projection.activityID, terminal: true, truncated: projection.truncated },
        output: lines.join("\n"),
      }
    })

    return {
      description:
        "Fetch the BOUNDED terminal result of this session's most recent facade activity of the given subkind. " +
        "Returns only the terminal projection (state/reason/bounded summary/structured receipt or verdict) — " +
        "never the full child transcript. Non-terminal activities return a state hint.",
      parameters: ResultParameters,
      execute: (params: Schema.Schema.Type<typeof ResultParameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

// ── activity_control ──────────────────────────────────────────────────────────────────────────

const ControlParameters = Schema.Struct({
  subkind: FacadeSubkind.annotate({ description: "Which subkind's most recent facade activity to control." }),
  action: Schema.Literals(["pause", "resume", "stop", "steer"]).annotate({
    description:
      "Control action. goal supports pause/resume/stop/steer; task and panel support only stop (pause/resume are not fabricated).",
  }),
  message: Schema.optional(Schema.String).annotate({
    description: "steer only: guidance text delivered to the goal via the goal_steer channel.",
  }),
  reason: Schema.optional(Schema.String).annotate({ description: "Optional reason recorded in the audit trail." }),
})

export const ActivityControlTool = Tool.define(
  "activity_control",
  Effect.gen(function* () {
    const facade = yield* FacadeActivity.Service

    const run = Effect.fn("ActivityControlTool.execute")(function* (
      params: Schema.Schema.Type<typeof ControlParameters>,
      ctx: Tool.Context,
    ) {
      // MUTATING: governed under the "task" permission (in core MUTATING_PERMISSIONS).
      yield* ctx.ask({
        permission: "task",
        patterns: [`${params.subkind}:${params.action}`],
        always: ["*"],
        metadata: { subkind: params.subkind, action: params.action },
      })
      const outcome = yield* facade
        .control({
          sessionID: ctx.sessionID,
          subkind: params.subkind,
          action: params.action,
          ...(params.message !== undefined ? { message: params.message } : {}),
          ...(params.reason !== undefined ? { reason: params.reason } : {}),
        })
        .pipe(Effect.mapError((error) => new Error(`${error._tag}: ${("reason" in error && error.reason) || "control failed"}`)))
      return {
        title: `Activity control (${params.subkind}/${params.action})`,
        metadata: { subkind: params.subkind, action: params.action, applied: outcome.applied },
        output: `${outcome.detail} (applied=${outcome.applied})`,
      }
    })

    return {
      description:
        "Control this session's most recent facade activity of the given subkind. Delegates to each runner's existing " +
        "control surface: goal pause/resume/stop/steer, task stop (durable close), panel stop. Unsupported combinations fail closed.",
      parameters: ControlParameters,
      execute: (params: Schema.Schema.Type<typeof ControlParameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

/** Tool ids registered under the activity facade gate (used by the registry's primary-only filter). */
export const ACTIVITY_FACADE_TOOL_IDS: ReadonlySet<string> = new Set([
  ActivityStartTool.id,
  ActivityStatusTool.id,
  ActivityResultTool.id,
  ActivityControlTool.id,
])
