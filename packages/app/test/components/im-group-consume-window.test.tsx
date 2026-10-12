import { expect, it } from "vitest"
import { createServer } from "node:http"
import { createIMClient } from "@/utils/im-client"

async function serve() {
  const requested = Promise.withResolvers<void>()
  const state = { directory: "/owned/project", delay: 1100, expiry: 60000, window: 1000, proof: true, epoch: "current" }
  const calls: { method: string; directory: string | null; lane: string | null }[] = []
  const listener = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const url = new URL(request.url ?? "/", "http://fixture.invalid")
    calls.push({
      method: request.method ?? "GET",
      directory: url.searchParams.get("directory"),
      lane: url.searchParams.get("lane"),
    })
    const serverNow = Date.now()
    requested.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, state.delay))
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify({
        version: 1,
        lane: "protected",
        groups: [
          {
            id: "group",
            name: "Peer",
            workspaceID: "workspace",
            projectID: null,
            type: "direct",
            createdBy: "viewer",
            createdAt: 1,
            updatedAt: 1,
            kernelConvID: "kr1:peer",
          },
        ],
        hasMore: false,
        nextCursor: null,
        ...(state.proof
          ? {
              reader: {
                displayEpoch: state.epoch,
                proofWindowMs: state.window,
                validatedServerNow: serverNow,
                nextExpiryAt: serverNow + state.expiry,
              },
            }
          : {}),
      }),
    )
  })
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Listener unavailable")
  return {
    state,
    calls,
    requested: requested.promise,
    client: createIMClient(() => ({ url: `http://127.0.0.1:${address.port}`, directory: state.directory })),
    async close() {
      listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    },
  }
}

it("accepts a current protected group response after a slow HTTP flight without spending its local consumption window twice", async () => {
  const peer = await serve()
  try {
    const page = await peer.client.listGroupPage("protected", undefined, AbortSignal.timeout(5000))
    expect(page.groups.map((group) => group.id)).toEqual(["group"])
    expect(page.reader?.proofWindowMs).toBe(1000)
    expect(peer.calls).toEqual([{ method: "GET", directory: "/owned/project", lane: "protected" }])
  } finally {
    await peer.close()
  }
})

it("still counts the full HTTP flight against server-observed message expiry", async () => {
  const peer = await serve()
  try {
    peer.state.expiry = 100
    await expect(peer.client.listGroupPage("protected", undefined, AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "reader_stale",
      status: 503,
    })
    expect(peer.calls).toHaveLength(1)
  } finally {
    await peer.close()
  }
})

it("rejects a late response after the caller directory changes", async () => {
  const peer = await serve()
  try {
    const read = peer.client.listGroupPage("protected", undefined, AbortSignal.timeout(5000))
    await peer.requested
    peer.state.directory = "/other/project"
    await expect(read).rejects.toMatchObject({ code: "reader_unavailable", status: 503 })
    expect(peer.calls[0].directory).toBe("/owned/project")
  } finally {
    await peer.close()
  }
})

it("retains the required proof, epoch and bounded local-window gates", async () => {
  const peer = await serve()
  try {
    peer.state.delay = 0
    peer.state.proof = false
    await expect(peer.client.listGroupPage("protected")).rejects.toMatchObject({ code: "reader_unavailable" })
    peer.state.proof = true
    for (const window of [0, 1001]) {
      peer.state.window = window
      await expect(peer.client.listGroupPage("protected")).rejects.toMatchObject({ code: "reader_stale" })
    }
    peer.state.window = 1000
    peer.state.epoch = ""
    await expect(peer.client.listGroupPage("protected")).rejects.toMatchObject({ code: "reader_stale" })
    expect(peer.calls.every((call) => call.method === "GET")).toBe(true)
  } finally {
    await peer.close()
  }
})
