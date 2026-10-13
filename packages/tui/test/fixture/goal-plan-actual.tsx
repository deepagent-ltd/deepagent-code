/** @jsxImportSource @opentui/solid */
import assert from "node:assert/strict"
import { mock } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { dict } from "../../src/i18n/en"

import { Global } from "@deepagent-code/core/global"
import type { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"
import { createTuiResolvedConfig } from "./tui-runtime"
import fs from "node:fs/promises"
import path from "node:path"

let cleaning = false
process.on("unhandledRejection", (error: unknown) => {
  if (cleaning && error instanceof Error && error.name === "AbortError") return
  console.error("Unexpected unhandled fixture rejection", error)
  process.exitCode = 1
})
const root = process.env.DAC_GOAL_PLAN_FIXTURE_ROOT!
const directory = process.cwd()
const chinese = process.env.LANG?.startsWith("zh")
const localized = chinese ? await import("../../src/i18n/zh") : undefined
const text = (value: string) => {
  const key = Object.keys(dict).find((key) => dict[key as keyof typeof dict] === value)
  return key && localized ? (localized.dict[key as keyof typeof localized.dict] ?? value) : value
}
const modulePath = path.resolve(import.meta.dir, "../../../deepagent-code/src/cli/tui/goal-plan-bridge.ts")
const { createGoalPlanBridge } = (await import(modulePath)) as {
  createGoalPlanBridge(
    worker: Worker,
    directory: string,
  ): Promise<{ transport: GoalPlanClient.Transport; close(): void }>
}
let providerRequests = 0
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    providerRequests++
    return new Response("No generation authorized in this UI fixture", { status: 503 })
  },
})
await fs.writeFile(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({
    permission: { "*": "ask" },
    mcp: {},
    lsp: false,
    model: "fixture/fixture-model",
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local fixture",
        options: { baseURL: `${provider.url}v1`, apiKey: "fixture-no-secret" },
        models: { "fixture-model": { name: "Fixture model", limit: { context: 32768, output: 1024 } } },
      },
    },
  }),
)
if (process.env.DAC_GOAL_PLAN_TUI_THEME)
  await fs.writeFile(
    path.join(Global.Path.state, "kv.json"),
    JSON.stringify({ theme_mode_lock: process.env.DAC_GOAL_PLAN_TUI_THEME }),
  )
const worker = new Worker(new URL("../../../deepagent-code/test/server/fixture/goal-plan-worker.ts", import.meta.url))
const seed = new Promise<{ sessionID: string; goalID: string; url: string }>((resolve) =>
  worker.addEventListener("message", (event) => {
    if (event.data?.fixture === "seed") resolve(event.data)
  }),
)
const bridgePromise = createGoalPlanBridge(worker, directory)
worker.addEventListener("error", (event) => console.error(event.message))
async function probe(kind: string) {
  const promise = new Promise<unknown>((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.data?.fixture === kind) {
        worker.removeEventListener("message", listener)
        resolve(event.data)
      }
    }
    worker.addEventListener("message", listener)
  })
  worker.postMessage({ fixture: kind })
  return promise
}
const setup = await createTestRenderer({
  width: Number(process.env.DAC_GOAL_PLAN_TUI_WIDTH ?? 100),
  height: 36,
  useThread: false,
  kittyKeyboard: true,
})
const core = await import("@opentui/core")
mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
const target = await seed
const bridge = await bridgePromise
const whenSettled = bridge.transport.whenSettled
assert.equal(typeof whenSettled, "function")
if (!whenSettled) throw new Error("Native bridge has no ownership barrier")
const auth = `Basic ${Buffer.from(`fixture-operator:${process.env.DEEPAGENT_CODE_SERVER_PASSWORD}`).toString("base64")}`
const frames: { name: string; frame: string }[] = []
const events: unknown[] = []
const streams: ReadableStreamDefaultReader<Uint8Array>[] = []
const http: { path: string; method?: string; status: number; shape?: unknown }[] = []
async function frame(name: string, expected: string, timeout = 15000) {
  const match = text(expected)
  const started = Date.now()
  for (;;) {
    await setup.renderOnce()
    const value = setup.captureCharFrame()
    if (value.includes(match) || value.replace(/\s+/g, " ").includes(match)) {
      frames.push({ name, frame: value })
      return value
    }
    if (Date.now() - started > timeout) {
      await fs.writeFile(path.join(root, "diagnostic.json"), JSON.stringify({ http, events, frames, frame: value }))
      throw new Error(`Missing ${match}\n${value}`)
    }
    await Bun.sleep(20)
  }
}
async function textarea() {
  const start = Date.now()
  while (!(setup.renderer.currentFocusedEditor instanceof core.TextareaRenderable)) {
    if (Date.now() - start > 3000) throw new Error("Actual dialog textarea was not focused")
    await Bun.sleep(10)
  }
}
async function select(index: number) {
  await Bun.sleep(80)
  for (let count = 0; count < index; count++) {
    setup.mockInput.pressArrow("down")
    await Bun.sleep(10)
  }
  setup.mockInput.pressEnter()
}
async function publish(command: string) {
  const response = await fetch(new URL(`/tui/publish?directory=${encodeURIComponent(directory)}`, target.url), {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ type: "tui.command.execute", properties: { command } }),
  })
  const body = await response.text()
  http.push({ path: `publish:${command}`, status: response.status, shape: body })
  assert.equal(response.status, 200, body)
}
const { run } = await import("../../src/app")
const task = Effect.runPromise(
  run({
    url: "http://deepagent-code.internal",
    directory,
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        // Production local TUI has a stable internal URL. This test routes that exact
        // SDK request to an owned real HTTP listener instead of an in-memory fake.
        const url = new URL(input instanceof Request ? input.url : String(input))
        const endpoint = new URL(url.pathname + url.search, target.url)
        const response = await fetch(input instanceof Request ? new Request(endpoint, input) : endpoint, init)
        if (url.pathname === "/global/event") {
          const reader = response.clone().body!.getReader()
          streams.push(reader)
          void (async () => {
            let buffer = ""
            const decoder = new TextDecoder()
            for (;;) {
              const chunk = await reader.read()
              if (chunk.done) break
              buffer += decoder.decode(chunk.value, { stream: true })
              const lines = buffer.split("\n")
              buffer = lines.pop()!
              for (const line of lines)
                if (line.startsWith("data:")) {
                  events.push(JSON.parse(line.slice(5)))
                  if (events.length > 100) events.shift()
                }
            }
          })().catch(() => undefined)
        }
        const shape =
          url.pathname.startsWith("/session") || url.pathname === "/project/current"
            ? await response
                .clone()
                .json()
                .catch(() => undefined)
            : undefined
        http.push({
          path: url.pathname,
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          status: response.status,
          shape,
        })
        return response
      },
      { preconnect: fetch.preconnect },
    ),
    headers: { Authorization: auth },
    goalPlan: bridge.transport,
    config: createTuiResolvedConfig({ plugin_enabled: {} }),
    args: { sessionID: target.sessionID, agent: "auto", model: "fixture/fixture-model" },
    pluginHost: { async start() {}, async dispose() {} },
  }).pipe(Effect.provide(Global.defaultLayer)),
)
try {
  while (!http.some((item) => item.path === `/session/${target.sessionID}/message` && item.status === 200))
    await Bun.sleep(20)
  await Bun.sleep(250)
  await setup.renderOnce()
  frames.push({ name: "session", frame: setup.captureCharFrame() })
  setup.mockInput.pressKey("p", { ctrl: true })
  await frame("palette", "Commands")
  await Bun.sleep(100)
  await setup.mockInput.typeText(chinese ? text("Show plan") : "plan", 20)
  await frame("palette-filter", "Show plan")
  setup.mockInput.pressEnter()
  if (process.env.DAC_GOAL_PLAN_TUI_MODE === "cold-view") {
    await frame("cold-plan", "Plan saved")
    const observed = await probe("snapshot")
    setup.mockInput.pressEnter()
    await frame("cold-refreshed", "Plan saved")
    assert.deepEqual(await probe("snapshot"), observed)
    // MCP invocation listing uses POST for a read-only query; every other POST
    // remains a forbidden mutation while the saved plan is only being viewed.
    assert.equal(http.filter((request) => request.method === "POST" &&
      !(request.path === "/mcp/apps/invocations/list" && request.status === 200)).length, 0)
    await fs.writeFile(
      path.join(root, "tui-actual-result.json"),
      JSON.stringify({ target, frames, before: observed, final: observed, providerRequests, http, events }),
    )
    assert.equal(providerRequests, 0)
  } else {
    await frame("plan-open", "Prepare edit")
    const before = await probe("snapshot")
    await publish("dialog.select.submit")
    await publish("session.plan")
    await publish("session.toggle.auto_accept")
    // The toast observes the same real HTTP->SSE bus after the malicious commands.
    const barrier = await fetch(new URL(`/tui/publish?directory=${encodeURIComponent(directory)}`, target.url), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({
        type: "tui.toast.show",
        properties: { message: "relay fence reached", variant: "info", duration: 3000 },
      }),
    })
    http.push({ path: "toast", status: barrier.status, shape: await barrier.text() })
    if (!process.env.DAC_GOAL_PLAN_DIAG_KEYBOARD) await frame("relay-guard", "relay fence reached")
    assert.deepEqual(await probe("snapshot"), before)
    setup.mockInput.pressEnter()
    await frame("prepared", "Ready to edit; Goal is paused")
    const after = await probe("snapshot")
    assert.notDeepEqual(after, before)
    await select(1)
    await frame("steps", "Completed source")
    setup.mockInput.pressEnter()
    await frame("completed-readonly", "original-proof")
    setup.mockInput.pressEnter()
    await frame("return-steps", "Completed source")
    await select(1)
    await frame("step-fields", "Acceptance criterion")
    setup.mockInput.pressEnter()
    await textarea()
    await frame("title-prompt", "Future source")
    setup.mockInput.pressKey("end")
    for (let index = 0; index < 40; index++) {
      setup.mockInput.pressBackspace()
      await Bun.sleep(5)
    }
    await setup.mockInput.typeText("中文 revised future", 10)
    setup.mockInput.pressEnter()
    await frame("edited-steps", "中文 revised future")
    await select(3)
    await textarea()
    await frame("reason", "Reason for this plan revision")
    await Bun.sleep(100)
    await setup.mockInput.typeText("Explicit local operator revision", 10)
    setup.mockInput.pressEnter()
    await frame("reason-saved", "Explicit local operator revision")
    await select(4)
    await frame("return-edit", "Review permissions and apply")
    setup.mockInput.pressArrow("down")
    await select(1)
    await frame("apply-wait", "Close to review permission")
    const permissionDeadline = Date.now() + 10000
    for (;;) {
      const pending = await probe("permissions")
      if (
        pending &&
        typeof pending === "object" &&
        "data" in pending &&
        Array.isArray(pending.data) &&
        pending.data.length === 1
      )
        break
      if (Date.now() > permissionDeadline) throw new Error("Native Apply never reached actual Permission")
      await Bun.sleep(20)
    }
    setup.mockInput.pressEnter()
    if (Number(process.env.DAC_GOAL_PLAN_TUI_WIDTH ?? 100) < 80) setup.mockInput.pressKey("f", { ctrl: true })
    await frame("permission", "Allow once")
    const awaiting = await probe("snapshot")
    await publish("session.toggle.auto_accept")
    await publish("permission.reply.once")
    await publish("dialog.select.submit")
    const fence = await fetch(new URL(`/tui/publish?directory=${encodeURIComponent(directory)}`, target.url), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({
        type: "tui.toast.show",
        properties: { message: "approval relay fence reached", variant: "info", duration: 3000 },
      }),
    })
    assert.equal(fence.status, 200)
    const fenceDeadline = Date.now() + 5000
    while (
      !events.some(
        (event) =>
          event &&
          typeof event === "object" &&
          "payload" in event &&
          event.payload &&
          typeof event.payload === "object" &&
          "type" in event.payload &&
          event.payload.type === "tui.toast.show" &&
          "properties" in event.payload &&
          event.payload.properties &&
          typeof event.payload.properties === "object" &&
          "message" in event.payload.properties &&
          event.payload.properties.message === "approval relay fence reached",
      )
    ) {
      if (Date.now() > fenceDeadline) throw new Error("Actual SSE approval fence was not observed")
      await Bun.sleep(10)
    }
    await setup.renderOnce()
    frames.push({ name: "approval-relay-guard", frame: setup.captureCharFrame() })
    assert.deepEqual(await probe("snapshot"), awaiting)
    const pending = await probe("permissions")
    assert(
      pending &&
        typeof pending === "object" &&
        "data" in pending &&
        Array.isArray(pending.data) &&
        pending.data.length === 1,
    )
    if (process.env.DAC_GOAL_PLAN_TUI_MODE === "timeout") {
      await whenSettled()
      await publish("session.toggle.auto_accept")
      await publish("permission.reply.once")
      await Bun.sleep(150)
    } else {
      setup.mockInput.pressEnter()
      await whenSettled()
      await Bun.sleep(100)
    }
    frames.push({ name: "after-approval", frame: setup.captureCharFrame() })
    const final = await probe("snapshot")
    assert(final && typeof final === "object" && "data" in final)
    if (process.env.DAC_GOAL_PLAN_TUI_MODE === "timeout") assert.deepEqual(final, awaiting)
    else assert.notDeepEqual(final, awaiting)
    await fs.writeFile(
      path.join(root, "tui-actual-result.json"),
      JSON.stringify({
        target: { sessionID: target.sessionID, goalID: target.goalID },
        frames,
        before,
        after,
        final,
        providerRequests,
        http,
        events,
      }),
    )
    assert.equal(providerRequests, 0)
  }
} finally {
  cleaning = true
  for (const stream of streams) void stream.cancel().catch(() => undefined)
  setup.renderer.destroy()
  await task.catch(() => undefined)
  bridge.close()
  worker.postMessage({ fixture: "shutdown" })
  setTimeout(() => worker.terminate(), 2000).unref()
  await provider.stop(true)
  mock.restore()
}
