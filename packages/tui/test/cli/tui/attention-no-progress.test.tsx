/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { AttentionItem } from "@deepagent-code/sdk"
import { DialogAttention } from "../../../src/component/dialog-attention"
import { SDKProvider } from "../../../src/context/sdk"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../../src/keymap"
import { KVProvider } from "../../../src/context/kv"
import { TuiI18nProvider, useTuiI18n } from "../../../src/context/i18n"
import { ThemeProvider } from "../../../src/context/theme"
import { ToastProvider } from "../../../src/ui/toast"
import { TuiConfigProvider } from "../../../src/config"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { eventSource } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"
import { mountIM, until } from "../../fixture/im-environment"

function fixture() {
  const item: AttentionItem = {
    id: "no-progress:original-activity",
    revision: "original-revision",
    kind: "no_progress",
    state: "needs_human",
    reasonCode: "no_progress",
    occurredAt: 1,
    observedAt: 2,
    seen: false,
    seenAt: null,
    session: {
      id: "original-session",
      title: "Original paused activity",
      projectID: "original-project",
      directory: "/projects/original",
      workspaceID: null,
    },
    source: {
      activityID: "original-activity",
      permissionRequestID: "original-permission",
      expiresAt: Date.now() + 60000,
    },
    allowedActions: ["continue_once", "terminate"],
  }
  const state = {
    item,
    reads: 0,
    fresh: undefined as AttentionItem | undefined,
    delay: undefined as Promise<void> | undefined,
    postDelay: undefined as Promise<void> | undefined,
    postStatus: 204,
    calls: [] as { method: string; path: string; body: unknown; auth: string | null }[],
  }
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname)
      const body: unknown = request.method === "GET" ? undefined : await request.json()
      state.calls.push({ method: request.method, path, body, auth: request.headers.get("authorization") })
      if (path === "/api/attention/capability")
        return Response.json({ enabled: true, actor: "server", scope: "implicit-local", reason: "enabled" })
      if (path === "/api/attention")
        return Response.json({
          data: [state.item],
          unseenCount: Number(!state.item.seen),
          asOf: 2,
          scope: "implicit-local",
        })
      if (path === `/api/attention/${item.id}`) {
        state.reads++
        if (state.reads > 1) await state.delay
        return Response.json({ data: state.reads > 1 ? (state.fresh ?? state.item) : state.item })
      }
      if (path.endsWith("/seen")) {
        state.item = { ...state.item, seen: true, seenAt: 3 }
        return Response.json({ data: state.item })
      }
      if (path === "/api/session/original-session/permission/original-permission/reply") {
        await state.postDelay
        if (state.postStatus !== 204)
          return Response.json({ message: "private diagnostic" }, { status: state.postStatus })
        state.item = { ...state.item, allowedActions: [] }
        return new Response(null, { status: 204 })
      }
      return Response.json({}, { status: 404 })
    },
  })
  return {
    state,
    url: listener.url.toString(),
    replies: () => state.calls.filter((call) => call.method === "POST"),
    [Symbol.dispose]() {
      listener.stop(true)
    },
  }
}

// A replacement SDK is a new process-local UI owner. Mount it at the root instead of hiding
// it beneath a dialog whose existing context was already captured by the outer provider.
async function replacement(root: string, url: string, auth: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ tui_locale: "en", animations_enabled: false }))
  function Open() {
    const dialog = useDialog()
    useTuiI18n().setLocale("en")
    onMount(() => dialog.replace(() => <DialogAttention />))
    return <box />
  }
  function Root() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <SDKProvider url={url} directory={root} events={eventSource()} headers={{ Authorization: auth }}>
                    <TuiI18nProvider>
                      <DialogProvider>
                        <Open />
                      </DialogProvider>
                    </TuiI18nProvider>
                  </SDKProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Root />, { width: 80, height: 24, kittyKeyboard: true })
  return {
    app,
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}

test("80x24 reads and seen never approve; continue once validates then sends one real SDK reply", async () => {
  await using root = await tmpdir()
  using api = fixture()
  using ui = await mountIM(root.path, api.url, () => <DialogAttention />, 80)
  ui.app.renderer.resize(80, 24)
  await ui.frame("Original paused activity")
  await ui.select("Original paused activity")
  await ui.frame("Continue once")
  expect(api.replies()).toHaveLength(0)
  await ui.select("Mark viewed")
  await ui.frame("Viewed")
  expect(api.replies()).toHaveLength(0)
  await ui.select("Continue once")
  await ui.frame("Decision submitted")
  expect(api.replies()).toEqual([
    {
      method: "POST",
      path: "/api/session/original-session/permission/original-permission/reply",
      body: { reply: "once" },
      auth: "Bearer fixture-token",
    },
  ])
  expect(api.state.reads).toBe(3)
})

test("terminate-only approval requires a separate confirmation and never replies always", async () => {
  await using root = await tmpdir()
  using api = fixture()
  api.state.item.allowedActions = ["terminate"]
  using ui = await mountIM(root.path, api.url, () => <DialogAttention />, 80)
  ui.app.renderer.resize(80, 24)
  await ui.frame("Original paused activity")
  await ui.select("Original paused activity")
  await ui.frame("Stop activity")
  expect(ui.app.captureCharFrame()).not.toContain("Continue once")
  await ui.select("Stop activity")
  await ui.frame("Confirm stop")
  expect(api.replies()).toHaveLength(0)
  await ui.select("Confirm stop")
  await ui.frame("Decision submitted")
  expect(api.replies()[0]?.body).toEqual({ reply: "reject" })
})

test.each(["expiry", "source", "actions"])("fresh %s change blocks the original pending permission", async (change) => {
  await using root = await tmpdir()
  using api = fixture()
  using ui = await mountIM(root.path, api.url, () => <DialogAttention />, 80)
  ui.app.renderer.resize(80, 24)
  await ui.frame("Original paused activity")
  await ui.select("Original paused activity")
  await ui.frame("Continue once")
  api.state.fresh = {
    ...api.state.item,
    source:
      change === "source"
        ? { ...api.state.item.source, activityID: "replacement" }
        : change === "expiry"
          ? { ...api.state.item.source, expiresAt: Date.now() - 1 }
          : api.state.item.source,
    allowedActions: change === "actions" ? ["terminate"] : api.state.item.allowedActions,
  }
  await ui.select("Continue once")
  await ui.frame("This approval changed or expired")
  expect(api.replies()).toHaveLength(0)
})

test("double Enter makes one request; 503 keeps context and cannot retry automatically", async () => {
  await using root = await tmpdir()
  using api = fixture()
  const delay = Promise.withResolvers<void>()
  api.state.postDelay = delay.promise
  api.state.postStatus = 503
  using ui = await mountIM(root.path, api.url, () => <DialogAttention />, 80)
  ui.app.renderer.resize(80, 24)
  await ui.frame("Original paused activity")
  await ui.select("Original paused activity")
  await ui.frame("Continue once")
  await ui.select("Continue once")
  ui.app.mockInput.pressEnter()
  await until(() => api.replies().length === 1)
  delay.resolve()
  await ui.frame("Request failed")
  expect(api.replies()).toHaveLength(1)
  expect(ui.app.captureCharFrame()).toContain("Original paused activity")
  expect(ui.app.captureCharFrame()).not.toContain("private diagnostic")
})

test.each(["server", "credentials"])(
  "%s owner replacement discards a delayed original item before reply",
  async (change) => {
    await using root = await tmpdir()
    using first = fixture()
    using next = fixture()
    next.state.item = { ...next.state.item, session: { ...next.state.item.session, title: "Replacement activity" } }
    const delay = Promise.withResolvers<void>()
    first.state.delay = delay.promise
    const ui = await mountIM(root.path, first.url, () => <DialogAttention />, 80)
    let disposed = false
    try {
      ui.app.renderer.resize(80, 24)
      await ui.frame("Original paused activity")
      await ui.select("Original paused activity")
      await ui.frame("Continue once")
      await ui.select("Continue once")
      await until(() => first.state.reads === 2)
      ui[Symbol.dispose]()
      disposed = true
      using fresh = await replacement(
        root.path,
        change === "credentials" ? first.url : next.url,
        "Bearer replacement-token",
      )
      await until(
        () => first.state.calls.concat(next.state.calls).some((call) => call.auth === "Bearer replacement-token"),
        "replacement SDK request",
      )
      delay.resolve()
      await fresh.app.renderOnce()
      expect(first.replies()).toHaveLength(0)
      expect(next.replies()).toHaveLength(0)
    } finally {
      delay.resolve()
      if (!disposed) ui[Symbol.dispose]()
    }
  },
)

test("closing pending validation cancels its ownership and cannot send a late reply", async () => {
  await using root = await tmpdir()
  using api = fixture()
  const delay = Promise.withResolvers<void>()
  api.state.delay = delay.promise
  function Close() {
    const dialog = useDialog()
    useBindings(() => ({
      bindings: [{ key: "ctrl+x", desc: "Close owner", group: "Fixture", cmd: () => dialog.clear() }],
    }))
    return <text>Original context retained</text>
  }
  using ui = await mountIM(
    root.path,
    api.url,
    () => <DialogAttention />,
    80,
    () => <Close />,
  )
  ui.app.renderer.resize(80, 24)
  await ui.frame("Original paused activity")
  await ui.select("Original paused activity")
  await ui.frame("Continue once")
  await ui.select("Continue once")
  await until(() => api.state.reads === 2)
  ui.app.mockInput.pressKey("x", { ctrl: true })
  delay.resolve()
  await ui.frame("Original context retained")
  expect(api.replies()).toHaveLength(0)
})
