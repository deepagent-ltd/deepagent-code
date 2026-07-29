export * as LocationIndexCoordination from "./coordination"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import type { Identity } from "./identity"
import { LocationIdentityTable, LocationIndexCoordinationTable } from "./sql"
import { ProjectionKind } from "./reference"

export type Record = {
  readonly identity: Identity
  readonly projectionKind: ProjectionKind
  readonly indexIncarnation: number
  readonly dbLocator: string
  readonly ownerId?: string
  readonly fencingToken: number
  readonly expiresAt?: number
  readonly replacementState: "ready" | "replacing"
  readonly updatedAt: number
}

export type Lease = Record & {
  readonly ownerId: string
  readonly expiresAt: number
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "LocationIndexCoordination.NotFoundError",
  {},
) {}

export class LeaseHeldError extends Schema.TaggedErrorClass<LeaseHeldError>()(
  "LocationIndexCoordination.LeaseHeldError",
  { expiresAt: Schema.Int },
) {}

export class StaleWriterError extends Schema.TaggedErrorClass<StaleWriterError>()(
  "LocationIndexCoordination.StaleWriterError",
  {},
) {}

export class InvalidIdentityError extends Schema.TaggedErrorClass<InvalidIdentityError>()(
  "LocationIndexCoordination.InvalidIdentityError",
  {},
) {}

export type Error = NotFoundError | LeaseHeldError | StaleWriterError | InvalidIdentityError

export interface Interface {
  readonly get: (input: {
    readonly identity: Identity
    readonly projectionKind: ProjectionKind
  }) => Effect.Effect<Record, Error>
  readonly ensure: (input: {
    readonly identity: Identity
    readonly projectionKind: ProjectionKind
    readonly dbLocator: string
    readonly now?: number
  }) => Effect.Effect<Record, Error>
  readonly acquire: (input: {
    readonly identity: Identity
    readonly projectionKind: ProjectionKind
    readonly ownerId: string
    readonly leaseMs: number
    readonly now?: number
  }) => Effect.Effect<Lease, Error>
  readonly renew: (input: {
    readonly lease: Lease
    readonly leaseMs: number
    readonly now?: number
  }) => Effect.Effect<Lease, Error>
  readonly validate: (input: {
    readonly lease: Lease
    readonly now?: number
  }) => Effect.Effect<Lease, Error>
  readonly replaceDatabase: (input: {
    readonly lease: Lease
    readonly dbLocator: string
    readonly now?: number
  }) => Effect.Effect<Lease, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/LocationIndexCoordination") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const get = Effect.fn("LocationIndexCoordination.get")(function* (input: {
      readonly identity: Identity
      readonly projectionKind: ProjectionKind
    }) {
      const current = yield* db
        .select()
        .from(LocationIndexCoordinationTable)
        .where(
          and(
            eq(LocationIndexCoordinationTable.index_space_id, input.identity.indexSpaceId),
            eq(LocationIndexCoordinationTable.projection_kind, input.projectionKind),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!current) return yield* new NotFoundError()
      if (!recordMatchesIdentity(current, input.identity)) return yield* new InvalidIdentityError()
      return record(input.identity, current)
    })

    const ensure = Effect.fn("LocationIndexCoordination.ensure")(function* (input: {
      readonly identity: Identity
      readonly projectionKind: ProjectionKind
      readonly dbLocator: string
      readonly now?: number
    }) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (!(yield* identityExists(tx, input.identity))) return yield* new InvalidIdentityError()
            const existing = yield* tx
              .select()
              .from(LocationIndexCoordinationTable)
              .where(
                and(
                  eq(LocationIndexCoordinationTable.index_space_id, input.identity.indexSpaceId),
                  eq(LocationIndexCoordinationTable.projection_kind, input.projectionKind),
                ),
              )
              .get()
            if (existing) {
              if (!recordMatchesIdentity(existing, input.identity)) return yield* new InvalidIdentityError()
              return record(input.identity, existing)
            }
            const now = input.now ?? Date.now()
            yield* tx
              .insert(LocationIndexCoordinationTable)
              .values({
                security_namespace_id: input.identity.securityNamespaceId,
                location_key: input.identity.locationKey,
                index_space_id: input.identity.indexSpaceId,
                projection_kind: input.projectionKind,
                index_incarnation: 1,
                db_locator: input.dbLocator,
                fencing_token: 0,
                replacement_state: "ready",
                updated_at: now,
              })
              .run()
            return {
              identity: input.identity,
              projectionKind: input.projectionKind,
              indexIncarnation: 1,
              dbLocator: input.dbLocator,
              fencingToken: 0,
              replacementState: "ready" as const,
              updatedAt: now,
            }
          }),
        )
        .pipe(preserveErrors)
    })

    const acquire = Effect.fn("LocationIndexCoordination.acquire")(function* (input: {
      readonly identity: Identity
      readonly projectionKind: ProjectionKind
      readonly ownerId: string
      readonly leaseMs: number
      readonly now?: number
    }) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(LocationIndexCoordinationTable)
              .where(
                and(
                  eq(LocationIndexCoordinationTable.index_space_id, input.identity.indexSpaceId),
                  eq(LocationIndexCoordinationTable.projection_kind, input.projectionKind),
                ),
              )
              .get()
            if (!current) return yield* new NotFoundError()
            if (!recordMatchesIdentity(current, input.identity)) return yield* new InvalidIdentityError()
            const now = input.now ?? Date.now()
            if (current.owner_id && current.owner_id !== input.ownerId && (current.expires_at ?? 0) > now) {
              return yield* new LeaseHeldError({ expiresAt: current.expires_at ?? now })
            }
            const fencingToken =
              current.owner_id === input.ownerId && (current.expires_at ?? 0) > now
                ? current.fencing_token
                : current.fencing_token + 1
            const expiresAt = now + Math.max(1, input.leaseMs)
            yield* tx
              .update(LocationIndexCoordinationTable)
              .set({ owner_id: input.ownerId, fencing_token: fencingToken, expires_at: expiresAt, updated_at: now })
              .where(
                and(
                  eq(LocationIndexCoordinationTable.index_space_id, input.identity.indexSpaceId),
                  eq(LocationIndexCoordinationTable.projection_kind, input.projectionKind),
                ),
              )
              .run()
            return lease(input.identity, {
              ...current,
              owner_id: input.ownerId,
              fencing_token: fencingToken,
              expires_at: expiresAt,
              updated_at: now,
            })
          }),
        )
        .pipe(preserveErrors)
    })

    const renew = Effect.fn("LocationIndexCoordination.renew")(function* (input: {
      readonly lease: Lease
      readonly leaseMs: number
      readonly now?: number
    }) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = input.now ?? Date.now()
            const current = yield* currentRecord(tx, input.lease)
            if (!current || !recordMatchesIdentity(current, input.lease.identity)) {
              return yield* new InvalidIdentityError()
            }
            if (!owns(current, input.lease, now)) return yield* new StaleWriterError()
            const expiresAt = now + Math.max(1, input.leaseMs)
            yield* tx
              .update(LocationIndexCoordinationTable)
              .set({ expires_at: expiresAt, updated_at: now })
              .where(
                and(
                  eq(LocationIndexCoordinationTable.index_space_id, input.lease.identity.indexSpaceId),
                  eq(LocationIndexCoordinationTable.projection_kind, input.lease.projectionKind),
                ),
              )
              .run()
            return { ...input.lease, expiresAt, updatedAt: now }
          }),
        )
        .pipe(preserveErrors)
    })

    const validate = Effect.fn("LocationIndexCoordination.validate")(function* (input: {
      readonly lease: Lease
      readonly now?: number
    }) {
      const current = yield* db
        .select()
        .from(LocationIndexCoordinationTable)
        .where(
          and(
            eq(LocationIndexCoordinationTable.index_space_id, input.lease.identity.indexSpaceId),
            eq(LocationIndexCoordinationTable.projection_kind, input.lease.projectionKind),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const now = input.now ?? Date.now()
      if (!current || !recordMatchesIdentity(current, input.lease.identity)) {
        return yield* new InvalidIdentityError()
      }
      if (!owns(current, input.lease, now)) return yield* new StaleWriterError()
      return lease(input.lease.identity, current)
    })

    const replaceDatabase = Effect.fn("LocationIndexCoordination.replaceDatabase")(function* (input: {
      readonly lease: Lease
      readonly dbLocator: string
      readonly now?: number
    }) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = input.now ?? Date.now()
            const current = yield* currentRecord(tx, input.lease)
            if (!current || !recordMatchesIdentity(current, input.lease.identity)) {
              return yield* new InvalidIdentityError()
            }
            if (!owns(current, input.lease, now)) return yield* new StaleWriterError()
            const indexIncarnation = current.index_incarnation + 1
            const fencingToken = current.fencing_token + 1
            yield* tx
              .update(LocationIndexCoordinationTable)
              .set({
                index_incarnation: indexIncarnation,
                db_locator: input.dbLocator,
                fencing_token: fencingToken,
                replacement_state: "ready",
                updated_at: now,
              })
              .where(
                and(
                  eq(LocationIndexCoordinationTable.index_space_id, input.lease.identity.indexSpaceId),
                  eq(LocationIndexCoordinationTable.projection_kind, input.lease.projectionKind),
                ),
              )
              .run()
            return {
              ...input.lease,
              indexIncarnation,
              dbLocator: input.dbLocator,
              fencingToken,
              updatedAt: now,
            }
          }),
        )
        .pipe(preserveErrors)
    })

    return Service.of({ get, ensure, acquire, renew, validate, replaceDatabase })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

function currentRecord(tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0], lease: Lease) {
  return tx
    .select()
    .from(LocationIndexCoordinationTable)
    .where(
      and(
        eq(LocationIndexCoordinationTable.index_space_id, lease.identity.indexSpaceId),
        eq(LocationIndexCoordinationTable.projection_kind, lease.projectionKind),
      ),
    )
    .get()
}

function identityExists(tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0], identity: Identity) {
  if (identity.indexSpaceId !== Hash.sha256(`location-index/v1${identity.locationKey}`)) return Effect.succeed(false)
  return tx
    .select({
      project_scope_key: LocationIdentityTable.project_scope_key,
      retired_at: LocationIdentityTable.retired_at,
    })
    .from(LocationIdentityTable)
    .where(
      and(
        eq(LocationIdentityTable.security_namespace_id, identity.securityNamespaceId),
        eq(LocationIdentityTable.location_key, identity.locationKey),
      ),
    )
    .get()
    .pipe(Effect.map((row) => row?.retired_at === null && row.project_scope_key === identity.projectScopeKey))
}

function recordMatchesIdentity(row: typeof LocationIndexCoordinationTable.$inferSelect, identity: Identity) {
  return (
    row.security_namespace_id === identity.securityNamespaceId &&
    row.location_key === identity.locationKey &&
    row.index_space_id === identity.indexSpaceId
  )
}

function owns(row: typeof LocationIndexCoordinationTable.$inferSelect | undefined, lease: Lease, now: number) {
  return Boolean(
    row &&
      row.owner_id === lease.ownerId &&
      row.fencing_token === lease.fencingToken &&
      row.index_incarnation === lease.indexIncarnation &&
      (row.expires_at ?? 0) > now,
  )
}

function record(identity: Identity, row: typeof LocationIndexCoordinationTable.$inferSelect): Record {
  return {
    identity,
    projectionKind: row.projection_kind,
    indexIncarnation: row.index_incarnation,
    dbLocator: row.db_locator,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    fencingToken: row.fencing_token,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    replacementState: row.replacement_state,
    updatedAt: row.updated_at,
  }
}

function lease(identity: Identity, row: typeof LocationIndexCoordinationTable.$inferSelect): Lease {
  return {
    ...record(identity, row),
    ownerId: row.owner_id!,
    expiresAt: row.expires_at!,
  }
}

function preserveErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Error, R> {
  return effect.pipe(Effect.catch((error) => (isError(error) ? Effect.fail(error) : Effect.die(error))))
}

function isError(value: unknown): value is Error {
  if (!value || typeof value !== "object" || !("_tag" in value)) return false
  return [
    "LocationIndexCoordination.NotFoundError",
    "LocationIndexCoordination.LeaseHeldError",
    "LocationIndexCoordination.StaleWriterError",
    "LocationIndexCoordination.InvalidIdentityError",
  ].includes(String(value._tag))
}
