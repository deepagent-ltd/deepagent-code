import { createGoalPlanBridge } from "../../../src/cli/tui/goal-plan-bridge"
import fs from "node:fs/promises"
import path from "node:path"
const worker = new Worker(new URL("./goal-plan-worker.ts", import.meta.url))
const seed = new Promise<{ sessionID: string; goalID: string }>((resolve) =>
  worker.addEventListener("message", (event) => {
    if (event.data?.fixture === "seed") resolve(event.data)
  }),
)
const bridge = await createGoalPlanBridge(worker, process.cwd())
async function probe(kind: string) {
  const result = new Promise<unknown>((resolve) => {
    const listen = (event: MessageEvent) => {
      if (event.data?.fixture === kind) {
        worker.removeEventListener("message", listen)
        resolve(event.data)
      }
    }
    worker.addEventListener("message", listen)
  })
  worker.postMessage({ fixture: kind })
  return result
}
const target = await seed
const before = await probe("snapshot")
const listener = await probe("start-listener")
if (!listener || typeof listener !== "object" || !("url" in listener) || typeof listener.url !== "string")
  throw new Error("No owned listener")
await Bun.sleep(3000)
const afterListen = await probe("snapshot")
const response = await fetch(
  new URL(
    `/deepagent/goal/status?directory=${encodeURIComponent(process.cwd())}&sessionID=${target.sessionID}`,
    listener.url,
  ),
  {
    headers: {
      authorization: `Basic ${Buffer.from(`${process.env.DEEPAGENT_CODE_SERVER_USERNAME}:${process.env.DEEPAGENT_CODE_SERVER_PASSWORD}`).toString("base64")}`,
    },
  },
)
const responseStatus = response.status
await response.arrayBuffer()
await Bun.sleep(3000)
const afterGet = await probe("snapshot")
await fs.writeFile(
  path.join(process.env.DAC_GOAL_PLAN_FIXTURE_ROOT!, "cold-read-result.json"),
  JSON.stringify({ target, before, afterListen, afterGet, responseStatus }),
)
bridge.close()
worker.postMessage({ fixture: "shutdown" })
setTimeout(() => worker.terminate(), 3000).unref()
