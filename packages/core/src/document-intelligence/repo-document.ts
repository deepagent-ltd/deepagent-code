export * as RepoDocument from "./repo-document"

import { Schema } from "effect"
import { ProjectionSnapshotRevision } from "../context-federation/reference"

export const Entry = Schema.Struct({
  documentId: Schema.String,
  path: Schema.String,
  contentSha: Schema.String,
  headingPath: Schema.String,
  anchor: Schema.String,
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
  searchableText: Schema.String,
})
export type Entry = typeof Entry.Type

export type Build = { readonly documents: readonly Entry[] }

export type SearchHit = { readonly document: Entry; readonly score: number }

export interface Store {
  readonly snapshot: () => ProjectionSnapshotRevision | undefined
  readonly fullCommit: (input: Commit & Build) => ProjectionSnapshotRevision
  readonly incrementalCommit: (input: Commit & {
    readonly documents: readonly Entry[]
    readonly deletedPaths: readonly string[]
  }) => ProjectionSnapshotRevision
  readonly search: (input: { readonly query: string; readonly limit: number }) => {
    readonly revision?: ProjectionSnapshotRevision
    readonly hits: readonly SearchHit[]
  }
  readonly lookup: (input: { readonly documentIds: readonly string[]; readonly limit: number }) => {
    readonly revision?: ProjectionSnapshotRevision
    readonly hits: readonly SearchHit[]
  }
  readonly close: () => void
}

export type Commit = {
  readonly indexIncarnation: number
  readonly fencingToken: number
  readonly expectedGeneration: number
  readonly indexedAt: number
}
