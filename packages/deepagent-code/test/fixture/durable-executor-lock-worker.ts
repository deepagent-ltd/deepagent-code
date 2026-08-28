import fs from "node:fs"
import {
  acquireDurableExecutorLease,
  releaseDurableExecutorLease,
  releaseDurableExecutorReservation,
  reserveDurableExecutor,
} from "@/session/durable-executor-lock"

const [stateRoot, directory, resultPath, holdText, staleText, heartbeatText] = process.argv.slice(2)
if (!stateRoot || !directory || !resultPath || !holdText) throw new Error("missing worker arguments")

const reserved = reserveDurableExecutor(directory)
const lease = reserved
  ? acquireDurableExecutorLease({
      directory,
      mode: "durable",
      stateRoot,
      ...(staleText ? { staleMs: Number.parseInt(staleText, 10) } : {}),
      ...(heartbeatText ? { heartbeatMs: Number.parseInt(heartbeatText, 10) } : {}),
    })
  : undefined
fs.writeFileSync(resultPath, JSON.stringify({ acquired: lease !== undefined, pid: process.pid }))
if (lease) {
  await Bun.sleep(Number.parseInt(holdText, 10))
  releaseDurableExecutorLease(lease)
} else if (reserved) {
  releaseDurableExecutorReservation(directory)
}
