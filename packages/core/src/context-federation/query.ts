export * as FederatedContextQuery from "./query"

import { Context, Effect, Schema } from "effect"
import type { EgressPolicy, Principal } from "./authorization"
import type { ContextQueryIntent, GraphKind } from "./contract"
import type { GraphQueryStatus } from "./federation"
import type { Relation } from "./link-store"
import type { ContextRef } from "./reference"
import { DeepAgentReleasedSnapshot } from "../deepagent/released-snapshot"

export type Request = {
  readonly intent: ContextQueryIntent
  readonly query?: string
  readonly sources?: readonly GraphKind[]
  readonly ref?: ContextRef
  readonly relation?: Relation
  readonly limit: number
  readonly consistency: "stale_ok" | "fresh"
  readonly principal: Principal
  readonly egress: EgressPolicy
  readonly sessionId: string
  /** Internal execution capability. Public tool callers always set this to true. */
  readonly toolCall?: boolean
  /** Internal provider-turn authority. Public tool inputs never populate this field. */
  readonly releasedKnowledgeSelection?: DeepAgentReleasedSnapshot.Selection
}

export type Hit = {
  readonly ref: ContextRef
  readonly title: string
  readonly graph: GraphKind
  readonly excerpt?: string
  readonly relationPath?: readonly {
    readonly relation: string
    readonly ref: ContextRef
    readonly freshness: "exact" | "rebound" | "broken"
  }[]
  readonly provenance: readonly ContextRef[]
  readonly validity?: {
    readonly state: "current" | "historical" | "expired" | "superseded" | "conflict"
    readonly reason?: string
  }
  readonly score: number
  readonly sensitivity: "public" | "source_code" | "pii" | "secret_adjacent" | "secret"
}

export type Result = {
  readonly statuses: readonly GraphQueryStatus[]
  readonly hits: readonly Hit[]
  readonly truncated: boolean
  readonly snapshotFingerprint: string
}

export class InvalidQueryError extends Schema.TaggedErrorClass<InvalidQueryError>()(
  "FederatedContextQuery.InvalidQueryError",
  { reason: Schema.String },
) {}

export interface Interface {
  readonly query: (input: Request) => Effect.Effect<Result, InvalidQueryError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/FederatedContextQuery") {}
