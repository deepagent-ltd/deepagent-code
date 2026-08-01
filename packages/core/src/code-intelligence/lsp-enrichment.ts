export * as CodeLSPEnrichment from "./lsp-enrichment"

import { Context, Effect, Schema } from "effect"

export const Intent = Schema.Literals([
  "search",
  "definition",
  "references",
  "implementations",
  "calls_in",
  "calls_out",
  "outline",
  "diagnostics",
])
export type Intent = typeof Intent.Type

export const Observation = Schema.Struct({
  path: Schema.String,
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
  startCharacter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
  endCharacter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  symbol: Schema.String.pipe(Schema.optional),
  kind: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  detail: Schema.String.pipe(Schema.optional),
  documentVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  contentSha: Schema.String.pipe(Schema.optional),
})
export type Observation = typeof Observation.Type

export type Request = {
  readonly intent: Intent
  readonly query?: string
  readonly path?: string
  readonly line?: number
  readonly character?: number
  readonly limit: number
}

export type Result =
  | { readonly state: "ready"; readonly observations: readonly Observation[] }
  | {
      readonly state: "degraded" | "unavailable"
      readonly reasonCode: "source_timeout" | "source_error" | "lsp_unavailable"
      readonly observations: readonly Observation[]
    }

export interface Interface {
  readonly enrich: (input: Request) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/CodeLSPEnrichment") {}
