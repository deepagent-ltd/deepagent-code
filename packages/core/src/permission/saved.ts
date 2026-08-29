export * as PermissionSaved from "./saved"

import { and, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ProjectV2 } from "../project"
import { withStatics } from "../schema"
import { Identifier } from "../util/identifier"
import { PermissionSavedEpochTable, PermissionTable } from "./sql"

export const ID = Schema.String.pipe(
  Schema.brand("PermissionSaved.ID"),
  withStatics((schema) => ({ create: () => schema.make("psv_" + Identifier.ascending()) })),
)
export type ID = typeof ID.Type

export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectV2.ID,
  action: Schema.String,
  resource: Schema.String,
}).annotate({ identifier: "PermissionSaved.Info" })
export type Info = typeof Info.Type

export const ListInput = Schema.Struct({
  projectID: ProjectV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionSaved.ListInput" })
export type ListInput = typeof ListInput.Type

export const AddInput = Schema.Struct({
  projectID: ProjectV2.ID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
}).annotate({ identifier: "PermissionSaved.AddInput" })
export type AddInput = typeof AddInput.Type

export const CompareAndAddInput = Schema.Struct({
  ...AddInput.fields,
  expectedEpoch: Schema.Int,
}).annotate({ identifier: "PermissionSaved.CompareAndAddInput" })
export type CompareAndAddInput = typeof CompareAndAddInput.Type

export const AuthorityVersion = Schema.Struct({
  projectID: ProjectV2.ID,
  epoch: Schema.Int,
}).annotate({ identifier: "PermissionSaved.AuthorityVersion" })
export type AuthorityVersion = typeof AuthorityVersion.Type

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("PermissionSaved.ConflictError", {
  projectID: ProjectV2.ID,
  expectedEpoch: Schema.Int,
  actualEpoch: Schema.Int,
}) {}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly add: (input: AddInput) => Effect.Effect<void>
  readonly compareAndAdd: (input: CompareAndAddInput) => Effect.Effect<AuthorityVersion, ConflictError>
  readonly epoch: (projectID: ProjectV2.ID) => Effect.Effect<AuthorityVersion>
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/PermissionSaved") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const list = Effect.fn("PermissionSaved.list")(function* (input?: ListInput) {
      const rows = yield* db
        .select()
        .from(PermissionTable)
        .where(input?.projectID ? eq(PermissionTable.project_id, input.projectID) : undefined)
        .all()
        .pipe(Effect.orDie)
      return rows.map(
        (row): Info => ({ id: row.id, projectID: row.project_id, action: row.action, resource: row.resource }),
      )
    })

    const add = Effect.fn("PermissionSaved.add")(function* (input: AddInput) {
      const resources = [...new Set(input.resources)]
      if (!resources.length) return
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(PermissionSavedEpochTable)
                .values({ project_id: input.projectID, epoch: 0, updated_at: Date.now() })
                .onConflictDoNothing()
                .run()
              const current = yield* tx
                .select()
                .from(PermissionSavedEpochTable)
                .where(eq(PermissionSavedEpochTable.project_id, input.projectID))
                .get()
              if (!current) return yield* Effect.die(new Error(`permission authority is missing: ${input.projectID}`))
              const existing = yield* tx
                .select({ resource: PermissionTable.resource })
                .from(PermissionTable)
                .where(
                  and(
                    eq(PermissionTable.project_id, input.projectID),
                    eq(PermissionTable.action, input.action),
                    inArray(PermissionTable.resource, resources),
                  ),
                )
                .all()
              const known = new Set(existing.map((item) => item.resource))
              const missing = resources.filter((resource) => !known.has(resource))
              if (!missing.length) return
              yield* tx
                .update(PermissionSavedEpochTable)
                .set({ epoch: current.epoch + 1, updated_at: Date.now() })
                .where(
                  and(
                    eq(PermissionSavedEpochTable.project_id, input.projectID),
                    eq(PermissionSavedEpochTable.epoch, current.epoch),
                  ),
                )
                .run()
              yield* tx
                .insert(PermissionTable)
                .values(
                  missing.map((resource) => ({
                    id: ID.create(),
                    project_id: input.projectID,
                    action: input.action,
                    resource,
                  })),
                )
                .onConflictDoNothing()
                .run()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const compareAndAdd = Effect.fn("PermissionSaved.compareAndAdd")(function* (input: CompareAndAddInput) {
      const resources = [...new Set(input.resources)]
      if (!resources.length)
        return yield* new ConflictError({
          projectID: input.projectID,
          expectedEpoch: input.expectedEpoch,
          actualEpoch: input.expectedEpoch,
        })
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(PermissionSavedEpochTable)
                .values({ project_id: input.projectID, epoch: 0, updated_at: Date.now() })
                .onConflictDoNothing()
                .run()
              const current = yield* tx
                .select()
                .from(PermissionSavedEpochTable)
                .where(eq(PermissionSavedEpochTable.project_id, input.projectID))
                .get()
              if (!current) return yield* Effect.die(new Error(`permission authority is missing: ${input.projectID}`))
              const existing = yield* tx
                .select({ resource: PermissionTable.resource })
                .from(PermissionTable)
                .where(
                  and(
                    eq(PermissionTable.project_id, input.projectID),
                    eq(PermissionTable.action, input.action),
                    inArray(PermissionTable.resource, resources),
                  ),
                )
                .all()
              const known = new Set(existing.map((item) => item.resource))
              const missing = resources.filter((resource) => !known.has(resource))
              if (!missing.length) return { kind: "updated" as const, epoch: current.epoch }
              if (current.epoch !== input.expectedEpoch)
                return { kind: "conflict" as const, actualEpoch: current.epoch }
              const updated = yield* tx
                .update(PermissionSavedEpochTable)
                .set({ epoch: current.epoch + 1, updated_at: Date.now() })
                .where(
                  and(
                    eq(PermissionSavedEpochTable.project_id, input.projectID),
                    eq(PermissionSavedEpochTable.epoch, input.expectedEpoch),
                  ),
                )
                .returning()
                .get()
              if (!updated) return { kind: "conflict" as const, actualEpoch: current.epoch }
              yield* tx
                .insert(PermissionTable)
                .values(
                  missing.map((resource) => ({
                    id: ID.create(),
                    project_id: input.projectID,
                    action: input.action,
                    resource,
                  })),
                )
                .onConflictDoNothing()
                .run()
              return { kind: "updated" as const, epoch: updated.epoch }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (result.kind === "conflict")
        return yield* new ConflictError({
          projectID: input.projectID,
          expectedEpoch: input.expectedEpoch,
          actualEpoch: result.actualEpoch,
        })
      return { projectID: input.projectID, epoch: result.epoch }
    })

    const epoch = Effect.fn("PermissionSaved.epoch")(function* (projectID: ProjectV2.ID) {
      yield* db
        .insert(PermissionSavedEpochTable)
        .values({ project_id: projectID, epoch: 0, updated_at: Date.now() })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const current = yield* db
        .select()
        .from(PermissionSavedEpochTable)
        .where(eq(PermissionSavedEpochTable.project_id, projectID))
        .get()
        .pipe(Effect.orDie)
      if (!current) return yield* Effect.die(new Error(`permission authority is missing: ${projectID}`))
      return { projectID, epoch: current.epoch }
    })

    const remove = Effect.fn("PermissionSaved.remove")(function* (id: ID) {
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const existing = yield* tx.select().from(PermissionTable).where(eq(PermissionTable.id, id)).get()
              if (!existing) return
              yield* tx
                .insert(PermissionSavedEpochTable)
                .values({ project_id: existing.project_id, epoch: 0, updated_at: Date.now() })
                .onConflictDoNothing()
                .run()
              const current = yield* tx
                .select()
                .from(PermissionSavedEpochTable)
                .where(eq(PermissionSavedEpochTable.project_id, existing.project_id))
                .get()
              if (!current)
                return yield* Effect.die(new Error(`permission authority is missing: ${existing.project_id}`))
              yield* tx
                .update(PermissionSavedEpochTable)
                .set({ epoch: current.epoch + 1, updated_at: Date.now() })
                .where(
                  and(
                    eq(PermissionSavedEpochTable.project_id, existing.project_id),
                    eq(PermissionSavedEpochTable.epoch, current.epoch),
                  ),
                )
                .run()
              yield* tx.delete(PermissionTable).where(eq(PermissionTable.id, id)).run()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    return Service.of({ list, add, compareAndAdd, epoch, remove })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
