import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { SessionPaths } from "./workspace"

// Minimal admitted-hit shape for the optional project-memory block. The legacy ProjectMemoryIndex
// admission path is retired (docs/34); this type is retained locally so the prompt-pipeline's
// optional projectMemory field keeps its shape for any future doc-graph-backed admission source.
// Only `id` and `decision` are read here; the rest are carried through untouched.
export type AdmittedHit = {
  readonly id: string
  readonly decision: "inject_summary" | "match_only" | "blocked"
  readonly project_id?: string
  readonly title?: string
  readonly summary?: string
  readonly provenance?: string
  readonly body?: string
  readonly blocked_reason?: string
}

export const PROMPT_DRAFT_SCHEMA_VERSION = "deepagent-code.prompt_draft.v1"
export const CONTEXT_PLAN_SCHEMA_VERSION = "deepagent-code.context_plan.v1"

export type PromptMode = "intelligence" | "direct_override"
export type IntelligenceRoute = "code" | "general"
export type PromptDraftState = "draft_ready" | "confirmed" | "archived" | "task_submitted"
export type TaskType = "implementation" | "review" | "test" | "research" | "document" | "unknown"

export type Assumption = {
  readonly text: string
  readonly status: "pending_confirmation" | "confirmed" | "rejected"
  readonly source: "system_inference" | "user_input" | "project_memory" | "handoff"
}

export type SourceBlock = {
  readonly label: string
  readonly source_label: "user_input" | "project_memory" | "skill" | "handoff" | "rule"
  readonly ref: string
  readonly admitted: boolean
}

export type AgentPromptDraft = {
  readonly schema_version: typeof PROMPT_DRAFT_SCHEMA_VERSION
  readonly id: string
  readonly mode: PromptMode
  readonly state: PromptDraftState
  readonly raw_input_ref: string
  readonly goal: string
  readonly task_type: TaskType
  readonly constraints: readonly string[]
  readonly acceptance: readonly string[]
  readonly assumptions: readonly Assumption[]
  readonly source_blocks: readonly SourceBlock[]
  readonly selected_skills: readonly string[]
  readonly context_plan_id: string
  readonly confirmed_at: string | null
  readonly submitted_at?: string
}

export type ContextPlan = {
  readonly schema_version: typeof CONTEXT_PLAN_SCHEMA_VERSION
  readonly id: string
  readonly query: { readonly raw: string; readonly keywords: readonly string[]; readonly domains: readonly string[] }
  readonly topk: {
    readonly project_memory: number
    readonly user_memory: number
    readonly skills: number
    readonly handoff: number
  }
  readonly memory_snapshot_id: string
  readonly skill_snapshot_id: string
  readonly admitted_refs: readonly string[]
  readonly suggested_refs: readonly string[]
  readonly denied_refs: readonly string[]
  readonly admission_audit: readonly string[]
  readonly estimated_prompt_tokens: number
  readonly incomplete_context: boolean
}

export type RefineInput = {
  readonly rawInput: string
  readonly mode?: PromptMode
  readonly turn?: number
  readonly projectMemory?: readonly AdmittedHit[]
  readonly selectedSkills?: readonly string[]
  readonly handoffRefs?: readonly string[]
  readonly timeoutMs?: number
  readonly startedAt?: number
}

export type SubmitResult = {
  readonly prompt_draft_id: string
  readonly context_plan_id: string
  readonly memory_snapshot_id: string
  readonly skill_snapshot_id: string
  readonly task_prompt: string
}

const safeFileID = (id: string): string => id.replace(/[^A-Za-z0-9._:-]/g, "_").replace(/:/g, "__")

const writeJson = (file: string, value: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8")
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T

const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

const keywords = (text: string): string[] =>
  Array.from(new Set(text.toLowerCase().match(/[a-z0-9_\-]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [])).slice(0, 12)

const classifyTask = (text: string): TaskType => {
  const lower = text.toLowerCase()
  if (/review|审查|评审/.test(lower)) return "review"
  if (/test|测试|验证/.test(lower)) return "test"
  if (/research|调研|查找|搜索/.test(lower)) return "research"
  if (/doc|文档|报告|简报/.test(lower)) return "document"
  if (/implement|fix|build|修改|实现|修复|完成/.test(lower)) return "implementation"
  return "unknown"
}

export class PromptDraftStore {
  readonly sessionID: string

  constructor(private readonly session: SessionPaths) {
    this.sessionID = sessionID(session)
    mkdirSync(session.draftsDir, { recursive: true })
    mkdirSync(session.confirmedDir, { recursive: true })
    if (!existsSync(session.rawInputs)) writeFileSync(session.rawInputs, "", "utf8")
  }

  appendRawInput(rawInput: string): string {
    const index = this.rawCount()
    const entry = { offset: index, created_at: new Date().toISOString(), raw_input: rawInput }
    appendFileSync(this.session.rawInputs, JSON.stringify(entry) + "\n", "utf8")
    return `prompt/raw-inputs.jsonl#${index}`
  }

  nextSequence(): number {
    return readdirSync(this.session.draftsDir).filter((file) => file.endsWith(".json")).length + 1
  }

  saveDraft(draft: AgentPromptDraft, contextPlan: ContextPlan): void {
    writeJson(path.join(this.session.draftsDir, `${safeFileID(draft.id)}.json`), draft)
    writeJson(path.join(this.session.draftsDir, `${safeFileID(contextPlan.id)}.json`), contextPlan)
    writeFileSync(path.join(this.session.draftsDir, `${safeFileID(draft.id)}.md`), renderDraftMarkdown(draft), "utf8")
  }

  getDraft(id: string): AgentPromptDraft | null {
    const file = path.join(this.session.draftsDir, `${safeFileID(id)}.json`)
    return existsSync(file) ? readJson<AgentPromptDraft>(file) : null
  }

  getContextPlan(id: string): ContextPlan | null {
    const file = path.join(this.session.draftsDir, `${safeFileID(id)}.json`)
    return existsSync(file) ? readJson<ContextPlan>(file) : null
  }

  // A3 macro-round: persist the next-round `{status, body}` suggestion so the UI can surface it
  // for human approval (high/max) or the ultra supervisor can read it. Append-only, sequenced.
  saveSuggestion(suggestion: { status: string; body: string }): string {
    const seq = this.suggestionFiles().length + 1
    // Zero-pad the sequence so lexical filename sort matches numeric order (round 10 must not sort
    // before round 2). loadLatestSuggestion relies on this ordering.
    const id = `round_suggestion:${this.sessionID}:${String(seq).padStart(6, "0")}`
    writeJson(path.join(this.session.suggestionsDir, `${safeFileID(id)}.json`), {
      schema_version: "deepagent-code.round_suggestion.v1",
      id,
      created_at: new Date().toISOString(),
      status: suggestion.status,
      body: suggestion.body,
    })
    return id
  }

  private suggestionFiles(): string[] {
    return readdirSync(this.session.suggestionsDir)
      .filter((f) => f.startsWith("round_suggestion") && f.endsWith(".json"))
      .sort()
  }

  loadLatestSuggestion(): { status: string; body: string } | null {
    const files = this.suggestionFiles()
    if (files.length === 0) return null
    const loaded = readJson<{ status: string; body: string }>(
      path.join(this.session.suggestionsDir, files[files.length - 1]!),
    )
    return { status: loaded.status, body: loaded.body }
  }

  // A4 macro-round: persist the structured round report (model declarations + runner ground truth
  // + reconciliation) next to the suggestion that derived from it, so the dual-provenance
  // reconciliation contract is auditable after the run. Sequenced to match the suggestion order.
  saveRoundReport(report: { round: number } & Record<string, unknown>): string {
    const seq =
      readdirSync(this.session.suggestionsDir).filter((f) => f.startsWith("round_report_") && f.endsWith(".json"))
        .length + 1
    const id = `round_report_${String(seq).padStart(6, "0")}`
    writeJson(path.join(this.session.suggestionsDir, `${id}.json`), report)
    return id
  }

  confirm(draftID: string, editedGoal?: string): AgentPromptDraft {
    const draft = this.getDraft(draftID)
    if (!draft) throw new Error(`unknown prompt draft: ${draftID}`)
    const confirmed: AgentPromptDraft = {
      ...draft,
      state: "confirmed",
      goal: editedGoal ?? draft.goal,
      confirmed_at: new Date().toISOString(),
    }
    writeJson(path.join(this.session.confirmedDir, `${safeFileID(draftID)}.json`), confirmed)
    writeJson(path.join(this.session.draftsDir, `${safeFileID(draftID)}.json`), confirmed)
    return confirmed
  }

  submitConfirmed(draftID: string): SubmitResult {
    const draft = this.getDraft(draftID)
    if (!draft || draft.state !== "confirmed") throw new Error("TaskThread requires a confirmed prompt draft")
    const plan = this.getContextPlan(draft.context_plan_id)
    if (!plan) throw new Error(`missing context plan: ${draft.context_plan_id}`)
    const submitted: AgentPromptDraft = { ...draft, state: "task_submitted", submitted_at: new Date().toISOString() }
    writeJson(path.join(this.session.confirmedDir, `${safeFileID(draftID)}.json`), submitted)
    return {
      prompt_draft_id: draft.id,
      context_plan_id: plan.id,
      memory_snapshot_id: plan.memory_snapshot_id,
      skill_snapshot_id: plan.skill_snapshot_id,
      task_prompt: draft.goal,
    }
  }

  directOverride(rawInput: string): SubmitResult {
    const rawRef = this.appendRawInput(rawInput)
    const seq = this.nextSequence()
    const draftID = `prompt_draft:${this.sessionID}:${seq}`
    const planID = `context_plan:${this.sessionID}:${seq}`
    const plan = buildContextPlan(planID, rawInput, [], [], [], false)
    const draft: AgentPromptDraft = {
      schema_version: PROMPT_DRAFT_SCHEMA_VERSION,
      id: draftID,
      mode: "direct_override",
      state: "task_submitted",
      raw_input_ref: rawRef,
      goal: rawInput,
      task_type: classifyTask(rawInput),
      constraints: [],
      acceptance: [],
      assumptions: [],
      source_blocks: [{ label: "User input", source_label: "user_input", ref: rawRef, admitted: true }],
      selected_skills: [],
      context_plan_id: planID,
      confirmed_at: new Date().toISOString(),
      submitted_at: new Date().toISOString(),
    }
    this.saveDraft(draft, plan)
    writeJson(path.join(this.session.confirmedDir, `${safeFileID(draftID)}.json`), draft)
    return {
      prompt_draft_id: draftID,
      context_plan_id: planID,
      memory_snapshot_id: plan.memory_snapshot_id,
      skill_snapshot_id: plan.skill_snapshot_id,
      task_prompt: rawInput,
    }
  }

  private rawCount(): number {
    if (!existsSync(this.session.rawInputs)) return 0
    const content = readFileSync(this.session.rawInputs, "utf8")
    return content.split("\n").filter((line) => line.trim()).length
  }
}

export class PromptRefiner {
  constructor(private readonly store: PromptDraftStore) {}

  refine(input: RefineInput): { readonly draft: AgentPromptDraft; readonly contextPlan: ContextPlan } {
    const rawRef = this.store.appendRawInput(input.rawInput)
    const seq = this.store.nextSequence()
    const sid = this.store.sessionID
    const draftID = `prompt_draft:${sid}:${seq}`
    const planID = `context_plan:${sid}:${seq}`
    const admittedRefs = (input.projectMemory ?? [])
      .filter((hit) => hit.decision === "inject_summary")
      .map((hit) => hit.id)
    const suggestedRefs = (input.projectMemory ?? [])
      .filter((hit) => hit.decision === "match_only")
      .map((hit) => hit.id)
      .concat(input.selectedSkills ?? [])
    const deniedRefs = (input.projectMemory ?? []).filter((hit) => hit.decision === "blocked").map((hit) => hit.id)
    const incomplete = Boolean(input.timeoutMs && input.startedAt && Date.now() - input.startedAt > input.timeoutMs)
    const plan = buildContextPlan(planID, input.rawInput, admittedRefs, suggestedRefs, deniedRefs, incomplete)
    const draft: AgentPromptDraft = {
      schema_version: PROMPT_DRAFT_SCHEMA_VERSION,
      id: draftID,
      mode: input.mode ?? "intelligence",
      state: "draft_ready",
      raw_input_ref: rawRef,
      goal: summarizeGoal(input.rawInput),
      task_type: classifyTask(input.rawInput),
      constraints: inferConstraints(input.rawInput),
      acceptance: inferAcceptance(input.rawInput),
      assumptions: [
        {
          text: "Confirm the refined task before execution.",
          status: "pending_confirmation",
          source: "system_inference",
        },
      ],
      source_blocks: [
        { label: "User input", source_label: "user_input", ref: rawRef, admitted: true },
        ...(input.projectMemory ?? []).map(
          (hit): SourceBlock => ({
            label: "Project memory",
            source_label: "project_memory",
            ref: hit.id,
            admitted: hit.decision === "inject_summary",
          }),
        ),
        ...(input.handoffRefs ?? []).map(
          (ref): SourceBlock => ({ label: "Handoff", source_label: "handoff", ref, admitted: true }),
        ),
      ],
      selected_skills: input.selectedSkills ?? [],
      context_plan_id: planID,
      confirmed_at: null,
    }
    this.store.saveDraft(draft, plan)
    return { draft, contextPlan: plan }
  }
}

// --- A2: model-driven intelligence refinement -------------------------------------------------------
//
// `intelligence` must call the user-specified model to turn a raw need into a COMPLETE, directly
// executable agent prompt: the model understands intent and fills gaps so the executing agent
// does not have to re-interpret the raw request. Two hard rules:
//   1. It must NOT rewrite the user's core goal.
//   2. Every inference the model adds while completing intent must be surfaced as an explicit,
//      visible assumption (not buried in prose) so the human can see and correct it before send.
// There is NO content template — only this structured OUTPUT shape the model fills. The prompt
// body is free-form prose; the structure exists so assumptions stay visible and machine-listable.

export type IntelligenceRefinementOutput = {
  // `general` means the request is conversational/non-code and should bypass DeepAgent runtime.
  readonly route: IntelligenceRoute
  // The complete, directly-executable prompt for the executing agent. Free-form prose.
  readonly refined_prompt: string
  // A faithful restatement of the user's core goal. Must not change user intent.
  readonly goal: string
  readonly task_type: TaskType
  readonly constraints: readonly string[]
  readonly acceptance: readonly string[]
  // Each inference the model made while completing intent, shown to the user for review.
  readonly assumptions: readonly string[]
}

export type IntelligenceRefinementOutputLanguage = "chinese" | "english"

// The single, code-task-generic system prompt for first-turn intelligence refinement. Not domain-specific.
export const INTELLIGENCE_REFINEMENT_SYSTEM_PROMPT = [
  "You classify and prepare a raw user request for DeepAgent Code.",
  "Goals:",
  "- First decide whether the request is a meaningful coding task.",
  "- If it is a normal conversation, identity question, writing/chat request, or otherwise not a",
  "  coding task, set `route` to `general`. The main model will answer directly in general mode.",
  "- If it is a coding task, set `route` to `code` and prepare it for the coding agent.",
  "- Refine ONLY the task description itself: clarify wording, structure it, and remove ambiguity.",
  "- Produce `refined_prompt` as a clear, well-structured instruction in the requested output language.",
  "Hard rules:",
  "- Do NOT change the user's core goal. Clarify and structure only; do not expand scope.",
  "- A conversation context block may be provided. Treat anything stated there (target directory,",
  "  paths, prior decisions, environment) as ALREADY KNOWN — use it directly and do NOT list it as",
  "  an assumption.",
  "- Do NOT decide the user's environment for them: never invent a working directory, file path,",
  "  branch, framework, version, or similar unless the user or the context stated it.",
  "- When a detail is genuinely missing and cannot be derived from the request or the context, do",
  "  NOT guess a concrete value. Leave it for the user: insert an explicit placeholder in",
  "  `refined_prompt` (e.g. `<待用户填写: 目标目录>` / `<TODO: target directory>`) and add a single",
  "  'needs user confirmation' note in `assumptions` describing what is missing.",
  "- `assumptions` must be few and meaningful — only inferences that materially affect understanding",
  "  of the task AND cannot be read from the context. Do not pad it with environment guesses.",
  "Output format:",
  "- Respond with a single JSON object and nothing else — no prose, no explanation before or after.",
  "- Keys: route ('code'|'general'), refined_prompt (string), goal (string),",
  "  task_type ('implementation'|'review'|'test'|'research'|'document'|'unknown'),",
  "  constraints (string[]), acceptance (string[]), assumptions (string[]).",
  "- Use [] for any array you cannot fill. refined_prompt is always required.",
  "- A fenced ```json block is acceptable, but raw JSON is preferred.",
].join("\n")

export const intelligenceRefinementSystemPrompt = (outputLanguage: IntelligenceRefinementOutputLanguage = "english") =>
  [
    INTELLIGENCE_REFINEMENT_SYSTEM_PROMPT,
    outputLanguage === "chinese"
      ? "Output language: generate `refined_prompt`, `goal`, `constraints`, `acceptance`, and `assumptions` in Chinese."
      : "Output language: generate `refined_prompt`, `goal`, `constraints`, `acceptance`, and `assumptions` in English.",
  ].join("\n")

export type IntelligenceContextTurn = { readonly role: "user" | "assistant"; readonly text: string }

// Build the compact conversation-context block fed to intelligence refinement. It lets the refiner reuse
// what the user already established (target directory, paths, prior decisions) instead of guessing
// and emitting misleading assumptions. Pure + dependency-free so it can be unit tested in core and
// shared by the session layer. Returns "" when there is no usable prior context (first turn), in
// which case the caller should omit the context message entirely.
export const buildIntelligenceContextBriefing = (
  turns: ReadonlyArray<IntelligenceContextTurn>,
  options: { maxTurns?: number; maxCharsPerTurn?: number } = {},
): string => {
  const maxTurns = options.maxTurns ?? 6
  const maxChars = options.maxCharsPerTurn ?? 500
  const cleaned = turns
    .map((turn) => ({ role: turn.role, text: turn.text.trim() }))
    .filter((turn) => turn.text.length > 0)
    .slice(-maxTurns)
  if (cleaned.length === 0) return ""
  return cleaned
    .map((turn) => {
      const label = turn.role === "user" ? "User" : "Assistant"
      const body = turn.text.length > maxChars ? turn.text.slice(0, maxChars) + "…" : turn.text
      return `${label}: ${body}`
    })
    .join("\n")
}

// The user message wrapper that carries the context briefing into the refiner. Kept here so the
// exact instruction (use context, don't re-guess established facts) lives next to the system prompt.
export const intelligenceContextMessage = (briefing: string) =>
  `<conversation_context>\n${briefing}\n</conversation_context>\n\n` +
  "Refine ONLY the new request below. Use the context above as already-known facts (target " +
  "directory, paths, prior decisions) — do not restate them as assumptions and do not guess values " +
  "that contradict it."

export const INTELLIGENCE_REFINEMENT_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["route", "refined_prompt", "goal", "task_type", "constraints", "acceptance", "assumptions"],
  properties: {
    route: { type: "string", enum: ["code", "general"] },
    refined_prompt: { type: "string" },
    goal: { type: "string" },
    task_type: { type: "string", enum: ["implementation", "review", "test", "research", "document", "unknown"] },
    constraints: { type: "array", items: { type: "string" } },
    acceptance: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
  },
} as const

export const isIntelligenceRefinementOutput = (value: unknown): value is IntelligenceRefinementOutput => {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.route === "code" || v.route === "general") &&
    typeof v.refined_prompt === "string" &&
    typeof v.goal === "string" &&
    typeof v.task_type === "string" &&
    Array.isArray(v.constraints) &&
    Array.isArray(v.acceptance) &&
    Array.isArray(v.assumptions)
  )
}

const intelligenceRefinementStrings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

export const normalizeIntelligenceRefinementOutput = (value: unknown, rawInput: string): IntelligenceRefinementOutput | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.route !== "code" && v.route !== "general") return undefined
  if (typeof v.refined_prompt !== "string" || v.refined_prompt.trim().length === 0) return undefined

  return {
    route: v.route,
    refined_prompt: v.refined_prompt,
    goal: typeof v.goal === "string" && v.goal.trim().length > 0 ? v.goal : rawInput,
    task_type:
      v.task_type === "implementation" ||
      v.task_type === "review" ||
      v.task_type === "test" ||
      v.task_type === "research" ||
      v.task_type === "document"
        ? v.task_type
        : "unknown",
    constraints: intelligenceRefinementStrings(v.constraints),
    acceptance: intelligenceRefinementStrings(v.acceptance),
    assumptions: intelligenceRefinementStrings(v.assumptions),
  }
}

export class PromptRefinerModelError extends Error {}

export const classifyIntelligenceRoute = (text: string): IntelligenceRoute => {
  const lower = text.trim().toLowerCase()
  if (!lower) return "general"
  if (
    /```|\/[\w.-]+|\\[\w.-]+|\b(src|packages?|tests?|components?|api|cli|sdk|repo|git|bun|npm|pnpm|yarn|tsc|pytest|jest|vitest|eslint|typecheck)\b/.test(
      lower,
    ) ||
    /实现|修复|修改|代码|测试|仓库|文件|组件|接口|报错|构建|提交|重构|审查|评审/.test(lower)
  ) {
    return "code"
  }
  if (
    /^(hi|hello|hey|你好|您好|在吗|你是谁|who are you|what are you|介绍一下你|聊聊|谢谢|thanks)[\s!！。?？]*$/i.test(
      lower,
    )
  ) {
    return "general"
  }
  return "code"
}

const normalizeIntelligenceText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim()

export const isUsefulIntelligenceRefinement = (rawInput: string, output: IntelligenceRefinementOutput): boolean => {
  if (output.route === "general") return true
  const raw = normalizeIntelligenceText(rawInput)
  const refined = normalizeIntelligenceText(output.refined_prompt)
  if (!raw || !refined) return false
  if (refined === raw) return false
  if (raw.includes(refined)) return false
  if (refined.includes(raw) && refined.length - raw.length < 12) return false
  return true
}

// Build a draft from a model refinement result. This is the production intelligence first-turn path.
export const draftFromIntelligenceRefinement = (
  store: PromptDraftStore,
  rawInput: string,
  output: IntelligenceRefinementOutput,
): { readonly draft: AgentPromptDraft; readonly contextPlan: ContextPlan } => {
  const rawRef = store.appendRawInput(rawInput)
  const seq = store.nextSequence()
  const sid = store.sessionID
  const draftID = `prompt_draft:${sid}:${seq}`
  const planID = `context_plan:${sid}:${seq}`
  const plan = buildContextPlan(planID, output.refined_prompt, [], [], [], false)
  const taskType: TaskType =
    output.task_type === "implementation" ||
    output.task_type === "review" ||
    output.task_type === "test" ||
    output.task_type === "research" ||
    output.task_type === "document"
      ? output.task_type
      : "unknown"
  const draft: AgentPromptDraft = {
    schema_version: PROMPT_DRAFT_SCHEMA_VERSION,
    id: draftID,
    mode: "intelligence",
    state: "draft_ready",
    raw_input_ref: rawRef,
    // The submittable prompt IS the model's refined prompt; goal preserves user intent.
    goal: output.refined_prompt.trim() || output.goal.trim() || rawInput.trim(),
    task_type: taskType,
    constraints: output.constraints,
    acceptance: output.acceptance,
    // Inferences become explicit, reviewable assumptions (A2 visibility rule).
    assumptions:
      output.assumptions.length > 0
        ? output.assumptions.map((text) => ({
            text,
            status: "pending_confirmation" as const,
            source: "system_inference" as const,
          }))
        : [
            {
              text: "Confirm the refined prompt before execution.",
              status: "pending_confirmation",
              source: "system_inference",
            },
          ],
    source_blocks: [{ label: "User input", source_label: "user_input", ref: rawRef, admitted: true }],
    selected_skills: [],
    context_plan_id: planID,
    confirmed_at: null,
  }
  store.saveDraft(draft, plan)
  return { draft, contextPlan: plan }
}

const genericConfirmation = new Set([
  "Confirm the refined task before execution.",
  "Confirm the refined prompt before execution.",
])

// P2-9: the user-visible draft is scrubbed of any memory-context fences before it leaves the
// pipeline (contract: "Memory and context blocks must pass fencing/scrubber rules before any
// user-visible output"). renderDraftMarkdown is the single surface that produces the composer
// preview, so scrubbing here covers every consumer.
export const renderDraftMarkdown = (draft: AgentPromptDraft): string => {
  const assumptions = draft.assumptions.filter((item) => !genericConfirmation.has(item.text))
  const rendered = [
    draft.goal,
    ...(draft.constraints.length ? ["", "Constraints", ...draft.constraints.map((item) => `- ${item}`)] : []),
    ...(draft.acceptance.length ? ["", "Acceptance", ...draft.acceptance.map((item) => `- ${item}`)] : []),
    ...(assumptions.length ? ["", "Needs confirmation", ...assumptions.map((item) => `- ${item.text}`)] : []),
  ].join("\n")
  return scrubMemoryContext(rendered)
}

export const scrubMemoryContext = (text: string): string =>
  text
    .replace(/<memory-context>[\s\S]*?<\/memory-context>/gi, "[memory context hidden]")
    .replace(/<!--\s*memory-context[\s\S]*?-->/gi, "[memory context hidden]")

const buildContextPlan = (
  id: string,
  raw: string,
  admittedRefs: readonly string[],
  suggestedRefs: readonly string[],
  deniedRefs: readonly string[],
  incompleteContext: boolean,
): ContextPlan => ({
  schema_version: CONTEXT_PLAN_SCHEMA_VERSION,
  id,
  query: { raw, keywords: keywords(raw), domains: [] },
  topk: { project_memory: 5, user_memory: 3, skills: 5, handoff: 2 },
  memory_snapshot_id: `memsnap:${id}`,
  skill_snapshot_id: `skillsnap:${id}`,
  admitted_refs: admittedRefs,
  suggested_refs: suggestedRefs,
  denied_refs: deniedRefs,
  admission_audit: admittedRefs.map((ref) => `${ref}:admitted`).concat(deniedRefs.map((ref) => `${ref}:denied`)),
  estimated_prompt_tokens: estimateTokens(raw),
  incomplete_context: incompleteContext,
})

const summarizeGoal = (raw: string): string => raw.trim().split(/\n+/)[0]?.slice(0, 160) || "Untitled task"
const inferConstraints = (raw: string): string[] =>
  /不要|do not|must not/i.test(raw) ? ["Preserve explicit negative constraints from raw input"] : []
const inferAcceptance = (raw: string): string[] =>
  /测试|test|验证|typecheck/i.test(raw) ? ["Run the relevant validation command"] : []
const sessionID = (session: SessionPaths): string =>
  JSON.parse(readFileSync(session.sessionJson, "utf8")).session_id as string
