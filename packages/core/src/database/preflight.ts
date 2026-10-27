export * as DatabasePreflight from "./preflight"

// Read-only preflight (design §10.3, worklist C1A-02).
//
// Runs BEFORE any write and must never mutate the database: it only reads the
// SQLite header, the migration journal, the database_capability table, WAL/SHM
// state, the upgrade_run table, free space and the filesystem type. A failing
// preflight rejects the binary BEFORE migration runs (design §10.3: "不兼容时
// 不得先跑 migration 再拒绝"). The database is opened with a read-only SQLite
// connection; nothing is written. The connection keeps SQLite's default
// synchronous=FULL (it is at FULL, never NORMAL), which is a legitimate read-only,
// query_only-fenced exemption from design §10.6's "migration/backup/recovery
// 连接不得使用 NORMAL" rule.

import { Database, openImmutableReadOnly } from "#sqlite-native"
import { Effect, Result, Schema } from "effect"
import { pathToFileURL } from "node:url"
import fs from "node:fs/promises"
import path from "path"
import { DatabaseMigrationLease } from "./migration-lease"
import { contentDigest } from "../contract/digest"

export interface CapabilityRow {
  capability: string
  minimum_reader_protocol: number
  minimum_writer_protocol: number
}

export interface JournalRow {
  id: string
  time_completed: number
  content_hash?: string | null
}

export interface UpgradeRunRow {
  run_id: string
  state: string
}

export interface MigrationReceiptIdentityRow {
  receipt_id: string
  migration_id: string
  content_hash: string
  ordinal: number
  run_id: string
  build_identity: string
  package_version: string
  body_hash: string
  result: string
}

export type PreflightIssueCode =
  | "db_open_failed"
  | "not_a_sqlite_database"
  | "incompatible_binary"
  | "migration_journal_unknown_lineage"
  | "migration_journal_gap"
  | "migration_journal_duplicate_id"
  | "migration_journal_content_mismatch"
  | "unfinished_upgrade_run"
  | "insufficient_space"
  | "non_local_filesystem"
  | "another_process_active"

export interface PreflightIssue {
  code: PreflightIssueCode
  message: string
  resource?: string
  expected?: unknown
  actual?: unknown
  sqliteExtendedCode?: number
  /** C1A-14: constraint/trigger identity when the failure came from a constraint or trigger. */
  constraint?: string
  trigger?: boolean
}

export interface PreflightOptions {
  filename: string
  readerProtocol: number
  writerProtocol: number
  knownMigrationIds: readonly string[]
  historicalAliases: Readonly<Record<string, string>>
  knownContentHashes?: Readonly<Record<string, string>>
  /** Last migration allowed to carry the pre-sealed Function.toString identity. */
  legacyContentIdentityBoundary?: string
  mergedHistoryAnchor?: string
  mergedHistoryInsertions?: ReadonlySet<string>
  requiredFreeSpaceBytes?: number
  buildDigest: string
  buildVersion: string
}

export interface PreflightObservations {
  filename: string
  exists: boolean
  size: number
  mode: number | null
  sqliteHeaderValid: boolean
  pageSize: number | null
  pageCount: number | null
  journalMode: string | null
  dbReadable: boolean
  journalRows: JournalRow[]
  capabilities: CapabilityRow[]
  upgradeRuns: UpgradeRunRow[]
  /** Present when the receipt table exists; omitted by older injected probes. */
  migrationReceipts?: MigrationReceiptIdentityRow[]
  walExists: boolean
  walSize: number
  shmExists: boolean
  shmSize: number
  freeSpaceBytes: number
  localFilesystem: boolean
  activeProcess: boolean
}

export type PreflightResult =
  | { ok: true; observations: PreflightObservations }
  | { ok: false; observations: PreflightObservations; issues: PreflightIssue[] }

export interface PreflightProbes {
  stat: (filename: string) => Promise<{ size: number; mode: number } | null>
  readHeader: (filename: string) => Promise<{
    headerValid: boolean
    pageSize: number
    journalMode?: "wal" | "delete" | null
  } | null>
  readJournalMode: (filename: string) => Promise<{ journalMode: string | null; pageCount: number } | null>
  readJournalRows: (filename: string) => Promise<JournalRow[] | null>
  readCapabilities: (filename: string) => Promise<CapabilityRow[] | null>
  readUpgradeRuns: (filename: string) => Promise<UpgradeRunRow[] | null>
  readMigrationReceipts?: (filename: string) => Promise<MigrationReceiptIdentityRow[] | null>
  walShm: (filename: string) => Promise<{ walExists: boolean; walSize: number; shmExists: boolean; shmSize: number }>
  freeSpace: (filename: string) => Promise<number>
  localFilesystem: (filename: string) => Promise<boolean>
  activeProcess: (filename: string) => Promise<boolean>
}

const SQLITE_HEADER_MAGIC = "SQLite format 3\x00"
const HEADER_MAGIC_BYTES = Uint8Array.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])

const readConnection = (filename: string, immutable = false): Database | null => {
  // Physical read-only is part of the preflight authority boundary. If a WAL database cannot be
  // inspected without creating SHM or otherwise opening writable, the preflight must fail closed;
  // silently upgrading this connection to read-write would mutate the store before compatibility
  // and process ownership have been established.
  try {
    const db = immutable ? openImmutableReadOnly(filename) : new Database(filename, { readonly: true, create: false })
    db.run("PRAGMA query_only = ON")
    return db
  } catch {
    return null
  }
}

const inspectReadOnly = <T>(filename: string, inspect: (db: Database) => T, immutable = false): T | null => {
  const db = readConnection(filename, immutable)
  if (!db) return null
  try {
    return inspect(db)
  } catch {
    // Opening a corrupt file can succeed even though its first statement fails.
    // Preflight reports that state as unreadable; it must not crash the incident shell.
    return null
  } finally {
    db.close()
  }
}

const probesForReadOnly = (closed?: { filename: string; assertCurrent: () => Promise<void> }): PreflightProbes => {
  const inspect = <T>(filename: string, use: (db: Database) => T) => inspectReadOnly(filename, use, closed !== undefined)
  return {
    async stat(filename) {
      try {
        const stat = await fs.stat(filename)
        return { size: stat.size, mode: stat.mode }
      } catch {
        return null
      }
    },
    async readHeader(filename) {
      const stat = await fs.stat(filename).catch(() => null)
      if (!stat || stat.size === 0) return null
      // Read only the magic, page size and journal-mode bytes. Node's fs.readFile rejects files
      // larger than 2 GiB (ERR_FS_FILE_TOO_LARGE), which made the desktop
      // node-sidecar preflight flag a >2 GiB store as "not a SQLite database".
      const handle = await fs.open(filename, "r").catch(() => null)
      if (!handle) return { headerValid: false, pageSize: 0 }
      try {
        const buffer = Buffer.alloc(20)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (bytesRead < 16) return { headerValid: false, pageSize: 0 }
        const headerValid = buffer.subarray(0, 16).equals(HEADER_MAGIC_BYTES)
        const raw = buffer[16]! | (buffer[17]! << 8)
        const pageSize = raw === 1 ? 65536 : raw
        const journalMode = buffer[18] === 2 && buffer[19] === 2 ? "wal"
          : buffer[18] === 1 && buffer[19] === 1 ? "delete" : null
        return { headerValid, pageSize, journalMode }
      } catch {
        return { headerValid: false, pageSize: 0 }
      } finally {
        await handle.close()
      }
    },
    async readJournalMode(filename) {
      return inspect(filename, (db) => {
        const journal = db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined
        const count = db.query("PRAGMA page_count").get() as { page_count?: number } | undefined
        return { journalMode: journal?.journal_mode ?? null, pageCount: count?.page_count ?? 0 }
      })
    },
    async readJournalRows(filename) {
      return inspect(filename, (db) => {
        const exists = db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'")
          .get() as { name?: string } | undefined
        if (!exists) return []
        return db.query("SELECT * FROM migration").all() as unknown as JournalRow[]
      })
    },
    async readCapabilities(filename) {
      return inspect(filename, (db) => {
        const exists = db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_capability'")
          .get() as { name?: string } | undefined
        if (!exists) return []
        return db
          .query("SELECT capability, minimum_reader_protocol, minimum_writer_protocol FROM database_capability")
          .all() as unknown as CapabilityRow[]
      })
    },
    async readUpgradeRuns(filename) {
      return inspect(filename, (db) => {
        const exists = db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_upgrade_run'")
          .get() as { name?: string } | undefined
        if (!exists) return []
        return db.query("SELECT run_id, state FROM database_upgrade_run").all() as unknown as UpgradeRunRow[]
      })
    },
    async readMigrationReceipts(filename) {
      return inspect(filename, (db) => {
        const exists = db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_migration_receipt'")
          .get() as { name?: string } | undefined
        if (!exists) return []
        return db
          .query(
            "SELECT receipt_id, migration_id, content_hash, ordinal, run_id, build_identity, package_version, body_hash, result FROM database_migration_receipt",
          )
          .all() as unknown as MigrationReceiptIdentityRow[]
      })
    },
    async walShm(filename) {
      const wal = await fs.stat(filename + "-wal").catch(() => null)
      const shm = await fs.stat(filename + "-shm").catch(() => null)
      return {
        walExists: wal !== null,
        walSize: wal?.size ?? 0,
        shmExists: shm !== null,
        shmSize: shm?.size ?? 0,
      }
    },
    async freeSpace(filename) {
      try {
        const statfs = await fs.statfs(filename)
        return Number(statfs.bsize) * Number(statfs.bavail)
      } catch {
        return Number.MAX_SAFE_INTEGER
      }
    },
    async localFilesystem(filename) {
      try {
        const statfs = await fs.statfs(filename)
        const type = (statfs as unknown as { f_type?: number }).f_type ?? 0
        const remoteTypes = new Set([0x6969, 0x517b, 0xff534d42, 0x65735546])
        return !remoteTypes.has(type)
      } catch {
        return true
      }
    },
    async activeProcess(filename) {
      if (closed && filename === closed.filename) {
        await closed.assertCurrent()
        return false // This exact live lease is ours; other owners remain a blocker.
      }
      const lockDir = `${filename}.runtime.lock`
      const active = await DatabaseMigrationLease.processLockActive(lockDir, { staleMs: 15_000 })
      if (active) {
        // "Someone holds the database" is undiagnosable without the holder's identity — surface
        // the lock metadata (pid/hostname/created) so the culprit process is immediately findable.
        const meta = await fs.readFile(path.join(lockDir, "meta.json"), "utf8").catch(() => undefined)
        if (meta) console.error("[preflight] database runtime lock held:", meta.trim())
      }
      return active
    },
  }
}

const defaultProbes = probesForReadOnly()

const gatherObservations = async (
  options: PreflightOptions,
  probes: PreflightProbes,
  inspect = true,
): Promise<PreflightObservations> => {
  const stat = await probes.stat(options.filename)
  const exists = stat !== null
  const size = stat?.size ?? 0
  const mode = stat?.mode ?? null
  const readStat = exists && size > 0
  const readDatabase = readStat && inspect
  const header = readStat ? await probes.readHeader(options.filename) : null
  const journalMode = readDatabase ? await probes.readJournalMode(options.filename) : null
  const journalRows = readDatabase ? (await probes.readJournalRows(options.filename)) ?? [] : []
  const capabilities = readDatabase ? (await probes.readCapabilities(options.filename)) ?? [] : []
  const upgradeRuns = readDatabase ? (await probes.readUpgradeRuns(options.filename)) ?? [] : []
  const migrationReceipts = readDatabase ? (await probes.readMigrationReceipts?.(options.filename)) ?? [] : []
  const walShm = await probes.walShm(options.filename)
  const freeSpaceBytes = await probes.freeSpace(options.filename)
  const localFilesystem = await probes.localFilesystem(options.filename)
  const activeProcess = await probes.activeProcess(options.filename)

  return {
    filename: options.filename,
    exists,
    size,
    mode,
    sqliteHeaderValid: header?.headerValid ?? false,
    pageSize: header?.pageSize ?? null,
    pageCount: journalMode?.pageCount ?? null,
    journalMode: journalMode?.journalMode ?? header?.journalMode ?? null,
    dbReadable: readStat ? journalMode !== null : true,
    journalRows,
    capabilities,
    upgradeRuns,
    migrationReceipts,
    walExists: walShm.walExists,
    walSize: walShm.walSize,
    shmExists: walShm.shmExists,
    shmSize: walShm.shmSize,
    freeSpaceBytes,
    localFilesystem,
    activeProcess,
  }
}

export const analyzePreflight = (
  options: PreflightOptions,
  observations: PreflightObservations,
): PreflightResult => {
  const issues: PreflightIssue[] = []
  const canonicalize = (id: string): string => options.historicalAliases[id] ?? id
  const completed = new Set(observations.journalRows.map((row) => canonicalize(row.id)))
  const known = new Set(options.knownMigrationIds)

  const seen = new Set<string>()
  for (const row of observations.journalRows) {
    if (seen.has(row.id))
      issues.push({
        code: "migration_journal_duplicate_id",
        message: "migration journal contains duplicate id " + row.id,
        resource: row.id,
        actual: row.id,
      })
    seen.add(row.id)
  }

  if (observations.exists && observations.size > 0 && !observations.sqliteHeaderValid)
    issues.push({
      code: "not_a_sqlite_database",
      message: observations.filename + " is not a SQLite database (bad header)",
      resource: observations.filename,
      expected: "SQLite format 3",
      actual: "invalid header",
    })

  // A non-empty existing DB that cannot be opened read-only cannot be proven safe.
  if (observations.exists && observations.size > 0 && !observations.dbReadable)
    issues.push({
      code: "db_open_failed",
      message: "unable to open database read-only: " + observations.filename,
      resource: observations.filename,
    })

  for (const capability of observations.capabilities) {
    if (capability.minimum_reader_protocol > options.readerProtocol || capability.minimum_writer_protocol > options.writerProtocol) {
      issues.push({
        code: "incompatible_binary",
        message: "database capability " + capability.capability + " requires reader " + capability.minimum_reader_protocol + "/writer " + capability.minimum_writer_protocol + "; runtime " + options.writerProtocol,
        resource: capability.capability,
        expected: { reader: options.readerProtocol, writer: options.writerProtocol },
        actual: { reader: capability.minimum_reader_protocol, writer: capability.minimum_writer_protocol },
      })
    }
  }

  const unknown = [...completed].filter((id) => !known.has(id) && !options.historicalAliases[id]).sort()
  if (unknown.length > 0)
    issues.push({
      code: "migration_journal_unknown_lineage",
      message: "migration journal belongs to an incompatible lineage: " + unknown.join(", "),
      resource: unknown[0]!,
      actual: unknown,
    })

  const contentHashes = options.knownContentHashes ?? {}
  const legacyBoundary = options.legacyContentIdentityBoundary
  const legacyBoundaryIndex = legacyBoundary ? options.knownMigrationIds.indexOf(legacyBoundary) : -1
  const legacyReceiptHashes = new Set(
    (observations.migrationReceipts ?? [])
      .filter(
        (receipt) =>
          (receipt.result === "applied" || receipt.result === "backfilled") &&
          receipt.receipt_id ===
            contentDigest({
              migrationId: receipt.migration_id,
              contentHash: receipt.content_hash,
              ordinal: receipt.ordinal,
              runId: receipt.run_id,
              buildIdentity: receipt.build_identity,
              packageVersion: receipt.package_version,
              bodyHash: receipt.body_hash,
            }),
      )
      .map((receipt) => `${canonicalize(receipt.migration_id)}:${receipt.content_hash}`),
  )
  for (const row of observations.journalRows) {
    const canonical = canonicalize(row.id)
    const expected = contentHashes[canonical]
    const ordinal = options.knownMigrationIds.indexOf(canonical)
    const receiptBackedLegacyIdentity =
      row.content_hash !== null &&
      row.content_hash !== undefined &&
      legacyBoundaryIndex >= 0 &&
      ordinal >= 0 &&
      ordinal <= legacyBoundaryIndex &&
      legacyReceiptHashes.has(`${canonical}:${row.content_hash}`)
    if (expected && row.content_hash && row.content_hash !== expected && !receiptBackedLegacyIdentity)
      issues.push({
        code: "migration_journal_content_mismatch",
        message: "migration " + row.id + " content hash " + row.content_hash + " does not match registry " + expected,
        resource: row.id,
        expected,
        actual: row.content_hash,
      })
  }

  const pending = options.knownMigrationIds.filter((id) => !completed.has(id))

  const firstPendingIndex = pending.length > 0 ? options.knownMigrationIds.indexOf(pending[0]!) : -1
  if (firstPendingIndex >= 0) {
    const anchor = options.mergedHistoryAnchor
    const mergedInsertion = options.mergedHistoryInsertions ?? new Set<string>()
    const reconcileMerged =
      anchor !== undefined &&
      completed.has(anchor) &&
      pending.every((id) => mergedInsertion.has(id))
    const laterCompleted = options.knownMigrationIds.slice(firstPendingIndex + 1).find((id) => completed.has(id))
    if (laterCompleted && !reconcileMerged)
      issues.push({
        code: "migration_journal_gap",
        message: "migration journal has a gap: " + pending[0] + " is missing before " + laterCompleted,
        resource: pending[0]!,
        expected: laterCompleted,
        actual: pending[0],
      })
  }

  const unfinishedRun = observations.upgradeRuns.find((run) => run.state !== "ready")
  if (unfinishedRun)
    issues.push({
      code: "unfinished_upgrade_run",
      message: "upgrade run " + unfinishedRun.run_id + " is in state " + unfinishedRun.state,
      resource: unfinishedRun.run_id,
      actual: unfinishedRun.state,
    })

  const required = options.requiredFreeSpaceBytes ?? 64 * 1024 * 1024
  if (observations.freeSpaceBytes < required)
    issues.push({
      code: "insufficient_space",
      message: "insufficient free space: " + observations.freeSpaceBytes + " bytes free, need " + required,
      resource: observations.filename,
      expected: required,
      actual: observations.freeSpaceBytes,
    })

  if (!observations.localFilesystem)
    issues.push({
      code: "non_local_filesystem",
      message: "database is on a non-local filesystem (no lock semantics)",
      resource: observations.filename,
    })

  if (observations.activeProcess)
    issues.push({
      code: "another_process_active",
      message: "another process holds the database; migration is fenced",
      resource: observations.filename,
    })

  if (issues.length === 0) return { ok: true, observations }
  return { ok: false, observations, issues }
}

const closedFileStamp = async (filename: string) => {
  const entry = await fs.lstat(filename, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.size === 0n)
    throw new Error("closed_readonly_unavailable")
  const handle = await fs.open(filename, "r")
  try {
    const opened = await handle.stat({ bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error("closed_readonly_unavailable")
    const header = Buffer.alloc(100)
    const read = await handle.read(header, 0, header.length, 0)
    if (
      read.bytesRead !== 100 ||
      !header.subarray(0, 16).equals(Buffer.from(SQLITE_HEADER_MAGIC)) ||
      header[18] !== 2 ||
      header[19] !== 2
    )
      throw new Error("closed_readonly_unavailable")
    for (const suffix of ["-wal", "-shm"]) {
      const companion = await fs.lstat(filename + suffix).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
        throw error
      })
      if (companion) throw new Error("closed_readonly_unavailable")
    }
    return [
      entry.dev,
      entry.ino,
      entry.size,
      entry.mode,
      entry.uid,
      entry.gid,
      entry.mtimeNs,
      entry.ctimeNs,
      header.toString("hex"),
    ]
  } finally {
    await handle.close()
  }
}

const ownerMetadata = Schema.fromJsonString(Schema.Struct({ token: Schema.String, pid: Schema.Int }))

/** Keep the entire closed-WAL compatibility/inventory observation under the existing owner lock.
 * The URI never opens writable; active WAL keeps the ordinary read path, including its owner gate. */
export const withReadOnlyPreflight = async <A,>(
  options: PreflightOptions,
  use: (result: PreflightResult, readonlyFilename: string) => Promise<A> | A,
  unavailable: (result: PreflightResult) => Promise<A> | A,
  probes?: PreflightProbes,
): Promise<A> => {
  // Even SQLITE_OPEN_READONLY can create WAL/SHM in a writable directory. Select the
  // fenced closed-file path before opening SQLite, while live WAL keeps ordinary RO.
  const observations = await gatherObservations(options, probes ?? defaultProbes, probes !== undefined)
  const original = analyzePreflight(options, observations)
  if (probes || !observations.exists || observations.size === 0) return use(original, options.filename)
  if (!observations.sqliteHeaderValid || !observations.localFilesystem) return unavailable(original)
  if (observations.walExists || observations.shmExists || observations.journalMode === "delete") {
    return use(analyzePreflight(options, await gatherObservations(options, defaultProbes)), options.filename)
  }
  if (observations.journalMode !== "wal") return unavailable(original)
  if (observations.activeProcess) return unavailable(original)
  const before = await closedFileStamp(options.filename).catch(() => undefined)
  if (!before) return unavailable(original)
  const obtained = await Effect.runPromise(
    Effect.result(
      DatabaseMigrationLease.acquireProcessLock(`${options.filename}.runtime.lock`, {
        staleMs: 15_000,
        timeoutMs: 0,
      }),
    ),
  )
  if (Result.isFailure(obtained)) return unavailable(original)
  const lock = obtained.success
  try {
    const assertCurrent = async () => {
      const actual = await closedFileStamp(options.filename)
      if (!actual.every((value, index) => value === before[index])) throw new Error("closed_readonly_unavailable")
      const owner = Schema.decodeUnknownSync(ownerMetadata)(await fs.readFile(path.join(lock.dir, "meta.json"), "utf8"))
      if (owner.token !== lock.token || owner.pid !== process.pid) throw new Error("closed_readonly_unavailable")
    }
    const guarded = await assertCurrent()
      .then(() => true)
      .catch(() => false)
    if (!guarded) return unavailable(original)
    const current = await gatherObservations(options, probesForReadOnly({ filename: options.filename, assertCurrent }))
      .then((value) => analyzePreflight(options, value))
      .catch(() => undefined)
    if (!current) return unavailable(original)
    const uri = pathToFileURL(options.filename)
    uri.searchParams.set("mode", "ro")
    uri.searchParams.set("immutable", "1")
    const result = await use(current, uri.href)
    const unchanged = await assertCurrent()
      .then(() => true)
      .catch(() => false)
    return unchanged ? result : unavailable(original)
  } finally {
    await Effect.runPromise(lock.release)
  }
}

export const preflight = async (options: PreflightOptions, probes?: PreflightProbes): Promise<PreflightResult> =>
  withReadOnlyPreflight(
    options,
    (result) => result,
    (result) => result,
    probes,
  )
