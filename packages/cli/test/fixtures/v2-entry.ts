import { randomUUID } from "node:crypto"
import fsSync from "node:fs"
import path from "node:path"

const version = process.env.DEEPAGENT_CODE_DAEMON_FIXTURE_VERSION ?? "local"
const stateDir = path.join(process.env.DEEPAGENT_CODE_HOME ?? process.cwd(), "state")
const file = path.join(stateDir, "server.json")
const passwordFile = path.join(stateDir, "password")

const readRegistration = (): { id?: string } | undefined => {
  try {
    return JSON.parse(fsSync.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
const id = randomUUID()
const owned = () => readRegistration()?.id === id

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== "/api/health") return Response.json({ error: "not found" }, { status: 404 })
    const password = fsSync.existsSync(passwordFile) ? fsSync.readFileSync(passwordFile, "utf8") : ""
    const expected = `Basic ${Buffer.from(`deepagent-code:${password}`).toString("base64")}`
    if (request.headers.get("authorization") !== expected) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    return Response.json({ healthy: true })
  },
})

fsSync.mkdirSync(stateDir, { recursive: true })
const temp = `${file}.${id}.tmp`
fsSync.writeFileSync(temp, JSON.stringify({ id, version, url: `http://127.0.0.1:${server.port}`, pid: process.pid }), {
  mode: 0o600,
})
fsSync.renameSync(temp, file)

process.on("SIGTERM", () => {
  if (owned()) {
    try {
      fsSync.unlinkSync(file)
    } catch {
      // A concurrent takeover may have already replaced the file.
    }
  }
  server.stop(true)
  process.exit(0)
})
