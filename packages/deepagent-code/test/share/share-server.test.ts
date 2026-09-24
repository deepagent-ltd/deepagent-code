import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { cleanupExpiredShares, createShareHandler } from "../../script/share-server"
import { createSessionBundle, parseSessionBundle } from "../../src/session/bundle"
import { downloadSessionBundle, revokeSessionBundle, uploadSessionBundle } from "../../src/session/bundle-share"
import type { SessionSnapshot } from "../../src/session/snapshot"

test("public share upload, token download, and revoke", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deepagent-share-"))
  try {
    const handle = createShareHandler({ directory, publicURL: "https://share.example", uploadToken: "upload-token-with-more-than-32-characters" })
    const snapshot = {
      format: "deepagent-code.session-snapshot", format_version: 1, exported_at: 1,
      source: { session_id: "ses_a", title: "private" },
      session: { id: "ses_a", title: "private", v2_authority: true, metadata: {} },
      messages: [{ id: "msg_a", session_id: "ses_a", data: { text: "sk-1234567890123456 DATABASE_URL=postgres://alice:pwd@db.local/prod PROJECT_MODE=internal" } }],
      parts: [], activities: [], progress: [],
    } as unknown as SessionSnapshot
    const bytes = await createSessionBundle({ snapshot, tier: "session_logs", redact: false,
      logs: { events: [{ api_key: "top-secret", DATABASE_URL: "postgres://alice:pwd@db.local/prod" }], inputs: [], providerTurns: [] } })
    const localShared = await parseSessionBundle(await createSessionBundle({ snapshot, tier: "conversation", share: true }))
    expect(JSON.stringify(localShared)).not.toContain("postgres://alice:pwd@db.local/prod")
    expect(JSON.stringify(localShared)).not.toContain("PROJECT_MODE=internal")
    const post = (authorization: string) => handle(new Request("https://share.example/api/bundles", {
      method: "POST", headers: { authorization }, body: new Blob([new Uint8Array(bytes)]),
    }))
    const health = await handle(new Request("https://share.example/healthz"))
    expect(health.status).toBe(200)
    expect(await health.text()).toBe("ok")
    expect(health.headers.get("cache-control")).toBe("no-store")
    expect((await post("Bearer wrong")).status).toBe(401)
    const uploaded = await post("Bearer upload-token-with-more-than-32-characters")
    expect(uploaded.status).toBe(201)
    const result = await uploaded.json() as { id: string; url: string; revokeToken: string }
    const secret = new URL(result.url).hash.slice(1)
    const address = `https://share.example/api/bundles/${result.id}`
    expect((await handle(new Request(address))).status).toBe(401)
    const downloaded = await handle(new Request(address, { headers: { authorization: `Bearer ${secret}` } }))
    expect(downloaded.status).toBe(200)
    const bundle = await parseSessionBundle(new Uint8Array(await downloaded.arrayBuffer()))
    expect(bundle.manifest.redacted).toBe(true)
    expect(JSON.stringify(bundle)).not.toContain("top-secret")
    expect(JSON.stringify(bundle)).not.toContain("sk-1234567890123456")
    expect(JSON.stringify(bundle)).not.toContain("postgres://alice:pwd@db.local/prod")
    expect(JSON.stringify(bundle)).not.toContain("PROJECT_MODE=internal")
    expect((await handle(new Request(address, { method: "DELETE", headers: { authorization: `Bearer ${secret}` } }))).status).toBe(401)
    expect((await handle(new Request(address, { method: "DELETE", headers: { authorization: `Bearer ${result.revokeToken}` } }))).status).toBe(204)
    expect((await handle(new Request(address, { headers: { authorization: `Bearer ${secret}` } }))).status).toBe(404)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("app share client accepts only configured host and round-trips through HTTP", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deepagent-share-http-"))
  let handler = async (_request: Request): Promise<Response> => new Response(null, { status: 503 })
  const server = Bun.serve({ port: 0, fetch: (request) => handler(request) })
  const service = server.url.toString()
  handler = createShareHandler({ directory, publicURL: service, uploadToken: "upload-token-with-more-than-32-characters" })
  try {
    const snapshot = {
      format: "deepagent-code.session-snapshot", format_version: 1, exported_at: 1,
      source: { session_id: "ses_http", title: "http" },
      session: { id: "ses_http", title: "http", v2_authority: true },
      messages: [], parts: [], activities: [], progress: [],
    } as unknown as SessionSnapshot
    const bytes = await createSessionBundle({ snapshot, tier: "conversation" })
    const share = await uploadSessionBundle({ bytes, service, uploadToken: "upload-token-with-more-than-32-characters" })
    const downloaded = await downloadSessionBundle({ url: share.url, service })
    expect(downloaded.manifest.tier).toBe("conversation")
    const invalid = await downloadSessionBundle({ url: share.url.replace(server.url.host, "attacker.example"), service })
      .then(() => "accepted", (error: Error) => error.message)
    expect(invalid).toBe("invalid bundle share link")
    await revokeSessionBundle({ url: share.url, service, revokeToken: share.revokeToken })
    const removed = await downloadSessionBundle({ url: share.url, service })
      .then(() => "accepted", (error: Error) => error.message)
    expect(removed).toContain("404")
  } finally {
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("expired share is unavailable and its stored bundle is removed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deepagent-share-expiry-"))
  try {
    const handler = createShareHandler({ directory, publicURL: "https://share.example", uploadToken: "upload-token-with-more-than-32-characters", ttlMs: -1 })
    const snapshot = {
      format: "deepagent-code.session-snapshot", format_version: 1, exported_at: 1,
      source: { session_id: "ses_expired", title: "expired" },
      session: { id: "ses_expired", title: "expired" },
      messages: [], parts: [], activities: [], progress: [],
    } as unknown as SessionSnapshot
    const bytes = await createSessionBundle({ snapshot, tier: "conversation" })
    const uploaded = await handler(new Request("https://share.example/api/bundles", {
      method: "POST", headers: { authorization: "Bearer upload-token-with-more-than-32-characters" },
      body: new Blob([new Uint8Array(bytes)]),
    }))
    const result = await uploaded.json() as { id: string; url: string }
    const download = await handler(new Request(`https://share.example/api/bundles/${result.id}`, {
      headers: { authorization: `Bearer ${new URL(result.url).hash.slice(1)}` },
    }))
    expect(download.status).toBe(404)
    await cleanupExpiredShares(directory)
    expect(await Bun.file(path.join(directory, `${result.id}.zip`)).exists()).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
