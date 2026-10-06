import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { MessageComposer } from "@/components/im/message-composer"
import { MessageItem } from "@/components/im/message-item"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { dict } from "@/i18n/en"

const client = vi.hoisted(() => ({
  listMessages: vi.fn(),
  listAgents: vi.fn(),
  markRead: vi.fn(),
  createMessage: vi.fn(),
}))
const socket = vi.hoisted(() => ({ connected: (): boolean => false, connect: (_value: boolean) => {} }))
vi.mock("@/utils/im-client", () => ({ useIMClient: () => client }))
vi.mock("@/hooks/use-im-websocket", () => ({
  useIMWebSocket: () => ({
    connected: () => socket.connected(),
    messages: () => [],
    agentStatuses: () => new Map(),
    agentProgress: () => new Map(),
    typingMembers: () => new Set(),
    send: vi.fn(),
  }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))

beforeEach(() => {
  const connection = createSignal(false)
  socket.connected = connection[0]
  socket.connect = connection[1]
  Object.values(client).forEach((fn) => fn.mockReset())
  client.listAgents.mockResolvedValue([])
  client.markRead.mockResolvedValue({ ok: true })
  client.listMessages.mockResolvedValue({ messages: [], hasMore: false, nextCursor: null })
})
afterEach(cleanup)

const message = (senderID: string, content = "hello") => ({
  id: "message-1",
  groupID: "group-1",
  senderID,
  senderType: "user",
  type: "text",
  content,
  mentions: null,
  metadata: null,
  replyToID: null,
  createdAt: 1000,
  updatedAt: 1000,
  deletedAt: null,
})

describe("IM text conversations", () => {
  it("keeps the draft on failure and clears it only after an acknowledged retry", async () => {
    const pending = Promise.withResolvers<void>()
    const send = vi.fn().mockReturnValue(pending.promise)
    render(() => <MessageComposer onSend={send} agents={[]} />)
    const input = screen.getByRole("textbox")
    fireEvent.input(input, { target: { value: "中文草稿" } })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(send).toHaveBeenCalledTimes(1)
    expect((input as HTMLTextAreaElement).value).toBe("中文草稿")
    pending.reject(new Error("temporary failure"))
    await screen.findByRole("alert")
    expect((input as HTMLTextAreaElement).value).toBe("中文草稿")
    send.mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole("button", { name: dict["im.composer.send"] }))
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""))
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][1]).toBe(send.mock.calls[0][1])
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("can send an unknown mention and preserves Shift+Enter for a newline", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    render(() => <MessageComposer onSend={send} agents={[]} />)
    const input = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: "@unknown" } })
    input.setSelectionRange(8, 8)
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(send).toHaveBeenCalledWith("@unknown", expect.any(String)))
  })

  it("creates a new request identity when mention completion edits a failed draft", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("unconfirmed delivery")).mockResolvedValue(undefined)
    render(() => (
      <MessageComposer onSend={send} agents={[{ id: "auto", name: "auto", displayName: "Auto", visible: true }]} />
    ))
    const input = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: "@a" } })
    input.setSelectionRange(2, 2)
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await screen.findByRole("alert")
    fireEvent.click(screen.getByRole("button", { name: "@auto" }))
    expect(input.value).toBe("@auto ")
    expect(screen.queryByRole("alert")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(input.value).toBe(""))
    expect(send.mock.calls[1][0]).toBe("@auto ")
    expect(send.mock.calls[1][1]).not.toBe(send.mock.calls[0][1])
  })

  it("labels only the current member as You, retaining the remote sender identity", () => {
    render(() => (
      <>
        <MessageItem message={message("bob-uuid")} selfMemberIDs={["server", "alice-uuid"]} />
        <MessageItem message={{ ...message("alice-uuid"), id: "own" }} selfMemberIDs={["server", "alice-uuid"]} />
      </>
    ))
    expect(screen.getByRole("article", { name: "Message from bob-uuid" })).toBeTruthy()
    expect(screen.getAllByRole("article", { name: "Message from You" })).toHaveLength(1)
  })

  it("renders the HTTP receipt while realtime delivery is disconnected", async () => {
    client.createMessage.mockResolvedValue(message("server", "HTTP receipt"))
    render(() => <GroupChatPanel groupID="group-1" name="Design team" selfMemberIDs={["server"]} />)
    await screen.findByRole("heading", { name: "Design team" })
    const input = screen.getByRole("textbox")
    fireEvent.input(input, { target: { value: "HTTP receipt" } })
    fireEvent.click(screen.getByRole("button", { name: dict["im.composer.send"] }))
    await screen.findByText("HTTP receipt")
    expect(screen.getAllByRole("article", { name: "Message from You" })).toHaveLength(1)
    expect((input as HTMLTextAreaElement).value).toBe("")
    expect(client.createMessage).toHaveBeenCalledWith("group-1", {
      content: "HTTP receipt",
      type: "text",
      clientRequestID: expect.any(String),
    })
  })

  it("recovers a multi-page gap even when a newer HTTP receipt is already visible", async () => {
    const messages = Array.from({ length: 152 }, (_, index) => ({
      ...message("bob", `message ${index}`),
      id: `message-${index}`,
      createdAt: index + 1,
    }))
    client.listMessages.mockResolvedValueOnce({
      messages: messages.slice(0, 2).reverse(),
      hasMore: false,
      nextCursor: null,
    })
    client.createMessage.mockResolvedValue({ ...messages[151], senderID: "server", content: "new local reply" })
    render(() => <GroupChatPanel groupID="group-1" selfMemberIDs={["server"]} />)
    await screen.findByText("message 0")
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "new local reply" } })
    fireEvent.click(screen.getByRole("button", { name: dict["im.composer.send"] }))
    await screen.findByText("new local reply")
    client.listMessages.mockImplementation(async (_group: string, _limit: number, cursor?: string) => {
      const end = cursor ? Number(cursor) : messages.length
      const start = Math.max(0, end - 50)
      return {
        messages: messages.slice(start, end).reverse(),
        hasMore: start > 0,
        nextCursor: start > 0 ? String(start) : null,
      }
    })
    socket.connect(true)
    await screen.findByText("message 75")
    await screen.findByText("message 2")
    expect(screen.getAllByRole("article")).toHaveLength(152)
    expect(client.listMessages).toHaveBeenCalledWith("group-1", 50, "2")
  })

  it("queues a connection refresh that arrives while the initial snapshot is pending", async () => {
    const initial = Promise.withResolvers<{
      messages: ReturnType<typeof message>[]
      hasMore: boolean
      nextCursor: null
    }>()
    client.listMessages.mockReturnValueOnce(initial.promise)
    client.listMessages.mockResolvedValue({
      messages: [message("bob", "after connection")],
      hasMore: false,
      nextCursor: null,
    })
    render(() => <GroupChatPanel groupID="group-1" />)
    socket.connect(true)
    expect(client.listMessages).toHaveBeenCalledTimes(1)
    initial.resolve({ messages: [], hasMore: false, nextCursor: null })
    await screen.findByText("after connection")
    expect(client.listMessages).toHaveBeenCalledTimes(2)
  })
})
