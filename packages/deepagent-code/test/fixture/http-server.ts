import assert from "node:assert/strict"
import { createServer } from "node:http"

export async function serve(handler: (request: Request) => Response | Promise<Response>) {
  let current = handler
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const headers = new Headers()
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!)
      }
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const method = incoming.method ?? "GET"
      const request = new Request(new URL(incoming.url ?? "/", `http://${incoming.headers.host}`).href, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      })
      const response = await current(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body) return outgoing.end()
      const reader = response.body.getReader()
      const cancel = () => void reader.cancel().catch(() => {})
      outgoing.once("close", cancel)
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          if (!outgoing.write(Buffer.from(part.value)))
            await new Promise<void>((resolve) => outgoing.once("drain", resolve))
        }
      } finally {
        outgoing.off("close", cancel)
      }
      outgoing.end()
    })().catch((error: unknown) => {
      if (!outgoing.headersSent) outgoing.writeHead(500)
      outgoing.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  assert(address && typeof address === "object")
  return {
    port: address.port,
    url: new URL(`http://127.0.0.1:${address.port}/`),
    reload(options: { fetch: typeof handler }) {
      current = options.fetch
    },
    async stop() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      server.closeAllConnections()
      await closed
    },
  }
}
