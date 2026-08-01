export * as CodeGraph from "./code-graph"

import { Schema } from "effect"
import { ProjectionSnapshotRevision } from "../context-federation/reference"

export const EntityKind = Schema.Literals(["file", "module", "package", "external_package", "symbol"])
export type EntityKind = typeof EntityKind.Type

export const SemanticLevel = Schema.Literals(["file", "syntax", "semantic"])
export type SemanticLevel = typeof SemanticLevel.Type

export const Entity = Schema.Struct({
  entityId: Schema.String,
  entityKind: EntityKind,
  stableKey: Schema.String,
  displayName: Schema.String,
  language: Schema.String,
  filePath: Schema.String.pipe(Schema.optional),
  identityStability: Schema.Literals(["durable", "generation"]),
})
export type Entity = typeof Entity.Type

export const File = Schema.Struct({
  entityId: Schema.String,
  path: Schema.String,
  language: Schema.String,
  contentSha: Schema.String,
  mtimeNs: Schema.String.pipe(Schema.optional),
  semanticLevel: SemanticLevel,
  searchableText: Schema.String,
})
export type File = typeof File.Type

export const Symbol = Schema.Struct({
  entityId: Schema.String,
  owningEntityId: Schema.String,
  symbolPath: Schema.String,
  kind: Schema.String,
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
  signature: Schema.String,
})
export type Symbol = typeof Symbol.Type

export const EdgeRelation = Schema.Literals([
  "contains",
  "imports",
  "exports",
  "calls",
  "references",
  "implements",
  "depends_on",
])
export type EdgeRelation = typeof EdgeRelation.Type

export const Edge = Schema.Struct({
  fromEntityId: Schema.String,
  toEntityId: Schema.String,
  relation: EdgeRelation,
  evidence: Schema.String,
})
export type Edge = typeof Edge.Type

export const Degree = Schema.Struct({
  inDegree: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outDegree: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  callsIn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  callsOut: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type Degree = typeof Degree.Type

export const Alias = Schema.Struct({
  fromEntityId: Schema.String,
  toEntityId: Schema.String,
  reason: Schema.Literals(["trusted_rename", "git_rename", "parser_continuity"]),
  evidence: Schema.String,
})
export type Alias = typeof Alias.Type

export type FileProjection = {
  readonly entity: Entity
  readonly file: File
  readonly symbols: readonly { readonly entity: Entity; readonly symbol: Symbol }[]
  readonly edges: readonly Edge[]
}

export type Build = {
  readonly files: readonly FileProjection[]
  readonly externalEntities: readonly Entity[]
  readonly edges: readonly Edge[]
  readonly aliases: readonly Alias[]
}

export const IndexStatus = Schema.Struct({
  state: Schema.Literals(["cold", "indexing", "ready", "degraded", "unavailable"]),
  revision: ProjectionSnapshotRevision.pipe(Schema.optional),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  indexedAt: Schema.Int.pipe(Schema.optional),
  dirtyPathCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  semanticCoverage: Schema.Record(Schema.String, SemanticLevel),
  lastError: Schema.Struct({ code: Schema.String, message: Schema.String }).pipe(Schema.optional),
})
export type IndexStatus = typeof IndexStatus.Type

export type SearchHit = {
  readonly entity: Entity
  readonly file?: File
  readonly symbol?: Symbol
  /** Derived from the active snapshot; never persisted as node state. */
  readonly degree: Degree
  readonly score: number
}

export type Neighbor = SearchHit & { readonly edge: Edge; readonly direction: "incoming" | "outgoing" }

export interface Store {
  readonly snapshot: () => ProjectionSnapshotRevision | undefined
  readonly status: (dirtyPathCount?: number) => IndexStatus
  readonly fullCommit: (input: Commit & { readonly build: Build }) => ProjectionSnapshotRevision
  readonly incrementalCommit: (input: Commit & {
    readonly files: readonly FileProjection[]
    readonly deletedPaths: readonly string[]
    readonly externalEntities?: readonly Entity[]
    readonly edges?: readonly Edge[]
    readonly aliases?: readonly Alias[]
  }) => ProjectionSnapshotRevision
  readonly search: (input: { readonly query: string; readonly limit: number }) => {
    readonly revision?: ProjectionSnapshotRevision
    readonly hits: readonly SearchHit[]
  }
  readonly neighbors: (input: {
    readonly entityId: string
    readonly direction: "incoming" | "outgoing"
    readonly relations?: readonly EdgeRelation[]
    readonly limit: number
  }) => {
    readonly revision?: ProjectionSnapshotRevision
    readonly hits: readonly Neighbor[]
  }
  readonly close: () => void
}

export type Commit = {
  readonly indexIncarnation: number
  readonly fencingToken: number
  readonly expectedGeneration: number
  readonly indexedAt: number
}
