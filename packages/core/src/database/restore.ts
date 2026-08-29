export * as Restore from "./restore"

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Data, Effect } from "effect"
import { Database as BunDatabase } from "bun:sqlite"
import { Backup, type BackupManifest } from "./backup"
import { BackupVerify } from "./backup-verify"
import { Database } from "./database"

// §10.9 VERIFIED RESTORE (C1A-13). Restore must EXPLICITLY select a verified backup, quarantine the
// current DB/WAL/SHM into an incident set (never overwrite the only accident copy), atomically install
// the backup, reopen + verify, then forward-migrate through the normal apply() so upgrade-run /
// old-binary-fence semantics apply. On ANY failure the quarantined copy is the safety net (never
// deleted), the original live DB is put back, and a typed error is raised. A restore manifest (source
// backup ref, quarantine paths, timestamps, digests, outcome) is exported for audit.
//
// Quarantine semantic decision (documented): the live DB+WAL+SHM are COPIED (not moved) into the
// incident set. Copying keeps BOTH the live path (so a failed install can be put back) and an incident
// copy (the accident record that is never deleted/overwritten). Design §10.9 says "move" the current
// DB/WAL/SHM to the incident set; the invariant it protects is "never overwrite the only accident
// copy" — copy preserves that invariant strictly and is idempotent-recoverable, so a crash during
// install leaves the original still on disk.
//
// FIXTURE-ONLY: exercised against temp fixture DBs (DEEPAGENT_CODE_TEST_HOME/tmp). It never touches a
// production/user database and is never called implicitly at startup.

export type RestoreErrorCode =
  | "backup_unverified"
  | "backup_invalid"
  | "live_db_not_found"
  | "quarantine_failed"
  | "install_failed"
  | "reopen_verify_failed"
  | "forward_migrate_failed"

export class RestoreError extends Data.TaggedError("Restore.RestoreError")<{
  readonly code: RestoreErrorCode
  readonly detail: string
}> {}

export interface RestoreOptions {
  /** Absolute path of the live SQLite DB being restored (the target to replace). */
  readonly dbPath: string
  /** The verified backup manifest to install (load + verify via BackupVerify before calling). */
  readonly backup: BackupManifest
  /** Incidents/quarantine root directory. Defaults to `<dbDir>/restore-incidents`. */
  readonly quarantineDir?: string
  /** Injectable install step (test seam for the install-failure path). Defaults to the real atomic install. */
  readonly install?: (source: string, target: string) => Effect.Effect<void, RestoreError>
}

export interface RestoreManifest {
  readonly version: 1
  readonly restoreId: string
  readonly sourceBackup: {
    readonly filePath: string
    readonly sha256: string
    readonly createdAt: number
  }
  readonly liveDbPath: string
  readonly quarantineDir: string
  readonly installedAt: number
  readonly restoredAt: number
  readonly outcome: "restored" | "failed"
  readonly failure?: { readonly code: RestoreErrorCode; readonly detail: string }
  readonly restoredDigest: string
}

const sha256 = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")

const exists = (p: string) =>
  Effect.tryPromise(() => fs.stat(p)).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: () => true,
    }),
  )

/** Create a unique incident directory at `root` (never overwrite an existing incident set). */
const makeIncidentDir = (root: string) =>
  Effect.gen(function* () {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    let candidate = path.join(root, `incident-${stamp}-${randomUUID().slice(0, 8)}`)
    let counter = 0
    while (yield* exists(candidate)) {
      counter += 1
      candidate = path.join(root, `incident-${stamp}-${randomUUID().slice(0, 8)}-${counter}`)
    }
    yield* Effect.tryPromise({
      try: () => fs.mkdir(candidate, { recursive: true }),
      catch: () => new RestoreError({ code: "quarantine_failed", detail: `cannot create incident dir: ${candidate}` }),
    })
    return candidate
  })

/** Copy + fsync + atomic rename (0600) of a file onto a target path. */
const installFile = (source: string, target: string) =>
  Effect.gen(function* () {
    const dir = path.dirname(target)
    const tmp = path.join(dir, `.${path.basename(target)}.restore-tmp-${randomUUID().slice(0, 8)}`)
    yield* Effect.tryPromise({
      try: () => fs.copyFile(source, tmp),
      catch: () => new RestoreError({ code: "install_failed", detail: `cannot copy backup to ${tmp}` }),
    })
    yield* Effect.tryPromise({
      try: () => fs.chmod(tmp, 0o600),
      catch: () => new RestoreError({ code: "install_failed", detail: `cannot set 0600 on ${tmp}` }),
    })
    yield* Effect.tryPromise({
      try: async () => {
        const handle = await fs.open(tmp, "r+")
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      },
      catch: () => new RestoreError({ code: "install_failed", detail: `cannot fsync ${tmp}` }),
    })
    yield* Effect.tryPromise({
      try: () => fs.rename(tmp, target),
      catch: () => new RestoreError({ code: "install_failed", detail: `cannot rename ${tmp} -> ${target}` }),
    })
    yield* Effect.tryPromise({
      try: async () => {
        const handle = await fs.open(dir, "r")
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      },
      catch: () => new RestoreError({ code: "install_failed", detail: `cannot fsync dir ${dir}` }),
    })
  })

/** Bitwise read-only verification of the installed backup (integrity + FK + registry-set equality). */
const verifyInstalled = (dbPath: string, manifest: BackupManifest) =>
  Effect.gen(function* () {
    const reload = yield* Effect.tryPromise(
      async () => new BunDatabase(dbPath, { create: false, readonly: true }),
    ).pipe(Effect.orElseSucceed(() => null))
    if (reload === null)
      return yield* Effect.fail(
        new RestoreError({ code: "reopen_verify_failed", detail: `cannot reopen installed database: ${dbPath}` }),
      )
    try {
      const quick = (reload.query("PRAGMA integrity_check").get() as { integrity_check: string } | undefined)?.integrity_check
      if (quick !== "ok")
        return yield* Effect.fail(
          new RestoreError({ code: "reopen_verify_failed", detail: `integrity_check returned ${String(quick)}` }),
        )
      const orphans = reload.query("PRAGMA foreign_key_check").all() as Record<string, unknown>[]
      if (orphans.length > 0)
        return yield* Effect.fail(
          new RestoreError({ code: "reopen_verify_failed", detail: `${orphans.length} orphaned foreign-key reference(s)` }),
        )
      const applied = (
        reload.query("SELECT id FROM migration ORDER BY id").all() as { id: string }[]
      ).map((row) => row.id).sort()
      const expected = [...manifest.source.appliedMigrationIds].sort()
      if (applied.length !== expected.length || applied.some((id, i) => id !== expected[i]))
        return yield* Effect.fail(
          new RestoreError({
            code: "reopen_verify_failed",
            detail: "installed migration set differs from backup manifest",
          }),
        )
      return yield* Effect.succeed("ok")
    } finally {
      reload.close()
    }
  })

/**
 * Restore `dbPath` from a verified backup. Returns the restore manifest on success; on any failure
 * the incident set is retained (safety net) and the original live DB is put back.
 */
export const restoreVerified = Effect.fn("Restore.restoreVerified")(function* (options: RestoreOptions) {
  const restoreId = randomUUID()
  const dbPath = path.resolve(options.dbPath)
  const quarantineRoot = path.resolve(options.quarantineDir ?? path.join(path.dirname(dbPath), "restore-incidents"))
  const installedAt = Date.now()

  // 1. The target backup must be verified; a bad/no selection is a typed refusal.
  const verification = yield* BackupVerify.verify(options.backup)
  if (!verification.ok)
    return yield* Effect.fail(
      new RestoreError({
        code: "backup_unverified",
        detail: `backup verification failed (${verification.reason}): ${verification.detail}`,
      }),
    )

  const liveStat = yield* Effect.tryPromise(() => fs.stat(dbPath)).pipe(Effect.orElseSucceed(() => null))
  if (liveStat === null || !liveStat.isFile())
    return yield* Effect.fail(
      new RestoreError({ code: "live_db_not_found", detail: `live database does not exist: ${dbPath}` }),
    )

  const backupPath = path.resolve(options.backup.backup.filePath)
  if (!(yield* exists(backupPath)))
    return yield* Effect.fail(new RestoreError({ code: "backup_invalid", detail: `backup file missing: ${backupPath}` }))

  // 2. Quarantine: COPY the live DB + WAL + SHM into a unique incident set (never overwrite/delete it).
  const incidentDir = yield* makeIncidentDir(quarantineRoot)
  const liveParts = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
  for (const part of liveParts) {
    if (yield* exists(part)) {
      yield* Effect.tryPromise({
        try: () => fs.copyFile(part, path.join(incidentDir, path.basename(part))),
        catch: () =>
          new RestoreError({ code: "quarantine_failed", detail: `cannot quarantine-copy ${part}` }),
      })
    }
  }

  // 3.+4.+5. Atomic install + reopen-verify + forward migrate, ALL inside the rollback scope: a
  //       failure AFTER the atomic rename (e.g. dir-fsync) must put the original live DB back too.
  const result = yield* Effect.gen(function* () {
    yield* (options.install ?? installFile)(backupPath, dbPath)
    // The pre-restore live DB's WAL/SHM belong to the OLD main file (quarantine retained the
    // copies); leaving them on the live path would make the reopen-verify read foreign frames
    // (a stale-WAL recovery against the freshly installed backup). Remove the stale sidecars.
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      if (yield* exists(sidecar)) {
        yield* Effect.tryPromise({
          try: () => fs.rm(sidecar),
          catch: () => new RestoreError({ code: "install_failed", detail: `cannot remove stale sidecar ${sidecar}` }),
        })
      }
    }
    yield* verifyInstalled(dbPath, options.backup)
    const { db } = yield* Database.Service.pipe(Effect.provide(Database.layerFromPath(dbPath)), Effect.scoped)
    void db
    return { restored: true as const, error: undefined }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const err = Cause.squash(cause)
        for (const part of liveParts) {
          const incidentCopy = path.join(incidentDir, path.basename(part))
          if (yield* exists(incidentCopy)) {
            // Copy (NOT move) the incident copy back onto the live path: the incident set is the
            // safety net and is never deleted; the live path is restored for maintenance access.
            yield* Effect.tryPromise(() => fs.copyFile(incidentCopy, part)).pipe(Effect.ignore)
          }
        }
        const restoreError =
          err instanceof RestoreError ? err : new RestoreError({ code: "forward_migrate_failed", detail: String(err) })
        return { restored: false as const, error: restoreError }
      }),
    ),
  )

  const restoredDigest = yield* Effect.tryPromise(() => fs.readFile(dbPath)).pipe(
    Effect.orElseSucceed(() => Buffer.alloc(0)),
    Effect.map((bytes) => sha256(bytes)),
  )
  const manifest: RestoreManifest = {
    version: 1,
    restoreId,
    sourceBackup: {
      filePath: backupPath,
      sha256: options.backup.backup.sha256,
      createdAt: options.backup.backup.createdAt,
    },
    liveDbPath: dbPath,
    quarantineDir: incidentDir,
    installedAt,
    restoredAt: Date.now(),
    outcome: result.restored ? "restored" : "failed",
    failure: result.error ? { code: result.error.code, detail: result.error.detail } : undefined,
    restoredDigest,
  }

  const manifestPath = `${dbPath}.restore-manifest.json`
  yield* Effect.tryPromise({
    try: async () => {
      const handle = await fs.open(manifestPath, "w")
      try {
        await handle.writeFile(JSON.stringify(manifest, null, 2))
        await handle.sync()
      } finally {
        await handle.close()
      }
    },
    catch: () => new RestoreError({ code: "install_failed", detail: `cannot write restore manifest: ${manifestPath}` }),
  })

  if (!result.restored) return yield* Effect.fail(result.error)

  return manifest
})

export const restoreManifestPathFor = (dbPath: string) => `${dbPath}.restore-manifest.json`
