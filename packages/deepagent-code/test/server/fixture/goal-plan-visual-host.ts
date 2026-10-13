import fs from "node:fs/promises"
import path from "node:path"
const root = process.env.DAC_GOAL_PLAN_FIXTURE_ROOT!
const worker = new Worker(new URL("./goal-plan-worker.ts", import.meta.url))
worker.addEventListener("message", (event) => {
  if (event.data?.fixture === "seed")
    void fs.writeFile(path.join(root, "visual-ready.json"), JSON.stringify(event.data))
})
worker.addEventListener("error", (event) => {
  console.error(event.message)
  process.exitCode = 1
})
process.on("SIGTERM", () => {
  worker.postMessage({ fixture: "shutdown" })
  setTimeout(() => worker.terminate(), 5000).unref()
})
