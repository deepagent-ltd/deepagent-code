/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { createIMClient, type IMGroup } from "../../../src/component/im-client"
import { createMediaPreview } from "../../../src/component/im-media-preview"
import { DialogIMChat } from "../../../src/component/dialog-im"
import { tmpdir } from "../../fixture/fixture"
import { mountIM } from "../../fixture/im-environment"
import path from "node:path"

const bytes = new Uint8Array(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8MsAAAAASUVORK5CYII=", "base64"),
)
async function fixture(empty = false) {
  const body = empty ? new Uint8Array(0) : bytes
  const createdAt = Date.now()
  const attachment = {
    profile: "kernel_media" as const,
    attachmentID: "a".repeat(64),
    contentRef: "a".repeat(64),
    filename: empty ? "empty.bin" : "received.png",
    mime: empty ? "application/octet-stream" : "image/png",
    sizeBytes: body.length,
    sha256: await MediaIntent.checksum(body),
    createdAt,
    expiresAt: createdAt + 86400000,
  }
  const ref = { groupID: "protected-group", messageID: "typed-message", attachment }
  const route = `/api/v1/im/groups/${ref.groupID}/messages/${ref.messageID}/attachments/${attachment.attachmentID}`
  const state = { allowed: true, corrupt: false, calls: [] as string[], delay: undefined as Promise<void> | undefined }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      state.calls.push(`${request.method} ${url.pathname}`)
      if (request.method !== "GET" || request.headers.get("authorization") !== "Bearer fixture-token" || !state.allowed)
        return new Response(null, { status: 403 })
      if (url.pathname.includes("/ws/") && server.upgrade(request)) return
      if (url.pathname.endsWith("/messages"))
        return Response.json({
          messages: [
            {
              id: ref.messageID,
              groupID: ref.groupID,
              senderID: "alice",
              senderType: "user",
              type: "file",
              content: attachment.filename,
              remoteAttachments: [attachment],
              mentions: null,
              metadata: null,
              replyToID: null,
              createdAt,
              updatedAt: createdAt,
              deletedAt: null,
            },
          ],
          nextCursor: null,
          hasMore: false,
          reader: {
            state: "ready",
            displayEpoch: "media-fixture",
            projectionRevision: "1",
            validatedServerNow: Date.now(),
            nextExpiryAt: attachment.expiresAt,
          },
        })
      if (url.pathname === "/global/capabilities") return Response.json({ features: { v4FileUploadEnabled: false } })
      if (url.pathname === "/api/v1/im/status")
        return Response.json({
          facade: "disabled",
          identity: null,
          blocked: null,
          kernel: null,
          keyOrigin: "none",
          viewer: { memberID: "server" },
        })
      if (url.pathname === route) return Response.json(attachment)
      if (url.pathname !== `${route}/content`) return new Response(null, { status: 404 })
      await state.delay
      return new Response(state.corrupt ? new Uint8Array(body.length) : body, {
        headers: {
          "content-type": attachment.mime,
          ...(empty ? { "content-length": String(body.length) } : {}),
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      })
    },
    websocket: { message() {} },
  })
  const sdk = {
    url: server.url.href,
    directory: "/project",
    client: createOpencodeClient({ baseUrl: server.url.href, headers: { Authorization: "Bearer fixture-token" } }),
  }
  return {
    state,
    ref,
    route,
    body,
    sdk,
    client: createIMClient(sdk),
    [Symbol.asyncDispose]: async () => {
      await server.stop(true)
    },
  }
}

test("remote attachment HTTP binds group/message/object and verifies exact PNG and empty bytes; revoke and scope changes reject", async () => {
  for (const empty of [false, true]) {
    await using api = await fixture(empty)
    const abort = new AbortController()
    expect(await api.client.downloadRemoteAttachment(api.ref, abort.signal)).toEqual(api.body)
    expect(api.state.calls).toEqual([`GET ${api.route}`, `GET ${api.route}/content`, `GET ${api.route}`])
    await expect(
      api.client.getRemoteAttachment({ ...api.ref, messageID: "other-message" }, abort.signal),
    ).rejects.toThrow()
    api.state.allowed = false
    const count = api.state.calls.filter((call) => call.endsWith("/content")).length
    await expect(api.client.downloadRemoteAttachment(api.ref, abort.signal)).rejects.toThrow()
    expect(api.state.calls.filter((call) => call.endsWith("/content"))).toHaveLength(count)
  }
  await using api = await fixture()
  const pending = Promise.withResolvers<void>()
  api.state.delay = pending.promise
  const result = api.client.downloadRemoteAttachment(api.ref, new AbortController().signal)
  while (!api.state.calls.some((call) => call.endsWith("/content"))) await Bun.sleep(5)
  api.sdk.directory = "/other-project"
  pending.resolve()
  await expect(result).rejects.toThrow()
})

test("remote preview only fetches authenticated locator bytes, denies corrupt data and keeps bearer out of ticket", async () => {
  await using api = await fixture()
  const preview = await createMediaPreview({
    remote: api.ref,
    client: api.client,
    signal: new AbortController().signal,
  })
  try {
    expect(preview.url).not.toContain(api.ref.attachment.attachmentID)
    expect(preview.url).not.toContain("fixture-token")
    expect(new Uint8Array(await (await fetch(preview.url.replace("/view/", "/image/"))).arrayBuffer())).toEqual(bytes)
    api.state.corrupt = true
    const result = await fetch(preview.url.replace("/view/", "/image/")).catch(() => undefined)
    expect(result?.ok ?? false).toBe(false)
    expect(api.state.calls.every((call) => call.startsWith("GET "))).toBe(true)
  } finally {
    preview.close()
  }
})

test("actual TUI protected media details and explicit save use locator HTTP with uploads disabled, preserving original bytes without sending", async () => {
  await using dir = await tmpdir()
  await using api = await fixture()
  const group: IMGroup = {
    id: api.ref.groupID,
    workspaceID: "/project",
    projectID: null,
    type: "direct",
    name: "Alice",
    createdBy: "server",
    kernelConvID: "k:1:alice",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    reader: { mode: "protected", state: "ready", liveUnread: "0" },
  }
  using ui = await mountIM(dir.path, api.sdk.url, () => (
    <DialogIMChat
      client={api.client}
      sdk={api.sdk}
      group={group}
      displayEpoch="media-fixture"
      identity="server"
      back={() => {}}
    />
  ))
  await ui.frame("received.png")
  ui.app.mockInput.pressKey("u", { ctrl: true })
  await ui.frame("Attachment details")
  expect(ui.app.captureCharFrame()).not.toContain("Upload a local file")
  await ui.select("Attachment details received.png")
  await ui.frame(`${bytes.length} B`)
  expect(ui.app.captureCharFrame()).not.toContain("local server")
  await ui.select("Save file")
  await ui.type(path.join(dir.path, "received.png"))
  ui.app.mockInput.pressEnter()
  await ui.frame("File saved")
  expect(new Uint8Array(await Bun.file(path.join(dir.path, "received.png")).arrayBuffer())).toEqual(bytes)
  // The upload switch grants no read authority: revocation must still stop publication.
  api.state.allowed = false
  const downloads = api.state.calls.filter((call) => call.endsWith("/content")).length
  await ui.select("Save file")
  await ui.type(path.join(dir.path, "denied.png"))
  ui.app.mockInput.pressEnter()
  await ui.frame("IM operation failed")
  expect(await Bun.file(path.join(dir.path, "denied.png")).exists()).toBe(false)
  expect(api.state.calls.filter((call) => call.endsWith("/content"))).toHaveLength(downloads)
  expect(api.state.calls.every((call) => call.startsWith("GET "))).toBe(true)
})

// This opt-in case attaches only to the owned dual-DAC fixture. It never starts a server or sends a message.
test.skipIf(!process.env.DAC_TUI_REMOTE_MEDIA_CONFIG)(
  "private actual host reader renders a GUI attachment and saves the original authenticated bytes",
  async () => {
    const { SDKProvider } = await import("../../../src/context/sdk")
    const { DialogIM } = await import("../../../src/component/dialog-im")
    const { eventSource } = await import("../../fixture/tui-sdk")
    const { Schema } = await import("effect")
    const filename = process.env.DAC_TUI_REMOTE_MEDIA_CONFIG!
    if (!filename.includes("/dac-reader-media-sdk-") || !filename.endsWith("/host-bob/private.json"))
      throw new Error("Owned Bob fixture required")
    const config = Schema.decodeUnknownSync(
      Schema.Struct({ username: Schema.String, password: Schema.String, directory: Schema.String }),
    )(await Bun.file(filename).json())
    const ready = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
      await Bun.file(path.join(path.dirname(filename), "ready.json")).json(),
    )
    const item = Schema.decodeUnknownSync(
      Schema.Struct({
        groupID: Schema.String,
        messageID: Schema.String,
        attachmentID: Schema.String,
        filename: Schema.String,
        sha256: Schema.String,
        sizeBytes: Schema.Number,
        expiresAt: Schema.Number,
      }),
    )(await Bun.file(process.env.DAC_TUI_REMOTE_MEDIA_CASE!).json())
    const output = process.env.DAC_TUI_REMOTE_MEDIA_OUTPUT!
    if (!output.includes("/dac-tui-remote-media-") || new URL(ready.url).hostname !== "127.0.0.1" || !config.password)
      throw new Error("Owned loopback output required")
    const headers = {
      Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
    }
    const calls: { method: string; path: string; status: number }[] = []
    const observed = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method !== "GET") throw new Error("Read-only product case forbids mutations")
        const response = await fetch(request)
        calls.push({ method: request.method, path: new URL(request.url).pathname, status: response.status })
        await Bun.write(path.join(output, "actual-tui-requests.json"), JSON.stringify(calls, null, 2))
        return response
      },
      { preconnect: fetch.preconnect },
    )
    const sdk = {
      url: ready.url,
      directory: config.directory,
      client: createOpencodeClient({ baseUrl: ready.url, headers }),
      fetch: observed,
    }
    const client = createIMClient(sdk)
    const target = (await client.getGroup(item.groupID)).group
    await using dir = await tmpdir()
    using ui = await mountIM(dir.path, sdk.url, () => (
      <SDKProvider url={sdk.url} directory={sdk.directory} headers={headers} fetch={observed} events={eventSource()}>
        <DialogIM />
      </SDKProvider>
    ))
    await ui.frame("Shared IM ready")
    await ui.type(target.name, true)
    await ui.frame(`@ ${target.name}`)
    ui.app.mockInput.pressEnter()
    const chat = await ui.frame(item.filename)
    await Bun.write(path.join(output, "actual-tui-chat.txt"), chat)
    ui.app.mockInput.pressKey("u", { ctrl: true })
    await ui.frame("Attachments")
    await ui.select(`Attachment details ${item.filename}`)
    await ui.frame(`${item.sizeBytes} B`)
    await ui.select("Save file")
    const saved = path.join(dir.path, "received-gui-image.png")
    await ui.type(saved)
    ui.app.mockInput.pressEnter()
    const frame = await ui.frame("File saved")
    const result = new Uint8Array(await Bun.file(saved).arrayBuffer())
    expect(result.length).toBe(item.sizeBytes)
    expect(await MediaIntent.checksum(result)).toBe(item.sha256)
    expect(item.expiresAt).toBeGreaterThan(Date.now())
    expect(calls.every((call) => call.method === "GET")).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.path ===
            `/api/v1/im/groups/${item.groupID}/messages/${item.messageID}/attachments/${item.attachmentID}/content` &&
          call.status === 200,
      ),
    ).toBe(true)
    await Bun.write(path.join(output, "actual-tui-saved.txt"), frame)
    await Bun.write(path.join(output, "actual-tui-received.png"), result)
    await Bun.write(
      path.join(output, "actual-tui-result.json"),
      JSON.stringify(
        {
          groupID: item.groupID,
          messageID: item.messageID,
          attachmentID: item.attachmentID,
          sizeBytes: result.length,
          sha256: await MediaIntent.checksum(result),
          expiresAt: item.expiresAt,
          mutations: 0,
          requests: calls,
        },
        null,
        2,
      ),
    )
  },
)
