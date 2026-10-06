import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { dict } from "@/i18n/en"
import type { LocalMessage } from "@/hooks/use-im-websocket"

const client = vi.hoisted(() => ({
  facadeStatus: vi.fn(),
  listGroups: vi.fn(),
  listMessages: vi.fn(),
  listThread: vi.fn(),
  listAgents: vi.fn(),
  markRead: vi.fn(),
}))
vi.mock("@/utils/im-client", () => ({ useIMClient: () => client }))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: {} }) }))
vi.mock("@/components/im/capabilities", () => ({ fetchIMCapabilities: async () => ({ v4ThreadEnabled: true }) }))
vi.mock("@/components/im/message-search", () => ({ MessageSearch: () => <div>Search</div> }))
vi.mock("@/utils/toast", () => ({ showToast: vi.fn() }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn() }) }))
vi.mock("@/hooks/use-im-websocket", () => ({
  useIMWebSocket: () => ({
    connected: () => false,
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

const message = (id: string, senderID: string, senderType = "user"): LocalMessage => ({
  id,
  groupID: "conversation",
  senderID,
  senderType,
  type: "text",
  content: id,
  mentions: null,
  metadata: null,
  replyToID: null,
  createdAt: 1000,
  updatedAt: 1000,
  deletedAt: null,
})
const page = (messages: LocalMessage[]) => ({ messages, hasMore: false, nextCursor: null })

beforeEach(() => {
  Object.values(client).forEach((fn) => fn.mockReset())
  client.facadeStatus.mockResolvedValue({
    facade: "active",
    identity: { uuid: "alice-uuid", name: "alice", orgID: 2, orgAllGroupID: "org2" },
    blocked: null,
    kernel: "connected",
    keyOrigin: "stored",
  })
  client.listAgents.mockResolvedValue([])
  client.markRead.mockResolvedValue({ ok: true })
  client.listMessages.mockResolvedValue(
    page([
      message("peer message", "bob-uuid"),
      message("own message", "alice-uuid"),
      message("unknown message", "other-uuid"),
      message("agent message", "bob-uuid", "agent"),
    ]),
  )
  client.listThread.mockResolvedValue(page([message("peer reply", "bob-uuid")]))
})
afterEach(cleanup)

it("uses the verified direct peer's name through the panel, history, and thread without renaming other senders", async () => {
  client.listGroups.mockResolvedValue([
    { id: "conversation", name: "Bob", type: "direct", kernelConvID: "k:1:bob-uuid" },
  ])
  render(() => <SidePanelIM onClose={vi.fn()} />)
  fireEvent.click(await screen.findByRole("button", { name: /Bob/ }))
  const peer = await screen.findByRole("article", { name: "Message from Bob" })
  expect(within(peer).getByTitle("bob-uuid").textContent).toBe("Bob")
  expect(screen.getByRole("article", { name: "Message from You" })).toBeTruthy()
  expect(screen.getByRole("article", { name: "Message from other-uuid" })).toBeTruthy()
  expect(screen.getByRole("article", { name: "Message from bob-uuid" }).textContent).toContain("agent message")
  fireEvent.click(within(peer).getByRole("button", { name: dict["im.thread.reply"] }))
  const thread = await screen.findByRole("region", { name: dict["im.thread.title"] })
  await within(thread).findByText("peer reply")
  expect(within(thread).getAllByRole("article", { name: "Message from Bob" })).toHaveLength(2)
})

it.each([
  { type: "project", kernelConvID: "k:2:bob-uuid" },
  { type: "project", kernelConvID: "k:1:bob-uuid" },
  { type: "direct", kernelConvID: null },
  { type: "direct", kernelConvID: "k:1:" },
  { type: "direct", kernelConvID: "k:1:different-peer" },
])("preserves sender IDs without an exact direct peer binding (%j)", async (binding) => {
  client.listGroups.mockResolvedValue([{ id: "conversation", name: "Bob", ...binding }])
  render(() => <SidePanelIM onClose={vi.fn()} />)
  fireEvent.click(await screen.findByRole("button", { name: /Bob/ }))
  await screen.findByText("peer message")
  expect(screen.queryByRole("article", { name: "Message from Bob" })).toBeNull()
  expect(screen.getAllByRole("article", { name: "Message from bob-uuid" })).toHaveLength(2)
})
