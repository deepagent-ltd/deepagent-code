/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Renderable, TextRenderable } from "@opentui/core"
import type { ServerWebSocket } from "bun"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { DialogIMChat } from "../../../src/component/dialog-im"
import {
  createIMClient,
  mergeIMMessages,
  openIMGroupSocket,
  recoverIMMessages,
  type IMMessage,
} from "../../../src/component/im-client"
import { useSDK } from "../../../src/context/sdk"
import { tmpdir } from "../../fixture/fixture"
import { mountIM, until } from "../../fixture/im-environment"
import { Schema } from "effect"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"

const message = (seq: number): IMMessage => ({
  id: `message-${seq}`,
  content: `payload-${seq}`,
  groupID: "team",
  senderID: "uuid-bob",
  senderType: "user",
  type: "text",
  mentions: null,
  metadata: null,
  replyToID: null,
  createdAt: seq,
  updatedAt: seq,
  deletedAt: null,
})

function fixture(directory: string, protectedReader = false) {
  const sockets = new Set<ServerWebSocket<undefined>>()
  const state = {
    messages: Array.from({ length: 80 }, (_, seq) => message(seq + 1)),
    history: [] as Array<string | null>,
    upgrades: 0,
    closes: 0,
    authorized: false,
    delayed: undefined as Promise<void> | undefined,
    repeated: false,
    writes: [] as string[],
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (request.method !== "GET") state.writes.push(`${request.method} ${url.pathname}`)
      if (
        request.headers.get("authorization") !== "Bearer fixture-token" ||
        decodeURIComponent(request.headers.get("x-deepagent-code-directory") ?? "") !== directory ||
        url.searchParams.get("directory") !== directory ||
        url.searchParams.get("location[directory]") !== directory
      )
        return new Response("unauthorized", { status: 401 })
      if (url.pathname.endsWith("/ws/im/group/team")) {
        state.upgrades += 1
        state.authorized = true
        if (server.upgrade(request)) return
        return new Response("upgrade failed", { status: 400 })
      }
      if (url.pathname.endsWith("/messages")) {
        const cursor = url.searchParams.get("cursor")
        state.history.push(cursor)
        const page = state.messages
          .filter((item) => !cursor || item.createdAt < Number(cursor))
          .toReversed()
          .slice(0, 50)
        await state.delayed
        const more = state.repeated || state.messages.some((item) => item.createdAt < (page.at(-1)?.createdAt ?? 0))
        return Response.json({
          messages: page,
          nextCursor: state.repeated ? "repeated" : protectedReader && !more ? null : String(page.at(-1)?.createdAt),
          hasMore: more,
          ...(protectedReader
            ? {
                reader: Schema.decodeUnknownSync(
                  Schema.Struct({
                    state: Schema.Literal("ready"),
                    displayEpoch: Schema.String,
                    projectionRevision: KernelReaderSchema.Positive,
                    validatedServerNow: KernelReaderSchema.Time,
                    nextExpiryAt: Schema.NullOr(KernelReaderSchema.Time),
                  }),
                )({
                  state: "ready",
                  displayEpoch: "recovery-reader-current",
                  projectionRevision: String(state.messages.length),
                  validatedServerNow: Date.now(),
                  nextExpiryAt: Date.now() + 60000,
                }),
              }
            : {}),
        })
      }
      if (url.pathname.endsWith("/read")) return Response.json({ ok: true })
      throw new Error(`Unexpected request ${url.pathname}`)
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
      },
      close(socket) {
        sockets.delete(socket)
        state.closes += 1
      },
      message() {},
    },
  })
  const url = server.url.toString().replace(/\/$/, "") + "/w"
  const sdk = {
    url,
    directory,
    client: createOpencodeClient({ baseUrl: url, headers: { Authorization: "Bearer fixture-token" } }),
  }
  return {
    sdk,
    state,
    sockets,
    send(item: IMMessage) {
      for (const socket of sockets) socket.send(JSON.stringify({ type: "message_created", data: item }))
    },
    hint() {
      for (const socket of sockets)
        socket.send(
          JSON.stringify({
            type: "reader_changed",
            data: { groupID: "team", displayEpoch: "recovery-reader-current" },
          }),
        )
    },
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

function texts(node: Renderable): string[] {
  return [...(node instanceof TextRenderable ? [node.plainText] : []), ...node.getChildren().flatMap(texts)]
}

function Chat() {
  const sdk = useSDK()
  return (
    <DialogIMChat
      client={createIMClient(sdk)}
      sdk={sdk}
      identity="uuid-me"
      group={{
        id: "team",
        name: "team",
        kernelConvID: "k:2:team",
        workspaceID: "ws",
        projectID: null,
        type: "project",
        createdBy: "server",
        createdAt: 0,
        updatedAt: 0,
        deletedAt: null,
      }}
      back={() => {}}
    />
  )
}

test("recovery fetches more than 50 missed messages until the old displayed boundary", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  const client = createIMClient(api.sdk)
  const before = (await client.listMessages("team")).messages
  api.state.messages.push(...Array.from({ length: 135 }, (_, seq) => message(seq + 81)))
  const recovered = await recoverIMMessages(client, "team", "message-31")
  const merged = mergeIMMessages(before, [...recovered.messages, message(215), message(215)])
  expect(merged.map((item) => item.id)).toEqual(Array.from({ length: 185 }, (_, seq) => `message-${seq + 31}`))
  expect(api.state.history).toEqual([null, null, "166", "116", "66"])
  api.state.repeated = true
  await expect(recoverIMMessages(client, "team", "absent")).rejects.toMatchObject({ code: "invalid_response" })
})

test("authenticated routed WS reconnects and abort closes it without later delivery or retry", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  const abort = new AbortController()
  api.sdk.client = createOpencodeClient({
    baseUrl: api.sdk.url,
    headers: { Authorization: "Bearer fixture-token" },
    signal: abort.signal,
  })
  const received: string[] = []
  const states: string[] = []
  const socket = openIMGroupSocket(api.sdk, "team", {
    onMessage: (item) => received.push(item.id),
    onState: (state) => states.push(state),
  })
  try {
    await until(() => api.sockets.size === 1, "first authenticated socket")
    api.send(message(81))
    await until(() => received.length === 1)
    for (const active of api.sockets) active.close()
    await until(() => api.state.upgrades === 2 && api.sockets.size === 1, "reconnected socket", 4000)
    api.send(message(82))
    await until(() => received.length === 2)
    abort.abort()
    await until(() => api.sockets.size === 0, "aborted socket cleanup")
    await Bun.sleep(2100)
    expect(api.state.upgrades).toBe(2)
    expect(received).toEqual(["message-81", "message-82"])
    expect(states).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"])
    expect(api.state.authorized).toBe(true)
  } finally {
    socket.close()
  }
})

test("mounted protected chat queues handshake refresh and reads reconnect history only through fresh cursor GETs", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path, true)
  const initial = Promise.withResolvers<void>()
  api.state.delayed = initial.promise
  using ui = await mountIM(tmp.path, api.sdk.url, Chat)
  await until(() => api.state.history.length === 1 && api.sockets.size === 1, "HTTP snapshot and WS handshake")
  api.state.messages.push(message(81))
  api.hint()
  api.state.delayed = undefined
  initial.resolve()
  await until(() => texts(ui.app.renderer.root).includes("payload-81"), "handshake-window HTTP catch-up")
  expect(api.state.history.length).toBeGreaterThanOrEqual(2)
  for (const active of api.sockets) active.close()
  await until(() => api.sockets.size === 0)
  await until(() => !texts(ui.app.renderer.root).includes("payload-81"), "disconnect discards protected body")
  expect(texts(ui.app.renderer.root).filter((text) => text.startsWith("payload-"))).toEqual([])
  api.state.messages.push(...Array.from({ length: 135 }, (_, seq) => message(seq + 82)))
  await until(() => api.state.upgrades === 2 && api.sockets.size === 1, "chat reconnected", 4000)
  api.send(message(216))
  api.send(message(216))
  api.send(message(999))
  api.hint()
  await until(() => texts(ui.app.renderer.root).includes("payload-216"), "latest socket message reconciled")
  expect(texts(ui.app.renderer.root).filter((text) => text.startsWith("payload-"))).toEqual(
    Array.from({ length: 50 }, (_, index) => `payload-${index + 167}`),
  )
  expect(texts(ui.app.renderer.root)).not.toContain("payload-999")
  expect(texts(ui.app.renderer.root)).not.toContain("payload-132")
  const loaded = () => !texts(ui.app.renderer.root).includes("Loading…")
  await until(loaded, "fresh reader latest page settled")
  // Protected reconnect discards its old display cache. Older body is explicitly re-read,
  // rather than being restored from WS metadata or re-admitted as historical task input.
  for (const expected of ["payload-132", "payload-82", "payload-31"]) {
    ui.app.mockInput.pressKey("p", { ctrl: true })
    await until(() => texts(ui.app.renderer.root).includes(expected), `explicit reader cursor ${expected}`)
    await until(loaded, "older reader page settled")
  }
  const rendered = texts(ui.app.renderer.root).filter((text) => text.startsWith("payload-"))
  expect(rendered.filter((text) => Number(text.slice(8)) >= 31)).toEqual(
    Array.from({ length: 186 }, (_, seq) => `payload-${seq + 31}`),
  )
  expect(new Set(rendered).size).toBe(rendered.length)
  expect(api.state.history.filter((cursor) => cursor !== null).slice(-3)).toEqual(["167", "117", "67"])
  expect(api.state.writes).toEqual([])
  expect(rendered.filter((text) => text === "payload-216")).toHaveLength(1)
  ui.app.renderer.destroy()
  await until(() => api.sockets.size === 0, "chat unmount cleanup")
  await Bun.sleep(2100)
  expect(api.state.upgrades).toBe(2)
})
