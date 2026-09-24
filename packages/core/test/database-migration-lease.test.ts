import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigrationLease } from "@deepagent-code/core/database/migration-lease"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { tmpdir } from "./fixture/tmpdir"
import path from "path"
import os from "os"
import { mkdir, utimes } from "fs/promises"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const runFile = (filename: string) => <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

describe("DatabaseMigrationLease", () => {
  test("a live local owner cannot be broken solely because its heartbeat is stale", async () => {
    await using tmp = await tmpdir()
    const lockDir = path.join(tmp.path, "database.runtime.lock")
    await mkdir(lockDir)
    await Bun.write(path.join(lockDir, "heartbeat"), "")
    await Bun.write(
      path.join(lockDir, "meta.json"),
      JSON.stringify({ token: "owner", pid: process.pid, hostname: os.hostname(), createdAt: new Date(0).toISOString() }),
    )
    const stale = new Date(0)
    await utimes(path.join(lockDir, "heartbeat"), stale, stale)
    await utimes(path.join(lockDir, "meta.json"), stale, stale)
    await utimes(lockDir, stale, stale)

    expect(await DatabaseMigrationLease.processLockActive(lockDir, { staleMs: 1 })).toBe(true)
  })

  test("a dead local owner (pid no longer exists) can be broken once its heartbeat is stale", async () => {
    await using tmp = await tmpdir()
    const lockDir = path.join(tmp.path, "database.runtime.lock")
    // A real exited child guarantees an ESRCH pid; a guessed number could collide with a live process.
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" })
    await child.exited
    await mkdir(lockDir)
    await Bun.write(path.join(lockDir, "heartbeat"), "")
    await Bun.write(
      path.join(lockDir, "meta.json"),
      JSON.stringify({ token: "dead-owner", pid: child.pid, hostname: os.hostname(), createdAt: new Date(0).toISOString() }),
    )
    const stale = new Date(0)
    await utimes(path.join(lockDir, "heartbeat"), stale, stale)
    await utimes(path.join(lockDir, "meta.json"), stale, stale)
    await utimes(lockDir, stale, stale)

    expect(await DatabaseMigrationLease.processLockActive(lockDir, { staleMs: 1 })).toBe(false)
    await Effect.runPromise(
      Effect.gen(function* () {
        const lock = yield* DatabaseMigrationLease.acquireProcessLock(lockDir, { staleMs: 1, timeoutMs: 2_000 })
        yield* lock.release
      }),
    )
  })

  test("an un-signalable owner (EPERM) counts as alive: the lock is never stale, never breakable", async () => {
    // Root-owned pid 1 raises EPERM from kill(pid, 0) for an unprivileged runner; a root runner can
    // signal it instead, in which case no EPERM oracle exists on this host.
    const epermPid = [1].find((pid) => {
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
      }
    })
    if (epermPid === undefined) return
    await using tmp = await tmpdir()
    const lockDir = path.join(tmp.path, "database.runtime.lock")
    await mkdir(lockDir)
    await Bun.write(path.join(lockDir, "heartbeat"), "")
    await Bun.write(
      path.join(lockDir, "meta.json"),
      JSON.stringify({ token: "eperm-owner", pid: epermPid, hostname: os.hostname(), createdAt: new Date(0).toISOString() }),
    )
    const stale = new Date(0)
    await utimes(path.join(lockDir, "heartbeat"), stale, stale)
    await utimes(path.join(lockDir, "meta.json"), stale, stale)
    await utimes(lockDir, stale, stale)

    expect(await DatabaseMigrationLease.processLockActive(lockDir, { staleMs: 1 })).toBe(true)
    const attempt = await Effect.runPromise(
      DatabaseMigrationLease.acquireProcessLock(lockDir, { staleMs: 1, timeoutMs: 300 }).pipe(Effect.exit),
    )
    expect(attempt._tag).toBe("Failure")
    expect(String(attempt)).toContain("lease timed out")
  })

  // Windows has no SIGSTOP/SIGCONT; the stale-live-PID oracle above covers its process fence.
  const suspendTest = process.platform === "win32" ? test.skip : test
  suspendTest("a SIGSTOP-suspended owner still fences preemption: heartbeat frozen but the process is alive", async () => {
    await using tmp = await tmpdir()
    const lockDir = path.join(tmp.path, "database.runtime.lock")
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" })
    try {
      await mkdir(lockDir)
      await Bun.write(path.join(lockDir, "heartbeat"), "")
      await Bun.write(
        path.join(lockDir, "meta.json"),
        JSON.stringify({ token: "stopped-owner", pid: child.pid, hostname: os.hostname(), createdAt: new Date(0).toISOString() }),
      )
      // A suspended owner's heartbeat timer cannot fire; epoch mtimes reproduce the file state it leaves behind.
      const stale = new Date(0)
      await utimes(path.join(lockDir, "heartbeat"), stale, stale)
      await utimes(path.join(lockDir, "meta.json"), stale, stale)
      await utimes(lockDir, stale, stale)
      process.kill(child.pid, "SIGSTOP")

      // kill(pid, 0) succeeds for a suspended process, so it counts as alive despite the frozen heartbeat.
      expect(await DatabaseMigrationLease.processLockActive(lockDir, { staleMs: 1 })).toBe(true)
      const attempt = await Effect.runPromise(
        DatabaseMigrationLease.acquireProcessLock(lockDir, { staleMs: 1, timeoutMs: 300 }).pipe(Effect.exit),
      )
      expect(attempt._tag).toBe("Failure")
      expect(String(attempt)).toContain("lease timed out")
    } finally {
      // A suspended process does not handle SIGTERM until it is continued.
      process.kill(child.pid, "SIGCONT")
      child.kill()
      await child.exited
    }
  })

  test("acquires a DB lease with owner/generation/expiry and releases it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigrationLease.ensureTables(db)
        const lease = yield* DatabaseMigrationLease.acquire(db, { leaseMs: 5000 })
        expect(lease.token.length).toBeGreaterThan(0)
        expect(lease.generation).toBe(1)
        expect(lease.expiresAt).toBeGreaterThan(Date.now())
        const row = yield* db.get(sql`SELECT owner_token, generation, expires_at FROM database_migration_lease`)
        expect(row).toEqual({ owner_token: lease.token, generation: 1, expires_at: lease.expiresAt })

        yield* lease.release()
        const after = yield* db.get(sql`SELECT owner_token FROM database_migration_lease`)
        expect(after).toBeUndefined()
      }),
    )
  })

  test("only one migrator holds the lease and contention is bounded into a timeout", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "lease.sqlite")
    await runFile(filename)(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigrationLease.ensureTables(db)
        const first = yield* DatabaseMigrationLease.acquire(db, { staleMs: 60_000 }, filename)
        expect(first.generation).toBe(1)
        const second = yield* DatabaseMigrationLease.acquire(db, { staleMs: 60_000, timeoutMs: 300 }, filename).pipe(
          Effect.exit,
        )
        expect(second._tag).toBe("Failure")
        expect(String(second)).toContain("lease timed out")
        yield* first.release()
      }),
    )
  })

  test("a migrated generation invalidates a stale lease token so it cannot commit a receipt", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigrationLease.ensureTables(db)
        yield* DatabaseUpgradeRun.ensureTables(db)
        const lease = yield* DatabaseMigrationLease.acquire(db, { leaseMs: 60_000 })
        const runValue = yield* DatabaseUpgradeRun.beginRun(db, {
          sourceRegistryDigest: "s",
          targetRegistryDigest: "t",
          sourceProtocol: { reader: "2", writer: "2" },
          targetProtocol: { reader: "3", writer: "3" },
          buildIdentity: "b",
          packageVersion: "v",
          pendingMigrationIds: ["migration-a"],
          totalMigrations: 1,
        })
        yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "backup_verified")
        yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "applying")

        // A new owner bumps generation, stealing the lease from the first holder.
        yield* DatabaseMigrationLease.acquireDatabaseLease(db, "other-owner", { leaseMs: 60_000 })

        const receipt = yield* db
          .transaction((tx) =>
            DatabaseUpgradeRun.recordReceipt(tx, {
              runId: runValue.runId,
              migrationId: "migration-a",
              contentHash: "c1",
              bodyHash: "b1",
              ordinal: 1,
              buildIdentity: "b",
              packageVersion: "v",
              result: "applied",
              startedAt: 1,
              completedAt: 2,
            }, lease),
          )
          .pipe(Effect.exit)
        expect(receipt._tag).toBe("Failure")
        expect(String(receipt)).toContain("lease")
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_migration_receipt`)).toEqual({ count: 0 })
      }),
    )
  })

  test("assertCurrent fails when the lease has been transferred or expired", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigrationLease.ensureTables(db)
        const lease = yield* DatabaseMigrationLease.acquire(db, { leaseMs: 60_000 })
        const ok = yield* db.transaction((tx) => DatabaseMigrationLease.assertCurrent(tx, lease)).pipe(Effect.exit)
        expect(ok._tag).toBe("Success")

        // Transfer to a new owner bumps generation.
        yield* DatabaseMigrationLease.acquireDatabaseLease(db, "new-owner", { leaseMs: 60_000 })
        const transferred = yield* db.transaction((tx) => DatabaseMigrationLease.assertCurrent(tx, lease)).pipe(Effect.exit)
        expect(transferred._tag).toBe("Failure")
        expect(String(transferred)).toContain("lease")
      }),
    )
  })
})
