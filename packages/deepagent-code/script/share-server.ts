import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { BUNDLE_MAX_BYTES, createSessionBundle, parseSessionBundle } from "../src/session/bundle"
import { publicSharingEnabled } from "../src/share/public-share-policy"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const equals = (left: string, right: string) => timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)))
const token = () => randomBytes(32).toString("base64url")
const idPattern = /^[a-f0-9]{32}$/
const noStore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }

async function readLimited(request: Request) {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    size += result.value.byteLength
    if (size > BUNDLE_MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

type RecordInfo = {
  id: string
  downloadHash: string
  revokeHash: string
  createdAt: number
  expiresAt: number
  tier: string
  redacted: boolean
}

export async function cleanupExpiredShares(directory: string) {
  const entries = await readdir(directory).catch(() => [])
  await Promise.all(entries.filter((name) => /^[a-f0-9]{32}\.json$/.test(name)).map(async (name) => {
    const info = await Bun.file(path.join(directory, name)).json().catch(() => null) as RecordInfo | null
    if (!info || info.expiresAt > Date.now()) return
    const id = name.slice(0, 32)
    await Promise.all([
      rm(path.join(directory, `${id}.zip`), { force: true }),
      rm(path.join(directory, name), { force: true }),
    ])
  }))
}

export function createShareHandler(input: { directory: string; publicURL: string; uploadToken: string; ttlMs?: number; enabled?: boolean }) {
  const base = input.publicURL.replace(/\/$/, "")
  const enabled = input.enabled ?? publicSharingEnabled()
  const unauthorized = () => new Response("unauthorized", { status: 401, headers: noStore })
  const missing = () => new Response("not found", { status: 404, headers: noStore })
  const unavailable = () => new Response("public sharing is disabled", { status: 503, headers: noStore })
  const tokenFrom = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/healthz")
      return new Response("ok", { headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } })
    if (!enabled && (request.method === "POST" || request.method === "GET")) return unavailable()
    if (request.method === "POST" && url.pathname === "/api/bundles") {
      if (!equals(tokenFrom(request), input.uploadToken)) return unauthorized()
      if (Number(request.headers.get("content-length") ?? 0) > BUNDLE_MAX_BYTES) return new Response("bundle too large", { status: 413 })
      const bytes = await readLimited(request)
      if (!bytes) return new Response("bundle too large", { status: 413 })
      const parsed = await parseSessionBundle(bytes).catch(() => null)
      if (!parsed) return new Response("invalid bundle", { status: 400, headers: noStore })
      // The public host redacts again even if a client falsely labels its manifest redacted.
      const publicBytes = await createSessionBundle({ snapshot: parsed.snapshot, tier: parsed.manifest.tier, logs: parsed.logs, context: parsed.context, share: true })
      const id = randomBytes(16).toString("hex")
      const downloadToken = token()
      const revokeToken = token()
      const record: RecordInfo = {
        id,
        downloadHash: digest(downloadToken),
        revokeHash: digest(revokeToken),
        createdAt: Date.now(),
        expiresAt: Date.now() + (input.ttlMs ?? 7 * 24 * 60 * 60 * 1000),
        tier: parsed.manifest.tier,
        redacted: true,
      }
      await mkdir(input.directory, { recursive: true })
      await Bun.write(path.join(input.directory, `${id}.zip.tmp`), publicBytes)
      await rename(path.join(input.directory, `${id}.zip.tmp`), path.join(input.directory, `${id}.zip`))
      await Bun.write(path.join(input.directory, `${id}.json`), JSON.stringify(record))
      return Response.json({ id, url: `${base}/b/${id}#${downloadToken}`, revokeToken, expiresAt: record.expiresAt }, { status: 201, headers: noStore })
    }

    const match = url.pathname.match(/^\/api\/bundles\/([a-f0-9]{32})$/)
    if (match && idPattern.test(match[1])) {
      const info = await Bun.file(path.join(input.directory, `${match[1]}.json`)).json().catch(() => null) as RecordInfo | null
      if (!info || info.id !== match[1] || info.expiresAt <= Date.now()) return missing()
      if (request.method === "GET") {
        if (!equals(digest(tokenFrom(request)), info.downloadHash)) return unauthorized()
        const file = Bun.file(path.join(input.directory, `${info.id}.zip`))
        if (!(await file.exists())) return missing()
        return new Response(file, {
          headers: { ...noStore, "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="session-${info.id}.zip"` },
        })
      }
      if (request.method === "DELETE") {
        if (!equals(digest(tokenFrom(request)), info.revokeHash) && !equals(tokenFrom(request), input.uploadToken))
          return unauthorized()
        await Promise.all([
          rm(path.join(input.directory, `${info.id}.zip`), { force: true }),
          rm(path.join(input.directory, `${info.id}.json`), { force: true }),
        ])
        return new Response(null, { status: 204, headers: noStore })
      }
    }

    const page = url.pathname.match(/^\/b\/([a-f0-9]{32})$/)
    if (page && request.method === "GET") {
      return new Response(`<!doctype html><meta charset="utf-8"><title>DeepAgent session bundle</title><button id="download">Download session ZIP</button><script>
      document.getElementById("download").onclick = async () => {
        const response = await fetch("/api/bundles/${page[1]}", { headers: { Authorization: "Bearer " + location.hash.slice(1) } });
        if (!response.ok) { alert("Share unavailable or expired"); return; }
        const link = document.createElement("a"); link.href = URL.createObjectURL(await response.blob()); link.download = "session-${page[1]}.zip"; link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      };
      </script>`, { headers: { ...noStore, "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'" } })
    }
    return missing()
  }
}

if (import.meta.main) {
  const uploadToken = process.env.DEEPAGENT_SHARE_UPLOAD_TOKEN
  if (!uploadToken || uploadToken.length < 32) throw new Error("DEEPAGENT_SHARE_UPLOAD_TOKEN must contain at least 32 characters")
  const port = Number(process.env.PORT ?? 8789)
  const publicURL = process.env.DEEPAGENT_SHARE_PUBLIC_URL
  if (!publicURL) throw new Error("DEEPAGENT_SHARE_PUBLIC_URL is required")
  const directory = process.env.DEEPAGENT_SHARE_DATA_DIR ?? path.join(process.cwd(), "share-data")
  await cleanupExpiredShares(directory)
  setInterval(() => void cleanupExpiredShares(directory), 60 * 60 * 1000).unref()
  Bun.serve({ hostname: process.env.DEEPAGENT_SHARE_BIND_HOST ?? "127.0.0.1", port, fetch: createShareHandler({
    directory,
    publicURL,
    uploadToken,
  }) })
}
