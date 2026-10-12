/** @jsxImportSource @opentui/solid */
import { mkdtemp, rm } from "node:fs/promises"
import { createSignal } from "solid-js"
import { Renderable, TextRenderable } from "@opentui/core"
import type { ServerWebSocket } from "bun"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DialogIMChat } from "../../src/component/dialog-im"
import { createIMClient, type IMGroup, type IMMessage } from "../../src/component/im-client"
import { mountIM, until } from "./im-environment"
import { dict } from "../../src/i18n/en"

export const paginationInventory = { peersOpened: 0, peersClosed: 0, renderersOpened: 0, renderersDestroyed: 0,
  rootsCreated: 0, rootsRemoved: 0, socketsOpened: 0, socketsClosed: 0, writes: 0, metadataRefreshes: 0, unexpectedRequests: 0 }

function texts(node: Renderable): string[] {
  return [...(node instanceof TextRenderable ? [node.plainText] : []), ...node.getChildren().flatMap(texts)]
}

// Original generated SDK credentials/config, createIMClient, DialogIMChat and
// OpenTUI renderer. The original IM transport performs its own scoped HTTP GET;
// this controlled peer is not a real facade/Go authority or provider execution.
export async function mountPagination() {
  const root = await mkdtemp("/tmp/dac-im-pagination-product-tui-")
  paginationInventory.rootsCreated++
  const sockets = new Set<ServerWebSocket<{ directory: string }>>()
  const state = { failMiddle: false, cursorMode: "advance" as "advance" | "repeat" | "empty" | "terminal", delayed: undefined as Promise<void> | undefined,
    delayedClosed: false, delayedFinished: false,
    requests: [] as { directory: string; cursor: string | null; limit: string | null; rows: number; status: number }[] }
  const server = Bun.serve<{ directory: string }>({ hostname: "127.0.0.1", port: 0, async fetch(request, host) {
    const url = new URL(request.url)
    const directory = url.searchParams.get("directory") ?? ""
    const label = directory === `${root}/a` ? "a" : directory === `${root}/b` ? "b" : "foreign"
    if (request.headers.get("authorization") !== "Bearer fixture-token" || label === "foreign" ||
      decodeURIComponent(request.headers.get("x-deepagent-code-directory") ?? "") !== directory ||
      url.searchParams.get("location[directory]") !== directory)
      return Response.json({ denied: true }, { status: 401 })
    if (url.pathname === "/ws/im/group/pagination-team") {
      if (host.upgrade(request, { data: { directory } })) return
      return Response.json({ upgrade: false }, { status: 400 })
    }
    if (request.method === "POST" && url.pathname === "/api/v1/im/groups/pagination-team/refresh") {
      if (await request.text()) {
        paginationInventory.writes++
        return Response.json({ denied: true }, { status: 400 })
      }
      paginationInventory.metadataRefreshes++
      return Response.json({ version: 1, group, reader: {
        displayEpoch: directory, proofWindowMs: 1000, validatedServerNow: Date.now(), nextExpiryAt: null,
      } })
    }
    if (request.method !== "GET") {
      paginationInventory.writes++
      return Response.json({ denied: true }, { status: 405 })
    }
    if (url.pathname !== "/api/v1/im/groups/pagination-team/messages") {
      paginationInventory.unexpectedRequests++
      return Response.json({ missing: true }, { status: 404 })
    }
    const cursor = url.searchParams.get("cursor")
    const offset = cursor === "older-50" ? 50 : cursor === "older-100" ? 100 : 0
    const rows = Math.min(50, 125 - offset)
    const failure = cursor !== null && state.failMiddle
    state.requests.push({ directory, cursor, limit: url.searchParams.get("limit"), rows: failure ? 0 : rows,
      status: failure ? 500 : 200 })
    if (failure) return Response.json({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable" } }, { status: 500 })
    if (cursor && label === "a" && state.delayed) {
      request.signal.addEventListener("abort", () => { state.delayedClosed = true }, { once: true })
      await state.delayed
      state.delayedFinished = true
    }
    const messages: IMMessage[] = Array.from({ length: rows }, (_, index) => ({
      id: `${label}-message-${125 - offset - index}`, groupID: "pagination-team", senderID: "peer", senderType: "user",
      type: "text", content: `${label}-history-${String(125 - offset - index).padStart(3, "0")} 中文`,
      mentions: null, metadata: null, replyToID: null, createdAt: 125 - offset - index,
      updatedAt: 125 - offset - index, deletedAt: null,
    }))
    return Response.json({ messages, nextCursor: offset === 100 ? null : cursor && state.cursorMode === "repeat" ? cursor : cursor && state.cursorMode === "empty" ? "" : `older-${offset + 50}`,
      hasMore: cursor && state.cursorMode === "terminal" ? false : offset !== 100, reader: { state: "ready", displayEpoch: directory, projectionRevision: "1",
        validatedServerNow: Date.now(), nextExpiryAt: null } })
  }, websocket: {
    open(socket) { sockets.add(socket); paginationInventory.socketsOpened++ },
    close(socket) { sockets.delete(socket); paginationInventory.socketsClosed++ },
    message() {},
  } })
  paginationInventory.peersOpened++
  const [directory, setDirectory] = createSignal(`${root}/a`)
  const sdk = { url: server.url.origin, get directory() { return directory() },
    client: createDeepAgentCodeClient({ baseUrl: server.url.origin, headers: { Authorization: "Bearer fixture-token" } }) }
  const client = createIMClient(sdk)
  const group: IMGroup = { id: "pagination-team", name: "Private protected history", workspaceID: "ws", projectID: null,
    type: "project", createdBy: "peer", kernelConvID: "k:2:pagination-team", createdAt: 1, updatedAt: 1, deletedAt: null,
    reader: { mode: "protected", state: "ready", liveUnread: "125" } }
  const ui = await mountIM(root, sdk.url, () => <DialogIMChat client={client} sdk={sdk} group={group} back={() => {}} />, 100)
  paginationInventory.renderersOpened++
  const bodies = () => texts(ui.app.renderer.root).filter((value) => /^[ab]-history-\d{3} 中文$/.test(value))
  return { ...ui, state, sockets, root, setDirectory: (label: "a" | "b") => setDirectory(`${root}/${label}`), bodies,
    async settled(count: number) {
      await until(() => bodies().length === count && !texts(ui.app.renderer.root).includes(dict["tui.im.loading"]),
        `${count} original transcript messages and finished load`)
      await ui.app.renderOnce()
    },
    async older() { ui.app.mockInput.pressKey("p", { ctrl: true }); await ui.app.renderOnce() },
    async refresh() { ui.app.mockInput.pressKey("r", { ctrl: true }); await ui.app.renderOnce() },
    async close() {
      ui.app.renderer.destroy()
      paginationInventory.renderersDestroyed++
      await until(() => sockets.size === 0, "owned original scoped WS closed")
      server.stop(true)
      paginationInventory.peersClosed++
      await rm(root, { recursive: true, force: true })
      paginationInventory.rootsRemoved++
    },
  }
}
