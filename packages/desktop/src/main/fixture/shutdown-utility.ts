import { writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

type ParentPort = {
  postMessage: (message: unknown) => void
  on: (event: "message", listener: (message: { data: unknown }) => void) => void
}

const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!parent) throw new Error("shutdown utility requires the actual Electron parent port")
const root = process.env.DAC_SHUTDOWN_ROOT
if (!root) throw new Error("shutdown utility requires an isolated root")
const facts = { stops: 0, pid: process.pid, acceptedAt: 0, exitingAt: 0 }
parent.on("message", (message) => {
  if (
    typeof message.data !== "object" ||
    message.data === null ||
    !("type" in message.data) ||
    message.data.type !== "stop"
  )
    return
  facts.stops++
  facts.acceptedAt = Date.now()
  parent.postMessage({ type: "stopping" })
  // A real delayed utility exit makes an un-awaited Quit observably unsafe.
  setTimeout(() => {
    facts.exitingAt = Date.now()
    writeFileSync(path.join(root, "utility.json"), JSON.stringify(facts), { mode: 0o600 })
    process.exit(0)
  }, 150)
})
parent.postMessage({ type: "ready" })
