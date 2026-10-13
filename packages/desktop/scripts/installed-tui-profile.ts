#!/usr/bin/env bun
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { createPerformanceViewport } from "./performance-terminal"

const executable = process.env.DEEPAGENT_CODE_CLI_EXECUTABLE
if (!executable || !path.isAbsolute(executable) || await fs.realpath(executable) !== executable)
  throw new Error("Profile requires a canonical immutable private CLI candidate")
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This diagnostic uses macOS sample on the local ARM candidate")
await fs.access("/usr/bin/sample")
const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-installed-tui-profile-"))
await fs.chmod(root, 0o700)
await Promise.all(["home", "project", "tmp", "data", "config", "cache", "state"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
const home = path.join(root, "home")
const data = path.join(home, ".deepagent/code")
await fs.mkdir(path.join(data, "state"), { recursive: true, mode: 0o700 })
await fs.writeFile(path.join(data, "state/kv.json"), JSON.stringify({ tui_locale: "en", animations_enabled: false }), { mode: 0o600 })
await fs.writeFile(path.join(root, "project/deepagent-code.json"), JSON.stringify({ lsp: false, formatter: false, autoupdate: false }), { mode: 0o600 })
const env: Record<string, string> = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "USER", "LOGNAME"].flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []))
Object.assign(env, {
  HOME: home, DEEPAGENT_CODE_TEST_HOME: home, PWD: path.join(root, "project"), TMPDIR: path.join(root, "tmp"),
  XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
  DEEPAGENT_CODE_DB: path.join(data, "profile.sqlite"), DEEPAGENT_CODE_DISABLE_CHANNEL_DB: "1",
  DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1", DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "1",
  DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "1", DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1", DEEPAGENT_CODE_DISABLE_SHELL_ENV: "1", DEEPAGENT_ENABLED: "false",
  TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: "100", LINES: "40",
})
const viewport = createPerformanceViewport(100, 40)
const state = { output: "", bytes: 0, tail: "" }
const decoder = new TextDecoder()
const terminal = new Bun.Terminal({ cols: 100, rows: 40, name: "xterm-256color", data(tty, bytes) {
  state.bytes += bytes.length
  if (state.bytes > 8_388_608) return
  const text = decoder.decode(bytes, { stream: true }); state.output += text; viewport.push(text)
  const query = state.tail + text
  for (const match of query.matchAll(/\x1b\[6n|\x1b\]1[01];\?(?:\x07|\x1b\\)/g)) {
    if (match.index! + match[0].length <= state.tail.length) continue
    tty.write(match[0] === "\x1b[6n" ? "\x1b[1;1R" : `${match[0].slice(0, 5)}rgb:${match[0].startsWith("\x1b]10;") ? "ffff/ffff/ffff" : "0000/0000/0000"}\x07`)
  }
  state.tail = query.slice(-32)
} })
const flags = () => ({ input: terminal.inputFlags, output: terminal.outputFlags, local: terminal.localFlags, control: terminal.controlFlags })
const before = flags()
const child = Bun.spawn([executable, path.join(root, "project")], { cwd: path.join(root, "project"), env, terminal })
const result: Record<string, unknown> = { root, executable, pid: child.pid, hardware: { platform: process.platform, arch: process.arch, kernel: os.release(), cpus: os.cpus().length, memoryBytes: os.totalmem(), cpuModel: os.cpus()[0]?.model }, scope: "one actual CLI process; all native main/worker threads; unsubmitted 28-byte draft; no Session/prompt admission/model/Work", samples: [] }
const wait = async (text: string, frames = -1) => {
  const until = Date.now() + 30_000
  while (!viewport.text().includes(text) || viewport.frames() <= frames) {
    if (child.exitCode !== null || Date.now() > until || state.bytes > 8_388_608) throw new Error(`Profile original PTY missing ${text}`)
    await Bun.sleep(5)
  }
}
const observe = async (phase: string) => {
  const process = Bun.spawn(["/bin/ps", "-p", String(child.pid), "-o", "%cpu=,rss=,time="], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(process.stdout).text(); assert.equal(await process.exited, 0)
  const fields = output.trim().split(/\s+/)
  return { phase, observedAt: performance.now(), psCPUPercent: Number(fields[0]), rssKiB: Number(fields[1]), cumulativeCPUSeconds: fields[2]!.split(":").map(Number).reduce((sum, value) => sum * 60 + value, 0), ansiBytes: state.bytes, completedFrames: viewport.frames(), machineLoad: os.loadavg() }
}
console.log(`One owned TUI profile process started: ${child.pid} in ${root}`)
try {
  await wait("Ask anything...")
  await Bun.sleep(300)
  if (viewport.text().includes("Connect a provider")) { const frames = viewport.frames(); terminal.write("\x1b"); await wait("Ask anything...", frames) }
  const draft = "qjzx" + "z".repeat(24)
  terminal.write(draft); await wait(draft)
  const opening = viewport.frames(); terminal.write("\x18"); await Bun.sleep(20); terminal.write("l"); await wait("Sessions", opening)
  const closing = viewport.frames(); terminal.write("\x1b"); await wait(draft, closing)
  const observations: Awaited<ReturnType<typeof observe>>[] = []
  observations.push(await observe("warm_start"))
  for (let index = 0; index < 10; index++) { await Bun.sleep(1000); observations.push(await observe("idle_before_profile")) }
  const threads = Bun.spawn(["/bin/ps", "-M", "-p", String(child.pid)], { stdout: "pipe", stderr: "pipe" })
  await fs.writeFile(path.join(root, "threads-before.txt"), await new Response(threads.stdout).text(), { mode: 0o600 }); await threads.exited
  observations.push(await observe("profile_start"))
  const profileStarted = performance.now()
  const sample = Bun.spawn(["/usr/bin/sample", String(child.pid), "10", "1", "-file", path.join(root, "native-all-threads.sample.txt")], { stdout: "pipe", stderr: "pipe", timeout: 20_000 })
  const sampled = await Promise.all([sample.exited, new Response(sample.stdout).text(), new Response(sample.stderr).text()])
  await fs.writeFile(path.join(root, "sample-tool.log"), `${sampled[1]}\n${sampled[2]}`, { mode: 0o600 })
  result.profiler = { tool: "/usr/bin/sample", durationSeconds: 10, samplingIntervalMs: 1, code: sampled[0], elapsedMs: performance.now() - profileStarted, path: path.join(root, "native-all-threads.sample.txt"), limitation: "All-thread wall-clock stack samples including waiting threads; not a JavaScript CPU profile or proof that dominant waiting stacks consume CPU" }
  observations.push(await observe("profile_end"))
  for (let index = 0; index < 10; index++) { await Bun.sleep(1000); observations.push(await observe("idle_after_profile")) }
  result.samples = observations
  await fs.writeFile(path.join(root, "actual-viewport.txt"), viewport.text(), { mode: 0o600 })
  const db = new Database(env.DEEPAGENT_CODE_DB!, { readonly: true })
  const counts = Object.fromEntries(["session_input", "session_v2_provider_turn_receipt", "session_v2_tool_effect_admission", "session_v2_tool_effect", "work_execution", "work_dispatch_reservation", "task_run", "task_admission"].map((table) => {
    const row = db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }; assert.equal(row.count, 0); return [table, row.count]
  }))
  db.close(); result.census = counts
  const shutdownStarted = performance.now(); terminal.write("\x03")
  const code = await Promise.race([child.exited, Bun.sleep(2000).then(() => { if (child.exitCode === null) terminal.write("\x03"); return child.exited })])
  assert.equal(code, 0); assert.deepEqual(flags(), before); assert.throws(() => process.kill(child.pid, 0))
  result.shutdown = { code, elapsedMs: performance.now() - shutdownStarted, before, after: flags(), ownedProcessExited: true }
} catch (error) { result.error = error instanceof Error ? error.message : String(error); process.exitCode = 1 }
finally {
  if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited } }
  terminal.close(); await fs.writeFile(path.join(root, "terminal.ansi"), state.output, { mode: 0o600 })
  await fs.writeFile(path.join(root, "safe-result.json"), JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ root, error: result.error, profiler: result.profiler, shutdown: result.shutdown }))
}
