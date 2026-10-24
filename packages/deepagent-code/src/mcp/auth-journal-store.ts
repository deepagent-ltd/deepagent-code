import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Global } from "@deepagent-code/core/global"
import type { McpWindowsStorage } from "./windows-storage"
import { WindowsPrivateStorage } from "@/installation/windows-private-storage"
import { McpAuthJournalSchema } from "./auth-journal-schema"

type Value = string | number | null
export interface Database {
  exec: (text: string) => void
  query: (text: string) => {
    get: (...values: Value[]) => unknown
    all: (...values: Value[]) => unknown[]
    run: (...values: Value[]) => unknown
  }
  close: () => void
}

export interface Store {
  readonly read: <T>(body: (db: Database) => T) => T
  readonly transaction: <T>(body: (db: Database) => T) => T
  readonly close: () => void
}

const statements = McpAuthJournalSchema.SQL.split(";")
  .map((item) => item.trim())
  .filter(Boolean)
const expected = new Map(
  statements.map((text) => {
    const name = /^CREATE (?:UNIQUE )?(?:TABLE|INDEX) ([a-z_]+)/.exec(text)?.[1]
    if (!name) throw new McpAuthJournalSchema.Error("invalid")
    return [name, normalize(text)]
  }),
)

/** No business Root or migration lease is opened. Each operation uses SQLite's
 * actual transaction lock; an expiring filesystem heartbeat is not its CAS. */
export async function open(file: string, installationTag: string, mode: "read" | "write", native?: McpWindowsStorage.Port): Promise<Store | undefined> {
  if (!Schema.is(McpAuthJournalSchema.Tag)(installationTag)) throw new McpAuthJournalSchema.Error("invalid")
  const custody = process.platform === "win32" ? await openWindows(file, mode, native) : openPosix(file, mode)
  if (!custody) return undefined
  let database: Database | undefined
  const lifetime = { closed: false }
  const secure = () => {
    if (lifetime.closed) throw new McpAuthJournalSchema.Error("unavailable")
    custody.secure()
  }
  const close = () => {
    if (lifetime.closed) return
    lifetime.closed = true
    try { database?.close() }
    finally { custody.close() }
  }
  try {
    custody.bindClose?.(close)
    secure()
    const { PrivateSqlite } = await import("@deepagent-code/core/database/private-sqlite")
    // Root may retire while the driver module is loading. Never construct a new
    // connection after its original native custody has already been released.
    secure()
    database = new PrivateSqlite.Database(file, {
      readonly: mode === "read",
      readwrite: mode === "write",
      create: false,
    })
    const db = database
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; PRAGMA mmap_size=0; PRAGMA cache_size=-2048;")
    secure()
    if (mode === "write") {
      // No secret rows are created until the exact schema is committed. A cold
      // reader never performs this initialization or any rollback recovery.
      const journal = db.query("PRAGMA journal_mode").get()
      if (!record(journal) || journal.journal_mode !== "delete") throw new McpAuthJournalSchema.Error("invalid")
      db.exec("PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=4096;")
      db.exec("BEGIN IMMEDIATE")
      const progress = { commit: false }
      try {
        const existing = db.query("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
        if (existing.length === 0) {
          const version = db.query("PRAGMA user_version").get()
          if (!record(version) || version.user_version !== 0) throw new McpAuthJournalSchema.Error("invalid")
          statements.forEach((text) => db.exec(text))
          db.query("INSERT INTO mcp_auth_meta(id,version,installation_tag,created_at) VALUES(1,1,?,?)").run(
            installationTag,
            Date.now(),
          )
          db.exec("PRAGMA user_version=1")
        }
        const version = requireSchema(db, installationTag)
        requireCapacity(db)
        if (version === 1) {
          const before = retainedRows(db)
          before.slots.forEach((row) => {
            if (McpAuthJournalSchema.decodeSlot(row).credentials.clientInfo?.registeredRedirectUris !== undefined)
              throw new McpAuthJournalSchema.Error("invalid")
          })
          before.operations.forEach(McpAuthJournalSchema.decodeOperation)
          const now = Date.now()
          db.exec(McpAuthJournalSchema.EXTENSION_SQL)
          db.query(
            "INSERT INTO mcp_auth_extension(id,version,base_schema_sha256,created_at) SELECT 1,2,?,? FROM mcp_auth_meta WHERE id=1 AND version=1 AND installation_tag=? AND created_at<=?",
          ).run(McpAuthJournalSchema.BASE_SQL_SHA256, now, installationTag, now)
          db.exec("PRAGMA user_version=2")
          if (requireSchema(db, installationTag) !== 2 || JSON.stringify(retainedRows(db)) !== JSON.stringify(before))
            throw new McpAuthJournalSchema.Error("changed")
          requireCapacity(db)
        }
        secure()
        progress.commit = true
        db.exec("COMMIT")
        custody.afterCommit(true)
      } catch (error) {
        rollback(db)
        if (progress.commit) {
          // Observe only; neither a lost COMMIT reply nor fsync failure permits another migration write.
          try {
            requireSchema(db, installationTag)
          } catch {
            /* Keep the uncertain result. */
          }
          throw new McpAuthJournalSchema.Error("unknown")
        }
        throw error
      }
    }
    requireSchema(db, installationTag)
    requireCapacity(db)
    secure()
    return {
      read: (body) => {
        try {
          secure()
          db.exec("BEGIN")
          requireSchema(db, installationTag)
          requireCapacity(db)
          const result = body(db)
          if (result instanceof Promise) throw new McpAuthJournalSchema.Error("invalid")
          secure()
          db.exec("COMMIT")
          return result
        } catch (error) {
          rollback(db)
          throw safeError(error)
        }
      },
      transaction: (body) => {
        if (mode !== "write") throw new McpAuthJournalSchema.Error("unavailable")
        const progress = { commit: false }
        try {
          secure()
          db.exec("BEGIN IMMEDIATE")
          requireSchema(db, installationTag)
          requireCapacity(db)
          const result = body(db)
          if (result instanceof Promise) throw new McpAuthJournalSchema.Error("invalid")
          requireSchema(db, installationTag)
          requireCapacity(db)
          secure()
          progress.commit = true
          db.exec("COMMIT")
          custody.afterCommit(false)
          secure()
          return result
        } catch (error) {
          rollback(db)
          if (progress.commit) throw new McpAuthJournalSchema.Error("unknown")
          throw safeError(error)
        }
      },
      close,
    }
  } catch (error) {
    close()
    throw safeError(error)
  }
}

type Custody = {
  secure: () => void
  afterCommit: (initial: boolean) => void
  close: () => void
  bindClose?: (close: () => void) => void
}
async function openWindows(file: string, mode: "read" | "write", native: McpWindowsStorage.Port | undefined): Promise<Custody | undefined> {
  if (!native || file !== path.join(Global.Path.config, "mcp-oauth", "journal.sqlite"))
    throw new McpAuthJournalSchema.Error("unavailable")
  try {
    const lease = await native.openJournal(mode)
    return lease && { secure: lease.current, afterCommit: () => lease.flush(), close: lease.close, bindClose: lease.bindClose }
  } catch (error) { throw safeError(error) }
}
function openPosix(file: string, mode: "read" | "write"): Custody | undefined {
  if (!process.getuid) throw new McpAuthJournalSchema.Error("unavailable")
  const parent = path.dirname(file)
  if (mode === "write") mkdirSync(parent, { recursive: true, mode: 0o700 })
  const directory = observe(parent, "directory")
  if (!directory) {
    if (mode === "read") return undefined
    throw new McpAuthJournalSchema.Error("unavailable")
  }
  const descriptor = openDescriptor(file, mode)
  if (descriptor === undefined) return undefined
  const opened = fstatSync(descriptor)
  const lifetime = { closed: false }
  const secure = () => {
    if (lifetime.closed) throw new McpAuthJournalSchema.Error("unavailable")
    const actual = observe(file, "file")
    const currentDirectory = observe(parent, "directory")
    const fd = fstatSync(descriptor)
    if (
      !actual ||
      !currentDirectory ||
      !sameIdentity(actual, opened) ||
      !sameIdentity(actual, fd) ||
      !sameIdentity(currentDirectory, directory, false) ||
      realpathSync(parent) !== parent ||
      realpathSync(file) !== file
    )
      throw new McpAuthJournalSchema.Error("changed")
    if (fd.size > McpAuthJournalSchema.LIMITS.pageBytes * McpAuthJournalSchema.LIMITS.maxPages)
      throw new McpAuthJournalSchema.Error("capacity")
    // DELETE journaling is fixed. Never open an attacker-selected sidecar or
    // silently adopt a store that another runtime changed to WAL.
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const sidecar = observe(`${file}${suffix}`, "file")
      if (sidecar && suffix !== "-journal") throw new McpAuthJournalSchema.Error("invalid")
      if (
        sidecar &&
        sidecar.size > McpAuthJournalSchema.LIMITS.pageBytes * McpAuthJournalSchema.LIMITS.maxPages + 1048576
      )
        throw new McpAuthJournalSchema.Error("capacity")
    }
  }
  return {
    secure,
    afterCommit: (initial) => {
      if (!initial) return
      fsyncSync(descriptor)
      const parentDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(parentDescriptor) } finally { closeSync(parentDescriptor) }
    },
    close: () => { if (lifetime.closed) return; lifetime.closed = true; closeSync(descriptor) },
  }
}

function openDescriptor(file: string, mode: "read" | "write") {
  try {
    return openSync(
      file,
      (mode === "read" ? constants.O_RDONLY : constants.O_RDWR) | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if (errno(error) !== "ENOENT") throw new McpAuthJournalSchema.Error("unavailable")
    if (mode === "read") return undefined
    try {
      return openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if (errno(error) === "EEXIST") return openDescriptor(file, "write")
      throw new McpAuthJournalSchema.Error("unavailable")
    }
  }
}

function observe(file: string, kind: "file" | "directory") {
  try {
    const stat = lstatSync(file)
    if (
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o077) !== 0 ||
      (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    )
      throw new McpAuthJournalSchema.Error("unavailable")
    return stat
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined
    throw safeError(error)
  }
}

function sameIdentity(left: Stats, right: Stats, file = true) {
  // APFS directory link counts change when SQLite creates/removes a journal.
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    (!file || left.nlink === right.nlink)
  )
}

function requireSchema(db: Database, installationTag: string) {
  const version = db.query("PRAGMA user_version").get()
  if (!record(version) || (version.user_version !== 1 && version.user_version !== 2))
    throw new McpAuthJournalSchema.Error("invalid")
  const rows = db
    .query("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL LIMIT 9")
    .all()
  if (rows.length !== expected.size + (version.user_version === 2 ? 1 : 0))
    throw new McpAuthJournalSchema.Error("invalid")
  for (const row of rows) {
    if (
      !record(row) ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string" ||
      (version.user_version === 2 && row.name === "mcp_auth_extension"
        ? normalize(McpAuthJournalSchema.EXTENSION_SQL)
        : expected.get(row.name)) !== normalize(row.sql)
    )
      throw new McpAuthJournalSchema.Error("invalid")
  }
  const meta = db.query("SELECT * FROM mcp_auth_meta LIMIT 2").all()
  if (
    meta.length !== 1 ||
    !record(meta[0]) ||
    meta[0].id !== 1 ||
    meta[0].version !== 1 ||
    meta[0].installation_tag !== installationTag ||
    !Schema.is(McpAuthJournalSchema.Integer)(meta[0].created_at)
  )
    throw new McpAuthJournalSchema.Error("changed")
  if (version.user_version === 2) {
    const extension = db.query("SELECT * FROM mcp_auth_extension LIMIT 2").all()
    if (
      extension.length !== 1 ||
      !record(extension[0]) ||
      extension[0].id !== 1 ||
      extension[0].version !== 2 ||
      extension[0].base_schema_sha256 !== McpAuthJournalSchema.BASE_SQL_SHA256 ||
      !Schema.is(McpAuthJournalSchema.Integer)(extension[0].created_at) ||
      Number(extension[0].created_at) < Number(meta[0].created_at)
    )
      throw new McpAuthJournalSchema.Error("invalid")
  }
  const journal = db.query("PRAGMA journal_mode").get()
  const foreign = db.query("PRAGMA foreign_keys").get()
  const pages = db.query("PRAGMA page_size").get()
  if (
    !record(journal) ||
    journal.journal_mode !== "delete" ||
    !record(foreign) ||
    foreign.foreign_keys !== 1 ||
    !record(pages) ||
    pages.page_size !== 4096
  )
    throw new McpAuthJournalSchema.Error("invalid")
  return version.user_version
}

function retainedRows(db: Database) {
  return {
    meta: db.query("SELECT * FROM mcp_auth_meta ORDER BY id").all(),
    slots: db.query("SELECT * FROM mcp_auth_slot ORDER BY slot_key").all(),
    operations: db.query("SELECT * FROM mcp_oauth_operation ORDER BY operation_id").all(),
  }
}

function requireCapacity(db: Database) {
  const version = db.query("PRAGMA user_version").get()
  if (!record(version) || (version.user_version !== 1 && version.user_version !== 2))
    throw new McpAuthJournalSchema.Error("invalid")
  const available =
    McpAuthJournalSchema.LIMITS.logicalBytes -
    (version.user_version === 2 ? McpAuthJournalSchema.LIMITS.extensionCharge : 0)
  const slots = db
    .query(
      `SELECT COUNT(*) AS count,
    COALESCE(SUM(length(CAST(binding AS BLOB))+length(CAST(credentials AS BLOB))+length(CAST(flow AS BLOB))+512),0) AS bytes,
    COALESCE(SUM(CASE WHEN json_extract(flow,'$.phase') IN ('preparing','awaiting_callback') THEN 1 ELSE 0 END),0) AS active
    FROM mcp_auth_slot`,
    )
    .get()
  const operations = db
    .query(
      "SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(outcome AS BLOB))+1024),0) AS bytes FROM mcp_oauth_operation",
    )
    .get()
  if (
    !record(slots) ||
    !record(operations) ||
    ![slots.count, slots.bytes, slots.active, operations.count, operations.bytes].every((value) =>
      Schema.is(McpAuthJournalSchema.Integer)(value),
    )
  )
    throw new McpAuthJournalSchema.Error("invalid")
  if (
    Number(slots.count) > McpAuthJournalSchema.LIMITS.slots ||
    Number(slots.active) > McpAuthJournalSchema.LIMITS.activeFlows ||
    Number(operations.count) > McpAuthJournalSchema.LIMITS.operations ||
    Number(slots.bytes) > available ||
    Number(operations.bytes) > available - Number(slots.bytes)
  )
    throw new McpAuthJournalSchema.Error("capacity")
}

function normalize(text: string) {
  // Normalize whitespace outside literals only. Literal case/escapes are schema facts.
  const state = { quote: "", space: false, output: "" }
  for (const character of text.trim()) {
    if (state.quote) {
      state.output += character
      if (character === state.quote) state.quote = ""
      continue
    }
    if (/\s/.test(character)) {
      state.space = true
      continue
    }
    if (state.space) state.output += " "
    state.space = false
    state.output += character
    if (character === "'" || character === '"') state.quote = character
  }
  return state.output.replace(/;$/, "")
}

function rollback(db: Database) {
  try {
    db.exec("ROLLBACK")
  } catch {
    /* A completed COMMIT has no transaction to roll back. */
  }
}

function errno(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeError(error: unknown) {
  return error instanceof McpAuthJournalSchema.Error ? error : new McpAuthJournalSchema.Error(
    error instanceof WindowsPrivateStorage.Error ? error.reason : "unavailable")
}

export * as McpAuthJournalStore from "./auth-journal-store"
