import { Schema } from "effect"

/**
 * L3 (v3.8.0 §L3) — structured result contract for multi-agent orchestration.
 *
 * These schemas define the shape a reviewer / researcher subagent must return so
 * the primary (orchestrating) agent can synthesize findings deterministically,
 * instead of scraping the subagent's last text part (`findLast(type==="text")`),
 * which is easily polluted by trailing prose or split text parts.
 *
 * The `task` tool exposes an OPTIONAL `output_schema` param. When a caller passes
 * a schema, the subagent's final turn is forced through the structured-output path
 * (a `StructuredOutput` tool call gated by `toolChoice: "required"`), which is the
 * in-session equivalent of `generateObject`. `reviewer` defaults to `ReviewResult`
 * and `researcher` to `ResearchResult`, but `output_schema` is fully general — any
 * caller may pass any of these keys.
 */

export const ReviewSeverity = Schema.Literals(["critical", "high", "medium", "low"])
export type ReviewSeverity = Schema.Schema.Type<typeof ReviewSeverity>

export const ReviewCategory = Schema.Literals([
  "correctness",
  "security",
  "edge-case",
  "convention",
  "test-gap",
  "perf",
])
export type ReviewCategory = Schema.Schema.Type<typeof ReviewCategory>

/** A single reviewer finding. `failureScenario` must be a reproducible input→wrong-output. */
export const ReviewFinding = Schema.Struct({
  severity: ReviewSeverity,
  category: ReviewCategory,
  /** Relative path to the file the finding concerns. */
  file: Schema.String,
  line: Schema.optional(Schema.Int),
  /** One-line summary of the issue. */
  summary: Schema.String,
  /** A reproducible failure scenario: the input/condition and the resulting wrong behavior. */
  failureScenario: Schema.String,
  /** Reviewer confidence in this finding, 0..1. */
  confidence: Schema.Number,
  /** Optional concrete fix suggestion. */
  suggestion: Schema.optional(Schema.String),
}).annotate({ identifier: "ReviewFinding" })
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFinding>

export const ReviewVerdict = Schema.Literals(["approve", "revise", "block"])
export type ReviewVerdict = Schema.Schema.Type<typeof ReviewVerdict>

/** The full result of a reviewer subagent turn. */
export const ReviewResult = Schema.Struct({
  findings: Schema.Array(ReviewFinding),
  verdict: ReviewVerdict,
}).annotate({ identifier: "ReviewResult" })
export type ReviewResult = Schema.Schema.Type<typeof ReviewResult>

/** A key file within a researched module, with the role it plays. */
export const ResearchKeyFile = Schema.Struct({
  path: Schema.String,
  role: Schema.String,
}).annotate({ identifier: "ResearchKeyFile" })
export type ResearchKeyFile = Schema.Schema.Type<typeof ResearchKeyFile>

/** The full result of a researcher subagent turn. */
export const ResearchResult = Schema.Struct({
  /** The sub-module / subsystem that was researched. */
  module: Schema.String,
  /** How the module works — a decidable mechanism explanation. */
  mechanism: Schema.String,
  /** Key files and the role each plays. */
  keyFiles: Schema.Array(ResearchKeyFile),
  /** Outward interfaces to the rest of the system. */
  interfaces: Schema.Array(Schema.String),
  /** Concrete risks and edge cases. */
  risks: Schema.Array(Schema.String),
  /** Questions the caller must resolve. */
  openQuestions: Schema.Array(Schema.String),
}).annotate({ identifier: "ResearchResult" })
export type ResearchResult = Schema.Schema.Type<typeof ResearchResult>

/**
 * Named orchestration schemas, keyed for the `task` tool's `output_schema` param.
 * A caller passes one of these keys to force the corresponding subagent to return
 * that shape. Callers may also pass a raw JSON Schema object directly (see
 * `resolveOutputSchema`), so this map is a convenience default, not a closed set.
 */
export const OrchestrationSchemas = {
  ReviewResult,
  ResearchResult,
  ReviewFinding,
} as const

export type OrchestrationSchemaName = keyof typeof OrchestrationSchemas

/** The natural default output schema for each native orchestration subagent. */
export const DEFAULT_OUTPUT_SCHEMA_BY_AGENT: Record<string, OrchestrationSchemaName> = {
  reviewer: "ReviewResult",
  researcher: "ResearchResult",
}

export * as Orchestration from "./orchestration"
