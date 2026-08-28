export * as ContextReference from "./reference"

import { Schema } from "effect"
import { GraphKind } from "./contract"

export const SecurityNamespaceID = Schema.String.pipe(Schema.brand("Context.SecurityNamespaceID"))
export type SecurityNamespaceID = typeof SecurityNamespaceID.Type

export const LocationKey = Schema.String.pipe(Schema.brand("Context.LocationKey"))
export type LocationKey = typeof LocationKey.Type

export const ProjectScopeKey = Schema.String.pipe(Schema.brand("Context.ProjectScopeKey"))
export type ProjectScopeKey = typeof ProjectScopeKey.Type

export const IndexSpaceID = Schema.String.pipe(Schema.brand("Context.IndexSpaceID"))
export type IndexSpaceID = typeof IndexSpaceID.Type

export const ProjectionKind = Schema.Literals(["code", "repo_documents"])
export type ProjectionKind = typeof ProjectionKind.Type

export const ProjectionSnapshotRevision = Schema.Struct({
  projectionKind: ProjectionKind,
  indexIncarnation: Schema.Int.check(Schema.isGreaterThan(0)),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  manifestHash: Schema.String,
  schemaVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  adapterSetVersion: Schema.String,
})
export type ProjectionSnapshotRevision = typeof ProjectionSnapshotRevision.Type

export const ContextScopeBinding = Schema.Union([
  Schema.Struct({
    scope: Schema.Literal("location"),
    securityNamespaceId: SecurityNamespaceID,
    locationKey: LocationKey,
    projectScopeKey: ProjectScopeKey,
  }),
  Schema.Struct({
    scope: Schema.Literal("project"),
    securityNamespaceId: SecurityNamespaceID,
    projectScopeKey: ProjectScopeKey,
  }),
  Schema.Struct({
    scope: Schema.Literal("session"),
    securityNamespaceId: SecurityNamespaceID,
    projectScopeKey: ProjectScopeKey,
    sessionId: Schema.String,
  }),
  Schema.Struct({
    scope: Schema.Literal("user"),
    securityNamespaceId: SecurityNamespaceID,
    subjectId: Schema.String,
  }),
  Schema.Struct({ scope: Schema.Literal("builtin") }),
])
export type ContextScopeBinding = typeof ContextScopeBinding.Type

export const ContextRef = Schema.Struct({
  graph: GraphKind,
  entityId: Schema.String,
  binding: ContextScopeBinding,
  locator: Schema.Struct({
    path: Schema.String.pipe(Schema.optional),
    symbolPath: Schema.String.pipe(Schema.optional),
    heading: Schema.String.pipe(Schema.optional),
    startLine: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
    endLine: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
  }).pipe(Schema.optional),
  revision: Schema.String,
})
export type ContextRef = typeof ContextRef.Type

export function canonicalProjectionRevision(revision: ProjectionSnapshotRevision) {
  return JSON.stringify({
    projectionKind: revision.projectionKind,
    indexIncarnation: revision.indexIncarnation,
    generation: revision.generation,
    manifestHash: revision.manifestHash,
    schemaVersion: revision.schemaVersion,
    adapterSetVersion: revision.adapterSetVersion,
  })
}

export function canonicalContextRef(ref: ContextRef) {
  return JSON.stringify({
    graph: ref.graph,
    entityId: ref.entityId,
    binding: canonicalBinding(ref.binding),
    ...(ref.locator
      ? {
          locator: {
            ...(ref.locator.path === undefined ? {} : { path: ref.locator.path }),
            ...(ref.locator.symbolPath === undefined ? {} : { symbolPath: ref.locator.symbolPath }),
            ...(ref.locator.heading === undefined ? {} : { heading: ref.locator.heading }),
            ...(ref.locator.startLine === undefined ? {} : { startLine: ref.locator.startLine }),
            ...(ref.locator.endLine === undefined ? {} : { endLine: ref.locator.endLine }),
          },
        }
      : {}),
    revision: ref.revision,
  })
}

function canonicalBinding(binding: ContextScopeBinding) {
  if (binding.scope === "builtin") return { scope: binding.scope }
  if (binding.scope === "user") {
    return {
      scope: binding.scope,
      securityNamespaceId: binding.securityNamespaceId,
      subjectId: binding.subjectId,
    }
  }
  if (binding.scope === "location") {
    return {
      scope: binding.scope,
      securityNamespaceId: binding.securityNamespaceId,
      locationKey: binding.locationKey,
      projectScopeKey: binding.projectScopeKey,
    }
  }
  if (binding.scope === "session") {
    return {
      scope: binding.scope,
      securityNamespaceId: binding.securityNamespaceId,
      projectScopeKey: binding.projectScopeKey,
      sessionId: binding.sessionId,
    }
  }
  return {
    scope: binding.scope,
    securityNamespaceId: binding.securityNamespaceId,
    projectScopeKey: binding.projectScopeKey,
  }
}

export function sameProjectionRevision(a: ProjectionSnapshotRevision, b: ProjectionSnapshotRevision) {
  return canonicalProjectionRevision(a) === canonicalProjectionRevision(b)
}
