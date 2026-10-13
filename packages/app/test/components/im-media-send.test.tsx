import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { dict } from "@/i18n/en"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { File } from "node:buffer"
import { createHash } from "node:crypto"

const fixture = vi.hoisted(() => ({ directory: "", pending: new Set<Promise<unknown>>() }))
vi.mock("@/utils/im-media-intent", async () => {
  // Load the actual sibling disk store at test runtime without adding TUI source to
  // the app's composite build. Browser IndexedDB is verified separately in Chrome.
  const sibling = "../../../tui/src/util/im-media-intent"
  const { createMediaIntentStore, createMediaBatchStore } = (await import(/* @vite-ignore */ sibling)) as {
    createMediaIntentStore(
      directory: string,
    ): Pick<ReturnType<typeof import("@/utils/im-media-intent").createMediaIntentStore>, "list" | "put" | "discard">
    createMediaBatchStore(
      directory: string,
    ): Pick<ReturnType<typeof import("@/utils/im-media-intent").createMediaBatchStore>, "list" | "put" | "discard">
  }
  return {
    createMediaBatchStore: () => ({ ...createMediaBatchStore(fixture.directory), close() {} }),
    createMediaIntentStore: () => {
      const store = createMediaIntentStore(fixture.directory)
      return {
        ...store,
        put: (...args: Parameters<typeof store.put>) => {
          const operation = store.put(...args)
          fixture.pending.add(operation)
          void operation.finally(() => fixture.pending.delete(operation)).catch(() => undefined)
          return operation
        },
        close() {},
      }
    },
  }
})

const api = vi.hoisted(() => ({
  listMessages: vi.fn(),
  listAgents: vi.fn(),
  markRead: vi.fn(),
  uploadAttachment: vi.fn(),
  createMessage: vi.fn(),
  getAttachment: vi.fn(),
  scope: vi.fn(),
  listGroups: vi.fn(),
  getGroup: vi.fn(),
  facadeStatus: vi.fn(),
  mediaEnabled: vi.fn(),
}))
const toast = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => api,
  createIMClient: () => api,
}))
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
const createdAt = Date.now()
const attachment = {
  id: "ima_fixture",
  workspaceID: "fixture",
  projectID: null,
  groupID: "group",
  messageID: null,
  uploadedBy: "server",
  filename: "fixture.txt",
  mime: "application/octet-stream",
  sizeBytes: 7,
  checksum: createHash("sha256").update("fixture").digest("hex"),
  preview: false,
  createdAt,
  expiresAt: createdAt + 86_400_000,
}
beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-app-media-store-"))
  Object.values(api).forEach((method) => method.mockReset())
  toast.showToast.mockReset()
  api.listMessages.mockResolvedValue({ messages: [], hasMore: false, nextCursor: null })
  api.listAgents.mockResolvedValue([])
  api.markRead.mockResolvedValue({ ok: true })
  api.uploadAttachment.mockResolvedValue(attachment)
  api.getAttachment.mockResolvedValue(attachment)
  api.scope.mockReturnValue({ url: "http://127.0.0.1:4242", directory: "/fixture" })
  api.listGroups.mockResolvedValue([
    { id: "group", workspaceID: "fixture", kernelConvID: null },
    { id: "new-group", workspaceID: "fixture", kernelConvID: null },
  ])
  api.getGroup.mockImplementation(async (id: string) => ({
    version: 1,
    group: { id, workspaceID: "fixture", kernelConvID: null },
  }))
  api.facadeStatus.mockResolvedValue({ viewer: { memberID: "server" } })
  api.mediaEnabled.mockResolvedValue(true)
})
afterEach(async () => {
  cleanup()
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.allSettled([...fixture.pending])
  }
  await fs.rm(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

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
  await screen.findByRole("button", { name: `${dict["im.media.batch.remove"]} fixture.txt` })
  expect(api.createMessage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["im.composer.send"] }))
  const retry = await screen.findByRole("button", { name: dict["im.media.retry"] })
  await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: dict["im.media.retry"] }))
  await waitFor(() => expect(api.createMessage).toHaveBeenCalledTimes(2))
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
    expect.any(AbortSignal),
  ])
  await waitFor(() => expect(screen.queryByRole("button", { name: dict["im.media.retry"] })).toBeNull())
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
  await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(1))
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
  await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(1))
  if (action === "switch") setGroup("new-group")
  if (action === "close") view.unmount()
  pending.reject(new Error("late upload failure"))
  await pending.promise.catch(() => undefined)
  await vi.dynamicImportSettled()
  expect(toast.showToast).not.toHaveBeenCalled()
  expect(api.createMessage).not.toHaveBeenCalled()
})
