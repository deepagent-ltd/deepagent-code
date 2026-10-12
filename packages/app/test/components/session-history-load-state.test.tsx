import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createResource, Show } from "solid-js"
import { createServer } from "node:http"
import { SessionHistoryLoadState } from "@/pages/session/history-load-state"
import { dict } from "@/i18n/en"
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)
it("failed original history HTTP remains visible and an explicit retry loads the timeline", async () => {
  const state = { attempts: 0 }
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    state.attempts++; response.writeHead(state.attempts === 1 ? 503 : 200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(state.attempts === 1 ? { code: "unavailable" } : { content: "Original streamed history" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Listener missing")
  const url = `http://127.0.0.1:${address.port}/session/original/messages`
  function Owner() {
    const [history, actions] = createResource(async () => {
      const response = await fetch(url)
      if (!response.ok) throw new Error("Original history unavailable")
      return response.json() as Promise<{ content: string }>
    })
    return <Show when={history.state === "ready"} fallback={<SessionHistoryLoadState error={history.error}
      loading={history.loading} retry={() => void actions.refetch()} />}>
      <div role="log">{history.latest?.content}</div>
    </Show>
  }
  try {
    render(() => <Owner />)
    expect(screen.getByRole("status").textContent).toContain(dict["common.loading"])
    expect(await screen.findByRole("alert")).toBeDefined()
    expect(state.attempts).toBe(1)
    fireEvent.click(screen.getByRole("button", { name: dict["recovery.list.retry"] }))
    await waitFor(() => expect(screen.getByRole("log").textContent).toBe("Original streamed history"))
    expect(state.attempts).toBe(2); expect(screen.queryByRole("alert")).toBeNull()
  } finally { cleanup(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})
