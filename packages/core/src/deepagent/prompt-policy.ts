import type { AgentMode, ActivationStage } from "./mode"
import { knowledgeEnabled } from "./mode"
import type { ActivationDecision } from "./activation-policy"
import type { RoundState, CandidateRef, DiagnosisRef } from "./round-state"

export type PromptContext = {
  readonly mode: AgentMode
  readonly round: number
  readonly activation: ActivationDecision
  readonly roundState: RoundState
  readonly environment: EnvironmentContext
  readonly task: TaskContext
  readonly tools: ToolContext
  readonly knowledge: KnowledgeSynthesis | null
  readonly previousResults: PreviousResults | null
  readonly userInstructions: string | null
}

export type EnvironmentContext = {
  readonly os: string
  readonly shell: string
  readonly cwd: string
  readonly homedir: string
  readonly gitBranch: string | null
  readonly gitRoot: string | null
  readonly isGitRepo: boolean
  readonly date: string
  readonly platform: string
}

export type TaskContext = {
  readonly userRequest: string | null
  readonly taskType: string
  readonly domain: string
  readonly goals: readonly string[]
  readonly successCriteria: readonly string[]
  readonly riskBoundaries: readonly string[]
  readonly validationCommands: readonly string[]
}

export type ToolContext = {
  readonly availableTools: readonly ToolRef[]
  readonly mcpServers: readonly McpServerRef[]
  readonly totalToolCount: number
}

export type ToolRef = {
  readonly name: string
  readonly source: "builtin" | "mcp" | "custom"
  readonly description?: string
}

export type McpServerRef = {
  readonly name: string
  readonly toolCount: number
}

export type KnowledgeSynthesis = {
  readonly synthesis: string
  readonly strategyRefs: readonly string[]
  readonly methodologyRefs: readonly string[]
  readonly memoryRefs: readonly string[]
  // review_4 M1/M4: knowledge and skill refs now retrieved from the durable store. skill is
  // also available in high mode; knowledge only in max/ultra.
  readonly knowledgeRefs?: readonly string[]
  readonly skillRefs?: readonly string[]
  readonly conflicts: readonly string[]
  readonly candidateRefs?: readonly KnowledgeRefProjection[]
  readonly selectedRefs?: readonly KnowledgeRefProjection[]
  readonly rejectedRefs?: readonly { readonly ref_id: string; readonly reason: string }[]
  // V3 anti-misleading fields (optional; docs/30). When present, the prompt renders
  // knowledge as advisory with evidence strength and surfaces excluded/blocked refs.
  readonly gapAnalysis?: readonly { readonly ref_id: string; readonly excluded_by: string }[]
  readonly doNotUse?: readonly { readonly ref_id: string; readonly reason: string }[]
  readonly evidenceByRef?: Readonly<Record<string, string>>
  readonly topkApplied?: Readonly<Record<string, number>>
  readonly activeDomains?: readonly string[] // V3: domain packs activated for this retrieval
}

export type KnowledgeRefProjection = {
  readonly ref_id: string
  readonly kind: "strategy" | "methodology" | "memory" | "knowledge" | "skill"
  readonly provenance: string
  readonly scope: string
  readonly summary: string
  readonly relevance: number
  readonly evidence_strength: string
  readonly body_policy: "summary_only"
}

export type PreviousResults = {
  readonly lastCandidate: CandidateRef | null
  readonly lastDiagnosis: DiagnosisRef | null
  readonly validationOutput: string | null
  readonly bestCandidate: CandidateRef | null
}

export const buildSystemPrompt = (ctx: PromptContext): string => {
  const sections: string[] = []

  sections.push(identitySection(ctx.mode, ctx.round))
  sections.push(environmentSection(ctx.environment))
  sections.push(activationSection(ctx.activation, ctx.round))

  if (ctx.task.userRequest || ctx.task.goals.length > 0) {
    sections.push(taskSection(ctx.task))
  }

  sections.push(toolSection(ctx.tools))

  if (ctx.knowledge && knowledgeEnabled(ctx.mode)) {
    sections.push(knowledgeSection(ctx.knowledge))
  }

  if (ctx.previousResults && ctx.round > 1) {
    sections.push(previousResultsSection(ctx.previousResults))
  }

  sections.push(constraintsSection(ctx.mode, ctx.roundState))

  if (ctx.userInstructions) {
    sections.push(userInstructionsSection(ctx.userInstructions))
  }

  return sections.filter(Boolean).join("\n\n")
}

const identitySection = (mode: AgentMode, round: number): string => {
  // P2-1: ultra must not fall through to the High label. Each strength has its own label.
  const modeLabel =
    mode === "ultra"
      ? "Ultra（自治模式）"
      : mode === "max"
        ? "Max（知识增强模式）"
        : mode === "general"
          ? "General（轻量模式）"
          : "High（高效执行模式）"
  return [
    "# DeepAgent Code",
    "",
    `我是 DeepAgent Code，一个具有完整思维系统的 code agent。当前模式: ${modeLabel}，第 ${round} 轮。`,
    "",
    "我的工作方式：",
    "1. 理解需求 → 形成短设计 → 执行修改 → 运行验证",
    "2. 验证通过则完成，失败则诊断 → 修复 → 再验证",
    "3. 不盲目重试，不做无证据的猜测性修改",
    "4. 工具执行由运行时负责，我负责思维和决策",
  ].join("\n")
}

const environmentSection = (env: EnvironmentContext): string => {
  const lines = [
    "# Environment",
    "",
    `- OS: ${env.os}`,
    `- Shell: ${env.shell}`,
    `- CWD: ${env.cwd}`,
    `- Platform: ${env.platform}`,
    `- Date: ${env.date}`,
  ]
  if (env.isGitRepo) {
    lines.push(`- Git: ${env.gitBranch ?? "unknown branch"}${env.gitRoot ? ` (root: ${env.gitRoot})` : ""}`)
  }
  return lines.join("\n")
}

const activationSection = (activation: ActivationDecision, round: number): string => {
  return ["# Activation", "", `Stage: ${activation.stage} (round ${round})`, "", activation.guidance].join("\n")
}

const taskSection = (task: TaskContext): string => {
  const lines = ["# Task Context", ""]
  if (task.goals.length > 0) {
    lines.push("Goals:")
    for (const goal of task.goals) lines.push(`- ${goal}`)
    lines.push("")
  }
  if (task.successCriteria.length > 0) {
    lines.push("Success criteria:")
    for (const c of task.successCriteria) lines.push(`- ${c}`)
    lines.push("")
  }
  if (task.validationCommands.length > 0) {
    lines.push("Validation commands:")
    for (const cmd of task.validationCommands) lines.push(`- \`${cmd}\``)
    lines.push("")
  }
  if (task.riskBoundaries.length > 0) {
    lines.push("Risk boundaries:")
    for (const r of task.riskBoundaries) lines.push(`- ${r}`)
  }
  return lines.join("\n")
}

const toolSection = (tools: ToolContext): string => {
  const lines = ["# Available Tools", "", `Total: ${tools.totalToolCount} tools available.`]
  if (tools.mcpServers.length > 0) {
    lines.push("")
    lines.push("MCP servers:")
    for (const server of tools.mcpServers) {
      lines.push(`- ${server.name} (${server.toolCount} tools)`)
    }
  }
  const builtins = tools.availableTools.filter((t) => t.source === "builtin")
  if (builtins.length > 0) {
    lines.push("")
    lines.push("Core tools: " + builtins.map((t) => t.name).join(", "))
  }
  return lines.join("\n")
}

const knowledgeSection = (knowledge: KnowledgeSynthesis): string => {
  // Advisory framing (docs/30 §4): knowledge is an optional hint, never an instruction.
  const lines = [
    "# 参考知识（可选提示）",
    "",
    "以下是团队经验，仅供参考。与你的分析或当前证据冲突时，以你的判断为准，可忽略。每条标注证据强度。",
    "",
    knowledge.synthesis,
  ]
  if (knowledge.strategyRefs.length > 0) {
    lines.push("")
    lines.push("Strategy refs: " + knowledge.strategyRefs.join(", "))
  }
  if (knowledge.methodologyRefs.length > 0) {
    lines.push("Methodology refs: " + knowledge.methodologyRefs.join(", "))
  }
  if ((knowledge.knowledgeRefs ?? []).length > 0) {
    lines.push("Knowledge refs: " + knowledge.knowledgeRefs!.join(", "))
  }
  if ((knowledge.skillRefs ?? []).length > 0) {
    lines.push("Skill refs: " + knowledge.skillRefs!.join(", "))
  }
  if (knowledge.doNotUse && knowledge.doNotUse.length > 0) {
    lines.push("")
    lines.push("不要使用（系统已排除）：")
    for (const d of knowledge.doNotUse) lines.push(`- ${d.ref_id}（${d.reason}）`)
  }
  if (knowledge.conflicts.length > 0) {
    lines.push("")
    lines.push("冲突（不要静默选择，自行判断）：")
    for (const c of knowledge.conflicts) lines.push(`- ${c}`)
  }
  return lines.join("\n")
}

const previousResultsSection = (prev: PreviousResults): string => {
  const lines = ["# Previous Round Results", ""]
  if (prev.lastCandidate) {
    lines.push(`Last candidate: round ${prev.lastCandidate.round}, status=${prev.lastCandidate.status}`)
    if (prev.lastCandidate.metric !== null) lines.push(`  metric: ${prev.lastCandidate.metric}`)
  }
  if (prev.lastDiagnosis) {
    lines.push(`Diagnosis: ${prev.lastDiagnosis.root_cause ?? "no root cause identified"}`)
    lines.push(`  next action: ${prev.lastDiagnosis.next_action}`)
  }
  if (prev.validationOutput) {
    const truncated =
      prev.validationOutput.length > 2000 ? prev.validationOutput.slice(0, 2000) + "\n...(truncated)" : prev.validationOutput
    lines.push("")
    lines.push("Validation output:")
    lines.push("```")
    lines.push(truncated)
    lines.push("```")
  }
  if (prev.bestCandidate && prev.bestCandidate !== prev.lastCandidate) {
    lines.push("")
    lines.push(`Best candidate so far: round ${prev.bestCandidate.round}, metric=${prev.bestCandidate.metric}`)
  }
  return lines.join("\n")
}

const constraintsSection = (mode: AgentMode, state: RoundState): string => {
  const lines = [
    "# Constraints",
    "",
    "- Do NOT add comments to code unless asked",
    "- Do NOT explain code changes unless asked",
    "- Keep responses concise and actionable",
    "- Run validation after making changes",
    "- If validation passes, the task is complete — do not continue optimizing",
    "- If you cannot complete the task, explain why clearly",
  ]
  if (state.budget_remaining_tokens !== null) {
    lines.push(`- Token budget remaining: ~${Math.round(state.budget_remaining_tokens / 1000)}k tokens`)
  }
  if (mode === "max") {
    lines.push("- Knowledge synthesis is available — use refs for guidance, not verbatim copying")
    lines.push("- Do not inject hidden/evaluator information into outputs")
  }
  return lines.join("\n")
}

const userInstructionsSection = (instructions: string): string => {
  return ["# User Instructions", "", instructions].join("\n")
}
