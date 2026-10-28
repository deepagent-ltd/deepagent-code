import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { initializeDesktopStartup } from "../startup"

const trace = (phase: string) => {
  // Diagnostics must not replace the original bootstrap error or termination.
  try {
    appendFileSync(join(process.env.DAC_STARTUP_ROOT!, "startup-stages.jsonl"), JSON.stringify({ phase, at: performance.now() }) + "\n", { mode: 0o600 })
  } catch {}
}
trace("entry")
process.on("uncaughtExceptionMonitor", (error, origin) => {
  trace("uncaught")
  try {
    writeFileSync(join(process.env.DAC_STARTUP_ROOT!, "uncaught.json"), JSON.stringify({ origin, name: error.name.slice(0, 80),
      message: error.message.slice(0, 512), stack: error.stack?.slice(0, 4096) }), { mode: 0o600 })
  } catch {}
})
trace("storage:initialize")
const startup = initializeDesktopStartup(app)
trace("storage:initialized")
writeFileSync(join(process.env.DAC_STARTUP_ROOT!, "entry.json"), JSON.stringify({ ready: app.isReady(), session: app.getPath("sessionData"), expected: startup.storage.session }), { mode: 0o600 })
trace("fixture:import")
await import("./startup")
trace("fixture:imported")
