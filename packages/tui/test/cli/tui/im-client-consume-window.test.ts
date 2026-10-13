import { expect, test } from "bun:test"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { createIMClient } from "../../../src/component/im-client"

test("public TUI group proofs consume after delayed HTTP while retaining request-start body expiry", async () => {
  const requests: { method: string; path: string; authorized: boolean; directory: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push({
        method: request.method,
        path: url.pathname,
        authorized: request.headers.get("authorization") === "Bearer fixture-token",
        directory: request.headers.get("x-deepagent-code-directory"),
      })
      await Bun.sleep(1100)
      const group = {
        id: "protected_group",
        workspaceID: "fixture",
        projectID: null,
        type: "direct",
        name: "Public conversation",
        createdBy: "self",
        kernelConvID: "kr1:fixture",
        createdAt: 1,
        updatedAt: 1,
        reader: { mode: "protected", state: "ready", liveUnread: "1" },
      }
      const reader = {
        displayEpoch: "returned_epoch",
        proofWindowMs: 1000,
        validatedServerNow: Date.now(),
        nextExpiryAt: url.pathname.endsWith("/expired") ? Date.now() + 500 : null,
      }
      return Response.json(
        url.pathname.endsWith("/page")
          ? { version: 1, lane: "protected", groups: [group], reader, hasMore: false, nextCursor: null }
          : { version: 1, group, reader },
      )
    },
  })
  try {
    const client = createIMClient({
      url: server.url.toString(),
      directory: "/public-fixture",
      client: createOpencodeClient({
        baseUrl: server.url.toString(),
        headers: { Authorization: "Bearer fixture-token" },
      }),
    })
    const results = await Promise.allSettled([
      client.listGroupPage("protected"),
      client.getGroup("protected_group"),
      client.refreshGroup("protected_group"),
      client.getGroup("expired"),
    ])
    expect(results.slice(0, 3).map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
    expect(results[3].status).toBe("rejected")
    if (results[3].status === "rejected") expect(results[3].reason.code).toBe("reader_stale")
    expect(requests).toHaveLength(4)
    expect(requests.every((request) => request.authorized && request.directory === "%2Fpublic-fixture")).toBe(true)
    expect(requests.map((request) => request.method).sort()).toEqual(["GET", "GET", "GET", "POST"])
  } finally {
    server.stop(true)
  }
})

test("TUI group observation still rejects invalid proof windows and a changed SDK scope", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      return Response.json({
        version: 1,
        lane: "protected",
        groups: [],
        reader: {
          displayEpoch: "returned_epoch",
          proofWindowMs: url.searchParams.get("cursor") === "invalid" ? 1001 : 1000,
          nextExpiryAt: null,
        },
        hasMore: false,
        nextCursor: null,
      })
    },
  })
  try {
    const sdk = {
      url: server.url.toString(),
      directory: "/original-scope",
      client: createOpencodeClient({ baseUrl: server.url.toString() }),
    }
    const client = createIMClient(Object.assign(sdk, {
      fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const response = await fetch(request)
        if (new URL(request.url).searchParams.get("cursor") === "scope") sdk.directory = "/changed-scope"
        return response
      }, { preconnect: fetch.preconnect }),
    }))
    await expect(client.listGroupPage("protected", "invalid")).rejects.toMatchObject({ code: "reader_stale" })
    await expect(client.listGroupPage("protected", "scope")).rejects.toMatchObject({ code: "reader_unavailable" })
  } finally {
    server.stop(true)
  }
})
