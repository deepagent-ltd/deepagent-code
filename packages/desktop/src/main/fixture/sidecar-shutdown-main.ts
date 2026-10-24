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
  const exited = Promise.withResolvers<number>()
  const ready = Promise.withResolvers<void>()
  const facts = { utilityPID: 0, messages: [] as unknown[], exitCode: -1, stoppedAt: 0, exitedAt: 0 }
  const child = utilityProcess.fork(path.join(root!, "sidecar.js"), [], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: root,
      DAC_SIDECAR_SHUTDOWN_ROOT: root,
      DAC_SIDECAR_SHUTDOWN_SCENARIO: scenario,
    },
    stdio: "pipe",
  })
  child.on("message", (message: unknown) => {
    facts.messages.push(message)
    if (typeof message === "object" && message !== null && "type" in message && message.type === "ready")
      ready.resolve()
  })
  child.once("exit", (code) => {
    facts.exitCode = code
    facts.exitedAt = Date.now()
    exited.resolve(code)
  })
  const deadline = setTimeout(() => {
    child.kill()
    app.exit(70)
  }, 8_000)
  // This fixture supplies an unsealed test server, never an installed Native cohort.
  if (process.platform === "win32") child.postMessage({ type: "dac-native-preload-unavailable-v1" })
  child.postMessage({ type: "start", hostname: "127.0.0.1", port: 0, password: "private-fixture-password" })
  await ready.promise
  facts.utilityPID = child.pid ?? 0
  facts.stoppedAt = Date.now()
  child.postMessage({ type: "stop" })
  child.postMessage({ type: "stop" })
  await exited.promise
  clearTimeout(deadline)
  assert.equal(facts.exitCode, scenario === "normal" ? 0 : 1)
  writeFileSync(path.join(root!, "main.json"), JSON.stringify(facts), { mode: 0o600 })
  app.quit()
}
void main().catch(() => {
  app.exit(1)
})
