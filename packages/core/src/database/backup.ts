export * as Backup from "./backup"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Data, Effect } from "effect"
import { Database } from "bun:sqlite"

// §10.4 Consistency backup. A pending migration must never run on a live database copy: the
// backup is produced by SQLite's own online-safe snapshot path (VACUUM INTO on a separate,
// read-only connection to the live file). It is never a plain `cp`/`rsync` of the main file,
// which would silently drop WAL content and produce an unrecoverable backup. The snapshot is
// written to a 0600 temp file, fsynced, atomically renamed into place, and a manifest records
// the source file identity, source schema/registry digest, backup hash and logical sizes,
// build ID and creation time — no keys or secrets.
//
// VACUUM INTO is used rather than the C sqlite3_backup_* API because the bundled bun:sqlite
// exposes neither backup_init nor a serialization file target; VACUUM INTO is the documented
// SQLite online-backup alternative (a consistent, single-file, WAL-free snapshot that does not
// mutate the source). See backup-verify.ts for the §10.4/10.9 verification step.

export type BackupErrorCode =
  | "source_not_found"
  | "source_not_file"
  | "dest_not_found"
  | "dest_not_directory"
  | "vacuum_failed"
  | "temp_mode_failed"
  | "temp_fsync_failed"
  | "rename_failed"
  | "dir_fsync_failed"
  | "manifest_write_failed"
  | "registry_digest_failed"
  | "backup_exists"

export class BackupError extends Data.TaggedError("Backup.BackupError")<{
  readonly code: BackupErrorCode
  readonly detail: string
}> {}

export interface BackupManifest {
  readonly version: 1
  readonly backup: {
    readonly fileName: string
    readonly filePath: string
    readonly sizeBytes: number
    readonly sha256: string
    readonly createdAt: number
  }
  readonly source: {
    readonly filePath: string
    readonly sizeBytes: number
    readonly mtimeMs: number
    readonly journalMode: string
    readonly synchronous: number
    readonly pageCount: number
    readonly pageSize: number
    readonly dbLogicalSizeBytes: number
    readonly walSizeBytes: number
    readonly appliedMigrationIds: readonly string[]
    readonly migrationCount: number
    readonly schemaDigest: string
    readonly capability: readonly CapabilityRow[]
  }
  readonly build: {
    readonly buildId: string
    readonly registryDigest: string
  }
}

export interface CapabilityRow {
  readonly capability: string
  readonly minimum_reader_protocol: number
  readonly minimum_writer_protocol: number
}

export interface BackupOptions {
  /** Absolute path to the live SQLite database file. */
  readonly sourcePath: string
  /** Absolute path to the directory that will hold the backup. Must be on the same filesystem as the temp file. */
  readonly destDir: string
  /** Build/package identity of the binary that is producing the backup. */
  readonly buildId: string
  /** Optional backup file base name (without extension). A deterministic local name is generated when omitted. */
  readonly fileName?: string
  /** Optional migration-registry digest. When omitted, the digest of the current binary's registry is computed. */
  readonly registryDigest?: string
}

const sha256 = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")

const statFile = (path: string) =>
  Effect.tryPromise({
    try: () => fs.stat(path),
    catch: () => new BackupError({ code: "source_not_found", detail: `cannot stat source: ${path}` }),
  })

const isDirectory = (path: string) =>
  Effect.tryPromise({
    try: () => fs.stat(path),
    catch: () => new BackupError({ code: "dest_not_found", detail: `cannot stat destination: ${path}` }),
  })

export const create = Effect.fn("Backup.create")(function* (options: BackupOptions) {
  const sourcePath = path.resolve(options.sourcePath)
  const destDir = path.resolve(options.destDir)

  const sourceStat = yield* statFile(sourcePath)
  if (!sourceStat.isFile())
    return yield* Effect.fail(
      new BackupError({ code: "source_not_file", detail: `source is not a regular file: ${sourcePath}` }),
    )
  const destStat = yield* isDirectory(destDir)
  if (!destStat.isDirectory())
    return yield* Effect.fail(
      new BackupError({ code: "dest_not_directory", detail: `destination is not a directory: ${destDir}` }),
    )

  const baseName = options.fileName ?? `backup-${options.buildId}-${Date.now()}`
  const tmpPath = path.join(destDir, `.${baseName}.tmp-${Math.random().toString(36).slice(2)}`)
  const finalName = `${baseName}.db`
  const finalPath = path.join(destDir, finalName)
  // Never clobber an existing backup file: an installed known-good or incident copy is kept until a
  // verified successor commits. A collision therefore fails fast without creating a temp snapshot.
  const existing = yield* Effect.tryPromise(() => fs.stat(finalPath)).pipe(Effect.orElseSucceed(() => null))
  if (existing !== null)
    return yield* Effect.fail(
      new BackupError({ code: "backup_exists", detail: `backup target already exists: ${finalPath}` }),
    )

  // Introspect the source on a separate, read-only connection and produce the snapshot. VACUUM
  // INTO reads a consistent snapshot (including committed WAL frames) and never mutates the
  // source; the live effect-connection is untouched.
  const snapshot = yield* Effect.tryPromise({
    try: async () => {
      const source = new Database(sourcePath, { create: false, readonly: true })
      try {
        source.exec("PRAGMA busy_timeout = 5000")
        const journalMode = (source.query("PRAGMA journal_mode").get() as { journal_mode: string })?.journal_mode
        const synchronous = (source.query("PRAGMA synchronous").get() as { synchronous: number })?.synchronous
        const pageCount = (source.query("PRAGMA page_count").get() as { page_count: number })?.page_count
        const pageSize = (source.query("PRAGMA page_size").get() as { page_size: number })?.page_size

        const capabilityTable = source
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_capability'")
          .get()
        const capability: CapabilityRow[] = capabilityTable
          ? (source
              .query("SELECT capability, minimum_reader_protocol, minimum_writer_protocol FROM database_capability")
              .all() as CapabilityRow[])
          : []

        let appliedMigrationIds: string[] = []
        const migrationTable = source
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'")
          .get()
        if (migrationTable) {
          appliedMigrationIds = (source
            .query("SELECT id FROM migration ORDER BY id")
            .all() as { id: string }[]).map((row) => row.id)
        }

        source.exec(`VACUUM INTO '${tmpPath.replaceAll("'", "''")}'`)

        return { journalMode, synchronous, pageCount, pageSize, capability, appliedMigrationIds }
      } finally {
        source.close()
      }
    },
    catch: (cause) =>
      new BackupError({ code: "vacuum_failed", detail: cause instanceof Error ? cause.message : String(cause) }),
  })

  // 0600 temp file, fsync file data, then atomic rename into place.
  yield* Effect.tryPromise({
    try: () => fs.chmod(tmpPath, 0o600),
    catch: () => new BackupError({ code: "temp_mode_failed", detail: `cannot set 0600 on temp backup: ${tmpPath}` }),
  })
  yield* Effect.tryPromise({
    try: async () => {
      const handle = await fs.open(tmpPath, "r+")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    },
    catch: () => new BackupError({ code: "temp_fsync_failed", detail: `cannot fsync temp backup: ${tmpPath}` }),
  })

  const backupBytes = yield* Effect.tryPromise({
    try: () => fs.readFile(tmpPath),
    catch: () => new BackupError({ code: "temp_fsync_failed", detail: `cannot read temp backup: ${tmpPath}` }),
  })
  const backupSha256 = sha256(backupBytes)

  yield* Effect.tryPromise({
    try: () => fs.rename(tmpPath, finalPath),
    catch: (cause) =>
      new BackupError({ code: "rename_failed", detail: cause instanceof Error ? cause.message : String(cause) }),
  })
  // Persist the rename across power loss by fsyncing the containing directory.
  yield* Effect.tryPromise({
    try: async () => {
      const handle = await fs.open(destDir, "r")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    },
    catch: () => new BackupError({ code: "dir_fsync_failed", detail: `cannot fsync backup directory: ${destDir}` }),
  })

  const walPath = `${sourcePath}-wal`
  const walSizeBytes = yield* Effect.tryPromise({
    try: async () => {
      try {
        return (await fs.stat(walPath)).size
      } catch {
        return 0
      }
    },
    catch: () => 0,
  })

  const schemaDigest = sha256(JSON.stringify(snapshot.appliedMigrationIds))
  const registryDigest =
    options.registryDigest ??
    (yield* Effect.tryPromise({
      try: async () => {
        const { migrations } = await import("./migration.gen")
        return sha256(JSON.stringify(migrations.map((m) => m.id)))
      },
      catch: () => new BackupError({ code: "registry_digest_failed", detail: "cannot load migration registry" }),
    }))

  const manifest: BackupManifest = {
    version: 1,
    backup: {
      fileName: finalName,
      filePath: finalPath,
      sizeBytes: backupBytes.length,
      sha256: backupSha256,
      createdAt: Date.now(),
    },
    source: {
      filePath: sourcePath,
      sizeBytes: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      journalMode: snapshot.journalMode,
      synchronous: snapshot.synchronous,
      pageCount: snapshot.pageCount,
      pageSize: snapshot.pageSize,
      dbLogicalSizeBytes: snapshot.pageCount * snapshot.pageSize,
      walSizeBytes,
      appliedMigrationIds: snapshot.appliedMigrationIds,
      migrationCount: snapshot.appliedMigrationIds.length,
      schemaDigest,
      capability: snapshot.capability,
    },
    build: {
      buildId: options.buildId,
      registryDigest,
    },
  }

  const manifestPath = `${finalPath}.manifest.json`
  yield* Effect.tryPromise({
    try: async () => {
      const manifestHandle = await fs.open(manifestPath, "w")
      try {
        await manifestHandle.writeFile(JSON.stringify(manifest, null, 2))
        await manifestHandle.sync()
      } finally {
        await manifestHandle.close()
      }
    },
    catch: () => new BackupError({ code: "manifest_write_failed", detail: manifestPath }),
  })

  return manifest
})

/** Absolute path of the JSON manifest next to a backup produced by {@link create}. */
export function manifestPathFor(backupFilePath: string) {
  return `${backupFilePath}.manifest.json`
}

/** Read and structurally validate a backup manifest written by {@link create}. */
export const readManifest = Effect.fn("Backup.readManifest")(function* (manifestPath: string) {
  const text = yield* Effect.tryPromise({
    try: () => fs.readFile(manifestPath, "utf8"),
    catch: () => new BackupError({ code: "manifest_write_failed", detail: `cannot read manifest: ${manifestPath}` }),
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return yield* Effect.die(new Error(`backup manifest is not valid JSON: ${manifestPath}`))
  }
  const manifest = parsed as Partial<BackupManifest> | null
  if (
    manifest?.version !== 1 ||
    manifest.backup === undefined ||
    manifest.source === undefined ||
    manifest.build === undefined ||
    typeof manifest.backup.filePath !== "string" ||
    typeof manifest.backup.sha256 !== "string" ||
    typeof manifest.source.filePath !== "string" ||
    typeof manifest.build.buildId !== "string"
  ) {
    return yield* Effect.die(new Error(`backup manifest is malformed: ${manifestPath}`))
  }
  return manifest as BackupManifest
})