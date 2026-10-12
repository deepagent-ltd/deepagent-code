import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { createServer } from "node:http"
import { File } from "node:buffer"
import { PropertySymbol } from "happy-dom"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { createIMClient, type IMClient } from "@/utils/im-client"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({ directory: "", client: undefined as IMClient | undefined }))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => runtime.client!,
}))
vi.mock("@/utils/im-media-intent", async () => {
  // HappyDOM lacks durable IndexedDB. Use the original private disk store, not a mocked receipt store.
  const sibling = "../../../tui/src/util/im-media-intent"
  const source = (await import(/* @vite-ignore */ sibling)) as {
    createMediaIntentStore(
      directory: string,
    ): Omit<ReturnType<typeof import("@/utils/im-media-intent").createMediaIntentStore>, "close">
    createMediaBatchStore(
      directory: string,
    ): Omit<ReturnType<typeof import("@/utils/im-media-intent").createMediaBatchStore>, "close">
  }
  return {
    createMediaIntentStore: () => ({ ...source.createMediaIntentStore(runtime.directory), close() {} }),
    createMediaBatchStore: () => ({ ...source.createMediaBatchStore(runtime.directory), close() {} }),
  }
})
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, number | string>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))
vi.mock("@/hooks/use-im-websocket", () => ({
  useIMWebSocket: () => ({
    connected: () => false,
    messages: () => [],
    agentStatuses: () => new Map(),
    agentProgress: () => new Map(),
    typingMembers: () => new Set(),
    send() {},
    reconnect() {},
  }),
}))

beforeEach(async () => {
  vi.stubGlobal("fetch", window.fetch.bind(window))
  vi.stubGlobal("FormData", window.FormData)
  vi.stubGlobal("File", window.File)
  vi.stubGlobal("Blob", window.Blob)
  vi.stubGlobal("Request", window.Request)
  vi.stubGlobal("AbortController", window.AbortController)
  vi.stubGlobal("AbortSignal", window.AbortSignal)
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-media-batch-app-"))
})
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await fs.rm(runtime.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function serve() {
  const state = {
    lost: false,
    multiple: true,
    enabled: true,
    uploadGate: undefined as Promise<void> | undefined,
    uploads: [] as MediaIntent.Attachment[],
    sends: [] as {
      content: string
      type: string
      attachmentIDs?: string[]
      attachmentID?: string
      clientRequestID: string
    }[],
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.headers.authorization !== "Bearer private-media-fixture") {
      response.writeHead(403)
      response.end()
      return
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const groupID = url.pathname.includes("/next") ? "next" : "group"
    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === "/global/capabilities") {
      json({ features: { v4FileUploadEnabled: state.enabled } })
      return
    }
    if (url.pathname.endsWith("/status")) {
      json({
        facade: "disabled",
        identity: null,
        blocked: null,
        kernel: null,
        keyOrigin: "none",
        viewer: { memberID: "viewer" },
        ...(state.multiple
          ? {
              media: {
                version: 2,
                enabled: state.enabled,
                multipleAttachments: true,
                maxAttachments: 4,
                maxAttachmentBytes: 52428800,
                ttlMs: 86400000,
              },
            }
          : {}),
      })
      return
    }
    if (url.pathname.endsWith("/agents")) {
      json([])
      return
    }
    if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      json({ messages: [], hasMore: false, nextCursor: null })
      return
    }
    if (url.pathname.endsWith(`/groups/${groupID}`)) {
      json({
        version: 1,
        group: { id: groupID, workspaceID: "workspace", kernelConvID: null, createdAt: 1, updatedAt: 1 },
      })
      return
    }
    if (request.method === "GET" && url.pathname.includes("/attachments/")) {
      const attachment = state.uploads.find((item) => url.pathname.endsWith(`/${item.id}`))
      json(attachment && { ...attachment, messageID: "message" })
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const bytes = new Uint8Array(Buffer.concat(chunks))
    if (url.pathname.endsWith("/attachments")) {
      const envelope = new window.Request(url.href, {
        method: "POST",
        headers: { "content-type": request.headers["content-type"] ?? "" },
        body: bytes,
      })
      // HappyDOM ignores explicit Content-Type in formData() for buffered bodies and
      // Blob.type lowercases the boundary. Preserve the real incoming header and bytes.
      Object.defineProperty(envelope, PropertySymbol.contentType, { value: request.headers["content-type"] ?? null })
      const form = await envelope.formData()
      const file = form.get("file")
      if (!file || typeof file === "string") throw new Error("Missing actual multipart file")
      const body = new Uint8Array(await file.arrayBuffer())
      const createdAt = Date.now()
      const attachment = MediaIntent.attachment({
        id: `attachment-${state.uploads.length + 1}`,
        workspaceID: "workspace",
        projectID: null,
        groupID: form.get("groupId"),
        messageID: null,
        uploadedBy: "viewer",
        filename: file.name,
        mime: "application/octet-stream",
        sizeBytes: body.length,
        checksum: await MediaIntent.checksum(body),
        createdAt,
        expiresAt: createdAt + 86400000,
        preview: false,
      })
      state.uploads.push(attachment)
      await state.uploadGate
      json(attachment)
      return
    }
    if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      const input = JSON.parse(new TextDecoder().decode(bytes)) as (typeof state.sends)[number]
      state.sends.push(input)
      if (state.lost) {
        state.lost = false
        response.destroy()
        return
      }
      json({
        id: "message",
        groupID,
        senderID: "viewer",
        senderType: "user",
        type: "file",
        content: input.content,
        metadata: input.attachmentIDs
          ? input.attachmentIDs.map((id) => ({ type: "attachment_ref", attachmentID: id, batch: true }))
          : { type: "attachment_ref", attachmentID: input.attachmentID },
        mentions: null,
        replyToID: null,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing private socket")
  runtime.client = createIMClient(() => ({
    url: `http://127.0.0.1:${address.port}`,
    directory: "/private",
    bearer: "private-media-fixture",
  }))
  return {
    state,
    async close() {
      cleanup()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
function choose(container: HTMLElement, names: string[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error("Missing original composer file input")
  expect(input.multiple).toBe(true)
  fireEvent.change(input, { target: { files: names.map((name) => new File([name], name)) } })
}

it("four real multipart uploads stay in a removable draft; lost send retries the exact ordered request once", async () => {
  const api = await serve()
  try {
    const view = render(() => <GroupChatPanel groupID="group" fileUploadEnabled />)
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    choose(view.container, ["one", "two", "three", "four"])
    await screen.findByRole("button", { name: `${dict["im.media.batch.remove"]} four` })
    expect(api.state.uploads).toHaveLength(4)
    expect(api.state.sends).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: `${dict["im.media.batch.remove"]} two` }))
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: `${dict["im.media.batch.remove"]} two` })).toBeNull(),
    )
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "  original caption\n" } })
    api.state.lost = true
    fireEvent.click(screen.getByRole("button", { name: dict["im.composer.send"] }))
    await screen.findByText(dict["im.media.batch.unknown"])
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["im.media.retry"] }).hasAttribute("disabled")).toBe(false),
    )
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "new text draft" } })
    fireEvent.click(screen.getByRole("button", { name: dict["im.media.retry"] }))
    await waitFor(() => expect(api.state.sends).toHaveLength(2))
    await screen.findByRole("article")
    await waitFor(() => expect(screen.queryByRole("button", { name: dict["im.media.retry"] })).toBeNull())
    expect(api.state.sends).toHaveLength(2)
    expect(api.state.sends[1]).toEqual(api.state.sends[0])
    expect(api.state.sends[0].attachmentIDs).toEqual(["attachment-1", "attachment-3", "attachment-4"])
    expect(api.state.sends[0].content).toBe("  original caption\n")
    expect(api.state.uploads).toHaveLength(4)
    expect(
      screen.getByRole("textbox").getAttribute("value") ?? (screen.getByRole("textbox") as HTMLTextAreaElement).value,
    ).toBe("new text draft")
    expect(screen.getAllByRole("button", { name: dict["im.media.download"] })).toHaveLength(3)
  } finally {
    await api.close()
  }
})

it("a fifth file causes zero upload; an old server never receives a multiple request", async () => {
  const api = await serve()
  api.state.multiple = false
  try {
    const view = render(() => <GroupChatPanel groupID="group" fileUploadEnabled />)
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    choose(view.container, ["one", "two", "three", "four", "five"])
    await screen.findByText(dict["im.media.batch.tooMany"])
    expect(api.state.uploads).toHaveLength(0)
    choose(view.container, ["one", "two"])
    await screen.findByRole("button", { name: `${dict["im.media.batch.remove"]} two` })
    expect(screen.getByRole("button", { name: dict["im.composer.send"] }).hasAttribute("disabled")).toBe(true)
    expect(api.state.sends).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: `${dict["im.media.batch.remove"]} two` }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["im.composer.send"] }).hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["im.composer.send"] }))
    await screen.findByRole("article")
    expect(api.state.sends[0].attachmentIDs).toBeUndefined()
    expect(api.state.sends[0].attachmentID).toBe("attachment-1")
  } finally {
    await api.close()
  }
})

it("a real late upload from the old group cannot send or clear the next owner's text draft", async () => {
  const api = await serve()
  const gate = Promise.withResolvers<void>()
  api.state.uploadGate = gate.promise
  try {
    const [group, setGroup] = createSignal("group")
    const view = render(() => <GroupChatPanel groupID={group()} fileUploadEnabled />)
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    choose(view.container, ["old"])
    await waitFor(() => expect(api.state.uploads).toHaveLength(1))
    setGroup("next")
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "next owner" } })
    gate.resolve()
    await waitFor(() => expect(screen.getByRole("textbox").hasAttribute("readonly")).toBe(false))
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("next owner")
    expect(api.state.sends).toHaveLength(0)
    expect(screen.queryByRole("button", { name: `${dict["im.media.batch.remove"]} old` })).toBeNull()
  } finally {
    gate.resolve()
    await api.close()
  }
})

it("oversize selection uploads nothing; canceling an actual pending multipart stops its batch without sending", async () => {
  const api = await serve()
  const gate = Promise.withResolvers<void>()
  try {
    const view = render(() => <GroupChatPanel groupID="group" fileUploadEnabled />)
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error("Missing original file input")
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(52428801)], "too-large.bin")] } })
    await screen.findByText(dict["im.media.batch.tooLarge"])
    expect(api.state.uploads).toHaveLength(0)
    api.state.uploadGate = gate.promise
    choose(view.container, ["first", "second"])
    await waitFor(() => expect(api.state.uploads).toHaveLength(1))
    fireEvent.click(screen.getByRole("button", { name: dict["im.media.batch.cancelUpload"] }))
    await waitFor(() => expect(screen.queryByRole("button", { name: dict["im.media.batch.cancelUpload"] })).toBeNull())
    expect(api.state.uploads).toHaveLength(1)
    expect(api.state.sends).toHaveLength(0)
    expect(screen.queryByRole("button", { name: dict["im.media.retry"] })).toBeNull()
    expect(await screen.findByText(/Upload result unknown/)).toBeTruthy()
  } finally {
    gate.resolve()
    await api.close()
  }
})
