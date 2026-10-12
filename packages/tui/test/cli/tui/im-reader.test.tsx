/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { ServerWebSocket } from "bun"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { DialogIMChat } from "../../../src/component/dialog-im"
import { createIMClient, type IMGroup, type IMMessage, type IMReadAction } from "../../../src/component/im-client"
import { tmpdir } from "../../fixture/fixture"
import { mountIM, until } from "../../fixture/im-environment"

const group: IMGroup = {
  id: "img_kr_fixture",
  name: "受保护会话",
  workspaceID: "fixture",
  projectID: null,
  type: "direct",
  createdBy: "self",
  kernelConvID: "kr1:fixture",
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  reader: { mode: "protected", state: "ready", liveUnread: "9007199254740993" },
}
const message = (content: string): IMMessage => ({
  id: content,
  groupID: group.id,
  senderID: "peer",
  senderType: "user",
  type: "text",
  content,
  mentions: null,
  metadata: null,
  replyToID: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
})
function fixture(directory: string) {
  const sockets = new Set<ServerWebSocket<undefined>>()
  const state = {
    content: "protected first",
    epoch: "e1",
    reads: [] as IMReadAction[],
    gets: 0,
    expiry: 60000,
    pending: undefined as Promise<void> | undefined,
    readPending: undefined as Promise<void> | undefined,
    failed: false,
    readRefused: false,
    readState: "unknown" as "unknown" | "partial" | "confirmed" | "cancelled",
    wsWrites: [] as string[],
    legacy: false,
    refreshes: 0,
    refreshPending: undefined as Promise<void> | undefined,
    detailReads: 0,
    refreshRefused: false,
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
      if (url.pathname.endsWith("/refresh") || url.pathname === `/api/v1/im/groups/${group.id}`) {
        if (request.method === "POST") {
          state.refreshes++
          if (await request.text()) return new Response("unexpected body", { status: 400 })
          if (state.refreshRefused)
            return Response.json({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable" } }, { status: 503 })
          await state.refreshPending
        }
        if (request.method === "GET") state.detailReads++
        return Response.json({ version: 1, group: { ...group, name: "Verified remote group" },
          reader: { displayEpoch: state.epoch, proofWindowMs: 1000, nextExpiryAt: null } })
      }
      if (url.pathname.endsWith("/read")) {
        const body = (await request.json()) as IMReadAction
        state.reads.push(body)
        await state.readPending
        if (state.readRefused)
          return Response.json({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable" } }, { status: 503 })
        return Response.json({
          ok: state.readState === "confirmed",
          reader: {
            actionID: body.actionID,
            state: state.readState,
            targetAdmitted: "9007199254740995",
            readOrdinal: "9007199254740993",
            liveUnread: "2",
          },
        })
      }
      state.gets++
      const page = {
        messages: [message(state.content)],
        nextCursor: null,
        hasMore: false,
        reader: {
          state: "ready",
          displayEpoch: state.epoch,
          projectionRevision: "9007199254740993",
          validatedServerNow: 1000,
          nextExpiryAt: 1000 + state.expiry,
        },
      }
      await state.pending
      if (state.failed)
        return Response.json({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable" } }, { status: 503 })
      return Response.json(state.legacy ? { messages: page.messages, nextCursor: null, hasMore: false } : page)
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
      },
      close(socket) {
        sockets.delete(socket)
      },
      message(_socket, data) {
        state.wsWrites.push(String(data))
      },
    },
  })
  const url = server.url.toString().replace(/\/$/, "")
  const sdk = {
    url,
    directory,
    client: createOpencodeClient({ baseUrl: url, headers: { Authorization: "Bearer fixture-token" } }),
  }
  return {
    sdk,
    state,
    sockets,
    emit(type: string) {
      for (const socket of sockets)
        socket.send(
          JSON.stringify({ type, data: { groupID: group.id, displayEpoch: state.epoch, code: "reader_unavailable" } }),
        )
    },
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

test("explicit protected TUI metadata refresh joins clicks then reads detail and body without sending names", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  const client = createIMClient(api.sdk)
  const [observed, setObserved] = createSignal(group)
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat sdk={api.sdk} client={client} group={observed()} back={() => {}}
      metadataRefreshed={async () => { setObserved((await client.getGroup(group.id)).group) }} />
  ))
  await ui.frame("protected first")
  expect(api.state.refreshes).toBe(0)
  const gate = Promise.withResolvers<void>()
  api.state.refreshPending = gate.promise
  const gets = api.state.gets
  ui.app.mockInput.pressKey("r", { ctrl: true })
  await until(() => api.state.refreshes === 1)
  ui.app.mockInput.pressKey("r", { ctrl: true })
  await Bun.sleep(20)
  expect(api.state.refreshes).toBe(1)
  expect(api.state.detailReads).toBe(0)
  expect(api.state.gets).toBe(gets)
  gate.resolve()
  await ui.frame("Verified remote group")
  await until(() => api.state.gets > gets)
  expect(api.state.detailReads).toBe(1)
  expect(api.state.reads).toHaveLength(0)
  expect(api.state.wsWrites).toHaveLength(0)
})
test("failed protected TUI metadata refresh withdraws old body without follow-up reads or retry", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat sdk={api.sdk} client={createIMClient(api.sdk)} group={group} back={() => {}} />
  ))
  await ui.frame("protected first")
  const gets = api.state.gets
  api.state.refreshRefused = true
  ui.app.mockInput.pressKey("r", { ctrl: true })
  expect(await ui.frame("Status refresh failed")).not.toContain("protected first")
  expect(api.state.refreshes).toBe(1)
  expect(api.state.detailReads).toBe(0)
  expect(api.state.gets).toBe(gets)
  expect(api.state.reads).toHaveLength(0)
  expect(api.state.wsWrites).toHaveLength(0)
})

test("actual protected TUI uses body-free updates and one explicit read action through unknown/partial/confirmed", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat sdk={api.sdk} client={createIMClient(api.sdk)} group={group} back={() => {}} />
  ))
  await ui.frame("protected first")
  expect(api.state.reads).toHaveLength(0)
  api.state.content = "protected second"
  api.emit("reader_changed")
  await ui.frame("protected second")
  ui.app.mockInput.pressKey("k", { ctrl: true })
  await until(() => api.state.reads.length === 1)
  await ui.frame("Check the same read action")
  api.state.readState = "partial"
  ui.app.mockInput.pressKey("k", { ctrl: true })
  await until(() => api.state.reads.length === 2)
  await ui.frame("Continue the same read action")
  api.state.readState = "confirmed"
  ui.app.mockInput.pressKey("k", { ctrl: true })
  await until(() => api.state.reads.length === 3)
  await ui.frame("Read status confirmed")
  expect(new Set(api.state.reads.map((value) => value.actionID)).size).toBe(1)
  expect(api.state.reads[0].actionID).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  expect(api.state.reads[1].reconcile).toBe(true)
  expect(api.state.reads[2].continue).toBe(true)
  expect(api.state.wsWrites.some((value) => value.includes("read_receipt"))).toBe(false)
  api.emit("reader_invalidated")
  const frame = await ui.frame("content has been cleared.")
  expect(frame).not.toContain("protected first")
  expect(frame).not.toContain("protected second")
})

test("protected TUI fences late HTTP after disconnection", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  const client = createIMClient(api.sdk)
  using ui = await mountIM(
    tmp.path,
    api.sdk.url,
    () => <DialogIMChat sdk={api.sdk} client={client} group={group} back={() => {}} />,
    50,
    undefined,
    { locale: "zh", mode: "light" },
  )
  await ui.frame("protected first")
  const late = Promise.withResolvers<void>()
  api.state.content = "late forbidden body"
  api.state.pending = late.promise
  ui.app.mockInput.pressKey("r", { ctrl: true })
  await until(() => api.state.gets >= 2)
  for (const socket of api.sockets) socket.close()
  await ui.frame("受保护内容已清除")
  late.resolve()
  await Bun.sleep(30)
  expect(ui.app.captureCharFrame()).not.toContain("late forbidden body")
  expect(api.state.reads).toHaveLength(0)
})

test("protected pending mapping never marks read and an expired page never renders", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.expiry = 0
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat
      sdk={api.sdk}
      client={createIMClient(api.sdk)}
      group={{ ...group, reader: { mode: "protected", state: "pending", liveUnread: null } }}
      back={() => {}}
    />
  ))
  await ui.frame("Waiting for the conversation")
  ui.app.mockInput.pressKey("k", { ctrl: true })
  await Bun.sleep(30)
  expect(api.state.reads).toHaveLength(0)
  expect(ui.app.captureCharFrame()).not.toContain("protected first")
})

test("legacy kernel mirror without reader proof stays hidden even on HTTP 200", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.legacy = true
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat
      sdk={api.sdk}
      client={createIMClient(api.sdk)}
      group={{ ...group, kernelConvID: "k:2:old", reader: undefined }}
      back={() => {}}
    />
  ))
  await ui.frame("content has been cleared.")
  expect(api.state.gets).toBeGreaterThan(0)
  expect(ui.app.captureCharFrame()).not.toContain("protected first")
  expect(api.state.reads).toHaveLength(0)
})

test("five-second TUI head observation catches a lost notification without marking read", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat sdk={api.sdk} client={createIMClient(api.sdk)} group={group} back={() => {}} />
  ))
  await ui.frame("protected first")
  api.state.content = "lost notification recovered"
  await until(() => api.state.gets >= 2, "bounded head poll", 6000)
  await ui.frame("lost notification recovered")
  expect(api.state.reads).toHaveLength(0)
  expect(api.state.gets).toBe(2)
}, 10000)

// Explicitly opt in with the private production fixture. This path exercises the
// actual renderer, HTTP facade and kernel-backed reader; it never creates a server.
test.skipIf(!process.env.DAC_IM_READER_PRODUCT_CONFIG)(
  "private production reader renders the real DM and group and marks each only through keyboard action",
  async () => {
    const { SDKProvider } = await import("../../../src/context/sdk")
    const { DialogIM } = await import("../../../src/component/dialog-im")
    const { eventSource } = await import("../../fixture/tui-sdk")
    const configPath = process.env.DAC_IM_READER_PRODUCT_CONFIG!
    if (!configPath.includes("/dac-reader-product-20261007-")) throw new Error("Private product fixture required")
    const config: unknown = await Bun.file(configPath).json()
    if (
      !config ||
      typeof config !== "object" ||
      !("backend" in config) ||
      typeof config.backend !== "string" ||
      !("workspace" in config) ||
      typeof config.workspace !== "string" ||
      !("basicUsername" in config) ||
      typeof config.basicUsername !== "string" ||
      !("basicPassword" in config) ||
      typeof config.basicPassword !== "string"
    )
      throw new Error("Private product fixture config is incomplete")
    if (new URL(config.backend).hostname !== "127.0.0.1" || !config.basicPassword)
      throw new Error("Private loopback fixture required")
    const cases: unknown = await Bun.file(process.env.DAC_IM_READER_PRODUCT_CASES!).json()
    if (!Array.isArray(cases) || cases.length !== 2) throw new Error("Two real conversation cases required")
    const headers = {
      Authorization: `Basic ${Buffer.from(`${config.basicUsername}:${config.basicPassword}`).toString("base64")}`,
    }
    const requests: { action: unknown; status: number; result: unknown }[] = []
    const productFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const action =
          request.method === "POST" && new URL(request.url).pathname.endsWith("/read")
            ? await request.clone().json()
            : undefined
        const response = await fetch(request)
        if (action) {
          requests.push({ action, status: response.status, result: await response.clone().json() })
          await Bun.write(
            `${process.env.DAC_IM_READER_PRODUCT_OUTPUT}/read-requests.json`,
            JSON.stringify(requests, null, 2),
          )
        }
        return response
      },
      { preconnect: fetch.preconnect },
    )
    const sdk = {
      url: config.backend,
      directory: config.workspace,
      client: createOpencodeClient({ baseUrl: config.backend, headers }),
      fetch: productFetch,
    }
    const client = createIMClient(sdk)
    const groups = await client.listGroups()
    const evidence = []
    for (const item of cases) {
      if (
        !item ||
        typeof item !== "object" ||
        !("groupID" in item) ||
        typeof item.groupID !== "string" ||
        !("content" in item) ||
        typeof item.content !== "string"
      )
        throw new Error("Invalid private case")
      const target = groups.find((value) => value.id === item.groupID)
      if (!target?.reader || target.reader.state !== "ready") throw new Error("Actual protected group is not ready")
      await using tmp = await tmpdir()
      using ui = await mountIM(
        tmp.path,
        sdk.url,
        () => (
          <SDKProvider
            url={sdk.url}
            directory={sdk.directory}
            headers={headers}
            fetch={productFetch}
            events={eventSource()}
          >
            <DialogIM />
          </SDKProvider>
        ),
        100,
        undefined,
        { locale: "zh", mode: "dark" },
      )
      await ui.frame("身份已就绪")
      await ui.select(target.name)
      const before = await ui.frame(item.content)
      await Bun.write(`${process.env.DAC_IM_READER_PRODUCT_OUTPUT}/${target.type}-before.txt`, before)
      const readBefore = (await client.listGroups()).find((value) => value.id === item.groupID)?.reader?.liveUnread
      expect(readBefore).not.toBe("0")
      ui.app.mockInput.pressKey("k", { ctrl: true })
      const after = await ui.frame("已读状态已确认")
      await Bun.write(`${process.env.DAC_IM_READER_PRODUCT_OUTPUT}/${target.type}-after.txt`, after)
      const readAfter = (await client.listGroups()).find((value) => value.id === item.groupID)?.reader?.liveUnread
      expect(readAfter).toBe("0")
      evidence.push({
        groupID: item.groupID,
        content: item.content,
        readBefore,
        readAfter,
        rendered: true,
        action: "Ctrl+K",
      })
    }
    await Bun.write(`${process.env.DAC_IM_READER_PRODUCT_OUTPUT}/tui-product.json`, JSON.stringify(evidence, null, 2))
  },
  30000,
)

test("actual TUI keeps read singleflight through invalidation and fresh same-scope body proof", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat sdk={api.sdk} client={createIMClient(api.sdk)} group={group} back={() => {}} />
  ))
  await ui.frame("protected first")
  const receipt = Promise.withResolvers<void>()
  api.state.readPending = receipt.promise
  api.state.readState = "confirmed"
  ui.app.mockInput.pressKey("k", { ctrl: true })
  await until(() => api.state.reads.length === 1)
  api.emit("reader_invalidated")
  await ui.frame("content has been cleared.")
  api.emit("reader_changed")
  await ui.frame("protected first")
  ui.app.mockInput.pressKey("k", { ctrl: true })
  await Bun.sleep(20)
  expect(api.state.reads).toHaveLength(1)
  receipt.resolve()
  await ui.frame("Read status confirmed")
  expect(api.state.reads).toHaveLength(1)
})

test("actual TUI clears protected content on a read refusal and does not retry", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat sdk={api.sdk} client={createIMClient(api.sdk)} group={group} back={() => {}} />
  ))
  await ui.frame("protected first")
  api.state.readRefused = true
  ui.app.mockInput.pressKey("k", { ctrl: true })
  const frame = await ui.frame("content has been cleared.")
  expect(frame).not.toContain("protected first")
  expect(api.state.reads).toHaveLength(1)
})

test("actual TUI restores unknown action from server metadata with no automatic read and continues only that action", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat
      sdk={api.sdk}
      client={createIMClient(api.sdk)}
      group={{
        ...group,
        reader: {
          ...group.reader!,
          readAction: {
            actionID: "original_action",
            cutID: "original_cut",
            phase: "unknown",
            cutIndex: 0,
            targetAdmitted: "9",
            throughOrdinal: "4",
            targetReached: false,
          },
        },
      }}
      back={() => {}}
    />
  ))
  await ui.frame("protected first")
  expect(api.state.reads).toHaveLength(0)
  api.state.readState = "partial"
  ui.app.mockInput.pressKey("k", { ctrl: true })
  await ui.frame("Continue the same read action")
  expect(api.state.reads[0]).toEqual({ actionID: "original_action", reconcile: true })
  api.state.readState = "confirmed"
  ui.app.mockInput.pressKey("k", { ctrl: true })
  await ui.frame("Read status confirmed")
  expect(api.state.reads[1]).toEqual({ actionID: "original_action", continue: true })
})

test.each(["unknown", "dispatched"] as const)(
  "actual TUI keeps a reached %s action unresolved with its original ID",
  async (phase) => {
    await using tmp = await tmpdir()
    using api = fixture(tmp.path)
    using ui = await mountIM(tmp.path, api.sdk.url, () => (
      <DialogIMChat
        sdk={api.sdk}
        client={createIMClient(api.sdk)}
        group={{
          ...group,
          reader: {
            ...group.reader!,
            readAction: {
              actionID: "reached_unknown_action",
              cutID: "reached_unknown_cut",
              phase,
              cutIndex: 0,
              targetAdmitted: "9",
              throughOrdinal: "9",
              targetReached: true,
            },
          },
        }}
        back={() => {}}
      />
    ))
    const frame = await ui.frame("protected first")
    expect(api.state.reads).toHaveLength(0)
    expect(frame).not.toContain("Mark current messages read")
    ui.app.mockInput.pressKey("k", { ctrl: true })
    await until(() => api.state.reads.length === 1)
    expect(api.state.reads[0]).toEqual({ actionID: "reached_unknown_action", reconcile: true })
    expect((await ui.frame("unconfirmed.")).replace(/\s+/g, " ")).toContain(
      "These messages are currently read; the original action is still unconfirmed.",
    )
    ui.app.mockInput.pressKey("k", { ctrl: true })
    await until(() => api.state.reads.length === 2)
    expect(api.state.reads[1]).toEqual(api.state.reads[0])
  },
)

test("actual TUI restores prepared read intent and Ctrl+X cancels only the undispatched action", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat
      sdk={api.sdk}
      client={createIMClient(api.sdk)}
      group={{
        ...group,
        reader: {
          ...group.reader!,
          readAction: {
            actionID: "prepared_action",
            cutID: "prepared_cut",
            phase: "prepared",
            cutIndex: 0,
            targetAdmitted: "9",
            throughOrdinal: "4",
            targetReached: false,
          },
        },
      }}
      back={() => {}}
    />
  ))
  await ui.frame("protected first")
  expect(api.state.reads).toHaveLength(0)
  await ui.frame("Resume the prepared read action")
  api.state.readState = "cancelled"
  ui.app.mockInput.pressKey("x", { ctrl: true })
  const frame = await ui.frame("Read action cancelled before dispatch")
  expect(api.state.reads).toEqual([{ actionID: "prepared_action", cancel: true }])
  expect(frame).not.toContain("Read status confirmed")
})

test("actual TUI pages both conversation lanes and refreshes an off-page selection by ID", async () => {
  const { SDKProvider } = await import("../../../src/context/sdk")
  const { DialogIM } = await import("../../../src/component/dialog-im")
  const { eventSource } = await import("../../fixture/tui-sdk")
  await using tmp = await tmpdir()
  const conversations: IMGroup[] = [
    { ...group, id: "protected_a", name: "Protected Alpha" },
    { ...group, id: "protected_b", name: "Protected Beta" },
    { ...group, id: "protected_c", name: "Protected Gamma" },
    { ...group, id: "ordinary_a", name: "Ordinary Alpha", kernelConvID: null, reader: undefined },
  ]
  const calls = { legacy: 0, ordinary: [] as string[], protected: [] as string[], details: [] as string[], reads: 0 }
  const envelope = () => ({
    displayEpoch: "page_epoch",
    proofWindowMs: 1000,
    validatedServerNow: Date.now(),
    nextExpiryAt: Date.now() + 60000,
  })
  const server = Bun.serve({
    port: 0,
    async fetch(request, host) {
      const url = new URL(request.url)
      if (request.headers.get("authorization") !== "Bearer fixture-token")
        return new Response("denied", { status: 401 })
      if (url.pathname.startsWith("/ws/")) {
        if (host.upgrade(request)) return
        return new Response("upgrade", { status: 400 })
      }
      if (url.pathname.endsWith("/status"))
        return Response.json({
          facade: "active",
          identity: { uuid: "self", name: "Fixture Self", orgID: 1, orgAllGroupID: "all" },
          blocked: null,
          keyOrigin: "stored",
          kernel: "connected",
          reader: { state: "ready", displayEpoch: "page_epoch", legacyMirrorUnavailable: true },
        })
      if (url.pathname.endsWith("/groups")) {
        calls.legacy++
        return Response.json(conversations)
      }
      if (url.pathname.endsWith("/groups/page")) {
        const lane = url.searchParams.get("lane")
        if (lane !== "ordinary" && lane !== "protected") return new Response("lane", { status: 400 })
        const cursor = url.searchParams.get("cursor") ?? ""
        calls[lane].push(cursor)
        const rows =
          lane === "ordinary" ? conversations.slice(3) : cursor ? conversations.slice(2, 3) : conversations.slice(0, 2)
        return Response.json({
          version: 1,
          lane,
          groups: rows,
          hasMore: lane === "protected" && !cursor,
          nextCursor: lane === "protected" && !cursor ? "page_tail" : null,
          ...(lane === "protected" ? { reader: envelope() } : {}),
        })
      }
      if (url.pathname.endsWith("/read")) {
        calls.reads++
        return new Response("unexpected read", { status: 500 })
      }
      const detail = /^\/api\/v1\/im\/groups\/([^/]+)$/.exec(url.pathname)
      if (detail) {
        calls.details.push(detail[1])
        const found = conversations.find((value) => value.id === detail[1])
        return found
          ? Response.json({ version: 1, group: found, ...(found.reader ? { reader: envelope() } : {}) })
          : new Response("missing", { status: 404 })
      }
      if (url.pathname.endsWith("/agents")) return Response.json([])
      if (url.pathname.endsWith("/messages"))
        return Response.json({
          messages: [{ ...message("Off-page protected body"), groupID: "protected_c" }],
          hasMore: false,
          nextCursor: null,
          reader: { ...envelope(), state: "ready", projectionRevision: "1" },
        })
      return new Response("missing", { status: 404 })
    },
    websocket: { message() {} },
  })
  using resource = { [Symbol.dispose]: () => server.stop(true) }
  using ui = await mountIM(tmp.path, server.url.toString(), () => (
    <SDKProvider
      url={server.url.toString()}
      directory={tmp.path}
      events={eventSource()}
      headers={{ Authorization: "Bearer fixture-token" }}
    >
      <DialogIM />
    </SDKProvider>
  ))
  await ui.frame("Shared IM ready")
  expect(calls.legacy).toBe(0)
  expect(calls.protected).toEqual([""])
  expect(ui.app.captureCharFrame()).not.toContain("Protected Gamma")
  await ui.select("Load more remote conversations")
  await until(() => calls.protected.length === 2, "explicit next page")
  expect(calls.protected).toEqual(["", "page_tail"])
  await ui.select("Protected Gamma")
  await ui.frame("Off-page protected body")
  await until(() => calls.details.filter((id) => id === "protected_c").length >= 2, "selected detail refresh", 6500)
  expect(ui.app.captureCharFrame()).toContain("Off-page protected body")
  expect(calls.legacy).toBe(0)
  expect(calls.reads).toBe(0)
}, 12000)

test.skipIf(!process.env.DAC_IM_READER_PRODUCT_PAGINATION)(
  "private production reader paginates both lanes and opens an off-page conversation without mutations",
  async () => {
    const { SDKProvider } = await import("../../../src/context/sdk")
    const { DialogIM } = await import("../../../src/component/dialog-im")
    const { eventSource } = await import("../../fixture/tui-sdk")
    const configPath = process.env.DAC_IM_READER_PRODUCT_PAGINATION!
    if (!configPath.includes("/dac-reader-product-20261007-")) throw new Error("Private product fixture required")
    const config: unknown = await Bun.file(configPath).json()
    if (
      !config ||
      typeof config !== "object" ||
      !("backend" in config) ||
      typeof config.backend !== "string" ||
      !("workspace" in config) ||
      typeof config.workspace !== "string" ||
      !("basicUsername" in config) ||
      typeof config.basicUsername !== "string" ||
      !("basicPassword" in config) ||
      typeof config.basicPassword !== "string" ||
      new URL(config.backend).hostname !== "127.0.0.1" ||
      !config.basicPassword
    )
      throw new Error("Private loopback fixture config is incomplete")
    const connection = { url: config.backend, directory: config.workspace }
    const output = process.env.DAC_IM_READER_PRODUCT_OUTPUT
    if (!output?.startsWith("/tmp/dac-im-reader-ui-20261007-")) throw new Error("Private evidence directory required")
    const requests: {
      method: string
      path: string
      lane: string | null
      cursor: boolean
      status: number
      count?: number
    }[] = []
    const productFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (request.method !== "GET") throw new Error("Read-only pagination fixture forbids mutations")
        const response = await fetch(request)
        const body: unknown = url.pathname.endsWith("/groups/page") ? await response.clone().json() : undefined
        requests.push({
          method: request.method,
          path: url.pathname,
          lane: url.searchParams.get("lane"),
          cursor: url.searchParams.has("cursor"),
          status: response.status,
          count:
            body && typeof body === "object" && "groups" in body && Array.isArray(body.groups)
              ? body.groups.length
              : undefined,
        })
        await Bun.write(`${output}/requests.json`, JSON.stringify(requests, null, 2))
        return response
      },
      { preconnect: fetch.preconnect },
    )
    await using tmp = await tmpdir()
    using ui = await mountIM(
      tmp.path,
      connection.url,
      () => (
        <SDKProvider
          url={connection.url}
          directory={connection.directory}
          headers={{
            Authorization: `Basic ${Buffer.from(`${config.basicUsername}:${config.basicPassword}`).toString("base64")}`,
          }}
          fetch={productFetch}
          events={eventSource()}
        >
          <DialogIM />
        </SDKProvider>
      ),
      100,
      undefined,
      { locale: "zh", mode: "dark" },
    )
    const first = await ui.frame("身份已就绪")
    await until(() => requests.some((value) => value.lane === "protected" && value.count === 2), "first protected page")
    expect(requests.find((value) => value.lane === "ordinary")?.count).toBe(32)
    expect(requests.some((value) => value.cursor)).toBe(false)
    await Bun.write(`${output}/first-page.txt`, first)
    await ui.type("加载更多本地会话", true)
    await ui.frame("加载更多本地会话")
    ui.app.mockInput.pressEnter()
    await until(
      () => requests.some((value) => value.lane === "ordinary" && value.cursor),
      "ordinary explicit next page",
    )
    await ui.type("加载更多远端会话", true)
    await ui.frame("加载更多远端会话")
    ui.app.mockInput.pressEnter()
    await until(
      () => requests.some((value) => value.lane === "protected" && value.cursor),
      "protected explicit next page",
    )
    expect(requests.find((value) => value.lane === "ordinary" && value.cursor)?.count).toBe(2)
    expect(requests.find((value) => value.lane === "protected" && value.cursor)?.count).toBe(1)
    await ui.type("alice", true)
    await ui.frame("@ alice")
    ui.app.mockInput.pressEnter()
    await Bun.write(`${output}/off-page-alice.txt`, await ui.frame("已读操作已在派发前取消"))
    const selectedPath = "/api/v1/im/groups/img_kr_8df816493db62c49a8771fa2569d26e72fa4362caf029edf3dc360479ce95368"
    await until(
      () => requests.filter((value) => value.path === selectedPath && value.status === 200).length >= 2,
      "fresh selected detail",
      6500,
    )
    ui.app.mockInput.pressEscape()
    await ui.type("g4da96ecd190251a42938f06e", true)
    await ui.frame("# g4da96ecd190251a42938f06e")
    ui.app.mockInput.pressEnter()
    await Bun.write(`${output}/third-group-body.txt`, await ui.frame("REAL_READER_PAGE_GROUP226_20261007"))
    expect(requests.some((value) => value.path === "/api/v1/im/groups")).toBe(false)
    expect(requests.every((value) => value.method === "GET")).toBe(true)
    await Bun.write(
      `${output}/result.json`,
      JSON.stringify(
        { ordinary: [32, 2], protected: [2, 1], offPageFresh: true, actualBody: true, mutations: 0 },
        null,
        2,
      ),
    )
  },
  20000,
)

test("protected expiry aborts shared refresh without stranding ordinary or releasing its successor", async () => {
  const { SDKProvider } = await import("../../../src/context/sdk")
  const { DialogIM } = await import("../../../src/component/dialog-im")
  const { eventSource } = await import("../../fixture/tui-sdk")
  await using tmp = await tmpdir()
  const old = Promise.withResolvers<void>()
  const next = Promise.withResolvers<void>()
  const calls = { ordinary: 0, held: false, returned: false }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "GET" || request.headers.get("authorization") !== "Bearer fixture-token")
        return new Response("denied", { status: 403 })
      if (url.pathname.endsWith("/status"))
        return Response.json({
          facade: "active",
          identity: { uuid: "self", name: "Self", orgID: 1, orgAllGroupID: "all" },
          blocked: null,
          keyOrigin: "stored",
          kernel: "connected",
          reader: { state: "ready", displayEpoch: "expiry_epoch", legacyMirrorUnavailable: true },
        })
      if (!url.pathname.endsWith("/groups/page")) return new Response("unexpected", { status: 404 })
      const lane = url.searchParams.get("lane")
      if (lane === "ordinary") {
        const attempt = ++calls.ordinary
        if (attempt === 3) await next.promise
        return Response.json({
          version: 1,
          lane,
          hasMore: false,
          nextCursor: null,
          groups: [
            {
              ...group,
              id: `ordinary_${attempt}`,
              name: attempt === 1 ? "Ordinary preserved" : attempt === 2 ? "Stale ordinary" : "Ordinary recovered",
              kernelConvID: null,
              reader: undefined,
            },
          ],
        })
      }
      return Response.json({
        version: 1,
        lane,
        groups: [group],
        hasMore: false,
        nextCursor: null,
        reader: {
          displayEpoch: "expiry_epoch",
          proofWindowMs: 1000,
          validatedServerNow: Date.now(),
          nextExpiryAt: Date.now() + 500,
        },
      })
    },
  })
  using resource = {
    [Symbol.dispose]: () => {
      old.resolve()
      next.resolve()
      server.stop(true)
    },
  }
  const delayed = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const response = await fetch(request)
      if (url.searchParams.get("lane") === "ordinary" && calls.ordinary === 2 && !calls.held) {
        calls.held = true
        await old.promise
        calls.returned = true
      }
      return response
    },
    { preconnect: fetch.preconnect },
  )
  using ui = await mountIM(tmp.path, server.url.toString(), () => (
    <SDKProvider
      url={server.url.toString()}
      directory={tmp.path}
      headers={{ Authorization: "Bearer fixture-token" }}
      fetch={delayed}
      events={eventSource()}
    >
      <DialogIM />
    </SDKProvider>
  ))
  await ui.frame("Ordinary preserved")
  await ui.select("Refresh status and conversations")
  await until(() => calls.held, "old ordinary response delayed")
  await Bun.sleep(550)
  await ui.select("Refresh status and conversations")
  await until(() => calls.ordinary === 3, "ordinary request after protected abort")
  old.resolve()
  await until(() => calls.returned, "late predecessor response")
  await ui.select("Refresh status and conversations")
  expect(calls.ordinary).toBe(3)
  next.resolve()
  await ui.type("Ordinary", true)
  const frame = await ui.frame("Ordinary recovered")
  expect(frame).toContain("Ordinary preserved")
  expect(frame).not.toContain("Stale ordinary")
}, 6000)

test("actual TUI independently marks new messages and keeps the old unknown action across reopen", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  const old = {
    actionID: "old_unknown",
    cutID: "old_cut",
    phase: "unknown" as const,
    cutIndex: 0,
    targetAdmitted: "9007199254740993",
    throughOrdinal: "9007199254740993",
    targetReached: true,
  }
  const [current, setCurrent] = createSignal<IMGroup>({
    ...group,
    reader: {
      ...group.reader!,
      admittedOrdinal: "9007199254740993",
      liveUnread: "1",
      readAction: old,
      unresolvedReadActions: [old],
    },
  })
  {
    using ui = await mountIM(tmp.path, api.sdk.url, () => (
      <DialogIMChat sdk={api.sdk} client={createIMClient(api.sdk)} group={current()} back={() => {}} />
    ))
    await ui.frame("protected first")
    expect(api.state.reads).toHaveLength(0)
    expect(ui.app.captureCharFrame()).not.toContain("Mark new messages as read")
    setCurrent({ ...current(), reader: { ...current().reader!, admittedOrdinal: "9007199254740994" } })
    await ui.frame("Mark new messages as read")
    api.state.readState = "confirmed"
    ui.app.mockInput.pressKey("n", { ctrl: true })
    await ui.frame("Read status confirmed")
    expect(api.state.reads).toHaveLength(1)
    expect(api.state.reads[0]).toEqual({ actionID: expect.stringMatching(/^tui-read_/), newAction: true })
    expect(api.state.reads[0].actionID).not.toBe(old.actionID)
  }
  setCurrent({
    ...current(),
    reader: {
      ...current().reader!,
      liveUnread: "0",
      readAction: {
        ...old,
        actionID: api.state.reads[0].actionID,
        cutID: "new_cut",
        phase: "confirmed",
        targetAdmitted: "9007199254740994",
        throughOrdinal: "9007199254740994",
      },
    },
  })
  using ui = await mountIM(tmp.path, api.sdk.url, () => (
    <DialogIMChat sdk={api.sdk} client={createIMClient(api.sdk)} group={current()} back={() => {}} />
  ))
  await ui.frame("protected first")
  const reopened = await ui.frame("Read status confirmed")
  expect(reopened).toContain(old.actionID)
  expect(api.state.reads).toHaveLength(1)
  api.emit("reader_invalidated")
  await ui.frame("currently unavailable")
  setCurrent({ ...current(), reader: { ...current().reader!, readAction: { ...current().reader!.readAction! } } })
  api.emit("reader_changed")
  await ui.frame("protected first")
  await ui.frame("Read status confirmed")
  expect(api.state.reads).toHaveLength(1)
  api.state.readState = "unknown"
  ui.app.mockInput.pressKey("1", { meta: true })
  await until(() => api.state.reads.length === 2)
  await ui.frame("The original action remains unconfirmed")
  expect(api.state.reads[1]).toEqual({ actionID: old.actionID, reconcile: true })
  expect(ui.app.captureCharFrame()).toContain("Read status confirmed")
  expect(ui.app.captureCharFrame()).not.toContain("Mark new messages as read")
  expect(api.state.wsWrites.some((body) => body.includes("read_receipt"))).toBe(false)
})
