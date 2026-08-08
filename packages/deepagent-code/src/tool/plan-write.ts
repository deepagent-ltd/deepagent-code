import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./plan-write.txt"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "../session/schema"
import { NonNegativeInt } from "@deepagent-code/core/schema"

// U2: the live plan event. Published after each authority version change so the app can render a
// persistent plan panel (goal + steps + progress). Mirrors todo.updated in the same SSE stream.
const PlanStepEvent = Schema.Struct({
  step_id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  acceptance: Schema.optional(Schema.NullOr(Schema.String)),
  assigned_agent: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
  evidence: Schema.optional(Schema.Array(Schema.String)),
})
export const PlanEvent = {
  Updated: EventV2.define({
    type: "plan.updated",
    schema: {
      sessionID: SessionID,
      plan_id: Schema.String,
      goal: Schema.String,
      plan_version: Schema.Number,
      assumptions: Schema.Array(Schema.String),
      active_step_id: Schema.NullOr(Schema.String),
      steps: Schema.Array(PlanStepEvent),
      done: Schema.Number,
      total: Schema.Number,
      // U10: runtime-computed status transitions this write produced ("Title: from→to"). Lets the UI
      // and logs show WHAT changed, derived from before/after — not from the model's prose.
      changes: Schema.optional(Schema.Array(Schema.String)),
    },
  }),
}

// U1 PlanController write tool. The model calls this to create/update its working plan. Committing a
// semantic change clears a stale latch, which unblocks the soft gate after the runtime flagged the
// plan as out of date; a no-op acknowledgement deliberately leaves the latch unchanged.

const PlanStep = Schema.Struct({
  step_id: Schema.optional(Schema.String).annotate({
    description: "Stable id; required for advance, omit only when create/replan should allocate a new identity",
  }),
  title: Schema.String.annotate({ description: "What this step does" }),
  status: Schema.String.annotate({ description: "pending | active | done | cancelled | blocked" }),
  // No NullOr: a nested optional(NullOr(...)) emits a double-nested anyOf whose inner
  // {type:null} survives normalize() and is rejected by some third-party providers (no-reply).
  // Optional already covers "absent"; strict admission normalizes missing values to null.
  acceptance: Schema.optional(Schema.String).annotate({ description: "How you know this step is done" }),
  assigned_agent: Schema.optional(Schema.String).annotate({ description: "Subagent type to delegate to" }),
  note: Schema.optional(Schema.String).annotate({
    description: "Short note; REQUIRED when status is 'blocked' — say why you are stuck",
  }),
})

export const Parameters = Schema.Struct({
  operation: Schema.Literals(["create", "advance", "replan"]).annotate({
    description: "create a plan, advance an existing plan, or replan with a reason",
  }),
  expected_plan_id: Schema.NullOr(Schema.String),
  expected_version: Schema.NullOr(NonNegativeInt),
  replan_reason: Schema.optional(Schema.String),
  goal: Schema.String.annotate({ description: "One sentence: what 'done' means for this task" }),
  steps: Schema.mutable(Schema.Array(PlanStep)).annotate({ description: "Ordered plan steps" }),
  assumptions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Facts the plan relies on",
  }),
  active_step_id: Schema.NullOr(Schema.String).annotate({ description: "The step currently being worked on" }),
})
export const PlanWriteParameters = Parameters

type Metadata = {
  plan_id: string
  goal: string
  done: number
  total: number
  plan_protocol?: "success" | "invalid" | "conflict" | "no_progress"
  plan_progress?: boolean
  plan_version?: number
  plan_attempt_ordinal?: number
  plan_error_code?: string
  challenge_id?: string
}

export const PlanTool = Tool.define<typeof Parameters, Metadata, EventV2Bridge.Service>(
  "plan",
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // ToolSequenceTracker must compare the plan's semantic proposal rather than display text or
      // object key order. The version/precondition remains part of the fingerprint so repeated stale
      // retries are visible, while runtime evidence is intentionally excluded from model input.
      semanticFingerprint: (input: Schema.Schema.Type<typeof Parameters>) => ({
        operation: input.operation,
        expected_plan_id: input.expected_plan_id,
        expected_version: input.expected_version,
        replan_reason: input.replan_reason ?? null,
        goal: input.goal.trim(),
        assumptions: (input.assumptions ?? []).map((value) => value.trim()),
        active_step_id: input.active_step_id,
        steps: input.steps.map((step) => ({
          step_id: step.step_id ?? null,
          title: step.title.trim(),
          status: step.status.trim().toLowerCase(),
          acceptance: step.acceptance ?? null,
          assigned_agent: step.assigned_agent ?? null,
          note: step.note ?? null,
        })),
      }),
      resultFingerprint: (result) => ({
        plan_protocol: result.metadata.plan_protocol ?? null,
        plan_progress: result.metadata.plan_progress ?? null,
        plan_id: result.metadata.plan_id,
        plan_version: result.metadata.plan_version ?? null,
        done: result.metadata.done,
        total: result.metadata.total,
      }),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "plan", patterns: ["*"], always: ["*"], metadata: {} })

          const previous = AgentGateway.DeepAgentPlanStore.getPlanDoc(ctx.sessionID)
          const ref = AgentGateway.DeepAgentPlanStore.planDocRef(ctx.sessionID)
          const expectedRef =
            previous && ref
              ? {
                  plan_id: previous.plan_id,
                  doc_id: ref.id,
                  version: ref.version,
                }
              : null
          const attempt = yield* Effect.try({
            try: () => {
              const built = AgentGateway.DeepAgentPlanController.buildPlanFromWriteInput(
                ctx.sessionID,
                {
                  operation: params.operation,
                  expected_plan_id: params.expected_plan_id,
                  expected_version: params.expected_version,
                  replan_reason: params.replan_reason,
                  goal: params.goal,
                  steps: params.steps,
                  assumptions: params.assumptions,
                  active_step_id: params.active_step_id,
                },
                previous,
                expectedRef,
              )
              // The runtime supplies validation evidence only after semantic admission succeeds.
              const plan = AgentGateway.DeepAgentPlanController.attachEvidenceToNewlyDone(
                previous,
                built,
                AgentGateway.DeepAgentSessionState.lastValidationSummary(ctx.sessionID),
              )
              const committed = AgentGateway.DeepAgentPlanStore.compareAndCommitPlan({
                sessionId: ctx.sessionID,
                expected: expectedRef,
                candidate: plan,
                origin: "model_tool",
              })
              AgentGateway.DeepAgentSessionState.bindPlan(ctx.sessionID, committed.plan, previous, committed.changed)
              return {
                previous,
                plan: committed.plan,
                version: committed.version,
                changed: committed.changed,
                changes: AgentGateway.DeepAgentPlanController.diffStepStatuses(previous, committed.plan),
              }
            },
            catch: (error) => error,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          )

          if (!attempt.ok) {
            const error = attempt.error
            if (error instanceof AgentGateway.DeepAgentPlanController.PlanConflictError) {
              const conflict = error as InstanceType<typeof AgentGateway.DeepAgentPlanController.PlanConflictError>
              return {
                title: "Plan conflict",
                output: "The plan changed before this update was committed. Re-read the current plan and retry with its exact plan_id and version.",
                metadata: {
                  plan_id: conflict.actual?.plan_id ?? previous?.plan_id ?? "",
                  goal: previous?.goal ?? params.goal,
                  done: previous ? AgentGateway.DeepAgentPlanController.planProgress(previous).done : 0,
                  total: previous ? AgentGateway.DeepAgentPlanController.planProgress(previous).total : 0,
                  plan_protocol: "conflict",
                  plan_error_code: "plan_conflict",
                  plan_version: conflict.actual?.version ?? ref?.version ?? 0,
                },
              }
            }
            if (error instanceof AgentGateway.DeepAgentPlanController.PlanValidationError) {
              const validation = error
              return {
                title: "Plan needs correction",
                output: `The plan was not committed (${validation.code}). Correct the plan payload and retry once.${validation.challenge_id ? ` Confirmation: ${validation.challenge_id}` : ""}`,
                metadata: {
                  plan_id: previous?.plan_id ?? "",
                  goal: previous?.goal ?? params.goal,
                  done: previous ? AgentGateway.DeepAgentPlanController.planProgress(previous).done : 0,
                  total: previous ? AgentGateway.DeepAgentPlanController.planProgress(previous).total : 0,
                  plan_protocol: "invalid",
                  plan_error_code: validation.code,
                  ...(validation.challenge_id ? { challenge_id: validation.challenge_id } : {}),
                  ...(ref ? { plan_version: ref.version } : {}),
                },
              }
            }
            return yield* Effect.die(error)
          }

          const { previous: prior, plan, version, changed, changes } = attempt.value

          const { done, total } = AgentGateway.DeepAgentPlanController.planProgress(plan)
          const changeLines = changes.map((c) => AgentGateway.DeepAgentPlanController.formatStepChange(c))
          // U10: soft advisory — a step declared `done` whose acceptance criterion has no passing
          // validation on record is flagged (not blocked): the model may be marking done prematurely.
          const acceptanceWarnings = plan.steps
            .filter(
              (s) =>
                s.status === "done" &&
                s.acceptance != null &&
                s.acceptance.trim() !== "" &&
                (s.evidence == null || s.evidence.length === 0),
            )
            .map((s) => `"${s.title}" is done but its acceptance ("${s.acceptance}") has no recorded validation`)
          // U2: publish the live plan only after a real authority version changed. No-op writes still
          // settle the activity tracker as no-progress but must not manufacture a live event.
          if (changed) {
            yield* events
              .publish(PlanEvent.Updated, {
                sessionID: SessionID.make(ctx.sessionID),
                plan_id: plan.plan_id,
                plan_version: version,
                goal: plan.goal,
                assumptions: [...plan.assumptions],
                active_step_id: plan.active_step_id,
                steps: plan.steps.map((s) => ({
                  step_id: s.step_id,
                  title: s.title,
                  status: s.status,
                  acceptance: s.acceptance ?? null,
                  assigned_agent: s.assigned_agent ?? null,
                  note: s.note ?? null,
                  evidence: [...(s.evidence ?? [])],
                })),
                done,
                total,
                changes: changeLines,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("plan.updated publication failed; snapshot remains authoritative").pipe(
                    Effect.annotateLogs({ sessionID: ctx.sessionID, plan_id: plan.plan_id, plan_version: version, cause }),
                    Effect.asVoid,
                  ),
                ),
              )
          }

          const lines = plan.steps.map((s) => {
            const mark =
              s.status === "done"
                ? "x"
                : s.status === "cancelled"
                  ? "-"
                  : s.status === "blocked"
                    ? "!"
                    : s.status === "active"
                      ? ">"
                      : " "
            const suffix = s.status === "blocked" && s.note ? ` — blocked: ${s.note}` : ""
            return `[${mark}] ${s.title}${suffix}`
          })
          const changeSummary = changeLines.length > 0 ? `\n\nChanges: ${changeLines.join("; ")}` : ""
          const warnSummary =
            acceptanceWarnings.length > 0 ? `\n\n⚠ ${acceptanceWarnings.join("; ")}. Verify before finalizing.` : ""
          return {
            title: `Plan: ${done}/${total} steps`,
            output: `Goal: ${plan.goal}\n${lines.join("\n")}${changeSummary}${warnSummary}`,
            metadata: {
              plan_id: plan.plan_id,
              goal: plan.goal,
              done,
              total,
              plan_protocol: changed ? "success" : "no_progress",
              plan_progress:
                changed &&
                (prior == null ||
                  AgentGateway.DeepAgentPlanController.planProgressFingerprint(prior) !==
                    AgentGateway.DeepAgentPlanController.planProgressFingerprint(plan)),
              plan_version: version,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
