import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { ErrorBoundary } from "solid-js"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { SidePanelContext } from "@/pages/session/side-panel-context"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createDeepAgentCodeClient> | undefined }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get client() {
      return wiring.client!
    },
  }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

it("keeps an actual HTTP diagnostic failure inside the panel and retries the original Session without destroying its parent", async () => {
  const peer = { fail: true, requests: [] as string[] }
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    peer.requests.push(request.url ?? "")
    response.writeHead(peer.fail ? 500 : 200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify(
        peer.fail
          ? { name: "UnknownError", data: { message: "Original diagnostic failed" } }
          : {
              sessionId: "original-session",
              selections: [],
              attempts: [],
              metrics: { selections: 0, tokens: 0, graphs: [], alerts: [] },
            },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The original HTTP peer was not bound")
  wiring.client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  const history = createMemoryHistory()
  history.set({ value: "/original-session" })
  try {
    render(() => (
      <MemoryRouter history={history}>
        <Route
          path="/:id"
          component={() => (
            <ErrorBoundary fallback={<p>global-failure</p>}>
              <p>original-conversation</p>
              <SidePanelContext onClose={() => {}} />
            </ErrorBoundary>
          )}
        />
      </MemoryRouter>
    ))
    await waitFor(() => expect(screen.getByText(dict["session.context.loadFailed"])).toBeTruthy())
    expect(screen.queryByText("global-failure")).toBeNull()
    expect(screen.getByText("original-conversation")).toBeTruthy()
    peer.fail = false
    fireEvent.click(screen.getByRole("button", { name: dict["common.retry"] }))
    await waitFor(() => expect(screen.getByText(dict["session.context.noSelection"])).toBeTruthy())
    expect(screen.queryByText(dict["session.context.loadFailed"])).toBeNull()
    expect(screen.queryByText("global-failure")).toBeNull()
    expect(peer.requests).toEqual(["/session/original-session/context", "/session/original-session/context"])
  } finally {
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
