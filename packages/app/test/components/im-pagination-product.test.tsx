import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { MemoryRouter, Route } from "@solidjs/router"
import { createServer } from "node:http"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { MessageList } from "@/components/im/message-list"
import type { LocalMessage } from "@/hooks/use-im-websocket"
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
vi.mock("@/context/command", async (original) => ({
  ...(await original<typeof import("@/context/command")>()),
  useCommand: () => ({ register: vi.fn() }),
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
    anchorMissing: false,
    requests: [] as { directory: string; cursor: string | null; anchorID: string | null; limit: string | null }[],
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
    const message = (index: number) => ({
      id: `${directory}-message-${index}`,
      groupID: group.id,
      senderID: "peer",
      senderType: "user",
      type: "text",
      content: `${directory} history ${index} 中文`,
      mentions: null,
      metadata: null,
      replyToID: null,
      createdAt: 125 - index,
      updatedAt: 125 - index,
      deletedAt: null,
    })
    if (url.pathname.endsWith("/search")) {
      json({
        messages: [{ ...message(124), content: "Search preview is not conversation history" }],
        nextCursor: null,
        hasMore: false,
        reader: reader(),
      })
      return
    }
    if (url.pathname.endsWith("/messages")) {
      const cursor = url.searchParams.get("cursor")
      const anchorID = url.searchParams.get("anchorID")
      state.requests.push({ directory, cursor, anchorID, limit: url.searchParams.get("limit") })
      if (cursor && state.fail) {
        json({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable" } }, 500)
        return
      }
      if ((cursor || anchorID) && state.delayed) {
        response.once("close", () => {
          state.delayedClosed = true
        })
        await state.delayed
        state.delayedFinished = true
      }
      const offset = anchorID ? 75 : Number(cursor?.replace("older-", "") ?? 0)
      const messages =
        anchorID && state.anchorMissing
          ? []
          : Array.from({ length: Math.min(50, 125 - offset) }, (_, index) => message(offset + index))
      json({
        messages,
        nextCursor: offset >= 75 ? null : state.repeat && cursor ? cursor : `older-${offset + 50}`,
        hasMore: offset < 75,
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

async function searchTarget() {
  await screen.findByRole("button", { name: /Remote \/a/ })
  const input = await screen.findByRole("textbox", { name: dict["im.workspace.filter"] })
  fireEvent.input(input, { target: { value: "history" } })
  fireEvent.keyDown(input, { key: "Enter" })
  fireEvent.click(await screen.findByRole("button", { name: /Search preview is not conversation history/ }))
}

it("a parent search selection reads the real anchored page, focuses its exact message and returns to latest", async () => {
  const api = await serve()
  show()
  try {
    await searchTarget()
    await screen.findByText("/a history 124 中文")
    const target = document.querySelector<HTMLElement>('[data-im-message="/a-message-124"]')!
    await waitFor(() => expect(target.dataset.imTarget).toBe("true"))
    expect(target.getAttribute("aria-current")).toBe("location")
    expect(document.activeElement).toBe(target)
    expect(count()).toBe(50)
    expect(within(screen.getByRole("log")).queryByText("Search preview is not conversation history")).toBeNull()
    expect(screen.getByText("Search preview is not conversation history").closest('[data-slot="im-message-search-results"]')?.classList.contains("hidden")).toBe(true)
    expect(api.state.requests.some((request) => request.anchorID === "/a-message-124" && request.cursor === null)).toBe(
      true,
    )
    const composer = screen.getByPlaceholderText(dict["im.composer.placeholder"]) as HTMLTextAreaElement
    fireEvent.input(composer, { target: { value: "Keep this unsent conversation draft" } })
    fireEvent.click(screen.getByRole("button", { name: dict["im.message.location.latest"] }))
    await screen.findByText("/a history 0 中文")
    expect(screen.queryByText("/a history 124 中文")).toBeNull()
    expect(document.querySelector('[aria-current="location"]')).toBeNull()
    expect(screen.getByPlaceholderText(dict["im.composer.placeholder"])).toBe(composer)
    expect(composer.value).toBe("Keep this unsent conversation draft")
    expect(api.state.requests.at(-1)?.anchorID).toBeNull()
    expect(api.state.posts).toBe(0)
  } finally {
    await api.close()
  }
})

it("a focused message remains detached from tail following after a scroll event and a newer message", async () => {
  const message: LocalMessage = {
    id: "focus-target",
    groupID: "focus-group",
    senderID: "peer",
    senderType: "user",
    type: "text",
    content: "Focused message",
    mentions: null,
    metadata: null,
    replyToID: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
  const [messages, setMessages] = createSignal([message])
  const [focus, setFocus] = createSignal<string | undefined>(message.id)
  render(() => (
    <MessageList messages={messages()} focusMessageID={focus()} agentStatuses={new Map()} agentProgress={new Map()} />
  ))
  const log = screen.getByRole("log")
  await waitFor(() => expect(document.querySelector('[data-im-target="true"]')).toBeTruthy())
  // happy-dom has no layout. This checks scroll state transitions, not Native geometry.
  log.scrollTop = 100
  fireEvent.scroll(log)
  setMessages([message, { ...message, id: "newer-message", content: "Newer message", createdAt: 2 }])
  await screen.findByText("Newer message")
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  expect(log.scrollTop).toBe(100)
  expect(document.querySelector('[aria-current="location"]')?.getAttribute("data-im-message")).toBe(message.id)
  setFocus(undefined)
  await waitFor(() => expect(log.scrollTop).toBe(log.scrollHeight))
})

it("an invisible search target shows explicit feedback without injecting the search preview or falling back to latest", async () => {
  const api = await serve()
  api.state.anchorMissing = true
  show()
  try {
    await searchTarget()
    await screen.findByText(dict["im.message.location.unavailable"])
    expect(count()).toBe(0)
    expect(screen.queryByText("/a history 0 中文")).toBeNull()
    expect(screen.getByText("Search preview is not conversation history").closest('[data-slot="im-message-search-results"]')?.classList.contains("hidden")).toBe(true)
    expect(api.state.requests.every((request) => request.anchorID === "/a-message-124")).toBe(true)
    expect(api.state.posts).toBe(0)
  } finally {
    await api.close()
  }
})

it("a directory switch aborts the held anchored page and never displays its late target in the next scope", async () => {
  const api = await serve()
  const gate = Promise.withResolvers<void>()
  api.state.delayed = gate.promise
  show()
  try {
    await searchTarget()
    await waitFor(() => expect(api.state.requests.some((request) => request.anchorID === "/a-message-124")).toBe(true))
    api.setDirectory("/b")
    await waitFor(() => expect(screen.queryByText("Search preview is not conversation history")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: dict["im.sidebar.clearSearch"] }))
    await select("/b")
    await waitFor(() => expect(api.state.delayedClosed).toBe(true))
    gate.resolve()
    await waitFor(() => expect(api.state.delayedFinished).toBe(true))
    expect(screen.queryByText("/a history 124 中文")).toBeNull()
    expect(document.querySelector('[aria-current="location"]')).toBeNull()
    expect(count()).toBe(50)
    expect(api.state.posts).toBe(0)
  } finally {
    gate.resolve()
    await api.close()
  }
})

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
