import { mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

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
export type ShareEntry = { key: string; content: any }

type Meta = { secret: string; sessionID: string }
type Data = Record<string, any>

export function shortName(id: string) {
  return id.substring(id.length - 8)
}

export class ShareStore {
  private readonly baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  private dir(shareId: string) {
    return join(this.baseDir, shareId)
  }

  private metaPath(shareId: string) {
    return join(this.dir(shareId), "meta.json")
  }

  private dataPath(shareId: string) {
    return join(this.dir(shareId), "data.json")
  }

  private async readMeta(shareId: string): Promise<Meta | undefined> {
    const path = this.metaPath(shareId)
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(await readFile(path, "utf8")) as Meta
    } catch {
      return undefined
    }
  }

  private async readData(shareId: string): Promise<Data> {
    const path = this.dataPath(shareId)
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(await readFile(path, "utf8")) as Data
    } catch {
      return {}
    }
  }

  private async writeData(shareId: string, data: Data) {
    await writeFile(this.dataPath(shareId), JSON.stringify(data))
  }

  /** Create the share if it does not exist yet; return its secret. */
  async share(sessionID: string): Promise<string> {
    const shareId = shortName(sessionID)
    const existing = await this.readMeta(shareId)
    if (existing) return existing.secret

    const secret = randomUUID()
    await mkdir(this.dir(shareId), { recursive: true })
    await writeFile(this.metaPath(shareId), JSON.stringify({ secret, sessionID } satisfies Meta))
    await this.writeData(shareId, {})
    return secret
  }

  async assertSecret(shareId: string, secret: string): Promise<void> {
    const meta = await this.readMeta(shareId)
    if (!meta || meta.secret !== secret) throw new Error("Invalid secret")
  }

  /**
   * Store a single entry after validating that its key belongs to this share's
   * session. Returns the stored entry so callers can broadcast it.
   */
  async publish(shareId: string, key: string, content: any): Promise<ShareEntry> {
    const meta = await this.readMeta(shareId)
    if (!meta) throw new Error("Unknown share")
    const sessionID = meta.sessionID
    if (
      !key.startsWith(`session/info/${sessionID}`) &&
      !key.startsWith(`session/message/${sessionID}/`) &&
      !key.startsWith(`session/part/${sessionID}/`)
    ) {
      throw new Error("Invalid key")
    }

    const data = await this.readData(shareId)
    data[key] = content
    await this.writeData(shareId, data)
    return { key, content }
  }

  /** All `session/*` entries for a share (used for initial sync + viewer data). */
  async getData(shareId: string): Promise<ShareEntry[]> {
    const data = await this.readData(shareId)
    return Object.entries(data)
      .filter(([key]) => key.startsWith("session/"))
      .map(([key, content]) => ({ key, content }))
  }

  async clear(shareId: string): Promise<void> {
    await rm(this.dir(shareId), { recursive: true, force: true })
  }
}
