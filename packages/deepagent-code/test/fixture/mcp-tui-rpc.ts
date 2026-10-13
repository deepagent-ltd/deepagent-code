import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Rpc } from "../../src/util/rpc"
import { Global } from "@deepagent-code/core/global"

const root = process.env.DAC_MCP_TUI_ROOT
assert(root && path.basename(root).startsWith("dac-mcp-tui-rpc-"))
assert.equal(await fs.realpath(root), root)
assert.equal(process.env.DEEPAGENT_CODE_SERVER_PASSWORD, "")
const requests: string[] = []
const as = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    requests.push(request.method)
    return new Response(null, { status: 401 })
  },
})
const directory = path.join(root, "project")
await fs.writeFile(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({
    formatter: false,
    lsp: false,
    mcp: { fixture: { type: "remote", url: new URL("/mcp", as.url).href, oauth: { clientId: "fixture" } } },
  }),
)
const rg = Bun.which("rg")
assert(rg)
await fs.mkdir(Global.Path.bin, { recursive: true })
await fs.copyFile(rg, path.join(Global.Path.bin, "rg"))
const worker = new Worker(new URL("../../src/cli/tui/worker.ts", import.meta.url))
const client = Rpc.client<typeof import("../../src/cli/tui/worker").rpc>(worker, { requireReady: true, timeoutMs: 20000 })
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Actual worker bootstrap did not become ready")), 10000)
    worker.addEventListener("message", function ready(event: MessageEvent<unknown>) {
      if (
        !event.data ||
        typeof event.data !== "object" ||
        !("kind" in event.data) ||
        event.data.kind !== "goal-plan-bootstrap-ready-v1"
      )
        return
      clearTimeout(timer)
      worker.removeEventListener("message", ready)
      resolve()
    })
    worker.addEventListener(
      "error",
      (event) => {
        clearTimeout(timer)
        reject(new Error(event.message))
      },
      { once: true },
    )
  })
  await client.ready
  // Observe worker readiness only. Do not transfer a Goal authority channel.
  const result = await client.call("fetch", {
    url: "http://deepagent-code.internal/mcp/fixture/auth",
    method: "POST",
    headers: { "x-deepagent-code-directory": directory },
  })
  assert.equal(result.status, 401)
  assert.match(JSON.parse(result.body).error, /non-empty server password/)
  assert.deepEqual(requests, [])
  assert.equal(
    await fs.stat(path.join(Global.Path.config, "mcp-oauth")).then(
      () => true,
      () => false,
    ),
    false,
  )
  const cliHome = path.join(root, "cli-home")
  await fs.mkdir(path.join(cliHome, ".deepagent", "code", "cache", "bin"), { recursive: true })
  await fs.copyFile(rg, path.join(cliHome, ".deepagent", "code", "cache", "bin", "rg"))
  const cli = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../../src/index.ts"), "mcp", "debug", "fixture"],
    {
      cwd: directory,
      env: {
        ...process.env,
        HOME: cliHome,
        DEEPAGENT_CODE_TEST_HOME: cliHome,
        DEEPAGENT_CODE_DB: path.join(cliHome, ".deepagent", "code", "authority.sqlite"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => cli.kill(), 15000)
  const [code, stdout, stderr] = await Promise.all([
    cli.exited,
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
  ])
  clearTimeout(timer)
  await fs.writeFile(path.join(root, "cli-readonly.log"), stdout + stderr)
  assert.equal(code, 0, stdout + stderr)
  assert.match(stdout + stderr, /read-only diagnostic/)
  assert.deepEqual(requests, [])
  assert.equal(
    await fs.stat(path.join(cliHome, ".deepagent", "code", "mcp-oauth")).then(
      () => true,
      () => false,
    ),
    false,
  )
  await fs.writeFile(
    path.join(root, "evidence.json"),
    JSON.stringify(
      {
        cli: { pid: cli.pid, code, zeroOAuthRequests: true, noJournal: true },
        pid: process.pid,
        httpStatus: result.status,
        actualWorker: "src/cli/tui/worker.ts",
        noTcpListener: true,
        actualRpc: true,
        externalRequests: requests.length,
        limitation:
          "Raw parent RPC has no fixed MCP operator interaction authority yet; this negative gate is not a usable local TUI OAuth flow",
      },
      null,
      2,
    ),
  )
  await client.call("shutdown", undefined)
} finally {
  client.close()
  worker.terminate()
  await as.stop(true)
}
process.exit(0)
