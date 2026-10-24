import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createServer, type ServerResponse } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DebugProvider, useDebug } from "@/context/debug"
import { SDKProvider } from "@/context/sdk"
import { SidePanelDebug } from "@/pages/session/side-panel-debug"

const wiring = vi.hoisted(() => ({
  client: undefined as ReturnType<typeof createDeepAgentCodeClient> | undefined,
  global: undefined as ReturnType<typeof createDeepAgentCodeClient> | undefined,
}))
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => ({
    get client() {
      return wiring.global ?? wiring.client!
    },
    createDirSdkContext: (directory: string) => ({ directory, client: wiring.client! }),
  }),
}))
vi.mock("@/context/server", () => ({ useServer: () => ({}) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: () => "Close" }) }))
afterEach(() => {
  cleanup()
  wiring.global = undefined
})

it("aborts its own generated SDK event request when the debug provider is disposed", async () => {
  const abort = new AbortController()
  const peer = { connected: false, closed: false, stream: undefined as ServerResponse | undefined }
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (new URL(request.url!, "http://localhost").pathname === "/debug/events") {
      peer.connected = true
      peer.stream = response
      response.once("close", () => {
        peer.closed = true
      })
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.flushHeaders()
      return
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"sessions":[]}')
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Debug cleanup peer did not bind")
  wiring.client = createDeepAgentCodeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    signal: abort.signal,
    throwOnError: true,
  })
  try {
    render(() => (
      <SDKProvider directory="/tmp/debug-contract">
        <DebugProvider>
          <div />
        </DebugProvider>
      </SDKProvider>
    ))
    await waitFor(() => expect(peer.connected).toBe(true))
    cleanup()
    await waitFor(() => expect(peer.closed).toBe(true))
  } finally {
    cleanup()
    abort.abort()
    peer.stream?.end()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

// This is an HTTP/DAP-state contract peer, not a debugger or a debuggee.
it("routes the actual debug panel controls through generated SDK HTTP and consumes incremental stopped events", async () => {
  const abort = new AbortController()
  const peer = {
    sessions: [] as Array<{
      id: string
      adapterId: string
      status: string
      breakpoints: []
      createdAt: number
      updatedAt: number
    }>,
    calls: [] as Array<{ path: string; body: Record<string, unknown>; directory: string | null }>,
    stream: undefined as ServerResponse | undefined,
    closed: false,
    starts: 0,
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const url = new URL(request.url!, "http://localhost")
    if (url.pathname === "/debug/events") {
      peer.stream = response
      response.once("close", () => {
        peer.closed = true
      })
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.flushHeaders()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {}
    peer.calls.push({ path: url.pathname, body, directory: url.searchParams.get("directory") })
    response.setHeader("Content-Type", "application/json")
    if (url.pathname === "/debug/start") {
      peer.starts++
      if (peer.starts === 1) {
        response.end(
          JSON.stringify({
            error: "adapter_unavailable",
            message: "Install the project debug adapter before retrying.",
          }),
        )
        return
      }
      peer.sessions = [
        {
          id: "debug-contract-session",
          adapterId: "debugpy",
          status: "running",
          breakpoints: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ]
      response.end(JSON.stringify({ sessionId: peer.sessions[0].id, state: peer.sessions[0] }))
      return
    }
    if (url.pathname === "/debug/sessions") {
      response.end(JSON.stringify({ sessions: peer.sessions }))
      return
    }
    if (url.pathname === "/debug/stack") {
      response.end(
        JSON.stringify({
          frames: [{ id: 7, name: "fixture_frame", source: { path: "/tmp/debug-contract/main.py" }, line: 3 }],
        }),
      )
      return
    }
    if (url.pathname === "/debug/scopes") {
      response.end(JSON.stringify({ scopes: [{ name: "Locals", variablesReference: 11, expensive: false }] }))
      return
    }
    if (url.pathname === "/debug/variables") {
      response.end(JSON.stringify({ variables: [{ name: "answer", value: "42", variablesReference: 0 }] }))
      return
    }
    if (url.pathname === "/debug/evaluate") {
      response.end(JSON.stringify({ result: "42" }))
      return
    }
    if (url.pathname === "/debug/terminate") peer.sessions = []
    response.end(JSON.stringify({ sessionId: "debug-contract-session", state: peer.sessions[0] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Debug contract peer did not bind")
  wiring.client = createDeepAgentCodeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory: "/tmp/debug-contract",
    signal: abort.signal,
    throwOnError: true,
  })
  const close = vi.fn()
  const navigate = vi.fn()
  try {
    render(() => (
      <SDKProvider directory="/tmp/debug-contract">
        <DebugProvider>
          <SidePanelDebug onClose={close} onNavigate={navigate} />
        </DebugProvider>
      </SDKProvider>
    ))
    await waitFor(() => expect(peer.stream).toBeDefined())
    const program = screen.getByPlaceholderText("src/main.py")
    const start = screen.getByRole("button", { name: "启动调试会话" })
    expect(start).toHaveProperty("disabled", true)
    fireEvent.input(program, { target: { value: "main.py" } })
    fireEvent.click(start)
    await screen.findByText("Install the project debug adapter before retrying.")
    expect(start).toHaveProperty("disabled", false)
    fireEvent.click(start)
    await screen.findByText("运行中")
    expect(screen.getByRole("button", { name: "继续" })).toHaveProperty("disabled", true)
    peer.sessions[0].status = "stopped"
    peer.stream!.write(
      `data: ${JSON.stringify({ type: "debug.stopped", data: { sessionId: "debug-contract-session", reason: "breakpoint", threadId: 1 } })}\n\n`,
    )
    await screen.findByText("已暂停")
    await screen.findByText("fixture_frame")
    await screen.findByText("answer")
    fireEvent.click(screen.getByText("fixture_frame"))
    expect(navigate).toHaveBeenCalledWith("/tmp/debug-contract/main.py", 2)
    fireEvent.input(screen.getByRole("textbox", { name: "监视表达式" }), { target: { value: "answer" } })
    fireEvent.click(screen.getByRole("button", { name: "求值" }))
    await waitFor(() =>
      expect(peer.calls.find((call) => call.path === "/debug/evaluate")?.body).toEqual({
        sessionId: "debug-contract-session",
        expression: "answer",
        frameId: 7,
      }),
    )
    for (const name of ["单步跳过", "单步进入", "单步退出", "继续"])
      fireEvent.click(screen.getByRole("button", { name }))
    await waitFor(() =>
      expect(peer.calls.filter((call) => call.path === "/debug/step").map((call) => call.body.kind)).toEqual([
        "next",
        "stepIn",
        "stepOut",
      ]),
    )
    await waitFor(() =>
      expect(peer.calls.find((call) => call.path === "/debug/continue")?.body).toEqual({
        sessionId: "debug-contract-session",
      }),
    )
    expect(
      peer.calls
        .filter((call) => call.path === "/debug/start")
        .every((call) => call.body.adapter === "debugpy" && call.body.program === "main.py"),
    ).toBe(true)
    expect(
      peer.calls
        .filter((call) => ["/debug/stack", "/debug/scopes", "/debug/variables"].includes(call.path))
        .every((call) => call.directory === "/tmp/debug-contract"),
    ).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "终止调试" }))
    await screen.findByRole("button", { name: "启动调试会话" })
    expect(peer.calls.filter((call) => call.path === "/debug/terminate")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(close).toHaveBeenCalledOnce()
    cleanup()
    await waitFor(() => expect(peer.closed).toBe(true))
  } finally {
    cleanup()
    abort.abort()
    peer.stream?.end()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

it("keeps idle relative breakpoints and all debug requests in the project SDK scope without a prompt Session", async () => {
  const directory = "/tmp/debug-project-without-session"
  const peer = {
    calls: [] as Array<{ path: string; body: Record<string, unknown>; directory: string | null }>,
    stream: undefined as ServerResponse | undefined,
    sessions: [] as Array<{
      id: string
      adapterId: string
      status: string
      breakpoints: []
      createdAt: number
      updatedAt: number
    }>,
    closed: false,
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const url = new URL(request.url!, "http://localhost")
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {}
    const directoryHeader = request.headers["x-deepagent-code-directory"]
    peer.calls.push({
      path: url.pathname,
      body,
      directory:
        url.searchParams.get("directory") ??
        (typeof directoryHeader === "string" ? decodeURIComponent(directoryHeader) : null),
    })
    if (url.pathname === "/debug/events") {
      peer.stream = response
      response.once("close", () => {
        peer.closed = true
      })
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.flushHeaders()
      return
    }
    response.setHeader("Content-Type", "application/json")
    if (url.pathname === "/debug/start") {
      peer.sessions = [
        {
          id: "debug-project-session",
          adapterId: "lldb",
          status: "running",
          breakpoints: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ]
    }
    if (url.pathname === "/debug/terminate") peer.sessions = []
    response.end(
      JSON.stringify(
        url.pathname === "/debug/sessions"
          ? { sessions: peer.sessions }
          : { sessionId: "debug-project-session", state: peer.sessions[0] },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Project debug peer did not bind")
  wiring.global = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  wiring.client = createDeepAgentCodeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory,
    throwOnError: true,
  })
  const EditorBreakpoint = () => {
    const debug = useDebug()
    return (
      <>
        <button type="button" onClick={() => void debug.toggleBreakpoint("main.c", 11)}>
          Set main.c line12
        </button>
        <output>{debug.breakpointsFor("main.c").has(11) ? "Breakpoint set" : "No breakpoint"}</output>
      </>
    )
  }
  try {
    render(() => (
      <SDKProvider directory={directory}>
        <DebugProvider>
          <EditorBreakpoint />
          <SidePanelDebug onClose={() => {}} />
        </DebugProvider>
      </SDKProvider>
    ))
    await waitFor(() => expect(peer.stream).toBeDefined())
    fireEvent.click(screen.getByRole("button", { name: "Set main.c line12" }))
    await screen.findByText("Breakpoint set")
    expect(peer.calls.filter((call) => call.path === "/debug/breakpoints")).toEqual([])
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "lldb" } })
    fireEvent.input(screen.getByPlaceholderText("src/main.py"), {
      target: { value: "/tmp/debug-project-without-session/debug-program" },
    })
    fireEvent.click(screen.getByRole("button", { name: "启动调试会话" }))
    await waitFor(() => expect(peer.calls.filter((call) => call.path === "/debug/breakpoints")).toHaveLength(1))
    expect(peer.calls.find((call) => call.path === "/debug/breakpoints")).toEqual({
      path: "/debug/breakpoints",
      directory,
      body: { sessionId: "debug-project-session", file: "main.c", breakpoints: [{ line: 12 }] },
    })
    await screen.findByText("运行中")
    fireEvent.click(screen.getByRole("button", { name: "终止调试" }))
    await screen.findByRole("button", { name: "启动调试会话" })
    expect(peer.calls.map((call) => call.path)).toEqual(
      expect.arrayContaining([
        "/debug/events",
        "/debug/sessions",
        "/debug/start",
        "/debug/breakpoints",
        "/debug/terminate",
      ]),
    )
    expect(peer.calls.every((call) => call.directory === directory)).toBe(true)
    expect(peer.calls.every((call) => call.path.startsWith("/debug/"))).toBe(true)
    cleanup()
    await waitFor(() => expect(peer.closed).toBe(true))
  } finally {
    cleanup()
    peer.stream?.end()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
