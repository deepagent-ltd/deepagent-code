import { mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"

/**
 * Filesystem-backed share store.
 *
 * Replaces the Cloudflare Durable Object storage + R2 bucket used by the
 * original worker. Each share is a directory under {@link baseDir}:
 *
 *   <baseDir>/<shareId>/meta.json   -> { secret, sessionID }
 *   <baseDir>/<shareId>/data.json   -> { [storageKey]: content }
 *
 * `shareId` is the short name (last 8 chars) of the session id, matching the
 * addressing scheme the web viewer already uses (`/s/<short>`).
 */
export type ShareEntry = { key: string; content: unknown }

type Meta = { secret: string; sessionID: string }
type Data = Record<string, unknown>

const ShareID = /^[A-Za-z0-9_-]{1,128}$/
const SessionID = /^[A-Za-z0-9_-]{8,256}$/
const MaxEntries = 10_000
const MaxEntryBytes = 1024 * 1024
const MaxDataBytes = 16 * 1024 * 1024
const MaxShares = 10_000
const MaxStoreBytes = 10 * 1024 * 1024 * 1024
const LockStaleMs = 30_000
const LockTimeoutMs = 10_000
const GlobalQuotaLock = "global-quota"

export function isValidShareID(id: string) {
  return ShareID.test(id) && id !== GlobalQuotaLock
}

export function isValidSessionID(id: unknown): id is string {
  return typeof id === "string" && SessionID.test(id)
}

function requireShareID(id: string) {
  if (!isValidShareID(id)) throw new Error("Invalid share ID")
  return id
}

export function shortName(id: string) {
  if (!isValidSessionID(id)) throw new Error("Invalid session ID")
  return id.substring(id.length - 8)
}

export class ShareStore {
  private readonly baseDir: string
  private readonly pending = new Map<string, Promise<void>>()
  private readonly maxShares: number
  private readonly maxStoreBytes: number

  constructor(baseDir: string, limits: { maxShares?: number; maxStoreBytes?: number } = {}) {
    this.baseDir = resolve(baseDir)
    this.maxShares = limits.maxShares ?? MaxShares
    this.maxStoreBytes = limits.maxStoreBytes ?? MaxStoreBytes
  }

  private dir(shareId: string) {
    return join(this.baseDir, requireShareID(shareId))
  }

  private metaPath(shareId: string) {
    return join(this.dir(shareId), "meta.json")
  }

  private dataPath(shareId: string) {
    return join(this.dir(shareId), "data.json")
  }

  private lockPath(shareId: string) {
    return join(this.baseDir, ".locks", `${requireShareID(shareId)}.lock`)
  }

  private async readMeta(shareId: string): Promise<Meta | undefined> {
    const path = this.metaPath(shareId)
    if (!existsSync(path)) return undefined
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<Meta>
    if (typeof value.secret !== "string" || !value.secret || typeof value.sessionID !== "string")
      throw new Error("Invalid share metadata")
    return { secret: value.secret, sessionID: value.sessionID }
  }

  private async readData(shareId: string): Promise<Data> {
    const path = this.dataPath(shareId)
    if (!existsSync(path)) return {}
    const value = JSON.parse(await readFile(path, "utf8")) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid share data")
    return value as Data
  }

  private async writeData(shareId: string, data: Data) {
    const encoded = JSON.stringify(data)
    if (Buffer.byteLength(encoded) > MaxDataBytes) throw new Error("Share data exceeds storage limit")
    await this.atomicWrite(this.dataPath(shareId), encoded)
  }

  private async atomicWrite(file: string, content: string) {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temp, "wx", 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temp, file)
      const directory = await open(dirname(file), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  private async withShareLock<T>(shareId: string, body: () => Promise<T>): Promise<T> {
    const key = shareId === GlobalQuotaLock ? shareId : requireShareID(shareId)
    const previous = this.pending.get(key) ?? Promise.resolve()
    let release = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = previous.catch(() => {}).then(() => barrier)
    this.pending.set(key, current)
    await previous.catch(() => {})
    let releaseFileLock = async () => {}
    try {
      releaseFileLock = await this.acquireFileLock(key)
      return await body()
    } finally {
      await releaseFileLock()
      release()
      if (this.pending.get(key) === current) this.pending.delete(key)
    }
  }

  private async acquireFileLock(shareId: string) {
    const lock =
      shareId === GlobalQuotaLock ? join(this.baseDir, ".locks", `${GlobalQuotaLock}.lock`) : this.lockPath(shareId)
    const owner = `${process.pid}:${randomUUID()}`
    const deadline = Date.now() + LockTimeoutMs
    await mkdir(join(this.baseDir, ".locks"), { recursive: true })

    while (true) {
      try {
        await mkdir(lock)
        const ownerPath = join(lock, "owner")
        await writeFile(ownerPath, owner, { flag: "wx", mode: 0o600 })
        const heartbeat = setInterval(
          () => {
            const now = new Date()
            void utimes(ownerPath, now, now).catch(() => {})
          },
          Math.max(100, Math.floor(LockStaleMs / 3)),
        )
        heartbeat.unref?.()
        return async () => {
          clearInterval(heartbeat)
          const current = await readFile(ownerPath, "utf8").catch(() => "")
          if (current !== owner) throw new Error(`Refusing to release a share lock not owned by this process`)
          await rm(lock, { recursive: true, force: true })
        }
      } catch (error) {
        if (!isCode(error, "EEXIST")) {
          await rm(lock, { recursive: true, force: true }).catch(() => {})
          throw error
        }
        const age =
          Date.now() -
          (await stat(join(lock, "owner"))
            .then((value) => value.mtimeMs)
            .catch(() =>
              stat(lock)
                .then((value) => value.mtimeMs)
                .catch(() => Date.now()),
            ))
        if (age > LockStaleMs) {
          const stale = `${lock}.stale.${randomUUID()}`
          await rename(lock, stale)
            .then(() => rm(stale, { recursive: true, force: true }))
            .catch(() => {})
          continue
        }
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring share lock for ${shareId}`)
        await Bun.sleep(10)
      }
    }
  }

  private async withGlobalQuotaLock<T>(body: () => Promise<T>) {
    return this.withShareLock(GlobalQuotaLock, body)
  }

  private async storageUsage() {
    await mkdir(this.baseDir, { recursive: true })
    const shares = (await readdir(this.baseDir, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && isValidShareID(entry.name),
    )
    const bytes = (
      await Promise.all(
        shares.map(async (entry) =>
          (
            await Promise.all(
              (await readdir(join(this.baseDir, entry.name), { withFileTypes: true }))
                .filter((file) => file.isFile())
                .map((file) => stat(join(this.baseDir, entry.name, file.name)).then((value) => value.size)),
            )
          ).reduce((total, size) => total + size, 0),
        ),
      )
    ).reduce((total, size) => total + size, 0)
    return { shares: shares.length, bytes }
  }

  private async requireQuota(additionalBytes: number, newShare: boolean) {
    const usage = await this.storageUsage()
    if (newShare && usage.shares >= this.maxShares) throw new Error("Share count exceeds storage limit")
    if (usage.bytes + additionalBytes > this.maxStoreBytes) throw new Error("Share store exceeds storage limit")
  }

  /** Create the share if it does not exist yet; return its secret. */
  async share(sessionID: string): Promise<string> {
    const shareId = shortName(sessionID)
    return this.withShareLock(shareId, async () => {
      const existing = await this.readMeta(shareId)
      if (existing?.sessionID !== sessionID && existing !== undefined) throw new Error("Share ID collision")
      if (existing) return existing.secret

      return this.withGlobalQuotaLock(async () => {
        const secret = randomUUID()
        const metadata = JSON.stringify({ secret, sessionID } satisfies Meta)
        await this.requireQuota(Buffer.byteLength(metadata) + Buffer.byteLength("{}"), true)
        await mkdir(this.dir(shareId), { recursive: true })
        try {
          await this.writeData(shareId, {})
          await this.atomicWrite(this.metaPath(shareId), metadata)
          return secret
        } catch (error) {
          await rm(this.dir(shareId), { recursive: true, force: true }).catch(() => {})
          throw error
        }
      })
    })
  }

  async assertSecret(shareId: string, secret: string): Promise<void> {
    const meta = await this.readMeta(shareId)
    if (!meta || !sameSecret(meta.secret, secret)) throw new ShareAuthorizationError()
  }

  /**
   * Store a single entry after validating that its key belongs to this share's
   * session. Returns the stored entry so callers can broadcast it.
   */
  async publish(shareId: string, secret: string, key: string, content: unknown): Promise<ShareEntry> {
    return this.withShareLock(shareId, async () => {
      const meta = await this.readMeta(shareId)
      if (!meta) throw new Error("Unknown share")
      if (!sameSecret(meta.secret, secret)) throw new ShareAuthorizationError()
      const sessionID = meta.sessionID
      if (
        !key.startsWith(`session/info/${sessionID}`) &&
        !key.startsWith(`session/message/${sessionID}/`) &&
        !key.startsWith(`session/part/${sessionID}/`)
      ) {
        throw new Error("Invalid key")
      }
      if (Buffer.byteLength(JSON.stringify(content)) > MaxEntryBytes)
        throw new Error("Share entry exceeds storage limit")

      const data = await this.readData(shareId)
      if (!(key in data) && Object.keys(data).length >= MaxEntries) throw new Error("Share entry count exceeds limit")
      data[key] = content
      const encoded = JSON.stringify(data)
      if (Buffer.byteLength(encoded) > MaxDataBytes) throw new Error("Share data exceeds storage limit")
      const previousBytes = await stat(this.dataPath(shareId))
        .then((value) => value.size)
        .catch(() => 0)
      await this.withGlobalQuotaLock(async () => {
        await this.requireQuota(Buffer.byteLength(encoded) - previousBytes, false)
        await this.atomicWrite(this.dataPath(shareId), encoded)
      })
      return { key, content }
    })
  }

  /** All `session/*` entries for a share (used for initial sync + viewer data). */
  async getData(shareId: string): Promise<ShareEntry[]> {
    const data = await this.readData(shareId)
    return Object.entries(data)
      .filter(([key]) => key.startsWith("session/"))
      .map(([key, content]) => ({ key, content }))
  }

  async exists(shareId: string): Promise<boolean> {
    return (await this.readMeta(shareId)) !== undefined
  }

  async clear(shareId: string): Promise<void> {
    await this.withShareLock(shareId, () =>
      this.withGlobalQuotaLock(() => rm(this.dir(shareId), { recursive: true, force: true })),
    )
  }

  async clearAuthorized(shareId: string, secret: string): Promise<void> {
    await this.withShareLock(shareId, async () => {
      await this.assertSecret(shareId, secret)
      await this.withGlobalQuotaLock(() => rm(this.dir(shareId), { recursive: true, force: true }))
    })
  }
}

export class ShareAuthorizationError extends Error {
  constructor() {
    super("Invalid share secret")
    this.name = "ShareAuthorizationError"
  }
}

function sameSecret(expected: string, actual: string) {
  return timingSafeEqual(createHash("sha256").update(expected).digest(), createHash("sha256").update(actual).digest())
}

function isCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}
