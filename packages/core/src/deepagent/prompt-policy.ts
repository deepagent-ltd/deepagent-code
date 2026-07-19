import type { AgentMode, ActivationStage } from "./mode"
import { knowledgeEnabled } from "./mode"
import type { ActivationDecision } from "./activation-policy"
import type { RoundState, CandidateRef, DiagnosisRef } from "./round-state"
import { buildOrchestrationSection, type FanoutDecision } from "./orchestration"

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
  // §5b: the concrete per-turn fan-out verdict (from decideFanout over this turn's ComplexitySignals).
  // Injected as task-specific numbers by buildOrchestrationSection. Undefined ⇒ generic guidance only.
  readonly fanoutDecision?: FanoutDecision
  // V3.8 App-A C3: the cross-session Project Bridge handoff, pre-rendered (bridge.renderHandoff) by the
  // orchestrator when the mode gate (shouldLoadBridge) admits it and the project has a non-empty bridge.
  // Undefined/empty ⇒ nothing to hand off, section is omitted. Purely additive; independent of fanout.
  readonly bridge?: string
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
  // M2 (S1-v3.4): explicit MCP server name from tool provenance, used for reliable
  // server grouping instead of splitting the tool name. Undefined for non-MCP tools.
  readonly mcpServer?: string
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

// PROMPT-CACHE CONTRACT (see docs/deepagent-cache-hit-fix-plan.md):
// `buildSystemPrompt` MUST be byte-stable across every turn of a session — it becomes the cached
// Anthropic prefix (cache_control breakpoint sits at the end of the system block, transform.ts
// applyCaching). Anything that changes per-round (round number, previous-round results, token
// budget, the concrete fan-out verdict) is a cache-buster: it invalidates the whole prefix AND all
// history after it on every intra-turn call. All such volatile state lives in
// `buildVolatileRoundContext` instead, which the caller appends to the LAST user message (after the
// breakpoint) so the model still sees it without churning the prefix. When editing, ask: "does this
// value differ between two turns of the same session?" If yes, it belongs in the volatile context.
export const buildSystemPrompt = (ctx: PromptContext): string => {
  const sections: string[] = []

  sections.push(identitySection(ctx.mode))
  sections.push(environmentSection(ctx.environment))
  // NOTE: activation guidance and the task/goal section are round-derived (stage advances, the
  // current objective can be re-seeded on a continue round), so they live in buildVolatileRoundContext
  // now, not here. Keeping them out is what makes the prefix byte-stable ACROSS rounds, not just
  // within a round.

  sections.push(toolSection(ctx.tools))

  // L2 (v3.8.0 §L2): orchestration guidance, injected after the tools/task section per the design.
  // Tier-gated by mode; buildOrchestrationSection returns null when there is nothing to add. The
  // per-turn fan-out DECISION (concrete counts) is intentionally NOT passed here — it is volatile and
  // rendered by buildVolatileRoundContext; the system block keeps only the stable generic guidance.
  const orchestration = buildOrchestrationSection(ctx.mode)
  if (orchestration) sections.push(orchestration)

  // V3.8 App-A C3: cross-session handoff. The orchestrator has already gated (shouldLoadBridge) and
  // rendered this; a non-empty string means "another session left forward-looking state" — inject it
  // so the new session opens knowing prior goals/decisions/open items/next. Loaded once at session
  // start and stable thereafter, so it stays in the cached prefix.
  if (ctx.bridge && ctx.bridge.trim().length > 0) {
    sections.push(ctx.bridge)
  }

  // BUG #5 (prompt-cache): knowledge is populated LAZILY — round 1 on a fresh/empty store returns
  // null (no section), and a later retrieval-enabled round returns non-null, which USED to insert the
  // section into the cached prefix mid-session and bust the cache for the rest of the session. Mirror
  // the T4.4 fan-out guard: knowledge is per-session-volatile w.r.t. WHEN it first appears, so it does
  // NOT belong in the byte-stable prefix. It is rendered in buildVolatileRoundContext instead (tail,
  // after the cache breakpoint), so the model still sees it without ever churning the prefix.

  sections.push(constraintsSection(ctx.mode))

  if (ctx.userInstructions) {
    sections.push(userInstructionsSection(ctx.userInstructions))
  }

  return sections.filter(Boolean).join("\n\n")
}

// Volatile per-turn state that must NOT enter the cached system prefix. Rendered into a single
// `<deepagent-round-context>` block that the caller appends to the last user message (after the
// cache breakpoint). Returns "" when there is nothing round-specific to surface (e.g. first turn,
// no previous results) so the caller can skip injection entirely. Keep the ORDER and wording here
// free to change per turn — that is the whole point; only buildSystemPrompt must stay stable.
export const buildVolatileRoundContext = (ctx: PromptContext): string => {
  const sections: string[] = []

  // Round + activation stage: the model's sense of "where am I in the loop". Was previously baked
  // into the identity and activation headers in the system prefix (round-numbered ⇒ cache-busting).
  const roundLine = `第 ${ctx.round} 轮 · 阶段 ${ctx.activation.stage}`
  sections.push(["# 本轮状态 (round context)", "", roundLine].join("\n"))

  // MEDIUM cache-buster fix: the current date was moved OUT of environmentSection (cached prefix) —
  // it advances at midnight and would bust the whole prefix once per day. Render it here in the tail
  // so the model still knows "today" without churning the cache.
  if (ctx.environment.date) {
    sections.push(["# 日期 (date)", "", `- Date: ${ctx.environment.date}`].join("\n"))
  }

  // Activation guidance: the stage-specific how-to-work prose. Stage advances across rounds, so this
  // is round-derived and must not sit in the cached prefix.
  if (ctx.activation.guidance.trim()) {
    sections.push(activationSection(ctx.activation))
  }

  // Task objective + goals/criteria: the current target can be re-seeded on a continue round (the
  // supervisor advances the goal), so it is round-derived. Keep it in the tail.
  if (ctx.task.userRequest || ctx.task.goals.length > 0) {
    sections.push(taskSection(ctx.task))
  }

  // §5b fan-out verdict: task-complexity-derived, so it changes with the user request each turn.
  const fanout = ctx.fanoutDecision ? fanoutVerdictLines(ctx.fanoutDecision) : null
  if (fanout) sections.push(fanout)

  // BUG #5 (prompt-cache): knowledge is retrieved LAZILY (null on a fresh store round 1, non-null on a
  // later retrieval-enabled round). It used to live in the cached system prefix, so its late appearance
  // busted the prefix mid-session (~10× cost). It is advisory, round-derived context — render it here in
  // the volatile tail (after the cache breakpoint) so the model still sees it without ever churning the
  // prefix. The `knowledgeEnabled(mode)` gate is preserved from the original prefix placement.
  if (ctx.knowledge && knowledgeEnabled(ctx.mode)) {
    sections.push(knowledgeSection(ctx.knowledge))
  }

  if (ctx.previousResults && ctx.round > 1) {
    sections.push(previousResultsSection(ctx.previousResults))
  }

  // Token budget remaining: decremented every turn, so it was busting the constraints section.
  if (ctx.roundState.budget_remaining_tokens !== null) {
    sections.push(
      ["# 预算 (budget)", "", `- Token budget remaining: ~${Math.round(ctx.roundState.budget_remaining_tokens / 1000)}k tokens`].join(
        "\n",
      ),
    )
  }

  const body = sections.filter(Boolean).join("\n\n")
  if (!body) return ""
  return ["<deepagent-round-context>", body, "</deepagent-round-context>"].join("\n")
}

const identitySection = (mode: AgentMode): string => {
  // P2-1: ultra must not fall through to the High label. Each strength has its own label.
  // NOTE (prompt-cache): mode is session-stable, but the round number is NOT — it now lives in
  // buildVolatileRoundContext, not here, so this section stays byte-identical across turns.
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
    `我是 DeepAgent Code，一个具有完整思维系统的 code agent。当前模式: ${modeLabel}。`,
    "",
    "我的工作方式：",
    "1. 理解需求 → 形成短设计 → 执行修改 → 运行验证",
    "2. 验证通过则完成，失败则诊断 → 修复 → 再验证",
    "3. 不盲目重试，不做无证据的猜测性修改",
    "4. 工具执行由运行时负责，我负责思维和决策",
    "5. 当前轮次 / 阶段 / 上轮结果 / 预算见对话末尾的 <deepagent-round-context>",
  ].join("\n")
}

const environmentSection = (env: EnvironmentContext): string => {
  // NOTE (prompt-cache): `- Date` is intentionally NOT rendered here. The date advances at midnight,
  // so baking it into the cached prefix busts the whole prefix once per day (MEDIUM cache-buster). It
  // is rendered in buildVolatileRoundContext (tail, after the cache breakpoint) instead — same policy
  // as every other volatile env-derived value. Everything left here is session-stable.
  const lines = [
    "# Environment",
    "",
    `- OS: ${env.os}`,
    `- Shell: ${env.shell}`,
    `- CWD: ${env.cwd}`,
    `- Platform: ${env.platform}`,
  ]
  if (env.isGitRepo) {
    lines.push(`- Git: ${env.gitBranch ?? "unknown branch"}${env.gitRoot ? ` (root: ${env.gitRoot})` : ""}`)
  }
  return lines.join("\n")
}

// The concrete stage+round line moved to buildVolatileRoundContext (it changes per turn). Here we
// keep only the stage's stable GUIDANCE text — the how-to-work-in-this-stage prose, which is a
// function of the stage label and is stable while the session sits in a given stage. (If guidance
// itself ever embeds the round number, render that in the volatile block instead.)
const activationSection = (activation: ActivationDecision): string => {
  return ["# Activation", "", activation.guidance].join("\n")
}

// §5b fan-out verdict rendered for the volatile block. Mirrors the advisory numbers that
// buildOrchestrationSection used to inline, but kept OUT of the cached system prefix because the
// verdict is derived from this turn's task complexity and changes turn-to-turn.
const fanoutVerdictLines = (decision: FanoutDecision): string => {
  if (!decision.orchestrate) {
    return [
      "# 本轮调度判定 (orchestration verdict)",
      "",
      `不建议扇出（level=${decision.level}，tier=${decision.tier}，complexity=${decision.complexity}）。本体直接完成，除非用户明确要求深入/多角度。`,
    ].join("\n")
  }
  return [
    "# 本轮调度判定 (orchestration verdict)",
    "",
    `建议扇出约 ${decision.researchers} 个 researcher` +
      (decision.reviewers > 0 ? ` + ${decision.reviewers} 个 reviewer` : "") +
      `；单轮并行上限 ${decision.maxConcurrency}（代码层已按此硬限流，超发会自动排队）。level=${decision.level}。`,
  ].join("\n")
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
      prev.validationOutput.length > 2000
        ? prev.validationOutput.slice(0, 2000) + "\n...(truncated)"
        : prev.validationOutput
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

// Stable constraints only. The per-turn "Token budget remaining" line moved to
// buildVolatileRoundContext — it decremented every turn and busted this section (and the whole
// prefix after it). What remains is a function of `mode`, which is session-stable.
const constraintsSection = (mode: AgentMode): string => {
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
  if (mode === "max") {
    lines.push("- Knowledge synthesis is available — use refs for guidance, not verbatim copying")
    lines.push("- Do not inject hidden/evaluator information into outputs")
  }
  return lines.join("\n")
}

const userInstructionsSection = (instructions: string): string => {
  return ["# User Instructions", "", instructions].join("\n")
}
