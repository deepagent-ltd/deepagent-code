/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { DialogIM } from "../../../src/component/dialog-im"
import type { IMFacadeStatus, IMGroup, IMMessage } from "../../../src/component/im-client"
import { tmpdir } from "../../fixture/fixture"
import { mountIM, until } from "../../fixture/im-environment"

function fixture(directory: string, protectedGroup = false) {
  const group: IMGroup = {
    id: "original-team",
    name: "Original team",
    workspaceID: directory,
    projectID: null,
    type: "project",
    createdBy: "server",
    kernelConvID: protectedGroup ? "k:2:original-team" : null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...(protectedGroup ? { reader: { mode: "protected", state: "pending", liveUnread: null } as const } : {}),
  }
  const message: IMMessage = {
    id: "original-message",
    groupID: group.id,
    senderID: "peer",
    senderType: "user",
    type: "text",
    content: "Original authenticated message",
    mentions: null,
    metadata: null,
    replyToID: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
  const state = {
    groups: [group],
    status: {
      facade: "active",
      identity: { uuid: "original-reader", name: "Alice", orgID: 1, orgAllGroupID: "everyone" },
      blocked: null,
      kernel: "connected",
      keyOrigin: "stored",
      reader: { state: "ready", displayEpoch: "current_epoch", legacyMirrorUnavailable: true },
    } as IMFacadeStatus,
    calls: [] as { method: string; path: string; auth: string | null; directory: string | null; query: string | null }[],
  }
  const observation = () => ({
    displayEpoch: "current_epoch",
    proofWindowMs: 1000,
    validatedServerNow: Date.now(),
    nextExpiryAt: Date.now() + 60000,
  })
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, host) {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/ws/")) {
        if (host.upgrade(request)) return
        return new Response("upgrade failed", { status: 400 })
      }
      state.calls.push({
        method: request.method,
        path: url.pathname,
        auth: request.headers.get("authorization"),
        directory: request.headers.get("x-deepagent-code-directory"),
        query: url.searchParams.get("directory"),
      })
      if (
        request.headers.get("authorization") !== "Bearer fixture-token" ||
        decodeURIComponent(request.headers.get("x-deepagent-code-directory") ?? "") !== directory ||
        url.searchParams.get("directory") !== directory
      )
        return new Response("denied", { status: 401 })
      if (url.pathname.endsWith("/status")) return Response.json(state.status)
      if (url.pathname.endsWith("/groups/page")) {
        const lane = url.searchParams.get("lane")
        return Response.json({
          version: 1,
          lane,
          groups: state.groups.filter((row) => (lane === "protected" ? !!row.reader : !row.reader)),
          hasMore: false,
          nextCursor: null,
          ...(lane === "protected" ? { reader: observation() } : {}),
        })
      }
      if (url.pathname.endsWith(`/groups/${group.id}`))
        return Response.json({ version: 1, group, ...(group.reader ? { reader: observation() } : {}) })
      if (url.pathname.endsWith("/messages")) {
        if (protectedGroup)
          return Response.json(
            { name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable" } },
            { status: 503 },
          )
        if (request.method !== "GET") return new Response("unexpected send", { status: 405 })
        return Response.json({ messages: [message], hasMore: false, nextCursor: null })
      }
      if (url.pathname.endsWith("/read")) return Response.json({ ok: true })
      return new Response("not found", { status: 404 })
    },
    websocket: { message() {} },
  })
  return {
    state,
    url: listener.url.toString(),
    [Symbol.dispose]() {
      listener.stop(true)
    },
  }
}

test("80x24 authenticated IM shows the original conversation first, enters by Enter and preserves a cancelled draft", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />, 80)
  ui.app.renderer.resize(80, 24)
  const first = await ui.frame("# Original team")
  expect(first).toContain("Alice")
  expect(first).toContain("Shared IM ready")
  expect(first.split("\n").filter((row) => row.trim()).length).toBeLessThanOrEqual(24)
  await until(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable, "conversation filter focus")
  ui.app.mockInput.pressEnter()
  await ui.frame("Original authenticated message")
  expect(api.state.calls.some((call) => call.path.endsWith("/groups/original-team"))).toBe(true)
  ui.app.mockInput.pressKey("s", { ctrl: true })
  await ui.type("Unsent original draft")
  ui.app.mockInput.pressEscape()
  await ui.frame("Original authenticated message")
  ui.app.mockInput.pressKey("s", { ctrl: true })
  await ui.frame("Unsent original draft")
  expect((ui.app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("Unsent original draft")
  ui.app.mockInput.pressEscape()
  await ui.frame("Original authenticated message")
  ui.app.mockInput.pressEscape()
  await ui.frame("# Original team")
  await ui.select("Rename identity")
  await ui.frame("Alice")
  expect((ui.app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("Alice")
  expect(api.state.calls.filter((call) => call.method !== "GET").every((call) => call.path.endsWith("/read"))).toBe(true)
  expect(api.state.calls.every((call) => call.auth === "Bearer fixture-token" && call.query === tmp.path)).toBe(true)
})

test("80x24 conversation priority keeps pending protected chats read-only and returns to the original list", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path, true)
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />, 80)
  ui.app.renderer.resize(80, 24)
  await ui.frame("# Original team")
  ui.app.mockInput.pressEnter()
  await until(() => api.state.calls.some((call) => call.path.endsWith("/messages")), "current protected read")
  const chat = await ui.frame("Waiting for the conversation")
  expect(chat).not.toContain("Original authenticated message")
  ui.app.mockInput.pressEscape()
  await ui.frame("# Original team")
  expect(api.state.calls.filter((call) => call.method !== "GET")).toEqual([])
})

test("80x24 empty IM keeps blocked status and searchable management entries without submitting", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.groups = []
  api.state.status = { ...api.state.status, facade: "blocked", blocked: { code: "im_key_invalid", message: "revoked" } }
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />, 80)
  ui.app.renderer.resize(80, 24)
  await ui.frame("The IM key is invalid")
  await ui.select("Recover: update local")
  await ui.frame("Read a local regular file")
  ui.app.mockInput.pressEscape()
  await ui.frame("The IM key is invalid")
  const reads = api.state.calls.filter((call) => call.path.endsWith("/status")).length
  await ui.select("Refresh status and conversations")
  await until(() => api.state.calls.filter((call) => call.path.endsWith("/status")).length > reads, "explicit refresh")
  expect(api.state.calls.filter((call) => call.method !== "GET")).toEqual([])
})
