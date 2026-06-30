import { analyzeErrors, type ErrorPattern } from "./diagnosis"
import type { ValidationResult } from "./round-state"

/**
 * T2 (S1-v3.4): failure triage — the "fixability × progress" three-light classifier.
 *
 * This runs BEFORE the round-backoff in `determineAction`. Where determineAction only looks at
 * category-repeat + round-count, the triage adds the missing axes: the category's NATURE
 * (fixable code error vs unfixable environment problem), the process exit code, and whether the
 * model actually changed a file this round. The microbatch loop (deepagent-code) assembles the
 * inputs — some live in core (category/previousDiagnoses), some are loop-local (changedThisRound /
 * stagnantRounds / prevFailedCount) — and routes by the returned tier.
 *
 * Priority is RED > YELLOW > GREEN: fixability dominates pure round backoff. RED never burns the
 * round budget (it exits immediately with a reason); GREEN/YELLOW consume rounds (YELLOW tightened).
 */

export type FailureTier = "auto_fixable" | "needs_narrowing" | "not_auto_fixable"

// stall = fingerprint unchanged; oscillation = category flips, count flat; half_progress = count
// dropping; regression = count rising or category got strictly harder.
export type YellowSubstate = "stall" | "oscillation" | "half_progress" | "regression"

export type TriageInput = {
  readonly failed: readonly ValidationResult[] // failed validations this round (carry exit_code, T1)
  readonly changedThisRound: boolean // T1: did the model actually change a file this round?
  readonly round: number
  readonly previousCategory: string | null // root_cause_category of the PREVIOUS round (for flips)
  readonly prevFailedCount?: number // previous round's failed count (half_progress / regression)
  readonly stagnant: boolean // loop-local: fingerprint unchanged this round (stall)
  readonly errorOutput: string | null
}

export type TriageResult = {
  readonly tier: FailureTier
  readonly substate?: YellowSubstate
  readonly category: string | null // the dominant category this round (surfaced for the loop)
  readonly reason: string // human-readable; flows into needs_human body / fold label
}

// Exit codes that indicate the command/environment, not the code, failed.
//  127 = command not found, 126 = not executable, 124 = timeout (GNU coreutils convention).
const ENV_EXIT_CODES = new Set([124, 126, 127])
// 128 + signal: 137 = SIGKILL (OOM), 139 = SIGSEGV, 134 = SIGABRT — when these come from the
// toolchain itself they are environment crashes, not user-code assertions.
const SIGNAL_EXIT_CODES = new Set([134, 137, 139])

// Output signatures of environment / dependency / network / resource problems (not fixable by editing code).
const ENV_OUTPUT =
  /Cannot find module|ENOENT|ECONNREFUSED|ENOSPC|EACCES|permission denied|command not found|No such file or directory|ETIMEDOUT|EADDRINUSE/i

// How "hard" a category is, for regression detection (a flip to a harder category is a regression).
const CATEGORY_HARDNESS: Record<string, number> = {
  lint_error: 1,
  type_error: 2,
  test_failure: 2,
  build_error: 3,
  runtime_error: 3,
  unknown: 4,
}

const FIXABLE_CATEGORIES = new Set(["type_error", "lint_error", "build_error", "test_failure"])

const dominantCategory = (patterns: ErrorPattern[]): string | null => {
  if (patterns.length === 0) return null
  return [...patterns].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))[0]!.category
}

const hasEnvExitCode = (failed: readonly ValidationResult[]): number | undefined =>
  failed.find((f) => ENV_EXIT_CODES.has(f.exit_code) || SIGNAL_EXIT_CODES.has(f.exit_code))?.exit_code

/**
 * Classify a failing round into a tier (+ yellow substate). Pure function; all signals are passed in.
 * Substate precedence within yellow: stall → regression → oscillation → half_progress (catch the most
 * severe progress anomaly first).
 */
export const classifyFailure = (input: TriageInput): TriageResult => {
  const patterns = analyzeErrors(input.failed, input.errorOutput)
  const category = dominantCategory(patterns)
  const combined = [...input.failed.map((f) => f.output), input.errorOutput ?? ""].join("\n")

  // ── 🔴 RED: not auto-fixable (any one hit → immediate exit, no budget burn) ──
  const envExit = hasEnvExitCode(input.failed)
  if (envExit !== undefined) {
    return {
      tier: "not_auto_fixable",
      category,
      reason: `command/environment failure (exit ${envExit}) — not auto-fixable`,
    }
  }
  if (ENV_OUTPUT.test(combined)) {
    const match = combined.match(ENV_OUTPUT)
    return {
      tier: "not_auto_fixable",
      category,
      reason: `environment/dependency signal "${match?.[0]}" — not auto-fixable`,
    }
  }
  // An unknown failure (no locatable code-error signature) is red ONLY when the model did NOT change
  // a file this round. With no edit AND no recognizable signal, repeated failure looks like the
  // environment, not the code. But an unknown failure WHILE the model is actively editing is a
  // fixable-in-progress check (e.g. a bare shell assertion) — that stays in the yellow/green path,
  // it must not be force-escalated. (Mirrors the runtime_error rule below.)
  if ((category === "unknown" || category === null) && !input.changedThisRound) {
    return {
      tier: "not_auto_fixable",
      category,
      reason: "no locatable code-error signature and no file change — suspected environment, not auto-fixable",
    }
  }
  // runtime_error that recurs WITHOUT a file change this round looks like an environment issue, not code.
  if (category === "runtime_error" && !input.changedThisRound) {
    return {
      tier: "not_auto_fixable",
      category,
      reason: "runtime error persists with no file change this round — suspected environment, not code",
    }
  }

  // ── 🟡 YELLOW: fixable category but progress is anomalous ──
  const failedCount = input.failed.length
  const prev = input.prevFailedCount

  // stall: fingerprint unchanged.
  if (input.stagnant) {
    return {
      tier: "needs_narrowing",
      substate: "stall",
      category,
      reason: "no progress (output + diff unchanged) — narrowing once before escalation",
    }
  }
  // regression: failures grew, or category got strictly harder than the previous round.
  const harderThanPrev =
    input.previousCategory != null &&
    category != null &&
    (CATEGORY_HARDNESS[category] ?? 0) > (CATEGORY_HARDNESS[input.previousCategory] ?? 0)
  if ((prev !== undefined && failedCount > prev) || harderThanPrev) {
    return {
      tier: "needs_narrowing",
      substate: "regression",
      category,
      reason: "failures increased or the error class got harder — restore best and narrow hard",
    }
  }
  // oscillation: category flipped between rounds while the count did not drop.
  if (
    input.previousCategory != null &&
    category !== input.previousCategory &&
    (prev === undefined || failedCount >= prev)
  ) {
    return {
      tier: "needs_narrowing",
      substate: "oscillation",
      category,
      reason: "error class is flipping round-to-round — stabilize, do not widen the change",
    }
  }
  // half_progress: failures dropping but not yet zero.
  if (prev !== undefined && failedCount < prev && failedCount > 0) {
    return {
      tier: "needs_narrowing",
      substate: "half_progress",
      category,
      reason: "failures decreasing but not yet clear — continue with a tightened budget",
    }
  }

  // ── 🟢 GREEN: fixable category + real progress ──
  if (category !== null && FIXABLE_CATEGORIES.has(category) && input.changedThisRound) {
    return {
      tier: "auto_fixable",
      category,
      reason:
        input.round <= 1 ? "fixable error, first attempt — revise" : "fixable error — revise with prior diagnosis",
    }
  }

  // Fall-through. Two distinct cases, kept honest (M4 fix — don't hardcode "stall + no file change"):
  //  - The model DID change a file this round but the category isn't in the green set (unknown/
  //    runtime_error while actively editing, already cleared the red gate above): treat as a
  //    productive-but-unverified revise (half_progress), NOT a stall — it must not consume the
  //    narrow budget as if nothing happened.
  //  - The model changed nothing and it isn't a recognized yellow pattern: a genuine stall.
  if (input.changedThisRound) {
    return {
      tier: "needs_narrowing",
      substate: "half_progress",
      category,
      reason: "edited this round but the failure is not a recognized fixable class — continue with a tightened budget",
    }
  }
  return {
    tier: "needs_narrowing",
    substate: "stall",
    category,
    reason: "no file change this round and no recognized progress — narrowing before escalation",
  }
}

export * as FailureTriage from "./failure-triage"
