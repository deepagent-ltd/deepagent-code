#!/usr/bin/env bun
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { _electron } from "@playwright/test"
import { createPerformanceViewport } from "./performance-terminal"

const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-installed-performance-"))
await fs.chmod(root, 0o700)
const samples = 24
const idleSamples = 20
const result: Record<string, unknown> = {
  version: "2.0.4", root, samples, idleSamples,
  workload: { guiSessions: 12, messages: 0, concurrentWorks: 0, imConnections: 0, providerExecuted: false },
  hardware: { platform: process.platform, architecture: process.arch, kernel: os.release(), memoryBytes: os.totalmem(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, machineLoad: os.loadavg() },
  slo: { inputEchoP95Ms: 50, loadedSessionSwitchP95Ms: 300, localListPageP95Ms: 300, coldInteractiveP95Ms: 5000 },
  limits: [
    "Diagnostic small-load measurements, not the frozen 1000 Sessions/10000 messages/5 Works/20 IM SLO workload",
    "Only one cold launch per interface; no cold p95/soak/IME/cross-platform claim",
    "GUI input endpoint is two animation frames after a real keydown and visible editor text; driver roundtrip separately recorded",
    "TUI endpoint is receipt of a fresh actual ANSI frame with the expected text, including PTY/parser/renderer time",
    "CPU and RSS are process metrics; machine contention/load recorded, not a dedicated idle hardware benchmark",
    "Private HOME/database/random original port; no provider credentials/model execution/user service/publication",
  ],
}
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
function statistics(values: number[], failures = 0) {
  const sorted = values.toSorted((a, b) => a - b)
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null
  return { n: values.length + failures, successful: values.length, failures, errorRate: failures / Math.max(1, values.length + failures), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), min: sorted[0] ?? null, max: sorted.at(-1) ?? null, samples: values }
}
async function privateEnvironment(name: string) {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { mode: 0o700 })
  await Promise.all(["home", "tmp", "data", "config", "cache", "state", "project"].map((part) => fs.mkdir(path.join(directory, part), { mode: 0o700 })))
  await fs.writeFile(path.join(directory, "project/deepagent-code.json"), JSON.stringify({ lsp: false, formatter: false, autoupdate: false }), { mode: 0o600 })
  const env: Record<string, string> = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "USER", "LOGNAME"].flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []))
  Object.assign(env, {
    HOME: path.join(directory, "home"), TMPDIR: path.join(directory, "tmp"),
    XDG_DATA_HOME: path.join(directory, "data"), XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "state"),
    DEEPAGENT_CODE_TEST_HOME: path.join(directory, "home"), DEEPAGENT_CODE_TEST_ROOT: directory,
    DEEPAGENT_CODE_TEST_ONBOARDING: "1", DEEPAGENT_CODE_DISABLE_CHANNEL_DB: "1",
    DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1", DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
    DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "1", DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "1",
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_DISABLE_SHELL_ENV: "1", DEEPAGENT_ENABLED: "false",
  })
  return { directory, env }
}
function census(filename: string) {
  const db = new Database(filename, { readonly: true })
  try {
    const tables = ["session_input", "session_v2_provider_turn_receipt", "session_v2_tool_effect_admission", "session_v2_tool_effect", "work_execution", "work_dispatch_reservation", "task_run", "task_admission"]
    const counts = Object.fromEntries(tables.map((table) => {
      const row = db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }
      assert.equal(row.count, 0, `Performance observation executed ${table}`)
      return [table, row.count]
    }))
    const session = db.query("SELECT count(*) AS count FROM session").get() as { count: number }
    return { counts, sessions: session.count }
  } finally { db.close() }
}
async function canonical(name: string) {
  const filename = process.env[name]
  if (!filename || !path.isAbsolute(filename) || await fs.realpath(filename) !== filename)
    throw new Error(`${name} must name the canonical immutable private candidate`)
  return filename
}
async function gui() {
  const executable = await canonical("DEEPAGENT_CODE_DESKTOP_EXECUTABLE")
  const runtime = await privateEnvironment("gui")
  const project = path.join(runtime.directory, "project")
  runtime.env.DEEPAGENT_CODE_DB = path.join(runtime.directory, "database.sqlite")
  const started = performance.now()
  const app = await _electron.launch({ executablePath: executable, args: [], env: runtime.env, timeout: 45_000 })
  const measurements: Record<string, unknown> = { executable, cold: true, warmScenarios: true }
  result.gui = measurements
  try {
    const actual = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, executable: process.execPath, application: app.getAppPath(), userData: app.getPath("userData") }))
    assert.equal(actual.version, "2.0.4"); assert.equal(actual.packaged, true); assert.ok(actual.userData.startsWith(root + path.sep))
    measurements.actual = actual
    const page = await app.firstWindow({ timeout: 45_000 })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message.slice(0, 1024)))
    await page.waitForFunction(() => Boolean((window as unknown as { api?: unknown }).api), undefined, { timeout: 45_000 })
    const server = await page.evaluate(() => (window as unknown as { api: { awaitInitialization(): Promise<{ url: string; username: string; password: string }> } }).api.awaitInitialization())
    assert.equal(new URL(server.url).hostname, "127.0.0.1")
    const authorization = `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`
    const request = async (pathname: string, init?: RequestInit) => {
      const url = new URL(pathname, server.url); url.searchParams.set("directory", project)
      const response = await fetch(url, { ...init, headers: { authorization, ...(init?.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`Private ${init?.method ?? "GET"} ${url.pathname} HTTP ${response.status}`)
      return response
    }
    await page.waitForFunction(() => document.body.innerText.includes("Local Server"), undefined, { timeout: 30_000 })
    measurements.coldHome = { endpoint: "driver launch to visible original Home+sidecar initialization", ...statistics([performance.now() - started]) }
    measurements.before = census(runtime.env.DEEPAGENT_CODE_DB)
    const sessions: { id: string; title: string }[] = []
    for (let index = 0; index < 12; index++) {
      const response = await request("/session", { method: "POST", body: JSON.stringify({ title: `DAC performance ${String(index + 1).padStart(2, "0")}` }) })
      sessions.push(await response.json() as { id: string; title: string })
    }
    const slug = Buffer.from(project).toString("base64url")
    await page.evaluate(async ({ project, id, slug }) => {
      const api = (window as unknown as { api: { storeSet(name: string, key: string, value: string): Promise<void> } }).api
      await api.storeSet("deepagent.global.dat", "layout.page", JSON.stringify({ lastProjectSession: { [project]: { directory: project, id, at: Date.now() } } }))
      await api.storeSet("deepagent.global.dat", "server", JSON.stringify({ list: [], projects: { local: [{ worktree: project, expanded: true }] }, lastProject: { local: project } }))
      await api.storeSet("deepagent.global.dat", "layout", JSON.stringify({ sessionView: { [`local\u0000${slug}/${id}`]: { scroll: {} } } }))
    }, { project, id: sessions[0]!.id, slug })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("heading", { name: sessions[0]!.title, exact: true }).waitFor({ state: "visible", timeout: 30_000 })
    const editor = page.locator('[data-component="prompt-input"]')
    await editor.waitFor({ state: "visible", timeout: 10_000 }); await editor.click()
    await page.evaluate(() => {
      type Mark = { start: number; text: string; painted: number }
      const state = { keys: [] as Mark[], click: 0 }
      ;(window as unknown as { dacPerformance: typeof state }).dacPerformance = state
      document.addEventListener("keydown", (event) => {
        if (!(event.target instanceof HTMLElement) || event.target.dataset.component !== "prompt-input") return
        const mark = { start: performance.now(), text: "", painted: 0 }; state.keys.push(mark)
        requestAnimationFrame(() => requestAnimationFrame(() => { mark.text = (event.target as HTMLElement).innerText; mark.painted = performance.now() }))
      }, true)
      document.addEventListener("click", () => { state.click = performance.now() }, true)
    })
    const keyDriver: number[] = []
    const keyPaint: number[] = []
    const draft = { text: "" }
    for (let index = 0; index < samples; index++) {
      const character = String.fromCharCode(65 + index)
      draft.text += character
      const beginning = performance.now(); await page.keyboard.type(character)
      await page.waitForFunction((count) => {
        const state = (window as unknown as { dacPerformance: { keys: { painted: number }[] } }).dacPerformance
        return Boolean(state.keys[count - 1]?.painted)
      }, index + 1, { timeout: 5000 })
      const mark = await page.evaluate((count) => (window as unknown as { dacPerformance: { keys: { start: number; text: string; painted: number }[] } }).dacPerformance.keys[count - 1]!, index + 1)
      assert.equal(mark.text, draft.text)
      keyPaint.push(mark.painted - mark.start); keyDriver.push(performance.now() - beginning)
    }
    measurements.inputPaint = { endpoint: "real captured keydown to two rAFs with exact visible editor text", cache: "warm", candidateP95Ms: 50, ...statistics(keyPaint) }
    measurements.inputDriver = { endpoint: "driver before keyboard.type to observed original paint marker", cache: "warm", ...statistics(keyDriver) }
    await editor.fill("")
    const switchDriver: number[] = []
    const switchPaint: number[] = []
    const targetSessions = sessions.slice(0, 2)
    for (let index = 0; index < samples + 2; index++) {
      const session = targetSessions[(index + 1) % 2]!
      const anchor = page.locator(`a[href="/${slug}/session/${session.id}"]`).first()
      const beginning = performance.now(); await anchor.click({ timeout: 5000 })
      await page.getByRole("heading", { name: session.title, exact: true }).waitFor({ state: "visible", timeout: 5000 })
      const painted = await page.evaluate(() => new Promise<number>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve(performance.now() - (window as unknown as { dacPerformance: { click: number } }).dacPerformance.click)
        }))
      }))
      if (index < 2) continue
      switchPaint.push(painted); switchDriver.push(performance.now() - beginning)
    }
    measurements.loadedSessionSwitch = { endpoint: "actual sidebar anchor click to correct Session heading plus two rAFs; two distinct Sessions warmed first", cache: "warm", candidateP95Ms: 300, ...statistics(switchPaint) }
    measurements.sessionSwitchDriver = { endpoint: "driver before click including Playwright actionability to correct heading+two rAFs", cache: "warm", ...statistics(switchDriver) }
    const listTimes: number[] = []
    for (let index = 0; index < samples; index++) {
      const beginning = performance.now()
      const response = await request("/session?limit=5")
      const data = await response.json() as { id: string }[]
      assert.ok(data.length > 0 && data.length <= 5); listTimes.push(performance.now() - beginning)
    }
    measurements.sessionListFirstPage = { endpoint: "driver before original authenticated GET /session?limit=5 to full parsed JSON; API-only, not UI pagination", cache: "warm", ...statistics(listTimes) }
    await page.screenshot({ path: path.join(root, "gui-session.png"), fullPage: false })
    const readMetrics = () => app.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, name: metric.name, creationTime: metric.creationTime, percentCPUUsage: metric.cpu.percentCPUUsage, cumulativeCPUSeconds: metric.cpu.cumulativeCPUUsage, workingSetKiB: metric.memory.workingSetSize, peakWorkingSetKiB: metric.memory.peakWorkingSetSize })))
    const idle: { elapsedMs: number; load: number[]; metrics: Awaited<ReturnType<typeof readMetrics>> }[] = []
    await app.evaluate(({ app }) => app.getAppMetrics())
    const idleStarted = performance.now()
    for (let index = 0; index < idleSamples; index++) {
      await Bun.sleep(1000)
      const metrics = await readMetrics()
      idle.push({ elapsedMs: performance.now() - idleStarted, load: os.loadavg(), metrics })
    }
    const points = idle.map((point) => point.metrics)
    measurements.idle = { endpoint: "20 one-second actual app.getAppMetrics snapshots across Main/Utility/Renderer/GPU; first CPU reading discarded", elapsedMs: performance.now() - idleStarted, aggregateReportedCPUPercent: statistics(points.map((metrics) => metrics.reduce((sum, metric) => sum + metric.percentCPUUsage, 0))), aggregateWorkingSetKiB: statistics(points.map((metrics) => metrics.reduce((sum, metric) => sum + metric.workingSetKiB, 0))), points: idle }
    measurements.after = census(runtime.env.DEEPAGENT_CODE_DB)
    measurements.pageErrors = errors
    assert.equal(errors.length, 0)
    const closing = performance.now(); await app.close()
    measurements.shutdown = { endpoint: "original ElectronApplication.close to actual exit", ...statistics([performance.now() - closing]), exited: true }
  } catch (error) {
    measurements.error = error instanceof Error ? error.message : String(error)
    const page = app.windows()[0]
    if (page) {
      measurements.failureView = await page.evaluate(() => ({ uri: location.href, text: document.body.innerText.slice(0, 4096), anchors: [...document.querySelectorAll("a")].map((item) => ({ text: item.textContent, href: item.getAttribute("href") })).slice(0, 30) })).catch(() => undefined)
      await page.screenshot({ path: path.join(root, "gui-failure.png") }).catch(() => undefined)
    }
    throw error
  } finally { await app.close().catch(() => undefined) }
}
async function tui() {
  const executable = await canonical("DEEPAGENT_CODE_CLI_EXECUTABLE")
  const runtime = await privateEnvironment("tui")
  const data = path.join(runtime.env.HOME!, ".deepagent/code")
  await fs.mkdir(path.join(data, "state"), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(data, "state/kv.json"), JSON.stringify({ tui_locale: "en", animations_enabled: false }), { mode: 0o600 })
  Object.assign(runtime.env, { DEEPAGENT_CODE_DB: path.join(data, "performance.sqlite"), PWD: path.join(runtime.directory, "project"), TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: "100", LINES: "40" })
  const state = { output: "", bytes: 0, tail: "" }
  const decoder = new TextDecoder()
  const viewport = createPerformanceViewport(100, 40)
  const terminal = new Bun.Terminal({ cols: 100, rows: 40, name: "xterm-256color", data(tty, bytes) {
    state.bytes += bytes.length; if (state.bytes > 8_388_608) return
    const text = decoder.decode(bytes, { stream: true }); state.output += text
    viewport.push(text)
    const queries = state.tail + text
    for (const match of queries.matchAll(/\x1b\[6n|\x1b\]1[01];\?(?:\x07|\x1b\\)/g)) {
      if (match.index! + match[0].length <= state.tail.length) continue
      tty.write(match[0] === "\x1b[6n" ? "\x1b[1;1R" : `${match[0].slice(0, 5)}rgb:${match[0].startsWith("\x1b]10;") ? "ffff/ffff/ffff" : "0000/0000/0000"}\x07`)
    }
    state.tail = queries.slice(-32)
  } })
  const flags = () => ({ input: terminal.inputFlags, output: terminal.outputFlags, local: terminal.localFlags, control: terminal.controlFlags })
  const before = flags()
  const started = performance.now()
  const child = Bun.spawn([executable, path.join(runtime.directory, "project")], { cwd: path.join(runtime.directory, "project"), env: runtime.env, terminal })
  const measurements: Record<string, unknown> = { executable, pid: child.pid, terminal: { columns: 100, rows: 40 }, cache: "warm after one cold launch", emptySessions: true }
  result.tui = measurements
  const wait = async (marker: string, frames = -1, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!viewport.text().includes(marker) || viewport.frames() <= frames) {
      if (child.exitCode !== null || Date.now() > deadline || state.bytes > 8_388_608) throw new Error(`Actual PTY frame missing ${marker}`)
      await Bun.sleep(2)
    }
  }
  try {
    await wait("Ask anything...", -1, 30_000)
    measurements.coldHome = { endpoint: "driver spawn to receipt of actual Home/input ANSI frame", ...statistics([performance.now() - started]) }
    measurements.before = census(runtime.env.DEEPAGENT_CODE_DB!)
    await Bun.sleep(300)
    if (viewport.text().includes("Connect a provider")) {
      const offset = viewport.frames()
      terminal.write("\x1b")
      await wait("Ask anything...", offset)
      measurements.initialProviderDialog = "Original empty-provider onboarding dismissed with Escape; no provider configured"
    }
    terminal.write("qjzx"); await wait("qjzx")
    const echo: number[] = []
    const draft = { text: "qjzx" }
    for (let index = 0; index < samples; index++) {
      draft.text += "z"
      const offset = viewport.frames(); const start = performance.now(); terminal.write("z")
      await wait(draft.text, offset); echo.push(performance.now() - start)
    }
    measurements.inputEcho = { endpoint: "one actual PTY byte write to fresh ANSI frame containing exact cumulative draft", candidateP95Ms: 50, ...statistics(echo) }
    const openList: number[] = []
    const closeList: number[] = []
    for (let index = 0; index < 12; index++) {
      const offset = viewport.frames(); const start = performance.now(); terminal.write("\x18"); await Bun.sleep(20); terminal.write("l")
      await wait("Sessions", offset); openList.push(performance.now() - start)
      const closingOffset = viewport.frames(); const closing = performance.now(); terminal.write("\x1b")
      await wait(draft.text, closingOffset); closeList.push(performance.now() - closing)
    }
    measurements.sessionListOpen = { endpoint: "original CtrlX,L multi-key shortcut to fresh Sessions frame; empty real Session list, not Session switching", ...statistics(openList) }
    measurements.sessionListReturn = { endpoint: "Escape to fresh preserved actual prompt draft frame", ...statistics(closeList) }
    await fs.writeFile(path.join(root, "tui-viewport.txt"), viewport.text(), { mode: 0o600 })
    const idle: { elapsedMs: number; percentCPU: number; rssKiB: number; cumulativeCPUSeconds: number; load: number[] }[] = []
    const idleStarted = performance.now()
    for (let index = 0; index < idleSamples; index++) {
      await Bun.sleep(1000)
      const measured = Bun.spawn(["/bin/ps", "-p", String(child.pid), "-o", "%cpu=,rss=,time="], { stdout: "pipe", stderr: "pipe" })
      const output = await new Response(measured.stdout).text(); assert.equal(await measured.exited, 0)
      const fields = output.trim().split(/\s+/); const time = fields[2]!.split(":").map(Number)
      idle.push({ elapsedMs: performance.now() - idleStarted, percentCPU: Number(fields[0]), rssKiB: Number(fields[1]), cumulativeCPUSeconds: time.reduce((sum, part) => sum * 60 + part, 0), load: os.loadavg() })
    }
    measurements.idle = { endpoint: "actual owned CLI PID ps TIME/RSS snapshots; %cpu is OS lifetime estimate, not an idle-only percentage", elapsedMs: performance.now() - idleStarted, reportedCPUPercent: statistics(idle.map((point) => point.percentCPU)), rssKiB: statistics(idle.map((point) => point.rssKiB)), intervalCPUPercentOneCore: 100 * (idle.at(-1)!.cumulativeCPUSeconds - idle[0]!.cumulativeCPUSeconds) / ((idle.at(-1)!.elapsedMs - idle[0]!.elapsedMs) / 1000), points: idle }
    measurements.after = census(runtime.env.DEEPAGENT_CODE_DB!)
    const closing = performance.now(); terminal.write("\x03")
    const code = await Promise.race([child.exited, Bun.sleep(2000).then(() => { if (child.exitCode === null) terminal.write("\x03"); return child.exited })])
    assert.equal(code, 0); assert.deepEqual(flags(), before); assert.throws(() => process.kill(child.pid, 0))
    measurements.shutdown = { endpoint: "original CtrlC to process exit including original worker shutdown", ...statistics([performance.now() - closing]), code, terminalBefore: before, terminalAfter: flags(), exited: true }
  } catch (error) { measurements.error = error instanceof Error ? error.message : String(error); throw error }
  finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited } }
    terminal.close(); await fs.writeFile(path.join(root, "tui.ansi"), state.output, { mode: 0o600 })
  }
}
console.log(`Installed performance observation started in ${root}`)
const outcomes: { interface: string; error?: string }[] = []
for (const [name, observe] of [["gui", gui], ["tui", tui]] as const) {
  if (process.env.DAC_INSTALLED_PERFORMANCE_ONLY && process.env.DAC_INSTALLED_PERFORMANCE_ONLY !== name) continue
  try { await observe(); outcomes.push({ interface: name }); console.log(`${name} performance completed`) }
  catch (error) { outcomes.push({ interface: name, error: error instanceof Error ? error.message : String(error) }); console.log(`${name} observation failed; retained partial facts`) }
}
result.outcomes = outcomes
result.driver = { path: import.meta.path, bytes: (await fs.stat(import.meta.path)).size, sha256: hash(await fs.readFile(import.meta.path)) }
await fs.writeFile(path.join(root, "safe-result.json"), JSON.stringify(result, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ root, outcomes, safe: path.join(root, "safe-result.json") }))
if (outcomes.some((item) => item.error)) process.exitCode = 1
