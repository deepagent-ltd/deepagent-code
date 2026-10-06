import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { dict } from "@/i18n/en"

const api = vi.hoisted(() => ({
  listMessages: vi.fn(),
  listAgents: vi.fn(),
  markRead: vi.fn(),
  uploadAttachment: vi.fn(),
  createMessage: vi.fn(),
  getAttachment: vi.fn(),
}))
const toast = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock("@/utils/im-client", () => ({ useIMClient: () => api }))
vi.mock("@/utils/toast", () => toast)
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
  useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }),
}))
const attachment = {
  id: "ima_fixture",
  workspaceID: "fixture",
  projectID: null,
  groupID: "group",
  messageID: null,
  uploadedBy: "server",
  filename: "fixture.txt",
  mime: "text/plain",
  sizeBytes: 7,
  checksum: "verified-by-service",
  preview: false,
  createdAt: 1000,
  expiresAt: Date.now() + 60_000,
}
beforeEach(() => {
  Object.values(api).forEach((method) => method.mockReset())
  toast.showToast.mockReset()
  api.listMessages.mockResolvedValue({ messages: [], hasMore: false, nextCursor: null })
  api.listAgents.mockResolvedValue([])
  api.markRead.mockResolvedValue({ ok: true })
  api.uploadAttachment.mockResolvedValue(attachment)
  api.getAttachment.mockResolvedValue(attachment)
})
afterEach(cleanup)

it("retries a lost file-message receipt with the same attachment and request ID without reuploading", async () => {
  api.createMessage.mockRejectedValueOnce(new Error("receipt lost")).mockResolvedValueOnce({
    id: "message",
    groupID: "group",
    senderID: "server",
    senderType: "user",
    type: "file",
    content: "fixture.txt",
    metadata: { type: "attachment_ref", attachmentID: attachment.id },
    mentions: null,
    replyToID: null,
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
  })
  const view = render(() => <GroupChatPanel groupID="group" fileUploadEnabled />)
  await screen.findByRole("button", { name: dict["im.composer.attach"] })
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error("Missing real file input")
  fireEvent.change(input, { target: { files: [new File(["fixture"], "fixture.txt")] } })
  const retry = await screen.findByRole("button", { name: dict["im.media.retry"] })
  await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false))
  fireEvent.click(retry)
  await screen.findByRole("article")
  expect(api.uploadAttachment).toHaveBeenCalledTimes(1)
  expect(api.createMessage).toHaveBeenCalledTimes(2)
  expect(api.createMessage.mock.calls[1]).toEqual(api.createMessage.mock.calls[0])
  expect(api.createMessage.mock.calls[0]).toEqual([
    "group",
    {
      type: "file",
      content: "fixture.txt",
      attachmentID: attachment.id,
      clientRequestID: expect.any(String),
    },
  ])
  expect(screen.queryByRole("button", { name: dict["im.media.retry"] })).toBeNull()
})

it("does not send a late upload into a different conversation", async () => {
  const pending = Promise.withResolvers<typeof attachment>()
  api.uploadAttachment.mockReturnValueOnce(pending.promise)
  const [group, setGroup] = createSignal("group")
  const view = render(() => <GroupChatPanel groupID={group()} fileUploadEnabled />)
  await screen.findByRole("button", { name: dict["im.composer.attach"] })
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error("Missing real file input")
  fireEvent.change(input, { target: { files: [new File(["fixture"], "fixture.txt")] } })
  setGroup("new-group")
  pending.resolve(attachment)
  await pending.promise
  await screen.findByRole("button", { name: dict["im.composer.attach"] })
  expect(api.uploadAttachment).toHaveBeenCalledTimes(1)
  expect(api.createMessage).not.toHaveBeenCalled()
  expect(screen.queryByRole("button", { name: dict["im.media.retry"] })).toBeNull()
})

it.each(["switch", "close"])("does not toast a late upload rejection after conversation %s", async (action) => {
  const pending = Promise.withResolvers<typeof attachment>()
  api.uploadAttachment.mockReturnValueOnce(pending.promise)
  const [group, setGroup] = createSignal("group")
  const view = render(() => <GroupChatPanel groupID={group()} fileUploadEnabled />)
  await screen.findByRole("button", { name: dict["im.composer.attach"] })
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error("Missing real file input")
  fireEvent.change(input, { target: { files: [new File(["fixture"], "fixture.txt")] } })
  if (action === "switch") setGroup("new-group")
  if (action === "close") view.unmount()
  pending.reject(new Error("late upload failure"))
  await pending.promise.catch(() => undefined)
  await vi.dynamicImportSettled()
  expect(toast.showToast).not.toHaveBeenCalled()
  expect(api.createMessage).not.toHaveBeenCalled()
})
