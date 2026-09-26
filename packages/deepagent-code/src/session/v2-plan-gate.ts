export * as V2PlanGate from "./v2-plan-gate"

// W2-V2 接线：V2 runner 的工具结算门禁。V1 路径的门禁在 SessionTools.resolve 的包装器里
// （session/tools.ts evaluatePlanGate）；V2 runner 经 core ToolRegistry 结算工具，完全绕过
// 该包装器 — run 模式实测 V2 路径上 edit 零拦截、plan 零调用。本模块把同一套门禁决策
// （W2 无计划首变更阻断 / W6 stale 阻断 / U1 grace release / 轻量豁免）接到
// SessionRunner.CurrentToolSettleGate seam 上。本模块是 production V2 的门禁决策入口；后续
// 门禁行为与测试都以 core V2 路径为准，legacy session/tools.ts 仅保留迁移期兼容。

import { Context, Effect, Layer } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as mechanismBeacon from "@deepagent-code/core/deepagent/mechanism-beacon"

const planHook = new AgentGateway.DeepAgentHooks.HookPolicy().on(
  "before_tool_use",
  AgentGateway.DeepAgentHooks.planGate(),
)

type Directive = { kind: "pass"; reminder?: string } | { kind: "block"; output: string }

const decide = function (
  flags: RuntimeFlags.Info,
  runtime: AgentGateway.RuntimeInterface,
  input: { readonly sessionID: string; readonly parentID?: string; readonly toolName: string; readonly args: unknown },
): Effect.Effect<Directive> {
  // The parent owns the goal plan. A delegated child has its own Session ID and cannot advance
  // that plan, so gating its edits on a child-local plan creates a deadlock.
  if (input.parentID) return Effect.succeed({ kind: "pass" })
  return Effect.sync(() =>
    runtime.withStorage(() => {
      const sessionID = input.sessionID
      // Beacon: this function is called on EVERY tool settlement, with the gate ON or OFF, so a
      // counter here measures reachability of the call site rather than the mechanism — measured as
      // C3 (gate OFF) logging MORE consults than C2 (gate ON): 101 vs 67. The mechanism is recorded
      // only where it DECIDES: an implicit-plan registration (3 sites) or a block (2 sites).
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
      // Bash 命令的变更分类沿用 core 控制器的命令嗅探；其余工具按工具名分类。失败按变更
      // 处理。这个分类器用于放宽门禁，因此不能再按命令头做二次豁免：grep/find 也可通过
      // 重定向、-delete 或写入型管道改变仓库。
      let isMutating: boolean
      try {
        const command =
          input.toolName === "bash" &&
          typeof input.args === "object" &&
          input.args !== null &&
          "command" in input.args &&
          typeof input.args.command === "string"
            ? input.args.command
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
      const subagentHasPlanEscape = !sessionID.includes("ses_learning_review")
      // V2 sessions never seed DeepAgentSessionState, so the latch reads undefined until the first
      // block — seed it HERE (same "high" the unseeded gate reads as) or recordPlanGateBlock
      // no-ops forever and the consecutive-block grace release never arms: the model gets blocked
      // indefinitely with no tool-side escape (102 blocks, 0 releases in the ablation runs).
      if (subagentHasPlanEscape && latch == null && state == null)
        AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, agentMode)
      let graceReminder: string | undefined
      // W2：无计划的 run 的首个变更被拦一次（可复制最小计划模板；单步计划 = trivial 出口）。
      // G1 隐式 plan：低风险首变更（单点 edit/write，且非 stale、非子会话）由 runtime 直接登记一个
      // 单步 plan 并放行 —— 简单任务不再为“先调 plan 工具”多付一个 provider round。plan store 的
      // 版本、审计事件与模型写的 plan 完全一致（origin=runtime_plan_gate，runner 溯源）；模型仍可
      // 通过 plan 工具推进/replan。高风险（bash 变更、stale、多工具并发首改）保持原阻断路径。
      if (flags.strictPlanGate && !lightweight && plan == null && !planStale && isMutating && subagentHasPlanEscape) {
        // `apply_patch` and `apply_patch_chunk` are the SAME low-risk class as edit/write: both are
        // single-target, content-matched file mutations with no shell authority. Excluding them made
        // the implicit-plan fast path dead for the way models actually edit (round-10: the run's
        // mutations were `apply_patch_chunk`/`apply_patch`, so every first edit took the BLOCK path
        // and cost an extra provider turn — 40 of 160 gate consults were blocks).
        const lowRiskFirstEdit =
          (input.toolName === "edit" ||
            input.toolName === "write" ||
            input.toolName === "apply_patch" ||
            input.toolName === "apply_patch_chunk") &&
          latch != null &&
          latch.consecutive_blocks === 0
        if (lowRiskFirstEdit) {
          const registered = AgentGateway.DeepAgentSessionState.registerImplicitPlan(sessionID, {
            title: implicitPlanTitle(input),
            agentMode,
          })
          if (registered != null) {
            mechanismBeacon.recordEngagement("strict_plan_gate", `implicit-plan=${input.toolName}`)
            const pass: Directive = {
              kind: "pass",
              reminder:
                "Plan gate registered a one-step runtime plan for this edit. Continue; call the `plan` tool if the work grows beyond it.",
            }
            return pass
          }
        }
        if (latch != null && AgentGateway.DeepAgentPlanController.shouldGraceRelease(latch)) {
          // The grace release used to be a BARE pass: the latch kept its block count, the pass reset it,
          // and the next mutations blocked twice more. Measured on the wazero run: 93 blocks / 46
          // releases over 199 provider turns — a 2-turn tax that repeated for the whole run because the
          // block never once produced a plan. A release is therefore a DECISION, not a pardon: the
          // runtime registers the one-step implicit plan (the same audit artifact the low-risk fast path
          // writes) and the session proceeds. The block tax is paid at most once per session.
          const registered = AgentGateway.DeepAgentSessionState.registerImplicitPlan(sessionID, {
            title: implicitPlanTitle(input),
            agentMode,
          })
          graceReminder = registered
            ? `Plan gate released this call after ${latch.consecutive_blocks} blocks and registered a one-step runtime plan; the block will not repeat. Call the \`plan\` tool if the work grows beyond it.`
            : `Plan gate released this call after ${latch.consecutive_blocks} blocks. Call the \`plan\` tool now (one step is fine) — the next mutating call blocks again.`
          mechanismBeacon.recordEngagement(
            "strict_plan_gate",
            registered ? `grace-release+implicit-plan=${input.toolName}` : `grace-release=${input.toolName}`,
          )
        } else {
          AgentGateway.DeepAgentSessionState.recordPlanGateBlock(sessionID)
          mechanismBeacon.recordEngagement("strict_plan_gate", `blocked=${input.toolName}`)
          const block: Directive = {
            kind: "block",
            output:
              "Plan gate: create a plan first via the `plan` tool (one step is fine), then retry.\n" +
              JSON.stringify({
                operation: "create",
                goal: "<one sentence>",
                steps: [{ title: "<first step>", status: "active" }],
              }),
          }
          return block
        }
      }
      // W6：stale 计划的变更阻断；与无计划分支共享 core 的 grace limit。
      const strictBlock =
        flags.strictPlanGate &&
        gateDecision.decision === "warn" &&
        !lightweight &&
        gateDecision.blockReason != null &&
        planStale &&
        subagentHasPlanEscape
      if (gateDecision.decision === "block" || strictBlock) {
        if (strictBlock && latch != null && AgentGateway.DeepAgentPlanController.shouldGraceRelease(latch)) {
          // Same repeated-tax bug as the no-plan branch, and the same fix: a release clears the stale
          // latch instead of leaving it armed to re-block two calls later. The latch is re-armed by its
          // real triggers (a new user message, a failing validation), so clearing it here cannot hide a
          // genuine desync — it only stops the gate from billing turns for a warning the model has
          // already been shown.
          AgentGateway.DeepAgentSessionState.clearPlanStale(sessionID)
          mechanismBeacon.recordEngagement("strict_plan_gate", `grace-release-stale=${input.toolName}`)
          graceReminder =
            `The plan is stale (${latch.stale_reason}) and the plan gate already blocked ${latch.consecutive_blocks} consecutive mutating calls without a plan update. ` +
            "This call was released and the staleness warning cleared — update the plan via the `plan` tool when it is next convenient; it will not block again for this reason."
        } else {
          AgentGateway.DeepAgentSessionState.recordPlanGateBlock(sessionID)
          mechanismBeacon.recordEngagement("strict_plan_gate", `blocked-stale=${input.toolName}`)
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
    }),
  )
}

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const runtime = yield* AgentGateway.Runtime
    return Context.make(SessionRunner.CurrentToolSettleGate, (input) => decide(flags, runtime, input))
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(RuntimeFlags.defaultLayer),
  Layer.provide(AgentGateway.runtimeLayer()),
)

// The implicit plan's single step title: derived from the gated edit's target path (write) or file
// path (edit). The title is descriptive only — the plan's semantics come from the gate's decision
// that this is a low-risk first edit; a malformed/absent path falls back to the tool name.
const implicitPlanTitle = (input: { readonly toolName: string; readonly args: unknown }): string => {
  const args = (typeof input.args === "object" && input.args !== null ? input.args : {}) as Record<string, unknown>
  const target = args.filePath ?? args.path ?? args.file
  return typeof target === "string" && target.trim().length > 0
    ? `Apply ${input.toolName} to ${target.trim().slice(0, 80)}`
    : `First ${input.toolName} (runtime-registered)`
}

// exported for tests
export const decideForTest = decide
