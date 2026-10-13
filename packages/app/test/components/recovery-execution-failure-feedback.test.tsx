import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { createServer } from "node:http"
import { RecoveryDock } from "@/recovery/RecoveryDock"
import { createRecoveryLifecycle, type LifecycleSnapshot } from "@/recovery/recovery-lifecycle-state"
import { createMaintenanceClient } from "@/maintenance/maintenance-client"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({ snapshot: undefined as (() => LifecycleSnapshot) | undefined }))
vi.mock("@/recovery/session-lifecycle", () => ({ useSessionLifecycle: () => ({ snapshot: runtime.snapshot! }) }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, number | string>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))
afterEach(cleanup)

async function serve() {
  const state = { writes: 0, reads: 0 }
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    if (request.method !== "GET") state.writes++
    state.reads++
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ session_id: "current", descriptors: [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing original maintenance listener")
  return {
    state,
    client: createMaintenanceClient({ baseUrl: `http://127.0.0.1:${address.port}`, fetch: window.fetch.bind(window) }),
    async close() {
      cleanup()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

it("recovery original failed execution without messages shows its safe cause and clears it on a new turn", async () => {
  const api = await serve()
  const lifecycle = createRecoveryLifecycle()
  const [revision, setRevision] = createSignal(0)
  runtime.snapshot = () => { revision(); return lifecycle.snapshot() }
  lifecycle.onEvent({ type: "execution-started", sessionID: "current", timestamp: 1 })
  lifecycle.onEvent({ type: "execution-failed", sessionID: "current", timestamp: 2,
    error: { type: "unknown", message: "Current installed Work source, route or native count authority is unavailable" } })
  try {
    render(() => <RecoveryDock sessionId="current" client={api.client} />)
    expect(screen.getByRole("alert").textContent).toContain(dict["recovery.execution.failureAuthority"])
    expect(screen.getByText(dict["recovery.execution.failureGuidance"])).toBeDefined()
    expect(screen.queryByText(/Check the error above/)).toBeNull()
    await waitFor(() => expect(api.state.reads).toBe(1))
    lifecycle.onEvent({ type: "execution-started", sessionID: "current", timestamp: 3 })
    setRevision((value) => value + 1)
    expect(screen.queryByText(dict["recovery.execution.failureAuthority"])).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(api.state.writes).toBe(0)
  } finally { await api.close() }
})

it("recovery failure fallback never displays arbitrary error payload or another session's authority failure", async () => {
  const api = await serve()
  const lifecycle = createRecoveryLifecycle()
  runtime.snapshot = () => lifecycle.snapshot()
  lifecycle.onEvent({ type: "execution-failed", sessionID: "foreign", timestamp: 1,
    error: { type: "unknown", message: "Current Work placement authority is unavailable" } })
  lifecycle.onEvent({ type: "execution-failed", sessionID: "current", timestamp: 2,
    error: { type: "unknown", message: "private-provider-key-DO-NOT-DISPLAY", stack: "private/path" } })
  try {
    const view = render(() => <RecoveryDock sessionId="current" client={api.client} />)
    expect(screen.getByRole("alert").textContent).toContain(dict["recovery.execution.failureUnknown"])
    expect(view.container.textContent).not.toContain("DO-NOT-DISPLAY")
    expect(view.container.textContent).not.toContain("private/path")
    expect(screen.queryByText(dict["recovery.execution.failurePlacement"])).toBeNull()
    await waitFor(() => expect(api.state.reads).toBe(1))
    expect(api.state.writes).toBe(0)
  } finally { await api.close() }
})
