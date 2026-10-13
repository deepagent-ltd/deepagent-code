#!/usr/bin/env bun
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"

const executable = process.env.DEEPAGENT_CODE_CLI_EXECUTABLE
if (!executable || !path.isAbsolute(executable) || (await fs.realpath(executable)) !== executable)
  throw new Error("TUI smoke requires the canonical private installed CLI artifact")
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This installer PTY oracle covers the current macOS ARM candidate")
const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-installed-tui-"))
await fs.chmod(root, 0o700)
await Promise.all(["home", "project", "tmp", "config", "data", "cache", "state"].map((name) =>
  fs.mkdir(path.join(root, name), { mode: 0o700 }),
))
const home = path.join(root, "home")
const data = path.join(home, ".deepagent/code")
await fs.mkdir(path.join(data, "state"), { recursive: true, mode: 0o700 })
await fs.writeFile(path.join(data, "state/kv.json"), JSON.stringify({
  tui_locale: "en", animations_enabled: false,
}), { mode: 0o600 })
await fs.writeFile(path.join(root, "project/deepagent-code.json"), JSON.stringify({
  lsp: false, formatter: false, autoupdate: false,
}), { mode: 0o600 })
const environment: Record<string, string> = Object.fromEntries(
  ["PATH", "SHELL", "LANG", "LC_ALL", "USER", "LOGNAME"].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]!]] : [],
  ),
)
Object.assign(environment, {
  HOME: home, DEEPAGENT_CODE_TEST_HOME: home,
  PWD: path.join(root, "project"), TMPDIR: path.join(root, "tmp"),
  XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
  DEEPAGENT_CODE_DB: path.join(data, "pty-smoke.sqlite"),
  DEEPAGENT_CODE_DISABLE_CHANNEL_DB: "1", DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
  DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1", DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "1",
  DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "1", DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
  DEEPAGENT_CODE_DISABLE_SHELL_ENV: "1", TERM: "xterm-256color", COLORTERM: "truecolor",
  COLUMNS: "100", LINES: "40", DEEPAGENT_ENABLED: "false",
})
const flags = (terminal: Bun.Terminal) => ({
  input: terminal.inputFlags, output: terminal.outputFlags,
  local: terminal.localFlags, control: terminal.controlFlags,
})
const state = { output: "", bytes: 0, cancelled: false, queryTail: "" }
const decoder = new TextDecoder()
const started = performance.now()
const terminal = new Bun.Terminal({
  cols: 100, rows: 40, name: "xterm-256color",
  data(tty, bytes) {
    state.bytes += bytes.length
    if (state.bytes > 2_097_152) {
      state.cancelled = true
      return
    }
    const text = decoder.decode(bytes, { stream: true })
    state.output += text
    // Answer only genuine device queries; never send prompt text or a command.
    const queries = state.queryTail + text
    const boundary = state.queryTail.length
    for (const match of queries.matchAll(/\x1b\[6n|\x1b\]1[01];\?(?:\x07|\x1b\\)/g)) {
      if (match.index! + match[0].length <= boundary) continue
      tty.write(match[0] === "\x1b[6n" ? "\x1b[1;1R" :
        `${match[0].slice(0, 5)}rgb:${match[0].startsWith("\x1b]10;") ? "ffff/ffff/ffff" : "0000/0000/0000"}\x07`)
    }
    state.queryTail = queries.slice(-32)
  },
})
const before = flags(terminal)
const child = Bun.spawn([executable, path.join(root, "project")], {
  cwd: path.join(root, "project"), env: environment, terminal,
})
console.log(`Installed TUI smoke started in ${root}; owned PID ${child.pid}`)
const watchdog = setTimeout(() => { state.cancelled = true; child.kill("SIGTERM") }, 40_000)
try {
  const deadline = Date.now() + 30_000
  while (!state.output.includes("DeepAgent Code") || !state.output.includes("Ask anything...")) {
    if (state.cancelled || child.exitCode !== null || Date.now() >= deadline)
      throw new Error("The actual installed TUI did not show its home title and input area")
    await Bun.sleep(20)
  }
  const startupMs = Math.round(performance.now() - started)
  const db = new Database(environment.DEEPAGENT_CODE_DB!, { readonly: true })
  const inventory = Object.fromEntries([
    "session_input", "session_v2_provider_turn_receipt", "session_v2_tool_effect_admission",
    "session_v2_tool_effect", "work_execution", "work_dispatch_reservation", "task_run", "task_admission",
  ].map((table) => {
    const row = db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }
    assert.equal(row.count, 0, `TUI startup admitted or executed ${table}`)
    return [table, row.count]
  }))
  db.close()
  // The original app_exit default includes Ctrl+C and the prompt is untouched.
  // An optional initial connection dialog consumes the first key as its close.
  terminal.write("\x03")
  const ended = await Promise.race([
    child.exited,
    Bun.sleep(2000).then(() => {
      if (child.exitCode === null) terminal.write("\x03")
      return child.exited
    }),
  ])
  assert.equal(ended, 0)
  assert.equal(state.cancelled, false)
  const after = flags(terminal)
  assert.deepEqual(after, before, "Original shutdown must restore terminal mode")
  assert.throws(() => process.kill(child.pid, 0), "The owned CLI process must have exited")
  const bytes = await fs.readFile(executable)
  await fs.writeFile(path.join(root, "safe-result.json"), JSON.stringify({
    version: "2.0.4", executable, executableBytes: bytes.length,
    executableHash: createHash("sha256").update(bytes).digest("hex"),
    terminal: { columns: 100, rows: 40, before, after, originalExitCode: ended, restored: true },
    startupMs, inventory, capturedOutputBytes: state.bytes,
    homeTitle: true, inputArea: true, ownedProcessExited: true,
    limits: ["one interactive startup and ordinary exit; not full TUI/SLO acceptance",
      "no prompt/session/continue/provider credentials/external server",
      "read-only execution census while original worker is alive"],
  }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ state: "passed", root, startupMs, inventory, restored: true, code: ended }))
} finally {
  clearTimeout(watchdog)
  if (child.exitCode === null) {
    child.kill("SIGTERM")
    await Promise.race([child.exited, Bun.sleep(5000)])
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited }
  }
  terminal.close()
  await fs.writeFile(path.join(root, "terminal.ansi"), state.output, { mode: 0o600 })
  console.log(`Installed TUI smoke artifacts retained at ${root}`)
}
