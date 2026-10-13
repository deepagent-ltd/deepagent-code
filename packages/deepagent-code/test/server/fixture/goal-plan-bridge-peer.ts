import { MessagePort, parentPort } from "node:worker_threads"
let generation = 0
parentPort!.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("port" in value) || !(value.port instanceof MessagePort)) return
  const port = value.port
  const current = ++generation
  if (current === 2) {
    setTimeout(() => port.close(), 50)
    setTimeout(() => {
      try {
        port.postMessage({ ready: true, directory: process.cwd() })
      } catch {}
    }, 6000)
    return
  }
  port.on("message", (input: unknown) => {
    if (!input || typeof input !== "object" || !("id" in input) || !("request" in input)) return
    if (
      input.request &&
      typeof input.request === "object" &&
      "requestID" in input.request &&
      input.request.requestID === "hold"
    )
      return
    port.postMessage({ id: input.id, data: { nativeGeneration: current } })
    port.postMessage({ id: input.id, settled: true })
  })
  port.start()
  port.postMessage({ ready: true, directory: process.cwd() })
})
parentPort!.postMessage({ kind: "goal-plan-bootstrap-ready-v1" })
