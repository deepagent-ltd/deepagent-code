import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { createIMClient } from "@/utils/im-client"
import { createIMSummaryOwner } from "./summary-owner"
import { imNavigationState } from "./navigation-state"

async function serve(read: (url: URL) => unknown | Promise<unknown>) {
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader(
      "access-control-allow-headers",
      "x-deepagent-code-directory, x-deepagent-code-workspace, authorization",
    )
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    response.setHeader("content-type", "application/json")
    void Promise.resolve(read(new URL(request.url!, "http://127.0.0.1"))).then((body) =>
      response.end(JSON.stringify(body)),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test address")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

test("the same owner delegates to the open panel then reads a partial summary after the view closes", async () => {
  const requests: string[] = []
  const server = await serve((url) => {
    requests.push(url.pathname)
    if (url.pathname.endsWith("/status"))
      return {
        facade: "active",
        identity: { uuid: "owner", name: "owner", orgID: 1, orgAllGroupID: "all" },
        kernel: "connected",
        reader: { displayEpoch: "epoch" },
      }
    return {
      lane: "protected",
      hasMore: true,
      nextCursor: "next",
      reader: { displayEpoch: "epoch", proofWindowMs: 1000, nextExpiryAt: null },
      groups: [{ id: "conversation", createdAt: 1, updatedAt: 1, reader: { liveUnread: "1" } }],
    }
  })
  const owner = createIMSummaryOwner()
  const connection = { url: server.origin }
  const client = createIMClient(() => ({ ...connection, directory: "/owned" }))
  let panelReads = 0
  try {
    owner.activate("summary-owner-test", connection)
    const detach = owner.attach({
      scope: "summary-owner-test",
      connection,
      client,
      reader: {
        owner: {},
        refresh: async () => {
          panelReads++
        },
      },
    })
    await owner.refresh()
    expect(panelReads).toBe(1)
    expect(requests).toEqual([])
    detach()
    const deadline = Date.now() + 1000
    while (imNavigationState()?.scope !== "summary-owner-test" && Date.now() < deadline) await Bun.sleep(2)
    expect(requests).toEqual(["/api/v1/im/status", "/api/v1/im/groups/page"])
    expect(imNavigationState()?.connected).toBe(true)
    expect(imNavigationState()?.unread).toBe(true)
    expect(imNavigationState()?.current).toBe(true)
    expect(requests.some((path) => /read|activate|dac/.test(path))).toBe(false)
    owner.activate("other-server", { url: "http://127.0.0.1:1" })
    expect(imNavigationState()?.current).toBe(false)
  } finally {
    owner.stop()
    server.stop()
  }
})

test("a partial zero page is unknown rather than an invented global zero count", async () => {
  const server = await serve((url) => {
    if (url.pathname.endsWith("/status"))
      return {
        facade: "active",
        identity: { uuid: "owner", name: "owner", orgID: 1, orgAllGroupID: "all" },
        kernel: "connected",
        reader: { displayEpoch: "epoch" },
      }
    return {
      lane: "protected",
      hasMore: true,
      nextCursor: "next",
      reader: { displayEpoch: "epoch", proofWindowMs: 1000, nextExpiryAt: null },
      groups: [],
    }
  })
  const owner = createIMSummaryOwner()
  const connection = { url: server.origin }
  const client = createIMClient(() => ({ ...connection, directory: "/owned" }))
  try {
    owner.activate("partial-zero-test", connection)
    owner.attach({ scope: "partial-zero-test", connection, client, reader: { owner: {}, refresh: async () => {} } })()
    const deadline = Date.now() + 1000
    while (imNavigationState()?.scope !== "partial-zero-test" && Date.now() < deadline) await Bun.sleep(2)
    expect(imNavigationState()?.scope).toBe("partial-zero-test")
    expect(imNavigationState()?.unread).toBe(false)
    expect(imNavigationState()?.current).toBe(false)
  } finally {
    owner.stop()
    server.stop()
  }
})

test("a late response from the previous connection cannot publish into a replacement scope", async () => {
  const deferred = Promise.withResolvers<unknown>()
  let requests = 0
  const server = await serve(() => {
    requests++
    return deferred.promise
  })
  const owner = createIMSummaryOwner()
  const connection = { url: server.origin }
  const client = createIMClient(() => ({ ...connection, directory: "/owned" }))
  try {
    owner.activate("late-response-test", connection)
    owner.attach({ scope: "late-response-test", connection, client, reader: { owner: {}, refresh: async () => {} } })()
    const deadline = Date.now() + 1000
    while (requests === 0 && Date.now() < deadline) await Bun.sleep(2)
    expect(requests).toBe(1)
    owner.activate("replacement", { url: "http://127.0.0.1:1" })
    deferred.resolve({ facade: "active", identity: { uuid: "old-account" }, kernel: "connected" })
    await Bun.sleep(10)
    expect(imNavigationState()?.scope).not.toBe("late-response-test")
    expect(requests).toBe(1)
  } finally {
    deferred.resolve({})
    owner.stop()
    server.stop()
  }
})

test("a hidden panel summary immediately retires when the IM realm changes on the same DAC server", async () => {
  let requests = 0
  let serviceURL = "https://old-service.invalid/im"
  const server = await serve((url) => {
    requests++
    if (url.pathname.endsWith("/status"))
      return {
        facade: "active",
        identity: { uuid: "same-uuid", name: "owner", orgID: 1, orgAllGroupID: "all" },
        service: { url: serviceURL, source: "config", reconnectRequired: false },
        kernel: "connected",
        reader: { displayEpoch: "epoch" },
      }
    return {
      lane: "protected",
      hasMore: false,
      nextCursor: null,
      reader: { displayEpoch: "epoch", proofWindowMs: 1000, nextExpiryAt: null },
      groups: [{ id: "same-conversation", createdAt: 1, updatedAt: 1, reader: { liveUnread: "1" } }],
    }
  })
  const owner = createIMSummaryOwner()
  const connection = { url: server.origin }
  const client = createIMClient(() => ({ ...connection, directory: "/owned", serviceURL }))
  try {
    owner.activate("realm-summary", connection, serviceURL)
    owner.attach({ scope: "realm-summary", connection, client, reader: { owner: {}, refresh: async () => {} } })()
    const deadline = Date.now() + 1000
    while (imNavigationState()?.scope !== "realm-summary" && Date.now() < deadline) await Bun.sleep(2)
    expect(imNavigationState()?.current).toBe(true)
    expect(imNavigationState()?.unread).toBe(true)
    expect(imNavigationState()?.accountID).toBe(JSON.stringify([serviceURL, "same-uuid"]))
    expect(requests).toBe(2)
    serviceURL = "https://new-service.invalid/im"
    owner.activate("realm-summary", connection, serviceURL)
    expect(imNavigationState()?.current).toBe(false)
    await owner.refresh()
    expect(requests).toBe(2)
  } finally {
    owner.stop()
    server.stop()
  }
})
