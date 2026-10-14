import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
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
import { createBrowserMediaStoreFixture } from "./fixture/browser-media-store"

const runtime = vi.hoisted(() => ({ directory: "", storage: undefined as Awaited<ReturnType<typeof createBrowserMediaStoreFixture>> | undefined, client: undefined as IMClient | undefined }))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => runtime.client!,
}))
vi.mock("@/utils/im-media-intent", () => ({
  createMediaIntentStore: () => runtime.storage!.createMediaIntentStore(),
  createMediaBatchStore: () => runtime.storage!.createMediaBatchStore(),
}))

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

beforeAll(async () => {
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-media-batch-app-"))
  runtime.storage = await createBrowserMediaStoreFixture(runtime.directory)
})
afterAll(async () => {
  await runtime.storage?.close()
  if (runtime.directory) await fs.rm(runtime.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
beforeEach(async () => {
  await runtime.storage!.records("intents", [])
  await runtime.storage!.records("batches", [])
  vi.stubGlobal("fetch", window.fetch.bind(window))
  vi.stubGlobal("FormData", window.FormData)
  vi.stubGlobal("File", window.File)
  vi.stubGlobal("Blob", window.Blob)
  vi.stubGlobal("Request", window.Request)
  vi.stubGlobal("AbortController", window.AbortController)
  vi.stubGlobal("AbortSignal", window.AbortSignal)
})
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await runtime.storage!.drain()
})

async function serve() {
  const state = {
    lost: false,
    multiple: true,
    enabled: true,
    viewerReady: true,
    statusGate: undefined as Promise<void> | undefined,
    uploadGate: undefined as Promise<void> | undefined,
    sendGate: undefined as Promise<void> | undefined,
    uploads: [] as MediaIntent.Attachment[],
    protected: false,
    detailEpoch: "current",
    groupReads: 0,
    statusReads: 0,
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
      state.statusReads++
      const viewerReady = state.viewerReady
      await state.statusGate
      json({
        facade: "disabled",
        identity: null,
        blocked: null,
        kernel: state.protected ? "connected" : null,
        ...(state.protected ? { reader: { state: "ready", displayEpoch: "current", legacyMirrorUnavailable: true } } : {}),
        keyOrigin: "none",
        ...(viewerReady ? { viewer: { memberID: "viewer" } } : {}),
        ...(state.multiple
          ? {
              media: {
                version: 2,
                enabled: state.enabled,
                multipleAttachments: true,
                maxAttachments: 4,
                maxAttachmentBytes: 10 * 1024 * 1024,
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
      json({ messages: [], hasMore: false, nextCursor: null,
        ...(state.protected ? { reader: { displayEpoch: "current", validatedServerNow: Date.now(), nextExpiryAt: null } } : {}) })
      return
    }
    if (url.pathname.endsWith(`/groups/${groupID}`)) {
      state.groupReads++
      json({
        version: 1,
        group: { id: groupID, workspaceID: "workspace", kernelConvID: state.protected ? "kr1:pending" : null, createdAt: 1, updatedAt: 1,
          ...(state.protected ? { reader: { mode: "protected", state: "pending", liveUnread: null } } : {}) },
        ...(state.protected ? { reader: { displayEpoch: state.detailEpoch, proofWindowMs: 1000, nextExpiryAt: null } } : {}),
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
      await state.sendGate
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

function messageSignals() {
  const observed: AbortSignal[] = []
  const original = globalThis.fetch
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (init?.method === "POST" && new URL(String(input)).pathname.endsWith("/messages") && init.signal)
      observed.push(init.signal)
    return original(input, init)
  })
  return observed
}

it("a current protected pending conversation can prepare its first attachment without visible history", async () => {
  const api = await serve()
  api.state.protected = true
  try {
    const view = render(() => <GroupChatPanel groupID="group" fileUploadEnabled protected displayEpoch="current"
      reader={{ mode: "protected", state: "pending", liveUnread: null }} />)
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    choose(view.container, ["first"])
    await waitFor(() => expect(api.state.uploads).toHaveLength(1))
    await screen.findByRole("button", { name: `${dict["im.media.batch.remove"]} first` })
    expect(api.state.sends).toHaveLength(0)
  } finally { await api.close() }
})

it("pending history never enables attachments across a changed current reader epoch", async () => {
  const api = await serve()
  api.state.protected = true
  api.state.detailEpoch = "other"
  try {
    render(() => <GroupChatPanel groupID="group" fileUploadEnabled protected displayEpoch="current"
      reader={{ mode: "protected", state: "pending", liveUnread: null }} />)
    await screen.findByText(dict["im.message.empty"])
    await waitFor(() => expect(api.state.groupReads > 0 && api.state.statusReads > 0).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole("button", { name: dict["im.composer.attach"] })).toBeNull()
    expect(api.state.uploads).toHaveLength(0)
    expect(api.state.sends).toHaveLength(0)
  } finally { await api.close() }
})

it("same-group metadata refresh keeps the actual dispatched attachment request alive", async () => {
  const api = await serve()
  const gate = Promise.withResolvers<void>()
  api.state.sendGate = gate.promise
  const observed = messageSignals()
  try {
    const [detail, setDetail] = createSignal({ id: "group", revision: 1 })
    const view = render(() => <GroupChatPanel groupID="group" fileUploadEnabled={detail().id === "group"} />)
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    choose(view.container, ["first"])
    await screen.findByRole("button", { name: `${dict["im.media.batch.remove"]} first` })
    fireEvent.click(screen.getByRole("button", { name: dict["im.composer.send"] }))
    await waitFor(() => expect(api.state.sends).toHaveLength(1))
    expect(observed).toHaveLength(1)
    expect(observed[0].aborted).toBe(false)
    const reads = api.state.groupReads
    setDetail({ id: "group", revision: 2 })
    expect(observed[0].aborted).toBe(false)
    expect(api.state.groupReads).toBe(reads)
    gate.resolve()
    await screen.findByRole("article")
    expect(api.state.sends).toHaveLength(1)
    await waitFor(() => expect(screen.queryByText(dict["im.media.batch.unknown"])).toBeNull())
  } finally {
    gate.resolve()
    await api.close()
  }
})

it("an initially unavailable media qualification can initialize after same-group metadata becomes current", async () => {
  const api = await serve()
  api.state.viewerReady = false
  try {
    const [detail, setDetail] = createSignal({ id: "group", revision: 1 })
    render(() => <GroupChatPanel groupID="group" fileUploadEnabled={detail().id === "group"} />)
    await screen.findByText(dict["im.message.empty"])
    await waitFor(() => expect(api.state.statusReads).toBeGreaterThan(0))
    expect(screen.queryByRole("button", { name: dict["im.composer.attach"] })).toBeNull()
    api.state.viewerReady = true
    setDetail({ id: "group", revision: 2 })
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    expect(api.state.statusReads).toBeGreaterThan(1)
    expect(api.state.uploads).toHaveLength(0)
    expect(api.state.sends).toHaveLength(0)
  } finally {
    await api.close()
  }
})

it("metadata observations during one qualification coalesce into one read-only successor", async () => {
  const api = await serve()
  const gate = Promise.withResolvers<void>()
  api.state.viewerReady = false
  api.state.statusGate = gate.promise
  try {
    const [detail, setDetail] = createSignal({ id: "group", revision: 1 })
    render(() => <GroupChatPanel groupID="group" fileUploadEnabled={detail().id === "group"} />)
    await waitFor(() => expect(api.state.statusReads).toBe(1))
    setDetail({ id: "group", revision: 2 })
    setDetail({ id: "group", revision: 3 })
    expect(api.state.statusReads).toBe(1)
    api.state.viewerReady = true
    gate.resolve()
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    expect(api.state.statusReads).toBe(2)
    const reads = api.state.groupReads
    setDetail({ id: "group", revision: 4 })
    expect(api.state.groupReads).toBe(reads)
    expect(api.state.uploads).toHaveLength(0)
    expect(api.state.sends).toHaveLength(0)
  } finally {
    gate.resolve()
    await api.close()
  }
})

it.each(["disabled", "epoch", "group"])("%s change cancels an already dispatched attachment request", async (change) => {
  const api = await serve()
  const gate = Promise.withResolvers<void>()
  api.state.sendGate = gate.promise
  const observed = messageSignals()
  try {
    const [enabled, setEnabled] = createSignal(true)
    const [epoch, setEpoch] = createSignal("current")
    const [group, setGroup] = createSignal("group")
    const view = render(() => <GroupChatPanel groupID={group()} displayEpoch={epoch()} fileUploadEnabled={enabled()} />)
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    choose(view.container, ["first"])
    await screen.findByRole("button", { name: `${dict["im.media.batch.remove"]} first` })
    fireEvent.click(screen.getByRole("button", { name: dict["im.composer.send"] }))
    await waitFor(() => expect(api.state.sends).toHaveLength(1))
    expect(observed[0].aborted).toBe(false)
    if (change === "disabled") setEnabled(false)
    if (change === "epoch") setEpoch("next")
    if (change === "group") setGroup("next")
    expect(observed[0].aborted).toBe(true)
    gate.resolve()
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull())
    expect(api.state.sends).toHaveLength(1)
  } finally {
    gate.resolve()
    await api.close()
  }
})
