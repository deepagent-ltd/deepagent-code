export * as BrowserCanonicalPTY from "./browser-canonical-pty"

import { BrowserClientWindow } from "../../../app/test/fixture/browser-client-window-descriptor"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import { BrowserCanonicalViewport } from "./browser-canonical-viewport"

export async function run(descriptorFile: string, dry = false, startupOnly = false) {
  const { input, authorization } = await BrowserClientWindow.read(descriptorFile, !dry)
  if (dry) { console.log(JSON.stringify({ dry: true, originalCLI: "attach", promptCalls: 0, PTY: false })); return }
  const root = path.join(input.output, "client-tui-private")
  await fs.mkdir(root, { mode: 0o700 })
  const home = path.join(root, "home")
  await fs.mkdir(path.join(home, ".deepagent/code/state"), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(home, ".deepagent/code/state/kv.json"), JSON.stringify({ tui_locale: "en", animations_enabled: false,
    intelligence_mode: { [input.sessions.tui]: false } }), { mode: 0o600 })
  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8")
  const split = decoded.indexOf(":")
  assert(split > 0)
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: root,
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"), DEEPAGENT_CODE_TEST_HOME: home,
    DEEPAGENT_CODE_SERVER_USERNAME: decoded.slice(0, split), DEEPAGENT_CODE_SERVER_PASSWORD: decoded.slice(split + 1),
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
    DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "1", DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1", DEEPAGENT_ENABLED: "false",
    TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: "100", LINES: "40" }
  const state = { phase: "original_attach", bytes: 0, output: "", queryTail: "", explicitUse: false,
    controlID: "", approvals: 0, stopConfirmed: false, cancelled: false, originalExit: undefined as number | undefined,
    restored: false, promptSubmitted: false, cleanupSignals: [] as string[] }
  const diagnostic = process.env.DAC_BROWSER_TUI_STARTUP_TRACE === "1"
  const screen = await BrowserCanonicalViewport.create()
  const started = performance.now()
  const mark = (stage: string, value: Record<string, unknown> = {}) => {
    if (diagnostic) appendFileSync(path.join(root, "driver-timing-private.jsonl"), JSON.stringify({ stage,
      elapsedMs: Math.round(performance.now() - started), wallClockMs: Date.now(), pid: process.pid, ...value }) + "\n", { mode: 0o600 })
  }
  mark("driver-start", { ppid: process.ppid, startupOnly })
  const decoder = new TextDecoder()
  const terminal = new Bun.Terminal({ cols: 100, rows: 40, name: "xterm-256color", data(tty, bytes) {
    state.bytes += bytes.length
    if (state.bytes > 4_194_304) { state.cancelled = true; return }
    const text = decoder.decode(bytes, { stream: true })
    state.output += text
    screen.feed(text)
    const queries = state.queryTail + text
    for (const match of queries.matchAll(/\x1b\[6n|\x1b\]1[01];\?(?:\x07|\x1b\\)/g)) {
      if (match.index! + match[0].length <= state.queryTail.length) continue
      tty.write(match[0] === "\x1b[6n" ? "\x1b[1;1R" :
        `${match[0].slice(0, 5)}rgb:${match[0].startsWith("\x1b]10;") ? "ffff/ffff/ffff" : "0000/0000/0000"}\x07`)
    }
    state.queryTail = queries.slice(-32)
  }, exit(_tty, lifecycleStatus, signal) { mark("pty-stream-close", { lifecycleStatus, signal }) } })
  const flags = () => ({ input: terminal.inputFlags, output: terminal.outputFlags, local: terminal.localFlags, control: terminal.controlFlags })
  const before = flags()
  // Source CLI execution from the private project needs the same transform
  // that its original bunfig and the compiled CLI install before loading JSX.
  const child = Bun.spawn([process.execPath, "--preload", Bun.resolveSync("@opentui/solid/preload", import.meta.dir),
    ...(diagnostic ? ["--preload", path.join(import.meta.dir,
    "browser-canonical-cli-trace.ts")] : []), path.resolve(import.meta.dir, "../../../deepagent-code/src/index.ts"),
    "attach", input.rootURL, "--dir", input.directory, "--session", input.sessions.tui], {
    cwd: input.directory, env: { ...environment, ...(diagnostic ? {
      DAC_BROWSER_TUI_TRACE_FILE: path.join(root, "startup-trace-private.jsonl") } : {}) }, terminal, stderr: "pipe",
  })
  mark("child-start", { childPID: child.pid })
  void child.exited.then((code) => mark("child-exited", { code }))
  const stderr = new Response(child.stderr).text()
  const client = createDeepAgentCodeClient({ baseUrl: input.rootURL, headers: { Authorization: authorization } })
  const deadline = Math.min(input.deadlineAt, Date.now() + (startupOnly ? 15_000 : 100_000))
  const watchdog = setTimeout(() => { state.cancelled = true; child.kill("SIGTERM") }, Math.max(1, deadline - Date.now()))
  async function text(value: string, title = false) {
    const until = Math.min(deadline, Date.now() + 8000)
    while (true) {
      const view = await screen.current()
      if ((title ? view.title : view.text).includes(value)) return
      if (child.exitCode !== null || state.cancelled || Date.now() >= until) throw new Error("Original CLI stage did not become observable")
      await Bun.sleep(20)
    }
  }
  async function choose(index: number) {
    for (const _ of Array.from({ length: index })) { terminal.write("\x1b[B"); await Bun.sleep(15) }
    terminal.write("\r")
    await Bun.sleep(50)
  }
  async function replace(value: string) {
    // Original Home/Shift+End/Backspace key bindings select the complete real textarea.
    terminal.write("\x1b[H\x1b[1;2F\x7f")
    terminal.write(`\x1b[200~${value}\x1b[201~`)
    await Bun.sleep(30)
    terminal.write("\r")
  }
  async function open(expected = "Approve and connect") { terminal.write("/browser"); await Bun.sleep(60); terminal.write("\r"); await text(expected) }
  try {
    // Session titles use the original OSC title, while the prompt model is
    // drawn in the terminal frame. Neither waits for an exit-only epilogue.
    await text("OC | Canonical browser tui", true)
    await text("QA test model")
    if (startupOnly) {
      state.phase = "original_startup_visible"
      terminal.write("\x03")
      state.originalExit = await child.exited
      assert.equal(state.originalExit, 0)
      assert.deepEqual(flags(), before)
      state.restored = true
      state.phase = "startup_complete"
      return
    }
    state.phase = "original_browser_policy"
    await open()
    await choose(6)
    await text("Configure bounded page changes")
    await replace(JSON.stringify({ operations: ["fill", "select", "click"], maxSteps: 3 }))
    await text("Read-only verification")
    state.phase = "original_browser_code"
    await choose(2)
    await text("Page validation code")
    terminal.write(`\x1b[200~${input.program.source}\x1b[201~`)
    terminal.write("\r")
    await text("JSON arguments")
    await replace(input.program.argsJSON)
    await text("Approve and connect")
    state.phase = "original_browser_connect"
    await choose(0)
    await text("First line")
    await replace(input.pageOrigin + "\n" + input.postPath)
    await text("Bounded page program approved")
    await text("Add approved page program to agent draft")
    state.phase = "original_browser_use"
    // After approval the original menu is refresh/use/scriptUse/stop, with refresh selected.
    await choose(2)
    await text("browser controlID:")
    state.explicitUse = true
    state.phase = "original_prompt_once"
    terminal.write("\r")
    state.promptSubmitted = true
    const replied = new Set<string>()
    while (Date.now() < deadline) {
      const pending = await client.v2.session.permission.list({ sessionID: input.sessions.tui }, { throwOnError: true })
      for (const permission of pending.data.data) {
        if (replied.has(permission.id)) continue
        if (!state.controlID) {
          const id = permission.resources[0]?.split("/")[0]
          if (!id) throw new Error("Original pending tool permission lacks its control reference")
          const view = (await client.browser.get({ controlID: id }, { throwOnError: true })).data
          if (view.nativeVerification !== "verified" || view.control.scope.sessionID !== input.sessions.tui ||
              view.control.scope.directory !== input.directory) throw new Error("Original current control scope changed")
          state.controlID = id
        }
        if (permission.source?.type !== "tool" || !["browser", "browser-program"].includes(permission.action) ||
            !permission.resources.every((resource) => resource.startsWith(state.controlID + "/")))
          throw new Error("Unexpected original permission, no blanket approval allowed")
        await text("Allow once")
        terminal.write("\r")
        replied.add(permission.id)
        state.approvals++
      }
      if ((await screen.current()).text.includes("Browser client program completed")) break
      await Bun.sleep(30)
    }
    await text("Browser client program completed")
    state.phase = "original_stop"
    await open("Stop browser")
    // Active program control menu is refresh/use/scriptUse/stop.
    await choose(3)
    await text("Browser stop confirmed")
    state.stopConfirmed = true
    terminal.write("\x1b")
    await Bun.sleep(30)
    terminal.write("\x03")
    const ended = await Promise.race([child.exited, Bun.sleep(2000).then(() => {
      if (child.exitCode === null) terminal.write("\x03")
      return child.exited
    })])
    state.originalExit = ended
    assert.equal(ended, 0)
    assert.equal(state.cancelled, false)
    assert.deepEqual(flags(), before)
    state.restored = true
    state.phase = "complete"
  } catch (error) {
    mark("driver-error", { childExit: child.exitCode, phase: state.phase })
    await fs.writeFile(path.join(root, "driver-error-private.log"),
      error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600 })
    throw error
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) {
      state.cleanupSignals.push("SIGTERM")
      mark("driver-signal", { signal: "SIGTERM", phase: state.phase })
      child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)])
    }
    if (child.exitCode === null) {
      state.cleanupSignals.push("SIGKILL")
      mark("driver-signal", { signal: "SIGKILL", phase: state.phase })
      child.kill("SIGKILL"); await child.exited
    }
    state.originalExit = child.exitCode ?? undefined
    await fs.writeFile(path.join(root, "stderr-private.log"), await stderr, { mode: 0o600 })
    mark("pty-before-driver-close", { childExit: child.exitCode, closed: terminal.closed })
    terminal.close()
    await screen.dispose()
    mark("pty-driver-closed", { closed: terminal.closed })
    await fs.writeFile(path.join(root, "terminal-private.txt"), state.output, { mode: 0o600 })
    await fs.writeFile(path.join(root, "client-safe-observation.json"), JSON.stringify({ version: 1,
      ...state, output: undefined, controlID: undefined, originalCLI: "attach", actualPTY: true, originalPrompt: state.promptSubmitted,
      currentViewport: true, parser: { name: "@xterm/headless", version: screen.version, sha256: screen.sha256 },
      processExited: child.exitCode !== null, terminalClosed: terminal.closed,
      limits: ["Buffered terminal text is not a current-frame viewport proof", "Original HTTP/ledger must corroborate all operations",
        "QA free loopback model transport only"] }, null, 2), { mode: 0o600 })
  }
}

if (import.meta.main) await run(process.argv[2], process.argv[3] === "--dry", process.argv[3] === "--startup-only").catch(() => {
  console.error("BROWSER_CANONICAL_TUI_FAILED; inspect private observations"); process.exitCode = 1
})
