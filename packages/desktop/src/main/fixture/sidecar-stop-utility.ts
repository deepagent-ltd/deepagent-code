import { writeFileSync } from "node:fs"
import path from "node:path"

const root = process.env.DAC_SIDECAR_STOP_ROOT
const scenario = process.env.DAC_SIDECAR_STOP_SCENARIO
const parent = process.parentPort
if (!root || !scenario || !parent) throw new Error("sidecar stop utility requires original parent port and private case paths")
const facts = { pid: process.pid, stops: 0, acceptedAt: 0, exitingAt: 0 }
parent.on("message", (event) => {
  if (typeof event.data !== "object" || event.data === null || !("type" in event.data) || event.data.type !== "stop") return
  facts.stops++
  facts.acceptedAt = Date.now()
  writeFileSync(path.join(root, "utility.json"), JSON.stringify(facts), { mode: 0o600 })
  if (scenario === "forced") return
  setTimeout(() => {
    facts.exitingAt = Date.now()
    writeFileSync(path.join(root, "utility.json"), JSON.stringify(facts), { mode: 0o600 })
    process.exit(0)
  }, 150)
})
setInterval(() => {}, 1_000)
parent.postMessage({ type: "ready" })

