import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { SidePanelProfile } from "@/pages/session/side-panel-profile"

const wiring = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createDeepAgentCodeClient> | undefined }))
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => ({
    get client() {
      return wiring.client!
    },
  }),
}))
vi.mock("@/context/file", () => ({ useFile: () => ({ load: async () => {} }) }))
afterEach(cleanup)

it("displays a known immediate profiler failure from the original run list without polling or hiding it behind the launch hint", async () => {
  const peer = { started: false, launches: 0, results: 0, requests: [] as string[] }
  const failed = { runId: "original-profiler-failure", status: "error", error: "PROFILER_BINARY_UNAVAILABLE" }
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    peer.requests.push(request.url ?? "")
    response.setHeader("Content-Type", "application/json")
    if (request.url === "/profile/run") {
      peer.started = true
      peer.launches++
      response.end(JSON.stringify(failed))
      return
    }
    if (request.url === "/profile/runs") {
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
