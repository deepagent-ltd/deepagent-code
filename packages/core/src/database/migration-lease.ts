export * as DatabaseMigrationLease from "./migration-lease"

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { randomUUID } from "crypto"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { createHash } from "crypto"
import path from "path"
import os from "os"
import { mkdir, readFile, rm, stat, utimes, writeFile } from "fs/promises"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

export type LeaseOptions = {
  /** Explicit lock directory. Defaults to <dbPath>.migration.lock when a dbPath is given. */
  dir?: string
  /** A lock whose heartbeat/metadata has not been touched for this long can be broken. */
  staleMs?: number
  /** How long to wait to acquire the OS lock before timing out into maintenance. */
  timeoutMs?: number
  /** Lease duration (ms) for the DB-side lease row. */
  leaseMs?: number
  onWait?: (attempt: number, waitedMs: number) => void
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number
}

export class LeaseLost extends Error {
  readonly _tag = "MigrationLease.LeaseLost"
  readonly detail: string
  constructor(input: { detail: string }) {
    super(`database migration lease lost: ${input.detail}`)
    this.detail = input.detail
  }
}

export class LeaseTimeout extends Error {
  readonly _tag = "MigrationLease.LeaseTimeout"
  readonly detail: string
  constructor(input: { detail: string }) {
    super(`database migration lease timed out: ${input.detail}`)
    this.detail = input.detail
  }
}

export class LeaseCompromised extends Error {
  readonly _tag = "MigrationLease.LeaseCompromised"
  readonly detail: string
  constructor(input: { detail: string }) {
    super(`database migration lease compromised: ${input.detail}`)
    this.detail = input.detail
  }
}

const LEASE_ID = "database_migration"

export type MigrationLease = {
  readonly token: string
  readonly generation: number
  readonly expiresAt: number
  readonly heldAt: number
  readonly leaseMs: number
  readonly refresh: () => Effect.Effect<void, LeaseLost>
  readonly release: () => Effect.Effect<void>
}

type LeaseRow = {
  lease_id: string
  owner_token: string
  generation: number
  expires_at: number
  acquired_at: number
  refreshed_at: number
}

function clockNow(options: LeaseOptions): number {
  return options.now ? options.now() : Date.now()
}

/** Ensure the database migration lease table exists. */
export function ensureTables(db: Database) {
  return db.run(sql`
    CREATE TABLE IF NOT EXISTS database_migration_lease (
      lease_id TEXT NOT NULL PRIMARY KEY,
      owner_token TEXT NOT NULL,
      generation INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL,
      refreshed_at INTEGER NOT NULL
    )
  `)
}

// ---------------------------------------------------------------------------
// OS/process lock — atomic directory lock with heartbeat + stale recovery.
// ---------------------------------------------------------------------------

type OsHandle = { dir: string; token: string; heartbeat: () => void; release: () => Promise<void> }

function code(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined
  const value = (err as { code?: unknown }).code
  return typeof value === "string" ? value : undefined
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function stats(file: string) {
  try {
    return await stat(file)
  } catch (err) {
    if (code(err) === "ENOENT" || code(err) === "ENOTDIR") return undefined
    throw err
  }
}

async function isStaleLock(lockDir: string, opts: LeaseOptions): Promise<boolean> {
  const staleMs = opts.staleMs ?? 60_000
  const hb = await stats(path.join(lockDir, "heartbeat"))
  if (hb && clockNow(opts) - hb.mtimeMs > staleMs) return true
  const meta = await stats(path.join(lockDir, "meta.json"))
  if (meta && clockNow(opts) - meta.mtimeMs > staleMs) return true
  const dir = await stats(lockDir)
  if (!dir) return false
  return clockNow(opts) - dir.mtimeMs > staleMs
}

async function tryAcquireOsLock(lockDir: string, opts: LeaseOptions): Promise<OsHandle | undefined> {
  const token = randomUUID()
  const staleMs = opts.staleMs ?? 60_000
  const metaPath = path.join(lockDir, "meta.json")
  const heartbeatPath = path.join(lockDir, "heartbeat")

  let created = false
  try {
    await mkdir(lockDir, { mode: 0o700 })
    created = true
  } catch (err) {
    if (code(err) !== "EEXIST") throw err
  }

  if (!created) {
    if (!(await isStaleLock(lockDir, opts))) return undefined
    const breakerPath = lockDir + ".breaker"
    let claimed = false
    try {
      await mkdir(breakerPath, { mode: 0o700 })
      claimed = true
    } catch (err) {
      if (code(err) === "EEXIST") {
        const breaker = await stats(breakerPath)
        if (breaker && clockNow(opts) - breaker.mtimeMs > staleMs)
          await rm(breakerPath, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    if (!claimed) return undefined
    try {
      if (!(await isStaleLock(lockDir, opts))) return undefined
      await rm(lockDir, { recursive: true, force: true })
      try {
        await mkdir(lockDir, { mode: 0o700 })
      } catch (err) {
        const errCode = code(err)
        if (errCode === "EEXIST" || errCode === "ENOTEMPTY") return undefined
        throw err
      }
    } finally {
      await rm(breakerPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  await writeFile(heartbeatPath, "", { flag: "wx" }).catch(async () => {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
    throw new LeaseCompromised({ detail: "heartbeat already existed" })
  })
  const meta = { token, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() }
  await writeFile(metaPath, JSON.stringify(meta), { flag: "wx" }).catch(async () => {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
    throw new LeaseCompromised({ detail: "meta.json already existed" })
  })

  let timer: ReturnType<typeof setInterval> | undefined
  const heartbeat = () => {
    if (timer) return
    timer = setInterval(() => {
      const t = new Date()
      void utimes(heartbeatPath, t, t).catch(() => undefined)
    }, Math.max(100, Math.floor(staleMs / 3)))
    if (timer) timer.unref?.()
  }
  const release = async () => {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    const current = await readFile(metaPath, "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as { token?: unknown }
        return typeof parsed.token === "string" ? parsed.token : undefined
      })
      .catch(() => undefined)
    if (current !== token) throw new LeaseCompromised({ detail: "lock token mismatch (not the owner)" })
    await rm(lockDir, { recursive: true, force: true })
  }

  return { dir: lockDir, token, heartbeat, release }
}

async function acquireOsLock(lockDir: string, opts: LeaseOptions): Promise<OsHandle> {
  const timeoutMs = opts.timeoutMs ?? 5_000
  const start = clockNow(opts)
  let attempt = 0
  let waited = 0
  let delay = 100
  while (true) {
    const handle = await tryAcquireOsLock(lockDir, opts)
    if (handle) return handle
    if (clockNow(opts) - start > timeoutMs) throw new LeaseTimeout({ detail: lockDir })
    attempt += 1
    await opts.onWait?.(attempt, waited)
    await sleep(delay)
    waited += delay
    delay = Math.min(2_000, Math.floor(delay * 1.7))
  }
}

function asLeaseError(error: unknown): LeaseLost | LeaseTimeout | LeaseCompromised {
  if (error instanceof LeaseLost || error instanceof LeaseTimeout || error instanceof LeaseCompromised) return error
  return new LeaseLost({ detail: String(error) })
}

// ---------------------------------------------------------------------------
// DB lease
// ---------------------------------------------------------------------------

function assertNotExpired(lease: MigrationLease, leaseRow: LeaseRow, options: LeaseOptions): void {
  if (leaseRow.owner_token !== lease.token) throw new LeaseLost({ detail: "owner token changed (lease was transferred)" })
  if (leaseRow.generation !== lease.generation) throw new LeaseLost({ detail: "generation changed (lease was re-acquired)" })
  if (leaseRow.expires_at <= clockNow(options)) throw new LeaseLost({ detail: "lease expired" })
}

/** Validate the current DB lease row matches the held lease; fails LeaseLost when it is stale. */
export function assertCurrent(
  tx: Transaction,
  lease: MigrationLease,
  options: LeaseOptions = {},
): Effect.Effect<void, LeaseLost> {
  return Effect.gen(function* () {
    const row = yield* tx.get<LeaseRow>(sql`SELECT * FROM database_migration_lease WHERE lease_id = ${LEASE_ID}`).pipe(
      Effect.orDie,
    )
    if (!row) return yield* Effect.fail(new LeaseLost({ detail: "lease row missing" }))
    assertNotExpired(lease, row, options)
  })
}

/**
 * Write the DB lease row (owner token + generation + expiry). Every acquire bumps generation, so a
 * previous holder's token becomes stale the moment a new owner takes the lease.
 */
export function acquireDatabaseLease(
  db: Database,
  token: string,
  options: LeaseOptions,
) {
  const leaseMs = options.leaseMs ?? 60_000
  const acquisition = clockNow(options)
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO database_migration_lease (lease_id, owner_token, generation, expires_at, acquired_at, refreshed_at)
      VALUES (${LEASE_ID}, ${token}, 1, ${acquisition + leaseMs}, ${acquisition}, ${acquisition})
      ON CONFLICT(lease_id) DO UPDATE SET
        owner_token = excluded.owner_token,
        generation = database_migration_lease.generation + 1,
        expires_at = excluded.expires_at,
        acquired_at = excluded.acquired_at,
        refreshed_at = excluded.refreshed_at
    `)
    const row = yield* db.get<LeaseRow>(sql`SELECT * FROM database_migration_lease WHERE lease_id = ${LEASE_ID}`)
    if (!row) return yield* Effect.die(new Error("failed to read database migration lease after acquire"))
    return { generation: row.generation, expiresAt: row.expires_at, refreshedAt: row.refreshed_at }
  })
}

/**
 * Acquire the full migration lease: OS/process lock + DB lease with owner/generation/expiry.
 * Bounded by timeoutMs; on contention the caller must go to maintenance, never block unbounded.
 */
export function acquire(
  db: Database,
  options: LeaseOptions = {},
  dbPath?: string,
) {
  return Effect.gen(function* () {
    const token = randomUUID()
    let osHandle: OsHandle | undefined
    if (dbPath && dbPath !== ":memory:") {
      const lockDir = options.dir ?? `${dbPath}.migration.lock`
      osHandle = yield* Effect.tryPromise({
        try: () => acquireOsLock(lockDir, options),
        catch: (error) => asLeaseError(error),
      })
      osHandle.heartbeat()
    }
    const releaseOsHandle = () =>
      osHandle ? Effect.promise(() => osHandle.release()).pipe(Effect.ignore) : Effect.void
    const lease = yield* acquireDatabaseLease(db, token, options).pipe(
      Effect.tapError(() => releaseOsHandle()),
    )
    const leaseMs = options.leaseMs ?? 60_000
    const leaseValue: MigrationLease = {
      token,
      generation: lease.generation,
      expiresAt: lease.expiresAt,
      heldAt: lease.refreshedAt,
      leaseMs,
      refresh: () =>
        Effect.gen(function* () {
          yield* db.run(sql`
            UPDATE database_migration_lease
            SET expires_at = ${clockNow(options) + leaseMs}, refreshed_at = ${clockNow(options)}
            WHERE lease_id = ${LEASE_ID} AND owner_token = ${token} AND generation = ${lease.generation}
          `).pipe(Effect.orDie)
          const row = yield* db.get<LeaseRow>(sql`SELECT * FROM database_migration_lease WHERE lease_id = ${LEASE_ID}`).pipe(
            Effect.orDie,
          )
          if (row && (row.owner_token !== token || row.generation !== lease.generation))
            return yield* Effect.fail(new LeaseLost({ detail: "lost lease while refreshing" }))
          return yield* Effect.void
        }),
      release: () =>
        Effect.gen(function* () {
          yield* db.run(sql`
            DELETE FROM database_migration_lease
            WHERE lease_id = ${LEASE_ID} AND owner_token = ${token} AND generation = ${lease.generation}
          `).pipe(Effect.orDie)
          if (osHandle) yield* Effect.promise(() => osHandle.release()).pipe(Effect.ignore)
          return yield* Effect.void
        }),
    }
    return leaseValue
  })
}

/** Hash helper for deterministic lock keys (kept for dir derivation / tests). */
export function lockKey(dbPath: string): string {
  return createHash("sha256").update(dbPath).digest("hex").slice(0, 32)
}
