import { createDeepAgentCodeClient } from "../../src/client.js"

const controller = new AbortController()
const client = createDeepAgentCodeClient({ baseUrl: process.argv[2]! })
const response = await client.global.event({ signal: controller.signal, sseMaxRetryAttempts: 0 })
const first = await response.stream.next()
if (first.done) throw new Error("Expected the real connected event")
const pending = response.stream.next()
await new Promise((resolve) => setTimeout(resolve, 20))
controller.abort()
await pending
await response.stream.return()
await new Promise((resolve) => setTimeout(resolve, 20))
process.stdout.write(JSON.stringify({ received: 1, closed: true }))
