/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { ServerWebSocket } from "bun"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { DialogIMChat } from "../../../src/component/dialog-im"
import { createIMClient, type IMMessage } from "../../../src/component/im-client"
import { tmpdir } from "../../fixture/fixture"
import { mountIM, until } from "../../fixture/im-environment"

const message = (id: string, state: NonNullable<IMMessage["transport"]>["state"], reason?: string): IMMessage => ({
  id,
  groupID: "team",
  senderID: "server",
  senderType: "user",
  type: "text",
  content: `中文任务进展与 delivery status ${id}`,
  mentions: null,
  metadata: null,
  replyToID: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  transport: { state, reason },
})
const group = {
  id: "team",
  name: "状态核对",
  workspaceID: "ws",
  projectID: null,
  type: "project",
  nameAlias: "",
  createdBy: "server",
  // These transport ordering oracles exercise ordinary local conversations.
  kernelConvID: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
}
function fixture(directory: string) {
  const sockets = new Set<ServerWebSocket<undefined>>()
  const state = {
    requests: [] as Array<{ method: string; path: string; limit: string | null; cursor: string | null }>,
    messages: [message("first", "prepared")],
    pending: undefined as Promise<void> | undefined,
    postPending: undefined as Promise<void> | undefined,
    echo: false,
    failed: false,
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request, host) {
      const url = new URL(request.url)
      if (
        request.headers.get("authorization") !== "Bearer fixture-token" ||
        decodeURIComponent(request.headers.get("x-deepagent-code-directory") ?? "") !== directory
      )
        return new Response("denied", { status: 401 })
      if (url.pathname.startsWith("/ws/")) {
        if (host.upgrade(request)) return
        return new Response("upgrade", { status: 400 })
      }
      state.requests.push({
        method: request.method,
        path: url.pathname,
        limit: url.searchParams.get("limit"),
        cursor: url.searchParams.get("cursor"),
      })
      if (url.pathname.endsWith("/read")) return Response.json({ ok: true })
      if (request.method === "POST") {
        const body = await request.json()
        if (state.echo)
          for (const socket of sockets)
            socket.send(
              JSON.stringify({
                type: "message_created",
                data: { ...message("sent", "prepared"), content: body.content },
              }),
            )
        await state.postPending
        return Response.json({ ...message("sent", "acknowledged"), content: body.content })
      }
      if (state.failed) return Response.json({ error: "unavailable" }, { status: 503 })
      const snapshot = structuredClone(state.messages)
      await state.pending
      return Response.json({ messages: snapshot, nextCursor: "older", hasMore: true })
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
      },
      close(socket) {
        sockets.delete(socket)
      },
      message() {},
    },
  })
  const url = server.url.toString().replace(/\/$/, "")
  const sdk = {
    url,
    directory,
    client: createOpencodeClient({ baseUrl: url, headers: { Authorization: "Bearer fixture-token" } }),
  }
  return {
    state,
    sdk,
    sockets,
    emit(item: IMMessage) {
      for (const socket of sockets) socket.send(JSON.stringify({ type: "message_created", data: item }))
    },
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

for (const appearance of [
  { width: 42, locale: "zh", mode: "dark" },
  { width: 100, locale: "en", mode: "light" },
] as const) {
  test(`transport keyboard and bounded read-only refresh ${appearance.width}/${appearance.locale}/${appearance.mode}`, async () => {
    await using tmp = await tmpdir()
    using api = fixture(tmp.path)
    using ui = await mountIM(
      tmp.path,
      api.sdk.url,
      () => <DialogIMChat client={createIMClient(api.sdk)} sdk={api.sdk} group={group} back={() => {}} />,
      appearance.width,
      undefined,
      appearance,
    )
    await ui.frame(appearance.locale === "zh" ? "本地待发送" : "Waiting to send locally")
    await until(
      () => api.state.requests.filter((r) => r.path.endsWith("/read")).length >= 2,
      "initial and handshake reads",
    )
    api.state.requests.length = 0
    const delayed = Promise.withResolvers<void>()
    api.state.messages = [message("first", "acknowledged")]
    api.state.pending = delayed.promise
    ui.app.mockInput.pressKey("r", { ctrl: true })
    await until(() => api.state.requests.length === 1)
    ui.app.mockInput.pressKey("r", { ctrl: true })
    await Bun.sleep(20)
    expect(api.state.requests).toEqual([
      { method: "GET", path: "/api/v1/im/groups/team/messages", limit: "50", cursor: null },
    ])
    api.state.pending = undefined
    delayed.resolve()
    const frame = await ui.frame(appearance.locale === "zh" ? "服务已应答" : "Service acknowledged")
    expect(frame.replace(/[\s█]+/g, "")).toContain(api.state.messages[0].content.replace(/\s+/g, ""))
    expect(frame.replace(/[\s█]+/g, appearance.locale === "zh" ? "" : " ")).toContain(
      appearance.locale === "zh" ? "尚未核实" : "has not been verified",
    )
    expect(api.state.requests).toHaveLength(1)
    api.emit(message("first", "prepared"))
    await Bun.sleep(30)
    expect(await ui.frame(appearance.locale === "zh" ? "服务已应答" : "Service acknowledged")).not.toContain(
      appearance.locale === "zh" ? "本地待发送" : "Waiting to send locally",
    )
    api.state.messages = [message("first", "unknown", "receipt_mismatch")]
    ui.app.mockInput.pressKey("r", { ctrl: true })
    await ui.frame(appearance.locale === "zh" ? "发送结果待核对" : "Delivery outcome needs checking")
    expect(api.state.requests.filter((r) => r.method !== "GET")).toHaveLength(0)
    const output = process.env.DAC_IM_TRANSPORT_EVIDENCE
    if (output)
      await Bun.write(
        `${output}/tui-${appearance.width}-${appearance.locale}-${appearance.mode}.txt`,
        ui.app.captureCharFrame(),
      )
    ui.app.renderer.destroy()
    await until(() => api.sockets.size === 0, "owned socket disposed")
  })
}

test("old HTTP page cannot replace later create receipt; refresh failure retains message and does not resend", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat client={createIMClient(api.sdk)} sdk={api.sdk} group={group} back={() => {}} />
  ))
  await ui.frame("Waiting to send locally")
  await until(() => api.state.requests.filter((r) => r.path.endsWith("/read")).length >= 2)
  api.state.requests.length = 0
  const delayed = Promise.withResolvers<void>()
  api.state.messages = [message("sent", "unknown")]
  api.state.pending = delayed.promise
  ui.app.mockInput.pressKey("r", { ctrl: true })
  await until(() => api.state.requests.length === 1)
  ui.app.mockInput.pressKey("s", { ctrl: true })
  await ui.type("new reply")
  ui.app.mockInput.pressEnter()
  await ui.frame("Service acknowledged")
  api.state.pending = undefined
  delayed.resolve()
  await Bun.sleep(20)
  expect(await ui.frame("Service acknowledged")).toContain("new reply")
  expect(api.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/messages"))).toHaveLength(1)
  expect(api.state.requests.filter((r) => r.path.endsWith("/read"))).toHaveLength(0)
  api.state.failed = true
  ui.app.mockInput.pressKey("r", { ctrl: true })
  await ui.frame("Status refresh failed")
  expect(await ui.frame("Service acknowledged")).toContain("new reply")
  expect(api.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/messages"))).toHaveLength(1)
})

test("switching server for the same group discards old in-flight observations and sockets", async () => {
  await using tmp = await tmpdir()
  using previous = fixture(tmp.path)
  using next = fixture(tmp.path)
  next.state.messages = [message("next-server", "unknown", "delivery_identity_or_expiry_changed")]
  const [sdk, setSDK] = createSignal(previous.sdk)
  using ui = await mountIM(tmp.path, previous.sdk.url, () => (
    <DialogIMChat client={createIMClient(sdk())} sdk={sdk()} group={group} identity={sdk().url} back={() => {}} />
  ))
  await ui.frame("Waiting to send locally")
  await until(() => previous.state.requests.filter((r) => r.path.endsWith("/read")).length >= 2)
  const delayed = Promise.withResolvers<void>()
  previous.state.pending = delayed.promise
  previous.state.messages = [message("old-secret", "acknowledged")]
  const count = previous.state.requests.length
  ui.app.mockInput.pressKey("r", { ctrl: true })
  await until(() => previous.state.requests.length > count)
  setSDK(next.sdk)
  await ui.frame("next-server")
  delayed.resolve()
  await Bun.sleep(30)
  const frame = await ui.frame("Delivery outcome needs checking")
  expect(frame).not.toContain("old-secret")
  expect(frame).not.toContain("Service acknowledged")
  await until(() => previous.sockets.size === 0, "old scoped socket closed")
})

test("real websocket creation before delayed POST receipt converges to service ACK without retry", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat client={createIMClient(api.sdk)} sdk={api.sdk} group={group} back={() => {}} />
  ))
  await ui.frame("Waiting to send locally")
  await until(() => api.state.requests.filter((r) => r.path.endsWith("/read")).length >= 2)
  const pending = Promise.withResolvers<void>()
  api.state.postPending = pending.promise
  api.state.echo = true
  ui.app.mockInput.pressKey("s", { ctrl: true })
  await ui.type("echo before receipt")
  ui.app.mockInput.pressEnter()
  await until(() => api.state.requests.some((r) => r.method === "POST" && r.path.endsWith("/messages")))
  await Bun.sleep(30)
  pending.resolve()
  expect(await ui.frame("Service acknowledged")).toContain("echo before receipt")
  expect(api.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/messages"))).toHaveLength(1)
})
