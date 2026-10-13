import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { MessageItem } from "@/components/im/message-item"
import { createIMClient, type IMClient } from "@/utils/im-client"
import type { IMMessage } from "@/components/im/types"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({ client: undefined as IMClient | undefined }))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => runtime.client!,
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))

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
  emit(message: IMMessage) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "message_created", data: message }) }))
  }
}
const message = (id: string, state?: NonNullable<IMMessage["transport"]>["state"], reason?: string): IMMessage => ({
  id,
  groupID: "group",
  senderID: "server",
  senderType: "user",
  type: "text",
  content: `body ${id}`,
  mentions: null,
  metadata: null,
  replyToID: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  ...(state ? { transport: { state, ...(reason ? { reason } : {}) } } : {}),
})
const page = (messages: IMMessage[]) => Response.json({ messages, nextCursor: "older", hasMore: true })
let requests: Request[]
let read: (request: Request) => Promise<Response>
let post: (request: Request) => Promise<Response>

beforeEach(() => {
  requests = []
  Socket.instances = []
  vi.stubGlobal("WebSocket", Socket)
  read = async () => page([message("initial", "prepared")])
  post = async () => Response.json(message("sent", "acknowledged"))
  runtime.client = createIMClient(() => ({ url: "http://old.test", directory: "/private/old", password: "secret-old" }))
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (new URL(request.url).pathname.endsWith("/agents")) return Response.json([])
      if (new URL(request.url).pathname.endsWith("/read")) return Response.json({ ok: true })
      return request.method === "GET" ? read(request) : post(request)
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const refresh = () => screen.getByRole("button", { name: dict["im.transport.refresh"] })
async function mount() {
  const view = render(() => <GroupChatPanel groupID="group" />)
  await screen.findByText("body initial")
  await waitFor(() => expect(requests.some((r) => new URL(r.url).pathname.endsWith("/read"))).toBe(true))
  requests.length = 0
  return view
}

it("distinguishes local waiting, service ACK and unknown without rendering private reasons or read claims", () => {
  render(() => (
    <>
      <MessageItem message={message("a", "prepared")} />
      <MessageItem message={message("b", "acknowledged")} />
      <MessageItem message={message("c", "unknown", "secret-token=never-render")} />
      <MessageItem message={message("local")} />
    </>
  ))
  expect(screen.getByText(dict["im.transport.prepared"])).toBeTruthy()
  expect(screen.getByText(dict["im.transport.acknowledged"])).toBeTruthy()
  expect(screen.getByText(dict["im.transport.acknowledgedHint"])).toBeTruthy()
  expect(screen.getByText(dict["im.transport.reason.unknown"])).toBeTruthy()
  expect(document.body.textContent).not.toContain("secret-token")
  expect(document.querySelectorAll("[data-im-transport]")).toHaveLength(3)
})

it("refresh is one bounded GET, single-flight, and performs no send/read write or history scan", async () => {
  await mount()
  const pending = Promise.withResolvers<Response>()
  read = () => pending.promise
  fireEvent.click(refresh())
  const busy = screen.getByRole("button", { name: dict["im.transport.refreshing"] })
  fireEvent.click(busy)
  expect(requests).toHaveLength(1)
  expect(requests[0].method).toBe("GET")
  expect(new URL(requests[0].url).searchParams.get("limit")).toBe("50")
  expect(new URL(requests[0].url).searchParams.has("cursor")).toBe(false)
  pending.resolve(page([message("initial", "acknowledged")]))
  await screen.findByText(dict["im.transport.acknowledged"])
  expect(requests).toHaveLength(1)
  expect(screen.getByRole("button", { name: dict["im.message.older"] })).toBeTruthy()
})

it("late history and WS echoes cannot replace a newer HTTP ACK; a new authoritative read may report a mismatch", async () => {
  await mount()
  const delayed = Promise.withResolvers<Response>()
  read = () => delayed.promise
  fireEvent.click(refresh())
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "send this" } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  await screen.findByText(dict["im.transport.acknowledged"])
  Socket.instances[0].emit(message("sent", "prepared"))
  delayed.resolve(page([message("sent", "unknown", "delivery_outcome_unknown")]))
  await waitFor(() => expect(refresh()).toBeTruthy())
  expect(screen.getByText(dict["im.transport.acknowledged"])).toBeTruthy()
  requests.length = 0
  read = async () => page([message("sent", "unknown", "receipt_mismatch")])
  fireEvent.click(refresh())
  await screen.findByText(dict["im.transport.reason.mismatch"])
  Socket.instances[0].emit(message("sent", "acknowledged"))
  expect(screen.queryByText(dict["im.transport.acknowledged"])).toBeNull()
  expect(requests.filter((r) => r.method !== "GET")).toHaveLength(0)
})

it("scope change aborts old reads and old callbacks cannot populate the same group under a new identity", async () => {
  const [scope, setScope] = createStore({
    url: "http://old.test",
    directory: "/old",
    password: "old",
    identity: "old-id",
  })
  runtime.client = createIMClient(() => ({ url: scope.url, directory: scope.directory, password: scope.password }))
  render(() => <GroupChatPanel groupID="group" selfMemberIDs={[scope.identity]} />)
  await screen.findByText("body initial")
  const delayed = Promise.withResolvers<Response>()
  read = () => delayed.promise
  fireEvent.click(refresh())
  const previous = requests.at(-1)!
  const oldCallback = Socket.instances[0].onmessage
  read = async () => page([message("new-person", "unknown")])
  setScope({ url: "http://new.test", directory: "/new", password: "new", identity: "new-id" })
  await screen.findByText("body new-person")
  expect(previous.signal.aborted).toBe(true)
  delayed.resolve(page([message("old-secret", "acknowledged")]))
  oldCallback?.(
    new MessageEvent("message", { data: JSON.stringify({ type: "message_created", data: message("old-echo") }) }),
  )
  await Promise.resolve()
  expect(screen.queryByText("body initial")).toBeNull()
  expect(screen.queryByText("body old-secret")).toBeNull()
  expect(screen.queryByText("body old-echo")).toBeNull()
  const active = requests.find((request) => request.url.startsWith("http://new.test") && request.method === "GET")!
  const header = active.headers.get("x-deepagent-code-directory")!
  // InstanceContext decodes this header once; a double-encoded value cannot select this scope.
  expect(header).toBe(encodeURIComponent(scope.directory))
  expect(decodeURIComponent(header)).toBe(scope.directory)
  expect(decodeURIComponent(encodeURIComponent(header))).not.toBe(scope.directory)
  expect(active.headers.get("authorization")).not.toBe(previous.headers.get("authorization"))
})

it("deadline and unmount cancel observation without clearing messages or scheduling polling", async () => {
  const view = await mount()
  vi.useFakeTimers()
  read = (request) =>
    new Promise((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    )
  fireEvent.click(refresh())
  await vi.advanceTimersByTimeAsync(10_000)
  expect(screen.getByText(dict["im.transport.refreshFailed"])).toBeTruthy()
  expect(screen.getByText("body initial")).toBeTruthy()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(requests).toHaveLength(1)
  fireEvent.click(refresh())
  const pending = requests.at(-1)!
  view.unmount()
  expect(pending.signal.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(requests).toHaveLength(2)
})

it("creation broadcast arriving before the HTTP response does not suppress its transport receipt", async () => {
  await mount()
  const pending = Promise.withResolvers<Response>()
  post = () => pending.promise
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "new reply" } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  Socket.instances[0].emit(message("sent", "prepared"))
  await screen.findByText("body sent")
  pending.resolve(Response.json(message("sent", "acknowledged")))
  await screen.findByText(dict["im.transport.acknowledged"])
  expect(
    requests.filter((request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/messages")),
  ).toHaveLength(1)
})

it("a GET observing the prepared row while POST is pending cannot suppress the later actual ACK", async () => {
  await mount()
  const pending = Promise.withResolvers<Response>()
  post = () => pending.promise
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "new reply" } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  read = async () => page([message("sent", "prepared")])
  fireEvent.click(refresh())
  await screen.findByText("body sent")
  pending.resolve(Response.json(message("sent", "acknowledged")))
  await screen.findByText(dict["im.transport.acknowledged"])
  expect(
    requests.filter((request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/messages")),
  ).toHaveLength(1)
})
