export * as SessionProviderOwner from "./provider-owner"

import { and, eq, gt, isNull, lte, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { SessionProviderOwnerLeaseTable } from "./session-sql"

export type Lease = {
  readonly ownerToken: string
  readonly registeredAt: number
  readonly heartbeatAt: number
  readonly leaseExpiresAt: number
  readonly releasedAt?: number
}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionProviderOwner.ConflictError", {
  reason: Schema.String,
}) {}

export interface Interface {
  readonly register: (input: {
    readonly ownerToken: string
    readonly leaseMs: number
    // Successor generation registration (provider recovery): the old token was fenced by lease expiry and
    // this token continues the same ownership chain. Also installs the protocol-3 compatibility fence
    // so a pre-successor binary refuses to open this database instead of re-quarantining the chain.
    readonly successor?: boolean
    readonly now?: number
  }) => Effect.Effect<Lease, ConflictError>
  readonly heartbeat: (input: {
    readonly ownerToken: string
    readonly leaseMs: number
    readonly now?: number
  }) => Effect.Effect<Lease, ConflictError>
  readonly release: (input: { readonly ownerToken: string; readonly now?: number }) => Effect.Effect<Lease, ConflictError>
  readonly get: (ownerToken: string) => Effect.Effect<Lease | undefined>
}

export const LeaseMs = 30_000

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionProviderOwner") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const get = Effect.fn("SessionProviderOwner.get")(function* (ownerToken: string) {
      const row = yield* db
        .select()
        .from(SessionProviderOwnerLeaseTable)
        .where(eq(SessionProviderOwnerLeaseTable.owner_token, ownerToken))
        .get()
        .pipe(Effect.orDie)
      return row ? lease(row) : undefined
    })
    const register = Effect.fn("SessionProviderOwner.register")(function* (input: {
      readonly ownerToken: string
      readonly leaseMs: number
      readonly successor?: boolean
      readonly now?: number
    }) {
      return yield* db
        .transaction((tx) => registerInTransaction(tx, input), { behavior: "immediate" })
        .pipe(preserveErrors)
    })
    const heartbeat = Effect.fn("SessionProviderOwner.heartbeat")(function* (input: {
      readonly ownerToken: string
      readonly leaseMs: number
      readonly now?: number
    }) {
      return yield* db
        .transaction((tx) => heartbeatInTransaction(tx, input), { behavior: "immediate" })
        .pipe(preserveErrors)
    })
    const release = Effect.fn("SessionProviderOwner.release")(function* (input: {
      readonly ownerToken: string
      readonly now?: number
    }) {
      return yield* db
        .transaction((tx) => releaseInTransaction(tx, input), { behavior: "immediate" })
        .pipe(preserveErrors)
    })
    return Service.of({ register, heartbeat, release, get })
  }),
)

type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

export function observedAtInTransaction(tx: Transaction): Effect.Effect<number> {
  return tx
    .get<{ observedAt: number }>(sql`SELECT ${databaseNow} AS observedAt`)
    .pipe(
      Effect.flatMap((row) => (row ? Effect.succeed(row.observedAt) : Effect.die(new Error("database clock unavailable")))),
      Effect.orDie,
    )
}

function registerInTransaction(
  tx: Transaction,
  input: { readonly ownerToken: string; readonly leaseMs: number; readonly successor?: boolean },
) {
  return Effect.gen(function* () {
    if (!input.ownerToken.trim()) return yield* new ConflictError({ reason: "owner_token_required" })
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1)
      return yield* new ConflictError({ reason: "lease_ms_invalid" })
    const inserted = yield* tx
      .insert(SessionProviderOwnerLeaseTable)
      .values({
        owner_token: input.ownerToken,
        registered_at: databaseNow,
        heartbeat_at: databaseNow,
        lease_expires_at: sql`${databaseNow} + ${Math.min(input.leaseMs, MaxLeaseMs)}`,
      })
      .onConflictDoNothing()
      .returning()
      .get()
    if (!inserted) return yield* new ConflictError({ reason: "owner_token_already_registered" })
    if (input.successor)
      yield* tx.run(sql`
        INSERT INTO database_capability(
          capability, minimum_reader_protocol, minimum_writer_protocol, installed_at
        ) VALUES (
          'provider_owner_successor_v1', 3, 3, ${databaseNow}
        ) ON CONFLICT(capability) DO NOTHING
      `)
    return lease(inserted)
  })
}

function heartbeatInTransaction(
  tx: Transaction,
  input: { readonly ownerToken: string; readonly leaseMs: number },
) {
  return Effect.gen(function* () {
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1)
      return yield* new ConflictError({ reason: "lease_ms_invalid" })
    const leaseMs = Math.min(input.leaseMs, MaxLeaseMs)
    const updated = yield* tx
      .update(SessionProviderOwnerLeaseTable)
      .set({ heartbeat_at: databaseNow, lease_expires_at: sql`${databaseNow} + ${leaseMs}` })
      .where(
        and(
          eq(SessionProviderOwnerLeaseTable.owner_token, input.ownerToken),
          isNull(SessionProviderOwnerLeaseTable.released_at),
          lte(SessionProviderOwnerLeaseTable.heartbeat_at, databaseNow),
          gt(SessionProviderOwnerLeaseTable.lease_expires_at, databaseNow),
          lte(SessionProviderOwnerLeaseTable.lease_expires_at, sql`${databaseNow} + ${leaseMs}`),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (!updated) return yield* new ConflictError({ reason: "provider_owner_lease_not_live" })
    return lease(updated)
  })
}

function releaseInTransaction(tx: Transaction, input: { readonly ownerToken: string }) {
  return Effect.gen(function* () {
    const updated = yield* tx
      .update(SessionProviderOwnerLeaseTable)
      .set({ released_at: databaseNow })
      .where(
        and(
          eq(SessionProviderOwnerLeaseTable.owner_token, input.ownerToken),
          isNull(SessionProviderOwnerLeaseTable.released_at),
          lte(SessionProviderOwnerLeaseTable.registered_at, databaseNow),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (!updated) return yield* new ConflictError({ reason: "provider_owner_release_fence_lost" })
    return lease(updated)
  })
}

const databaseNow = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`
const MaxLeaseMs = 31_536_000_000

function lease(row: typeof SessionProviderOwnerLeaseTable.$inferSelect): Lease {
  return {
    ownerToken: row.owner_token,
    registeredAt: row.registered_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    ...(row.released_at !== null ? { releasedAt: row.released_at } : {}),
  }
}

function preserveErrors<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.catch((error) => (error instanceof ConflictError ? Effect.fail(error) : Effect.die(error))))
}
