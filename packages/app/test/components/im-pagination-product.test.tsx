import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { MemoryRouter, Route } from "@solidjs/router"
import { createServer } from "node:http"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { createIMClient, type IMClient } from "@/utils/im-client"
import { createSdkForServer } from "@/utils/server"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({
  client: undefined as IMClient | undefined,
  sdk: undefined as ReturnType<typeof createSdkForServer> | undefined,
}))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => runtime.client!,
}))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get client() {
      return runtime.sdk!
    },
    get directory() {
      return runtime.client!.scope().directory
    },
    get url() {
      return runtime.client!.scope().url
    },
  }),
}))
vi.mock("@/context/server", async (original) => ({
  ...(await original<typeof import("@/context/server")>()),
  useServer: () => ({ key: "private-reader-product", all: [], projects: () => ({ list: [] }) }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict) => dict[key],
  }),
}))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show() {} }) }))
vi.mock("@/hooks/use-im-websocket", () => ({
  useIMWebSocket: () => ({
    connected: () => true,
    messages: () => [],
    agentStatuses: () => new Map(),
    agentProgress: () => new Map(),
    typingMembers: () => new Set(),
    send() {},
    reconnect() {},
  }),
}))
afterEach(cleanup)

async function serve() {
  const state = {
    posts: 0,
    capabilities: 0,
    repeat: false,
    fail: false,
    requests: [] as { directory: string; cursor: string | null; limit: string | null }[],
    delayed: undefined as Promise<void> | undefined,
    delayedFinished: false,
    delayedClosed: false,
  }
  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", request.headers.origin ?? "*")
    response.setHeader(
      "access-control-allow-headers",
      "authorization,content-type,x-deepagent-code-directory,x-deepagent-code-workspace",
    )
    response.setHeader("access-control-allow-methods", "GET,OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const url = new URL(request.url ?? "/", "http://private.invalid")
    const directory =
      url.searchParams.get("directory") ??
      decodeURIComponent(String(request.headers["x-deepagent-code-directory"] ?? "/a"))
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(value))
    }
    if (request.headers.authorization !== "Bearer private-reader-product") {
      json({ denied: true }, 401)
      return
    }
    if (request.method !== "GET") {
      state.posts++
      json({ rejected: true }, 405)
      return
    }
    const reader = () => ({
      displayEpoch: directory,
      proofWindowMs: 1000,
      validatedServerNow: Date.now(),
      nextExpiryAt: null,
    })
    const group = {
      id: "private-group",
      name: `Remote ${directory}`,
      workspaceID: directory,
      projectID: null,
      type: "direct",
      createdBy: "viewer",
      kernelConvID: "kr1:private-peer",
      createdAt: 1,
      updatedAt: 1,
      reader: { mode: "protected", state: "ready", liveUnread: "125" },
    }
    if (url.pathname === "/global/capabilities") {
      state.capabilities++
      json({ features: { v4FileUploadEnabled: false } })
      return
    }
    if (url.pathname.endsWith("/status")) {
      json({
        facade: "active",
        identity: { uuid: "viewer", name: "Private viewer", orgID: 1, orgAllGroupID: "all" },
        blocked: null,
        kernel: "connected",
        keyOrigin: "none",
        viewer: { memberID: "viewer" },
        reader: { state: "ready", displayEpoch: directory, legacyMirrorUnavailable: true },
      })
      return
    }
    if (url.pathname.endsWith("/groups/page")) {
      const lane = url.searchParams.get("lane")
      json({
        version: 1,
        lane,
        groups: lane === "protected" ? [group] : [],
        hasMore: false,
        nextCursor: null,
        ...(lane === "protected" ? { reader: reader() } : {}),
      })
      return
    }
    if (url.pathname.endsWith("/agents")) {
      json([])
      return
    }
    if (url.pathname.endsWith("/messages")) {
      const cursor = url.searchParams.get("cursor")
      state.requests.push({ directory, cursor, limit: url.searchParams.get("limit") })
      if (cursor && state.fail) {
        json({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable" } }, 500)
        return
      }
      if (cursor && state.delayed) {
        response.once("close", () => {
          state.delayedClosed = true
        })
        await state.delayed
        state.delayedFinished = true
      }
      const offset = cursor === "older-50" ? 50 : cursor === "older-100" ? 100 : 0
      const messages = Array.from({ length: Math.min(50, 125 - offset) }, (_, index) => ({
        id: `${directory}-message-${offset + index}`,
        groupID: group.id,
        senderID: "peer",
        senderType: "user",
        type: "text",
        content: `${directory} history ${offset + index} 中文`,
        mentions: null,
        metadata: null,
        replyToID: null,
        createdAt: 125 - offset - index,
        updatedAt: 125 - offset - index,
        deletedAt: null,
      }))
      json({
        messages,
        nextCursor: offset === 100 ? null : state.repeat && cursor ? cursor : `older-${offset + 50}`,
        hasMore: offset !== 100,
        reader: reader(),
      })
      return
    }
    if (url.pathname.endsWith("/groups/private-group")) {
      json({ group, reader: reader() })
      return
    }
    json({ missing: true }, 404)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Private HTTP address missing")
  const [directory, setDirectory] = createSignal("/a")
  runtime.client = createIMClient(() => ({
    url: `http://127.0.0.1:${address.port}`,
    directory: directory(),
    bearer: "private-reader-product",
  }))
  runtime.sdk = createSdkForServer({ server: runtime.client.scope(), directory: "/a" })
  return {
    state,
    setDirectory,
    async close() {
      cleanup()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
const show = () =>
  render(() => (
    <MemoryRouter>
      <Route path="/" component={() => <SidePanelIM onClose={() => {}} />} />
    </MemoryRouter>
  ))
async function select(directory = "/a") {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`Remote ${directory}`) }))
  await screen.findByText(`${directory} history 0 中文`)
}
const count = () => document.querySelectorAll("[data-im-message]").length
const older = () => screen.getByRole("button", { name: dict["im.message.older"] })

it("original parent and child load125 distinct protected messages in50/50/25 through real HTTP without a read write", async () => {
  const api = await serve()
  show()
  try {
    await select()
    expect(count()).toBe(50)
    fireEvent.click(older())
    await waitFor(() => expect(count()).toBe(100))
    fireEvent.click(older())
    await waitFor(() => expect(count()).toBe(125))
    expect(
      new Set(
        Array.from(document.querySelectorAll<HTMLElement>("[data-im-message]")).map((node) => node.dataset.imMessage),
      ).size,
    ).toBe(125)
    expect(screen.queryByRole("button", { name: dict["im.message.older"] })).toBeNull()
    expect(api.state.requests.flatMap((request) => request.cursor ?? [])).toEqual(["older-50", "older-100"])
    expect(api.state.requests.filter((request) => request.cursor === null).length).toBeGreaterThanOrEqual(1)
    expect(api.state.requests.filter((request) => request.cursor === null).length).toBeLessThanOrEqual(2)
    expect(api.state.requests.every((request) => request.limit === "50")).toBe(true)
    expect(api.state.capabilities).toBeGreaterThan(0)
    expect(api.state.posts).toBe(0)
  } finally {
    await api.close()
  }
})

it("a real middle-page500 clears protected history and exposes explicit retry instead of claiming completion", async () => {
  const api = await serve()
  show()
  try {
    await select()
    api.state.fail = true
    fireEvent.click(older())
    await screen.findByText(dict["im.message.load.failed"])
    expect(count()).toBe(0)
    expect(screen.getByText(dict["im.reader.unavailable"])).toBeTruthy()
    api.state.fail = false
    fireEvent.click(screen.getByRole("button", { name: dict["im.facade.retry"] }))
    await waitFor(() => expect(count()).toBe(50))
    fireEvent.click(older())
    await waitFor(() => expect(count()).toBe(100))
    fireEvent.click(older())
    await waitFor(() => expect(count()).toBe(125))
    expect(api.state.posts).toBe(0)
  } finally {
    await api.close()
  }
})

it("same-origin directory change cancels the original held page and cannot disclose its late body in the new parent", async () => {
  const api = await serve()
  show()
  const gate = Promise.withResolvers<void>()
  try {
    await select()
    api.state.delayed = gate.promise
    fireEvent.click(older())
    await waitFor(() => expect(api.state.requests.some((request) => request.cursor === "older-50")).toBe(true))
    api.setDirectory("/b")
    await select("/b")
    await waitFor(() => expect(api.state.delayedClosed).toBe(true))
    gate.resolve()
    await waitFor(() => expect(api.state.delayedFinished).toBe(true))
    expect(screen.queryByText("/a history 50 中文")).toBeNull()
    expect(screen.queryByText("/a history 0 中文")).toBeNull()
    expect(count()).toBe(50)
    expect(api.state.posts).toBe(0)
  } finally {
    gate.resolve()
    await api.close()
  }
})

it("a repeated older cursor cannot be treated as a successful advancing protected page", async () => {
  const api = await serve()
  show()
  try {
    await select()
    api.state.repeat = true
    fireEvent.click(older())
    await screen.findByText(dict["im.message.load.failed"])
    expect(count()).toBe(0)
    expect(api.state.posts).toBe(0)
  } finally {
    await api.close()
  }
})
