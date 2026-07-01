import path from "path"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

// U10 step-reporting: re-inject the model's own structured plan as an ephemeral synthetic reminder
// each turn (high+ only), so it can SEE its checklist and report against it — and, when it has made
// several edits without a status change, nudge it (soft) to report progress. Pushed as an ephemeral
// part (NOT persisted via updatePart), mirroring the plan-mode reminders, so it is constant-cost and
// does not accumulate across turns. The runtime never infers step completion; this only prompts the
// model to report, and the plan tool applies the report.
const applyPlanReport = (userMessage: SessionV1.WithParts): void => {
  const sessionID = userMessage.info.sessionID
  const agentMode = AgentGateway.snapshot().agentMode ?? "high"
  // Lightweight modes (general/direct) never carry the plan machinery — no snapshot, no nudge.
  if (AgentGateway.DeepAgentPlanController.isLightweightMode(agentMode)) return
  const plan = AgentGateway.DeepAgentSessionState.getPlan(sessionID)
  if (!plan) return

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
  userMessage.parts.push({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID,
    type: "text",
    text: `<plan-status>\n${snapshot}${nudge}\n</plan-status>`,
    synthetic: true,
  })
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

  // U10: PlanController snapshot + progress nudge, independent of experimental plan mode.
  applyPlanReport(userMessage)

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
    if (wasPlan && input.agent.name === "build") {
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
