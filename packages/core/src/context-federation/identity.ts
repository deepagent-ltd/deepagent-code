export * as LocationIdentity from "./identity"

import { randomBytes } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { AbsolutePath } from "../schema"
import { Database } from "../database/database"
import { FSUtil } from "../fs-util"
import { Hash } from "../util/hash"
import {
  LocationIdentityAliasTable,
  LocationIdentityTable,
  ProjectScopeIdentityAliasTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "./sql"
import { IndexSpaceID, LocationKey, ProjectScopeKey, SecurityNamespaceID } from "./reference"

export const SecurityBoundary = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("implicit_local") }),
  Schema.Struct({ kind: Schema.Literal("workspace"), tenantId: Schema.String, workspaceId: Schema.String }),
])
export type SecurityBoundary = typeof SecurityBoundary.Type

export const ProjectBinding = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("git"), observedProjectId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("registered_root"), observedProjectId: Schema.String.pipe(Schema.optional) }),
])
export type ProjectBinding = typeof ProjectBinding.Type

export type Identity = {
  readonly securityNamespaceId: SecurityNamespaceID
  readonly locationKey: LocationKey
  readonly projectScopeKey: ProjectScopeKey
  readonly indexSpaceId: IndexSpaceID
  readonly canonicalRoot: AbsolutePath
  readonly observedProjectId?: string
}

export class RootUnavailableError extends Schema.TaggedErrorClass<RootUnavailableError>()(
  "LocationIdentity.RootUnavailableError",
  { directory: Schema.String },
) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("LocationIdentity.NotFoundError", {
  kind: Schema.Literals(["namespace", "location", "project_scope"]),
}) {}

export class RetiredError extends Schema.TaggedErrorClass<RetiredError>()("LocationIdentity.RetiredError", {
  kind: Schema.Literals(["namespace", "location", "project_scope"]),
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("LocationIdentity.ConflictError", {
  kind: Schema.Literals(["location_root", "project_identity", "alias"]),
}) {}

export type Error = RootUnavailableError | NotFoundError | RetiredError | ConflictError

export interface Interface {
  readonly resolveNamespace: (boundary: SecurityBoundary) => Effect.Effect<SecurityNamespaceID, Error>
  readonly resolve: (input: {
    readonly boundary: SecurityBoundary
    readonly directory: AbsolutePath
    readonly project: ProjectBinding
  }) => Effect.Effect<Identity, Error>
  readonly migrateLocation: (input: {
    readonly securityNamespaceId: SecurityNamespaceID
    readonly locationKey: LocationKey
    readonly nextDirectory: AbsolutePath
    readonly reason: string
  }) => Effect.Effect<Identity, Error>
  readonly migrateProjectIdentity: (input: {
    readonly securityNamespaceId: SecurityNamespaceID
    readonly projectScopeKey: ProjectScopeKey
    readonly nextObservedProjectId: string
    readonly reason: string
  }) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ContextLocationIdentity") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fs = yield* FSUtil.Service

    const resolveNamespace = Effect.fn("LocationIdentity.resolveNamespace")(function* (boundary: SecurityBoundary) {
      const bindingHash = namespaceBindingHash(boundary)
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(SecurityNamespaceTable)
              .where(
                and(
                  eq(SecurityNamespaceTable.kind, boundary.kind),
                  eq(SecurityNamespaceTable.binding_hash, bindingHash),
                ),
              )
              .get()
            if (existing?.retired_at !== null && existing?.retired_at !== undefined) {
              return yield* new RetiredError({ kind: "namespace" })
            }
            if (existing) return SecurityNamespaceID.make(existing.id)
            const id = SecurityNamespaceID.make(opaque("sec"))
            yield* tx
              .insert(SecurityNamespaceTable)
              .values({ id, kind: boundary.kind, binding_hash: bindingHash, created_at: Date.now() })
              .run()
            return id
          }),
        )
        .pipe(preserveErrors)
    })

    const canonicalRoot = Effect.fn("LocationIdentity.canonicalRoot")(function* (directory: AbsolutePath) {
      const root = yield* fs.realPath(directory).pipe(Effect.mapError(() => new RootUnavailableError({ directory })))
      const info = yield* fs.stat(root).pipe(Effect.mapError(() => new RootUnavailableError({ directory })))
      if (info.type !== "Directory") return yield* new RootUnavailableError({ directory })
      return AbsolutePath.make(root)
    })

    const resolve = Effect.fn("LocationIdentity.resolve")(function* (input: {
      readonly boundary: SecurityBoundary
      readonly directory: AbsolutePath
      readonly project: ProjectBinding
    }) {
      const securityNamespaceId = yield* resolveNamespace(input.boundary)
      const root = yield* canonicalRoot(input.directory)
      const workspaceBinding = input.boundary.kind === "workspace" ? namespaceBindingHash(input.boundary) : undefined

      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(LocationIdentityTable)
              .where(
                and(
                  eq(LocationIdentityTable.security_namespace_id, securityNamespaceId),
                  eq(LocationIdentityTable.canonical_root, root),
                ),
              )
              .get()
            if (existing?.retired_at !== null && existing?.retired_at !== undefined) {
              return yield* new RetiredError({ kind: "location" })
            }
            if (existing) return identity(existing)

            const alias = yield* tx
              .select({ location_key: LocationIdentityAliasTable.location_key })
              .from(LocationIdentityAliasTable)
              .where(
                and(
                  eq(LocationIdentityAliasTable.security_namespace_id, securityNamespaceId),
                  eq(LocationIdentityAliasTable.old_canonical_root, root),
                ),
              )
              .get()
            if (alias) {
              const moved = yield* tx
                .select()
                .from(LocationIdentityTable)
                .where(
                  and(
                    eq(LocationIdentityTable.security_namespace_id, securityNamespaceId),
                    eq(LocationIdentityTable.location_key, alias.location_key),
                  ),
                )
                .get()
              if (!moved || moved.retired_at !== null) return yield* new RetiredError({ kind: "location" })
              return identity(moved)
            }

            const projectIdentityHash = projectBindingHash(input.project, root)
            const directProject = yield* tx
              .select()
              .from(ProjectScopeIdentityTable)
              .where(
                and(
                  eq(ProjectScopeIdentityTable.security_namespace_id, securityNamespaceId),
                  eq(ProjectScopeIdentityTable.project_identity_hash, projectIdentityHash),
                ),
              )
              .get()
            const projectAlias = directProject
              ? undefined
              : yield* tx
                  .select({ project_scope_key: ProjectScopeIdentityAliasTable.project_scope_key })
                  .from(ProjectScopeIdentityAliasTable)
                  .where(
                    and(
                      eq(ProjectScopeIdentityAliasTable.security_namespace_id, securityNamespaceId),
                      eq(ProjectScopeIdentityAliasTable.old_project_identity_hash, projectIdentityHash),
                    ),
                  )
                  .get()
            const aliasedProject = projectAlias
              ? yield* tx
                  .select()
                  .from(ProjectScopeIdentityTable)
                  .where(
                    and(
                      eq(ProjectScopeIdentityTable.security_namespace_id, securityNamespaceId),
                      eq(ProjectScopeIdentityTable.project_scope_key, projectAlias.project_scope_key),
                    ),
                  )
                  .get()
              : undefined
            const project = directProject ?? aliasedProject
            if (project?.retired_at !== null && project?.retired_at !== undefined) {
              return yield* new RetiredError({ kind: "project_scope" })
            }
            const projectScopeKey = project
              ? ProjectScopeKey.make(project.project_scope_key)
              : ProjectScopeKey.make(opaque("prjctx"))
            if (!project) {
              yield* tx
                .insert(ProjectScopeIdentityTable)
                .values({
                  security_namespace_id: securityNamespaceId,
                  project_scope_key: projectScopeKey,
                  project_kind: input.project.kind,
                  project_identity_hash: projectIdentityHash,
                  observed_project_id: input.project.observedProjectId,
                  created_at: Date.now(),
                })
                .run()
            }

            const locationKey = LocationKey.make(opaque("loc"))
            yield* tx
              .insert(LocationIdentityTable)
              .values({
                security_namespace_id: securityNamespaceId,
                location_key: locationKey,
                project_scope_key: projectScopeKey,
                workspace_binding: workspaceBinding,
                canonical_root: root,
                observed_project_id: input.project.observedProjectId,
                created_at: Date.now(),
              })
              .run()
            return identity({
              security_namespace_id: securityNamespaceId,
              location_key: locationKey,
              project_scope_key: projectScopeKey,
              canonical_root: root,
              observed_project_id: input.project.observedProjectId ?? null,
            })
          }),
        )
        .pipe(preserveErrors)
    })

    const migrateLocation = Effect.fn("LocationIdentity.migrateLocation")(function* (input: {
      readonly securityNamespaceId: SecurityNamespaceID
      readonly locationKey: LocationKey
      readonly nextDirectory: AbsolutePath
      readonly reason: string
    }) {
      const root = yield* canonicalRoot(input.nextDirectory)
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(LocationIdentityTable)
              .where(
                and(
                  eq(LocationIdentityTable.security_namespace_id, input.securityNamespaceId),
                  eq(LocationIdentityTable.location_key, input.locationKey),
                ),
              )
              .get()
            if (!current) return yield* new NotFoundError({ kind: "location" })
            if (current.retired_at !== null) return yield* new RetiredError({ kind: "location" })
            if (current.canonical_root === root) return identity(current)
            const occupied = yield* tx
              .select({ location_key: LocationIdentityTable.location_key })
              .from(LocationIdentityTable)
              .where(
                and(
                  eq(LocationIdentityTable.security_namespace_id, input.securityNamespaceId),
                  eq(LocationIdentityTable.canonical_root, root),
                  isNull(LocationIdentityTable.retired_at),
                ),
              )
              .get()
            if (occupied) return yield* new ConflictError({ kind: "location_root" })
            const alias = yield* tx
              .select()
              .from(LocationIdentityAliasTable)
              .where(
                and(
                  eq(LocationIdentityAliasTable.security_namespace_id, input.securityNamespaceId),
                  eq(LocationIdentityAliasTable.old_canonical_root, current.canonical_root),
                ),
              )
              .get()
            if (alias && alias.location_key !== input.locationKey) return yield* new ConflictError({ kind: "alias" })
            if (!alias) {
              yield* tx
                .insert(LocationIdentityAliasTable)
                .values({
                  security_namespace_id: input.securityNamespaceId,
                  old_canonical_root: current.canonical_root,
                  location_key: input.locationKey,
                  reason: input.reason,
                  created_at: Date.now(),
                })
                .run()
            }
            yield* tx
              .update(LocationIdentityTable)
              .set({ canonical_root: root })
              .where(
                and(
                  eq(LocationIdentityTable.security_namespace_id, input.securityNamespaceId),
                  eq(LocationIdentityTable.location_key, input.locationKey),
                ),
              )
              .run()
            return identity({ ...current, canonical_root: root })
          }),
        )
        .pipe(preserveErrors)
    })

    const migrateProjectIdentity = Effect.fn("LocationIdentity.migrateProjectIdentity")(function* (input: {
      readonly securityNamespaceId: SecurityNamespaceID
      readonly projectScopeKey: ProjectScopeKey
      readonly nextObservedProjectId: string
      readonly reason: string
    }) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(ProjectScopeIdentityTable)
              .where(
                and(
                  eq(ProjectScopeIdentityTable.security_namespace_id, input.securityNamespaceId),
                  eq(ProjectScopeIdentityTable.project_scope_key, input.projectScopeKey),
                ),
              )
              .get()
            if (!current) return yield* new NotFoundError({ kind: "project_scope" })
            if (current.retired_at !== null) return yield* new RetiredError({ kind: "project_scope" })
            if (current.project_kind !== "git") return yield* new ConflictError({ kind: "project_identity" })
            const nextHash = Hash.sha256(`git:${input.nextObservedProjectId}`)
            if (current.project_identity_hash === nextHash) return
            const conflict = yield* tx
              .select({ project_scope_key: ProjectScopeIdentityTable.project_scope_key })
              .from(ProjectScopeIdentityTable)
              .where(
                and(
                  eq(ProjectScopeIdentityTable.security_namespace_id, input.securityNamespaceId),
                  eq(ProjectScopeIdentityTable.project_identity_hash, nextHash),
                ),
              )
              .get()
            if (conflict && conflict.project_scope_key !== input.projectScopeKey) {
              return yield* new ConflictError({ kind: "project_identity" })
            }
            const nextAlias = yield* tx
              .select({ project_scope_key: ProjectScopeIdentityAliasTable.project_scope_key })
              .from(ProjectScopeIdentityAliasTable)
              .where(
                and(
                  eq(ProjectScopeIdentityAliasTable.security_namespace_id, input.securityNamespaceId),
                  eq(ProjectScopeIdentityAliasTable.old_project_identity_hash, nextHash),
                ),
              )
              .get()
            if (nextAlias && nextAlias.project_scope_key !== input.projectScopeKey) {
              return yield* new ConflictError({ kind: "project_identity" })
            }
            const previousAlias = yield* tx
              .select({ project_scope_key: ProjectScopeIdentityAliasTable.project_scope_key })
              .from(ProjectScopeIdentityAliasTable)
              .where(
                and(
                  eq(ProjectScopeIdentityAliasTable.security_namespace_id, input.securityNamespaceId),
                  eq(ProjectScopeIdentityAliasTable.old_project_identity_hash, current.project_identity_hash),
                ),
              )
              .get()
            if (previousAlias && previousAlias.project_scope_key !== input.projectScopeKey) {
              return yield* new ConflictError({ kind: "alias" })
            }
            yield* tx
              .insert(ProjectScopeIdentityAliasTable)
              .values({
                security_namespace_id: input.securityNamespaceId,
                old_project_identity_hash: current.project_identity_hash,
                project_scope_key: input.projectScopeKey,
                reason: input.reason,
                created_at: Date.now(),
              })
              .onConflictDoNothing()
              .run()
            yield* tx
              .update(ProjectScopeIdentityTable)
              .set({ project_identity_hash: nextHash, observed_project_id: input.nextObservedProjectId })
              .where(
                and(
                  eq(ProjectScopeIdentityTable.security_namespace_id, input.securityNamespaceId),
                  eq(ProjectScopeIdentityTable.project_scope_key, input.projectScopeKey),
                ),
              )
              .run()
            yield* tx
              .update(LocationIdentityTable)
              .set({ observed_project_id: input.nextObservedProjectId })
              .where(
                and(
                  eq(LocationIdentityTable.security_namespace_id, input.securityNamespaceId),
                  eq(LocationIdentityTable.project_scope_key, input.projectScopeKey),
                ),
              )
              .run()
          }),
        )
        .pipe(preserveErrors)
    })

    return Service.of({ resolveNamespace, resolve, migrateLocation, migrateProjectIdentity })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(FSUtil.defaultLayer))

function opaque(prefix: string) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`
}

function namespaceBindingHash(boundary: SecurityBoundary) {
  return Hash.sha256(
    boundary.kind === "implicit_local"
      ? "context-security-namespace/v1:implicit-local"
      : JSON.stringify({
          version: "context-security-namespace/v1",
          tenantId: boundary.tenantId,
          workspaceId: boundary.workspaceId,
        }),
  )
}

function projectBindingHash(project: ProjectBinding, root: AbsolutePath) {
  if (project.kind === "git" && project.observedProjectId !== "global") {
    return Hash.sha256(`git:${project.observedProjectId}`)
  }
  return Hash.sha256(`${project.kind}:${root}`)
}

function identity(row: {
  readonly security_namespace_id: string
  readonly location_key: string
  readonly project_scope_key: string
  readonly canonical_root: string
  readonly observed_project_id: string | null
}): Identity {
  const locationKey = LocationKey.make(row.location_key)
  return {
    securityNamespaceId: SecurityNamespaceID.make(row.security_namespace_id),
    locationKey,
    projectScopeKey: ProjectScopeKey.make(row.project_scope_key),
    indexSpaceId: IndexSpaceID.make(Hash.sha256(`location-index/v1${locationKey}`)),
    canonicalRoot: AbsolutePath.make(row.canonical_root),
    ...(row.observed_project_id ? { observedProjectId: row.observed_project_id } : {}),
  }
}

function preserveErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Error, R> {
  return effect.pipe(Effect.catch((error) => (isError(error) ? Effect.fail(error) : Effect.die(error))))
}

function isError(value: unknown): value is Error {
  if (!value || typeof value !== "object" || !("_tag" in value)) return false
  return [
    "LocationIdentity.RootUnavailableError",
    "LocationIdentity.NotFoundError",
    "LocationIdentity.RetiredError",
    "LocationIdentity.ConflictError",
  ].includes(String(value._tag))
}
