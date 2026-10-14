import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { MemoryRouter, Route } from "@solidjs/router"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { createSdkForServer } from "@/utils/server"
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

const runtime = vi.hoisted(() => ({ directory: "", client: undefined as IMClient | undefined, sdk: undefined as ReturnType<typeof createSdkForServer> | undefined, connected: true }))
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
vi.mock("@/context/command", async (original) => ({
  ...(await original<typeof import("@/context/command")>()),
  useCommand: () => ({ register: vi.fn() }),
}))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: runtime.sdk!, directory: "/private", url: runtime.client!.scope().url }) }))
vi.mock("@/context/server", async (original) => ({ ...(await original<typeof import("@/context/server")>()), useServer: () => ({ key: "parent-media-fixture", all: [], projects: () => ({ list: [] }) }) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show() {} }) }))
vi.mock("@/hooks/use-im-websocket", () => ({
  useIMWebSocket: () => ({
    connected: () => runtime.connected,
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
  runtime.connected = true
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
    viewerReady: true,
    statusGate: undefined as Promise<void> | undefined,
    uploadGate: undefined as Promise<void> | undefined,
    sendGate: undefined as Promise<void> | undefined,
    uploads: [] as MediaIntent.Attachment[],
    protected: true,
    historyUnavailable: false,
    historyStatus: 503,
    historyCode: "reader_unavailable",
    historyReads: 0,
    epoch: "current",
    sourceUnavailable: false,
    invalidExpiryClock: false,
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
        facade: "active",
        identity: { uuid: "viewer", name: "Fixture Viewer", orgID: 1, orgAllGroupID: "all" },
        blocked: null,
        kernel: state.protected ? "connected" : null,
        ...(state.protected ? { reader: { state: state.sourceUnavailable ? "unavailable" : "ready", displayEpoch: state.epoch, legacyMirrorUnavailable: true } } : {}),
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
    if (url.pathname.endsWith("/groups/page")) {
      const lane = url.searchParams.get("lane")
      json({ version: 1, lane, groups: lane === "protected" ? [{ id: "group", name: "Private media group", workspaceID: "workspace", projectID: null, type: "direct", createdBy: "viewer", kernelConvID: "kr1:pending", createdAt: 1, updatedAt: 1, reader: { mode: "protected", state: "ready", liveUnread: "1" } }] : [], hasMore: false, nextCursor: null, ...(lane === "protected" ? { reader: { displayEpoch: state.epoch, proofWindowMs: 1000, nextExpiryAt: state.invalidExpiryClock ? Date.now() + 60000 : null } } : {}) })
      return
    }
    if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      state.historyReads++
      if (state.historyUnavailable) {
        response.writeHead(state.historyStatus, { "content-type": "application/json" })
        response.end(JSON.stringify({ name: "IM_READER_UNAVAILABLE", data: { code: state.historyCode } }))
        return
      }
      json({ messages: [{ id: "observed", groupID, senderID: "peer", senderType: "user", type: "text", content: "Observed history before temporary failure", metadata: null, mentions: null, replyToID: null, createdAt: 1, updatedAt: 1, deletedAt: null }], hasMore: false, nextCursor: null,
        ...(state.protected ? { reader: { displayEpoch: state.epoch, validatedServerNow: Date.now(), nextExpiryAt: null } } : {}) })
      return
    }
    if (url.pathname.endsWith(`/groups/${groupID}`) ||
      (request.method === "POST" && url.pathname.endsWith(`/groups/${groupID}/refresh`))) {
      state.groupReads++
      json({
        version: 1,
        group: { id: groupID, name: "Private media group", type: "direct", projectID: null, createdBy: "viewer", workspaceID: "workspace", kernelConvID: state.protected ? "kr1:pending" : null, createdAt: 1, updatedAt: 1,
          ...(state.protected ? { reader: { mode: "protected", state: "ready", liveUnread: "1" } } : {}) },
        ...(state.protected ? { reader: { displayEpoch: state.epoch, proofWindowMs: 1000, nextExpiryAt: state.invalidExpiryClock ? Date.now() + 60000 : null } } : {}),
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
  runtime.sdk = createSdkForServer({ server: runtime.client.scope(), directory: "/private" })
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


async function openAndDispatch(api: Awaited<ReturnType<typeof serve>>) {
  const gate = Promise.withResolvers<void>()
  api.state.sendGate = gate.promise
  const observed = messageSignals()
  const view = render(() => <MemoryRouter><Route path="/" component={() => <SidePanelIM onClose={() => {}} />} /></MemoryRouter>)
  fireEvent.click(await screen.findByRole("button", { name: /Private media group/ }))
  await screen.findByRole("button", { name: dict["im.composer.attach"] })
  choose(view.container, ["first"])
  await screen.findByRole("button", { name: `${dict["im.media.batch.remove"]} first` })
  fireEvent.click(screen.getByRole("button", { name: dict["im.composer.send"] }))
  await waitFor(() => expect(api.state.sends).toHaveLength(1))
  return { gate, observed }
}

it("a history-only 503 keeps the real parent media sender alive while clearing protected history", async () => {
  const api = await serve()
  const send = await openAndDispatch(api)
  try {
    expect(send.observed[0].aborted).toBe(false)
    await screen.findByText("Observed history before temporary failure")
    const reads = api.state.historyReads
    api.state.historyUnavailable = true
    fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refresh"] }))
    await waitFor(() => expect(api.state.historyReads).toBeGreaterThan(reads))
    await screen.findByText(dict["im.reader.unavailable"])
    expect(screen.queryByText("Observed history before temporary failure")).toBeNull()
    expect(send.observed[0].aborted).toBe(false)
    expect(api.state.sends).toHaveLength(1)
    expect(api.state.uploads).toHaveLength(1)
  } finally {
    send.gate.resolve()
    await api.close()
  }
})

it.each(["epoch", "source", "member", "unverified-expiry"])("real parent %s denial still cancels the original media sender", async (change) => {
  const api = await serve()
  const send = await openAndDispatch(api)
  try {
    expect(send.observed[0].aborted).toBe(false)
    if (change === "epoch") api.state.epoch = "next"
    if (change === "source") api.state.sourceUnavailable = true
    if (change === "unverified-expiry") api.state.invalidExpiryClock = true
    if (change === "member") {
      api.state.historyUnavailable = true
      api.state.historyStatus = 403
      api.state.historyCode = "forbidden"
      fireEvent.click(screen.getByRole("button", { name: dict["im.transport.refresh"] }))
      await waitFor(() => expect(send.observed[0].aborted).toBe(true))
      return
    }
    const reads = api.state.statusReads
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
    await waitFor(() => expect(api.state.statusReads).toBeGreaterThan(reads))
    await waitFor(() => expect(send.observed[0].aborted).toBe(true))
    expect(api.state.sends).toHaveLength(1)
  } finally {
    send.gate.resolve()
    await api.close()
  }
})


it("attachment initialization qualification failure is distinct from a transfer and explicit retry only rechecks access", async () => {
  const api = await serve()
  api.state.viewerReady = false
  try {
    render(() => <GroupChatPanel groupID="group" protected fileUploadEnabled />)
    await screen.findByText(dict["im.media.initialize.qualification"])
    expect(screen.queryByText(dict["im.media.storageOrTransferFailed"])).toBeNull()
    expect(screen.queryByRole("button", { name: dict["im.composer.attach"] })).toBeNull()
    expect(api.state.uploads).toHaveLength(0)
    expect(api.state.sends).toHaveLength(0)
    api.state.viewerReady = true
    fireEvent.click(screen.getByRole("button", { name: dict["im.media.initialize.retry"] }))
    await screen.findByRole("button", { name: dict["im.composer.attach"] })
    expect(screen.queryByText(dict["im.media.initialize.qualification"])).toBeNull()
    expect(api.state.uploads).toHaveLength(0)
    expect(api.state.sends).toHaveLength(0)
  } finally { await api.close() }
})

it("attachment initialization disabled capability does not report an attempted transfer", async () => {
  const api = await serve()
  api.state.enabled = false
  try {
    render(() => <GroupChatPanel groupID="group" protected fileUploadEnabled />)
    await screen.findByText(dict["im.media.initialize.disabled"])
    expect(screen.queryByText(dict["im.media.storageOrTransferFailed"])).toBeNull()
    expect(api.state.statusReads).toBe(0)
    expect(api.state.uploads).toHaveLength(0)
    expect(api.state.sends).toHaveLength(0)
  } finally { await api.close() }
})

it.each(["storage", "capacity"])("attachment initialization %s retains actual original private store bytes and performs no transfer", async (kind) => {
  const api = await serve()
  const file = path.join(runtime.directory, "im-media-v1", "records.json")
  await fs.mkdir(path.dirname(file), { mode: 0o700 })
  const original = kind === "storage" ? Buffer.from("[invalid original record") : Buffer.alloc(MediaIntent.maxStoreBytes + 1, 32)
  await fs.writeFile(file, original, { mode: 0o600 })
  try {
    render(() => <GroupChatPanel groupID="group" protected fileUploadEnabled />)
    await screen.findByText(dict[kind === "storage" ? "im.media.initialize.storage" : "im.media.initialize.capacity"])
    expect(screen.queryByText(dict["im.media.storageOrTransferFailed"])).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: dict["im.media.initialize.retry"] }))
    await waitFor(() => expect(api.state.statusReads).toBeGreaterThan(1))
    await waitFor(() => expect(screen.getByRole("button", { name: dict["im.media.initialize.retry"] }).hasAttribute("disabled")).toBe(false))
    expect(await fs.readFile(file)).toEqual(original)
    expect(api.state.uploads).toHaveLength(0)
    expect(api.state.sends).toHaveLength(0)
  } finally { await api.close() }
})

it("attachment operation lost acknowledgement still retains the original unknown batch and its uncertainty notice", async () => {
  const api = await serve()
  api.state.lost = true
  const send = await openAndDispatch(api)
  try {
    send.gate.resolve()
    await screen.findByText(dict["im.media.batch.unknown"])
    expect(screen.queryByText(dict["im.media.initialize.qualification"])).toBeNull()
    const bytes = JSON.parse(await fs.readFile(path.join(runtime.directory, "im-media-v1", "batches.json"), "utf8"))
    expect(bytes).toHaveLength(1)
    expect(bytes[0].phase).toBe("send_outcome_unknown")
    expect(bytes[0].requestID).toBe(api.state.sends[0].clientRequestID)
    expect(api.state.sends).toHaveLength(1)
    expect(api.state.uploads).toHaveLength(1)
  } finally { send.gate.resolve(); await api.close() }
})
