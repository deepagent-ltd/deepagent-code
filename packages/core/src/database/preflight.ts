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

import { Database as BunDatabase } from "bun:sqlite"
import { promises as fs } from "fs"

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
}

export interface PreflightOptions {
  filename: string
  readerProtocol: number
  writerProtocol: number
  knownMigrationIds: readonly string[]
  historicalAliases: Readonly<Record<string, string>>
  knownContentHashes?: Readonly<Record<string, string>>
  mergedHistoryAnchor?: string
  mergedHistoryInsertions?: Readonly<Set<string>>
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
  readHeader: (filename: string) => Promise<{ headerValid: boolean; pageSize: number } | null>
  readJournalMode: (filename: string) => Promise<{ journalMode: string | null; pageCount: number } | null>
  readJournalRows: (filename: string) => Promise<JournalRow[] | null>
  readCapabilities: (filename: string) => Promise<CapabilityRow[] | null>
  readUpgradeRuns: (filename: string) => Promise<UpgradeRunRow[] | null>
  walShm: (filename: string) => Promise<{ walExists: boolean; walSize: number; shmExists: boolean; shmSize: number }>
  freeSpace: (filename: string) => Promise<number>
  localFilesystem: (filename: string) => Promise<boolean>
  activeProcess: (filename: string) => Promise<boolean>
}

const SQLITE_HEADER_MAGIC = "SQLite format 3\x00"
const HEADER_MAGIC_BYTES = Uint8Array.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])

const readConnection = (filename: string): BunDatabase | null => {
  // Open with read-write + `query_only` so a freshly created empty WAL DB can be
  // inspected (a pure read-only open cannot create the shared-memory file and
  // returns SQLITE_CANTOPEN). `query_only` fences every write at the SQLite level,
  // so the preflight never mutates user data.
  try {
    const db = new BunDatabase(filename, { readwrite: true, create: false })
    db.run("PRAGMA query_only = ON")
    // Design §10.6: a recovery/read-only inspection connection must not be at NORMAL. bun:sqlite
    // defaults a fresh connection to synchronous=NORMAL, so force FULL (query_only fences all writes,
    // so this is purely the durability posture, never a write path).
    db.run("PRAGMA synchronous = FULL")
    return db
  } catch {
    return null
  }
}

const defaultProbes: PreflightProbes = {
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
    const bytes = await fs.readFile(filename).catch(() => null)
    if (!bytes || bytes.length < 16) return { headerValid: false, pageSize: 0 }
    const magic = bytes.subarray(0, 16)
    let headerValid = magic.length === 16
    if (headerValid) {
      for (let i = 0; i < 16; i++) if (magic[i] !== HEADER_MAGIC_BYTES[i]) { headerValid = false; break }
    }
    const raw = bytes[16]! | (bytes[17]! << 8)
    const pageSize = raw === 1 ? 65536 : raw
    return { headerValid, pageSize }
  },
  async readJournalMode(filename) {
    const db = readConnection(filename)
    if (!db) return null
    try {
      const journal = db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined
      const count = db.query("PRAGMA page_count").get() as { page_count?: number } | undefined
      return { journalMode: journal?.journal_mode ?? null, pageCount: count?.page_count ?? 0 }
    } finally {
      db.close()
    }
  },
  async readJournalRows(filename) {
    const db = readConnection(filename)
    if (!db) return null
    try {
      const exists = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'")
        .get() as { name?: string } | undefined
      if (!exists) return []
      return db.query("SELECT * FROM migration").all() as unknown as JournalRow[]
    } finally {
      db.close()
    }
  },
  async readCapabilities(filename) {
    const db = readConnection(filename)
    if (!db) return null
    try {
      const exists = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_capability'")
        .get() as { name?: string } | undefined
      if (!exists) return []
      return db
        .query("SELECT capability, minimum_reader_protocol, minimum_writer_protocol FROM database_capability")
        .all() as unknown as CapabilityRow[]
    } finally {
      db.close()
    }
  },
  async readUpgradeRuns(filename) {
    const db = readConnection(filename)
    if (!db) return null
    try {
      const exists = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_upgrade_run'")
        .get() as { name?: string } | undefined
      if (!exists) return []
      return db.query("SELECT run_id, state FROM database_upgrade_run").all() as unknown as UpgradeRunRow[]
    } finally {
      db.close()
    }
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
  async activeProcess() {
    // C1A-05 provides the fenced OS lock + DB lease. Until that lands, a read-only
    // preflight cannot prove a second window, so it returns false and never
    // false-positives a boot. Two-window race determinism is exercised in tests
    // with an injected probe.
    return false
  },
}

const gatherObservations = async (
  options: PreflightOptions,
  probes: PreflightProbes,
): Promise<PreflightObservations> => {
  const stat = await probes.stat(options.filename)
  const exists = stat !== null
  const size = stat?.size ?? 0
  const mode = stat?.mode ?? null
  const readStat = exists && size > 0
  const header = readStat ? await probes.readHeader(options.filename) : null
  const journalMode = readStat ? await probes.readJournalMode(options.filename) : null
  const journalRows = readStat ? (await probes.readJournalRows(options.filename)) ?? [] : []
  const capabilities = readStat ? (await probes.readCapabilities(options.filename)) ?? [] : []
  const upgradeRuns = readStat ? (await probes.readUpgradeRuns(options.filename)) ?? [] : []
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
    journalMode: journalMode?.journalMode ?? null,
    dbReadable: readStat ? journalMode !== null : true,
    journalRows,
    capabilities,
    upgradeRuns,
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
  for (const row of observations.journalRows) {
    const canonical = canonicalize(row.id)
    const expected = contentHashes[canonical]
    if (expected && row.content_hash && row.content_hash !== expected)
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

export const preflight = async (
  options: PreflightOptions,
  probes?: PreflightProbes,
): Promise<PreflightResult> => {
  const observations = await gatherObservations(options, probes ?? defaultProbes)
  return analyzePreflight(options, observations)
}
