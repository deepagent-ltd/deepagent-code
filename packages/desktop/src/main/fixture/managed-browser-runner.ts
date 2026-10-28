import { app, BrowserWindow } from "electron"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { writeFile, mkdir, copyFile, readFile } from "node:fs/promises"
import path from "node:path"
import { spawnLocalServer } from "../server"
import { spawnUnsealedCanonicalSidecar } from "./unsealed-canonical-sidecar"
import type { DatabaseSync } from "node:sqlite"

function backgroundWork(database: DatabaseSync) {
  const pending = database.prepare(`SELECT
    (SELECT count(*) FROM learning_generation WHERE (trigger IS NOT NULL AND admitted_at IS NULL) OR (trigger IS NULL AND settled_at <= ?)) AS learningGeneration,
    (SELECT count(*) FROM learning_admission_outbox WHERE state = 'pending') AS learningAdmission,
    (SELECT count(*) FROM learning_job WHERE state IN ('queued', 'running', 'reviewing', 'governance')) AS learningJob,
    (SELECT count(*) FROM learning_governance_plan WHERE state = 'prepared') AS learningPlan,
    (SELECT count(*) FROM learning_governance_action WHERE state IN ('prepared', 'running')) AS learningAction,
    (SELECT count(*) FROM deepagent_event_outbox WHERE status IN ('pending', 'publishing')) AS eventOutbox,
    (SELECT count(*) FROM deepagent_event_outbox o CROSS JOIN deepagent_event_consumer c
      LEFT JOIN deepagent_event_consumer_delivery d ON d.outbox_id=o.outbox_id AND d.consumer_key=c.consumer_key
      WHERE o.status='published' AND d.outbox_id IS NULL) AS eventAssignment,
    (SELECT count(*) FROM deepagent_event_consumer_delivery WHERE status IN ('pending', 'claimed')) AS eventDelivery`).get(Date.now() - 120_000)
  if (!pending) throw new Error("Fixture background work could not be observed")
  return pending
}

const root = process.env.DAC_BROWSER_TEST_ROOT!
const mode = process.env.DAC_BROWSER_TEST_MODE ?? "happy"
const interaction = mode.startsWith("interaction")
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.on("window-all-closed", () => {})
app.commandLine.appendSwitch("disable-background-networking")
// Shown interaction qualifiers must not receive ambient pointer events while
// their real native source is checked across awaited canonical tool calls.
if (interaction) app.on("browser-window-created", (_event, window) => {
  window.on("show", () => window.setPosition(-10_000, -10_000))
  window.setPosition(-10_000, -10_000)
})
async function main() {
  await app.whenReady()
  const bodies: Record<string, unknown>[] = []
  const previewRequests: string[] = []
  const posted: string[] = []
  let outsideRequests = 0
  let providerFinished = 0
  const terminalProviderStops = new Set<number>()
  let selectionMutationRejected = false
  let controlID = ""
  let browserMissing = false
  const provider = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions") { outsideRequests++; response.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }
    bodies.push(body)
    const requestOrdinal = bodies.length
    await writeFile(path.join(root, `provider-${bodies.length}.json`), JSON.stringify(body, null, 2))
    browserMissing ||= !body.tools?.some((tool) => tool.function.name === "browser")
    // The ordinary runner requires its real plan tool before the first mutating browser call.
    const ordinal = bodies.length - 1
    const planning = ordinal === 0
    if (planning && !body.tools?.some((tool) => tool.function.name === "plan")) throw new Error("Original registry must offer plan")
    const prior = body.messages.filter((message) => message.role === "tool").at(-1)
    const result = prior && typeof prior.content === "string" && prior.content.startsWith("{") ? JSON.parse(prior.content) as { tabs?: Array<{ tabID: string; generation: number }>; frameID?: string; observationRevision?: number; refs?: Array<{ ref: string; role: string; name: string }> } : undefined
    const tab = result?.tabs?.[0]
    const commands = [ { type: "tabs.list" },
      { type: "navigate", tabID: tab?.tabID, generation: tab?.generation, url: process.env.DAC_BROWSER_ORIGIN + (["unknown", "cancel", "crash"].includes(mode) ? "slow" : "") },
      { type: "snapshot", tabID: tab?.tabID, generation: tab?.generation },
      { type: "screenshot", tabID: tab?.tabID, generation: tab?.generation } ]
    const target = (role: string) => ({ tabID: tab?.tabID, generation: tab?.generation, frameID: result?.frameID,
      observationRevision: result?.observationRevision, ref: result?.refs?.find((value) => value.role === role)?.ref })
    const interactions = [commands[0], commands[1], commands[2],
      { type: "fill", ...target("textbox"), text: "真实中文表单一次" }, commands[2],
      { type: "click", ...target("button"), waitForNavigation: true }, commands[2], commands[3]]
    const tool = planning || ordinal <= (interaction ? 8 : 4) && !browserMissing && (ordinal === 1 || result !== undefined)
    const delta = tool ? { tool_calls: [{ index: 0, id: planning ? "call_plan" : `call_browser_${ordinal}`, type: "function",
      function: { name: planning ? "plan" : "browser", arguments: JSON.stringify(planning
        ? { operation: "create", goal: "Validate the approved browser actions", steps: [{ title: "Execute the scoped browser fixture", status: "active" }] }
        : { controlID, command: (interaction ? interactions : commands)[ordinal - 1], ...(["unknown", "cancel", "crash"].includes(mode) ? { timeoutMs: mode === "unknown" ? 500 : 5_000 } : {}) }) } }] } : { content: "Browser native integration complete" }
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const chunk of [ { choices: [{ index: 0, delta: { role: "assistant" } }] },
      { choices: [{ index: 0, delta }] },
      { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } } ])
      response.write(`data: ${JSON.stringify({ id: `completion-${bodies.length}`, object: "chat.completion.chunk", model: "fixture", created: 0, ...chunk })}\n\n`)
    response.end("data: [DONE]\n\n", () => {
      providerFinished++
      if (!tool) terminalProviderStops.add(requestOrdinal)
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
  const providerAddress = provider.address()
  if (!providerAddress || typeof providerAddress === "string") throw new Error("No provider address")
  const preview = createServer(async (request, response) => {
    previewRequests.push(request.url ?? "")
    if (["unknown", "cancel", "crash"].includes(mode) && request.url === "/slow") return
    if (interaction) {
      if (request.method === "POST") {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        posted.push(Buffer.concat(chunks).toString())
        if (mode === "interaction-redirect-denied") {
          response.writeHead(307, { location: `http://127.0.0.1:${providerAddress.port}/outside` }).end()
          return
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end('<html><body><h1>提交成功：真实中文表单一次</h1></body></html>')
        return
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(`<html><body><h1>受管项目预览</h1><form method="post" action="${mode === "interaction-path-denied" ? "/other" : "/submit"}"><label>姓名<input name="name" type="text"></label>${mode === "interaction-body-denied" ? '<input type="hidden" name="padding" value="' + "a".repeat(65_537) + '">' : ""}<button type="submit">提交</button></form></body></html>`)
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end('<html><body style="background:#142638;color:#e1f6ff"><h1>Canonical Browser PNG</h1><p>真实工具与模型原生图像</p></body></html>')
  })
  await new Promise<void>((resolve) => preview.listen(0, "127.0.0.1", resolve))
  const previewAddress = preview.address()
  if (!previewAddress || typeof previewAddress === "string") throw new Error("No preview address")
  const origin = `http://127.0.0.1:${previewAddress.port}`
  process.env.DAC_BROWSER_ORIGIN = origin + "/"
  const directory = path.join(root, "project")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "deepagent-code.json"), JSON.stringify({ formatter: false, lsp: false,
    model: "fixture/test-model", permission: { "*": "allow", browser: ["permission", "retired", "selection-drift"].includes(mode) ? "ask" : "allow" }, provider: { deepagent: { options: { selfLearning: "manual", durableLearning: false } }, fixture: { name: "Fixture", npm: "@ai-sdk/openai-compatible",
      env: [], options: { apiKey: "loopback-fixture", baseURL: `http://127.0.0.1:${providerAddress.port}/v1` }, models: {
        "test-model": { id: "test-model", name: "Fixture", attachment: true, tool_call: true,
          modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 100_000, output: 10_000 }, cost: { input: 0, output: 0 } } } } } }))
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const address = probe.address()
  if (!address || typeof address === "string") throw new Error("No server address")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const password = "private-browser-fixture"
  if (mode === "missing-native-cohort") {
    try {
      const unexpected = await spawnLocalServer("127.0.0.1", address.port, password, { onStdout: console.log, onStderr: console.error })
      await unexpected.listener.stop()
      throw new Error("Source-only Windows fixture unexpectedly acquired an installed cohort")
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND" ||
        !error.message.includes(path.join(root, "chunks", "native-image-factory.node"))) throw error
      await writeFile(path.join(root, "result.json"), JSON.stringify({ refused: true, code: error.code, missingFixedAddon: true,
        nativeWindowsWitness: false, providerRequests: bodies.length, previewRequests }))
    } finally {
      provider.closeAllConnections(); preview.closeAllConnections()
      provider.close(); preview.close()
    }
    return
  }
  const startServer = () => process.platform === "win32"
    ? spawnUnsealedCanonicalSidecar(root, address.port, password)
    : spawnLocalServer("127.0.0.1", address.port, password, { onStdout: console.log, onStderr: console.error })
  let server = await startServer()
  await server.health.wait
  const url = `http://127.0.0.1:${address.port}`
  const authorization = `Basic ${Buffer.from(`deepagent-code:${password}`).toString("base64")}`
  const call = async (route: string, body?: unknown, auth = true, placement = directory,
    observations?: Array<{ route: string; status: number; elapsedMs: number }>) => {
    const started = performance.now()
    const response = await fetch(url + route, { method: body === undefined ? "GET" : "POST", headers: {
      ...(auth ? { authorization } : {}), "content-type": "application/json", "x-deepagent-code-directory": placement },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    observations?.push({ route, status: response.status, elapsedMs: performance.now() - started })
    if (!response.ok) throw new Error(`${route} HTTP ${response.status}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  const waitForSettled = async (sessionID: string, requests: number, duration: number, withBackground = false) => {
    const { DatabaseSync } = await import("node:sqlite")
    const database = new DatabaseSync(path.join(root, "authority.sqlite"), { readOnly: true })
    try {
      const deadline = Date.now() + duration
      while (Date.now() < deadline) {
        const activity = database.prepare("SELECT a.state, s.execution_claim_token FROM session_activity a JOIN session s ON s.id=a.session_id WHERE a.session_id=? ORDER BY a.ordinal DESC LIMIT 1").get(sessionID)
        // Activity settlement precedes the drain's learning/event finalizers. The
        // claim is released only with the terminal execution event, before GET snapshots.
        if (bodies.length >= requests && activity?.state === "settled" && activity.execution_claim_token === null) {
          if (!withBackground) return
          // These independent daemons outlive the Session claim. Wait on their
          // durable completion inside the same deadline before the all-table GET oracle.
          const pending = backgroundWork(database)
          if (Object.values(pending).every((count) => count === 0)) return { observedAt: Date.now(), pending }
        }
        if (activity && ["failed", "interrupted"].includes(String(activity.state)))
          throw new Error(`Fixture activity did not settle: ${JSON.stringify(activity)}`)
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const activity = database.prepare("SELECT a.state, s.execution_claim_token IS NOT NULL AS claimActive FROM session_activity a JOIN session s ON s.id=a.session_id WHERE a.session_id=? ORDER BY a.ordinal DESC LIMIT 1").get(sessionID)
      const turns = database.prepare("SELECT request_ordinal, state, error_code FROM session_v2_provider_turn_receipt WHERE session_id=? ORDER BY request_ordinal DESC LIMIT 8").all(sessionID)
      throw new Error(`Fixture activity did not settle after ${bodies.length}/${requests} provider requests; providerFinished=${providerFinished}; activity=${JSON.stringify(activity)}; turns=${JSON.stringify(turns)}; background=${JSON.stringify(backgroundWork(database))}`)
    } finally { database.close() }
  }
  const waitForBrowserRejection = async (sessionID: string, duration: number) => {
    const { DatabaseSync } = await import("node:sqlite")
    const database = new DatabaseSync(path.join(root, "authority.sqlite"), { readOnly: true })
    const effects = () => database.prepare(`SELECT e.state FROM session_v2_tool_effect_admission a
      JOIN session_v2_tool_effect e ON e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id
        AND e.session_id=a.session_id AND e.tool_name=a.tool_name
      WHERE a.session_id=? AND a.tool_name='browser' AND a.tool_call_id='call_browser_1'`).all(sessionID)
    try {
      const started = performance.now()
      // The first provider turn runs the real plan tool and cold project setup.
      // Start the denial window only after the Browser provider response is sent.
      const readyDeadline = Date.now() + 15_000
      while (providerFinished < 2 && Date.now() < readyDeadline)
        await new Promise((resolve) => setTimeout(resolve, 25))
      if (providerFinished < 2)
        throw new Error(`Fixture Browser request was not ready after ${bodies.length}/2 provider requests; providerFinished=${providerFinished}`)
      console.log(JSON.stringify({ test: "browser-rejection", phase: "browser-provider-ready",
        elapsedMs: Math.round(performance.now() - started), providerFinished }))
      const deadline = Date.now() + duration
      while (Date.now() < deadline) {
        if (bodies.length > 3) throw new Error("Fixture Browser rejection made an unexpected provider request")
        const observed = effects()
        if (observed.length === 1 && observed[0]!.state === "settled" && bodies.length === 3 &&
            providerFinished >= 3 && terminalProviderStops.has(3)) {
          const body = JSON.parse(await readFile(path.join(root, "provider-3.json"), "utf8")) as {
            messages: Array<{ role: string; content: unknown }>
          }
          const error = body.messages.findLast((message) => message.role === "tool")?.content
          const expected = mode === "selection-drift" ? "rejected"
            : ["retired", "control-tamper"].includes(mode) ? "BROWSER_AUTHORITY_REQUIRED" : "BROWSER_SCOPE_DENIED"
          if (typeof error !== "string" || !error.includes(expected))
            throw new Error("Fixture Browser rejection did not persist its expected provider error history")
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`Fixture Browser rejection did not settle after ${bodies.length}/3 provider requests; providerFinished=${providerFinished}; terminalStop3=${terminalProviderStops.has(3)}; effects=${JSON.stringify(effects())}`)
    } finally { database.close() }
  }
  try {
    if (mode === "identity") {
      const { DatabaseSync } = await import("node:sqlite")
      const database = new DatabaseSync(path.join(root, "authority.sqlite"), { readOnly: true })
      const indexed: Array<{ kind: string; matched: boolean; stopped: boolean }> = []
      const sessions: Array<{ id: string; directory: string }> = []
      for (const kind of ["registered_root", "git"]) {
        const currentDirectory = path.join(root, kind)
        await mkdir(currentDirectory, { recursive: true })
        await copyFile(path.join(directory, "deepagent-code.json"), path.join(currentDirectory, "deepagent-code.json"))
        if (kind === "git") {
          execFileSync("git", ["init", "--quiet"], { cwd: currentDirectory })
          execFileSync("git", ["-c", "user.name=Browser Fixture", "-c", "user.email=browser@invalid", "commit", "--allow-empty", "--quiet", "-m", "fixture"], { cwd: currentDirectory })
          execFileSync("git", ["remote", "add", "origin", "https://fixture.invalid/identity-original.git"], { cwd: currentDirectory })
        }
        const createdSession = await call("/api/session", { model: { id: "test-model", providerID: "fixture" } }, true, currentDirectory)
        sessions.push({ id: createdSession.data.id, directory: currentDirectory })
        await call(`/context/readiness?session_id=${createdSession.data.id}`, undefined, true, currentDirectory)
        const location = database.prepare("SELECT l.*, p.project_kind FROM context_location_identity l JOIN context_project_scope_identity p ON p.project_scope_key=l.project_scope_key AND p.security_namespace_id=l.security_namespace_id WHERE canonical_root=?").get(currentDirectory)
        if (!location) throw new Error("Actual indexed location was not created")
        const currentControl = await call("/api/v1/browser/controls", { requestID: `indexed-${kind}`, sessionID: createdSession.data.id,
          profile: "managed-loopback-interaction-v1", postPaths: ["/submit"], origin, expiresAt: Date.now() + 60_000 }, true, currentDirectory)
        const stopped = await call(`/api/v1/browser/controls/${currentControl.control.controlID}/cancel`, { requestID: `stop-${kind}`, expectedRevision: currentControl.control.revision }, true, currentDirectory)
        indexed.push({ kind, matched: location.project_kind === kind && currentControl.control.scope.locationKey === location.location_key && currentControl.control.scope.projectScopeKey === location.project_scope_key, stopped: stopped.stopConfirmed })
      }
      const snapshot = () => ({ controls: database.prepare("SELECT * FROM browser_control ORDER BY control_id").all(),
        locations: database.prepare("SELECT * FROM context_location_identity ORDER BY location_key").all(),
        projects: database.prepare("SELECT * FROM context_project_scope_identity ORDER BY project_scope_key").all() })
      const before = snapshot()
      const windowsBefore = BrowserWindow.getAllWindows().length
      const selected = sessions[1]!
      execFileSync("git", ["remote", "set-url", "origin", "https://fixture.invalid/identity-changed.git"], { cwd: selected.directory })
      const changed = await fetch(url + "/api/v1/browser/controls", { method: "POST", headers: { authorization, "content-type": "application/json", "x-deepagent-code-directory": selected.directory },
        body: JSON.stringify({ requestID: "changed-filesystem", sessionID: selected.id, profile: "managed-loopback-interaction-v1", postPaths: ["/submit"], origin, expiresAt: Date.now()+60_000 }) })
      const drift = { status: changed.status, body: await changed.text() }
      const after = snapshot()
      // Both original non-git observers are valid; use a foreign ID outside that closed pair.
      // This is a deliberately inconsistent private fixture, never a source of authority.
      const fixtureDB = new DatabaseSync(path.join(root, "authority.sqlite"))
      const prior = sessions[0]!
      const location = fixtureDB.prepare("SELECT project_scope_key FROM context_location_identity WHERE canonical_root=?").get(prior.directory)!
      fixtureDB.exec("BEGIN IMMEDIATE")
      fixtureDB.prepare("UPDATE context_location_identity SET observed_project_id='project_foreign_fixture' WHERE canonical_root=?").run(prior.directory)
      fixtureDB.prepare("UPDATE context_project_scope_identity SET observed_project_id='project_foreign_fixture' WHERE project_scope_key=?").run(String(location.project_scope_key))
      fixtureDB.exec("COMMIT")
      fixtureDB.close()
      const foreignBefore = snapshot()
      const foreign = await fetch(url + "/api/v1/browser/controls", { method: "POST", headers: { authorization, "content-type": "application/json", "x-deepagent-code-directory": prior.directory },
        body: JSON.stringify({ requestID: "foreign-wrong-binding", sessionID: prior.id, profile: "managed-loopback-interaction-v1", postPaths: ["/submit"], origin, expiresAt: Date.now()+60_000 }) })
      const foreignBinding = { status: foreign.status, body: await foreign.text(), before: foreignBefore, after: snapshot() }
      await writeFile(path.join(root, "result.json"), JSON.stringify({ indexed, drift, before, after, foreignBinding, windowsBefore,
        windowsAfter: BrowserWindow.getAllWindows().length, providerRequests: bodies.length, previewRequests }, null, 2))
      database.close()
      return
    }
    const session = await call("/api/session", { model: { id: "test-model", providerID: "fixture" } })
    const control = await call("/api/v1/browser/controls", { requestID: "canonical-control", sessionID: session.data.id,
      ...(interaction ? { profile: "managed-loopback-interaction-v1", postPaths: ["/submit"] } : { profile: "managed-loopback-preview-v1" }), origin, expiresAt: Date.now() + 60_000 })
    controlID = control.control.controlID
    if (mode === "control-tamper") {
      const { DatabaseSync } = await import("node:sqlite")
      const db = new DatabaseSync(path.join(root, "authority.sqlite"))
      const changed = { ...control.control, origin: "http://127.0.0.1:1" }
      const record = CanonicalJson.stringify(changed)
      try {
        // Match the other owned mutation probes while the sidecar finishes its write.
        db.exec("PRAGMA busy_timeout=5000")
        db.prepare("UPDATE browser_control SET origin = ?, record = ?, record_hash = ? WHERE control_id = ?").run(
          changed.origin, record, createHash("sha256").update(record).digest("hex"), controlID)
      } finally { db.close() }
    }
    const invokeDirectory = mode === "wrong-root" ? path.join(root, "other-project") : directory
    if (mode === "wrong-root") {
      await mkdir(invokeDirectory, { recursive: true })
      await copyFile(path.join(directory, "deepagent-code.json"), path.join(invokeDirectory, "deepagent-code.json"))
    }
    const invokeSession = ["wrong-root", "wrong-session"].includes(mode)
      ? await call("/api/session", { model: { id: "test-model", providerID: "fixture" } }, true, invokeDirectory) : session
    const prompt = { id: "msg_browser_original", prompt: { text: "Observe the connected local preview in browser, including its PNG." }, resume: true }
    const admitted = await call(`/api/session/${invokeSession.data.id}/prompt`, prompt)
    if (["unknown", "cancel", "crash"].includes(mode)) {
      const deadline = Date.now() + 15_000
      while (!previewRequests.includes("/slow") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
      let explicitCancel: unknown
      let killedPID: number | undefined
      if (mode === "cancel") explicitCancel = await call(`/api/v1/browser/controls/${controlID}/cancel`, {
        requestID: "stop-dispatched-navigation", expectedRevision: control.control.revision,
      })
      if (mode === "crash") {
        const candidates = app.getAppMetrics().filter((item) => item.type === "Utility" && item.name === "deepagent-code server")
        await writeFile(path.join(root, "owned-processes.json"), JSON.stringify(app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type, name: item.name }))))
        if (candidates.length !== 1) throw new Error("Owned sidecar process identity unavailable")
        killedPID = candidates[0]!.pid
        process.kill(killedPID, "SIGKILL")
      }
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      const afterUnknown = bodies.length
      const sameProcess = mode === "crash" ? undefined : await call(`/api/session/${session.data.id}/prompt`, prompt)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const sameProcessRequests = bodies.length
      const observed = mode === "crash" ? undefined : await call(`/api/v1/browser/controls/${controlID}`)
      await server.listener.stop()
      server = await startServer()
      await server.health.wait
      const coldObserved = await call(`/api/v1/browser/controls/${controlID}`)
      const { DatabaseSync } = await import("node:sqlite")
      const coldDatabase = new DatabaseSync(path.join(root, "authority.sqlite"), { readOnly: true })
      const action = coldDatabase.prepare("SELECT action_id, record FROM browser_action ORDER BY created_at DESC LIMIT 1").get()!
      const coldAction = await call(`/api/v1/browser/actions/${action.action_id}`)
      const unchangedAction = coldDatabase.prepare("SELECT record FROM browser_action WHERE action_id = ?").get(String(action.action_id))!.record === action.record
      coldDatabase.close()
      const coldRetry = await call(`/api/session/${session.data.id}/prompt`, prompt)
      await new Promise((resolve) => setTimeout(resolve, 600))
      await writeFile(path.join(root, "result.json"), JSON.stringify({ mode, session, admitted, afterUnknown, sameProcess,
        sameProcessRequests, observed, explicitCancel, killedPID, coldObserved, coldAction, unchangedAction, coldRetry, providerRequests: bodies.length, previewRequests }, null, 2))
      return
    }
    const permissions: Array<{ id: string; providerFinished: number }> = []
    if (["permission", "retired", "selection-drift"].includes(mode)) {
      const deadline = Date.now() + 15_000
      while (permissions.length < (["retired", "selection-drift"].includes(mode) ? 1 : 4) && Date.now() < deadline) {
        const pending = await call(`/api/session/${session.data.id}/permission`)
        for (const request of pending.data) {
          if (permissions.some((value) => value.id === request.id)) continue
          permissions.push({ id: request.id, providerFinished })
          if (["retired", "selection-drift"].includes(mode)) {
            const { DatabaseSync } = await import("node:sqlite")
            const db = new DatabaseSync(path.join(root, "authority.sqlite"))
            // Wait for the real runner's short write before testing its immutable trigger.
            db.exec("PRAGMA busy_timeout=5000")
            if (mode === "retired")
              db.prepare("UPDATE context_security_namespace SET retired_at = ? WHERE id = ?").run(Date.now(), control.control.scope.securityNamespaceID)
            if (mode === "selection-drift") {
              const before = db.prepare("SELECT projection, projection_hash FROM session_context_selection WHERE session_id = ?").all(session.data.id)
              try { db.prepare("UPDATE session_context_selection SET projection = projection || ' ' WHERE session_id = ?").run(session.data.id) }
              catch (error) {
                selectionMutationRejected = error instanceof Error && error.message.includes("immutable")
                await writeFile(path.join(root, "selection-mutation-error.json"), JSON.stringify({ message: String(error),
                  code: error && typeof error === "object" && "code" in error ? error.code : null, rows: before.length }))
              }
              if (JSON.stringify(before) !== JSON.stringify(db.prepare("SELECT projection, projection_hash FROM session_context_selection WHERE session_id = ?").all(session.data.id)))
                throw new Error("Selection mutated")
            }
            db.close()
          }
          await call(`/api/session/${session.data.id}/permission/${request.id}/reply`, { reply: mode === "selection-drift" ? "reject" : "once" })
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    if (["wrong-root", "wrong-session", "retired", "selection-drift", "control-tamper"].includes(mode)) {
      await waitForBrowserRejection(invokeSession.data.id, 3_000)
      // This denial oracle owns a Browser receipt, not natural Session drain
      // completion. Join the original stop before observing final side effects.
      await server.listener.stop()
      await writeFile(path.join(root, "result.json"), JSON.stringify({ mode, session, invokeSession, admitted,
        permissions, selectionMutationRejected, providerRequests: bodies.length, previewRequests,
        fixtureCompletion: "browser-rejection-receipt" }, null, 2))
      return
    }
    const { DatabaseSync } = await import("node:sqlite")
    const deniedProgress = () => {
      const database = new DatabaseSync(path.join(root, "authority.sqlite"), { readOnly: true })
      try {
        return {
          providerRequests: bodies.length,
          providerFinished,
          activity: database.prepare("SELECT a.state, s.execution_claim_token IS NOT NULL AS claimActive FROM session_activity a JOIN session s ON s.id=a.session_id WHERE a.session_id=? ORDER BY a.ordinal DESC LIMIT 1").get(invokeSession.data.id),
          providerReceipts: database.prepare("SELECT request_ordinal, state, error_code FROM session_v2_provider_turn_receipt WHERE session_id=? ORDER BY request_ordinal").all(invokeSession.data.id),
          toolEffects: database.prepare("SELECT a.tool_call_id, a.tool_name, a.effect_kind, e.state, e.error_code FROM session_v2_tool_effect_admission a LEFT JOIN session_v2_tool_effect e ON e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id WHERE a.session_id=? ORDER BY a.time_created, a.tool_call_id").all(invokeSession.data.id),
          actions: database.prepare("SELECT outcome, json_extract(record, '$.command.type') AS commandType, json_extract(record, '$.command.generation') AS generation FROM browser_action ORDER BY created_at").all(),
        }
      } finally { database.close() }
    }
    const deadline = Date.now() + 40_000
    while (mode.endsWith("-denied") && bodies.length < 9 && Date.now() < deadline) {
      const progress = deniedProgress()
      // A failed earlier tool must not disappear behind the later click-count
      // assertion after a full deadline. These reads never retry an input.
      if (!progress.actions.some((action) => action.commandType === "click") &&
          (["settled", "failed", "interrupted"].includes(String(progress.activity?.state)) ||
            progress.providerReceipts.some((receipt) => receipt.state === "failed"))) {
        await writeFile(path.join(root, "denied-progress.json"), JSON.stringify({ reason: "ended-before-click", ...progress }, null, 2))
        throw new Error(`Denied interaction ended before its click: ${JSON.stringify(progress)}`)
      }
      if (bodies.length >= 6 && progress.actions.at(-1)?.outcome === "unknown") break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const deniedDiagnostic = mode.endsWith("-denied") ? deniedProgress() : undefined
    if (deniedDiagnostic)
      await writeFile(path.join(root, "denied-progress.json"), JSON.stringify({ reason: Date.now() >= deadline ? "deadline" : "observed", ...deniedDiagnostic }, null, 2))
    const backgroundBoundary = mode.endsWith("-denied") ? undefined : await waitForSettled(invokeSession.data.id,
      interaction ? 10 : 6, 40_000, ["happy", "interaction"].includes(mode))
    const observed = await call(`/api/v1/browser/controls/${controlID}`)
    const stopped = await call(`/api/v1/browser/controls/${controlID}/cancel`, { requestID: "canonical-cancel", expectedRevision: observed.control.revision })
    const denied = await fetch(url + `/api/v1/browser/controls/${controlID}`)
    const database = new DatabaseSync(path.join(root, "authority.sqlite"), { readOnly: true })
    const getObservation = { backgroundBoundary, pendingBefore: backgroundWork(database),
      requests: [] as Array<{ route: string; status: number; elapsedMs: number }>, pendingAfter: {} as ReturnType<typeof backgroundWork> }
    if (backgroundBoundary && Object.values(getObservation.pendingBefore).some((count) => count !== 0))
      throw new Error(`Fixture background work resumed before GET: ${JSON.stringify(getObservation.pendingBefore)}`)
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    const snapshot = () => tables.map((table) => ({ name: String(table.name), rows: JSON.stringify(
      database.prepare(`SELECT * FROM "${String(table.name).replaceAll('"', '""')}"`).all()) }))
    const beforeGet = snapshot()
    const controlRead = await call(`/api/v1/browser/controls/${controlID}`, undefined, true, directory, getObservation.requests)
    const actions = database.prepare("SELECT action_id FROM browser_action ORDER BY action_id").all()
    for (const action of actions) await call(`/api/v1/browser/actions/${action.action_id}`, undefined, true, directory, getObservation.requests)
    const afterGet = snapshot()
    getObservation.pendingAfter = backgroundWork(database)
    const getWriteTables = beforeGet.filter((table, index) => table.rows !== afterGet[index]!.rows).map((table) => table.name)
    database.close()
    const forbiddenAction = await fetch(url + "/api/v1/browser/actions", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ effectID: "caller-invented" }) })
    const queryAuth = await fetch(url + `/api/v1/browser/controls/${controlID}?auth_token=untrusted`)
    let coldHistory: unknown
    if (mode === "happy") {
      await server.listener.stop()
      server = await startServer()
      await server.health.wait
      const beforeRead = { provider: bodies.length, preview: previewRequests.length }
      coldHistory = { control: await call(`/api/v1/browser/controls/${controlID}`),
        context: await call(`/api/session/${session.data.id}/context`),
        beforeRead, afterRead: { provider: bodies.length, preview: previewRequests.length } }
    }
    await writeFile(path.join(root, "result.json"), JSON.stringify({ control, observed, stopped, session, admitted,
      permissions, previewRequests, posted, outsideRequests, controlRead, getNoWrites: getWriteTables.length === 0, getWriteTables, getObservation, forbiddenActionStatus: forbiddenAction.status, queryAuthStatus: queryAuth.status, providerRequests: bodies.length, browserMissing, unauthorizedStatus: denied.status,
      coldHistory, deniedDiagnostic,
      fixtureDevMint: process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT === "1" }, null, 2))
  } finally {
    await server.listener.stop()
    provider.closeAllConnections(); preview.closeAllConnections()
    provider.close(); preview.close()
  }
}
void main().then(() => app.exit(0)).catch(async (error) => {
  console.error(error)
  await writeFile(path.join(root, "error.json"), JSON.stringify({ message: String(error), stack: error.stack }))
  app.exit(1)
})
