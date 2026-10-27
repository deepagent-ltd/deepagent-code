import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { app, utilityProcess } from "electron"

const root = process.env.DAC_SIDECAR_SHUTDOWN_ROOT
const scenario = process.env.DAC_SIDECAR_SHUTDOWN_SCENARIO
if (!root || !scenario) throw new Error("Private sidecar shutdown fixture is required")
app.setPath("userData", path.join(root, "user-data"))
app.setPath("sessionData", path.join(root, "session-data"))
app.on("window-all-closed", () => {})

async function main() {
  await app.whenReady()
  if (process.platform === "win32" && !process.env.SystemRoot)
    throw new Error("Windows utility fixture requires SystemRoot")
  const exited = Promise.withResolvers<number>()
  const ready = Promise.withResolvers<void>()
  const facts = {
    utilityPID: 0,
    messages: [] as unknown[],
    exitCode: -1,
    stoppedAt: 0,
    exitedAt: 0,
    phase: "forking",
    ready: false,
    startupError: undefined as string | undefined,
  }
  const persist = () => writeFileSync(path.join(root!, "main.json"), JSON.stringify(facts), { mode: 0o600 })
  // Electron replaces this environment; Windows still needs its OS runtime root.
  const child = utilityProcess.fork(path.join(root!, "sidecar.js"), [], {
    cwd: root,
    env: {
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      DAC_SIDECAR_SHUTDOWN_ROOT: root,
      DAC_SIDECAR_SHUTDOWN_SCENARIO: scenario,
    },
    stdio: "pipe",
  })
  child.on("message", (message: unknown) => {
    facts.messages.push(message)
    if (typeof message === "object" && message !== null && "type" in message && message.type === "ready") {
      facts.ready = true
      facts.phase = "ready"
      ready.resolve()
    }
    if (
      !facts.ready &&
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "error"
    ) {
      facts.phase = "startup-error"
      facts.startupError =
        "error" in message &&
        typeof message.error === "object" &&
        message.error !== null &&
        "message" in message.error &&
        typeof message.error.message === "string"
          ? message.error.message
          : "Unknown sidecar startup error"
      persist()
      ready.reject(new Error(facts.startupError))
    }
  })
  child.once("spawn", () => {
    facts.utilityPID = child.pid ?? 0
    facts.phase = "waiting-ready"
    persist()
  })
  child.once("exit", (code) => {
    facts.exitCode = code
    facts.exitedAt = Date.now()
    if (!facts.ready) {
      facts.phase = "exit-before-ready"
      persist()
      ready.reject(new Error(`Sidecar exited before ready: ${code}`))
    }
    exited.resolve(code)
  })
  const deadline = setTimeout(() => {
    persist()
    console.error("SIDECAR_SCOPE_FIXTURE_TIMEOUT", JSON.stringify(facts))
    child.kill()
    app.exit(70)
  }, 8_000)
  // This fixture supplies an unsealed test server, never an installed Native cohort.
  if (process.platform === "win32") child.postMessage({ type: "dac-native-preload-unavailable-v1" })
  child.postMessage({ type: "start", hostname: "127.0.0.1", port: 0, password: "private-fixture-password" })
  await ready.promise
  facts.utilityPID = child.pid ?? 0
  facts.phase = "waiting-stop-exit"
  facts.stoppedAt = Date.now()
  child.postMessage({ type: "stop" })
  child.postMessage({ type: "stop" })
  await exited.promise
  clearTimeout(deadline)
  assert.equal(facts.exitCode, scenario === "normal" ? 0 : 1)
  facts.phase = "completed"
  persist()
  app.quit()
}
void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
