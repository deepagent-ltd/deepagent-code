import type { AgentMode } from "./mode"

/**
 * L2 (v3.8.0 §L2) — multi-agent orchestration fan-out decision, as a PURE function.
 *
 * The primary agent decides whether to fan out to researcher/reviewer subagents based on
 * `min(档位/tier, 复杂度/complexity)`: the mode gives a ceiling on proactiveness, the task
 * complexity gives the actual trigger. A simple task never over-orchestrates even at `ultra`.
 *
 * The caps below (`decideFanout` / `capFanout` / `capConcurrency` / `resolveCaps`) are the reusable
 * CODE-LAYER ceiling: any orchestration driver (e.g. the V4.0 orchestrator loop) MUST route its
 * requested counts through them so the model's stated intent cannot exceed the configured maximum —
 * the clamp runs regardless of what the model asks. In Phase 6 fan-out is still prompt-driven (the
 * primary agent issues `task` calls directly), so `buildOrchestrationSection` surfaces these same
 * numbers as advisory self-limiting guidance rather than a runtime gate; the pure functions here are
 * the single source of truth for both.
 *
 * Per the standing user constraint ("速率/长度类字段不要限制的太死") the caps are CONFIGURABLE with
 * LENIENT defaults — a runaway safety net, not a tight leash. Unset ⇒ the lenient default (never a
 * tight number, never zero). An agent's own `limits.maxConcurrency` (Phase 4 registry, unset ⇒ no
 * agent-specific limit) tightens further when set, but never loosens past nor is required by the
 * orchestration default.
 */

/** Proactiveness ceiling per mode. 0 = orchestration off (only on explicit user request). */
export type OrchestrationTier = 0 | 1 | 2 | 3

export const tierForMode = (mode: AgentMode): OrchestrationTier => {
  switch (mode) {
    case "general":
      return 0
    case "high":
    case "xhigh":
      return 1
    case "max":
      return 2
    case "ultra":
      return 3
  }
}

/** Default reviewer votes per mode (see §L2 table). Gated to 0 when orchestration does not fire. */
export const reviewerVotesForMode = (mode: AgentMode): number => {
  switch (mode) {
    case "general":
      return 0
    case "high":
    case "xhigh":
      return 1
    case "max":
      return 2
    case "ultra":
      return 3
  }
}

/**
 * Task signals used to estimate complexity. `fileOrModuleCount` and the boolean flags come from the
 * primary agent's read of the task; this function is deterministic given them (testable in isolation).
 */
export type ComplexitySignals = {
  /** Number of distinct files/modules the task appears to touch. */
  readonly fileOrModuleCount?: number
  /** Multiple reasonable approaches exist and need comparison. */
  readonly multipleApproaches?: boolean
  /** User explicitly asked to go deep / multi-angle / review / thorough. */
  readonly userRequestedDepth?: boolean
  /** Safety/correctness sensitive (auth, migration, concurrency, data deletion). */
  readonly safetySensitive?: boolean
  /** Changes an interface across subsystems. */
  readonly crossSubsystem?: boolean
  /** Purely mechanical (rename/typo/format) — a suppression signal. */
  readonly trivialMechanical?: boolean
  /** User explicitly asked for a fast / direct answer — a suppression signal. */
  readonly userRequestedFast?: boolean
}

/**
 * §5b — LIGHTWEIGHT, deterministic heuristic that derives `ComplexitySignals` from the raw user
 * request text (and an optional caller-supplied touched-file count). This is deliberately a first
 * pass: cheap keyword/shape detection, NOT an LLM classifier or a deep AST analysis. It only feeds
 * the ADVISORY `decideFanout` numbers injected into the prompt; the real hard cap is the §5a
 * semaphore, so a mis-estimate here can never cause runaway concurrency — at worst the prompt's
 * suggested count is slightly off and the model uses its own judgment. Everything is regex/substring
 * on lowercased text so it is stable and unit-testable.
 */
export const estimateSignalsFromText = (input: {
  readonly userRequest?: string | null
  /** Optional count of distinct files/modules the caller already knows are in play. */
  readonly fileOrModuleCount?: number
}): ComplexitySignals => {
  const text = (input.userRequest ?? "").toLowerCase()
  const has = (...needles: string[]) => needles.some((n) => text.includes(n))

  // Suppression signals take precedence (mirrors estimateComplexity's hard-floor to 0).
  const trivialMechanical =
    has("typo", "rename", "格式", "format", "lint", "重命名", "改个名") ||
    /\bfix (a |the )?typo\b/.test(text)
  const userRequestedFast = has("quick", "quickly", "just ", "asap", "尽快", "快速", "直接告诉", "简单说")

  const userRequestedDepth = has(
    "deep",
    "thorough",
    "comprehensive",
    "review",
    "multiple approach",
    "compare approach",
    "深入",
    "彻底",
    "多角度",
    "审查",
    "多个方案",
    "对比方案",
  )
  const multipleApproaches = has("approach", "option", "alternative", "trade-off", "tradeoff", "方案", "权衡", "选型")
  const safetySensitive = has(
    "auth",
    "migration",
    "migrate",
    "concurren",
    "delete data",
    "drop table",
    "security",
    "permission",
    "认证",
    "鉴权",
    "迁移",
    "并发",
    "删除数据",
    "安全",
  )
  const crossSubsystem = has(
    "across",
    "cross-",
    "cross ",
    "interface",
    "subsystem",
    "end-to-end",
    "整个系统",
    "跨模块",
    "跨系统",
    "接口改动",
  )

  return {
    ...(input.fileOrModuleCount != null ? { fileOrModuleCount: input.fileOrModuleCount } : {}),
    multipleApproaches: multipleApproaches || undefined,
    userRequestedDepth: userRequestedDepth || undefined,
    safetySensitive: safetySensitive || undefined,
    crossSubsystem: crossSubsystem || undefined,
    trivialMechanical: trivialMechanical || undefined,
    userRequestedFast: userRequestedFast || undefined,
  }
}

/**
 * Estimate task complexity on the same 0..3 scale as tier, so `min(tier, complexity)` is meaningful.
 * Suppression signals hard-floor to 0. Otherwise the number of fan-out signals (with ≥3 files/modules
 * counting as a signal) maps monotonically onto 0..3.
 */
export const estimateComplexity = (signals: ComplexitySignals): OrchestrationTier => {
  if (signals.trivialMechanical || signals.userRequestedFast) return 0
  let hits = 0
  if ((signals.fileOrModuleCount ?? 0) >= 3) hits++
  if (signals.multipleApproaches) hits++
  if (signals.userRequestedDepth) hits++
  if (signals.safetySensitive) hits++
  if (signals.crossSubsystem) hits++
  if (hits <= 0) return 0
  if (hits === 1) return 1
  if (hits === 2) return 2
  return 3
}

/** Configurable, lenient orchestration ceilings. Unset ⇒ the lenient defaults below. */
export type OrchestrationCaps = {
  /** Max total subagents spawned in one orchestration (researchers + reviewers). */
  readonly maxFanout?: number
  /** Max subagents dispatched in parallel in a single round. */
  readonly maxConcurrency?: number
}

/**
 * Lenient defaults — deliberately generous. These are the CODE-layer runaway guard, not a tight
 * budget. Deployments may raise or lower them via config; nothing here bakes in a restrictive number.
 */
export const DEFAULT_MAX_FANOUT = 8
export const DEFAULT_MAX_CONCURRENCY = 4

export const resolveCaps = (caps?: OrchestrationCaps): { maxFanout: number; maxConcurrency: number } => {
  const maxFanout = caps?.maxFanout != null && caps.maxFanout > 0 ? caps.maxFanout : DEFAULT_MAX_FANOUT
  const maxConcurrency =
    caps?.maxConcurrency != null && caps.maxConcurrency > 0 ? caps.maxConcurrency : DEFAULT_MAX_CONCURRENCY
  return { maxFanout, maxConcurrency }
}

/** Clamp a requested subagent count to the resolved hard cap. Never returns more than the cap. */
export const capFanout = (requested: number, caps?: OrchestrationCaps): number => {
  const { maxFanout } = resolveCaps(caps)
  if (!Number.isFinite(requested) || requested < 0) return 0
  return Math.min(Math.floor(requested), maxFanout)
}

/** Clamp a requested parallel round width to the resolved concurrency cap. */
export const capConcurrency = (requested: number, caps?: OrchestrationCaps): number => {
  const { maxConcurrency } = resolveCaps(caps)
  if (!Number.isFinite(requested) || requested < 0) return 0
  return Math.min(Math.floor(requested), maxConcurrency)
}

export type FanoutDecision = {
  /** Whether to orchestrate at all. False ⇒ handle the task inline (current behavior). */
  readonly orchestrate: boolean
  /** Effective proactiveness = min(tier, complexity). */
  readonly level: OrchestrationTier
  readonly tier: OrchestrationTier
  readonly complexity: OrchestrationTier
  /** Number of researcher subagents to fan out (after hard caps). */
  readonly researchers: number
  /** Number of reviewer subagents to fan out (after hard caps). */
  readonly reviewers: number
  /** Max subagents to run in parallel per round (after hard caps). */
  readonly maxConcurrency: number
}

/**
 * Decide whether and how much to fan out. Pure and deterministic.
 *
 * Merge rule: `level = min(tier, complexity)`. Orchestration fires only when `level >= 1`, so a
 * trivial task never orchestrates even at `ultra`, and no task orchestrates at `general` (tier 0)
 * unless the caller forces it (`forceOrchestrate`, e.g. the user explicitly asked).
 *
 * The requested researcher/reviewer counts are then clamped by the CODE-layer hard cap `capFanout`
 * — the model's stated intent cannot exceed it.
 */
export const decideFanout = (input: {
  readonly mode: AgentMode
  readonly signals: ComplexitySignals
  readonly caps?: OrchestrationCaps
  /** When true, orchestrate even if tier/complexity would suppress it (explicit user request). */
  readonly forceOrchestrate?: boolean
}): FanoutDecision => {
  const tier = tierForMode(input.mode)
  const complexity = estimateComplexity(input.signals)
  const level = Math.min(tier, complexity) as OrchestrationTier
  const orchestrate = input.forceOrchestrate === true || level >= 1
  const { maxConcurrency } = resolveCaps(input.caps)

  if (!orchestrate) {
    return { orchestrate: false, level, tier, complexity, researchers: 0, reviewers: 0, maxConcurrency }
  }

  // Researchers: roughly one per module, at least 2 when orchestrating, guided by the file/module
  // count and the effective level. Reviewers come from the mode's default votes. Both are clamped by
  // the hard cap; researchers take priority, reviewers get the remaining budget.
  const requestedResearchers = Math.max(2, Math.min(input.signals.fileOrModuleCount ?? level + 1, 5))
  const requestedReviewers = input.forceOrchestrate && reviewerVotesForMode(input.mode) === 0 ? 1 : reviewerVotesForMode(input.mode)

  const researchers = capFanout(requestedResearchers, input.caps)
  const { maxFanout } = resolveCaps(input.caps)
  const reviewers = Math.max(0, Math.min(requestedReviewers, maxFanout - researchers))

  return { orchestrate: true, level, tier, complexity, researchers, reviewers, maxConcurrency }
}

/**
 * L2 (v3.8.0 §L2, 2a) — the orchestration guidance system-prompt section. Single source of truth
 * shared by BOTH prompt-assembly paths (non-DeepAgent via session/system.ts+request.ts, DeepAgent via
 * prompt-policy.ts) so the two paths cannot drift. Tier-gated: at `general` (tier 0) orchestration is
 * OFF and the section only tells the agent to fan out on explicit user request; at higher tiers it
 * gives the full fan-out judgment. Returns `null` when there is nothing worth injecting.
 */
// PROMPT-CACHE NOTE: this returns the STABLE, generic orchestration guidance only — it is a pure
// function of `mode`, so it stays byte-identical across a session and can live in the cached system
// prefix. The per-turn fan-out VERDICT (concrete researcher/reviewer counts derived from this turn's
// task complexity) is deliberately NOT rendered here anymore; it changes turn-to-turn and would bust
// the prefix. The DeepAgent path renders that verdict via prompt-policy.ts `buildVolatileRoundContext`
// and appends it after the cache breakpoint. The non-DeepAgent path (session/system.ts) may still
// pass no decision and get just this stable guidance.
export const buildOrchestrationSection = (mode: AgentMode): string | null => {
  const tier = tierForMode(mode)
  const votes = reviewerVotesForMode(mode)
  const header = "# 多-Agent 编排 (multi-agent orchestration)"

  if (tier === 0) {
    // general: orchestration off by default. Still tell the model the capability exists on request.
    return [
      header,
      "",
      "默认不自动编排。只有当用户明确要求「深入 / 多角度 / review / 彻底」时，才用 `task` 工具扇出 researcher/reviewer 子 agent；否则本体直接完成。",
      "简单任务（单文件、机制清楚、纯机械改动）永远本体做。",
    ].join("\n")
  }

  const lines = [
    header,
    "",
    "当任务命中「扇出判据」时，不要本体独自完成，按此模式工作：",
    "1. 拆解：把任务分成 2–5 个可独立研究的子模块，声明各自文件范围。",
    "2. 并行研究：在同一条消息里对每个子模块发一个 `researcher` task 调用（单消息多 tool-use ⇒ 并行）。每个子任务 prompt 必须各异（按模块），不要发重复的 task。",
    "3. 综合：读回所有 researcher 的结构化结果，形成方案。",
    `4. 独立审查：对方案/关键改动，并行发 ${votes} 个 \`reviewer\` task（指示其反驳、找可复现失败场景）。`,
    "5. 决策：综合 reviewer findings，采纳/驳回，必要时回到第 2 步。",
    "",
    "扇出信号（任一命中即倾向扇出）：涉及 ≥3 个文件/模块；有多个合理方案需比较；用户要求深入/多角度/review/彻底；安全或正确性敏感（auth、迁移、并发、数据删除）；跨子系统接口改动。",
    "抑制信号（命中则本体做，禁止过度编排）：单文件；机制已明确；纯机械改动（改名/typo/格式）；用户要求快速/直接。",
    "",
    "关键判定（reviewer 的 verdict、研究结果的合并）走结构化结果：调 `task` 时传 `output_schema`（reviewer→ReviewResult，researcher→ResearchResult），不要依赖散文解析。",
    `扇出规模自控（宽松上限，非硬性）：单次编排子 agent 总数控制在 ${DEFAULT_MAX_FANOUT} 个以内，单轮并行不超过 ${DEFAULT_MAX_CONCURRENCY} 个；确有必要可分多轮，但不要一次性发起远超此规模的 task。本轮的具体扇出建议数见对话末尾 <deepagent-round-context>。`,
  ]
  if (mode === "ultra") {
    lines.push("当前为 ultra：默认倾向编排并可多轮迭代。")
  }
  return lines.join("\n")
}

export * as Orchestration from "./orchestration"
