import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"
import { ReceiverTaskStatusFixture } from "./fixture/receiver-task-status"

const actual = process.env.DAC_RECEIVER_TASK_ACTUAL === "1" ? test : test.skip

actual("the original ACK enters current A SDK/reader and opens B's current task without executing work", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-im-task-receiver-"))
  const reused = process.env.DAC_RECEIVER_TASK_REUSE
  const httpsViewer = process.env.DAC_RECEIVER_TASK_HTTPS_VIEWER === "1"
  await fs.chmod(root, 0o700)
  await fs.writeFile("/tmp/dac-im-task-receiver-current", root, { mode: 0o600 })
  const state = { stage: "original-B-preflight", completed: false, bStarted: false, aStarted: false }
  const currentB = process.env.DAC_RECEIVER_TASK_CURRENT_B === "1"
  const children: ReturnType<typeof Bun.spawn>[] = []
  const outputs = new Map<string, Promise<string>>()
  const proxies: ReturnType<typeof ReceiverTaskStatusFixture.proxy>[] = []
  const requests: { side: string; method: string; path: string; status: number; origin?: string | null }[] = []
  const originalEnv: Record<string, string> = JSON.parse(await fs.readFile(path.join(ReceiverTaskStatusFixture.original, "cancel_notice/exact-private-env.json"), "utf8"))
  const before = ReceiverTaskStatusFixture.census(ReceiverTaskStatusFixture.dbPath)
  const identity = await fs.stat(ReceiverTaskStatusFixture.dbPath, { bigint: true })
  const originalResult = JSON.parse(await fs.readFile(path.join(ReceiverTaskStatusFixture.original, "cancel_notice/result.json"), "utf8"))
  const tuple = originalResult.remoteStatus.tuple
  const originalStatus = originalResult.remoteStatus.located
  const aKey = randomUUID()
  const native = ReceiverTaskStatusFixture.peer({ aKey, bKey: originalEnv.DEEPAGENT_IM_FACADE_KEY, history: !!reused })
  const safe: Record<string, unknown> = { boundary: currentB ? "current source-runtime A+B; B original private identity/fileDB/ACK retained; standard production forward upgrade; controlled immutable-ACK protocol producer" : "mixed cohort: original B signed CLI/fileDB; current source-runtime A; controlled immutable-ACK protocol producer",
    root, original: ReceiverTaskStatusFixture.original, tuple, before, newNative: 0, provider: 0 }
  const read = async (url: URL, side: string, password: string, directory: string, body?: unknown) => {
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST",
      headers: { connection: "close", "content-type": "application/json", authorization: `Basic ${Buffer.from(`${side === "B" ? originalEnv.DEEPAGENT_CODE_SERVER_USERNAME : "qa"}:${password}`).toString("base64")}`,
        "x-deepagent-code-directory": directory }, body: body === undefined ? undefined : JSON.stringify(body),
      ...(url.protocol === "https:" ? { tls: { rejectUnauthorized: true, ca: await fs.readFile(originalEnv.DAC_NOTICE_CA, "utf8") } } : {}),
      signal: AbortSignal.timeout(12_000) }).catch((error: unknown) => {
        safe.failedRequest = { side, path: url.pathname, stage: state.stage,
          code: error instanceof Error ? error.name : "unknown", responseReceived: false }
        throw error
      })
    requests.push({ side, method: body === undefined ? "GET" : "POST", path: url.pathname, status: response.status })
    const value: unknown = await response.json()
    assert.equal(response.status, 200, `Original ${side} HTTP ${url.pathname}: ${response.status}`)
    return value
  }
  const runtime = process.execPath
  const aRoot = reused ?? root
  const aDirectory = path.join(aRoot, "A/project")
  try {
    // There is no live or eligible obligation to run in the original B database.
    const old = new Database(ReceiverTaskStatusFixture.dbPath, { readonly: true })
    try {
      expect(old.query<{ n: number }, []>("SELECT count(*) n FROM work_execution WHERE outcome='pending'").get()?.n).toBe(0)
      expect(old.query<{ n: number }, []>("SELECT count(*) n FROM session_input WHERE promoted_seq IS NULL").get()?.n).toBe(0)
    } finally { old.close() }
    expect(tuple.realm).toBe("http://127.0.0.1:60338/")
    const entry = path.join(aRoot, "current-receiver.js")
    if (!reused) {
      const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/receiver-task-status.ts")],
      target: "bun", conditions: ["browser"], outdir: root, naming: "current-receiver.js", sourcemap: "external" })
    assert(build.success, "Current receiving source-runtime module must compile")
    const map: { sources: string[]; sourcesContent: string[] } = JSON.parse(await fs.readFile(entry + ".map", "utf8"))
    await fs.writeFile(path.join(root, "source-cohort.json"), JSON.stringify({ version: 1, capturedAt: Date.now(),
      boundary: "source-runtime, not signed Native or installed", moduleSHA256: createHash("sha256").update(await fs.readFile(entry)).digest("hex"),
      sources: map.sources.map((filename, index) => ({ path: filename, sha256: createHash("sha256").update(map.sourcesContent[index]).digest("hex") })) }), { mode: 0o600 })
    process.stderr.write(`RECEIVER_CAPTURED ${root}\n`)
    }
    safe.module = { path: entry, sha256: createHash("sha256").update(await fs.readFile(entry)).digest("hex"),
      boundary: reused ? "immutable previous source-runtime module; UI/parent fixture mechanical successor" : "current source-runtime" }
    const sourceEntry = path.join(import.meta.dir, "fixture/receiver-task-status.ts")
    const httpsEntry = path.join(root, "current-receiver-https.js")
    if (httpsViewer) {
      // Only the test entry's listener options change. The already executed
      // production bundle stays byte-for-byte identical and keeps registry 246.
      const prior = await fs.readFile(entry, "utf8")
      const tls = 'const tls = process.env.DAC_RECEIVER_TASK_ROLE === "b" ? {'
      const listen = 'listen({ hostname: "127.0.0.1", port: Number(process.env.DAC_RECEIVER_TASK_PORT ?? 0), tls })'
      assert.equal(prior.split(tls).length, 2)
      assert.equal(prior.split(listen).length, 2)
      const after = prior.replace(tls, 'const tls = process.env.DAC_RECEIVER_TASK_ROLE === "b" || process.env.DAC_RECEIVER_TASK_HTTPS === "1" ? {')
        .replace(listen, 'listen({ hostname: "127.0.0.1", port: Number(process.env.DAC_RECEIVER_TASK_PORT ?? 0), tls, cors: process.env.DAC_RECEIVER_TASK_CORS ? [process.env.DAC_RECEIVER_TASK_CORS] : undefined })')
      const boundary = prior.indexOf('if (["a", "b"].includes(process.env.DAC_RECEIVER_TASK_ROLE ?? "")) {')
      assert(boundary > 0)
      assert.equal(after.slice(0, boundary), prior.slice(0, boundary))
      await fs.writeFile(httpsEntry, after, { mode: 0o600 })
      safe.fixtureOnlyRuntimeSuccessor = { before: entry, after: httpsEntry, sourceEntry,
        beforeSHA256: createHash("sha256").update(prior).digest("hex"), afterSHA256: createHash("sha256").update(after).digest("hex"),
        unchangedProductionPrefixSHA256: createHash("sha256").update(prior.slice(0, boundary)).digest("hex"),
        boundary: "source-runtime test role/listener options only; no build, signature or production module change" }
    }
    const command = [process.execPath, httpsViewer ? httpsEntry : entry]
    const aPortProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) })
    const aPort = aPortProbe.port
    await aPortProbe.stop(true)
    assert(typeof aPort === "number")
    const viewerOrigin = `https://127.0.0.1:${aPort}`
    if (httpsViewer) safe.environmentSuccessor = { origin: viewerOrigin, sourceEntry,
      boundary: "cached production module with fixture-listener-only successor; no build/sign; actual A HTTPS origin explicitly configured in actual B CORS" }
    const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) })
    const bPort = portProbe.port
    assert(typeof bPort === "number")
    await portProbe.stop(true)
    const bURL = new URL(`https://127.0.0.1:${bPort}/`)
    const bReady = path.join(root, "B-ready.json")
    const b = Bun.spawn(currentB ? command : [path.join(ReceiverTaskStatusFixture.original, "install/deepagent-code"), "serve", "--hostname", "127.0.0.1", "--port", String(bPort),
      "--tls-cert", originalEnv.DAC_NOTICE_CA, "--tls-key", originalEnv.DAC_NOTICE_KEY], {
      cwd: path.join(ReceiverTaskStatusFixture.original, "cancel_notice/project"), env: { ...originalEnv, DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "0",
        ...(currentB ? { DAC_RECEIVER_TASK_ROLE: "b", DAC_RECEIVER_TASK_PORT: String(bPort), DAC_RECEIVER_TASK_READY: bReady,
          ...(httpsViewer ? { DAC_RECEIVER_TASK_CORS: viewerOrigin } : {}) } : {}) },
      stdout: "pipe", stderr: "pipe" })
    children.push(b)
    const bOutput = new Response(b.stdout).text()
    const bErrors = new Response(b.stderr).text()
    outputs.set("B-startup.log", Promise.all([bOutput, bErrors]).then((value) => value.join("")))
    const bStartup = { listening: false }
    // Only the socket is observed; management requests are never retried.
    // The socket is checked for readiness only; exactly one management GET follows.
    for (const _ of Array.from({ length: currentB ? 600 : 100 })) {
      if (b.exitCode !== null) break
      if (currentB) {
        if (await Bun.file(bReady).exists()) { bStartup.listening = true; break }
        await Bun.sleep(50)
        continue
      }
      const socket = await Bun.connect({ hostname: "127.0.0.1", port: bPort,
        socket: { data() {}, open(socket) { socket.end() }, close() {}, error() {} } }).catch(() => undefined)
      if (socket) { bStartup.listening = true; break }
      await Bun.sleep(50)
    }
    state.bStarted = bStartup.listening
    if (!bStartup.listening) {
      b.kill("SIGTERM"); await b.exited
      await fs.writeFile(path.join(root, "B-startup.log"), await bOutput + await bErrors, { mode: 0o600 })
      throw new Error("Original B normalserve did not become ready in its single bounded startup")
    }
    state.stage = "original-B-one-management-GET"
    if (currentB) {
      const same: { instanceID: string } = JSON.parse(await fs.readFile(bReady, "utf8"))
      expect(same.instanceID).toBe(originalStatus.task.instanceID)
    }
    const bDirectory = originalStatus.task.directory
    const bPassword = originalEnv.DEEPAGENT_CODE_SERVER_PASSWORD
    const bStatus = await read(new URL("/api/v1/im/status?directory=" + encodeURIComponent(bDirectory), bURL), "B", bPassword, bDirectory)
    safe.bManagement = bStatus
    state.stage = "original-B-remote-status"
    const located = await read(new URL("/api/v1/im/tasks/remote-status?directory=" + encodeURIComponent(bDirectory), bURL), "B", bPassword, bDirectory, { tuple })
    expect(located).toEqual(originalStatus)
    safe.bCurrent = located
    // The rest of the run is fresh A. There is no old DB copy or schema upgrade.
    await fs.mkdir(aDirectory, { recursive: true, mode: 0o700 })
    const aHome = path.join(aRoot, "A/home")
    const aConfig = path.join(aHome, ".config/deepagent-code")
    await fs.mkdir(aConfig, { recursive: true, mode: 0o700 })
    if (!reused) {
      await fs.writeFile(path.join(aConfig, "deepagent-code.json"), "{}\n", { mode: 0o600 })
      await fs.writeFile(path.join(aRoot, "models.json"), "{}", { mode: 0o600 })
    }
    const password = randomUUID()
    const aDB = path.join(aRoot, "A/database.sqlite")
    const ready = path.join(root, "A-ready.json")
    const aEnv = { ...process.env, HOME: aHome, XDG_CONFIG_HOME: path.join(aHome, ".config"), XDG_DATA_HOME: path.join(aHome, ".local/share"),
      XDG_STATE_HOME: path.join(aHome, ".local/state"), XDG_CACHE_HOME: path.join(aHome, ".cache"), DEEPAGENT_CODE_HOME: aHome,
      DEEPAGENT_CODE_TEST_HOME: aHome, DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(aHome, "managed"), DEEPAGENT_CODE_DB: aDB,
      DEEPAGENT_CODE_MODELS_PATH: path.join(aRoot, "models.json"), DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "0",
      DEEPAGENT_CODE_SERVER_USERNAME: "qa", DEEPAGENT_CODE_SERVER_PASSWORD: password, DEEPAGENT_IM_FACADE_URL: native.server.url.origin,
      DEEPAGENT_IM_FACADE_KEY: aKey, DEEPAGENT_IM_AGENT_RESPONDER: "0", DAC_RECEIVER_TASK_ROLE: "a", DAC_RECEIVER_TASK_READY: ready,
      ...(httpsViewer ? { DAC_RECEIVER_TASK_PORT: String(aPort), DAC_RECEIVER_TASK_HTTPS: "1", DAC_NOTICE_CA: originalEnv.DAC_NOTICE_CA,
        DAC_NOTICE_KEY: originalEnv.DAC_NOTICE_KEY } : {}) }
    state.stage = "current-A-original-Root"
    const a = Bun.spawn(command,
      { cwd: aDirectory, env: aEnv, stdout: "pipe", stderr: "pipe" })
    children.push(a)
    const aOutput = new Response(a.stdout).text()
    const aErrors = new Response(a.stderr).text()
    outputs.set("A-startup.log", Promise.all([aOutput, aErrors]).then((value) => value.join("")))
    const deadline = Date.now() + 15_000
    while (!(await Bun.file(ready).exists()) && a.exitCode === null && Date.now() < deadline) await Bun.sleep(25)
    assert(await Bun.file(ready).exists(), "Current A original Root did not start")
    const aReady: { url: string; instanceID: string } = JSON.parse(await fs.readFile(ready, "utf8"))
    const aURL = new URL(aReady.url)
    state.aStarted = true
    const groups = new URL("/api/v1/im/groups/page?lane=protected&limit=2&directory=" + encodeURIComponent(aDirectory), aURL)
    await read(groups, "A", password, aDirectory)
    assert(native.facts.connections.includes("sender"), "Original A SDK must connect before publication")
    const empty = ReceiverTaskStatusFixture.census(aDB)
    safe.aBeforeIncoming = empty
    state.stage = "original-ACK-live-incoming"
    if (!reused) native.publish()
    const aStore = new Database(aDB, { readonly: true })
    const message = (() => {
      return aStore.query<{ local_message_id: string; metadata: string }, [string]>("SELECT local_message_id,metadata FROM im_kernel_reader_message WHERE message_id=?")
    })()
    const delivered = { value: undefined as ReturnType<typeof message.get> | undefined }
    const incomingDeadline = Date.now() + 8_000
    while (!delivered.value && Date.now() < incomingDeadline) { delivered.value = message.get(tuple.kernelMessageID); if (!delivered.value) await Bun.sleep(25) }
    aStore.close()
    assert(delivered.value, "Original SDK live message was not committed by current reader")
    const firstSeen: { firstSeen: { origin: string; receiverID: string } } = JSON.parse(delivered.value.metadata)
    expect(firstSeen.firstSeen.origin).toBe("kernel_live")
    expect(firstSeen.firstSeen.receiverID).toBe("sender")
    const locator = await read(new URL(`/api/v1/im/messages/${delivered.value.local_message_id}/remote-task-locator?directory=${encodeURIComponent(aDirectory)}`, aURL), "A", password, aDirectory)
    expect(locator).toMatchObject({ state: "available", tuple })
    const aClientPassword = randomUUID(), bClientPassword = randomUUID()
    const certificate = await fs.readFile(originalEnv.DAC_NOTICE_CA, "utf8")
    const proxy = (side: "A" | "B", origin: URL, directory: string, credential: string, clientPassword: string) => {
      const transport = ReceiverTaskStatusFixture.proxy({ origin, directory, https: httpsViewer, allowRead: side === "A",
        clientAuthorization: `Basic ${Buffer.from(`qa:${clientPassword}`).toString("base64")}`,
        upstreamAuthorization: `Basic ${Buffer.from(`${side === "B" ? originalEnv.DEEPAGENT_CODE_SERVER_USERNAME : "qa"}:${credential}`).toString("base64")}`,
        certificate, certificatePath: originalEnv.DAC_NOTICE_CA, keyPath: originalEnv.DAC_NOTICE_KEY,
        record: (request) => requests.push({ side, ...request }) })
      proxies.push(transport)
      return transport.server.url.origin
    }
    const aProxy = proxy("A", aURL, aDirectory, password, aClientPassword)
    const bProxy = proxy("B", bURL, bDirectory, bPassword, bClientPassword)
    const live = path.join(root, "live.json")
    await fs.writeFile(live, JSON.stringify({ a: { url: aProxy, directory: aDirectory }, b: { url: bProxy, directory: bDirectory }, tuple,
      messageID: delivered.value.local_message_id, groupID: "state" in Object(locator) ? (locator as { groupID: string }).groupID : "", status: located,
      ...(httpsViewer ? { viewerOrigin } : {}) }), { mode: 0o600 })
    state.stage = "current-GUI-and-TUI-receiver"
    const env = { ...process.env, DAC_RECEIVER_TASK_LIVE: live, DAC_RECEIVER_TASK_A_PASSWORD: aClientPassword, DAC_RECEIVER_TASK_B_PASSWORD: bClientPassword,
      ...(httpsViewer ? { NODE_EXTRA_CA_CERTS: originalEnv.DAC_NOTICE_CA } : {}) }
    const results: { name: string; code: number }[] = []
    const scenarios = [
      { name: "GUI", cwd: path.resolve(import.meta.dir, "../../../app"), command: [runtime, "run", "test:components", "test/components/im-task-status-receiver.test.tsx"] },
      { name: "TUI", cwd: path.resolve(import.meta.dir, "../../../tui"), command: [runtime, "test", "test/cli/tui/im-task-status-receiver.test.tsx"] },
    ].filter((scenario) => !process.env.DAC_RECEIVER_TASK_UI_ONLY || scenario.name === process.env.DAC_RECEIVER_TASK_UI_ONLY)
    assert(scenarios.length > 0, "The requested receiver UI scenario must exist")
    for (const scenario of scenarios) {
      const run = Bun.spawn(scenario.command, { cwd: scenario.cwd, env, stdout: "pipe", stderr: "pipe" })
      children.push(run)
      const output = new Response(run.stdout).text(), errors = new Response(run.stderr).text()
      const code = await run.exited
      await fs.writeFile(path.join(root, `${scenario.name}.log`), await output + await errors, { mode: 0o600 })
      results.push({ name: scenario.name, code })
    }
    safe.uiResults = results
    safe.aAfter = ReceiverTaskStatusFixture.census(aDB)
    expect(safe.aAfter).toMatchObject({ work_execution: { count: 0 }, session_input: { count: 0 }, session_provider_attempt: { count: 0 } })
    expect(results).toEqual(scenarios.map((scenario) => ({ name: scenario.name, code: 0 })))
    state.completed = true
    a.kill("SIGTERM"); await a.exited
    b.kill("SIGTERM"); await b.exited
    await fs.writeFile(path.join(root, "A-startup.log"), await aOutput + await aErrors, { mode: 0o600 })
    await fs.writeFile(path.join(root, "B-startup.log"), await bOutput + await bErrors, { mode: 0o600 })
  } catch (error) {
    safe.failure = { stage: state.stage, code: error instanceof Error ? error.name : "unknown" }
    throw error
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited }
    await Promise.all([...outputs].map(async ([name, output]) => fs.writeFile(path.join(root, name), await output, { mode: 0o600 })))
    for (const proxy of proxies) await proxy.close()
    if (await Bun.file(path.join(aRoot, "A/database.sqlite")).exists()) {
      safe.aFinal = ReceiverTaskStatusFixture.census(path.join(aRoot, "A/database.sqlite"))
      safe.aDrift = Object.keys(safe.aBeforeIncoming as Record<string, unknown> ?? {}).filter((name) =>
        JSON.stringify((safe.aBeforeIncoming as Record<string, unknown>)[name]) !== JSON.stringify((safe.aFinal as Record<string, unknown>)[name]))
    }
    await native.close()
    const after = ReceiverTaskStatusFixture.census(ReceiverTaskStatusFixture.dbPath)
    const finalIdentity = await fs.stat(ReceiverTaskStatusFixture.dbPath, { bigint: true })
    safe.bAfter = after
    safe.bDrift = Object.keys(before).filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
    safe.bExecutionDrift = (safe.bDrift as string[]).filter((name) =>
      /^(im_task|im_reply_outbox|im_kernel_delivery|work_|session)/.test(name) && name !== "session_provider_owner_lease")
    safe.dbIdentityUnchanged = identity.dev === finalIdentity.dev && identity.ino === finalIdentity.ino
    safe.state = state; safe.requests = requests; safe.protocol = native.facts
    safe.closed = children.every((child) => child.exitCode !== null)
    await fs.writeFile(path.join(root, "safe-result.json"), JSON.stringify(safe, null, 2), { mode: 0o600 })
    expect(native.facts.publishAttempts).toBe(0)
    expect(safe.dbIdentityUnchanged).toBe(true)
    // Infrastructure owner leases are recorded separately. Do not replace the
    // original HTTP exception with a broader census assertion during teardown.
    if (state.completed) expect(safe.bExecutionDrift).toEqual([])
  }
}, 90_000)


const relay = process.env.DAC_RECEIVER_TASK_RELAY_ONLY === "1" ? test : test.skip
relay("the private receiver proxy performs real authenticated TLS WS upgrades and closes both directions", async () => {
  const environment: Record<string, string> = JSON.parse(await fs.readFile(path.join(ReceiverTaskStatusFixture.original, "cancel_notice/exact-private-env.json"), "utf8"))
  const certificate = await fs.readFile(environment.DAC_NOTICE_CA, "utf8")
  const observed: { path: string; search: string; origin: string | null; authorization: string | null; directory: string | null }[] = []
  const records: { method: string; path: string; status: number; origin?: string | null }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { cert: Bun.file(environment.DAC_NOTICE_CA), key: Bun.file(environment.DAC_NOTICE_KEY) },
    fetch(request, owner) {
      const url = new URL(request.url)
      observed.push({ path: url.pathname, search: url.search, origin: request.headers.get("origin"),
        authorization: request.headers.get("authorization"), directory: request.headers.get("x-deepagent-code-directory") })
      if (request.headers.get("authorization") !== "Basic upstream-private" || request.headers.get("origin") !== "https://127.0.0.1:8443")
        return new Response(null, { status: 403 })
      if (owner.upgrade(request, { data: undefined })) return
      return new Response(null, { status: 400 })
    }, websocket: { open(socket) { socket.send("actual upstream reader frame") }, message(socket, message) { socket.send(message) } } })
  const transport = ReceiverTaskStatusFixture.proxy({ origin: server.url, directory: "/private/project", https: true, allowRead: true,
    clientAuthorization: "Basic client-private", upstreamAuthorization: "Basic upstream-private", certificate,
    certificatePath: environment.DAC_NOTICE_CA, keyPath: environment.DAC_NOTICE_KEY, record: (request) => records.push(request) })
  const url = new URL("/ws/im/group/original?directory=%2Fprivate%2Fproject&location%5Bdirectory%5D=%2Fprivate%2Fproject", transport.server.url)
  url.protocol = "wss:"
  const socket = ReceiverTaskStatusFixture.connectSocket(url, { headers: { authorization: "Basic client-private", origin: "https://127.0.0.1:8443" },
    tls: { rejectUnauthorized: true, ca: certificate } })
  const received: string[] = []
  socket.onmessage = (event) => received.push(String(event.data))
  const closed = Promise.withResolvers<void>()
  socket.onclose = () => closed.resolve()
  try {
    const deadline = Date.now() + 3_000
    while (!received.length && Date.now() < deadline) await Bun.sleep(10)
    expect(received).toEqual(["actual upstream reader frame"])
    socket.send("original client ping")
    while (received.length < 2 && Date.now() < deadline) await Bun.sleep(10)
    expect(received).toEqual(["actual upstream reader frame", "original client ping"])
    expect(observed).toEqual([{ path: url.pathname, search: url.search, origin: "https://127.0.0.1:8443",
      authorization: "Basic upstream-private", directory: "/private/project" }])
    expect(records).toEqual([{ method: "GET", path: url.pathname, status: 101, origin: "https://127.0.0.1:8443" }])
    await transport.close()
    await closed.promise
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  } finally { socket.close(); await transport.close(); await server.stop(true) }
}, 6_000)
