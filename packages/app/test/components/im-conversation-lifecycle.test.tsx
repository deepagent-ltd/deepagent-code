import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, Show } from "solid-js"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { ThreadView } from "@/components/im/thread-view"
import { MessageList } from "@/components/im/message-list"
import { createComposerDrafts } from "@/components/im/composer-draft"
import type { LocalMessage } from "@/hooks/use-im-websocket"
import { dict } from "@/i18n/en"

const client = vi.hoisted(() => ({
  scope: vi.fn(),
  listMessages: vi.fn(),
  listThread: vi.fn(),
  listAgents: vi.fn(),
  markRead: vi.fn(),
  createMessage: vi.fn(),
}))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => client,
  createIMClient: () => client,
}))
vi.mock("@/hooks/use-im-websocket", () => ({
  useIMWebSocket: () => ({
    connected: () => false,
    messages: () => [],
    agentStatuses: () => new Map(),
    agentProgress: () => new Map(),
    typingMembers: () => new Set(),
    send: vi.fn(),
    reconnect: vi.fn(),
  }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))

const message = (id: string, groupID = "a"): LocalMessage => ({
  id,
  groupID,
  content: id,
  senderID: "bob",
  senderType: "user",
  type: "text",
  mentions: null,
  metadata: null,
  replyToID: null,
  createdAt: 1000,
  updatedAt: 1000,
  deletedAt: null,
})
const page = (messages: LocalMessage[], nextCursor: string | null = null) => ({
  messages,
  nextCursor,
  hasMore: !!nextCursor,
})

beforeEach(async () => {
  Object.values(client).forEach((fn) => fn.mockReset())
  const { createIMClient } = await vi.importActual<typeof import("@/utils/im-client")>("@/utils/im-client")
  const actual = createIMClient(() => ({
    url: "http://fixture.test",
    directory: "/private/fixture",
    password: "fixture",
  }))
  client.scope.mockImplementation(actual.scope)
  client.listMessages.mockResolvedValue(page([]))
  client.listThread.mockResolvedValue(page([]))
  client.listAgents.mockResolvedValue([])
  client.markRead.mockResolvedValue({ ok: true })
})
afterEach(cleanup)

it("keeps pending drafts and retry identity with their conversation through list navigation", async () => {
  const [group, select] = createSignal<string | null>("a")
  const drafts = createComposerDrafts()
  const pending = Promise.withResolvers<LocalMessage>()
  client.createMessage.mockReturnValueOnce(pending.promise)
  render(() => <Show when={group()}>{(id) => <GroupChatPanel groupID={id()} name={id()} drafts={drafts} />}</Show>)
  await screen.findByRole("heading", { name: "a" })
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "甲的发送草稿" } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  const requestID = client.createMessage.mock.calls[0][1].clientRequestID
  select(null)
  select("b")
  await screen.findByRole("heading", { name: "b" })
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("")
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "乙的未发送草稿" } })
  pending.reject(new Error("lost acknowledgment"))
  await waitFor(() => expect(drafts("a").state.failed).toBe(true))
  expect(screen.queryByRole("alert")).toBeNull()
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("乙的未发送草稿")
  select(null)
  select("a")
  await screen.findByRole("alert")
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("甲的发送草稿")
  client.createMessage.mockResolvedValue(message("accepted"))
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  await screen.findByText("accepted")
  expect(client.createMessage.mock.calls[1]).toEqual([
    "a",
    { content: "甲的发送草稿", type: "text", clientRequestID: requestID },
  ])
  select("b")
  await screen.findByRole("heading", { name: "b" })
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("乙的未发送草稿")
})

it("ignores a previous visit's history even after switching back to the same conversation", async () => {
  const [group, select] = createSignal("a")
  const stale = Promise.withResolvers<ReturnType<typeof page>>()
  client.listMessages.mockReturnValueOnce(stale.promise)
  render(() => <GroupChatPanel groupID={group()} name={group()} />)
  select("b")
  await screen.findByRole("heading", { name: "b" })
  client.listMessages.mockResolvedValue(page([message("current history")]))
  select("a")
  await screen.findByText("current history")
  stale.resolve(page([message("stale history")]))
  await Promise.resolve()
  expect(screen.queryByText("stale history")).toBeNull()
  expect(screen.getByText("current history")).toBeTruthy()
})

it("isolates thread history and drafts when the selected root changes", async () => {
  const [root, select] = createSignal(message("root-a"))
  const stale = Promise.withResolvers<ReturnType<typeof page>>()
  client.listThread.mockReturnValueOnce(stale.promise)
  render(() => <ThreadView groupID="a" root={root()} agents={[]} onClose={() => {}} />)
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "甲线程草稿" } })
  select(message("root-b"))
  await waitFor(() => expect(client.listThread).toHaveBeenCalledWith("a", "root-b", 50, undefined))
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("")
  stale.resolve(page([message("reply for root-a")]))
  await Promise.resolve()
  expect(screen.queryByText("reply for root-a")).toBeNull()
  select(message("root-a"))
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("甲线程草稿")
})

it("preserves a thread send receipt when an older snapshot arrives and retries failed pagination", async () => {
  const snapshot = Promise.withResolvers<ReturnType<typeof page>>()
  client.listThread.mockReturnValueOnce(snapshot.promise)
  client.createMessage.mockResolvedValue(message("acknowledged reply"))
  render(() => <ThreadView groupID="a" root={message("root-a")} agents={[]} onClose={() => {}} />)
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "acknowledged reply" } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  await screen.findByText("acknowledged reply")
  snapshot.resolve(page([message("older reply")], "cursor-1"))
  await screen.findByText("older reply")
  expect(screen.getAllByText("acknowledged reply")).toHaveLength(1)
  client.listThread.mockRejectedValueOnce(new Error("temporary history failure"))
  fireEvent.click(screen.getByRole("button", { name: "Load more replies" }))
  await screen.findByRole("alert")
  client.listThread.mockResolvedValue(page([message("older reply"), message("next reply")]))
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  await screen.findByText("next reply")
  expect(client.listThread.mock.calls.slice(-2)).toEqual([
    ["a", "root-a", 50, "cursor-1"],
    ["a", "root-a", 50, "cursor-1"],
  ])
  expect(screen.getAllByText("older reply")).toHaveLength(1)
  expect(screen.queryByRole("alert")).toBeNull()
})

it("preserves the visible message after prepend and counts only newly appended messages", async () => {
  const original = Array.from({ length: 6 }, (_, index) => message(`existing-${index}`))
  const [messages, update] = createSignal(original)
  const [loading, setLoading] = createSignal(false)
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = messages().findIndex((row) => row.id === this.dataset.imMessage)
    const scroll = this.closest('[role="log"]')?.scrollTop ?? 0
    return new DOMRect(0, index < 0 ? 0 : index * 40 - scroll, 240, index < 0 ? 100 : 40)
  })
  render(() => (
    <MessageList
      messages={messages()}
      agentStatuses={new Map()}
      agentProgress={new Map()}
      onLoadOlder={() => setLoading(true)}
      loadingOlder={loading()}
    />
  ))
  const log = screen.getByRole("log")
  Object.defineProperty(log, "scrollHeight", { get: () => messages().length * 40 })
  Object.defineProperty(log, "clientHeight", { value: 100 })
  await Promise.resolve()
  log.scrollTop = 100
  fireEvent.scroll(log)
  const visible = log.querySelector<HTMLElement>('[data-im-message="existing-2"]')!
  const offset = visible.getBoundingClientRect().top
  fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }))
  update([message("older-1"), message("older-2"), ...original, message("new reply")])
  setLoading(false)
  await waitFor(() => expect(log.scrollTop).toBe(180))
  expect(visible.getBoundingClientRect().top).toBe(offset)
  const next = screen.getByRole("button", { name: "1 new messages" })
  fireEvent.click(next)
  expect(screen.queryByRole("button", { name: "1 new messages" })).toBeNull()
})

it("keeps a returning conversation pending and lets its late acknowledgment settle without stealing focus", async () => {
  const [group, select] = createSignal("a")
  const drafts = createComposerDrafts()
  const pending = Promise.withResolvers<LocalMessage>()
  client.createMessage.mockReturnValueOnce(pending.promise)
  render(() => <GroupChatPanel groupID={group()} name={group()} drafts={drafts} />)
  await screen.findByRole("heading", { name: "a" })
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "pending in a" } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  select("b")
  await screen.findByRole("heading", { name: "b" })
  select("a")
  await screen.findByRole("heading", { name: "a" })
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true)
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
  expect(client.createMessage).toHaveBeenCalledTimes(1)
  select("b")
  await screen.findByRole("heading", { name: "b" })
  const input = screen.getByRole("textbox") as HTMLTextAreaElement
  fireEvent.input(input, { target: { value: "keep b's input" } })
  input.focus()
  pending.resolve(message("a's acknowledgment"))
  await waitFor(() => expect(drafts("a").state.sending).toBe(false))
  expect(drafts("a").state.content).toBe("")
  expect(input.value).toBe("keep b's input")
  expect(document.activeElement).toBe(input)
  expect(screen.queryByText("a's acknowledgment")).toBeNull()
})

it("uses an explicit parent refresh increment without firing on mount or duplicating the owned header action", async () => {
  const [request, setRequest] = createSignal(7)
  render(() => <GroupChatPanel groupID="a" headerOwned refreshRequest={request()} />)
  await screen.findByRole("textbox")
  expect(client.listMessages).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole("button", { name: dict["im.transport.refresh"] })).toBeNull()
  setRequest(8)
  await waitFor(() => expect(client.listMessages).toHaveBeenCalledTimes(2))
  setRequest(8)
  await Promise.resolve()
  expect(client.listMessages).toHaveBeenCalledTimes(2)
})
