import path from "path"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

// U10 step-reporting: render the model's own structured plan as an ephemeral reminder each turn
// (high+ only), so it can SEE its checklist and report against it — and, when it has made several
// edits without a status change, nudge it (soft) to report progress.
//
// PROMPT-CACHE CONTRACT (docs/deepagent-cache-hit-fix-plan.md): the plan snapshot embeds live
// per-step state (done/total, mutation count, nudge) that changes EVERY model call within a turn.
// It MUST NOT be pushed onto a message that sits inside the cached prefix. Historically this pushed
// a synthetic part onto the LAST USER message — but in a tool loop a turn has exactly one user
// message at the FRONT, followed by the accumulated assistant/tool history, so that anchor is NOT
// the tail. Mutating it busted the cache from the user message through the entire tool-loop history,
// every step. So this is now a PURE RENDERER: the caller (session/llm/request.ts) folds the returned
// string into the SAME trailing `<deepagent-round-context>` message that carries the other volatile
// round state, which lands AFTER the Anthropic cache breakpoint. Returns null when there is nothing
// to surface (lightweight mode, or no plan) so the caller can skip it.
export const renderPlanStatus = (sessionID: string): string | null => {
  const agentMode = AgentGateway.snapshot().agentMode ?? "high"
  // Lightweight modes (general/direct) never carry the plan machinery — no snapshot, no nudge.
  if (AgentGateway.DeepAgentPlanController.isLightweightMode(agentMode)) return null
  const plan = AgentGateway.DeepAgentSessionState.getPlan(sessionID)
  if (!plan) return null

  const snapshot = AgentGateway.DeepAgentPlanController.renderPlanSnapshot(plan)
  const mutations = AgentGateway.DeepAgentSessionState.mutationsSinceReport(sessionID)
  const validationPassedSinceReport = AgentGateway.DeepAgentSessionState.validationPassedSinceReport(sessionID)
  // U10 hybrid trigger: semantic (a validation just passed) is primary, mode-scaled count is the
  // backstop. nudgeTrigger returns WHY it fired (or null) so the reminder can be phrased honestly.
  const trigger = AgentGateway.DeepAgentPlanController.nudgeTrigger(plan, {
    mutationsSinceReport: mutations,
    validationPassedSinceReport,
    mode: agentMode,
  })
  const nudge = trigger ? `\n\n${AgentGateway.DeepAgentPlanController.PROGRESS_NUDGE(trigger, mutations)}` : ""
  return `<plan-status>\n${snapshot}${nudge}\n</plan-status>`
}

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // U10 plan-status snapshot is NO LONGER injected here. It embeds live per-turn state and used to be
  // pushed onto this user message, which sits inside the cached prefix during a tool loop and busted
  // the cache every step. It is now rendered by `renderPlanStatus` and folded into the trailing
  // volatile round-context message (after the cache breakpoint) in session/llm/request.ts.

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && (input.agent.name === "auto" || input.agent.name === "build")) {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
