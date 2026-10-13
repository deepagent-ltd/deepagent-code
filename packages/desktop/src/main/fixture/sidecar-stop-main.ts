import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { app, utilityProcess } from "electron"
import { createSidecarStop } from "../sidecar-stop"

const root = process.env.DAC_SIDECAR_STOP_ROOT
const utility = process.env.DAC_SIDECAR_STOP_UTILITY
const scenario = process.env.DAC_SIDECAR_STOP_SCENARIO
if (!root || !utility || !scenario) throw new Error("sidecar stop fixture requires private paths and scenario")
app.setPath("userData", path.join(root, "user-data"))
app.setPath("sessionData", path.join(root, "session-data"))
app.on("window-all-closed", () => {})
const facts = {
  mainPID: process.pid,
  scenario,
  childPID: 0,
  postStops: 0,
  killRequests: 0,
  killAccepted: false,
  childExit: false,
  childCode: -1,
  childExitedAt: 0,
  startedAt: 0,
  completedAt: 0,
  joined: false,
  observations: [] as unknown[],
}
const persist = () => writeFileSync(path.join(root, "main.json"), JSON.stringify(facts), { mode: 0o600 })

async function main() {
  await app.whenReady()
  const exit = Promise.withResolvers<number>()
  const ready = Promise.withResolvers<void>()
  const child = utilityProcess.fork(utility, [], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: root,
      DAC_SIDECAR_STOP_ROOT: root,
      DAC_SIDECAR_STOP_SCENARIO: scenario,
    },
    stdio: "pipe",
  })
  child.once("exit", (code) => {
    facts.childExit = true
    facts.childCode = code
    facts.childExitedAt = Date.now()
    exit.resolve(code)
  })
  child.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && "type" in message && message.type === "ready") ready.resolve()
  })
  const deadline = setTimeout(() => { child.kill(); persist(); app.exit(70) }, 12_000)
  const stop = createSidecarStop({
    postStop: () => { facts.postStops++; child.postMessage({ type: "stop" }) },
    kill: () => { facts.killRequests++; facts.killAccepted = child.kill(); return facts.killAccepted },
    exit: exit.promise,
    hasExited: () => facts.childExit,
    onObservation: (observation) => { facts.observations.push(observation) },
  })
  await ready.promise
  facts.childPID = child.pid ?? 0
  facts.startedAt = Date.now()
  const first = stop()
  facts.joined = first === stop()
  await first
  facts.completedAt = Date.now()
  assert.equal(facts.childExit, true)
  assert.equal(facts.joined, true)
  assert.equal(facts.postStops, 1)
  assert.equal(facts.killRequests, scenario === "forced" ? 1 : 0)
  assert.ok(facts.completedAt >= facts.childExitedAt)
  clearTimeout(deadline)
  persist()
  app.quit()
}
void main().catch((error: unknown) => {
  writeFileSync(path.join(root, "failure.json"), JSON.stringify({ error: String(error) }), { mode: 0o600 })
  app.exit(1)
})

