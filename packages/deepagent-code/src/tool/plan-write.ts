import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./plan-write.txt"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "../session/schema"

// U2: the live plan event. Published on every plan write so the app can render a persistent plan
// panel (goal + steps + progress). Mirrors todo.updated so it flows through the same SSE stream.
const PlanStepEvent = Schema.Struct({
  step_id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  acceptance: Schema.optional(Schema.NullOr(Schema.String)),
  assigned_agent: Schema.optional(Schema.NullOr(Schema.String)),
})
export const PlanEvent = {
  Updated: EventV2.define({
    type: "plan.updated",
    schema: {
      sessionID: SessionID,
      plan_id: Schema.String,
      goal: Schema.String,
      active_step_id: Schema.NullOr(Schema.String),
      steps: Schema.Array(PlanStepEvent),
      done: Schema.Number,
      total: Schema.Number,
    },
  }),
}

// U1 PlanController write tool. The model calls this to create/update its working plan. Storing a
// plan clears a stale latch (session-state.setPlan), which is what unblocks the soft gate after the
// runtime flagged the plan as out of date. Read/diagnosis tools stay allowed while stale, so the
// model can always inspect first and then call `plan` to proceed.

const PlanStep = Schema.Struct({
  step_id: Schema.optional(Schema.String).annotate({ description: "Stable id; omit to auto-assign" }),
  title: Schema.String.annotate({ description: "What this step does" }),
  status: Schema.String.annotate({ description: "pending | active | done | cancelled" }),
  // No NullOr: a nested optional(NullOr(...)) emits a double-nested anyOf whose inner
  // {type:null} survives normalize() and is rejected by some third-party providers (no-reply).
  // Optional already covers "absent"; buildPlanFromInput coerces missing -> null.
  acceptance: Schema.optional(Schema.String).annotate({ description: "How you know this step is done" }),
  assigned_agent: Schema.optional(Schema.String).annotate({ description: "Subagent type to delegate to" }),
})

export const Parameters = Schema.Struct({
  goal: Schema.String.annotate({ description: "One sentence: what 'done' means for this task" }),
  steps: Schema.mutable(Schema.Array(PlanStep)).annotate({ description: "Ordered plan steps" }),
  assumptions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Facts the plan relies on",
  }),
  active_step_id: Schema.optional(Schema.String).annotate({ description: "The step currently being worked on" }),
})

type Metadata = {
  plan_id: string
  goal: string
  done: number
  total: number
}

export const PlanTool = Tool.define<typeof Parameters, Metadata, EventV2Bridge.Service>(
  "plan",
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "plan", patterns: ["*"], always: ["*"], metadata: {} })

          const previous = AgentGateway.DeepAgentSessionState.getPlan(ctx.sessionID)
          const plan = AgentGateway.DeepAgentPlanController.buildPlanFromInput(
            ctx.sessionID,
            {
              goal: params.goal,
              steps: params.steps,
              assumptions: params.assumptions,
              active_step_id: params.active_step_id ?? null,
            },
            previous,
          )
          // Persisting the plan clears a stale latch and bumps replan_count (escape hatch).
          AgentGateway.DeepAgentSessionState.setPlan(ctx.sessionID, plan)

          const { done, total } = AgentGateway.DeepAgentPlanController.planProgress(plan)
          // U2: publish the live plan so the app's persistent plan panel updates immediately.
          yield* events
            .publish(PlanEvent.Updated, {
              sessionID: SessionID.make(ctx.sessionID),
              plan_id: plan.plan_id,
              goal: plan.goal,
              active_step_id: plan.active_step_id,
              steps: plan.steps.map((s) => ({
                step_id: s.step_id,
                title: s.title,
                status: s.status,
                acceptance: s.acceptance ?? null,
                assigned_agent: s.assigned_agent ?? null,
              })),
              done,
              total,
            })
            .pipe(Effect.ignore)

          const lines = plan.steps.map((s) => {
            const mark = s.status === "done" ? "x" : s.status === "cancelled" ? "-" : s.status === "active" ? ">" : " "
            return `[${mark}] ${s.title}`
          })
          return {
            title: `Plan: ${done}/${total} steps`,
            output: `Goal: ${plan.goal}\n${lines.join("\n")}`,
            metadata: { plan_id: plan.plan_id, goal: plan.goal, done, total },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
