import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { SidePanelProfile } from "@/pages/session/side-panel-profile"

const wiring = vi.hoisted(() => ({
  client: undefined as ReturnType<typeof createDeepAgentCodeClient> | undefined,
  projectClient: undefined as ReturnType<typeof createDeepAgentCodeClient> | undefined,
  load: vi.fn(async (_path: string) => {}),
}))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get client() {
      return wiring.projectClient!
    },
  }),
}))
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => ({
    get client() {
      return wiring.client!
    },
  }),
}))
vi.mock("@/context/file", () => ({ useFile: () => ({ load: wiring.load }) }))
afterEach(cleanup)

it("displays a known immediate profiler failure from the original run list without polling or hiding it behind the launch hint", async () => {
  const peer = { started: false, launches: 0, results: 0, requests: [] as string[] }
  const failed = { runId: "original-profiler-failure", status: "error", error: "PROFILER_BINARY_UNAVAILABLE" }
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const path = new URL(request.url!, "http://localhost").pathname
    peer.requests.push(path)
    response.setHeader("Content-Type", "application/json")
    if (path === "/profile/run") {
      peer.started = true
      peer.launches++
      response.end(JSON.stringify(failed))
      return
    }
    if (path === "/profile/runs") {
      response.end(JSON.stringify(peer.started ? [failed] : []))
      return
    }
    peer.results++
    response.writeHead(500).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The original HTTP peer was not bound")
  wiring.client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  wiring.projectClient = createDeepAgentCodeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory: "/profile-owned",
    throwOnError: true,
  })
  try {
    render(() => <SidePanelProfile onClose={() => {}} />)
    await waitFor(() => expect(peer.requests).toEqual(["/profile/runs"]))
    fireEvent.input(screen.getByRole("textbox", { name: "剖析命令" }), { target: { value: "/usr/bin/true" } })
    fireEvent.click(screen.getByRole("button", { name: "运行" }))
    await waitFor(() => expect(screen.getByText(failed.error)).toBeTruthy())
    expect(screen.queryByText(/输入命令并点击运行/)).toBeNull()
    expect(screen.getByRole("combobox", { name: "历史运行" })).toHaveProperty("value", failed.runId)
    expect(peer.launches).toBe(1)
    expect(peer.results).toBe(0)
  } finally {
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

// The peer supplies an adapter-result contract; this does not run a profiler.
it("launches through generated SDK HTTP, renders completed hotspots and metrics, selects history and opens its source", async () => {
  const peer = { started: false, done: false, launches: [] as unknown[], requests: [] as string[] }
  const runId = "current-profile-contract"
  const oldId = "previous-profile-contract"
  const oldResult = Promise.withResolvers<void>()
  const oldPending = Promise.withResolvers<void>()
  const artifact = (old: boolean) => ({
    status: "done",
    evidence_kind: "profile",
    generated_at: "2026-10-16T00:00:00Z",
    profile: {
      domain: "cpu_sampling",
      vendor: "generic",
      adapterId: "perf",
      summary: { ipc: { value: old ? 1 : 2, unit: "ratio" } },
    },
    roofline: { bound: "compute_bound", detail: "Controlled profile-result contract" },
    diff: { comparable: true, hotspots: [{ name: "compute_fixture", status: "improved" }] },
  })
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const url = new URL(request.url!, "http://localhost")
    peer.requests.push(url.pathname)
    response.setHeader("Content-Type", "application/json")
    if (url.pathname === "/profile/run") {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      peer.launches.push(JSON.parse(Buffer.concat(chunks).toString()))
      peer.started = true
      response.end(JSON.stringify({ runId, status: "running" }))
      return
    }
    if (url.pathname === "/profile/runs") {
      response.end(
        JSON.stringify(
          peer.started
            ? [
                { runId, status: peer.done ? "done" : "running" },
                { runId: oldId, status: "done" },
              ]
            : [],
        ),
      )
      return
    }
    if (url.pathname === "/profile/result") {
      const old = url.searchParams.get("runId") === oldId
      if (old) {
        oldPending.resolve()
        await oldResult.promise
      }
      peer.done = true
      response.end(JSON.stringify(artifact(old)))
      return
    }
    if (url.pathname === "/profile/hotspots") {
      expect(url.searchParams.get("limit")).toBe("15")
      response.end(
        JSON.stringify([
          { name: "compute_fixture", fileLine: "src/compute.c:7", selfPct: 62.5, cumulPct: 80, calls: 3 },
        ]),
      )
      return
    }
    response.writeHead(404).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Profile contract peer did not bind")
  wiring.client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  wiring.projectClient = createDeepAgentCodeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory: "/profile-owned",
    throwOnError: true,
  })
  wiring.load.mockClear()
  const close = vi.fn()
  try {
    render(() => <SidePanelProfile onClose={close} />)
    await waitFor(() => expect(peer.requests).toEqual(["/profile/runs"]))
    expect(screen.getByRole("button", { name: "运行" })).toHaveProperty("disabled", true)
    fireEvent.input(screen.getByRole("textbox", { name: "剖析命令" }), { target: { value: "./own-benchmark" } })
    fireEvent.input(screen.getByRole("textbox", { name: /Profiler/ }), { target: { value: "perf" } })
    fireEvent.click(screen.getByRole("button", { name: "运行" }))
    await screen.findByText("剖析中…")
    expect(peer.launches).toEqual([{ program: "./own-benchmark", profiler: "perf" }])
    await screen.findByText("compute_fixture", {}, { timeout: 4_000 })
    await screen.findByText("2.00")
    expect(screen.getByText("62.5%")).toBeTruthy()
    expect(screen.getByText("▲ 1 优化")).toBeTruthy()
    expect(screen.getByText("compute_bound")).toBeTruthy()
    expect(screen.queryByText("剖析中…")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "src/compute.c:7" }))
    expect(wiring.load).toHaveBeenCalledWith("src/compute.c")
    fireEvent.change(screen.getByRole("combobox", { name: "历史运行" }), { target: { value: oldId } })
    await oldPending.promise
    fireEvent.change(screen.getByRole("combobox", { name: "历史运行" }), { target: { value: runId } })
    await screen.findByText("2.00")
    oldResult.resolve()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.getByText("2.00")).toBeTruthy()
    expect(screen.queryByText("1.00")).toBeNull()
    fireEvent.change(screen.getByRole("combobox", { name: "历史运行" }), { target: { value: oldId } })
    await screen.findByText("1.00")
    expect(screen.queryByText("2.00")).toBeNull()
    expect(peer.launches).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(close).toHaveBeenCalledOnce()
  } finally {
    oldResult.resolve()
    cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

it("uses the project SDK directory for profile run, list, hotspots and result instead of the global client", async () => {
  const calls: { method: string; path: string; directory: string | null }[] = []
  const runId = "directory-profile-contract"
  const state = { started: false, postDirectoryHeader: "" }
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const url = new URL(request.url!, "http://localhost")
    calls.push({
      method: request.method!,
      path: url.pathname,
      directory:
        url.searchParams.get("directory") ??
        (typeof request.headers["x-deepagent-code-directory"] === "string"
          ? decodeURIComponent(request.headers["x-deepagent-code-directory"])
          : null),
    })
    response.setHeader("Content-Type", "application/json")
    if (url.pathname === "/profile/runs") {
      response.end(JSON.stringify(state.started ? [{ runId, status: "done" }] : []))
      return
    }
    if (url.pathname === "/profile/run") {
      state.postDirectoryHeader = request.headers["x-deepagent-code-directory"]?.toString() ?? ""
      state.started = true
      response.end(JSON.stringify({ runId, status: "done" }))
      return
    }
    if (url.pathname === "/profile/hotspots") {
      response.end("[]")
      return
    }
    if (url.pathname === "/profile/result") {
      response.end(
        JSON.stringify({
          status: "done",
          evidence_kind: "profile",
          generated_at: "2026-10-16T00:00:00Z",
          profile: { domain: "cpu_sampling", vendor: "generic", adapterId: "perf", summary: { ipc: { value: 3 } } },
        }),
      )
      return
    }
    response.writeHead(404).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Profile directory peer did not bind")
  wiring.client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  wiring.projectClient = createDeepAgentCodeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory: "/profile-owned",
    throwOnError: true,
  })
  try {
    await wiring.client.profile.runs()
    expect(calls).toEqual([{ method: "GET", path: "/profile/runs", directory: null }])
    calls.length = 0
    render(() => <SidePanelProfile onClose={() => {}} />)
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ method: "GET", path: "/profile/runs", directory: "/profile-owned" })
    fireEvent.input(screen.getByRole("textbox", { name: "剖析命令" }), { target: { value: "./owned-profile" } })
    fireEvent.click(screen.getByRole("button", { name: "运行" }))
    await screen.findByText("3.00")
    expect(calls.map((call) => call.path)).toEqual([
      "/profile/runs",
      "/profile/run",
      "/profile/runs",
      "/profile/hotspots",
      "/profile/result",
    ])
    expect(calls.every((call) => call.directory === "/profile-owned")).toBe(true)
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
    expect(state.postDirectoryHeader).toBe(encodeURIComponent("/profile-owned"))
  } finally {
    cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
