import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { createIMClient } from "./im-client"

test("final reply retry uses the official bodyless SDK endpoint and preserves captured command placement", async () => {
  const calls: { method: string; path: string; directory: string | null; workspace: string | null; body: string }[] = []
  const command = {
    version: 1,
    groupID: "owned-conversation",
    projectID: "owned-project",
    directory: "/owned/中文 project",
    workspaceID: "owned-workspace",
    commandID: "owned-command",
    bindingID: "owned-binding",
    sessionID: "owned-session",
    inputID: "owned-input",
    delivery: "queue",
    state: "admitted",
    activityID: "original-activity",
    finalMessageID: "original-final",
    replyStatus: "pending",
  } as const
  // The package DOM preload replaces Response; the actual HTTP server owns its native wire.
  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS")
    response.setHeader(
      "access-control-allow-headers",
      "x-deepagent-code-directory,x-deepagent-code-workspace,content-type",
    )
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const url = new URL(request.url!, "http://127.0.0.1")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    calls.push({
      method: request.method!,
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      workspace: url.searchParams.get("workspace"),
      body: Buffer.concat(chunks).toString(),
    })
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(command))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing loopback port")
  const client = createIMClient(() => ({
    url: `http://127.0.0.1:${address.port}`,
    directory: command.directory,
    workspace: command.workspaceID,
  }))
  try {
    expect(await client.dacReplyRetry(command.groupID, command.commandID, new AbortController().signal)).toEqual(
      command,
    )
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/im/groups/owned-conversation/dac/commands/owned-command/reply/retry",
        directory: command.directory,
        workspace: command.workspaceID,
        body: "",
      },
    ])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING") ? reject(error) : resolve(),
      )
      server.closeAllConnections()
    })
  }
})
