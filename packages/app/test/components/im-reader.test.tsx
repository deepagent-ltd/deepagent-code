import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { Show, createSignal } from "solid-js"
import { MemoryRouter, Route } from "@solidjs/router"
import { ThreadView } from "@/components/im/thread-view"
import { MessageSearch } from "@/components/im/message-search"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { createIMClient, type IMClient } from "@/utils/im-client"
import { imSummaryOwner } from "@/components/im/summary-owner"
import type { IMMessage, IMReadAction, IMReaderGroup } from "@/components/im/types"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({ client: undefined as IMClient | undefined, connectedPanel: false }))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => runtime.client!,
}))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: {} }) }))
vi.mock("@/context/command", () => ({ useCommand: () => ({ register: vi.fn() }) }))
vi.mock("@/context/server", async (original) => ({
  ...(await original<typeof import("@/context/server")>()),
  useServer: () => ({
    key: "reader-fixture",
    scope: () => "reader-fixture",
    current: runtime.connectedPanel
      ? { type: "http", http: { url: "http://fixture.test", password: "fixture" } }
      : undefined,
    all: [],
    projects: () => ({ list: [] }),
  }),
}))
vi.mock("@/components/im/capabilities", () => ({ fetchIMCapabilities: async () => ({}) }))
vi.mock("@/components/settings-v2/im", () => ({ SettingsIMV2: () => null }))
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
  send = vi.fn()
  close = vi.fn()
  constructor(readonly url: string) {
    Socket.instances.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  emit(type: string, displayEpoch = "e1") {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type, data: { groupID: "protected", displayEpoch, code: "reader_unavailable" } }),
      }),
    )
  }
}
const message = (content: string): IMMessage => ({
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
})
let content: string
let expiry: number
let reads: IMReadAction[]
let gets: number
let readState: "unknown" | "partial" | "confirmed" | "cancelled"
let pending: Promise<void> | undefined
let readPending: Promise<void> | undefined
let readRefused: boolean
let readErrorCode: string
beforeEach(() => {
  runtime.connectedPanel = false
  content = "protected first"
  expiry = 60000
  reads = []
  gets = 0
  readState = "unknown"
  pending = undefined
  readPending = undefined
  readRefused = false
  readErrorCode = "reader_unavailable"
  Socket.instances = []
  vi.stubGlobal("WebSocket", Socket)
  runtime.client = createIMClient(() => ({
    url: "http://fixture.test",
    directory: "/private/fixture",
    password: "fixture",
  }))
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      if (path.endsWith("/agents")) return Response.json([])
      if (path.endsWith("/refresh"))
        return Response.json({
          version: 1,
          group: {
            id: "protected", name: "Protected conversation", workspaceID: "fixture", projectID: null,
            type: "direct", createdBy: "self", kernelConvID: "kr1:fixture", createdAt: 1, updatedAt: 1,
            reader: { mode: "protected", state: "ready", liveUnread: "2" },
          },
          reader: { displayEpoch: "e1", proofWindowMs: 1000, nextExpiryAt: null },
        })
      if (path.endsWith("/read")) {
        const body = (await request.json()) as IMReadAction
        reads.push(body)
        await readPending
        if (readRefused)
          return Response.json({ name: "IM_READER_UNAVAILABLE", data: { code: readErrorCode } }, { status: 503 })
        return Response.json({
          ok: readState === "confirmed",
          reader: {
            actionID: body.actionID,
            state: readState,
            targetAdmitted: "9007199254740995",
            readOrdinal: "9007199254740993",
            liveUnread: "2",
          },
        })
      }
      gets++
      const page = {
        messages: [message(content)],
        nextCursor: null,
        hasMore: false,
        reader: {
          state: "ready",
          displayEpoch: "e1",
          projectionRevision: "9007199254740993",
          validatedServerNow: 1000,
          nextExpiryAt: 1000 + expiry,
        },
      }
      await pending
      return Response.json(page)
    }),
  )
})
afterEach(() => {
  imSummaryOwner.stop()
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (document as { visibilityState?: string }).visibilityState
})
async function mount(state: "ready" | "pending" = "ready", readAction?: IMReaderGroup["readAction"]) {
  const view = render(() => (
    <GroupChatPanel
      groupID="protected"
      protected
      reader={{ mode: "protected", state, liveUnread: state === "pending" ? null : "2", readAction }}
    />
  ))
  await waitFor(() => expect(Socket.instances).toHaveLength(1))
  Socket.instances[0].open()
  return view
}
it("explicit protected metadata refresh precedes detail and body reads without sending names or messages", async () => {
  const calls: Request[] = []
  const gate = Promise.withResolvers<void>()
  const detail = {
    version: 1,
    group: {
      id: "protected", name: "Verified remote group", workspaceID: "fixture", projectID: null,
      type: "project", createdBy: "self", kernelConvID: "kr1:fixture", createdAt: 1, updatedAt: 1,
      reader: { mode: "protected", state: "ready", liveUnread: "2" },
    },
    reader: { displayEpoch: "e1", proofWindowMs: 1000, nextExpiryAt: null },
  }
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push(request)
    const path = new URL(request.url).pathname
    if (path.endsWith("/refresh")) {
      await gate.promise
      return Response.json(detail)
    }
    if (path.endsWith("/groups/protected")) return Response.json(detail)
    if (path.endsWith("/agents")) return Response.json([])
    return Response.json({ messages: [message("protected metadata body")], nextCursor: null, hasMore: false,
      reader: { state: "ready", displayEpoch: "e1", projectionRevision: "1", validatedServerNow: 1000, nextExpiryAt: 61000 } })
  }))
  const [name, setName] = createSignal("Old group")
  render(() => <GroupChatPanel groupID="protected" protected name={name()}
    reader={{ mode: "protected", state: "ready", liveUnread: "2" }}
    onMetadataRefreshed={async () => { setName((await runtime.client!.getGroup("protected")).group.name) }} />)
  await waitFor(() => expect(Socket.instances).toHaveLength(1))
  Socket.instances[0].open()
  await screen.findByText("protected metadata body")
  expect(calls.some((request) => request.method !== "GET")).toBe(false)
  calls.length = 0
  fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refresh"] }))
  await waitFor(() => expect(calls).toHaveLength(1))
  fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refreshing"] }))
  expect(calls).toHaveLength(1)
  gate.resolve()
  await screen.findByText("Verified remote group")
  await waitFor(() => expect(calls).toHaveLength(3))
  expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    "POST /api/v1/im/groups/protected/refresh", "GET /api/v1/im/groups/protected", "GET /api/v1/im/groups/protected/messages",
  ])
  expect(await calls[0].text()).toBe("")
  expect(calls.every((request) => new URL(request.url).searchParams.get("directory") === "/private/fixture")).toBe(true)
  expect(reads).toHaveLength(0)
})
it("failed protected metadata refresh withdraws old body without follow-up detail or retry", async () => {
  const calls: Request[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push(request)
    const path = new URL(request.url).pathname
    if (path.endsWith("/refresh"))
      return Response.json({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable" } }, { status: 503 })
    if (path.endsWith("/agents")) return Response.json([])
    return Response.json({ messages: [message("protected metadata body")], nextCursor: null, hasMore: false,
      reader: { state: "ready", displayEpoch: "e1", projectionRevision: "1", validatedServerNow: 1000, nextExpiryAt: 61000 } })
  }))
  const updated = vi.fn(async () => {})
  render(() => <GroupChatPanel groupID="protected" protected
    reader={{ mode: "protected", state: "ready", liveUnread: "2" }} onMetadataRefreshed={updated} />)
  await waitFor(() => expect(Socket.instances).toHaveLength(1))
  Socket.instances[0].open()
  await screen.findByText("protected metadata body")
  calls.length = 0
  fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refresh"] }))
  await screen.findByText(dict["im.transport.refreshFailed"])
  expect(screen.queryByText("protected metadata body")).toBeNull()
  expect(calls.map((request) => request.method)).toEqual(["POST"])
  expect(updated).not.toHaveBeenCalled()
  expect(reads).toHaveLength(0)
})
it("does not mark on view or refresh; explicit unknown/partial action preserves its ID and never sends a WS receipt", async () => {
  await mount()
  await screen.findByText("protected first")
  expect(reads).toHaveLength(0)
  content = "protected second"
  Socket.instances[0].emit("reader_changed")
  await screen.findByText("protected second")
  fireEvent.click(screen.getByRole("button", { name: dict["im.reader.markRead"] }))
  await screen.findByRole("button", { name: dict["im.reader.reconcile"] })
  readState = "partial"
  fireEvent.click(screen.getByRole("button", { name: dict["im.reader.reconcile"] }))
  await screen.findByRole("button", { name: dict["im.reader.continue"] })
  readState = "confirmed"
  fireEvent.click(screen.getByRole("button", { name: dict["im.reader.continue"] }))
  await screen.findByText(dict["im.reader.confirmed"])
  expect(reads).toHaveLength(3)
  expect(new Set(reads.map((value) => value.actionID)).size).toBe(1)
  expect(reads[0].actionID).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  expect(reads[1].reconcile).toBe(true)
  expect(reads[2].continue).toBe(true)
  expect(Socket.instances[0].send.mock.calls.some(([value]) => String(value).includes("read_receipt"))).toBe(false)
})
it("a failed current history read releases its flight so a normal hint can recover a partial page", async () => {
  const calls: Request[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname.endsWith("/agents")) return Response.json([])
    calls.push(request)
    if (calls.length === 1)
      return Response.json({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable" } }, { status: 503 })
    return Response.json({
      messages: [message("recovered partial history")], nextCursor: null, hasMore: false,
      reader: { state: "partial", displayEpoch: "e1", projectionRevision: "1", validatedServerNow: 1000, nextExpiryAt: null },
    })
  }))
  await mount()
  await screen.findByText(dict["im.message.load.failed"])
  expect(calls).toHaveLength(1)
  Socket.instances[0].emit("reader_changed")
  await screen.findByText("recovered partial history", undefined, { timeout: 2500 })
  expect(calls).toHaveLength(2)
  expect(calls[0].signal.aborted).toBe(true)
  expect(calls.every((request) => request.method === "GET")).toBe(true)
  expect(screen.queryByText(dict["im.message.load.failed"])).toBeNull()
  expect(reads).toHaveLength(0)
})
it("invalidation fences late HTTP and clears visible messages immediately", async () => {
  await mount()
  await screen.findByText("protected first")
  const late = Promise.withResolvers<void>()
  pending = late.promise
  content = "late forbidden body"
  fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refresh"] }))
  await waitFor(() => expect(gets).toBe(2))
  Socket.instances[0].emit("reader_invalidated")
  expect(screen.queryByText("protected first")).toBeNull()
  pending = undefined
  content = "current body after invalidation"
  Socket.instances[0].emit("reader_changed")
  await screen.findByText("current body after invalidation", undefined, { timeout: 2500 })
  late.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(screen.queryByText("late forbidden body")).toBeNull()
  expect(screen.getByText("current body after invalidation")).toBeTruthy()
  expect(gets).toBe(3)
  expect(reads).toHaveLength(0)
})
it("expires the protected display without extending TTL on a late response; pending cannot mark", async () => {
  expiry = 120
  await mount("pending")
  await screen.findByText("protected first")
  expect(screen.getByRole("button", { name: dict["im.reader.markRead"] }).hasAttribute("disabled")).toBe(true)
  await waitFor(() => expect(screen.queryByText("protected first")).toBeNull())
  expect(reads).toHaveLength(0)
})

it("protected thread expiry closes the root and its replies; no implicit read write", async () => {
  expiry = 120
  const [open, setOpen] = createSignal(true)
  render(() => (
    <Show when={open()}>
      <ThreadView
        groupID="protected"
        root={message("root body")}
        protected
        agents={[]}
        onClose={() => setOpen(false)}
      />
    </Show>
  ))
  await screen.findByText("protected first")
  expect(screen.getByText("root body")).toBeTruthy()
  await waitFor(() => expect(screen.queryByText("root body")).toBeNull())
  expect(screen.queryByText("protected first")).toBeNull()
  expect(reads).toHaveLength(0)
})
it("search expiry removes protected results but retains known local results", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        messages: [message("protected search body"), { ...message("local search body"), groupID: "local" }],
        nextCursor: null,
        hasMore: false,
        reader: {
          state: "partial",
          displayEpoch: "e1",
          projectionRevision: "1",
          validatedServerNow: 1000,
          nextExpiryAt: 1120,
        },
      }),
    ),
  )
  render(() => <MessageSearch localGroupIDs={["local"]} displayEpoch="e1" />)
  fireEvent.input(screen.getByPlaceholderText("Search messages…"), { target: { value: "body" } })
  fireEvent.click(screen.getByRole("button", { name: "Search" }))
  await screen.findByText("protected search body")
  await screen.findByText("local search body")
  await waitFor(() => expect(screen.queryByText("protected search body")).toBeNull())
  expect(screen.getByText("local search body")).toBeTruthy()
})

it("search lifecycle preserves results and pagination across a same-epoch status snapshot", async () => {
  vi.useFakeTimers()
  const [status, setStatus] = createSignal({ reader: { displayEpoch: "e1" }, invalidation: 0 })
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    messages: [message("current search body")], nextCursor: "older", hasMore: true,
    reader: { state: "ready", displayEpoch: "e1", projectionRevision: "1", validatedServerNow: 1000, nextExpiryAt: 61000 },
  })))
  render(() => <MessageSearch displayEpoch={status().reader.displayEpoch} invalidation={status().invalidation} />)
  const input = screen.getByPlaceholderText("Search messages…")
  fireEvent.input(input, { target: { value: "body" } })
  fireEvent.click(screen.getByRole("button", { name: "Search" }))
  await vi.advanceTimersByTimeAsync(0)
  expect(screen.getByText("current search body")).toBeTruthy()
  setStatus({ reader: { displayEpoch: "e1" }, invalidation: 0 })
  await vi.advanceTimersByTimeAsync(0)
  expect(screen.getByText("current search body")).toBeTruthy()
  expect(screen.getByRole("button", { name: dict["common.loadMore"] })).toBeTruthy()
  expect(screen.getByPlaceholderText("Search messages…")).toBe(input)
  expect(screen.queryByText(dict["im.reader.unavailable"])).toBeNull()
})

it("search lifecycle retires the previous query expiry before accepting its held successor", async () => {
  vi.useFakeTimers()
  const gate = Promise.withResolvers<void>()
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const q = new URL(new Request(input, init).url).searchParams.get("q")
    if (q === "second") await gate.promise
    return Response.json({
      messages: [message(`${q} query body`)], nextCursor: null, hasMore: false,
      reader: { state: "ready", displayEpoch: "e1", projectionRevision: "1", validatedServerNow: 1000,
        nextExpiryAt: q === "first" ? 1100 : 2000 },
    })
  }))
  render(() => <MessageSearch displayEpoch="e1" />)
  const input = screen.getByPlaceholderText("Search messages…")
  fireEvent.input(input, { target: { value: "first" } })
  fireEvent.click(screen.getByRole("button", { name: "Search" }))
  await vi.advanceTimersByTimeAsync(0)
  expect(screen.getByText("first query body")).toBeTruthy()
  await vi.advanceTimersByTimeAsync(20)
  fireEvent.input(input, { target: { value: "second" } })
  fireEvent.click(screen.getByRole("button", { name: "Search" }))
  await vi.advanceTimersByTimeAsync(100)
  gate.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(screen.getByText("second query body")).toBeTruthy()
  expect(screen.queryByText(dict["im.reader.unavailable"])).toBeNull()
})

it("search lifecycle replaces the deadline only after accepting a fresh complete page", async () => {
  vi.useFakeTimers()
  const current = { calls: 0 }
  vi.stubGlobal("fetch", vi.fn(async () => {
    current.calls++
    return Response.json({
      messages: [message(`replacement body ${current.calls}`)], nextCursor: null, hasMore: false,
      reader: { state: "ready", displayEpoch: "e1", projectionRevision: String(current.calls), validatedServerNow: 1000,
        nextExpiryAt: current.calls === 1 ? 1100 : 2000 },
    })
  }))
  render(() => <MessageSearch displayEpoch="e1" />)
  fireEvent.input(screen.getByPlaceholderText("Search messages…"), { target: { value: "body" } })
  fireEvent.click(screen.getByRole("button", { name: "Search" }))
  await vi.advanceTimersByTimeAsync(0)
  expect(screen.getByText("replacement body 1")).toBeTruthy()
  await vi.advanceTimersByTimeAsync(20)
  fireEvent.click(screen.getByRole("button", { name: "Search" }))
  await vi.advanceTimersByTimeAsync(0)
  expect(screen.getByText("replacement body 2")).toBeTruthy()
  await vi.advanceTimersByTimeAsync(81)
  expect(screen.getByText("replacement body 2")).toBeTruthy()
  await vi.advanceTimersByTimeAsync(920)
  expect(screen.queryByText("replacement body 2")).toBeNull()
  expect(screen.getByText(dict["im.reader.unavailable"])).toBeTruthy()
})

it("search lifecycle append keeps the earliest displayed proof expiry and retains local results", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const append = new URL(new Request(input, init).url).searchParams.has("cursor")
    return Response.json({
      messages: append ? [message("appended protected body")] : [message("first protected body"), { ...message("local body"), groupID: "local" }],
      nextCursor: append ? null : "older", hasMore: !append,
      reader: { state: "ready", displayEpoch: "e1", projectionRevision: "1", validatedServerNow: 1000,
        nextExpiryAt: append ? 2000 : 1100 },
    })
  }))
  render(() => <MessageSearch localGroupIDs={["local"]} displayEpoch="e1" />)
  fireEvent.input(screen.getByPlaceholderText("Search messages…"), { target: { value: "body" } })
  fireEvent.click(screen.getByRole("button", { name: "Search" }))
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(20)
  fireEvent.click(screen.getByRole("button", { name: dict["common.loadMore"] }))
  await vi.advanceTimersByTimeAsync(0)
  expect(screen.getByText("first protected body")).toBeTruthy()
  expect(screen.getByText("appended protected body")).toBeTruthy()
  await vi.advanceTimersByTimeAsync(81)
  expect(screen.queryByText("first protected body")).toBeNull()
  expect(screen.queryByText("appended protected body")).toBeNull()
  expect(screen.getByText("local body")).toBeTruthy()
})

it("search lifecycle real epoch invalidation and scope changes reject their late protected responses", async () => {
  vi.useFakeTimers()
  const [status, setStatus] = createSignal({ epoch: "e1", invalidation: 0, directory: "/private/fixture" })
  runtime.client = createIMClient(() => ({ url: "http://fixture.test", directory: status().directory, password: "fixture" }))
  const response = { body: "initial", epoch: "e1", gate: undefined as Promise<void> | undefined }
  vi.stubGlobal("fetch", vi.fn(async () => {
    const page = {
      messages: [message(response.body), { ...message("local body"), groupID: "local" }], nextCursor: null, hasMore: false,
      reader: { state: "ready", displayEpoch: response.epoch, projectionRevision: "1", validatedServerNow: 1000, nextExpiryAt: null },
    }
    await response.gate
    return Response.json(page)
  }))
  render(() => <MessageSearch localGroupIDs={["local"]} displayEpoch={status().epoch} invalidation={status().invalidation} />)
  fireEvent.input(screen.getByPlaceholderText("Search messages…"), { target: { value: "body" } })
  fireEvent.click(screen.getByRole("button", { name: "Search" }))
  await vi.advanceTimersByTimeAsync(0)
  expect(screen.getByText("initial")).toBeTruthy()
  for (const change of ["epoch", "invalidation", "scope"] as const) {
    const gate = Promise.withResolvers<void>()
    const prior = response.body
    response.body = `late ${change}`
    response.gate = gate.promise
    fireEvent.click(screen.getByRole("button", { name: "Search" }))
    await vi.advanceTimersByTimeAsync(0)
    setStatus((value) => change === "epoch" ? { ...value, epoch: "e2" }
      : change === "invalidation" ? { ...value, invalidation: value.invalidation + 1 }
      : { ...value, directory: "/private/changed" })
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.queryByText(prior)).toBeNull()
    expect(screen.queryByText(response.body)).toBeNull()
    expect(screen.getByText("local body")).toBeTruthy()
    expect(screen.getByText(dict["im.reader.unavailable"])).toBeTruthy()
    gate.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.queryByText(response.body)).toBeNull()
    response.body = `current ${change}`
    response.epoch = status().epoch
    response.gate = undefined
    fireEvent.click(screen.getByRole("button", { name: "Search" }))
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByText(response.body)).toBeTruthy()
    expect(screen.queryByText(dict["im.search.failed"])).toBeNull()
  }
})

it("keeps one read request across body invalidation and accepts its confirmation only after fresh proof", async () => {
  await mount()
  await screen.findByText("protected first")
  const receipt = Promise.withResolvers<void>()
  readPending = receipt.promise
  readState = "confirmed"
  fireEvent.click(screen.getByRole("button", { name: dict["im.reader.markRead"] }))
  await waitFor(() => expect(reads).toHaveLength(1))
  Socket.instances[0].emit("reader_invalidated")
  await screen.findByText(dict["im.reader.unavailable"])
  Socket.instances[0].emit("reader_changed")
  await screen.findByText("protected first")
  fireEvent.click(screen.getByRole("button", { name: dict["im.reader.reconcile"] }))
  expect(reads).toHaveLength(1)
  receipt.resolve()
  await screen.findByText(dict["im.reader.confirmed"])
  expect(reads).toHaveLength(1)
})

it("a refused read action clears protected content immediately without submitting another action", async () => {
  await mount()
  await screen.findByText("protected first")
  readRefused = true
  fireEvent.click(screen.getByRole("button", { name: dict["im.reader.markRead"] }))
  await screen.findByText(dict["im.reader.unavailable"])
  expect(screen.queryByText("protected first")).toBeNull()
  expect(reads).toHaveLength(1)
})

it("reopens an unknown server action read-only and reconciles then continues the same target", async () => {
  await mount("ready", {
    actionID: "original_action",
    cutID: "original_cut",
    phase: "unknown",
    cutIndex: 0,
    targetAdmitted: "9",
    throughOrdinal: "4",
    targetReached: false,
  })
  await screen.findByText("protected first")
  expect(reads).toHaveLength(0)
  readState = "partial"
  fireEvent.click(screen.getByRole("button", { name: dict["im.reader.reconcile"] }))
  await screen.findByRole("button", { name: dict["im.reader.continue"] })
  expect(reads[0]).toEqual({ actionID: "original_action", reconcile: true })
  readState = "confirmed"
  fireEvent.click(screen.getByRole("button", { name: dict["im.reader.continue"] }))
  await screen.findByText(dict["im.reader.confirmed"])
  expect(reads[1]).toEqual({ actionID: "original_action", continue: true })
})

it.each(["unknown", "dispatched"] as const)(
  "keeps a reached %s action unresolved and only reconciles its original ID",
  async (phase) => {
    await mount("ready", {
      actionID: "reached_unknown_action",
      cutID: "reached_unknown_cut",
      phase,
      cutIndex: 0,
      targetAdmitted: "9",
      throughOrdinal: "9",
      targetReached: true,
    })
    await screen.findByText("protected first")
    expect(reads).toHaveLength(0)
    expect(screen.queryByRole("button", { name: dict["im.reader.markRead"] })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: dict["im.reader.reconcile"] }))
    await waitFor(() => expect(reads).toEqual([{ actionID: "reached_unknown_action", reconcile: true }]))
    await screen.findByText(dict["im.reader.targetReachedUnknown"])
    expect(screen.queryByRole("button", { name: dict["im.reader.markRead"] })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: dict["im.reader.reconcile"] }))
    await waitFor(() => expect(reads).toHaveLength(2))
    expect(reads[1]).toEqual(reads[0])
  },
)

it("reopens prepared read intent without dispatch and explicitly cancels without claiming read confirmation", async () => {
  await mount("ready", {
    actionID: "prepared_action",
    cutID: "prepared_cut",
    phase: "prepared",
    cutIndex: 0,
    targetAdmitted: "9",
    throughOrdinal: "4",
    targetReached: false,
  })
  await screen.findByText("protected first")
  expect(reads).toHaveLength(0)
  await screen.findByRole("button", { name: dict["im.reader.resume"] })
  readState = "cancelled"
  fireEvent.click(screen.getByRole("button", { name: dict["im.reader.cancel"] }))
  await screen.findByText(dict["im.reader.cancelled"])
  expect(reads).toEqual([{ actionID: "prepared_action", cancel: true }])
  expect(screen.queryByText(dict["im.reader.confirmed"])).toBeNull()
})

it("pages ordinary and protected groups separately and uses current detail for an off-page selection", async () => {
  const groups = ["Alpha", "Beta", "Gamma"].map((name) => ({
    id: `protected_${name}`,
    name: `Protected ${name}`,
    workspaceID: "fixture",
    projectID: null,
    type: "direct",
    createdBy: "self",
    kernelConvID: `kr1:${name}`,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    reader: { mode: "protected", state: "ready", liveUnread: "1" },
  }))
  const ordinary = { ...groups[0], id: "ordinary", name: "Ordinary Alpha", kernelConvID: null, reader: undefined }
  const calls = { legacy: 0, ordinary: [] as string[], protected: [] as string[], details: [] as string[], reads: 0 }
  const envelope = () => ({
    displayEpoch: "e1",
    proofWindowMs: 1000,
    validatedServerNow: Date.now(),
    nextExpiryAt: Date.now() + 60000,
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url)
      if (url.pathname.endsWith("/status"))
        return Response.json({
          facade: "active",
          identity: { uuid: "self", name: "Fixture Self", orgID: 1, orgAllGroupID: "all" },
          blocked: null,
          keyOrigin: "stored",
          kernel: "connected",
          reader: { state: "ready", displayEpoch: "e1", legacyMirrorUnavailable: true },
        })
      if (url.pathname.endsWith("/groups")) {
        calls.legacy++
        return Response.json([...groups, ordinary])
      }
      if (url.pathname.endsWith("/groups/page")) {
        const lane = url.searchParams.get("lane")
        if (lane !== "ordinary" && lane !== "protected") return new Response("lane", { status: 400 })
        const cursor = url.searchParams.get("cursor") ?? ""
        calls[lane].push(cursor)
        return Response.json({
          version: 1,
          lane,
          groups: lane === "ordinary" ? [ordinary] : cursor ? groups.slice(2) : groups.slice(0, 2),
          hasMore: lane === "protected" && !cursor,
          nextCursor: lane === "protected" && !cursor ? "page_tail" : null,
          ...(lane === "protected" ? { reader: envelope() } : {}),
        })
      }
      const detail = /^\/api\/v1\/im\/groups\/([^/]+)$/.exec(url.pathname)
      if (detail) {
        calls.details.push(detail[1])
        const group = groups.find((item) => item.id === detail[1])
        return group
          ? Response.json({ version: 1, group, reader: envelope() })
          : new Response("missing", { status: 404 })
      }
      if (url.pathname.endsWith("/read")) {
        calls.reads++
        return new Response("unexpected read", { status: 500 })
      }
      if (url.pathname.endsWith("/agents")) return Response.json([])
      return Response.json({
        messages: [{ ...message("Off-page body"), groupID: "protected_Gamma" }],
        hasMore: false,
        nextCursor: null,
        reader: { ...envelope(), state: "ready", projectionRevision: "1" },
      })
    }),
  )
  render(() => <MemoryRouter><Route path="/" component={() => <SidePanelIM onClose={() => {}} />} /></MemoryRouter>)
  await screen.findByRole("button", { name: /Protected Alpha/ })
  expect(calls.legacy).toBe(0)
  expect(screen.queryByRole("button", { name: /Protected Gamma/ })).toBeNull()
  expect(calls.protected).toEqual([""])
  fireEvent.click(screen.getByRole("button", { name: "Load more remote conversations" }))
  fireEvent.click(await screen.findByRole("button", { name: /Protected Gamma/ }))
  await waitFor(() => expect(Socket.instances).toHaveLength(1))
  Socket.instances[0].open()
  await screen.findByText("Off-page body")
  expect(screen.getAllByRole("heading", { name: "Protected Gamma" })).toHaveLength(1)
  expect(calls.protected).toEqual(["", "page_tail"])
  expect(calls.details).toContain("protected_Gamma")
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
  document.dispatchEvent(new Event("visibilitychange"))
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  document.dispatchEvent(new Event("visibilitychange"))
  await waitFor(
    () => expect(calls.details.filter((value) => value === "protected_Gamma").length).toBeGreaterThanOrEqual(2),
  )
  expect(screen.getByText("Off-page body")).toBeTruthy()
  expect(calls.reads).toBe(0)
})

it("keeps a failed page cursor and discards its late retry after the real client scope changes", async () => {
  const [directory, setDirectory] = createSignal("/scope-a")
  runtime.client = createIMClient(() => ({ url: "http://fixture.test", directory: directory(), password: "fixture" }))
  const tail = Promise.withResolvers<void>()
  const cursors: string[] = []
  const row = (id: string, protectedRow = false) => ({
    id,
    name: id,
    workspaceID: "fixture",
    projectID: null,
    type: "direct",
    createdBy: "self",
    kernelConvID: protectedRow ? "kr1:fixture" : null,
    createdAt: 1,
    updatedAt: 1,
    ...(protectedRow ? { reader: { mode: "protected", state: "ready", liveUnread: "1" } } : {}),
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const scope = url.searchParams.get("directory")
      if (request.method !== "GET") throw new Error("Unexpected mutation")
      if (url.pathname.endsWith("/status"))
        return Response.json({
          facade: "active",
          identity: { uuid: "self", name: "Self", orgID: 1, orgAllGroupID: "all" },
          blocked: null,
          keyOrigin: "stored",
          kernel: "connected",
          reader: { state: "ready", displayEpoch: scope, legacyMirrorUnavailable: true },
        })
      if (!url.pathname.endsWith("/groups/page")) throw new Error("Unexpected request")
      const lane = url.searchParams.get("lane")
      const cursor = url.searchParams.get("cursor")
      if (cursor) {
        cursors.push(cursor)
        if (cursors.length === 1) return new Response("unavailable", { status: 503 })
        await tail.promise
      }
      return Response.json({
        version: 1,
        lane,
        groups:
          lane === "ordinary"
            ? [row(`Local ${scope}`)]
            : scope === "/scope-b"
              ? []
              : [row(cursor ? "Late secret" : "Protected first", true)],
        hasMore: lane === "protected" && scope === "/scope-a" && !cursor,
        nextCursor: lane === "protected" && scope === "/scope-a" && !cursor ? "original_tail" : null,
        ...(lane === "protected" ? { reader: { displayEpoch: scope, proofWindowMs: 1000, nextExpiryAt: null } } : {}),
      })
    }),
  )
  render(() => <MemoryRouter><Route path="/" component={() => <SidePanelIM onClose={() => {}} />} /></MemoryRouter>)
  await screen.findByRole("button", { name: /Protected first/ })
  fireEvent.click(screen.getByRole("button", { name: "Load more remote conversations" }))
  await waitFor(() => expect(cursors).toEqual(["original_tail"]))
  await waitFor(() => expect(screen.queryByRole("button", { name: /Protected first/ })).toBeNull())
  expect(screen.getByRole("button", { name: /Local \/scope-a/ })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Load more remote conversations" }))
  await waitFor(() => expect(cursors).toEqual(["original_tail", "original_tail"]))
  setDirectory("/scope-b")
  await screen.findByRole("button", { name: /Local \/scope-b/ })
  tail.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(screen.queryByRole("button", { name: /Late secret|Protected first|Local \/scope-a/ })).toBeNull()
  expect(screen.queryByRole("button", { name: "Load more remote conversations" })).toBeNull()
})

it("keeps old unknown actions separate from an explicit new message action and restores both read-only", async () => {
  const old = {
    actionID: "old_unknown",
    cutID: "old_cut",
    phase: "unknown" as const,
    cutIndex: 0,
    targetAdmitted: "9007199254740993",
    throughOrdinal: "9007199254740993",
    targetReached: true,
  }
  const [reader, setReader] = createSignal<IMReaderGroup>({
    mode: "protected",
    state: "ready",
    liveUnread: "1",
    admittedOrdinal: "9007199254740993",
    readAction: old,
    unresolvedReadActions: [old],
  })
  const show = () => render(() => <GroupChatPanel groupID="protected" protected reader={reader()} />)
  const first = show()
  await waitFor(() => expect(Socket.instances).toHaveLength(1))
  Socket.instances[0].open()
  await screen.findByText("protected first")
  expect(reads).toHaveLength(0)
  expect(screen.queryByRole("button", { name: dict["im.reader.newAction"] })).toBeNull()
  setReader({ ...reader(), admittedOrdinal: "9007199254740994" })
  readState = "confirmed"
  fireEvent.click(await screen.findByRole("button", { name: dict["im.reader.newAction"] }))
  await screen.findByText(dict["im.reader.confirmed"])
  expect(reads).toHaveLength(1)
  expect(reads[0]).toEqual({ actionID: expect.stringMatching(/^gui-read_/), newAction: true })
  expect(reads[0].actionID).not.toBe(old.actionID)
  const current = {
    ...old,
    actionID: reads[0].actionID,
    cutID: "new_cut",
    phase: "confirmed" as const,
    targetAdmitted: "9007199254740994",
    throughOrdinal: "9007199254740994",
  }
  setReader({ ...reader(), liveUnread: "0", readAction: current })
  first.unmount()
  show()
  await waitFor(() => expect(Socket.instances).toHaveLength(2))
  Socket.instances[1].open()
  await screen.findByText("protected first")
  await screen.findByText(dict["im.reader.confirmed"])
  expect(screen.getByText(old.actionID)).toBeTruthy()
  expect(reads).toHaveLength(1)
  Socket.instances[1].emit("reader_invalidated")
  await waitFor(() => expect(screen.queryByText(dict["im.reader.confirmed"])).toBeNull())
  setReader({ ...reader(), readAction: { ...current } })
  Socket.instances[1].emit("reader_changed")
  await screen.findByText("protected first")
  await screen.findByText(dict["im.reader.confirmed"])
  expect(reads).toHaveLength(1)
  readState = "unknown"
  fireEvent.click(screen.getByRole("button", { name: `${dict["im.reader.checkAction"]} ${old.actionID}` }))
  await screen.findByText(dict["im.reader.stillUnknown"])
  expect(reads[1]).toEqual({ actionID: old.actionID, reconcile: true })
  expect(screen.getByText(dict["im.reader.confirmed"])).toBeTruthy()
  expect(screen.queryByRole("button", { name: dict["im.reader.newAction"] })).toBeNull()
  expect(
    Socket.instances
      .flatMap((socket) => socket.send.mock.calls)
      .some(([body]) => String(body).includes("read_receipt")),
  ).toBe(false)
})

it("a normal read refused by an older unknown never silently resends under a new ID", async () => {
  const [reader, setReader] = createSignal<IMReaderGroup>({ mode: "protected", state: "ready", liveUnread: "1" })
  render(() => <GroupChatPanel groupID="protected" protected reader={reader()} />)
  await waitFor(() => expect(Socket.instances).toHaveLength(1))
  Socket.instances[0].open()
  await screen.findByText("protected first")
  readRefused = true
  readErrorCode = "reader_unknown"
  fireEvent.click(screen.getByRole("button", { name: dict["im.reader.markRead"] }))
  await screen.findByText(dict["im.reader.newActionRequired"])
  expect(reads).toHaveLength(1)
  expect(reads[0].newAction).toBeUndefined()
  const old = {
    actionID: "older_unknown",
    cutID: "older_cut",
    phase: "unknown" as const,
    cutIndex: 0,
    targetAdmitted: "2",
    throughOrdinal: "2",
    targetReached: true,
  }
  setReader({
    mode: "protected",
    state: "ready",
    liveUnread: "1",
    admittedOrdinal: "3",
    readAction: old,
    unresolvedReadActions: [old],
  })
  const next = await screen.findByRole("button", { name: dict["im.reader.newAction"] })
  expect(reads).toHaveLength(1)
  readRefused = false
  readState = "confirmed"
  fireEvent.click(next)
  await screen.findByText(dict["im.reader.confirmed"])
  expect(reads).toHaveLength(2)
  expect(reads[1].newAction).toBe(true)
  expect(reads[1].actionID).not.toBe(reads[0].actionID)
  expect(reads[1].actionID).not.toBe(old.actionID)
})


it("explicit group-list refresh observes current recovery and never reconnects or purchases", async () => {
  const current = { ready: false, statuses: 0 }
  const gate = Promise.withResolvers<void>()
  const calls: Request[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      calls.push(request)
      if (url.pathname.endsWith("/status")) {
        current.statuses++
        if (current.statuses === 2) await gate.promise
        return Response.json({
          facade: "active",
          identity: { uuid: "self", name: "Self", orgID: 1, orgAllGroupID: "all" },
          blocked: null,
          kernel: "connected",
          keyOrigin: "stored",
          reader: { state: current.ready ? "ready" : "partial", displayEpoch: current.ready ? "current" : "initial" },
          recovery: { status: current.ready ? "ready" : "pending" },
        })
      }
      if (!url.pathname.endsWith("/groups/page")) throw new Error("Unexpected request")
      const lane = url.searchParams.get("lane")
      return Response.json({
        version: 1,
        lane,
        groups: [],
        hasMore: false,
        nextCursor: null,
        ...(lane === "protected"
          ? { reader: { displayEpoch: current.ready ? "current" : "initial", proofWindowMs: 1000, nextExpiryAt: null } }
          : {}),
      })
    }),
  )
  render(() => (
    <MemoryRouter>
      <Route path="/" component={() => <SidePanelIM onClose={() => {}} />} />
    </MemoryRouter>
  ))
  fireEvent.click(screen.getByRole("button", { name: dict["im.workspace.settings"] }))
  await screen.findByText(dict["im.facade.recovery.pending"])
  fireEvent.click(screen.getByRole("button", { name: dict["im.workspace.messages"] }))
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["im.transport.refresh"] }).hasAttribute("disabled")).toBe(false),
  )
  current.ready = true
  fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refresh"] }))
  await waitFor(() => expect(current.statuses).toBe(2))
  const button = screen.getByRole("button", { name: dict["im.transport.refresh"] }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  button.click()
  expect(current.statuses).toBe(2)
  gate.resolve()
  fireEvent.click(screen.getByRole("button", { name: dict["im.workspace.settings"] }))
  await waitFor(() => expect(screen.queryByText(dict["im.facade.recovery.pending"])).toBeNull())
  await waitFor(() => expect(screen.queryByText(dict["im.reader.unavailable"])).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: dict["im.workspace.messages"] }))
  expect(screen.getByRole("button", { name: dict["im.transport.refresh"] }).hasAttribute("disabled")).toBe(false)
  expect(current.statuses).toBe(2)
  expect(calls).toHaveLength(6)
  expect(calls.every((request) => request.method === "GET")).toBe(true)
  expect(calls.every((request) => new URL(request.url).searchParams.get("directory") === "/private/fixture")).toBe(true)
})

it("explicit group-list refresh keeps protected content unavailable when the current page refuses", async () => {
  const current = { ready: false }
  const calls: Request[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      calls.push(request)
      if (url.pathname.endsWith("/status"))
        return Response.json({
          facade: "active",
          identity: { uuid: "self", name: "Self", orgID: 1, orgAllGroupID: "all" },
          blocked: null,
          kernel: "connected",
          keyOrigin: "stored",
          reader: { state: current.ready ? "ready" : "unavailable", displayEpoch: "current" },
          recovery: { status: current.ready ? "ready" : "failed" },
        })
      if (!url.pathname.endsWith("/groups/page")) throw new Error("Unexpected request")
      const lane = url.searchParams.get("lane")
      if (lane === "protected")
        return Response.json({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable" } }, { status: 503 })
      return Response.json({ version: 1, lane, groups: [], hasMore: false, nextCursor: null })
    }),
  )
  render(() => (
    <MemoryRouter>
      <Route path="/" component={() => <SidePanelIM onClose={() => {}} />} />
    </MemoryRouter>
  ))
  await screen.findByText(dict["im.reader.unavailable"])
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["im.transport.refresh"] }).hasAttribute("disabled")).toBe(false),
  )
  current.ready = true
  fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refresh"] }))
  await waitFor(() => expect(calls).toHaveLength(6))
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["im.transport.refresh"] }).hasAttribute("disabled")).toBe(false),
  )
  expect(screen.getByText(dict["im.reader.unavailable"])).toBeTruthy()
  expect(screen.queryByText(dict["im.facade.recovery.failed"])).toBeNull()
  expect(calls.every((request) => request.method === "GET")).toBe(true)
})


it("current body success clears only an older refresh failure and fences a late old body", async () => {
  const late = Promise.withResolvers<void>()
  const current = { delay: false, messages: 0, refreshes: 0 }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      if (path.endsWith("/agents")) return Response.json([])
      if (path.endsWith("/refresh")) {
        current.refreshes++
        return Response.json(
          {
            name: "IM_READER_UNAVAILABLE",
            data: { code: "reader_unavailable" },
          },
          { status: 503 },
        )
      }
      current.messages++
      if (current.delay) await late.promise
      return Response.json({
        messages: [message("recovered current body")],
        nextCursor: null,
        hasMore: false,
        reader: {
          state: "ready",
          displayEpoch: "e1",
          projectionRevision: "1",
          validatedServerNow: 1000,
          nextExpiryAt: null,
        },
      })
    }),
  )
  await mount()
  await screen.findByText("recovered current body")
  fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refresh"] }))
  await screen.findByText(dict["im.transport.refreshFailed"])
  expect(screen.queryByText("recovered current body")).toBeNull()
  Socket.instances[0].emit("reader_changed")
  await screen.findByText("recovered current body")
  await waitFor(() => expect(screen.queryByText(dict["im.transport.refreshFailed"])).toBeNull())
  current.delay = true
  const count = current.messages
  Socket.instances[0].emit("reader_changed")
  await waitFor(() => expect(current.messages).toBeGreaterThan(count), {
    timeout: 2500,
  })
  fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refresh"] }))
  await screen.findByText(dict["im.transport.refreshFailed"])
  late.resolve()
  await Promise.resolve()
  expect(screen.getByText(dict["im.transport.refreshFailed"])).toBeTruthy()
  expect(screen.queryByText("recovered current body")).toBeNull()
  expect(current.refreshes).toBe(2)
  expect(reads).toHaveLength(0)
})

it("a verified owner keeps the editor openable during background status while submit remains gated", async () => {
  runtime.connectedPanel = true
  const initial = Promise.withResolvers<void>()
  const background = Promise.withResolvers<void>()
  const current = { statuses: 0, refused: false }
  const calls: Request[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      calls.push(request)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/status")) {
        current.statuses++
        if (current.statuses === 1) await initial.promise
        if (current.statuses === 2) await background.promise
        if (current.refused)
          return Response.json(
            {
              name: "IM_READER_UNAVAILABLE",
              data: { code: "reader_unavailable" },
            },
            { status: 503 },
          )
        return Response.json({
          facade: "active",
          identity: {
            uuid: "ui-refresh-self",
            name: "Self",
            orgID: 1,
            orgAllGroupID: "all",
          },
          blocked: null,
          kernel: "connected",
          keyOrigin: "stored",
          reader: { state: "ready", displayEpoch: "e1" },
        })
      }
      if (!url.pathname.endsWith("/groups/page")) throw new Error("Unexpected request")
      const lane = url.searchParams.get("lane")
      return Response.json({
        version: 1,
        lane,
        groups: [],
        hasMore: false,
        nextCursor: null,
        ...(lane === "protected"
          ? {
              reader: {
                displayEpoch: "e1",
                proofWindowMs: 1000,
                nextExpiryAt: null,
              },
            }
          : {}),
      })
    }),
  )
  render(() => (
    <MemoryRouter>
      <Route path="/" component={() => <SidePanelIM onClose={() => {}} />} />
    </MemoryRouter>
  ))
  const opener = screen.getByRole("button", {
    name: dict["im.direct.create"],
  }) as HTMLButtonElement
  expect(opener.disabled).toBe(true)
  initial.resolve()
  await waitFor(() => expect(opener.disabled).toBe(false))
  const updating = imSummaryOwner.refresh()
  await waitFor(() => expect(current.statuses).toBe(2))
  expect(opener.disabled).toBe(false)
  fireEvent.click(opener)
  const editor = await screen.findByPlaceholderText(dict["im.facade.direct.placeholder"])
  fireEvent.input(editor, { target: { value: "existing-person" } })
  const submit = screen.getAllByRole("button", { name: dict["im.direct.create"] }).at(-1) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  background.resolve()
  await updating
  await waitFor(() => expect(submit.disabled).toBe(false))
  current.refused = true
  await imSummaryOwner.refresh()
  expect(opener.disabled).toBe(true)
  await waitFor(() => expect(current.statuses).toBeGreaterThanOrEqual(3))
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("button", { name: dict["im.direct.create"] })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true),
  )
  expect(calls.every((request) => request.method === "GET")).toBe(true)
})

it("parent search survives a status context snapshot with the same real client scope and retires on a changed scope", async () => {
  const [context, setContext] = createSignal({
    url: "http://fixture.test",
    directory: "/scope-a",
    password: "fixture",
  })
  runtime.client = createIMClient(context)
  const calls: Request[] = []
  const current = { statuses: 0 }
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    calls.push(request)
    if (request.method !== "GET") throw new Error("Unexpected mutation")
    if (url.pathname.endsWith("/status")) {
      current.statuses++
      if (current.statuses === 2) setContext((value) => ({ ...value }))
      return Response.json({
        facade: "active",
        identity: { uuid: "parent-search-self", name: "Self", orgID: 1, orgAllGroupID: "all" },
        blocked: null,
        keyOrigin: "stored",
        kernel: "connected",
        reader: { state: "ready", displayEpoch: "e1" },
      })
    }
    if (url.pathname.endsWith("/groups/page")) {
      const lane = url.searchParams.get("lane")
      return Response.json({
        version: 1,
        lane,
        groups: lane === "ordinary" ? [{
          id: "local", name: `Local ${url.searchParams.get("directory")}`, workspaceID: "fixture", projectID: null,
          type: "direct", createdBy: "self", kernelConvID: null, createdAt: 1, updatedAt: 1,
        }] : [],
        hasMore: false,
        nextCursor: null,
        ...(lane === "protected" ? { reader: { displayEpoch: "e1", proofWindowMs: 1000, nextExpiryAt: null } } : {}),
      })
    }
    if (url.pathname.endsWith("/search")) return Response.json({
      messages: [message("parent search body")], nextCursor: null, hasMore: false,
      reader: { state: "ready", displayEpoch: "e1", projectionRevision: "1", validatedServerNow: 1000, nextExpiryAt: null },
    })
    throw new Error("Unexpected request")
  }))
  render(() => <MemoryRouter><Route path="/" component={() => <SidePanelIM onClose={() => {}} />} /></MemoryRouter>)
  await screen.findByRole("button", { name: /Local \/scope-a/ })
  await waitFor(() => expect(screen.getByRole("button", { name: dict["im.transport.refresh"] }).hasAttribute("disabled")).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: dict["im.search.messages"] }))
  const input = screen.getByPlaceholderText("Search messages…")
  fireEvent.input(input, { target: { value: "body" } })
  fireEvent.click(screen.getByRole("button", { name: "Search" }))
  await screen.findByText("parent search body")
  const scope = runtime.client.scope()
  fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refresh"] }))
  await waitFor(() => expect(current.statuses).toBeGreaterThanOrEqual(2))
  await waitFor(() => expect(screen.getByRole("button", { name: dict["im.transport.refresh"] }).hasAttribute("disabled")).toBe(false))
  expect(runtime.client.scope()).toBe(scope)
  expect(screen.queryByPlaceholderText("Search messages…")).toBe(input)
  expect(screen.getByText("parent search body")).toBeTruthy()
  expect((input as HTMLInputElement).value).toBe("body")
  setContext((value) => ({ ...value, directory: "/scope-b" }))
  await screen.findByRole("button", { name: /Local \/scope-b/ })
  expect(runtime.client.scope()).not.toBe(scope)
  expect(screen.queryByPlaceholderText("Search messages…")).toBeNull()
  expect(screen.queryByText("parent search body")).toBeNull()
  expect(calls.every((request) => request.method === "GET")).toBe(true)
})

it("parent anchor context survives same-owner metadata and status snapshots without replacing its summary owner", async () => {
  runtime.connectedPanel = true
  const [context, setContext] = createSignal({
    url: "http://fixture.test",
    directory: "/anchor-a",
    password: "fixture",
  })
  runtime.client = createIMClient(context)
  const attached = vi.spyOn(imSummaryOwner, "attach")
  const calls: Request[] = []
  const current = { statuses: 0, epoch: "e1", account: "anchor-owner-self" }
  const group = () => ({
    id: "protected", name: "Anchor protected conversation", workspaceID: "fixture", projectID: null,
    type: "direct", createdBy: "self", kernelConvID: "kr1:fixture", createdAt: 1, updatedAt: current.statuses,
    reader: { mode: "protected", state: "ready", liveUnread: "2" },
  })
  const proof = () => ({ displayEpoch: current.epoch, proofWindowMs: 1000, nextExpiryAt: null })
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    calls.push(request)
    if (request.method !== "GET") throw new Error("Unexpected mutation")
    if (url.pathname.endsWith("/status")) {
      current.statuses++
      if (current.statuses === 2) setContext((value) => ({ ...value }))
      return Response.json({
        facade: "active",
        identity: { uuid: current.account, name: "Self", orgID: 1, orgAllGroupID: "all" },
        blocked: null, keyOrigin: "stored", kernel: "connected",
        reader: { state: "ready", displayEpoch: current.epoch },
      })
    }
    if (url.pathname.endsWith("/groups/page")) {
      const lane = url.searchParams.get("lane")
      return Response.json({
        version: 1, lane, groups: lane === "protected" ? [group()] : [], hasMore: false, nextCursor: null,
        ...(lane === "protected" ? { reader: proof() } : {}),
      })
    }
    if (url.pathname.endsWith("/groups/protected")) return Response.json({ version: 1, group: group(), reader: proof() })
    if (url.pathname.endsWith("/agents")) return Response.json([])
    if (url.pathname.endsWith("/search") || url.pathname.endsWith("/messages")) return Response.json({
      messages: [{ ...message("anchor current body"), id: "anchor-target" }], nextCursor: null, hasMore: false,
      reader: { state: "ready", displayEpoch: current.epoch, projectionRevision: "1", validatedServerNow: 1000, nextExpiryAt: null },
    })
    throw new Error("Unexpected request")
  }))
  render(() => <MemoryRouter><Route path="/" component={() => <SidePanelIM onClose={() => {}} />} /></MemoryRouter>)
  await screen.findByRole("button", { name: /Anchor protected conversation/ })
  await waitFor(() => expect(screen.getByRole("button", { name: dict["im.transport.refresh"] }).hasAttribute("disabled")).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: dict["im.search.messages"] }))
  fireEvent.input(screen.getByPlaceholderText("Search messages…"), { target: { value: "anchor" } })
  fireEvent.click(screen.getByRole("button", { name: "Search" }))
  fireEvent.click(await screen.findByText("anchor current body"))
  await waitFor(() => expect(Socket.instances).toHaveLength(1))
  Socket.instances[0].open()
  await screen.findByText("anchor current body")
  expect(calls.filter((request) => new URL(request.url).pathname.endsWith("/messages"))
    .every((request) => new URL(request.url).searchParams.get("anchorID") === "anchor-target")).toBe(true)
  expect(screen.getByText(dict["im.message.location.context"])).toBeTruthy()
  expect(attached).toHaveBeenCalledTimes(1)
  const scope = runtime.client.scope()
  await imSummaryOwner.refresh()
  await waitFor(() => expect(current.statuses).toBeGreaterThanOrEqual(2))
  await waitFor(() => expect(screen.getAllByRole("button", { name: dict["im.transport.refresh"] }).every((button) => !button.hasAttribute("disabled"))).toBe(true))
  expect(runtime.client.scope()).toBe(scope)
  expect(screen.queryByText(dict["im.message.location.context"])).not.toBeNull()
  expect(screen.getByRole("button", { name: dict["im.message.location.latest"] })).toBeTruthy()
  expect(screen.getByText("anchor current body")).toBeTruthy()
  expect(attached).toHaveBeenCalledTimes(1)
  expect(calls.filter((request) => new URL(request.url).pathname.endsWith("/messages"))
    .every((request) => new URL(request.url).searchParams.get("anchorID") === "anchor-target")).toBe(true)
  current.account = "anchor-owner-replacement"
  vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1001)
  await imSummaryOwner.refresh()
  await waitFor(() => expect(current.statuses).toBeGreaterThanOrEqual(3))
  await waitFor(() => expect(screen.queryByText(dict["im.message.location.context"])).toBeNull())
  expect(screen.queryByText("anchor current body")).toBeNull()
  expect(calls.every((request) => request.method === "GET")).toBe(true)
})
