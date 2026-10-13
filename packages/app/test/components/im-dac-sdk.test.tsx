import { expect, it } from "vitest"
import { createServer } from "node:http"
import { createIMClient, IMFacadeRequestError } from "@/utils/im-client"

async function server() {
  const calls: { method: string; path: string; directory: string | null; body: unknown }[] = []
  const state = { status: 200, denied: false }
  const listener = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const url = new URL(request.url ?? "/", "http://localhost")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    const body = text
      ? (JSON.parse(text) as {
          commandID: string
          text: string
          delivery: "queue" | "steer"
          referenceMessageIDs?: string[]
        })
      : undefined
    calls.push({
      method: request.method ?? "GET",
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      body,
    })
    response.writeHead(state.status, { "Content-Type": "application/json" })
    if (state.status !== 200) {
      response.end(
        JSON.stringify({
          name: "IM_DAC_COMMAND_REJECTED",
          data: { code: "reference_unavailable", ...(state.denied ? { admitted: false } : {}) },
        }),
      )
      return
    }
    const binding = {
      version: 1,
      groupID: "group",
      projectID: "project",
      directory: "/owned/project",
      workspaceID: null,
      bindingID: null,
      sessionID: null,
    }
    const value = url.pathname.endsWith("/dac")
      ? binding
      : {
          ...binding,
          bindingID: "binding",
          sessionID: "session",
          commandID: body?.commandID ?? "original",
          inputID: "input",
          delivery: body?.delivery ?? "queue",
          state: "admitted",
          activityID: null,
          finalMessageID: null,
          replyStatus: null,
        }
    response.end(JSON.stringify(value))
  })
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Listener missing")
  const client = createIMClient(() => ({ url: `http://127.0.0.1:${address.port}`, directory: "/owned/project" }))
  return {
    client,
    calls,
    state,
    async close() {
      listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    },
  }
}

it("uses the generated binding, submit and observation routes with current placement and private command body", async () => {
  const fixture = await server()
  try {
    const signal = AbortSignal.timeout(5000)
    expect((await fixture.client.dacBinding("group", signal)).sessionID).toBeNull()
    expect(
      (
        await fixture.client.dacSubmit(
          "group",
          { commandID: "original", text: "private command", delivery: "steer", referenceMessageIDs: ["source"] },
          signal,
        )
      ).sessionID,
    ).toBe("session")
    expect((await fixture.client.dacCommand("group", "original", signal)).commandID).toBe("original")
    expect(fixture.calls.map((value) => [value.method, value.path, value.directory])).toEqual([
      ["GET", "/api/v1/im/groups/group/dac", "/owned/project"],
      ["POST", "/api/v1/im/groups/group/dac/commands", "/owned/project"],
      ["GET", "/api/v1/im/groups/group/dac/commands/original", "/owned/project"],
    ])
    expect(fixture.calls[1].body).toEqual({
      commandID: "original",
      text: "private command",
      delivery: "steer",
      referenceMessageIDs: ["source"],
    })
    expect(fixture.calls.some((value) => value.path.endsWith("/messages"))).toBe(false)
  } finally {
    await fixture.close()
  }
})

it("exposes only explicit not-admitted evidence while an ordinary error preserves unknown admission", async () => {
  const fixture = await server()
  try {
    fixture.state.status = 409
    fixture.state.denied = true
    const input = { commandID: "original", text: "private command", delivery: "queue" as const }
    await expect(fixture.client.dacSubmit("group", input, AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "reference_unavailable",
      status: 409,
      notAdmitted: true,
    })
    fixture.state.denied = false
    const error = await fixture.client
      .dacSubmit("group", input, AbortSignal.timeout(5000))
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(IMFacadeRequestError)
    expect(error).toMatchObject({ notAdmitted: false })
  } finally {
    await fixture.close()
  }
})
