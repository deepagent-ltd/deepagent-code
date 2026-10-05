/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { DialogIM, readIMKeyFile } from "../../../src/component/dialog-im"
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
})
const message = (id: string, content: string, createdAt = 10): IMMessage => ({
  id,
  content,
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
  groupID: "team",
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
      const error = () =>
        Response.json(
          { name: "IM_FACADE_CONFLICT", data: { code: state.failure, message: "fixture failure" } },
          { status: 409 },
        )
      if (url.pathname.endsWith("/status")) return response(state.status)
      if (url.pathname.endsWith("/groups") && request.method === "GET") return response(state.groups)
      if (url.pathname.endsWith("/claim") || url.pathname.endsWith("/rename")) {
        if (state.failure) return error()
        state.status = { ...state.status, facade: "active", identity: { ...identity, name: payload.name! } }
        return response(state.status.identity)
      }
      if (url.pathname.endsWith("/rebind") || url.pathname.endsWith("/retry")) {
        if (state.failure) return error()
        state.status = { ...state.status, facade: "active", identity }
        return response(identity)
      }
      if (url.pathname.endsWith("/auth/im-facade")) return response(true)
      if (url.pathname.endsWith("/resolve"))
        return state.failure ? error() : response({ uuid: "uuid-bob", name: url.searchParams.get("name") })
      if (url.pathname.endsWith("/direct")) return response(group("bob", "k:1:uuid-bob"))
      if (url.pathname.endsWith("/facade/groups")) {
        state.groups.push(group("team", "k:2:team"))
        return response(state.groups.at(-1))
      }
      if (url.pathname.endsWith("/invite")) return state.failure ? error() : response({ ok: true })
      if (url.pathname.endsWith("/messages") && request.method === "GET")
        return response({ messages: [message("historical", "old hello")], nextCursor: null, hasMore: false })
      if (url.pathname.endsWith("/messages")) {
        state.sends += 1
        if (state.failure) return error()
        const receipt = payload.clientRequestID ? state.receipts.get(payload.clientRequestID) : undefined
        if (receipt) return response(receipt)
        const sent = { ...message(`sent-${state.sends}`, payload.content!), senderID: "server" }
        if (payload.clientRequestID) state.receipts.set(payload.clientRequestID, sent)
        if (state.loseReceipt) {
          state.loseReceipt = false
          return Response.json({ name: "ApiUnavailable", data: { code: "transport_error", message: "receipt unavailable" } }, { status: 503 })
        }
        return response(sent)
      }
      if (url.pathname.endsWith("/read")) return response({ ok: true })
      if (url.pathname.endsWith("/agents"))
        return response([{ id: "agent-local", name: "Local", displayName: "Local", visible: true }])
      if (url.pathname.endsWith("/groups")) return response(group("agent-local", null))
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

test("claim, rename and active rebind use routed authenticated contracts", async () => {
  await using tmp = await tmpdir()
  using api = fixture("claim_required")
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />)
  await ui.frame("Claim IM identity")
  await ui.select("Claim IM identity")
  await ui.type("Ａlice")
  api.state.failure = "im_name_taken"
  ui.app.mockInput.pressEnter()
  await ui.frame("already taken")
  expect((ui.app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("Ａlice")
  api.state.failure = ""
  ui.app.mockInput.pressEnter()
  await ui.frame("Shared IM ready")
  await ui.select("Rename identity")
  await ui.type("newalice", true)
  ui.app.mockInput.pressEnter()
  await ui.frame("newalice")
  const keyFile = path.join(tmp.path, "key")
  await Bun.write(keyFile, "fixture-key\n")
  await ui.select("Rebind: read local key file")
  await ui.type(keyFile)
  ui.app.mockInput.pressEnter()
  await ui.frame("Shared IM ready")
  const claims = api.state.calls.filter((call) => call.path.endsWith("/claim"))
  expect(claims.map((call) => call.body)).toEqual([{ name: "alice" }, { name: "alice" }])
  expect(api.state.calls.find((call) => call.path.endsWith("/rename"))?.body).toEqual({ name: "newalice" })
  expect(api.state.calls.find((call) => call.path.endsWith("/rebind"))?.body).toEqual({ newKey: "fixture-key" })
  expect(
    api.state.calls.every(
      (call) =>
        call.auth === "Bearer fixture-token" &&
        decodeURIComponent(call.directory!) === tmp.path &&
        call.query.get("directory") === tmp.path,
    ),
  ).toBe(true)
  expect(ui.app.captureCharFrame()).not.toContain("fixture-key")
})

test("revoked identity only offers platform inheritance recovery and saves then retries", async () => {
  await using tmp = await tmpdir()
  using api = fixture("blocked")
  using ui = await mountIM(tmp.path, api.url, () => <DialogIM />)
  const frame = await ui.frame("Recover: update local")
  expect(frame).not.toContain("Rebind: read")
  expect(frame).toContain("replacement key")
  const keyFile = path.join(tmp.path, "replacement")
  await Bun.write(keyFile, "replacement-fixture")
  await ui.select("Recover: update local")
  await ui.type(keyFile)
  ui.app.mockInput.pressEnter()
  await ui.frame("Shared IM ready")
  const calls = api.state.calls.filter((call) => call.method !== "GET")
  expect(calls.map((call) => call.path)).toEqual(["/w/auth/im-facade", "/w/api/v1/im/facade/retry"])
  expect(calls[0].body).toEqual({ type: "api", key: "replacement-fixture" })
})

test("person lookup confirms exact identity before direct chat; local Agent uses separate API", async () => {
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
  ui.app.mockInput.pressEscape()
  await ui.frame("Chat with a local Agent")
  await ui.select("Chat with a local Agent")
  await ui.type("agent-local")
  ui.app.mockInput.pressEnter()
  await ui.frame("old hello")
  expect(api.state.calls.find((call) => call.path.endsWith("/groups") && call.method === "POST")?.body).toEqual({
    name: "agent-local",
    type: "direct",
    member: { memberID: "agent-local", memberType: "agent" },
  })
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
  expect(requests.map((request) => request.content)).toEqual(["same message", "same message", "same message", "edited message"])
  expect(requests[0].clientRequestID).toMatch(/^tui:[\w-]+$/)
  expect(requests[2].clientRequestID).not.toBe(requests[1].clientRequestID)
  expect(requests[3].clientRequestID).not.toBe(requests[2].clientRequestID)
  expect(api.state.receipts.size).toBe(2)
})

test("key file validates type, size, single key and reads changed contents afresh", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "key")
  await mkdir(path.join(tmp.path, "directory"))
  for (const content of ["", "\n\t", "one\ntwo", "x".repeat(16385)]) {
    await Bun.write(file, content)
    await expect(readIMKeyFile(file)).rejects.toMatchObject({ code: "key_file" })
  }
  await expect(readIMKeyFile(path.join(tmp.path, "directory"))).rejects.toMatchObject({ code: "key_file" })
  await expect(readIMKeyFile(path.join(tmp.path, "missing"))).rejects.toMatchObject({ code: "key_file" })
  await expect(readIMKeyFile("")).rejects.toMatchObject({ code: "key_file" })
  await Bun.write(file, "first-key\n")
  expect(await readIMKeyFile(file)).toBe("first-key")
  await Bun.write(file, "second-key\n")
  expect(await readIMKeyFile(file)).toBe("second-key")
})

test("all facade and client codes map to terminal error guidance", () => {
  expect(Object.keys(IM_ERROR_KEYS).sort()).toEqual(
    [...new Set([...FACADE_ERROR_CODES, ...CLIENT_ERROR_CODES, "im_identity_changed"])].sort(),
  )
})
