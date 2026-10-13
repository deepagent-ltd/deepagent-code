export * as BrowserUnavailableCliPTY from "./browser-unavailable-cli-pty"

import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { Schema } from "effect"
import { BrowserCanonicalViewport } from "./browser-canonical-viewport"

export const Descriptor = Schema.Struct({ version: Schema.Literal(1),
  url: Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:[0-9]+$/)), directory: Schema.String,
  sessionID: Schema.String, authorizationFile: Schema.String, output: Schema.String, deadlineAt: Schema.Int })

export async function run(filename: string, dry = false) {
  const input = Schema.decodeUnknownSync(Descriptor)(await Bun.file(filename).json())
  assert(path.isAbsolute(input.directory) && path.isAbsolute(input.output))
  const stat = await fs.lstat(input.authorizationFile)
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size <= 8192)
  const authorization = await Bun.file(input.authorizationFile).text()
  assert(/^Basic [A-Za-z0-9+/]+=*$/.test(authorization))
  if (dry) { console.log(JSON.stringify({ dry: true, originalCLI: "attach", PTY: false, HTTP: false, provider: false })); return }
  assert(input.deadlineAt > Date.now())
  const root = path.join(input.output, "tui-cli-private")
  await fs.mkdir(root, { mode: 0o700 })
  const home = path.join(root, "home")
  await fs.mkdir(path.join(home, ".deepagent/code/state"), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(home, ".deepagent/code/state/kv.json"), JSON.stringify({ tui_locale: "en", animations_enabled: false }), { mode: 0o600 })
  const decoded = Buffer.from(authorization.slice(6), "base64").toString()
  const split = decoded.indexOf(":")
  assert(split > 0)
  const screen = await BrowserCanonicalViewport.create()
  const state = { phase: "original_attach", output: "", queryTail: "", bytes: 0, unavailableVisible: false,
    exactRetry: false, useDisabled: false, dialogClosed: false, exit: undefined as number | undefined,
    restored: false, cleanupSignals: [] as string[] }
  const observer = path.join(root, "http-observer-private.jsonl")
  const decoder = new TextDecoder()
  const terminal = new Bun.Terminal({ cols: 100, rows: 40, name: "xterm-256color", data(tty, bytes) {
    state.bytes += bytes.length
    if (state.bytes > 2_097_152) return
    const text = decoder.decode(bytes, { stream: true })
    state.output += text; screen.feed(text)
    const queries = state.queryTail + text
    for (const match of queries.matchAll(/\x1b\[6n|\x1b\]1[01];\?(?:\x07|\x1b\\)/g)) {
      if (match.index! + match[0].length <= state.queryTail.length) continue
      tty.write(match[0] === "\x1b[6n" ? "\x1b[1;1R" :
        `${match[0].slice(0, 5)}rgb:${match[0].startsWith("\x1b]10;") ? "ffff/ffff/ffff" : "0000/0000/0000"}\x07`)
    }
    state.queryTail = queries.slice(-32)
  } })
  const flags = () => ({ input: terminal.inputFlags, output: terminal.outputFlags, local: terminal.localFlags, control: terminal.controlFlags })
  const before = flags()
  const child = Bun.spawn([process.execPath, "--preload", Bun.resolveSync("@opentui/solid/preload", import.meta.dir),
    "--preload", path.join(import.meta.dir, "browser-unavailable-cli-observer.ts"),
    path.resolve(import.meta.dir, "../../../deepagent-code/src/index.ts"), "attach", input.url,
    "--dir", input.directory, "--session", input.sessionID], { cwd: input.directory, terminal, stderr: "pipe", env: {
    PATH: process.env.PATH, HOME: home, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    DEEPAGENT_CODE_TEST_HOME: home, DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
    DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "1", DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1", DEEPAGENT_ENABLED: "false",
    DEEPAGENT_CODE_SERVER_USERNAME: decoded.slice(0, split), DEEPAGENT_CODE_SERVER_PASSWORD: decoded.slice(split + 1),
    DAC_BROWSER_UNAVAILABLE_OBSERVER_FILE: observer, DAC_BROWSER_UNAVAILABLE_ROOT_URL: input.url,
    TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: "100", LINES: "40",
  } })
  const stderr = new Response(child.stderr).text()
  const deadline = Math.min(input.deadlineAt, Date.now() + 30_000)
  const observed = async () => await Bun.file(observer).exists() ? (await Bun.file(observer).text()).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { family: string; ordinal?: number; requestHash?: string; status?: number; code?: string }) : []
  async function frame(label: string, title = false, absent = false) {
    const until = Math.min(deadline, Date.now() + 8000)
    while (true) {
      const view = await screen.current()
      if ((title ? view.title : view.text).includes(label) !== absent) return view.text
      if (child.exitCode !== null || state.bytes > 2_097_152 || Date.now() >= until) throw new Error("Original unavailable CLI stage was not observable")
      await Bun.sleep(20)
    }
  }
  try {
    await frame("DeepAgent Code", true)
    await frame("QA unavailable model")
    state.phase = "original_browser_approval"
    terminal.write("/browser"); await Bun.sleep(60); terminal.write("\r")
    await frame("Approve and connect")
    terminal.write("\r")
    await frame("First line")
    terminal.write("\r")
    const unavailable = await frame("Not currently available; check the current state")
    assert(!unavailable.includes("Add browser reference to draft"))
    state.useDisabled = true; state.unavailableVisible = true
    terminal.write("\r")
    while ((await observed()).filter((row) => row.family === "browser-create").length < 2) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error("Original unavailable retry was not observed")
      await Bun.sleep(20)
    }
    const replies = await observed()
    assert.equal(replies.length, 2)
    assert(replies.every((row) => row.family === "browser-create" && row.status === 503 && row.code === "BROWSER_HOST_UNAVAILABLE"))
    assert.equal(replies[0].requestHash, replies[1].requestHash)
    state.exactRetry = true
    await frame("Not currently available; check the current state")
    state.phase = "original_close"
    terminal.write("\x1b")
    await frame("Connect an agent browser", false, true)
    const restored = await frame("QA unavailable model")
    assert(!restored.includes("browser controlID:"))
    state.dialogClosed = true
    // Follow the original visible system command after modal refocus, without
    // introducing a renderer destroy/exit or an extra process lifetime owner.
    await Bun.sleep(30)
    terminal.write("/exit")
    await frame("Exit the app")
    terminal.write("\r")
    state.exit = await Promise.race([child.exited, Bun.sleep(5000).then(() => undefined)])
    assert.equal(state.exit, 0)
    assert.deepEqual(flags(), before)
    state.restored = true; state.phase = "complete"
  } finally {
    if (child.exitCode === null) { state.cleanupSignals.push("SIGTERM"); child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(3000)]) }
    if (child.exitCode === null) { state.cleanupSignals.push("SIGKILL"); child.kill("SIGKILL"); await child.exited }
    terminal.close(); await screen.dispose()
    await fs.writeFile(path.join(root, "terminal-private.txt"), state.output, { mode: 0o600 })
    await fs.writeFile(path.join(root, "stderr-private.log"), await stderr, { mode: 0o600 })
    await fs.writeFile(path.join(root, "safe.json"), JSON.stringify({ ...state, output: undefined, queryTail: undefined,
      originalCLI: "attach", actualPTY: true, currentViewport: true, processExited: child.exitCode !== null,
      terminalClosed: terminal.closed, replies: await observed(),
      exitCommand: "original /exit command",
      observer: "QA-only passive fetch preload; no altered receiver/args/response/rejection/lifetime", native: false, provider: false }, null, 2), { mode: 0o600 })
  }
}

if (import.meta.main) await run(process.argv[2], process.argv[3] === "--dry")
