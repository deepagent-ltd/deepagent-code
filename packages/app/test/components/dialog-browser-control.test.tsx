import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { createServer } from "node:http"
import { createHash, webcrypto } from "node:crypto"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DialogBrowserControl } from "@/components/dialog-browser-control"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({ sdk: {} as object, close: vi.fn() }))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ close: wiring.close }) }))
vi.mock("@deepagent-code/ui/dialog", () => ({
  Dialog: (props: { title: string; children: JSX.Element }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it("bounded program approval binds its own operations and step cap through unknown retry and explicit handoff", async () => {
  vi.stubGlobal("crypto", webcrypto)
  const calls: Record<string, unknown>[] = []
  const source = 'return {version:1,steps:[{type:"fill",target:"field",text:args.value}]}'
  const argsJSON = '{"value":"approved"}'
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(new Uint8Array(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    calls.push(body)
    response.setHeader("Content-Type", "application/json")
    if (calls.length === 1) { response.writeHead(503); response.end(JSON.stringify({ code: "BROWSER_UNKNOWN" })); return }
    response.end(JSON.stringify({ control: { ...body, controlID: "program-control", revision: 1, state: "active",
      expiresAt: Date.now() + 60_000, scope: { sessionID: "program-session", directory: "/program-project" } },
      availability: "available", nativeVerification: "verified", stopConfirmed: false }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Original HTTP peer was not bound")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  wiring.sdk = { client, directory: "/program-project", scope: "program" }
  const used = vi.fn()
  try {
    render(() => <DialogBrowserControl sessionID="program-session" onUse={used} />)
    const mode = within(screen.getByRole("group", { name: dict["browser.control.program.mode"] })).getByRole("button")
    mode.focus()
    fireEvent.keyDown(mode, { key: "ArrowDown" })
    const option = await screen.findByRole("option", { name: dict["browser.control.program.name"] })
    option.focus()
    fireEvent.keyDown(option, { key: "Enter" })
    expect(screen.getByRole("checkbox", { name: dict["browser.control.program.operation.fill"] })).toHaveProperty("checked", true)
    fireEvent.click(screen.getByRole("checkbox", { name: dict["browser.control.program.operation.click"] }))
    fireEvent.input(screen.getByLabelText(dict["browser.control.program.steps"]), { target: { value: "2" } })
    fireEvent.input(screen.getByLabelText(dict["browser.control.scriptSource"]), { target: { value: source } })
    fireEvent.input(screen.getByLabelText(dict["browser.control.scriptArgs"]), { target: { value: argsJSON } })
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    await screen.findByRole("alert")
    expect(calls).toHaveLength(1)
    const hashes = { scriptHash: createHash("sha256").update(source).digest("hex"),
      argsHash: createHash("sha256").update(argsJSON).digest("hex") }
    expect(calls[0]?.programGrants).toEqual([{ ...hashes, operations: ["fill", "click"], maxSteps: 2 }])
    expect(calls[0]?.scriptGrants).toBeUndefined()
    expect(calls[0]?.clipboardPolicy).toBeUndefined()
    cleanup()
    render(() => <DialogBrowserControl sessionID="program-session" onUse={used} />)
    expect(calls).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.retry"] }))
    await screen.findByText(dict["browser.control.program.ready"])
    expect(calls[1]).toEqual(calls[0])
    expect(used).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.program.use"] }))
    expect(used).toHaveBeenCalledWith("program-control", { source, argsJSON, ...hashes,
      mode: "program", operations: ["fill", "click"], maxSteps: 2 })
  } finally {
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it("unverified native clipboard stays unavailable and an unknown retry cannot introduce its grant", async () => {
  const calls: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(new Uint8Array(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    calls.push(body)
    response.setHeader("Content-Type", "application/json")
    if (calls.length === 1) { response.writeHead(503); response.end(JSON.stringify({ code: "BROWSER_UNKNOWN" })); return }
    response.end(JSON.stringify({ control: { ...body, controlID: "clipboard-control", revision: 1, state: "active",
      scope: { sessionID: "clipboard-session", directory: "/clipboard-project" } },
      availability: "available", nativeVerification: "verified", stopConfirmed: false }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Original HTTP peer was not bound")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  wiring.sdk = { client, directory: "/clipboard-project", scope: "clipboard" }
  const used = vi.fn()
  try {
    render(() => <DialogBrowserControl sessionID="clipboard-session" onUse={used} />)
    expect(screen.getByText(dict["browser.control.clipboard.unavailable"])).toBeTruthy()
    expect(screen.queryByRole("group", { name: dict["browser.control.clipboard.label"] })).toBeNull()
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    await screen.findByRole("alert")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.clipboardPolicy).toBeUndefined()
    cleanup()
    render(() => <DialogBrowserControl sessionID="clipboard-session" onUse={used} />)
    expect(calls).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.retry"] }))
    await screen.findByText(dict["browser.control.active"])
    expect(calls[1]).toEqual(calls[0])
    expect(used).not.toHaveBeenCalled()
  } finally {
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it("public interaction explicitly pins page scripts and exact same-origin submission through unknown retry", async () => {
  const calls: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(new Uint8Array(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    calls.push(body)
    response.setHeader("Content-Type", "application/json")
    if (calls.length === 1) { response.writeHead(503); response.end(JSON.stringify({ code: "BROWSER_UNKNOWN" })); return }
    response.end(JSON.stringify({ control: { ...body, controlID: "public-interaction-control", revision: 1, state: "active",
      scope: { sessionID: "public-interaction-session", directory: "/public-interaction-project" } },
      availability: "available", nativeVerification: "verified", stopConfirmed: false }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Original HTTP peer was not bound")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  wiring.sdk = { client, directory: "/public-interaction-project", scope: "public" }
  const used = vi.fn()
  try {
    render(() => <DialogBrowserControl sessionID="public-interaction-session" onUse={used} />)
    const mode = within(screen.getByRole("group", { name: dict["browser.control.mode"] })).getByRole("button")
    mode.focus()
    fireEvent.keyDown(mode, { key: "ArrowDown" })
    const publicOption = await screen.findByRole("option", { name: dict["browser.control.publicInteraction"] })
    publicOption.focus()
    fireEvent.keyDown(publicOption, { key: "Enter" })
    expect(calls).toHaveLength(0)
    fireEvent.input(screen.getByLabelText(dict["browser.control.paths"]), { target: { value: "/submit\n/submit" } })
    const pageMode = within(screen.getByRole("group", { name: dict["browser.control.pageMode"] })).getByRole("button")
    expect(pageMode.textContent).toContain(dict["browser.control.pageStatic"])
    pageMode.focus()
    fireEvent.keyDown(pageMode, { key: "ArrowDown" })
    const dynamic = await screen.findByRole("option", { name: dict["browser.control.pageDynamic"] })
    dynamic.focus()
    fireEvent.keyDown(dynamic, { key: "Enter" })
    expect(screen.queryByLabelText(dict["browser.control.scriptSource"])).toBeNull()
    expect(within(screen.getByRole("group", { name: dict["browser.control.resolver"] })).getByRole("button").textContent)
      .toContain(dict["browser.control.resolverSystem"])
    fireEvent.input(screen.getByLabelText(dict["browser.control.approvedOrigins"]), { target: { value: "https://www.example.com\nhttps://example.com" } })
    const resolver = within(screen.getByRole("group", { name: dict["browser.control.resolver"] })).getByRole("button")
    resolver.focus()
    fireEvent.keyDown(resolver, { key: "ArrowDown" })
    const cloudflareOption = await screen.findByRole("option", { name: dict["browser.control.resolverCloudflare"] })
    cloudflareOption.focus()
    fireEvent.keyDown(cloudflareOption, { key: "Enter" })
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    await screen.findByRole("alert")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ profile: "managed-public-interaction-v1", origin: "https://example.com",
      approvedOrigins: ["https://example.com", "https://www.example.com"], resolverPolicy: "cloudflare_doh_v1", pageMode: "dynamic",
      postTargets: [{ origin: "https://example.com", path: "/submit" }] })
    expect(calls[0]?.postPaths).toBeUndefined()
    expect(calls[0]?.scriptGrants).toBeUndefined()
    expect(calls[0]?.programGrants).toBeUndefined()
    expect(calls[0]?.filePolicy).toBeUndefined()
    expect(calls[0]?.clipboardPolicy).toBeUndefined()
    cleanup()
    render(() => <DialogBrowserControl sessionID="public-interaction-session" onUse={used} />)
    expect(calls).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.retry"] }))
    await screen.findByText(dict["browser.control.active"])
    expect(calls[1]).toEqual(calls[0])
    expect(used).not.toHaveBeenCalled()
  } finally {
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it("public static permission requires explicit DNS choice and preserves exact origins after an unknown HTTP response", async () => {
  const calls: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(new Uint8Array(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    calls.push(body)
    response.setHeader("Content-Type", "application/json")
    if (calls.length === 1) { response.writeHead(503); response.end(JSON.stringify({ code: "BROWSER_UNKNOWN" })); return }
    response.end(JSON.stringify({ control: { ...body, controlID: "public-control", revision: 1, state: "active",
      scope: { sessionID: "public-session", directory: "/public-project" } },
      availability: "available", nativeVerification: "verified", stopConfirmed: false }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Original HTTP peer was not bound")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  wiring.sdk = { client, directory: "/public-project", scope: "public" }
  const used = vi.fn()
  try {
    render(() => <DialogBrowserControl sessionID="public-session" onUse={used} />)
    const mode = within(screen.getByRole("group", { name: dict["browser.control.mode"] })).getByRole("button")
    mode.focus()
    fireEvent.keyDown(mode, { key: "ArrowDown" })
    const publicOption = await screen.findByRole("option", { name: dict["browser.control.publicReadonly"] })
    publicOption.focus()
    fireEvent.keyDown(publicOption, { key: "Enter" })
    expect(calls).toHaveLength(0)
    expect(screen.queryByLabelText(dict["browser.control.paths"])).toBeNull()
    expect(screen.queryByLabelText(dict["browser.control.scriptSource"])).toBeNull()
    expect(within(screen.getByRole("group", { name: dict["browser.control.resolver"] })).getByRole("button").textContent)
      .toContain(dict["browser.control.resolverSystem"])
    fireEvent.input(screen.getByLabelText(dict["browser.control.approvedOrigins"]), { target: { value: "https://www.example.com\nhttps://example.com" } })
    const resolver = within(screen.getByRole("group", { name: dict["browser.control.resolver"] })).getByRole("button")
    resolver.focus()
    fireEvent.keyDown(resolver, { key: "ArrowDown" })
    const cloudflareOption = await screen.findByRole("option", { name: dict["browser.control.resolverCloudflare"] })
    cloudflareOption.focus()
    fireEvent.keyDown(cloudflareOption, { key: "Enter" })
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    await screen.findByRole("alert")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ profile: "managed-public-readonly-v1", origin: "https://example.com",
      approvedOrigins: ["https://example.com", "https://www.example.com"], resolverPolicy: "cloudflare_doh_v1" })
    expect(calls[0]?.postPaths).toBeUndefined()
    expect(calls[0]?.scriptGrants).toBeUndefined()
    cleanup()
    render(() => <DialogBrowserControl sessionID="public-session" onUse={used} />)
    expect(calls).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.retry"] }))
    await screen.findByText(dict["browser.control.active"])
    expect(calls[1]).toEqual(calls[0])
    expect(used).not.toHaveBeenCalled()
  } finally {
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it("explicit connection retains the same request after unknown and only confirmed cancel reports stopped", async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = []
  let unknown = true
  let stopped = false
  const client = createDeepAgentCodeClient({
    baseUrl: "http://fixture.invalid",
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        const body = request.method === "GET" ? undefined : ((await request.json()) as Record<string, unknown>)
        calls.push({ method: request.method, path: new URL(request.url).pathname, body })
        if (request.method === "POST" && !new URL(request.url).pathname.endsWith("/cancel") && unknown) {
          unknown = false
          return Response.json({ message: "unknown" }, { status: 503 })
        }
        if (new URL(request.url).pathname.endsWith("/cancel")) stopped = true
        return Response.json({
          control: {
            controlID: "control-one",
            scope: { sessionID: "session-one", directory: "/project" },
            origin: "http://127.0.0.1:3000",
            profile: "managed-loopback-interaction-v1",
            postPaths: ["/submit"],
            state: stopped ? "stopped" : "active",
            expiresAt: Date.now() + 60_000,
            revision: stopped ? 2 : 1,
          },
          availability: stopped ? "stopped" : "available",
          nativeVerification: "verified",
          stopConfirmed: stopped,
        })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  wiring.sdk = { client, directory: "/project", scope: "fixture" }
  const used = vi.fn()
  render(() => <DialogBrowserControl sessionID="session-one" onUse={used} />)
  expect(calls).toHaveLength(0)
  fireEvent.input(screen.getByLabelText(dict["browser.control.paths"]), { target: { value: "/submit" } })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
  await screen.findByRole("alert")
  expect(calls).toHaveLength(1)
  cleanup()
  render(() => <DialogBrowserControl sessionID="session-one" onUse={used} />)
  expect(calls).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: dict["browser.control.retry"] }))
  await screen.findByText(dict["browser.control.active"])
  expect(calls[0]?.body).toEqual(calls[1]?.body)
  expect(calls[0]?.body?.postPaths).toEqual(["/submit"])
  expect(calls[0]?.body?.scriptGrants).toBeUndefined()
  expect(used).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["browser.control.refresh"] }))
  await waitFor(() => expect(calls.filter((call) => call.method === "GET")).toHaveLength(1))
  fireEvent.click(screen.getByRole("button", { name: dict["browser.control.stop"] }))
  await screen.findByText(dict["browser.control.stopped"])
  expect(calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(1)
  expect(screen.getByRole("button", { name: dict["browser.control.use"] }).hasAttribute("disabled")).toBe(true)
})

async function serveBrowser() {
  vi.stubGlobal("crypto", webcrypto)
  const calls: Record<string, unknown>[] = []
  const state = { unknown: false, mismatched: false, gates: [] as Promise<void>[], completed: 0 }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "http://localhost:3000")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-deepagent-code-directory")
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    const bytes: Uint8Array[] = []
    for await (const chunk of request) bytes.push(new Uint8Array(chunk))
    const body = JSON.parse(Buffer.concat(bytes).toString()) as Record<string, unknown>
    calls.push(body)
    await state.gates[calls.length - 1]
    state.completed++
    response.writeHead(state.unknown ? 503 : 200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(state.unknown ? { message: "unknown" } : {
      control: { controlID: "script-control", scope: { sessionID: "script-session", directory: "/project" },
        origin: "http://127.0.0.1:3000", profile: "managed-loopback-interaction-v1", postPaths: [],
        scriptGrants: state.mismatched ? [{ scriptHash: "a".repeat(64), argsHash: "b".repeat(64), readOnly: true }] : body.scriptGrants,
        state: "active", expiresAt: Date.now() + 60_000, revision: 1 },
      availability: "available", nativeVerification: "verified", stopConfirmed: false,
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Private browser listener missing")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  wiring.sdk = { client, directory: "/project", scope: "script-fixture" }
  return { state, calls, async close() {
    cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  } }
}

it("actual HTTP approval hashes exact 8192-byte source/JSON and only explicit script-use adds their original bytes", async () => {
  const peer = await serveBrowser()
  const source = `/*${"x".repeat(8185)}中*/`
  const argsJSON = `"${"x".repeat(8190)}"`
  const used = vi.fn()
  try {
    peer.state.unknown = true
    render(() => <DialogBrowserControl sessionID="script-session" onUse={used} />)
    fireEvent.input(screen.getByLabelText(dict["browser.control.scriptSource"]), { target: { value: source } })
    fireEvent.input(screen.getByLabelText(dict["browser.control.scriptArgs"]), { target: { value: argsJSON } })
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    await screen.findByRole("alert")
    expect(peer.calls).toHaveLength(1)
    expect(new TextEncoder().encode(source)).toHaveLength(8192)
    expect(peer.calls[0].scriptGrants).toEqual([{
      scriptHash: createHash("sha256").update(source).digest("hex"),
      argsHash: createHash("sha256").update(argsJSON).digest("hex"), readOnly: true,
    }])
    expect(peer.calls[0]).not.toHaveProperty("source")
    expect(peer.calls[0]).not.toHaveProperty("argsJSON")
    cleanup()
    peer.state.unknown = false
    render(() => <DialogBrowserControl sessionID="script-session" onUse={used} />)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.retry"] }))
    await screen.findByText(dict["browser.control.scriptReady"])
    expect(peer.calls[1]).toEqual(peer.calls[0])
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.use"] }))
    expect(used).toHaveBeenLastCalledWith("script-control")
    used.mockClear()
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.scriptUse"] }))
    expect(used).toHaveBeenCalledWith("script-control", {
      source, argsJSON, scriptHash: createHash("sha256").update(source).digest("hex"),
      argsHash: createHash("sha256").update(argsJSON).digest("hex"),
    })
  } finally { await peer.close() }
})

it.each([
  { source: "中".repeat(2731), argsJSON: "null" },
  { source: "document.title", argsJSON: `"${"中".repeat(2731)}"` },
  { source: "document.title", argsJSON: "{" },
  { source: "\ud800", argsJSON: "null" },
  { source: "document.title", argsJSON: '"\ud800"' },
])("invalid UTF-16/JSON or oversized UTF-8 input performs zero control requests (case %#)", async (input) => {
  const peer = await serveBrowser()
  try {
    render(() => <DialogBrowserControl sessionID="script-session" onUse={() => {}} />)
    fireEvent.input(screen.getByLabelText(dict["browser.control.scriptSource"]), { target: { value: input.source } })
    fireEvent.input(screen.getByLabelText(dict["browser.control.scriptArgs"]), { target: { value: input.argsJSON } })
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    expect((await screen.findByRole("alert")).textContent).toContain(dict["browser.control.scriptInvalid"])
    expect(peer.calls).toHaveLength(0)
  } finally { await peer.close() }
})

it("another returned hash pair cannot enable the explicit validation-code draft action", async () => {
  const peer = await serveBrowser()
  try {
    peer.state.mismatched = true
    render(() => <DialogBrowserControl sessionID="script-session" onUse={() => {}} />)
    fireEvent.input(screen.getByLabelText(dict["browser.control.scriptSource"]), { target: { value: "document.title" } })
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    await screen.findByText(dict["browser.control.active"])
    expect(screen.getByRole("button", { name: dict["browser.control.scriptUse"] }).hasAttribute("disabled")).toBe(true)
  } finally { await peer.close() }
})

it("an old actual HTTP completion cannot clear the new cached-owner busy operation", async () => {
  const peer = await serveBrowser()
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  try {
    peer.state.gates = [first.promise, second.promise]
    const old = render(() => <DialogBrowserControl sessionID="script-session" onUse={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    await waitFor(() => expect(peer.calls).toHaveLength(1))
    // Keep the old owner alive: disposed alone cannot fence its cached-store completion.
    old.container.hidden = true
    const next = render(() => <DialogBrowserControl sessionID="script-session" onUse={() => {}} />)
    const current = within(next.container)
    fireEvent.click(current.getByRole("button", { name: dict["browser.control.retry"] }))
    await waitFor(() => expect(peer.calls).toHaveLength(2))
    first.resolve()
    await waitFor(() => expect(peer.state.completed).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(current.getByRole("button", { name: dict["browser.control.retry"] }).hasAttribute("disabled")).toBe(true)
    expect(current.queryByText(dict["browser.control.active"])).toBeNull()
    expect(peer.calls[1]).toEqual(peer.calls[0])
    second.resolve()
    await current.findByText(dict["browser.control.active"])
  } finally { first.resolve(); second.resolve(); await peer.close() }
})
