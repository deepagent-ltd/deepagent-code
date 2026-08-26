export * as ContextFederationContract from "./contract"

import { Schema } from "effect"

export const Version = {
  contextRefToken: 1,
  cursor: 1,
  artifactRefToken: 1,
  graphStatus: 1,
  projection: 1,
  ranking: 1,
  codeIntel: 2,
  contextQuery: 1,
} as const

export const GraphKind = Schema.Literals(["code", "knowledge", "memory", "documents"])
export type GraphKind = typeof GraphKind.Type

export const CodeIntelIntent = Schema.Literals([
  "search",
  "overview",
  "definition",
  "references",
  "implementations",
  "calls_in",
  "calls_out",
  "dependencies",
  "dependents",
  "outline",
  "diagnostics",
])
export type CodeIntelIntent = typeof CodeIntelIntent.Type

export const CodeIntelInput = Schema.Struct({
  intent: CodeIntelIntent,
  query: Schema.String.pipe(Schema.optional),
  symbol: Schema.String.pipe(Schema.optional),
  file: Schema.String.pipe(Schema.optional),
  kind: Schema.Literals(["file", "module", "package", "class", "interface", "type", "function", "method"]).pipe(
    Schema.optional,
  ),
  depth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })).pipe(Schema.optional),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(Schema.optional),
  consistency: Schema.Literals(["stale_ok", "fresh"]).pipe(Schema.optional),
  cursor: Schema.String.pipe(Schema.optional),
})
export type CodeIntelInput = typeof CodeIntelInput.Type
export const decodeCodeIntelInput = Schema.decodeUnknownSync(CodeIntelInput, { onExcessProperty: "error" })

export const ContextQueryIntent = Schema.Literals([
  "search",
  "recall",
  "related",
  "trace_evidence",
  "explain_decision",
  "find_conflicts",
])
export type ContextQueryIntent = typeof ContextQueryIntent.Type

export const ContextQueryInput = Schema.Struct({
  intent: ContextQueryIntent,
  query: Schema.String.pipe(Schema.optional),
  sources: Schema.Array(GraphKind).pipe(Schema.optional),
  ref: Schema.String.pipe(Schema.optional),
  relation: Schema.String.pipe(Schema.optional),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(Schema.optional),
  consistency: Schema.Literals(["stale_ok", "fresh"]).pipe(Schema.optional),
  cursor: Schema.String.pipe(Schema.optional),
})
export type ContextQueryInput = typeof ContextQueryInput.Type
export const decodeContextQueryInput = Schema.decodeUnknownSync(ContextQueryInput, { onExcessProperty: "error" })

export const Tool = {
  codeIntel: { id: "code_intel", schemaVersion: Version.codeIntel, input: CodeIntelInput },
  contextQuery: { id: "context_query", schemaVersion: Version.contextQuery, input: ContextQueryInput },
} as const

export const ProviderProtocol = Schema.Literals([
  "openai-responses",
  "openai-compatible-chat",
  "anthropic-messages",
  "gemini",
  "bedrock-converse",
])
export type ProviderProtocol = typeof ProviderProtocol.Type
