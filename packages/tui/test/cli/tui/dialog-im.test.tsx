/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { DialogIM } from "../../../src/component/dialog-im"
import { DialogIMForm } from "../../../src/component/dialog-im-form"
import { IMRequestError, type IMGroup, type IMMessage, type IMFacadeStatus } from "../../../src/component/im-client"
import { FACADE_ERROR_CODES, CLIENT_ERROR_CODES } from "@deepagent-code/core/im/facade-contract"
import { IM_ERROR_KEYS } from "../../../src/component/im-errors"
import { tmpdir } from "../../fixture/fixture"
import { mountIM, until } from "../../fixture/im-environment"

const identity = { uuid: "uuid-me", name: "alice", orgID: 7, orgAllGroupID: "everyone" }
const group = (id: string, conv: string | null): IMGroup => ({
  id,
  name: id,
  workspaceID: "ws",
  projectID: null,
  type: conv?.startsWith("k:1:") ? "direct" : "project",
  createdBy: "server",
  kernelConvID: conv,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  ...(conv ? { reader: { mode: "protected", state: "ready", liveUnread: "1" } as const } : {}),
})
const message = (id: string, content: string, createdAt = 10, groupID = "team"): IMMessage => ({
  id,
  content,
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
  groupID,
  senderID: "uuid-bob",
  senderType: "user",
  type: "text",
  mentions: null,
  metadata: null,
  replyToID: null,
})

function fixture(initial: IMFacadeStatus["facade"] = "active") {
  const state = {
    status: {
      facade: initial,
      identity: initial === "active" ? identity : null,
      blocked: initial === "blocked" ? { code: "im_key_invalid", message: "revoked" } : null,
      kernel: "connected",
      keyOrigin: "env",
      reader: { state: "ready", displayEpoch: "facade_fixture", legacyMirrorUnavailable: true },
    } as IMFacadeStatus,
    groups: [] as IMGroup[],
    calls: [] as {
      method: string
      path: string
      query: URLSearchParams
      body: unknown
      auth: string | null
      directory: string | null
    }[],
    failure: "",
    sends: 0,
    loseReceipt: false,
    receipts: new Map<string, IMMessage>(),
    delayed: undefined as (() => void) | undefined,
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname.includes("/ws/")) {
        if (server.upgrade(request)) return
        return new Response("upgrade failed", { status: 400 })
      }
      const body = request.method === "GET" ? undefined : await request.json()
      state.calls.push({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        auth: request.headers.get("Authorization"),
        directory: request.headers.get("x-deepagent-code-directory"),
      })
      const payload = body as { name?: string; content?: string; clientRequestID?: string }
      const response = (value: unknown) => Response.json(value)
      const observation = () => ({
        displayEpoch: "facade_fixture",
        proofWindowMs: 1000,
        validatedServerNow: Date.now(),
        nextExpiryAt: Date.now() + 60000,
      })
      const error = () =>
        Response.json(
          { name: "IM_FACADE_CONFLICT", data: { code: state.failure, message: "fixture failure" } },
          { status: 409 },
        )
      if (url.pathname.endsWith("/status")) return response(state.status)
      if (url.pathname.endsWith("/activation") && request.method === "GET") return response({ transaction: null })
      if (url.pathname.endsWith("/activation/quote")) return response({
        quoteID: "quote_fixture_activation", priceCredits: 1, quotaCost: 500000,
        expiresAt: Date.now() + 60000, entitlementExpiresAt: null,
      })
      if (url.pathname.endsWith("/groups/page")) {
        const lane = url.searchParams.get("lane")
        return response({
          version: 1,
          lane,
          groups: state.groups.filter((value) => (lane === "protected" ? !!value.reader : !value.reader)),
          hasMore: false,
          nextCursor: null,
          ...(lane === "protected" ? { reader: observation() } : {}),
        })
      }
      const detail = /\/groups\/([^/]+)$/.exec(url.pathname)
      if (request.method === "GET" && detail) {
        const value = state.groups.find((item) => item.id === detail[1])
        return value
          ? response({ version: 1, group: value, ...(value.reader ? { reader: observation() } : {}) })
          : new Response("missing", { status: 404 })
      }
      if (url.pathname.endsWith("/groups") && request.method === "GET") return response(state.groups)
      if (url.pathname.endsWith("/rename")) {
        if (state.failure) return error()
        state.status = { ...state.status, facade: "active", identity: { ...identity, name: payload.name! } }
        return response(state.status.identity)
      }
      if (url.pathname.endsWith("/retry")) {
        if (state.failure) return error()
        state.status = { ...state.status, facade: "active", identity }
        return response(identity)
      }
      if (url.pathname.endsWith("/resolve"))
        return state.failure ? error() : response({ uuid: "uuid-bob", name: url.searchParams.get("name") })
      if (url.pathname.endsWith("/direct")) {
        state.groups.push(group("bob", "k:1:uuid-bob"))
        return response(state.groups.at(-1))
      }
      if (url.pathname.endsWith("/facade/groups")) {
        state.groups.push(group("team", "k:2:team"))
        return response(state.groups.at(-1))
      }
      if (url.pathname.endsWith("/invite")) return state.failure ? error() : response({ ok: true })
      if (url.pathname.endsWith("/messages") && request.method === "GET")
        return response({
          messages: [message("historical", "old hello", 10, url.pathname.split("/").at(-2)),
            ...[...state.receipts.values()].filter((item) => item.groupID === url.pathname.split("/").at(-2))],
          nextCursor: null,
          hasMore: false,
          reader: { ...observation(), state: "ready", projectionRevision: "1" },
        })
      if (url.pathname.endsWith("/messages")) {
        state.sends += 1
        if (state.failure) return error()
        const receipt = payload.clientRequestID ? state.receipts.get(payload.clientRequestID) : undefined
        if (receipt) return response(receipt)
        const sent = { ...message(`sent-${state.sends}`, payload.content!, 10, url.pathname.split("/").at(-2)), senderID: "server" }
        if (payload.clientRequestID) state.receipts.set(payload.clientRequestID, sent)
        if (state.loseReceipt) {
          state.loseReceipt = false
          return Response.json(
            { name: "ApiUnavailable", data: { code: "transport_error", message: "receipt unavailable" } },
            { status: 503 },
          )
        }
        return response(sent)
      }
      if (url.pathname.endsWith("/read")) return response({ ok: true })
      if (url.pathname.endsWith("/agents"))
        return response([{ id: "agent-local", name: "Local", displayName: "Local", visible: true }])
      if (url.pathname.endsWith("/groups")) {
        state.groups.push(group("agent-local", null))
        return response(state.groups.at(-1))
      }
      throw new Error(`Unexpected fixture request ${url.pathname}`)
    },
    websocket: { message() {} },
  })
  return {
    state,
    url: server.url.toString().replace(/\/$/, "") + "/w",
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

test("IM form keyboard focus, pending guard and failed input retention", async () => {
  await using tmp = await tmpdir()
  const values: string[][] = []
  let settle: (value: void) => void = () => {}
  using ui = await mountIM(tmp.path, "http://127.0.0.1:1", () => (
    <DialogIMForm
      title="Create team"
      fields={[{ label: "Name" }, { label: "Members" }]}
      back={() => {}}
      submit={async (fields) => {
        values.push(fields)
        await new Promise<void>((resolve) => {
          settle = resolve
        })
        throw new IMRequestError("im_member_not_found", "no member")
      }}
    />
  ))
  await ui.type("research")
  ui.app.mockInput.pressTab()
  await ui.type("bob")
  ui.app.mockInput.pressTab({ shift: true })
  expect((ui.app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("research")
  ui.app.mockInput.pressEnter()
  ui.app.mockInput.pressEnter()
  expect(values).toEqual([["research", "bob"]])
  settle()
  await ui.frame("Some member names")
  await until(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  expect((ui.app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("research")
  ui.app.mockInput.pressEnter()
  expect(values.length).toBe(2)
  settle()
})

test("unclaimed IM opens explicit activation without legacy admission or credential writes", async () => {
  await using tmp = await tmpdir()
  using api = fixture("claim_required")
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />)
  const frame = await ui.frame("Activate IM")
  expect(frame).not.toContain("Claim IM identity")
  expect(frame).not.toContain("Rebind: read")
  expect(frame).not.toContain("Recover: update")
  await ui.select("Activate IM")
  await until(() => api.state.calls.some((call) => call.path.endsWith("/activation/quote")))
  await ui.frame("Activate IM")
  expect(api.state.calls.filter((call) => call.path.includes("/activation")).map((call) => call.method)).toEqual(["GET", "GET"])
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

test("activation-required identity opens the quoted manual activation flow", async () => {
  await using tmp = await tmpdir()
  using api = fixture("blocked")
  api.state.status.blocked = { code: "activation_required", message: "activation required" }
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />)
  const frame = await ui.frame("Activate IM")
  expect(frame).not.toContain("Recover: update")
  expect(frame).not.toContain("Rebind: read")
  await ui.select("Activate IM")
  await until(() => api.state.calls.some((call) => call.path.endsWith("/activation/quote")))
  await ui.frame("Activate IM")
  expect(api.state.calls.filter((call) => call.method !== "GET")).toEqual([])
  expect(api.state.calls.some((call) => call.path.endsWith("/claim") || call.path.endsWith("/rebind") || call.path.endsWith("/auth/im-facade"))).toBe(false)
})

test("active IM keeps authenticated rename and retry without rebind", async () => {
  await using tmp = await tmpdir()
  using api = fixture()
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />)
  const frame = await ui.frame("Rename identity")
  expect(frame).not.toContain("Rebind: read")
  await ui.select("Rename identity")
  await ui.type("newalice", true)
  ui.app.mockInput.pressEnter()
  await ui.frame("newalice")
  await ui.select("Retry connection")
  await until(() => api.state.calls.some((call) => call.path.endsWith("/retry")))
  expect(api.state.calls.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual([
    "/w/api/v1/im/facade/rename", "/w/api/v1/im/facade/retry",
  ])
  expect(api.state.calls.find((call) => call.path.endsWith("/rename"))?.body).toEqual({ name: "newalice" })
  expect(api.state.calls.every((call) => call.auth === "Bearer fixture-token" &&
    decodeURIComponent(call.directory!) === tmp.path && call.query.get("directory") === tmp.path)).toBe(true)
})

test("person lookup confirms exact identity before direct chat without creating a shared Agent", async () => {
  await using tmp = await tmpdir()
  using api = fixture()
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />)
  await ui.frame("Find a person")
  await ui.select("Find a person")
  await ui.type("BOB")
  ui.app.mockInput.pressEnter()
  await ui.frame("Found bob")
  expect(api.state.calls.some((call) => call.path.endsWith("/direct"))).toBe(false)
  ui.app.mockInput.pressEnter()
  await ui.frame("old hello")
  expect(api.state.calls.find((call) => call.path.endsWith("/direct"))?.body).toEqual({ name: "bob" })
  expect(api.state.calls.some((call) => call.path.endsWith("/agents"))).toBe(false)
  expect(api.state.calls.some((call) => call.path.endsWith("/groups") && call.method === "POST")).toBe(false)
})

test("shared group members use Tab, invite keeps failed name, failed send keeps draft", async () => {
  await using tmp = await tmpdir()
  using api = fixture()
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />)
  await ui.frame("new group")
  await ui.select("new group")
  await ui.type("Team")
  ui.app.mockInput.pressTab()
  await ui.type("BOB,bob,张三")
  ui.app.mockInput.pressEnter()
  await ui.frame("old hello")
  expect(api.state.calls.find((call) => call.path.endsWith("/facade/groups"))?.body).toEqual({
    name: "team",
    memberNames: ["bob", "张三"],
  })
  ui.app.mockInput.pressKey("g", { ctrl: true })
  await ui.type("dave")
  api.state.failure = "im_not_found"
  ui.app.mockInput.pressEnter()
  await ui.frame("No such name")
  expect((ui.app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("dave")
  api.state.failure = ""
  ui.app.mockInput.pressEnter()
  await ui.frame("old hello")
  expect(api.state.calls.filter((call) => call.path.endsWith("/invite")).map((call) => call.body)).toEqual([
    { name: "dave" },
    { name: "dave" },
  ])
  ui.app.mockInput.pressKey("s", { ctrl: true })
  await ui.type("hello team")
  api.state.failure = "im_kernel_error"
  ui.app.mockInput.pressEnter()
  await ui.frame("kernel had an error")
  expect((ui.app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("hello team")
  api.state.failure = ""
  ui.app.mockInput.pressEnter()
  await until(() => api.state.sends === 2, "retried message request")
  await ui.frame("you:")
  await ui.frame("hello team")
  expect(api.state.sends).toBe(2)
})

test("ambiguous sends retry the same request identity; edits and subsequent submissions get new identities", async () => {
  await using tmp = await tmpdir()
  using api = fixture()
  api.state.groups.push(group("team", "k:2:team"))
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />)
  await ui.frame("Shared IM ready")
  await ui.select("team")
  await ui.frame("old hello")
  ui.app.mockInput.pressKey("s", { ctrl: true })
  await ui.type("same message")
  api.state.loseReceipt = true
  ui.app.mockInput.pressEnter()
  await ui.frame("Cannot reach the IM facade")
  expect(api.state.receipts.size).toBe(1)
  expect((ui.app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("same message")
  ui.app.mockInput.pressEnter()
  await ui.frame("Connection: online")
  expect(api.state.receipts.size).toBe(1)
  const sent = () => api.state.calls.filter((call) => call.path.endsWith("/messages") && call.method === "POST")
  expect(sent()[0].body).toEqual(sent()[1].body)

  ui.app.mockInput.pressKey("s", { ctrl: true })
  await ui.type("same message")
  api.state.failure = "im_kernel_error"
  ui.app.mockInput.pressEnter()
  await ui.frame("kernel had an error")
  await ui.type("edited message", true)
  api.state.failure = ""
  ui.app.mockInput.pressEnter()
  await ui.frame("Connection: online")
  await ui.frame("edited message")
  const requests = sent().map((call) => call.body as { clientRequestID: string; content: string })
  expect(requests.map((request) => request.content)).toEqual([
    "same message",
    "same message",
    "same message",
    "edited message",
  ])
  expect(requests[0].clientRequestID).toMatch(/^tui:[\w-]+$/)
  expect(requests[2].clientRequestID).not.toBe(requests[1].clientRequestID)
  expect(requests[3].clientRequestID).not.toBe(requests[2].clientRequestID)
  expect(api.state.receipts.size).toBe(2)
})

test("all facade and client codes map to terminal error guidance", () => {
  expect(Object.keys(IM_ERROR_KEYS).sort()).toEqual(
    [...new Set([...FACADE_ERROR_CODES, ...CLIENT_ERROR_CODES, "im_identity_changed"])].sort(),
  )
})

test("an explicitly disabled reader leaves ordinary conversations available without protected requests", async () => {
  await using tmp = await tmpdir()
  using api = fixture("disabled")
  api.state.status = { ...api.state.status, reader: null, kernel: null, keyOrigin: "none" }
  api.state.groups.push(group("ordinary-available", null))
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />, 80)
  const frame = await ui.frame("ordinary-available")
  expect(frame).not.toContain("Remote conversation is currently unavailable")
  expect(
    api.state.calls.filter((call) => call.path.endsWith("/groups/page")).map((call) => call.query.get("lane")),
  ).toEqual(["ordinary"])
  await ui.select("ordinary-available")
  await ui.frame("old hello")
  expect(api.state.sends).toBe(0)
})
