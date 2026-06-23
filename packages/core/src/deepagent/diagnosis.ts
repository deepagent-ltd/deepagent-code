import type { RoundDecision } from "./mode"
import type { DiagnosisRef, ValidationResult } from "./round-state"

export type DiagnosisInput = {
  readonly round: number
  readonly validationResults: readonly ValidationResult[]
  readonly previousDiagnoses: readonly DiagnosisRef[]
  readonly errorOutput: string | null
}

export type DiagnosisResult = {
  readonly diagnosis: DiagnosisRef
  readonly suggestedAction: RoundDecision
  readonly evidenceSummary: string
}

export const diagnose = (input: DiagnosisInput): DiagnosisResult => {
  const failedValidations = input.validationResults.filter((v) => !v.passed)
  const errorPatterns = analyzeErrors(failedValidations, input.errorOutput)
  const rootCause = identifyRootCause(errorPatterns)
  const rootCauseCategory = primaryCategory(errorPatterns)
  const suggestedAction = determineAction(input, rootCauseCategory)

  return {
    diagnosis: {
      round: input.round,
      root_cause: rootCause,
      root_cause_category: rootCauseCategory,
      evidence_refs: failedValidations.map((v) => `validation:${v.command}`),
      next_action: suggestedAction,
    },
    suggestedAction,
    evidenceSummary: buildEvidenceSummary(failedValidations, errorPatterns),
  }
}

// The stable category of the highest-count error pattern. Used for cross-round repeat detection
// because root_cause embeds varying counts/samples and is unreliable for equality.
const primaryCategory = (patterns: ErrorPattern[]): string | null =>
  patterns.length === 0 ? null : sortByDominance(patterns)[0]!.category

// P2-B: deterministic dominance order WITHOUT mutating the caller's array. `diagnose()` passes the
// same errorPatterns array to identifyRootCause and primaryCategory; an in-place sort in one would
// leak into the other. The category tiebreaker makes the top pick stable when counts tie, so
// root_cause and root_cause_category can never disagree on which pattern is primary.
const sortByDominance = (patterns: ErrorPattern[]): ErrorPattern[] =>
  [...patterns].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))

type ErrorPattern = {
  readonly category: "type_error" | "test_failure" | "lint_error" | "build_error" | "runtime_error" | "unknown"
  readonly count: number
  readonly sample: string
}

const analyzeErrors = (failed: readonly ValidationResult[], errorOutput: string | null): ErrorPattern[] => {
  const patterns: ErrorPattern[] = []
  const combined = [...failed.map((v) => v.output), errorOutput ?? ""].join("\n")

  if (/type\s*error|ts\(\d+\)|cannot find name|not assignable/i.test(combined)) {
    patterns.push({ category: "type_error", count: (combined.match(/error TS\d+/g) ?? []).length || 1, sample: extractSample(combined, /error TS\d+.*/i) })
  }
  if (/FAIL|✗|✘|failed|AssertionError/i.test(combined) && /test|spec|describe|it\(/i.test(combined)) {
    patterns.push({ category: "test_failure", count: (combined.match(/FAIL|✗|✘/g) ?? []).length || 1, sample: extractSample(combined, /FAIL.*/i) })
  }
  if (/eslint|prettier|lint/i.test(combined)) {
    patterns.push({ category: "lint_error", count: 1, sample: extractSample(combined, /\d+ error/i) })
  }
  if (/build failed|compilation failed|cannot resolve/i.test(combined)) {
    patterns.push({ category: "build_error", count: 1, sample: extractSample(combined, /error.*/i) })
  }
  if (/ReferenceError|TypeError|SyntaxError|RangeError/i.test(combined)) {
    patterns.push({ category: "runtime_error", count: 1, sample: extractSample(combined, /(Reference|Type|Syntax|Range)Error.*/i) })
  }
  if (patterns.length === 0 && failed.length > 0) {
    patterns.push({ category: "unknown", count: failed.length, sample: failed[0]?.output.slice(0, 200) ?? "" })
  }
  return patterns
}

const extractSample = (text: string, pattern: RegExp): string => {
  const match = text.match(pattern)
  return match ? match[0].slice(0, 200) : ""
}

const identifyRootCause = (patterns: ErrorPattern[]): string | null => {
  if (patterns.length === 0) return null
  // P2-B: sort a copy with the same dominance order primaryCategory uses, so root_cause and
  // root_cause_category always describe the same primary pattern (and the caller's array is intact).
  const primary = sortByDominance(patterns)[0]!
  switch (primary.category) {
    case "type_error":
      return `Type errors (${primary.count} occurrences): ${primary.sample}`
    case "test_failure":
      return `Test failures (${primary.count}): ${primary.sample}`
    case "lint_error":
      return `Lint errors: ${primary.sample}`
    case "build_error":
      return `Build failure: ${primary.sample}`
    case "runtime_error":
      return `Runtime error: ${primary.sample}`
    case "unknown":
      return `Validation failed: ${primary.sample}`
  }
}

const determineAction = (input: DiagnosisInput, rootCauseCategory: string | null): RoundDecision => {
  if (!rootCauseCategory) return "escalate"
  if (input.previousDiagnoses.length >= 2) {
    // Compare on the stable category, not the human-readable root_cause string (which embeds
    // counts/samples that vary per round and would make repeats almost never match).
    const sameRoot = input.previousDiagnoses.filter(
      (d) => (d.root_cause_category ?? d.root_cause) === rootCauseCategory,
    )
    if (sameRoot.length >= 2) return "rollback"
  }
  if (input.previousDiagnoses.length >= 3) return "escalate"
  return "revise"
}

const buildEvidenceSummary = (failed: readonly ValidationResult[], patterns: ErrorPattern[]): string => {
  const lines: string[] = []
  lines.push(`Failed validations: ${failed.length}`)
  for (const p of patterns) {
    lines.push(`- ${p.category}: ${p.count} occurrence(s)`)
  }
  return lines.join("\n")
}
