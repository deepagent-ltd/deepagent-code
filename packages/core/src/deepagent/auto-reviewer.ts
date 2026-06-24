// V3.2 auto-review rules engine (docs/39 §5). Classifies a knowledge candidate into one of three
// review paths without any model call: auto-approve (rules only), blank-thread reviewer (model in
// isolation), or human review (Review UI). The goal is to eliminate human review for the vast
// majority of safe, scoped candidates so engineers can focus their limited attention on the few
// items that genuinely require human judgment.
//
// Design principle: trust the model; humans review only what is irreversible, high-risk, or
// out-of-scope for automated judgement.

export type AutoReviewPath =
  | { path: "auto_approve"; reason: string }
  | { path: "blank_thread"; reason: string }
  | { path: "human_review"; reason: string }

export type ReviewableDoc = {
  readonly scope: "project-shared" | "user-global" | "session-private"
  readonly memory_kind?: string // context_memory | project_fact | global_fact | skill | strategy | ...
  readonly type: string // DocumentStore doc type: memory | skill | strategy | methodology | knowledge | ...
  readonly sensitivity: string // public | source_code | pii | secret_adjacent | secret
  readonly approval_risk?: string // low | medium | high | regulated
  readonly body?: string
  readonly evidence_strength?: string // strong | medium | weak | none
}

export type AutoApproveConfig = {
  // Beta defaults: project-scoped low-risk auto-approved; global fact requires blank-thread.
  readonly project_scoped_low_risk: boolean // default true
  readonly blank_thread_review: boolean // default true — model reviews medium-risk
  readonly global_fact_auto_approve: boolean // default false
  readonly strategy_auto_approve: boolean // default false
  readonly sensitive_auto_approve: boolean // default false
}

export const DEFAULT_CONFIG: AutoApproveConfig = {
  project_scoped_low_risk: true,
  blank_thread_review: true,
  global_fact_auto_approve: false,
  strategy_auto_approve: false,
  sensitive_auto_approve: false,
}

// Types that must always go through human review (docs/39 §5.5).
const HUMAN_ONLY_TYPES = new Set(["strategy", "methodology"])
const HUMAN_ONLY_SENSITIVITY = new Set(["pii", "secret_adjacent", "secret"])
const HUMAN_ONLY_RISK = new Set(["high", "regulated"])

// Types eligible for auto-approve when project-scoped + low-risk (docs/39 §5.3).
const AUTO_APPROVABLE_KINDS = new Set([
  "context_memory",
  "project_fact",
  "skill",
  "failure_dossier",
  "memory",     // DocumentStore type alias
])

const STRONG_EVIDENCE = new Set(["strong", "medium"])
const MAX_AUTO_BODY_CHARS = 500

export const classifyReview = (doc: ReviewableDoc, config: AutoApproveConfig = DEFAULT_CONFIG): AutoReviewPath => {
  // 1. Hard blocks — always human review regardless of config.
  if (HUMAN_ONLY_TYPES.has(doc.type) || HUMAN_ONLY_TYPES.has(doc.memory_kind ?? "")) {
    return { path: "human_review", reason: "strategy/methodology requires human approval" }
  }
  if (HUMAN_ONLY_SENSITIVITY.has(doc.sensitivity)) {
    return { path: "human_review", reason: `sensitivity=${doc.sensitivity} blocks auto-approve` }
  }
  if (HUMAN_ONLY_RISK.has(doc.approval_risk ?? "")) {
    return { path: "human_review", reason: `approval_risk=${doc.approval_risk} requires human` }
  }

  const isProjectScoped = doc.scope === "project-shared"
  const isLowRisk = !doc.approval_risk || doc.approval_risk === "low"
  const hasEvidence = STRONG_EVIDENCE.has(doc.evidence_strength ?? "")
  const shortBody = !doc.body || doc.body.length <= MAX_AUTO_BODY_CHARS
  const isAutoKind = AUTO_APPROVABLE_KINDS.has(doc.type) || AUTO_APPROVABLE_KINDS.has(doc.memory_kind ?? "")

  // 2. Project-scoped low-risk — auto-approve when all conditions met (docs/39 §5.3).
  if (config.project_scoped_low_risk && isProjectScoped && isLowRisk && hasEvidence && shortBody && isAutoKind) {
    return { path: "auto_approve", reason: "project-scoped low-risk with strong evidence" }
  }

  // 3. Global fact with explicit config opt-in.
  if (doc.scope === "user-global" && doc.memory_kind === "global_fact" && config.global_fact_auto_approve) {
    return { path: "auto_approve", reason: "global_fact auto-approve enabled by config" }
  }

  // 4. Everything else goes to blank-thread model reviewer if configured (docs/39 §5.4).
  if (config.blank_thread_review) {
    return { path: "blank_thread", reason: "medium-risk or global scope: blank-thread model review" }
  }

  // 5. No automated reviewer configured — escalate to human.
  return { path: "human_review", reason: "no automated reviewer configured" }
}
