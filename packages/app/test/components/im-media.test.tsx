import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { MessageItem } from "@/components/im/message-item"
import { AttachmentCard } from "@/components/im/attachment-card"
import type { IMAttachment } from "@/components/im/types"
import type { LocalMessage } from "@/hooks/use-im-websocket"
import { dict } from "@/i18n/en"
const png = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8MsAAAAASUVORK5CYII="),
  (value) => value.charCodeAt(0),
)

const api = vi.hoisted(() => ({ getAttachment: vi.fn(), downloadAttachment: vi.fn() }))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => api,
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))
const attachment = (): IMAttachment => ({
  id: "ima_fixture",
  workspaceID: "fixture",
  projectID: null,
  groupID: "group",
  messageID: "message",
  uploadedBy: "server",
  filename: "image.png",
  mime: "image/png",
  sizeBytes: png.length,
  checksum: "verified-by-service",
  preview: true,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
})
const message = (): LocalMessage => ({
  id: "message",
  groupID: "group",
  senderID: "server",
  senderType: "user",
  type: "file",
  content: "image.png",
  mentions: null,
  metadata: { type: "attachment_ref", attachmentID: "ima_fixture" },
  replyToID: null,
  createdAt: 1000,
  updatedAt: 1000,
  deletedAt: null,
})
beforeEach(() => {
  Object.values(api).forEach((method) => method.mockReset())
  api.getAttachment.mockResolvedValue(attachment())
  api.downloadAttachment.mockResolvedValue(new Blob([png], { type: "image/png" }))
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture")
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("OFF does not load attachment metadata or expose download/preview controls", () => {
  render(() => <MessageItem message={message()} />)
  expect(screen.getByText("image.png")).toBeTruthy()
  expect(screen.queryByRole("button", { name: dict["im.media.download"] })).toBeNull()
  expect(api.getAttachment).not.toHaveBeenCalled()
  expect(api.downloadAttachment).not.toHaveBeenCalled()
})

it("ON previews only explicit verified Blob bytes and releases them when disabled", async () => {
  const [enabled, setEnabled] = createSignal(true)
  render(() => <MessageItem mediaEnabled={enabled()} message={message()} />)
  const preview = await screen.findByRole("button", { name: dict["im.media.preview"] })
  expect(api.downloadAttachment).not.toHaveBeenCalled()
  fireEvent.click(preview)
  const image = await screen.findByRole("img", { name: "image.png" })
  expect(image.getAttribute("src")).toBe("blob:fixture")
  expect(api.getAttachment).toHaveBeenCalledTimes(2)
  expect(api.downloadAttachment).toHaveBeenCalledTimes(1)
  setEnabled(false)
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture"))
  expect(screen.queryByRole("img")).toBeNull()
})

it("never embeds SVG or HTML even if an untrusted descriptor claims preview is available", async () => {
  api.getAttachment.mockResolvedValue({ ...attachment(), mime: "image/svg+xml", preview: true })
  render(() => <MessageItem mediaEnabled message={message()} />)
  await screen.findByRole("button", { name: dict["im.media.download"] })
  expect(screen.queryByRole("button", { name: dict["im.media.preview"] })).toBeNull()
  expect(screen.queryByRole("img")).toBeNull()
  expect(api.downloadAttachment).not.toHaveBeenCalled()
})

it("expires preview URLs and disables actions at the descriptor TTL", async () => {
  const timer = vi.spyOn(globalThis, "setTimeout")
  api.getAttachment.mockResolvedValue({ ...attachment(), expiresAt: Date.now() + 30_000 })
  render(() => <MessageItem mediaEnabled message={message()} />)
  fireEvent.click(await screen.findByRole("button", { name: dict["im.media.preview"] }))
  await screen.findByRole("img")
  const expire = timer.mock.calls.find(
    (entry) => typeof entry[1] === "number" && entry[1] > 25_000 && entry[1] <= 30_000,
  )?.[0]
  if (typeof expire !== "function") throw new Error("Expected TTL timer")
  expire()
  await screen.findByText(dict["im.media.expired"])
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture")
  expect(screen.getByRole("button", { name: dict["im.media.download"] }).hasAttribute("disabled")).toBe(true)
  expect(screen.queryByRole("img")).toBeNull()
})

it("discards late byte responses after the component is disposed", async () => {
  const pending = Promise.withResolvers<Blob>()
  api.downloadAttachment.mockReturnValue(pending.promise)
  const view = render(() => <MessageItem mediaEnabled message={message()} />)
  fireEvent.click(await screen.findByRole("button", { name: dict["im.media.preview"] }))
  await waitFor(() => expect(api.downloadAttachment).toHaveBeenCalled())
  view.unmount()
  pending.resolve(new Blob(["fixture"]))
  await pending.promise
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it("rechecks authorization for a cached preview and clears it when access is revoked", async () => {
  render(() => <MessageItem mediaEnabled message={message()} />)
  fireEvent.click(await screen.findByRole("button", { name: dict["im.media.preview"] }))
  await screen.findByRole("img")
  api.getAttachment.mockRejectedValueOnce(new Error("denied"))
  fireEvent.click(screen.getByRole("button", { name: dict["im.media.download"] }))
  await screen.findByRole("alert")
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture")
  expect(screen.queryByRole("img")).toBeNull()
  expect(api.downloadAttachment).toHaveBeenCalledTimes(1)
})

it("ignores delayed metadata from the previous attachment after its ID changes", async () => {
  const pending = Promise.withResolvers<IMAttachment>()
  api.getAttachment.mockReturnValueOnce(pending.promise)
  const [id, setID] = createSignal("ima_old")
  render(() => <AttachmentCard attachmentID={id()} />)
  api.getAttachment.mockResolvedValue({ ...attachment(), id: "ima_new", mime: "image/jpeg" })
  setID("ima_new")
  await screen.findByText(/image\/jpeg/)
  pending.resolve({ ...attachment(), id: "ima_old", mime: "image/svg+xml", preview: false })
  await pending.promise
  expect(screen.getByText(/image\/jpeg/)).toBeTruthy()
  expect(screen.queryByText(/image\/svg/)).toBeNull()
})

it("resets busy on attachment change and keeps a delayed byte request bound to its original descriptor", async () => {
  const pending = Promise.withResolvers<Blob>()
  api.downloadAttachment.mockReturnValueOnce(pending.promise)
  const [id, setID] = createSignal("ima_fixture")
  render(() => <AttachmentCard attachmentID={id()} />)
  fireEvent.click(await screen.findByRole("button", { name: dict["im.media.preview"] }))
  await waitFor(() => expect(api.downloadAttachment).toHaveBeenCalledTimes(1))
  api.getAttachment.mockResolvedValue({ ...attachment(), id: "ima_new", filename: "new.png", checksum: "new-checksum" })
  setID("ima_new")
  const preview = await screen.findByRole("button", { name: dict["im.media.preview"] })
  expect(preview.hasAttribute("disabled")).toBe(false)
  fireEvent.click(preview)
  await screen.findByRole("img", { name: "new.png" })
  pending.resolve(new Blob(["old bytes"]))
  await pending.promise
  expect(api.downloadAttachment.mock.calls[0][0]).toMatchObject({ id: "ima_fixture", checksum: "verified-by-service" })
  expect(api.downloadAttachment.mock.calls[1][0]).toMatchObject({ id: "ima_new", checksum: "new-checksum" })
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  expect(screen.getByRole("img").getAttribute("alt")).toBe("new.png")
})

it("revokes an already-loaded preview URL when the card is unmounted", async () => {
  const view = render(() => <AttachmentCard attachmentID="ima_fixture" />)
  fireEvent.click(await screen.findByRole("button", { name: dict["im.media.preview"] }))
  await screen.findByRole("img")
  view.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:fixture")
})
