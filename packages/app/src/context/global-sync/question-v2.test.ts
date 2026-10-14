import { describe, expect, test } from "bun:test"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { rejectQuestion, replyQuestion } from "./question-v2"
import { createServer } from "node:http"

async function startServer(status: number, requests: { path: string; directory: string | null; body: unknown }[]) {
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString("utf8")
    const url = new URL(request.url!, "http://127.0.0.1")
    requests.push({
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      body: text ? JSON.parse(text) : null,
    })
    response.writeHead(status, status === 204 ? {} : { "Content-Type": "application/json" })
    response.end(status === 204 ? undefined : JSON.stringify({ error: "QuestionNotFoundError" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("HTTP server port unavailable")
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

describe("Question routes", () => {
  test("uses the generated HTTP V2 or legacy route according to recorded provenance", async () => {
    const requests: { path: string; directory: string | null; body: unknown }[] = []
    const endpoint = await startServer(204, requests)
    try {
      const client = createDeepAgentCodeClient({ baseUrl: endpoint.baseUrl })
      const request = { sessionID: "ses_same", requestID: "que_pending", directory: "/project" }
      await replyQuestion(client, { ...request, v2: true, answers: [["Execute this version"]] })
      await rejectQuestion(client, { ...request, v2: true })
      await replyQuestion(client, { ...request, answers: [["Keep designing"]] })
      await rejectQuestion(client, request)
      expect(requests).toEqual([
        {
          path: "/api/session/ses_same/question/que_pending/reply",
          directory: null,
          body: { answers: [["Execute this version"]] },
        },
        { path: "/api/session/ses_same/question/que_pending/reject", directory: null, body: null },
        { path: "/question/que_pending/reply", directory: "/project", body: { answers: [["Keep designing"]] } },
        { path: "/question/que_pending/reject", directory: "/project", body: null },
      ])
    } finally {
      endpoint.server.close()
    }
  })

  test("propagates a refused real HTTP reply to the dock failure handler", async () => {
    const endpoint = await startServer(404, [])
    try {
      await expect(
        replyQuestion(createDeepAgentCodeClient({ baseUrl: endpoint.baseUrl }), {
          sessionID: "ses_same",
          requestID: "que_closed",
          answers: [["Execute this version"]],
          v2: true,
        }),
      ).rejects.toBeDefined()
    } finally {
      endpoint.server.close()
    }
  })
})
