export * as V2PlanGate from "./v2-plan-gate"

// W2-V2 接线：V2 runner 的工具结算门禁。V1 路径的门禁在 SessionTools.resolve 的包装器里
// （session/tools.ts evaluatePlanGate）；V2 runner 经 core ToolRegistry 结算工具，完全绕过
// 该包装器 — run 模式实测 V2 路径上 edit 零拦截、plan 零调用。本模块把同一套门禁决策
// （W2 无计划首变更阻断 / W6 stale 阻断 / U1 grace release / 轻量豁免）接到
// SessionRunner.CurrentToolSettleGate seam 上。
//
// 决策逻辑与 V1 的 evaluatePlanGate 保持同构：任何行为分歧按缺陷处理（两侧必须一致）。

import { Context, Effect, Layer, Option } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"

const planHook = new AgentGateway.DeepAgentHooks.HookPolicy().on(
  "before_tool_use",
  AgentGateway.DeepAgentHooks.planGate(),
)

type Directive = { kind: "pass"; reminder?: string } | { kind: "block"; output: string }

const decide = function (
  flags: RuntimeFlags.Info,
  input: { readonly sessionID: string; readonly toolName: string; readonly args: unknown },
): Effect.Effect<Directive> {
  return Effect.sync(() => {
    const sessionID = input.sessionID
    const latch = AgentGateway.DeepAgentSessionState.planLatch(sessionID)
    const planStale = latch?.latch === "stale" && !AgentGateway.DeepAgentPlanController.shouldEscapeToHuman(latch)
    // V2 sessions never seed DeepAgentSessionState (the V1 ensureSessionStateForRun does that) —
    // an unseeded session must NOT fall through to the process-global snapshot (whose default
    // "general" would silently exempt every V2 run from the gate): unseeded reads as "high",
    // the auto agent's tier on the V2 path.
    const state = AgentGateway.DeepAgentSessionState.get(sessionID)
    const agentMode = state?.mode ?? "high"
    const lightweight = AgentGateway.DeepAgentPlanController.isLightweightMode(agentMode)
    const plan = AgentGateway.DeepAgentSessionState.getPlan(sessionID)
    // Bash 命令的变更分类沿用控制器的命令嗅探；其余工具按工具名分类。失败按变更处理
    // （fail-safe，与 V1 包装器一致）。
    let isMutating: boolean
    try {
      const command = input.toolName === "bash" && typeof input.args === "object" && input.args !== null
        ? String((input.args as { readonly command?: unknown }).command ?? "")
        : undefined
      isMutating = AgentGateway.DeepAgentPlanController.isMutatingTool(input.toolName, command)
    } catch {
      isMutating = true
    }
    const gateDecision = planHook.evaluate({
      name: "before_tool_use",
      payload: {
        planStale,
        staleReason: latch?.stale_reason ?? null,
        isMutating,
        lightweight,
        hardGate: !lightweight && AgentGateway.DeepAgentPlanController.hardGateEnabled(agentMode),
        planExists: plan != null,
        hasActiveStep: AgentGateway.DeepAgentPlanController.hasActiveStep(plan),
      },
    })
    // V2 主会话默认可修复（plan 工具在 registry 中可用）；子会话（学习 reviewer 等）不设防 —
    // 它们没有 plan 权限，阻断即死锁（V1 的 subagentHasPlanEscape 同义，V2 侧 session 表无
    // parentID 可查时保守放行）。
    const subagentHasPlanEscape = sessionID.includes("ses_learning_review") !== true
    let graceReminder: string | undefined
    // W2：无计划的 run 的首个变更被拦一次（可复制最小计划模板；单步计划 = trivial 出口）。
    if (flags.strictPlanGate && !lightweight && plan == null && !planStale && isMutating && subagentHasPlanEscape) {
      if (latch != null && AgentGateway.DeepAgentPlanController.shouldGraceRelease(latch)) {
        graceReminder =
          `No plan was ever created and the plan gate already blocked ${latch.consecutive_blocks} consecutive mutating calls without one. ` +
          "This call was released ONCE: call the `plan` tool now with a minimal plan (a one-step plan is fine for a simple task) — otherwise the next mutating call will be blocked again."
      } else {
        AgentGateway.DeepAgentSessionState.recordPlanGateBlock(sessionID)
        const block: Directive = {
          kind: "block",
          output:
            "No plan exists yet, so this mutating action is held: call the `plan` tool first with a one-sentence goal and ordered steps. A one-step plan is a valid escape for a genuinely simple task.\n\nCopyable starting point:\n" +
            JSON.stringify({
              operation: "create",
              expected_plan_id: null,
              expected_version: null,
              goal: "<one sentence: what done means>",
              steps: [{ title: "<first coherent step>", status: "active" }],
            }),
        }
        return block
      }
    }
    // W6：stale 计划的变更阻断（grace release 同 V1）。
    const strictBlock =
      flags.strictPlanGate &&
      gateDecision.decision === "warn" &&
      !lightweight &&
      gateDecision.blockReason != null &&
      planStale &&
      subagentHasPlanEscape
    if (gateDecision.decision === "block" || strictBlock) {
      if (strictBlock && latch != null && AgentGateway.DeepAgentPlanController.shouldGraceRelease(latch)) {
        graceReminder =
          `The plan is stale (${latch.stale_reason}) and the plan gate already blocked ${latch.consecutive_blocks} consecutive mutating calls without a plan update. ` +
          "This call was released ONCE: call the `plan` tool now to update the plan (or replan) — otherwise the next mutating call will be blocked again."
      } else {
        AgentGateway.DeepAgentSessionState.recordPlanGateBlock(sessionID)
        const output =
          latch?.stale_reason != null
            ? `The plan is stale (${latch.stale_reason}). This action is blocked until the plan is re-synced: call the \`plan\` tool to update your plan (or replan), then retry this edit.`
            : `${gateDecision.blockReason} Call the \`plan\` tool first.`
        const staleBlock: Directive = { kind: "block", output }
        return staleBlock
      }
    }
    if (isMutating) {
      AgentGateway.DeepAgentSessionState.recordMutation(sessionID)
      AgentGateway.DeepAgentSessionState.resetPlanGateBlocks(sessionID)
    }
    const pass: Directive = graceReminder ? { kind: "pass", reminder: graceReminder } : { kind: "pass" }
    return pass
  })
}

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    SessionRunner.registerToolSettleGate((input) => decide(flags, input))
    return Context.make(
      SessionRunner.CurrentToolSettleGate,
      (input) => decide(flags, input),
    )
  }),
)

// The W3.1 seam pattern (productionV2SourcesLayer): the runner tree self-provides this layer at its
// root, so an OUTER host providing `layer` flows in via serviceOption; without a host the gate is
// absent and V2 settles stay ungated (pure core compositions).
export const gateSeamLayer = Layer.unwrap(
  Effect.gen(function* () {
    const provided = yield* Effect.serviceOption(SessionRunner.CurrentToolSettleGate)
    return Option.isSome(provided)
      ? Layer.succeedContext(Context.make(SessionRunner.CurrentToolSettleGate, provided.value))
      : Layer.effectDiscard(Effect.void)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(RuntimeFlags.defaultLayer))

// exported for tests
export const decideForTest = decide
