import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { Message, Part } from "@deepagent-code/sdk/client"
import { SessionContextUsage } from "@/components/session-context-usage"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({
  sync: (): unknown => ({ data: { message: {}, part: {} } }),
  providers: (): Map<string, unknown> => new Map(),
  show: vi.fn(),
}))
vi.mock("@/context/sync", () => ({ useSync: () => runtime.sync() }))
vi.mock("@/hooks/use-providers", () => ({ useProviders: () => ({ all: runtime.providers }) }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({ intl: () => "en-US", t: (key: keyof typeof dict) => dict[key] }),
}))
vi.mock("@/pages/session/session-layout", () => ({ useSessionLayout: () => ({ params: { id: "session" } }) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: runtime.show }) }))
vi.mock("@/components/session-context-dialog", () => ({
  SessionContextUsageDialog: () => <div>Existing context dialog</div>,
}))

beforeEach(() => {
  runtime.show.mockReset()
})
afterEach(cleanup)

const assistant = (extra: Record<string, unknown> = {}) =>
  ({
    id: "assistant",
    role: "assistant",
    sessionID: "session",
    providerID: "provider",
    modelID: "model",
    tokens: { input: 141_000, output: 20_000, reasoning: 10_000, cache: { read: 100_000, write: 0 } },
    cost: 0,
    time: { created: 1 },
    ...extra,
  }) as Message

function mount(input: { limit?: number; messages?: Message[]; parts?: Record<string, Part[]> } = {}) {
  runtime.sync = () => ({
    data: {
      message: { session: input.messages ?? [assistant()] },
      part: input.parts ?? {},
      // Cumulative usage is deliberately much larger than the request window.
      session: [{ id: "session", tokens: { input: 9_000_000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }],
    },
  })
  runtime.providers = () =>
    new Map([["provider", { id: "provider", models: { model: { limit: { context: input.limit ?? 475_000 } } } }]])
  return render(() => <SessionContextUsage />)
}

async function tooltip() {
  const button = screen.getByRole("button", { name: dict["context.usage.view"] })
  const trigger = button.closest('[data-component="tooltip-trigger"]')
  if (!trigger) throw new Error("The actual context tooltip trigger is missing")
  fireEvent.focus(trigger)
  return screen.findByRole("tooltip")
}

it("shows the last request window and capacity without mixing cumulative usage, then keeps the existing dialog action", async () => {
  mount()
  expect(screen.getByRole("img", { name: "Context window: 51%" })).toBeTruthy()
  const content = await tooltip()
  expect(content.textContent).toContain("Context window51%")
  expect(content.textContent).toContain("Used241,000/ Capacity475,000Tokens")
  expect(content.textContent).toContain(dict["context.usage.lastRequest"])
  expect(content.textContent).not.toContain("9,000,001")
  expect(content.textContent).not.toContain(dict["context.usage.totalTokens"])
  fireEvent.click(screen.getByRole("button", { name: dict["context.usage.view"] }))
  await waitFor(() => expect(runtime.show).toHaveBeenCalledTimes(1))
  render(runtime.show.mock.calls[0][0])
  expect(screen.getByText("Existing context dialog")).toBeTruthy()
})

it("keeps unknown model capacity distinct from zero percent", async () => {
  mount({ limit: 0 })
  expect(screen.getByRole("img", { name: "Context window: Unknown" })).toBeTruthy()
  expect(document.querySelector('[data-slot="context-usage-unknown"]')).toBeTruthy()
  expect(document.querySelector('[data-component="progress-circle"]')).toBeNull()
  const content = await tooltip()
  expect(content.textContent).toContain("Used241,000/ CapacityUnknownTokens")
  expect(content.textContent).not.toContain("0%")
})

it("marks committed compaction values as estimates", async () => {
  mount({
    messages: [
      { id: "marker", role: "user", model: { providerID: "provider", modelID: "model" } } as Message,
      assistant({ parentID: "marker", summary: true, finish: "stop" }),
    ],
    parts: { marker: [{ type: "compaction", context_tokens: 95_000 } as Part] },
  })
  expect(screen.getByRole("img", { name: "Context window: ≈ 20%" })).toBeTruthy()
  const content = await tooltip()
  expect(content.textContent).toContain("Used≈ 95,000/ Capacity475,000Tokens")
  expect(content.textContent).toContain(dict["context.usage.compactionEstimate"])
  expect(content.textContent).not.toContain(dict["context.usage.lastRequest"])
})

it("does not turn a new Session without usage into a measured empty window", async () => {
  mount({ messages: [] })
  expect(screen.getByRole("img", { name: "Context window: Not measured yet" })).toBeTruthy()
  const content = await tooltip()
  expect(content.textContent).toContain(dict["context.usage.pending"])
  expect(content.textContent).not.toContain("0%")
  expect(content.textContent).not.toContain("Used")
})
