import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { Database } from "bun:sqlite"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { BrowserUnavailableCliPTY } from "../../fixture/browser-unavailable-cli-pty"
import { BrowserCanonicalViewport } from "../../fixture/browser-canonical-viewport"

test.skipIf(process.env.DAC_BROWSER_TUI_UNAVAILABLE_ACTUAL !== "1")("original source CLI unavailable browser retries without admitting execution and restores its PTY", async () => {
  await (await BrowserCanonicalViewport.create()).dispose()
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-unavailable-cli-"))
  await fs.chmod(root, 0o700)
  await Promise.all(["home", "project", "tmp", "config", "data", "cache", "state"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
  const password = randomUUID()
  const authorization = `Basic ${Buffer.from(`deepagent-code:${password}`).toString("base64")}`
  const authorizationFile = path.join(root, "authorization")
  await fs.writeFile(authorizationFile, authorization, { mode: 0o600 })
  await fs.writeFile(path.join(root, "project/deepagent-code.json"), JSON.stringify({ formatter: false, lsp: false,
    model: "fixture/unavailable-model", provider: { fixture: { name: "QA metadata only", npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "unused-fixture", baseURL: "http://127.0.0.1:1/v1" }, models: { "unavailable-model": {
        name: "QA unavailable model", tool_call: true, limit: { context: 100000, output: 4096 } } } } },
    providers: { fixture: { name: "QA metadata only", env: ["DAC_UNUSED_QA_KEY"], api: {
      type: "native", settings: {}, protocol: "openai-compatible.chat", url: "http://127.0.0.1:1/v1" },
      models: { "unavailable-model": { api: { id: "unavailable-model" }, capabilities: { input: ["text"], output: ["text"], tools: true },
        limit: { context: 100000, output: 4096 } } } } } }), { mode: 0o600 })
  const allocator = createServer()
  await new Promise<void>((resolve) => allocator.listen(0, "127.0.0.1", resolve))
  const address = allocator.address()
  if (!address || typeof address === "string") throw new Error("Owned Root port not allocated")
  await new Promise<void>((resolve) => allocator.close(() => resolve()))
  const url = `http://127.0.0.1:${address.port}`
  const log = await fs.open(path.join(root, "root-private.log"), "wx", 0o600)
  const databaseFile = path.join(root, "database.sqlite")
  const server = Bun.spawn([process.execPath, "--preload", Bun.resolveSync("@opentui/solid/preload", import.meta.dir),
    path.resolve(import.meta.dir, "../../../../deepagent-code/src/index.ts"), "serve", "--hostname", "127.0.0.1", "--port", String(address.port)], {
    cwd: path.join(root, "project"), stdin: "ignore", stdout: log.fd, stderr: log.fd, env: {
      PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_DB: databaseFile,
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1", DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "1",
      DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1", DEEPAGENT_ENABLED: "false", DEEPAGENT_IM_AGENT_RESPONDER: "off",
      DEEPAGENT_CODE_SERVER_USERNAME: "deepagent-code", DEEPAGENT_CODE_SERVER_PASSWORD: password,
    },
  })
  const state = { phase: "root_ready", rootExit: undefined as number | undefined, rootStopSignals: [] as string[],
    counts: {} as Record<string, number>, portClosed: false }
  console.log("BROWSER_UNAVAILABLE_CLI_PRIVATE", root)
  try {
    const deadline = Date.now() + 60_000
    while (!await fetch(url + "/global/health", { headers: { Authorization: authorization }, signal: AbortSignal.timeout(500) })
      .then((response) => response.ok).catch(() => false)) {
      if (server.exitCode !== null || Date.now() >= deadline) throw new Error("Original Root did not become ready")
      await Bun.sleep(30)
    }
    const client = createDeepAgentCodeClient({ baseUrl: url, headers: { Authorization: authorization } })
    const session = (await client.v2.session.create({ location: { directory: path.join(root, "project") },
      model: { providerID: "fixture", id: "unavailable-model" } }, { throwOnError: true })).data.data
    const descriptor = path.join(root, "descriptor-private.json")
    await fs.writeFile(descriptor, JSON.stringify({ version: 1, url, directory: path.join(root, "project"), sessionID: session.id,
      authorizationFile, output: root, deadlineAt: Date.now() + 45_000 }), { mode: 0o600 })
    state.phase = "original_cli"
    await BrowserUnavailableCliPTY.run(descriptor)
    const result = await Bun.file(path.join(root, "tui-cli-private/safe.json")).json()
    expect(result.phase).toBe("complete")
    expect(result.cleanupSignals).toEqual([])
    expect(result.restored && result.terminalClosed).toBe(true)
    state.phase = "complete"
  } finally {
    if (server.exitCode === null) { state.rootStopSignals.push("SIGTERM"); server.kill("SIGTERM"); await Promise.race([server.exited, Bun.sleep(8000)]) }
    if (server.exitCode === null) { state.rootStopSignals.push("SIGKILL"); server.kill("SIGKILL"); await server.exited }
    state.rootExit = server.exitCode ?? undefined
    if (await Bun.file(databaseFile).exists()) {
      const database = new Database(databaseFile, { readonly: true })
      for (const table of ["session_input", "session_provider_attempt", "session_v2_provider_turn_receipt", "session_v2_tool_effect_admission", "browser_control", "browser_action", "work_execution", "work_count_acquisition"])
        state.counts[table] = (database.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
      database.close()
    }
    state.portClosed = await fetch(url + "/global/health", { signal: AbortSignal.timeout(500) }).then(() => false).catch(() => true)
    await fs.writeFile(path.join(root, "safe.json"), JSON.stringify({ ...state, actualRoot: true, nativeFactory: "unavailable",
      GUI: false, Vite: false, providerTransport: false, originalServe: true }, null, 2), { mode: 0o600 })
    await log.close()
  }
  expect(state.rootExit).toBe(0)
  expect(state.rootStopSignals).toEqual(["SIGTERM"])
  expect(state.portClosed).toBe(true)
  expect(Object.values(state.counts)).toEqual(Array.from({ length: 8 }, () => 0))
}, 100_000)
