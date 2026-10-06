/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { AttentionItem, SessionV2Info } from "@deepagent-code/sdk"
import { DialogAttention, attentionCommand } from "../../../src/component/dialog-attention"
import { CommandPaletteDialog } from "../../../src/component/command-palette"
import { useDialog } from "../../../src/ui/dialog"
import { useTuiI18n } from "../../../src/context/i18n"
import { useBindings, useCommandSlashes } from "../../../src/keymap"
import { tmpdir } from "../../fixture/fixture"
import { mountIM, until } from "../../fixture/im-environment"

function fixture(directory: string) {
  const target = `${directory}/project A`
  const item: AttentionItem = {
    id: "execution:session-a",
    revision: "revision-1",
    kind: "execution_recovery",
    state: "recovery_required",
    reasonCode: "recovery_required",
    occurredAt: 1,
    observedAt: 2,
    seen: false,
    seenAt: 0,
    session: {
      id: "session-a",
      title: "Project A recovery",
      projectID: "project-a",
      directory: target,
      workspaceID: null,
    },
    source: {},
  }
  const session: SessionV2Info = {
    id: "session-a",
    projectID: "project-a",
    title: "Project A history",
    location: { directory: target },
    permissions: [],
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  const state = {
    item,
    session,
    enabled: true,
    failure: false,
    stale: false,
    repeatCursor: false,
    delay: undefined as Promise<void> | undefined,
    text: "Target project message body",
    calls: [] as {
      method: string
      path: string
      query: URLSearchParams
      body: unknown
      directory: string | null
      auth: string | null
    }[],
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      url.pathname = decodeURIComponent(url.pathname)
      const body: unknown = request.method === "GET" ? undefined : await request.json()
      state.calls.push({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        directory: request.headers.get("x-deepagent-code-directory"),
        auth: request.headers.get("authorization"),
      })
      if (state.failure)
        return Response.json({ _tag: "ServiceUnavailableError", message: "secret diagnostic" }, { status: 503 })
      if (url.pathname === "/api/attention/capability")
        return Response.json({
          enabled: state.enabled,
          scope: "implicit-local",
          actor: "server",
          reason: state.enabled ? "enabled" : "profile_disabled",
        })
      if (url.pathname === "/api/attention") {
        const cursor = url.searchParams.get("cursor")
        const rows = cursor
          ? [{ ...state.item, id: "second", session: { ...state.item.session, title: "Second page result" } }]
          : [state.item]
        return Response.json({
          data: rows.filter(
            (item) =>
              (url.searchParams.get("view") !== "unseen" || !item.seen) &&
              (!url.searchParams.get("kind") || item.kind === url.searchParams.get("kind")),
          ),
          nextCursor: !cursor || state.repeatCursor ? "page-2" : undefined,
          unseenCount: Number(!state.item.seen),
          asOf: 2,
          scope: "implicit-local",
        })
      }
      if (url.pathname === "/api/attention/execution:session-a") return Response.json({ data: state.item })
      if (url.pathname === "/api/attention/execution:session-a/seen") {
        await state.delay
        if (state.stale) return Response.json({ _tag: "ConflictError", message: "secret conflict" }, { status: 409 })
        state.item = { ...state.item, seen: true, seenAt: 3 }
        return Response.json({ data: state.item })
      }
      if (url.pathname === "/api/session/session-a") return Response.json({ data: state.session })
      if (url.pathname === "/api/session/session-a/message") {
        if (url.searchParams.get("directory") !== target || url.searchParams.get("location[directory]") !== target)
          return Response.json({ _tag: "InvalidRequestError", message: "Wrong target placement" }, { status: 400 })
        const next = url.searchParams.get("cursor") === "messages-2"
        return Response.json({
          data: [
            {
              id: next ? "message-2" : "message-1",
              type: "user",
              text: next ? "Target older page" : state.text,
              time: { created: 1 },
            },
          ],
          cursor: next ? { previous: "messages-1" } : { next: "messages-2" },
        })
      }
      return Response.json({ _tag: "InvalidRequestError", message: "Unexpected write or endpoint" }, { status: 400 })
    },
  })
  return {
    state,
    target,
    url: server.url.toString(),
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

test("Attention renderer reads only, explicitly marks the observed revision, preserves recovery, and guards pending input", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("Project A recovery")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
  await ui.select("Project A recovery")
  await ui.frame("Mark viewed")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
  let release = () => {}
  api.state.delay = new Promise<void>((resolve) => {
    release = resolve
  })
  await ui.select("Mark viewed")
  ui.app.mockInput.pressEnter()
  await until(() => api.state.calls.some((call) => call.method === "PUT"))
  expect(api.state.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
  expect(api.state.calls.find((call) => call.method === "PUT")?.body).toEqual({ revision: "revision-1" })
  release()
  await ui.frame("Viewed")
  expect(ui.app.captureCharFrame()).toContain("Recovery required")
  expect(ui.app.captureCharFrame()).not.toContain("Mark viewed")
  expect(api.state.item.state).toBe("recovery_required")
  expect(api.state.calls.every((call) => call.auth === "Bearer fixture-token")).toBe(true)
})

test("Attention uses generated paths, keyboard pagination, server filters, and stale revision refresh", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("Project A recovery")
  await ui.select("Next page")
  await ui.frame("Second page result")
  expect(api.state.calls.at(-1)?.query.get("cursor")).toBe("page-2")
  await ui.select("Previous page")
  await ui.frame("Project A recovery")
  await ui.select("View: Unviewed")
  await ui.frame("View: All")
  expect(api.state.calls.at(-1)?.query.get("view")).toBe("all")
  await ui.select("Type: All types")
  await ui.frame("No attention items match")
  expect(api.state.calls.at(-1)?.query.get("kind")).toBe("activity_failed")
  await ui.select("Type: Failed activity")
  await ui.frame("Project A recovery")
  expect(api.state.calls.at(-1)?.query.get("kind")).toBe("execution_recovery")
  await ui.select("Project A recovery")
  await ui.frame("Mark viewed")
  api.state.stale = true
  await ui.select("Mark viewed")
  await ui.frame("This item changed")
  expect(ui.app.captureCharFrame()).not.toContain("secret conflict")
  expect(ui.app.captureCharFrame()).not.toContain("Read session history")
  expect(api.state.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
  api.state.failure = true
  await ui.select("Refresh")
  await ui.frame("Request failed")
  await ui.type("", true)
  await ui.app.renderOnce()
  expect(ui.app.captureCharFrame()).not.toContain("Mark viewed")
  api.state.failure = false
  api.state.stale = false
  api.state.item.revision = "revision-2"
  await ui.select("Refresh")
  await ui.frame("Mark viewed")
  await ui.select("Mark viewed")
  await ui.frame("Viewed")
  expect(api.state.calls.filter((call) => call.method === "PUT").at(-1)?.body).toEqual({ revision: "revision-2" })
})

test("cross-project history resolves server placement, retains auth, and leaves current SDK directory unchanged", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("Project A recovery")
  await ui.select("Project A recovery")
  await ui.frame("Read session history")
  await ui.select("Read session history")
  await ui.frame("Target project message body")
  expect(ui.app.captureCharFrame().replace(/\s+/g, " ")).toContain("Cross-project editing is unavailable")
  const get = api.state.calls.find((call) => call.path === "/api/session/session-a")!
  const messages = api.state.calls.find((call) => call.path === "/api/session/session-a/message")!
  expect(get.query.get("directory")).toBe(tmp.path)
  expect(messages.query.get("directory")).toBe(api.target)
  expect(messages.query.get("location[directory]")).toBe(api.target)
  expect(messages.auth).toBe("Bearer fixture-token")
  expect(messages.directory).toBeNull()
  await ui.select("Next page")
  await ui.frame("Target older page")
  expect(api.state.calls.at(-1)?.query.get("cursor")).toBe("messages-2")
  await ui.select("Target older page")
  await ui.frame("Target older page")
  await ui.select("Back")
  await ui.frame("Read session history")
  await ui.select("Back")
  await ui.frame("Mark viewed")
  await ui.select("Back")
  await ui.frame("Project A recovery")
  expect(api.state.calls.at(-1)?.query.get("directory")).toBe(tmp.path)
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

test("disabled and failed capability are explicit and cannot mutate; refresh can recover", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.enabled = false
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("disabled in this host profile")
  expect(api.state.calls.map((call) => call.path)).toEqual(["/api/attention/capability"])
  api.state.failure = true
  await ui.select("Refresh")
  await ui.frame("Request failed")
  expect(ui.app.captureCharFrame()).not.toContain("secret diagnostic")
  api.state.failure = false
  api.state.enabled = true
  await ui.select("Refresh")
  await ui.frame("Project A recovery")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

test("changed placement refuses history and repeated list cursor fails without losing the current page", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("Project A recovery")
  api.state.repeatCursor = true
  await ui.select("Next page")
  await ui.frame("Request failed")
  api.state.repeatCursor = false
  await ui.select("Refresh")
  await ui.frame("Project A recovery")
  await ui.select("Project A recovery")
  await ui.frame("Read session history")
  api.state.session.location.directory = `${tmp.path}/wrong-project`
  await ui.select("Read session history")
  await ui.frame("This item changed")
  expect(api.state.calls.some((call) => call.path.endsWith("/message"))).toBe(false)
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

test("Attention is reachable from the real command palette and slash-command registry", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  let slash: (() => void) | undefined
  function Register() {
    const dialog = useDialog()
    const i18n = useTuiI18n()
    useBindings(() => ({ commands: [{ ...attentionCommand(dialog, i18n), namespace: "palette" }] }))
    const entries = useCommandSlashes()
    return (
      <box>
        <text>
          {(() => {
            const entry = entries().find((value) => value.display === "/attention")
            slash = entry?.onSelect
            return entry?.display ?? "missing slash"
          })()}
        </text>
      </box>
    )
  }
  using ui = await mountIM(tmp.path, api.url, () => <CommandPaletteDialog />, 100, Register)
  await ui.frame("Attention inbox")
  expect(api.state.calls).toHaveLength(0)
  expect(slash).toBeFunction()
  await ui.select("Attention inbox")
  await ui.frame("Project A recovery")
  const before = api.state.calls.length
  slash!()
  await until(() => api.state.calls.length > before)
  await ui.frame("Project A recovery")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

test("read-only message detail scrolls with the keyboard without calling a write endpoint", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.text = Array.from({ length: 30 }, (_, i) => `history-line-${String(i).padStart(2, "0")}`).join("\n")
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("Project A recovery")
  await ui.select("Project A recovery")
  await ui.frame("Read session history")
  await ui.select("Read session history")
  await ui.frame("history-line-00")
  await ui.select("history-line-00")
  await ui.frame("Ctrl+D / Ctrl+U")
  expect(ui.app.captureCharFrame()).not.toContain("history-line-29")
  for (let i = 0; i < 5; i++) {
    ui.app.mockInput.pressKey("d", { ctrl: true })
    await ui.app.renderOnce()
  }
  await ui.frame("history-line-29")
  for (let i = 0; i < 5; i++) {
    ui.app.mockInput.pressKey("u", { ctrl: true })
    await ui.app.renderOnce()
  }
  await ui.frame("history-line-00")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})
