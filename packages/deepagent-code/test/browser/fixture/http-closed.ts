import { Server, BrowserNativeHost } from "../../../src/node"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const root = process.env.DAC_BROWSER_TEST_ROOT!
await BrowserNativeHost.prepare()
const servers = [
  await Server.listen({ hostname: "127.0.0.1", port: 0 }),
]
try {
  const payload = { requestID: "closed-fixture", sessionID: "ses_browser_not_created", profile: "managed-loopback-preview-v1",
    origin: "http://127.0.0.1:45678", expiresAt: Date.now() + 60_000 }
  const request = async (server: typeof servers[number], route: string, credentials: string | undefined, body?: unknown) => {
    const response = await fetch(new URL(route, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(credentials ? { authorization: `Basic ${Buffer.from(credentials).toString("base64")}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.text() }
  }
  const noHost = await request(servers[0]!, "/api/v1/browser/controls", "operator:private-fixture", payload)
  const wrongAuth = await request(servers[0]!, "/api/v1/browser/controls", "operator:wrong", payload)
  const emptyPassword = await request(servers[0]!, "/api/v1/browser/controls", "operator:", payload)
  const noAction = await request(servers[0]!, "/api/v1/browser/actions", "operator:private-fixture", { effectID: "caller-invented" })
  const absent = await request(servers[0]!, "/api/v1/browser/controls/absent", "operator:private-fixture")
  const db = new DatabaseSync(process.env.DEEPAGENT_CODE_DB!, { readOnly: true })
  const controls = db.prepare("SELECT count(*) AS count FROM browser_control").get()!.count
  const actions = db.prepare("SELECT count(*) AS count FROM browser_action").get()!.count
  db.close()
  await writeFile(path.join(root, "result.json"), JSON.stringify({ noHost, wrongAuth, emptyPassword, noAction, absent,
    controls, actions, hostAvailable: BrowserNativeHost.current() !== undefined, bunLoaded: process.versions.bun !== undefined }))
} finally {
  await Promise.all(servers.map((server) => server.stop()))
}
process.exit(0)
