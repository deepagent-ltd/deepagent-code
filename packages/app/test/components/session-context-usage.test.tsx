import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import type { SessionContextUsageSchema } from "@deepagent-code/core/session/context-usage.schema"
import { SessionContextUsage } from "@/components/session-context-usage"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({
  sync: (): unknown => ({}),
  local: (): unknown => ({}),
  prompt: (): unknown => ({}),
  scope: (): string => "server",
  sessionID: (): string | undefined => "session",
  read: vi.fn(),
  show: vi.fn(),
  toolChanged: undefined as (() => void) | undefined,
}))
vi.mock("@/context/sync", () => ({ useSync: () => runtime.sync() }))
vi.mock("@/context/local", () => ({ useLocal: () => runtime.local() }))
vi.mock("@/context/prompt", () => ({ usePrompt: () => runtime.prompt() }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get scope() {
      return runtime.scope()
    },
    directory: "/owned",
    client: { session: { contextUsage: runtime.read } },
    event: {
      on: (_type: string, callback: () => void) => {
        runtime.toolChanged = callback
        return () => {
          runtime.toolChanged = undefined
        }
      },
    },
  }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({ intl: () => "en-US", t: (key: keyof typeof dict) => dict[key] ?? key }),
}))
vi.mock("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: {
      get id() {
        return runtime.sessionID()
      },
    },
  }),
}))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: runtime.show }) }))
vi.mock("@/components/session-context-dialog", () => ({
  SessionContextUsageDialog: () => <div>Existing context dialog</div>,
}))

const values = { nonCachedInput: 20_000, cacheRead: 100_000, cacheWrite: 5_000, output: 30_000, reasoning: 10_000 }
const summary = (extra: Partial<SessionContextUsageSchema.Summary> = {}): SessionContextUsageSchema.Summary => ({
  sessionID: "session",
  observedAt: 1,
  revision: "source-fingerprint",
  estimate: {
    status: "complete",
    inputTokens: 241_000,
    contextLimit: 475_000,
    inputLimit: 450_000,
    physicalInputBudget: 420_000,
    reservedOutput: 30_000,
    modelID: "model",
    providerID: "provider",
    draftRevision: "draft",
    missing: [],
  },
  activity: {
    id: "activity",
    state: "active",
    current: true,
    calls: 3,
    reportedCalls: 2,
    unknownCalls: 1,
    reasoningReported: true,
    cacheReadReported: true,
    cacheWriteReported: true,
    tokens: values,
  },
  totals: { ...values, nonCachedInput: 9_000_000 },
  totalsReasoningReported: true,
  totalsCacheReadReported: true,
  totalsCacheWriteReported: true,
  totalCalls: 5,
  unknownCalls: 1,
  coverage: "partial",
  ...extra,
})
beforeEach(() => {
  vi.clearAllMocks()
  runtime.read.mockImplementation((query) =>
    Promise.resolve({
      data: { ...summary(), estimate: { ...summary().estimate, draftRevision: query.draftRevision } },
    }),
  )
})
afterEach(cleanup)

function mount(initial: { sessionID?: string; scope?: string } = {}) {
  const [state, setState] = createStore({
    id: initial.sessionID ?? "session",
    scope: initial.scope ?? "server",
    draft: "draft text",
    limit: 475_000,
    config: {},
    updated: 1,
    status: "idle",
  })
  runtime.sessionID = () => state.id || undefined
  runtime.scope = () => state.scope
  runtime.local = () => ({
    model: {
      current: () => ({ provider: { id: "provider" }, id: "model", limit: { context: state.limit } }),
      variant: { current: () => "default" },
    },
    agent: { current: () => ({ name: "auto" }) },
  })
  runtime.prompt = () => ({ current: () => [{ type: "text", content: state.draft }], context: { items: () => [] } })
  runtime.sync = () => ({
    session: { get: () => ({ time: { updated: state.updated }, permission: [] }) },
    data: {
      config: state.config,
      mcp: {},
      get session_status() {
        return { session: { type: state.status } }
      },
      message: { session: [] },
    },
  })
  const mounted = render(() => (
    <>
      <SessionContextUsage />
      <button>Other control</button>
    </>
  ))
  return { ...mounted, setState }
}
const trigger = () => screen.getByRole<HTMLButtonElement>("button", { name: dict["context.usage.view"] })
const card = async () => {
  fireEvent.click(trigger())
  return screen.findByRole("dialog")
}

it("uses next-input coverage and context capacity, with durable activity and Session totals kept separate", async () => {
  mount()
  await waitFor(() => expect(screen.getByRole("img").getAttribute("aria-label")).toContain("51%"))
  const content = await card()
  expect(content.textContent).toContain("≈241K")
  expect(content.textContent).toContain("475K")
  expect(content.textContent).toContain("3 model calls")
  expect(content.textContent).toContain(dict["context.preview.reportedPartial"])
  const activity = within(content).getByRole("button", { name: /This activity/ })
  const session = within(content).getByRole("button", { name: /Session total/ })
  expect(activity.getAttribute("aria-expanded")).toBe("false")
  fireEvent.click(activity)
  expect(activity.getAttribute("aria-expanded")).toBe("true")
  expect(content.textContent).toContain("≈40K")
  fireEvent.click(session)
  expect(activity.getAttribute("aria-expanded")).toBe("false")
  expect(session.getAttribute("aria-expanded")).toBe("true")
  expect(content.textContent).toContain("≈9,000K")
})

it("preserves missing coverage and unknown capacity instead of showing a normal zero-percent ring", async () => {
  runtime.read.mockImplementation((query) =>
    Promise.resolve({
      data: {
        ...summary(),
        estimate: {
          ...summary().estimate,
          status: "partial",
          contextLimit: null,
          draftRevision: query.draftRevision,
          missing: ["attachments"],
        },
      },
    }),
  )
  mount()
  await waitFor(() => expect(runtime.read).toHaveBeenCalled())
  const content = await card()
  await waitFor(() => expect(content.textContent).toContain(dict["context.preview.incomplete"]))
  expect(document.querySelector('[data-slot="context-usage-unknown"]')).toBeTruthy()
  expect(content.textContent).not.toContain("0%")
  fireEvent.click(within(content).getByRole("button", { name: dict["context.preview.explanation"] }))
  expect(content.textContent).toContain(dict["context.preview.missing.attachments"])
})

it("invalidates the same model ID for limits, config and registered tools without an idle poll", async () => {
  const fixture = mount()
  await waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(1))
  fixture.setState("limit", 600_000)
  await waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(2))
  fixture.setState("config", { model: "changed" })
  await waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(3))
  runtime.toolChanged?.()
  await waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(4))
  await card()
  expect(runtime.read).toHaveBeenCalledTimes(4)
})

it("aborts old draft reads and ignores their late results", async () => {
  let complete: ((value: unknown) => void) | undefined
  runtime.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const fixture = mount()
  await waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(1))
  const signal = runtime.read.mock.calls[0][1].signal as AbortSignal
  fixture.setState("draft", "a new draft")
  await waitFor(() => expect(signal.aborted).toBe(true))
  await waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByRole("img").getAttribute("aria-label")).toContain("51%"))
  complete?.({ data: { ...summary(), estimate: { ...summary().estimate, inputTokens: 470_000 } } })
  await Promise.resolve()
  expect(screen.getByRole("img").getAttribute("aria-label")).toContain("51%")
})

it("clears previous scope totals and does not let a refresh failure look fresh", async () => {
  const fixture = mount()
  await waitFor(() => expect(screen.getByRole("img").getAttribute("aria-label")).toContain("51%"))
  const content = await card()
  runtime.read.mockRejectedValueOnce(new Error("offline"))
  fireEvent.click(within(content).getByRole("button", { name: dict["context.preview.refresh"] }))
  await waitFor(() => expect(content.textContent).toContain(dict["context.preview.readFailed"]))
  expect(document.querySelector('[data-slot="context-usage-unknown"]')).toBeTruthy()
  runtime.read.mockImplementation(() => new Promise(() => {}))
  fixture.setState("scope", "another-server")
  expect(content.textContent).not.toContain("9,145K")
  expect(content.textContent).toContain(dict["context.preview.noActivity"])
})

it("returns focus on Escape, preserves outside focus and retains original detailed usage", async () => {
  mount()
  await waitFor(() => expect(runtime.read).toHaveBeenCalled())
  trigger().focus()
  const content = await card()
  fireEvent.keyDown(content, { key: "Escape" })
  await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"))
  await waitFor(() => expect(document.activeElement).toBe(trigger()))
  await card()
  const other = screen.getByRole<HTMLButtonElement>("button", { name: "Other control" })
  fireEvent.pointerDown(other)
  other.focus()
  await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"))
  expect(document.activeElement).toBe(other)
  const again = await card()
  fireEvent.click(within(again).getByRole("button", { name: dict["context.preview.explanation"] }))
  fireEvent.click(within(again).getByRole("button", { name: dict["context.preview.moreUsage"] }))
  await waitFor(() => expect(runtime.show).toHaveBeenCalledTimes(1))
})

it("does not render or query before a Session exists", async () => {
  mount({ sessionID: "" })
  expect(screen.queryByRole("button", { name: dict["context.usage.view"] })).toBeNull()
  await new Promise((resolve) => setTimeout(resolve, 450))
  expect(runtime.read).not.toHaveBeenCalled()
})

it("shows the three-line tooltip when the real button receives keyboard focus", async () => {
  mount()
  await waitFor(() => expect(screen.getByRole("img").getAttribute("aria-label")).toContain("51%"))
  trigger().focus()
  const tooltip = await screen.findByRole("tooltip")
  expect(tooltip.textContent).toContain(dict["context.preview.title"])
  expect(tooltip.textContent).toContain("51%")
  expect(tooltip.textContent).toContain("≈241K")
})

it("keeps a streaming Session unknown until settlement and distinguishes unreported cache fields", async () => {
  const fixture = mount()
  await waitFor(() => expect(screen.getByRole("img").getAttribute("aria-label")).toContain("51%"))
  fixture.setState("status", "busy")
  const content = await card()
  expect(content.textContent).toContain(dict["context.preview.generating"])
  expect(document.querySelector('[data-slot="context-usage-unknown"]')).toBeTruthy()
  runtime.read.mockImplementation((query) =>
    Promise.resolve({
      data: {
        ...summary(),
        activity: { ...summary().activity!, cacheWriteReported: false },
        estimate: { ...summary().estimate, draftRevision: query.draftRevision },
      },
    }),
  )
  fixture.setState("status", "idle")
  await waitFor(() => expect(screen.getByRole("img").getAttribute("aria-label")).toContain("51%"))
  fireEvent.click(within(content).getByRole("button", { name: /This activity/ }))
  expect(content.textContent).toContain(dict["context.preview.fieldUnknown"])
})
