import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { MessageList } from "@/components/im/message-list"
import { MessageItem } from "@/components/im/message-item"
import type { LocalMessage } from "@/hooks/use-im-websocket"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))
afterEach(cleanup)

function message(id: string, senderType: "user" | "agent" | "system" = "user"): LocalMessage {
  return {
    id,
    groupID: "original-chat",
    senderID: id === "self" ? "server" : id,
    senderType,
    type: "text",
    content: `Original message ${id}`,
    mentions: null,
    metadata: null,
    replyToID: null,
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
  }
}

it("compact proposal controls preserve the original user-message eligibility and callback", () => {
  const messages = [message("self"), message("peer"), message("agent", "agent"), message("system", "system")]
  const propose = vi.fn()
  render(() => (
    <MessageList messages={messages} agentStatuses={new Map()} agentProgress={new Map()} onUseDac={propose} />
  ))
  expect(propose).not.toHaveBeenCalled()
  expect(screen.getAllByRole("button", { name: dict["im.dac.action"] })).toHaveLength(2)
  for (const original of messages.slice(0, 2)) {
    const item = screen.getByRole("article", {
      name: dict["im.message.from"].replace("{{name}}", original.id === "self" ? dict["im.sender.you"] : original.id),
    })
    fireEvent.click(within(item).getByRole("button", { name: dict["im.dac.action"] }))
    expect(propose).toHaveBeenLastCalledWith(original)
    expect(propose.mock.calls.at(-1)?.[0]).toBe(original)
  }
  expect(propose).toHaveBeenCalledTimes(2)
})

it("proposal controls are keyboard reachable and absent when their owner supplies no action", async () => {
  const original = message("self")
  const propose = vi.fn()
  const view = render(() => <MessageItem message={original} onUseDac={propose} />)
  const keyboard = userEvent.setup()
  await keyboard.tab()
  expect(document.activeElement).toBe(screen.getByRole("button", { name: dict["im.dac.action"] }))
  expect(propose).not.toHaveBeenCalled()
  await keyboard.keyboard("{Enter}")
  expect(propose).toHaveBeenCalledOnce()
  expect(propose).toHaveBeenCalledWith(original)
  view.unmount()
  render(() => <MessageItem message={original} />)
  expect(screen.queryByRole("button", { name: dict["im.dac.action"] })).toBeNull()
})

it("the task card keeps its supplied status and opens only through the original message callback", () => {
  const original = {
    ...message("agent", "agent"),
    metadata: {
      type: "agent_run" as const,
      sessionID: "untrusted-session-hint",
      status: "completed_with_an_unusually_long_status",
    },
  }
  const open = vi.fn()
  const view = render(() => <MessageItem message={original} onOpenTaskResult={open} />)
  expect(screen.getByText(dict["im.taskResult.cardTitle"])).toBeDefined()
  expect(screen.getByText(`${dict["im.taskResult.status"]}: ${original.metadata.status}`)).toBeDefined()
  const control = screen.getByRole("button", { name: dict["im.taskResult.view"] })
  control.focus()
  expect(open).not.toHaveBeenCalled()
  fireEvent.click(control)
  expect(open).toHaveBeenCalledOnce()
  expect(open.mock.calls[0][0]).toBe(original)
  view.unmount()
  render(() => <MessageItem message={original} />)
  expect(screen.queryByRole("button", { name: dict["im.taskResult.view"] })).toBeNull()
})

it("a public final offers current-conversation navigation without trusting its advertised Session ID", () => {
  const original = {
    ...message("agent", "agent"),
    metadata: { type: "agent_run" as const, sessionID: "untrusted-session-hint", status: "completed" },
  }
  const open = vi.fn()
  const history = vi.fn()
  render(() => <MessageItem message={original} onOpenConversationSession={open} onOpenTaskResult={history} />)
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.conversationSession"] }))
  expect(open).toHaveBeenCalledWith(original)
  expect(history).not.toHaveBeenCalled()
  expect(screen.queryByText("untrusted-session-hint")).toBeNull()
})
