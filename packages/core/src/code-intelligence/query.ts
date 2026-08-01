export * as CodeQuery from "./query"

import { Context, Effect, Schema } from "effect"
import type { EgressPolicy, Principal } from "../context-federation/authorization"
import type { CodeIntelIntent } from "../context-federation/contract"
import type { GraphQueryReasonCode, GraphQueryStatus } from "../context-federation/federation"
import type { ContextRef } from "../context-federation/reference"
import type { CodeGraph, IndexStatus } from "./code-graph"

export type Request = {
  readonly intent: CodeIntelIntent
  readonly query?: string
  readonly symbol?: string
  readonly file?: string
  readonly depth?: number
  readonly limit: number
  readonly consistency: "stale_ok" | "fresh"
  readonly principal: Principal
  readonly egress: EgressPolicy
  readonly sessionId: string
}

export type Hit = {
  readonly ref: ContextRef
  readonly file: string
  readonly startLine?: number
  readonly endLine?: number
  readonly symbol?: string
  readonly kind?: string
  readonly relation?: string
  readonly direction?: "incoming" | "outgoing"
  readonly degree?: CodeGraph.Degree
  readonly snippet?: string
  readonly sources: readonly ("graph" | "lsp" | "editor_buffer" | "filesystem")[]
  readonly score?: number
  readonly contentSha?: string
  readonly documentVersion?: number
  readonly editorOverlay: "ready" | "unavailable" | "not_applicable"
}

export type Result = {
  readonly index: IndexStatus & { readonly stale: boolean }
  readonly status: GraphQueryStatus
  readonly consistency: "stale_ok" | "fresh"
  readonly freshnessSatisfied: boolean
  readonly enrichment: {
    readonly lsp: "ready" | "partial" | "unavailable" | "not_applicable"
    readonly editorOverlay: "ready" | "unavailable" | "not_applicable"
    readonly reasonCode?: GraphQueryReasonCode
  }
  readonly hits: readonly Hit[]
  readonly truncated: boolean
  readonly fallback?: { readonly from: "graph" | "lsp"; readonly reasonCode: GraphQueryReasonCode }
}

export class InvalidQueryError extends Schema.TaggedErrorClass<InvalidQueryError>()("CodeQuery.InvalidQueryError", {
  reason: Schema.String,
}) {}

export interface Interface {
  readonly query: (input: Request) => Effect.Effect<Result, InvalidQueryError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/CodeQuery") {}
