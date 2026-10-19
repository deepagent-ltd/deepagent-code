import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { SessionComposerRegion } from "@/pages/session/composer/session-composer-region"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({
  sync: (): unknown => undefined,
  sdk: (): unknown => undefined,
  server: (): unknown => undefined,
}))
vi.mock("@solidjs/router", () => ({ useNavigate: () => () => {} }))
vi.mock("@/context/sync", () => ({ useSync: () => runtime.sync() }))
vi.mock("@/context/sdk", () => ({ useSDK: () => runtime.sdk() }))
vi.mock("@/context/server", () => ({ useServer: () => runtime.server() }))
vi.mock("@/context/layout", () => ({
  useLayout: () => ({ view: () => ({ todoCollapsed: { get: () => false, set: () => {} } }) }),
}))
vi.mock("@/context/prompt", () => ({ usePrompt: () => ({ ready: () => true, current: () => [] }) }))
vi.mock("@/pages/session/session-layout", () => ({
  useSessionKey: () => ({ sessionKey: () => "current-recovery-gate", params: { id: "current", dir: "own" } }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }),
}))
vi.mock("@deepagent-code/ui/motion-spring", () => ({ useSpring: () => () => 0 }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: () => {}, close: () => {} }) }))
vi.mock("@/components/deepagent/goal-status-bar", () => ({ GoalStatusBar: () => null }))
vi.mock("@/components/deepagent/goal-start-button", () => ({ GoalStartButton: () => null }))
// The actual Composer and both actual recovery docks own this test. The input leaf only
// exposes the disabled prop without providers, prompt admission, PTYs or model requests.
vi.mock("@/components/prompt-input", () => ({
  PromptInput: (props: { disabled?: boolean }) => <textarea aria-label="Composer input" disabled={props.disabled} />,
}))
vi.mock("@/recovery/session-lifecycle", () => ({ useSessionLifecycle: () => undefined }))

afterEach(cleanup)

it("keeps historical unknown diagnostics without locking an authoritative idle composer or clearing a live recovery gate", async () => {
  const http = { reads: 0, writes: 0, checks: 0, releaseLegacy: false, legacyWaiters: [] as Array<() => void> }
  const descriptor = {
    schemaVersion: "recovery-descriptor.v1",
    requestHash: "owned-stopped-request",
    provenance: { origin: "recorded", sourceRefs: ["owned-stopped-attempt"] },
    baseline: { verified: false },
    terminalBridge: { bridgeId: "none", bridgeType: "none" },
    casTokens: { expectedState: "indeterminate_after_crash", expectedVersion: 1, ownerToken: "owned-test-owner" },
    descriptorKind: "coordination_required",
    coordination: { reason: "network_unknown", requiredActor: "admin" },
  }
  const originalDescriptor = JSON.stringify(descriptor)
  const listener = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method !== "GET" && !request.url?.includes("recovery/command")) http.writes++
    http.reads++
    const reply = (value: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify(value))
    }
    if (request.url?.includes("recovery/command")) {
      http.checks++
      return reply({ command_id: "owned-user-check", descriptor })
    }
    if (request.url?.includes("provider-resolution")) {
      if (http.releaseLegacy) return reply([])
      http.legacyWaiters.push(() => reply([]))
      return
    }
    reply({ descriptors: [descriptor], count: 1 })
  })
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Missing owned recovery listener")
  const url = `http://127.0.0.1:${address.port}`
  const [state, setState] = createStore({
    status: "partial" as "loading" | "partial" | "complete",
    execution: undefined as { type: "idle" | "recovery_required" | "busy"; message?: string } | undefined,
  })
  runtime.sdk = () => ({ client: createDeepAgentCodeClient({ baseUrl: url, fetch: window.fetch.bind(window) }) })
  runtime.server = () => ({ current: { http: { url } } })
  runtime.sync = () => ({
    get status() {
      return state.status
    },
    data: {
      get session_status() {
        return { current: state.execution }
      },
      session_working: () => state.execution?.type === "busy",
    },
    session: { get: () => ({ id: "current" }), sync: async () => {} },
  })
  try {
    render(() => (
      <SessionComposerRegion
        state={{
          blocked: () => false,
          questionRequest: () => undefined,
          permissionRequest: () => undefined,
          permissionResponding: () => false,
          decide: () => {},
          todos: () => [],
          dock: () => false,
          closing: () => false,
          opening: () => false,
        }}
        ready
        centered={false}
        inputRef={() => {}}
        newSessionWorktree="main"
        onNewSessionWorktreeReset={() => {}}
        onSubmit={() => {}}
        onResponseSubmit={() => {}}
        setPromptDockRef={() => {}}
      />
    ))
    const input = screen.getByRole("textbox", { name: "Composer input" }) as HTMLTextAreaElement
    await waitFor(() => expect(screen.getByText(dict["recovery.unknown.title"])).toBeDefined())
    expect(input.disabled).toBe(true)
    setState("status", "complete")
    expect(input.disabled).toBe(true) // The unrelated generic callback cannot clear legacy loading.
    http.releaseLegacy = true
    http.legacyWaiters.splice(0).forEach((reply) => reply())
    await waitFor(() => expect(input.disabled).toBe(false))
    expect(screen.getByText(dict["recovery.unknown.title"])).toBeDefined()
    fireEvent.click(screen.getByText(dict["recovery.check"]))
    await waitFor(() => expect(screen.getByText(dict["recovery.coordination.title"])).toBeDefined())
    expect(input.disabled).toBe(false)
    setState("execution", { type: "recovery_required", message: "Unresolved current authority" })
    expect(input.disabled).toBe(true)
    expect(screen.getByText(dict["composer.recovery.hint"])).toBeDefined()
    setState("execution", undefined)
    setState("status", "partial")
    expect(input.disabled).toBe(true) // Missing map entry during failed/incomplete bootstrap is not idle.
    setState("status", "loading")
    expect(input.disabled).toBe(true)
    setState("status", "complete")
    setState("execution", { type: "busy" })
    expect(input.disabled).toBe(true)
    setState("execution", { type: "idle" })
    expect(input.disabled).toBe(false)
    expect(screen.getByText(dict["recovery.coordination.title"])).toBeDefined()
    expect(JSON.stringify(descriptor)).toBe(originalDescriptor)
    expect(http.checks).toBe(1)
    expect(http.writes).toBe(0)
  } finally {
    cleanup()
    http.legacyWaiters.splice(0).forEach((reply) => reply())
    listener.closeAllConnections()
    await new Promise<void>((resolve) => listener.close(() => resolve()))
  }
})
