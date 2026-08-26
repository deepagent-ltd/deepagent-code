import type { AgentMode } from "./mode"

// V3 RUN_CONTEXT working-memory document (docs/29 §3). Replaces the V2 static metadata
// dump with a regenerated, handoff-ready summary: a reader should know the current status
// and the next action without opening any other file. Pure + testable; the gateway maps
// its RunRecord onto RunContextInput and embeds the boot message (identity + invariant).
//
// Invariants preserved for existing gateway tests:
//  - the output contains the embedded boot message string
//  - the output contains no hidden/evaluator content (caller passes only structured fields)

export type RunContextStatus = "in_progress" | "completed" | "runtime_failed" | "blocked" | "cancelled"

export type RunContextInput = {
  readonly runId: string
  readonly mode: AgentMode
  readonly status: RunContextStatus
  readonly round: number
  readonly modelId: string
  readonly feature: string
  readonly routerProvider: string
  readonly routerModel: string
  readonly activationMode: string
  readonly knowledgeEnabled: boolean
  readonly bestCandidateRef: string | null
  readonly nextAction: string
  readonly rootCause: string | null
  readonly bootMessage: string
}

const handoffHint = (input: RunContextInput): string => {
  switch (input.status) {
    case "completed":
      return "运行已完成；无需继续。"
    case "runtime_failed":
      return `运行失败（${input.rootCause ?? "未知根因"}）；先诊断再决定是否回滚到 best candidate，然后重试。`
    case "blocked":
      return `被策略阻断（${input.rootCause ?? "policy_block"}）；需人工复核后才能恢复。`
    case "cancelled":
      return "已取消；可从最近 checkpoint 复核后恢复。"
    default:
      return "运行进行中；按 next action 继续。"
  }
}

export const buildRunContext = (input: RunContextInput): string => {
  const lines = [
    "# DeepAgent Run Context",
    "",
    input.bootMessage,
    "",
    "## 现状",
    `- status: ${input.status}`,
    `- mode: ${input.mode}（activation: ${input.activationMode}）`,
    `- knowledge: ${input.knowledgeEnabled ? "enabled (max)" : "disabled"}`,
    `- best candidate: ${input.bestCandidateRef ?? "none"}`,
    `- next action: ${input.nextAction}`,
    `- router: ${input.routerProvider}/${input.routerModel}`,
    "",
    `## 本轮要点 (round ${input.round})`,
    `- root cause: ${input.rootCause ?? "无"}`,
    `- model: ${input.modelId} · feature: ${input.feature}`,
    "",
    "## 接手提示",
    `- ${handoffHint(input)}`,
    "",
  ]
  return lines.join("\n")
}
