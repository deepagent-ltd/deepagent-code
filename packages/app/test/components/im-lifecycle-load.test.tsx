import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { MemoryRouter, Route } from "@solidjs/router"
import { createSignal } from "solid-js"
import { createServer } from "node:http"
import { setImmediate } from "node:timers/promises"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { MessageSearch } from "@/components/im/message-search"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { createIMClient, type IMClient } from "@/utils/im-client"
import { dict } from "@/i18n/en"
import { imSummaryOwner } from "@/components/im/summary-owner"

const runtime = vi.hoisted(() => ({ client: undefined as IMClient | undefined }))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => runtime.client!,
}))
vi.mock("@/context/command", async (original) => ({
  ...(await original<typeof import("@/context/command")>()),
  useCommand: () => ({ register: vi.fn() }),
}))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: {}, directory: "/private/lifecycle" }) }))
vi.mock("@/context/server", async (original) => ({
  ...(await original<typeof import("@/context/server")>()),
  useServer: () => ({
    key: "lifecycle",
    scope: () => "lifecycle",
    get current() {
      return runtime.client ? { type: "sidecar", http: { ...runtime.client.scope() } } : undefined
    },
    all: [],
    projects: () => ({ list: [] }),
  }),
}))
vi.mock("@/components/im/capabilities", () => ({ fetchIMCapabilities: async () => ({}) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn() }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    Socket.instances.push(this)
  }
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
  })
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  fail() {
    this.readyState = 3
    this.onclose?.(new CloseEvent("close", { wasClean: false }))
  }
  changed(displayEpoch = "e1") {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "reader_changed", data: { groupID: "protected", displayEpoch } }),
      }),
    )
  }
}

beforeEach(() => {
  // HTTP uses a real private socket; only the UI's single timer clock is controlled.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] })
  Socket.instances = []
  vi.stubGlobal("WebSocket", Socket)
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
})
afterEach(() => {
  cleanup()
  imSummaryOwner.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (document as { visibilityState?: string }).visibilityState
})

async function flushHTTP(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await setImmediate()
  expect(check()).toBe(true)
  for (let i = 0; i < 10; i++) await setImmediate()
}
function visibility(value: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value })
  document.dispatchEvent(new Event("visibilitychange"))
}
async function serve() {
  const calls: { path: string; method: string }[] = []
  const state = {
    content: "first protected body",
    epoch: "e1",
    group: "",
    failed: false,
    readerDisabled: false,
    gate: undefined as Promise<void> | undefined,
    agents: undefined as Promise<void> | undefined,
    agentsClosed: false,
    agentsFinished: 0,
    search: { cursors: [] as (string | null)[], nextExpiryAt: null as number | null },
  }
  const statusGates: (Promise<void> | undefined)[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "http://localhost:3000")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-deepagent-code-directory")
    response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    calls.push({ path, method: request.method ?? "GET" })
    const content = state.content
    const epoch = state.epoch
    const group = state.group
    const lane = new URL(request.url ?? "/", "http://localhost").searchParams.get("lane")
    if (path.endsWith("/search")) {
      const cursor = new URL(request.url ?? "/", "http://localhost").searchParams.get("cursor")
      state.search.cursors.push(cursor)
      await state.gate
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(
        JSON.stringify({
          messages: [
            {
              id: cursor ? "search-next" : "search-first",
              groupID: "protected",
              senderID: "peer",
              senderType: "user",
              type: "text",
              content: content + (cursor ? " search next" : " search first"),
              mentions: null,
              metadata: null,
              replyToID: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          hasMore: !cursor,
          nextCursor: cursor ? null : "search-page-2",
          reader: {
            state: "ready",
            displayEpoch: epoch,
            projectionRevision: "1",
            validatedServerNow: 1000,
            nextExpiryAt: state.search.nextExpiryAt,
          },
        }),
      )
      return
    }
    if (path.endsWith("/agents")) {
      response.on("close", () => {
        state.agentsClosed = true
      })
      await state.agents
      state.agentsFinished++
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end("[]")
      return
    }
    // The protected request belongs to the status batch that chose its reader.
    if (path.endsWith("/status")) statusGates.push(state.gate)
    await (path.endsWith("/groups/page") && lane === "protected" ? statusGates.at(-1) : state.gate)
    response.writeHead(state.failed ? 503 : 200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify(
        state.failed
          ? {}
          : path.endsWith("/status")
            ? {
                facade: "disabled",
                identity: null,
                blocked: null,
                kernel: null,
                keyOrigin: "none",
                ...(state.readerDisabled ? { reader: null } : {}),
              }
            : path.endsWith("/groups/page")
              ? {
                  version: 1,
                  lane,
                  groups:
                    lane === "ordinary" && group
                      ? [
                          {
                            id: "local",
                            name: group,
                            workspaceID: "workspace",
                            projectID: null,
                            type: "group",
                            createdBy: "self",
                            kernelConvID: null,
                            createdAt: 1,
                            updatedAt: 1,
                          },
                        ]
                      : [],
                  hasMore: false,
                  nextCursor: null,
                  ...(lane === "protected"
                    ? { reader: { displayEpoch: "e1", proofWindowMs: 1000, nextExpiryAt: null } }
                    : {}),
                }
              : {
                  messages: [
                    {
                      id: content,
                      groupID: "protected",
                      senderID: "peer",
                      senderType: "user",
                      type: "text",
                      content,
                      mentions: null,
                      metadata: null,
                      replyToID: null,
                      createdAt: 1,
                      updatedAt: 1,
                      deletedAt: null,
                    },
                  ],
                  hasMore: false,
                  nextCursor: null,
                  reader: {
                    state: "ready",
                    displayEpoch: epoch,
                    projectionRevision: "1",
                    validatedServerNow: 1000,
                    nextExpiryAt: null,
                  },
                },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing private HTTP listener")
  runtime.client = createIMClient(() => ({
    url: `http://127.0.0.1:${address.port}`,
    directory: "/private/lifecycle",
    password: "private-fixture-only",
  }))
  return {
    state,
    calls,
    messages: () => calls.filter((call) => call.path.endsWith("/messages")).length,
    status: () => calls.filter((call) => call.path.endsWith("/status")).length,
    pages: () => calls.filter((call) => call.path.endsWith("/groups/page")).length,
    async close() {
      cleanup()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

it("the panel uses one 30-second fallback and merges hidden work into one foreground refresh", async () => {
  const peer = await serve()
  try {
    const view = render(() => (
      <MemoryRouter>
        <Route path="/" component={() => <SidePanelIM onClose={() => {}} />} />
      </MemoryRouter>
    ))
    await flushHTTP(() => peer.status() === 1 && peer.pages() === 2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(peer.status()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushHTTP(() => peer.status() === 2 && peer.pages() === 4)
    visibility("hidden")
    await vi.advanceTimersByTimeAsync(90_000)
    expect(peer.status()).toBe(2)
    expect(peer.pages()).toBe(4)
    peer.state.group = "Changed while hidden"
    visibility("visible")
    await flushHTTP(() => !!screen.queryByRole("button", { name: /Changed while hidden/ }))
    expect(peer.status()).toBe(3)
    expect(peer.pages()).toBe(6)
    expect(peer.calls.every((call) => call.method === "GET")).toBe(true)
    view.unmount()
    await flushHTTP(() => peer.status() === 4)
    expect(peer.pages()).toBe(6)
    imSummaryOwner.stop()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(peer.status()).toBe(4)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await peer.close()
  }
})

it("protected reader changes and reconnect refresh immediately while hidden automatic HTTP stays paused", async () => {
  const peer = await serve()
  try {
    const view = render(() => <GroupChatPanel groupID="protected" protected />)
    Socket.instances[0].open()
    await flushHTTP(() => !!screen.queryByText("first protected body"))
    expect(peer.messages()).toBe(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(peer.messages()).toBe(1)
    peer.state.content = "actual reader changed body"
    Socket.instances[0].changed()
    await flushHTTP(() => !!screen.queryByText(peer.state.content))
    expect(peer.messages()).toBe(2)
    visibility("hidden")
    peer.state.content = "hidden change body"
    for (let i = 0; i < 20; i++) Socket.instances[0].changed()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(peer.messages()).toBe(2)
    visibility("visible")
    await flushHTTP(() => !!screen.queryByText(peer.state.content))
    expect(peer.messages()).toBe(3)
    Socket.instances[0].fail()
    expect(screen.queryByText(peer.state.content)).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    peer.state.content = "reconnected body"
    Socket.instances[1].open()
    await flushHTTP(() => !!screen.queryByText(peer.state.content))
    expect(peer.messages()).toBe(4)
    expect(peer.calls.every((call) => call.method === "GET")).toBe(true)
    view.unmount()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(peer.messages()).toBe(4)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await peer.close()
  }
})

it("a reader event burst owns one request and at most one successor, then a new change can refresh", async () => {
  const peer = await serve()
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  try {
    peer.state.gate = first.promise
    render(() => <GroupChatPanel groupID="protected" protected />)
    Socket.instances[0].open()
    await flushHTTP(() => peer.messages() === 1)
    for (let i = 0; i < 20; i++) Socket.instances[0].changed()
    expect(peer.messages()).toBe(1)
    peer.state.gate = second.promise
    first.resolve()
    await flushHTTP(() => peer.messages() === 2)
    for (let i = 0; i < 20; i++) Socket.instances[0].changed()
    peer.state.gate = undefined
    second.resolve()
    await flushHTTP(() => !!screen.queryByText(peer.state.content))
    expect(peer.messages()).toBe(2)
    peer.state.content = "new burst body"
    Socket.instances[0].changed()
    await vi.advanceTimersByTimeAsync(1000)
    await flushHTTP(() => !!screen.queryByText(peer.state.content))
    expect(peer.messages()).toBe(3)
  } finally {
    first.resolve()
    second.resolve()
    await peer.close()
  }
})

it("a failed reader burst does not start an immediate retry loop", async () => {
  const peer = await serve()
  const held = Promise.withResolvers<void>()
  try {
    peer.state.gate = held.promise
    render(() => <GroupChatPanel groupID="protected" protected />)
    Socket.instances[0].open()
    await flushHTTP(() => peer.messages() === 1)
    for (let i = 0; i < 20; i++) Socket.instances[0].changed()
    peer.state.failed = true
    held.resolve()
    await flushHTTP(() => !!screen.queryByText(dict["im.reader.unavailable"]))
    await vi.advanceTimersByTimeAsync(29_999)
    expect(peer.messages()).toBe(1)
  } finally {
    held.resolve()
    await peer.close()
  }
})

it("a new reader epoch supersedes an in-flight page without waiting for the fallback", async () => {
  const peer = await serve()
  const held = Promise.withResolvers<void>()
  try {
    render(() => <GroupChatPanel groupID="protected" protected />)
    Socket.instances[0].open()
    await flushHTTP(() => !!screen.queryByText(peer.state.content))
    peer.state.gate = held.promise
    Socket.instances[0].changed()
    await flushHTTP(() => peer.messages() === 2)
    peer.state.epoch = "e2"
    peer.state.content = "new epoch body"
    Socket.instances[0].changed("e2")
    expect(screen.queryByText("first protected body")).toBeNull()
    peer.state.gate = undefined
    held.resolve()
    await flushHTTP(() => screen.queryByText("first protected body") === null)
    await vi.advanceTimersByTimeAsync(1000)
    await flushHTTP(() => !!screen.queryByText(peer.state.content))
    expect(peer.messages()).toBe(3)
  } finally {
    held.resolve()
    await peer.close()
  }
})

it("panel visibility bursts coalesce and a failed batch waits for another explicit event", async () => {
  const peer = await serve()
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  try {
    peer.state.gate = first.promise
    render(() => (
      <MemoryRouter>
        <Route path="/" component={() => <SidePanelIM onClose={() => {}} />} />
      </MemoryRouter>
    ))
    await flushHTTP(() => peer.status() === 1 && peer.pages() === 1)
    for (let i = 0; i < 20; i++) visibility("visible")
    peer.state.gate = second.promise
    first.resolve()
    await flushHTTP(() => peer.status() === 2 && peer.pages() === 3)
    for (let i = 0; i < 20; i++) visibility("visible")
    peer.state.failed = true
    second.resolve()
    await flushHTTP(() => !!screen.queryByText(dict["im.facade.status.failed"]))
    expect(peer.status()).toBe(2)
    expect(peer.pages()).toBe(4)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(peer.status()).toBe(2)
    peer.state.failed = false
    peer.state.gate = undefined
    visibility("visible")
    await flushHTTP(() => peer.status() === 3 && peer.pages() === 6)
  } finally {
    first.resolve()
    second.resolve()
    await peer.close()
  }
})

it("a final hint during the busy successor is consumed by one bounded trailing refresh and its timer belongs to the owner", async () => {
  const peer = await serve()
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const third = Promise.withResolvers<void>()
  try {
    peer.state.gate = first.promise
    const view = render(() => <GroupChatPanel groupID="protected" protected />)
    Socket.instances[0].open()
    await flushHTTP(() => peer.messages() === 1)
    const ownerTimers = vi.getTimerCount()
    for (let i = 0; i < 20; i++) Socket.instances[0].changed()
    peer.state.gate = second.promise
    first.resolve()
    await flushHTTP(() => peer.messages() === 2)
    peer.state.content = "last hint during busy successor"
    for (let i = 0; i < 20; i++) Socket.instances[0].changed()
    peer.state.gate = third.promise
    second.resolve()
    await flushHTTP(() => !!screen.queryByText("first protected body"))
    expect(peer.messages()).toBe(2)
    expect(vi.getTimerCount()).toBe(ownerTimers + 1)
    await vi.advanceTimersByTimeAsync(999)
    expect(peer.messages()).toBe(2)
    for (let i = 0; i < 20; i++) Socket.instances[0].changed()
    expect(vi.getTimerCount()).toBe(ownerTimers + 1)
    await vi.advanceTimersByTimeAsync(1)
    await flushHTTP(() => peer.messages() === 3)
    for (let i = 0; i < 20; i++) Socket.instances[0].changed()
    peer.state.gate = undefined
    third.resolve()
    await flushHTTP(() => !!screen.queryByText(peer.state.content))
    expect(peer.messages()).toBe(3)
    expect(vi.getTimerCount()).toBe(ownerTimers + 1)
    await vi.advanceTimersByTimeAsync(999)
    expect(peer.messages()).toBe(3)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(peer.messages()).toBe(3)
    expect(peer.calls.every((call) => call.method === "GET")).toBe(true)
  } finally {
    first.resolve()
    second.resolve()
    third.resolve()
    await peer.close()
  }
})

it("disposing a conversation aborts its actual agent HTTP request and ignores its late response", async () => {
  const peer = await serve()
  const held = Promise.withResolvers<void>()
  try {
    peer.state.agents = held.promise
    const [group, select] = createSignal("protected")
    const view = render(() => <GroupChatPanel groupID={group()} protected />)
    Socket.instances[0].open()
    await flushHTTP(() => peer.calls.filter((call) => call.path.endsWith("/agents")).length === 1)
    select("other-owner")
    await flushHTTP(() => peer.state.agentsClosed)
    expect(Socket.instances[0].close).toHaveBeenCalledTimes(1)
    expect(Socket.instances).toHaveLength(2)
    held.resolve()
    await flushHTTP(() => peer.state.agentsFinished === 2)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    held.resolve()
    await peer.close()
  }
})

it("an explicitly disabled reader keeps ordinary conversations available without protected page requests", async () => {
  const peer = await serve()
  try {
    peer.state.readerDisabled = true
    peer.state.group = "Ordinary chat without a remote reader"
    const view = render(() => (
      <MemoryRouter>
        <Route path="/" component={() => <SidePanelIM onClose={() => {}} />} />
      </MemoryRouter>
    ))
    await flushHTTP(() => !!screen.queryByRole("button", { name: /Ordinary chat without/ }))
    expect(peer.status()).toBe(1)
    expect(peer.pages()).toBe(1)
    expect(screen.queryByText(dict["im.group.load.failed"])).toBeNull()
    expect(screen.queryByText(dict["im.reader.unavailable"])).toBeNull()
    visibility("hidden")
    await vi.advanceTimersByTimeAsync(90_000)
    expect(peer.pages()).toBe(1)
    visibility("visible")
    await flushHTTP(() => peer.status() === 2 && peer.pages() === 2)
    view.unmount()
    await flushHTTP(() => peer.status() === 3)
    expect(peer.pages()).toBe(2)
    imSummaryOwner.stop()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(peer.pages()).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await peer.close()
  }
})

it("search pagination keeps appended results across natural refresh and a manual search resets the window", async () => {
  const peer = await serve()
  try {
    render(() => <MessageSearch displayEpoch="e1" />)
    fireEvent.input(screen.getByPlaceholderText(`${dict["im.search.messages"]}…`), { target: { value: "needle" } })
    fireEvent.click(screen.getByRole("button", { name: dict["common.search.placeholder"] }))
    await flushHTTP(() => !!screen.queryByText("first protected body search first"))
    fireEvent.click(screen.getByRole("button", { name: dict["common.loadMore"] }))
    await flushHTTP(() => !!screen.queryByText("first protected body search next"))
    expect(peer.state.search.cursors).toEqual([null, "search-page-2"])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(screen.queryByText("first protected body search first")).not.toBeNull()
    expect(screen.queryByText("first protected body search next")).not.toBeNull()
    expect(peer.state.search.cursors).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: dict["common.search.placeholder"] }))
    await flushHTTP(
      () => peer.state.search.cursors.length === 3 && !screen.queryByText("first protected body search next"),
    )
    expect(peer.state.search.cursors.at(-1)).toBeNull()
    await vi.advanceTimersByTimeAsync(5_000)
    await flushHTTP(() => peer.state.search.cursors.length === 4)
    expect(peer.calls.every((call) => call.method === "GET")).toBe(true)
  } finally {
    await peer.close()
  }
})

it("search pagination still clears every protected page at its earliest expiry", async () => {
  const peer = await serve()
  try {
    peer.state.search.nextExpiryAt = 3000
    render(() => <MessageSearch displayEpoch="e1" />)
    fireEvent.input(screen.getByPlaceholderText(`${dict["im.search.messages"]}…`), { target: { value: "needle" } })
    fireEvent.click(screen.getByRole("button", { name: dict["common.search.placeholder"] }))
    await flushHTTP(() => !!screen.queryByText("first protected body search first"))
    fireEvent.click(screen.getByRole("button", { name: dict["common.loadMore"] }))
    await flushHTTP(() => !!screen.queryByText("first protected body search next"))
    await vi.advanceTimersByTimeAsync(1999)
    expect(screen.queryByText("first protected body search next")).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(screen.queryByText("first protected body search first")).toBeNull()
    expect(screen.queryByText("first protected body search next")).toBeNull()
    expect(screen.queryByRole("status")?.textContent).toBe(dict["im.reader.unavailable"])
  } finally {
    await peer.close()
  }
})

it.each(["epoch", "invalidation"] as const)(
  "search pagination rejects a delayed response after %s authority changes",
  async (kind) => {
    const peer = await serve()
    const pending = Promise.withResolvers<void>()
    try {
      peer.state.gate = pending.promise
      const [epoch, setEpoch] = createSignal("e1")
      const [invalidation, setInvalidation] = createSignal(0)
      render(() => <MessageSearch displayEpoch={epoch()} invalidation={invalidation()} />)
      fireEvent.input(screen.getByPlaceholderText(`${dict["im.search.messages"]}…`), { target: { value: "needle" } })
      fireEvent.click(screen.getByRole("button", { name: dict["common.search.placeholder"] }))
      await flushHTTP(() => peer.state.search.cursors.length === 1)
      if (kind === "epoch") setEpoch("e2")
      if (kind === "invalidation") setInvalidation(1)
      pending.resolve()
      await flushHTTP(() => {
        const button = screen.queryByRole("button", { name: dict["common.search.placeholder"] })
        return !!button && !button.hasAttribute("disabled")
      })
      expect(screen.queryByText("first protected body search first")).toBeNull()
      expect(screen.queryByRole("status")).toBeNull()
      expect(peer.state.search.cursors).toHaveLength(1)
    } finally {
      pending.resolve()
      await peer.close()
    }
  },
)
