import { createServer } from "node:http"
import { Effect } from "effect"
import { LLM, LLMClient } from "../../src"
import { Auth, RequestExecutor } from "../../src/route"
import { OpenAIResponses } from "../../src/protocols/openai-responses"

const received: { model: string; auth?: string }[] = []
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    received.push({ model: JSON.parse(Buffer.concat(chunks).toString()).model, auth: request.headers.authorization })
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end('data: {"type":"response.completed","response":{"id":"fixture"}}\n\n')
  })
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
if (!address || typeof address === "string") throw new Error("Missing Node fixture listener")
try {
  await Effect.runPromise(
    LLMClient.generate(
      LLM.request({
        model: OpenAIResponses.route
          .with({
            endpoint: { baseURL: `http://127.0.0.1:${address.port}` },
            auth: Auth.value("node-fixture-key").bearer(),
          })
          .model({ id: "node-fixture" }),
        prompt: "Node ordinary request",
      }),
    ).pipe(Effect.provide(LLMClient.layer), Effect.provide(RequestExecutor.defaultLayer)),
  )
  console.log(JSON.stringify({ bun: !!process.versions.bun, requests: received.length, ...received[0] }))
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
