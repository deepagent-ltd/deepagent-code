// V3.9 mode redesign (P2b) — the DESIGN-mode plan source. In `design` mode the HUMAN authors the goal
// and plan in `.deepagent-code/plans/goal+plan.md`; the agent does NOT regenerate it. This module turns
// that human-authored markdown into the same PlanDoc the Goal Loop grades, so the loop can execute the
// user's plan faithfully (in `loop` mode the agent instead writes the file / session-state plan itself).
//
// This parser is PURE: it takes the file CONTENTS as a string and returns a `ParsedGoalPlan | null`. No
// fs, no Effect — so it is trivially unit-testable and the fs read lives at the wiring seam (goal-manager).
// It NEVER throws: a missing/empty/malformed document yields `null` and the caller falls back to the next
// plan source.
//
// ── Canonical markdown format ──────────────────────────────────────────────────────────────────────
// The file has three sections, keyed by markdown headings (heading level is ignored; aliases accepted):
//
//   ## Goal            (aliases: Objective, Goal + Plan title line)
//   A one-or-more-line statement of the objective — the decidable finish line.
//
//   ## Criteria        (optional; aliases: Completion Criteria, Done when)
//   A bullet list of completion criteria, each line mapped to a structured CompletionCriterion:
//     - `tests pass: \`bun test\``           → { kind: "tests_pass", commands: ["bun test"] }
//     - `no diagnostics above warning`       → { kind: "no_diagnostics", severityAtMost: "warning" }
//     - `reviewer clean`                     → { kind: "reviewer_clean", maxSeverity: "high" }
//     - `panel approves`                     → { kind: "panel_approves" }
//     - `plan complete` / `all steps done`   → { kind: "plan_complete" }
//   Unrecognized lines are ignored. A missing/empty section → no criteria (caller applies its default).
//
//   ## Plan            (aliases: Steps, Plan Steps)
//   An ordered checklist of plan steps. Each `- [ ] Title` line becomes a PlanStep; the checkbox mark
//   sets the initial status (mirrors plan-controller's STATUS_MARK):
//     - `- [ ] …`  pending   |  `- [x] …` done  |  `- [>] …` active
//     - `- [-] …`  cancelled |  `- [!] …` blocked
//   A plain `- Title` bullet (no checkbox) is treated as pending. An `acceptance:`-suffixed tail
//   (` — acceptance: …` or ` (acceptance: …)`) is captured as the step's acceptance criterion.
//
// A document with no objective OR no plan steps is not a runnable goal → returns null.
import { createPlanDoc, type PlanDoc, type PlanStep, type PlanStepStatus } from "./plan-controller"
import type { CompletionCriterion } from "./goal-loop"

/** The canonical repo-relative path of the human-authored goal+plan file (design mode) / loop-mode output. */
export const GOAL_PLAN_FILE = ".deepagent-code/plans/goal+plan.md"

/** The result of parsing a goal+plan.md: the PlanDoc the loop grades + any human-declared criteria. */
export type ParsedGoalPlan = {
  readonly plan: PlanDoc
  /** Completion criteria declared in the file. Empty when the file has no `## Criteria` section. */
  readonly criteria: readonly CompletionCriterion[]
}

type Section = "goal" | "criteria" | "plan" | null

// Classify a heading line into one of the known sections (heading level ignored, aliases accepted).
const classifyHeading = (heading: string): Section => {
  const h = heading.toLowerCase()
  if (/\b(goal|objective)\b/.test(h)) return "goal"
  if (/\b(criteria|done when|acceptance)\b/.test(h)) return "criteria"
  if (/\b(plan|steps)\b/.test(h)) return "plan"
  return null
}

// Map the checkbox mark to a plan step status (mirrors plan-controller STATUS_MARK).
const STATUS_BY_MARK: Record<string, PlanStepStatus> = {
  " ": "pending",
  x: "done",
  X: "done",
  ">": "active",
  "-": "cancelled",
  "!": "blocked",
}

// Parse one plan line into a PlanStep, or null when the line is not a bullet.
const parseStepLine = (line: string, index: number): PlanStep | null => {
  const bullet = line.match(/^\s*[-*]\s+(.*)$/)
  if (!bullet) return null
  let rest = bullet[1].trim()
  if (rest === "") return null

  let status: PlanStepStatus = "pending"
  const checkbox = rest.match(/^\[(.)\]\s*(.*)$/)
  if (checkbox) {
    status = STATUS_BY_MARK[checkbox[1]] ?? "pending"
    rest = checkbox[2].trim()
  }
  if (rest === "") return null

  // Capture a trailing acceptance clause: " — acceptance: …" or " (acceptance: …)".
  let acceptance: string | null = null
  const paren = rest.match(/\(acceptance:\s*([^)]*)\)\s*$/i)
  const dash = rest.match(/(?:—|--|-)\s*acceptance:\s*(.*)$/i)
  if (paren) {
    acceptance = paren[1].trim() || null
    rest = rest.slice(0, paren.index).trim()
  } else if (dash) {
    acceptance = dash[1].trim() || null
    rest = rest.slice(0, dash.index).trim()
  }
  if (rest === "") return null

  return {
    step_id: `step_${index + 1}`,
    title: rest,
    status,
    acceptance,
    assigned_agent: null,
    evidence: [],
    note: null,
  }
}

// Strip a leading bullet/checkbox from a criteria line, returning the bare text (or the raw line).
const criterionText = (line: string): string => {
  const bullet = line.match(/^\s*[-*]\s+(.*)$/)
  const body = (bullet ? bullet[1] : line).trim()
  return body.replace(/^\[.\]\s*/, "").trim()
}

// Extract shell commands from a criteria line: backtick-quoted spans, else text after a colon.
const extractCommands = (text: string): string[] => {
  const backticked = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean)
  if (backticked.length > 0) return backticked
  const colon = text.indexOf(":")
  if (colon >= 0) {
    return text
      .slice(colon + 1)
      .split(/[;,]/)
      .map((c) => c.trim())
      .filter(Boolean)
  }
  return []
}

// Map a single criteria line to a structured CompletionCriterion (or null when unrecognized).
const mapCriterion = (line: string): CompletionCriterion | null => {
  const text = criterionText(line)
  if (text === "") return null
  const l = text.toLowerCase()

  if (/\btests?\b|\bspec\b|\bsuite\b/.test(l) && !/no diagnostic|no error/.test(l)) {
    const commands = extractCommands(text)
    if (commands.length > 0) return { kind: "tests_pass", commands }
  }
  if (/no diagnostic|no error|compiles|clean build|type ?check/.test(l)) {
    const sev = l.match(/(?:above|beyond)\s+(warning|error|info|hint)/)
    return sev ? { kind: "no_diagnostics", severityAtMost: sev[1] } : { kind: "no_diagnostics" }
  }
  if (/review/.test(l)) {
    const sev = l.match(/\b(error|warning|high|medium|low)\b/)
    return { kind: "reviewer_clean", maxSeverity: sev ? sev[1] : "high" }
  }
  if (/panel/.test(l)) return { kind: "panel_approves" }
  if (/plan complete|all steps|every step|steps done/.test(l)) return { kind: "plan_complete" }
  return null
}

/**
 * Parse a human-authored `goal+plan.md` into a PlanDoc (+ any declared criteria). Pure and total: returns
 * `null` when the contents have no objective or no plan steps (not a runnable goal), never throws.
 */
export const parseGoalPlanFile = (sessionId: string, contents: string): ParsedGoalPlan | null => {
  if (typeof contents !== "string" || contents.trim() === "") return null

  const goalLines: string[] = []
  const criteriaLines: string[] = []
  const planLines: string[] = []
  let section: Section = null

  for (const raw of contents.split(/\r?\n/)) {
    const heading = raw.match(/^\s{0,3}#{1,6}\s+(.*)$/)
    if (heading) {
      section = classifyHeading(heading[1].trim())
      continue
    }
    if (section === "goal") goalLines.push(raw)
    else if (section === "criteria") criteriaLines.push(raw)
    else if (section === "plan") planLines.push(raw)
  }

  const objective = goalLines
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" ")
    .trim()
  if (objective === "") return null

  const steps: PlanStep[] = []
  for (const line of planLines) {
    const step = parseStepLine(line, steps.length)
    if (step) steps.push(step)
  }
  if (steps.length === 0) return null

  const criteria: CompletionCriterion[] = []
  const seen = new Set<string>()
  for (const line of criteriaLines) {
    const c = mapCriterion(line)
    if (!c) continue
    const key = JSON.stringify(c)
    if (seen.has(key)) continue
    seen.add(key)
    criteria.push(c)
  }

  const plan = createPlanDoc(sessionId, objective, steps)
  return { plan, criteria }
}
