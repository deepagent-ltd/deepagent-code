import { CliRenderer } from "@opentui/core"
import { appendFileSync } from "node:fs"
import path from "node:path"

// Private startup diagnosis only. No terminal bytes, keys, credentials or
// application data are recorded, and every wrapped call delegates unchanged.
const filename = process.env.DAC_BROWSER_TUI_TRACE_FILE
if (filename && path.isAbsolute(filename) && path.basename(filename) === "startup-trace-private.jsonl") {
  const started = performance.now()
  const mark = (stage: string, value: Record<string, unknown> = {}) => appendFileSync(filename,
    JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - started), wallClockMs: Date.now(), pid: process.pid, ...value }) + "\n",
    { mode: 0o600 })
  const sites = () => new Error().stack?.split("\n").slice(2, 9).map((line) => line.trim())
  mark("preload", { ppid: process.ppid, stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY })
  const destroy = CliRenderer.prototype.destroy
  CliRenderer.prototype.destroy = function (this: CliRenderer, ...args: Parameters<typeof destroy>) {
    mark("renderer-destroy", { destroyed: this.isDestroyed, sites: sites() })
    return destroy.apply(this, args)
  }
  const exit = process.exit
  process.exit = function (this: typeof process, ...args: Parameters<typeof exit>) {
    mark("process-exit", { code: args[0] ?? process.exitCode ?? null, sites: sites() })
    return exit.apply(this, args)
  }
  process.stdin.on("end", () => mark("stdin-end"))
  process.stdin.on("close", () => mark("stdin-close"))
  process.on("beforeExit", (code) => mark("before-exit", { code }))
  process.on("exit", (code) => mark("exit-event", { code }))
}
