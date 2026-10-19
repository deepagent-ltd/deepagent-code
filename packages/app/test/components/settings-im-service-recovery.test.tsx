import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { createServer, type ServerResponse } from "node:http"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { SettingsIMV2 } from "@/components/settings-v2/im"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({
  client: undefined as ReturnType<typeof createDeepAgentCodeClient> | undefined,
  scope: () => "original",
  local: (): boolean => false,
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@/context/server", () => ({
  useServer: () => ({ scope: () => wiring.scope() }),
  ServerConnection: { local: () => wiring.local() },
}))
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => ({
    scope: "original",
    get client() {
      return wiring.client!
    },
  }),
}))
vi.mock("@/context/server-sync", () => ({
  useServerSync: () => ({
    data: { config: { im: { url: "https://configured.invalid/im", model: "owned/model" } } },
    updateConfig: () => {
      throw new Error("A read-only service observation must not save configuration")
    },
  }),
}))
vi.mock("@/context/models", () => ({
  useModels: () => ({
    list: () => [{ id: "model", name: "Model", provider: { id: "owned", name: "Owned" } }],
    visible: () => true,
  }),
}))
afterEach(cleanup)

it("observes a newly current settings scope, explicitly retries a missing service, and retires late HTTP results", async () => {
  const calls: { method: string; path: string }[] = []
  const held = Promise.withResolvers<ServerResponse>()
  const [state, setState] = createStore({ local: false })
  wiring.local = () => state.local
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const path = new URL(request.url!, "http://localhost").pathname
    calls.push({ method: request.method!, path })
    response.setHeader("Content-Type", "application/json")
    if (request.method !== "GET" || path !== "/api/v1/im/status") {
      response.writeHead(500).end('{"unexpected":true}')
      return
    }
    if (calls.length === 2) {
      held.resolve(response)
      return
    }
    response.end(
      JSON.stringify({
        facade: "active",
        identity: null,
        blocked: null,
        kernel: "connected",
        keyOrigin: "stored",
        ...(calls.length === 1
          ? {}
          : { service: { url: "https://verified.invalid/im", source: "config", reconnectRequired: false } }),
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Settings peer did not bind")
  wiring.client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  const query = new QueryClient()
  try {
    render(() => (
      <QueryClientProvider client={query}>
        <SettingsIMV2 />
      </QueryClientProvider>
    ))
    expect(calls).toEqual([])
    setState("local", true)
    await waitFor(() => expect(calls).toHaveLength(1))
    await screen.findByText(dict["settings.im.service.loadFailed"])
    expect(screen.getByRole("button", { name: "Owned / Model" }).hasAttribute("data-disabled")).toBe(true)
    expect(screen.queryByRole("button", { name: dict["settings.im.service.checkDevice"] })).toBeNull()
    expect(screen.getByLabelText(dict["settings.im.service.address"])).toHaveProperty(
      "value",
      "https://configured.invalid/im",
    )
    const retry = screen.getByRole("button", { name: dict["common.retry"] })
    fireEvent.click(retry)
    const pending = await held.promise
    expect(retry).toHaveProperty("disabled", true)
    fireEvent.click(retry)
    expect(calls).toHaveLength(2)
    setState("local", false)
    await waitFor(() => expect(pending.destroyed).toBe(true))
    pending.end(
      JSON.stringify({ service: { url: "https://retired.invalid/im", source: "config", reconnectRequired: false } }),
    )
    setState("local", true)
    await screen.findByRole("button", { name: dict["settings.im.service.checkDevice"] })
    expect(calls).toEqual(Array.from({ length: 3 }, () => ({ method: "GET", path: "/api/v1/im/status" })))
    expect(screen.queryByText(dict["settings.im.service.loadFailed"])).toBeNull()
    expect(screen.getByRole("button", { name: "Owned / Model" }).hasAttribute("data-disabled")).toBe(false)
    expect(screen.getByText(/https:\/\/verified\.invalid\/im/)).toBeTruthy()
    expect(screen.queryByText(/https:\/\/retired\.invalid\/im/)).toBeNull()
  } finally {
    cleanup()
    query.clear()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
