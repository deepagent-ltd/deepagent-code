/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { DialogMcpSecrets } from "../src/component/dialog-mcp-secrets"
import { useSDK } from "../src/context/sdk"
import { useDialog } from "../src/ui/dialog"
import { tmpdir } from "./fixture/fixture"
import { mountIM, until } from "./fixture/im-environment"

function fixture(directory: string, mode: "normal" | "unknown" | "workspace" = "normal") {
  const preview = {
    name: "fixture",
    source: `${directory}/deepagent-code.json`,
    previewID: "a".repeat(32),
    fields: [{ field: "headers", key: "Authorization" }],
  }
  const state = {
    calls: [] as {
      method: string
      path: string
      directory: string | null
      workspace: string | null
      body: Record<string, unknown> | undefined
    }[],
    requestID: "",
    delay: undefined as Promise<void> | undefined,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "GET" ? undefined : ((await request.json()) as Record<string, unknown>)
      state.calls.push({
        method: request.method,
        path: url.pathname,
        directory: url.searchParams.get("directory"),
        workspace: url.searchParams.get("workspace"),
        body,
      })
      if (mode === "workspace")
        return Response.json({ code: "unavailable", error: "explicit workspace" }, { status: 503 })
      if (url.pathname.endsWith("/preview")) return Response.json(preview)
      if (url.pathname.endsWith("/commit")) {
        state.requestID = String(body?.requestID)
        if (mode === "unknown") return Response.json({ code: "unavailable", error: "unknown" }, { status: 503 })
      }
      await state.delay
      return Response.json({
        name: "fixture",
        requestID: state.requestID,
        state: mode === "unknown" ? "stored" : "committed",
        moved: mode === "unknown" ? 0 : 1,
      })
    },
  })
  return {
    state,
    preview,
    url: server.url.origin,
    posts: () => state.calls.filter((call) => call.method === "POST"),
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

function Panel(props: { directory: string; url: string; current: () => boolean; workspace?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  return (
    <DialogMcpSecrets
      name="fixture"
      client={sdk.client}
      directory={props.directory}
      workspace={props.workspace}
      server={props.url}
      current={props.current}
      close={() => dialog.clear()}
    />
  )
}

test("80x24 actual keyboard reviews before one generated SDK commit with the original preview and exact directory", async () => {
  await using root = await tmpdir()
  using api = fixture(root.path)
  using ui = await mountIM(
    root.path,
    api.url,
    () => <Panel directory={root.path} url={api.url} current={() => true} />,
    80,
  )
  ui.app.renderer.resize(80, 24)
  await ui.frame("Migrate these fields")
  expect(api.posts()).toHaveLength(0)
  ui.app.mockInput.pressArrow("down")
  ui.app.mockInput.pressArrow("down")
  ui.app.mockInput.pressArrow("down")
  ui.app.mockInput.pressEnter()
  await ui.frame("Move exactly the reviewed fields")
  expect(api.posts()).toHaveLength(0)
  ui.app.mockInput.pressEnter()
  ui.app.mockInput.pressEnter()
  await ui.frame("Committed · 1")
  expect(api.posts()).toHaveLength(1)
  expect(api.posts()[0]?.body).toEqual({ previewID: api.preview.previewID, requestID: api.state.requestID })
  expect(api.state.requestID).toMatch(/^[a-f0-9-]{36}$/)
  expect(api.state.calls.every((call) => call.directory === root.path && call.workspace === null)).toBe(true)
  expect(api.state.calls.filter((call) => call.path.endsWith("/preview"))).toHaveLength(2)
})

test("unknown commit permits original receipt inspection but host change and a late receipt cannot restore mutations", async () => {
  await using root = await tmpdir()
  using api = fixture(root.path, "unknown")
  const [current, setCurrent] = createSignal(true)
  using ui = await mountIM(
    root.path,
    api.url,
    () => <Panel directory={root.path} url={api.url} current={current} />,
    80,
  )
  ui.app.renderer.resize(80, 24)
  await ui.frame("Migrate these fields")
  ui.app.mockInput.pressArrow("down")
  ui.app.mockInput.pressArrow("down")
  ui.app.mockInput.pressArrow("down")
  ui.app.mockInput.pressEnter()
  await ui.frame("Move exactly the reviewed fields")
  ui.app.mockInput.pressEnter()
  await ui.frame("Outcome unknown.")
  expect(api.posts()).toHaveLength(1)
  expect(ui.app.captureCharFrame()).not.toContain("Migrate these fields")
  const release = Promise.withResolvers<void>()
  api.state.delay = release.promise
  ui.app.mockInput.pressArrow("down")
  ui.app.mockInput.pressArrow("down")
  ui.app.mockInput.pressEnter()
  await until(
    () => api.state.calls.some((call) => call.path.endsWith(`/${api.state.requestID}`)),
    "original receipt GET",
  )
  setCurrent(false)
  release.resolve()
  await ui.frame("Server, credentials or directory changed.")
  setCurrent(true)
  ui.app.mockInput.pressEnter()
  await Bun.sleep(30)
  expect(api.posts()).toHaveLength(1)
  expect(api.state.calls.filter((call) => call.path.endsWith(`/${api.state.requestID}`))).toHaveLength(1)
})

test("explicit workspace is sent to the real SDK boundary and unavailable never initializes implicitly", async () => {
  await using root = await tmpdir()
  using api = fixture(root.path, "workspace")
  using ui = await mountIM(
    root.path,
    api.url,
    () => <Panel directory={root.path} workspace="explicit-workspace" url={api.url} current={() => true} />,
    80,
  )
  ui.app.renderer.resize(80, 24)
  await ui.frame("Unavailable in this scope.")
  expect(api.state.calls).toHaveLength(1)
  expect(api.state.calls[0]?.workspace).toBe("explicit-workspace")
  expect(api.posts()).toHaveLength(0)
})
