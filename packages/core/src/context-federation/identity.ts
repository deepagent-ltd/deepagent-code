export * as LocationIdentity from "./identity"

import { randomBytes } from "node:crypto"
import { and, eq, isNull, or, sql } from "drizzle-orm"
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
import { WorkDispatchReservationTable, WorkExecutionTable } from "../session/work-authority.sql"

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

/** A read-only observation of the old binding, not permission to adopt it. */
export type ObservedProjectBinding = Identity & {
  readonly locationCreatedAt: number
  readonly projectCreatedAt: number
  readonly projectIdentityHash: string
  readonly locationObservedProjectId: string | null
  readonly projectObservedProjectId: string | null
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

export class WorkUnsettledError extends Schema.TaggedErrorClass<WorkUnsettledError>()(
  "LocationIdentity.WorkUnsettledError",
  {},
) {}

export type Error = RootUnavailableError | NotFoundError | RetiredError | ConflictError | WorkUnsettledError

export interface Interface {
  readonly resolveNamespace: (boundary: SecurityBoundary) => Effect.Effect<SecurityNamespaceID, Error>
  /** Observe the exact current root without creating identities or adopting an old alias. */
  readonly lookup: (input: {
    readonly boundary: SecurityBoundary
    readonly directory: AbsolutePath
    readonly project: ProjectBinding
  }) => Effect.Effect<Identity, Error>
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
  readonly inspectObservedProjectBinding: (input: {
    readonly boundary: SecurityBoundary
    readonly directory: AbsolutePath
  }) => Effect.Effect<ObservedProjectBinding, Error>
  /** Explicit host confirmation only. The host must obtain nextObservedProjectId from Project.observeDirectory. */
  readonly repairObservedProjectBinding: (input: {
    readonly boundary: SecurityBoundary
    readonly directory: AbsolutePath
    readonly expected: ObservedProjectBinding
    readonly nextObservedProjectId: string
  }) => Effect.Effect<Identity, Error>
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

    const lookup = Effect.fn("LocationIdentity.lookup")(function* (input: {
      readonly boundary: SecurityBoundary
      readonly directory: AbsolutePath
      readonly project: ProjectBinding
    }) {
      const root = yield* canonicalRoot(input.directory)
      // One SELECT observes all three durable bindings together; a read must not run
      // resolveNamespace/resolve and silently manufacture missing authority.
      const row = yield* db
        .select({
          namespace: SecurityNamespaceTable,
          location: LocationIdentityTable,
          project: ProjectScopeIdentityTable,
        })
        .from(SecurityNamespaceTable)
        .innerJoin(LocationIdentityTable, eq(LocationIdentityTable.security_namespace_id, SecurityNamespaceTable.id))
        .innerJoin(
          ProjectScopeIdentityTable,
          and(
            eq(ProjectScopeIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
            eq(ProjectScopeIdentityTable.project_scope_key, LocationIdentityTable.project_scope_key),
          ),
        )
        .where(
          and(
            eq(SecurityNamespaceTable.kind, input.boundary.kind),
            eq(SecurityNamespaceTable.binding_hash, namespaceBindingHash(input.boundary)),
            eq(LocationIdentityTable.canonical_root, root),
          ),
        )
        .get()
        .pipe(preserveErrors)
      if (!row) return yield* new NotFoundError({ kind: "location" })
      if (row.namespace.retired_at !== null) return yield* new RetiredError({ kind: "namespace" })
      if (row.location.retired_at !== null) return yield* new RetiredError({ kind: "location" })
      if (row.project.retired_at !== null) return yield* new RetiredError({ kind: "project_scope" })
      if (
        row.project.project_identity_hash !== projectBindingHash(input.project, root) ||
        row.location.observed_project_id !== (input.project.observedProjectId ?? null) ||
        row.location.workspace_binding !==
          (input.boundary.kind === "workspace" ? namespaceBindingHash(input.boundary) : null)
      )
        return yield* new ConflictError({ kind: "project_identity" })
      return identity(row.location)
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

    const inspectBinding = (
      tx: Pick<Database.Interface["db"], "select">,
      input: { readonly boundary: SecurityBoundary; readonly directory: AbsolutePath },
    ) =>
      Effect.gen(function* () {
        const root = yield* canonicalRoot(input.directory)
        // Repair never follows a symlink spelling or an old migrated-root alias.
        if (root !== input.directory) return yield* new ConflictError({ kind: "location_root" })
        const rows = yield* tx
          .select({
            namespace: SecurityNamespaceTable,
            location: LocationIdentityTable,
            project: ProjectScopeIdentityTable,
          })
          .from(SecurityNamespaceTable)
          .innerJoin(LocationIdentityTable, eq(LocationIdentityTable.security_namespace_id, SecurityNamespaceTable.id))
          .innerJoin(
            ProjectScopeIdentityTable,
            and(
              eq(ProjectScopeIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
              eq(ProjectScopeIdentityTable.project_scope_key, LocationIdentityTable.project_scope_key),
            ),
          )
          .where(
            and(
              eq(SecurityNamespaceTable.kind, input.boundary.kind),
              eq(SecurityNamespaceTable.binding_hash, namespaceBindingHash(input.boundary)),
              eq(LocationIdentityTable.canonical_root, root),
            ),
          )
          .limit(2)
        if (rows.length !== 1) return yield* new NotFoundError({ kind: "location" })
        const current = rows[0]!
        if (current.namespace.retired_at !== null) return yield* new RetiredError({ kind: "namespace" })
        if (current.location.retired_at !== null) return yield* new RetiredError({ kind: "location" })
        if (current.project.retired_at !== null) return yield* new RetiredError({ kind: "project_scope" })
        if (
          current.project.project_kind !== "registered_root" ||
          current.project.project_identity_hash !== projectBindingHash({ kind: "registered_root" }, root) ||
          current.location.workspace_binding !==
            (input.boundary.kind === "workspace" ? namespaceBindingHash(input.boundary) : null)
        )
          return yield* new ConflictError({ kind: "project_identity" })
        const locations = yield* tx
          .select({ key: LocationIdentityTable.location_key })
          .from(LocationIdentityTable)
          .where(
            and(
              eq(LocationIdentityTable.security_namespace_id, current.namespace.id),
              eq(LocationIdentityTable.project_scope_key, current.project.project_scope_key),
            ),
          )
          .limit(2)
        if (locations.length !== 1) return yield* new ConflictError({ kind: "project_identity" })
        const locationAlias = yield* tx
          .select({ key: LocationIdentityAliasTable.location_key })
          .from(LocationIdentityAliasTable)
          .where(
            and(
              eq(LocationIdentityAliasTable.security_namespace_id, current.namespace.id),
              or(
                eq(LocationIdentityAliasTable.location_key, current.location.location_key),
                eq(LocationIdentityAliasTable.old_canonical_root, root),
              ),
            ),
          )
          .get()
        const projectAlias = yield* tx
          .select({ key: ProjectScopeIdentityAliasTable.project_scope_key })
          .from(ProjectScopeIdentityAliasTable)
          .where(
            and(
              eq(ProjectScopeIdentityAliasTable.security_namespace_id, current.namespace.id),
              or(
                eq(ProjectScopeIdentityAliasTable.project_scope_key, current.project.project_scope_key),
                eq(ProjectScopeIdentityAliasTable.old_project_identity_hash, current.project.project_identity_hash),
              ),
            ),
          )
          .get()
        if (locationAlias || projectAlias) return yield* new ConflictError({ kind: "alias" })
        return {
          ...identity(current.location),
          locationCreatedAt: current.location.created_at,
          projectCreatedAt: current.project.created_at,
          projectIdentityHash: current.project.project_identity_hash,
          locationObservedProjectId: current.location.observed_project_id,
          projectObservedProjectId: current.project.observed_project_id,
        }
      })
    const inspectObservedProjectBinding = Effect.fn("LocationIdentity.inspectObservedProjectBinding")(function* (
      input: Parameters<Interface["inspectObservedProjectBinding"]>[0],
    ) {
      return yield* db.transaction((tx) => inspectBinding(tx, input)).pipe(preserveErrors)
    })
    const repairObservedProjectBinding = Effect.fn("LocationIdentity.repairObservedProjectBinding")(function* (
      input: Parameters<Interface["repairObservedProjectBinding"]>[0],
    ) {
      if (
        !input.nextObservedProjectId ||
        input.nextObservedProjectId.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(input.nextObservedProjectId)
      )
        return yield* new ConflictError({ kind: "project_identity" })
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* inspectBinding(tx, input)
              if (
                Object.keys(current).length !== Object.keys(input.expected).length ||
                Object.entries(current).some(
                  ([key, value]) => input.expected[key as keyof ObservedProjectBinding] !== value,
                )
              )
                return yield* new ConflictError({ kind: "project_identity" })
              // Unconfirmed work keeps its old authority. Repair never turns a pending or
              // unknown attempt into a fresh project execution or refunds its reservation.
              const blocked = yield* tx
                .select({ id: WorkExecutionTable.work_id })
                .from(WorkExecutionTable)
                .where(
                  and(
                    eq(WorkExecutionTable.security_namespace_id, current.securityNamespaceId),
                    sql`(json_extract(${WorkExecutionTable.binding}, '$.scope.projectScopeKey') IS NULL OR json_extract(${WorkExecutionTable.binding}, '$.scope.projectScopeKey') = ${current.projectScopeKey})`,
                    sql`(${WorkExecutionTable.outcome} IN ('pending','unknown') OR EXISTS (SELECT 1 FROM ${WorkDispatchReservationTable} WHERE ${WorkDispatchReservationTable.work_id} = ${WorkExecutionTable.work_id} AND ${WorkDispatchReservationTable.state} IN ('reserved','dispatching','unknown')))`,
                  ),
                )
                .get()
              if (blocked) return yield* new WorkUnsettledError()
              const location = yield* tx
                .update(LocationIdentityTable)
                .set({ observed_project_id: input.nextObservedProjectId })
                .where(
                  and(
                    eq(LocationIdentityTable.security_namespace_id, current.securityNamespaceId),
                    eq(LocationIdentityTable.location_key, current.locationKey),
                    eq(LocationIdentityTable.project_scope_key, current.projectScopeKey),
                    eq(LocationIdentityTable.canonical_root, current.canonicalRoot),
                    eq(LocationIdentityTable.created_at, current.locationCreatedAt),
                    isNull(LocationIdentityTable.retired_at),
                    current.locationObservedProjectId === null
                      ? isNull(LocationIdentityTable.observed_project_id)
                      : eq(LocationIdentityTable.observed_project_id, current.locationObservedProjectId),
                  ),
                )
                .returning({ key: LocationIdentityTable.location_key })
                .get()
              const project = yield* tx
                .update(ProjectScopeIdentityTable)
                .set({ observed_project_id: input.nextObservedProjectId })
                .where(
                  and(
                    eq(ProjectScopeIdentityTable.security_namespace_id, current.securityNamespaceId),
                    eq(ProjectScopeIdentityTable.project_scope_key, current.projectScopeKey),
                    eq(ProjectScopeIdentityTable.project_kind, "registered_root"),
                    eq(ProjectScopeIdentityTable.project_identity_hash, current.projectIdentityHash),
                    eq(ProjectScopeIdentityTable.created_at, current.projectCreatedAt),
                    isNull(ProjectScopeIdentityTable.retired_at),
                    current.projectObservedProjectId === null
                      ? isNull(ProjectScopeIdentityTable.observed_project_id)
                      : eq(ProjectScopeIdentityTable.observed_project_id, current.projectObservedProjectId),
                  ),
                )
                .returning({ key: ProjectScopeIdentityTable.project_scope_key })
                .get()
              if (!location || !project) return yield* new ConflictError({ kind: "project_identity" })
              return {
                ...identity({
                  security_namespace_id: current.securityNamespaceId,
                  location_key: current.locationKey,
                  project_scope_key: current.projectScopeKey,
                  canonical_root: current.canonicalRoot,
                  observed_project_id: input.nextObservedProjectId,
                }),
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(preserveErrors)
    })

    return Service.of({
      resolveNamespace,
      resolve,
      lookup,
      migrateLocation,
      migrateProjectIdentity,
      inspectObservedProjectBinding,
      repairObservedProjectBinding,
    })
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
    "LocationIdentity.WorkUnsettledError",
  ].includes(String(value._tag))
}
