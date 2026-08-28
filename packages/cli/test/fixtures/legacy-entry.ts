// PARITY-003 (Wave 0) fixture: a minimal stand-in for the legacy deepagent-code CLI entrypoint.
//
// Implements exactly the protocol surface the daemon relies on when mounting a legacy server:
//   * `serve --register` listens on an ephemeral port and exposes GET /global/health guarded by
//     Basic auth (the same DEEPAGENT_CODE_SERVER_PASSWORD credential the daemon injects).
//   * Writes state/server.json ({ id, version, url, pid }) atomically under the isolated test
//     home, mirroring registerWithDaemon in packages/deepagent-code/src/cli/cmd/serve.ts.
//   * Steps down on SIGTERM: removes the registration it owns, then exits.
//
// Plain Node/Bun on purpose — importing the real legacy CLI would drag in the whole app runtime.
import { randomUUID } from "node:crypto"
import fsSync from "node:fs"
import path from "node:path"

const version = process.env.DEEPAGENT_CODE_DAEMON_FIXTURE_VERSION ?? "local"
const stateDir = path.join(process.env.DEEPAGENT_CODE_HOME ?? process.cwd(), "state")
const file = path.join(stateDir, "server.json")

const read = (): { id?: string } | undefined => {
  try {
    return JSON.parse(fsSync.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
const id = randomUUID()
const owned = () => read()?.id === id
const expectedAuth = `Basic ${Buffer.from(`deepagent-code:${process.env.DEEPAGENT_CODE_SERVER_PASSWORD ?? ""}`).toString("base64")}`

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/global/health") {
      if (request.headers.get("authorization") !== expectedAuth) {
        return Response.json({ error: "unauthorized" }, { status: 401 })
      }
      return Response.json({ healthy: true, version, runtimeId: "fixture" })
    }
    return Response.json({ error: "not found" }, { status: 404 })
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
