import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { LocalProvider, useLocal } from "@/context/local"
import { PlatformProvider } from "@/context/platform"
import { Storage } from "happy-dom"

const wiring = vi.hoisted(() => ({
  state: undefined as
    | {
        connected: boolean
        visible: boolean
        catalog: boolean
        directory: string
        ordinaryEligible?: boolean
        defaultAgent: string
        sessionAgent: string
      }
    | undefined,
}))
const provider = () => ({
  id: "deepseek",
  models: {
    ...(wiring.state!.catalog ? { chosen: { id: "chosen" } } : {}),
    fallback: { id: "fallback" },
  },
})
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ directory: "/private/original" }) }))
vi.mock("@/context/server-sdk", () => ({ useServerSDK: () => ({ scope: "local" }) }))
vi.mock("@/context/sync", () => ({
  useSync: () => ({
    data: {
      agent: ["auto", "plan", "loop", "design"].map((name) => ({ name, mode: "primary" })),
      config: {
        get default_agent() {
          return wiring.state!.defaultAgent
        },
      },
    },
    session: {
      get: (id: string) => ({
        id,
        directory: wiring.state!.directory,
        ordinaryEligible: wiring.state!.ordinaryEligible,
        agent: wiring.state!.sessionAgent,
        model: { id: "chosen", providerID: "deepseek" },
      }),
    },
  }),
}))
vi.mock("@/hooks/use-providers", () => ({
  useProviders: () => ({
    all: () => new Map([["deepseek", provider()]]),
    connected: () => (wiring.state!.connected ? [provider()] : []),
    default: () => ({ deepseek: "fallback" }),
  }),
}))
vi.mock("@/context/models", () => ({
  useModels: () => ({
    visible: (model: { modelID: string }) => model.modelID !== "chosen" || wiring.state!.visible,
    find: (model: { modelID: string }) => ({ id: model.modelID, provider: provider() }),
    recent: { list: () => [], push: () => {} },
    ready: () => true,
    list: () => [],
    variant: { get: () => undefined, set: () => {} },
    setVisibility: () => {},
  }),
}))
beforeEach(() => vi.stubGlobal("localStorage", new Storage()))
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})
function mount() {
  const [state, setState] = createStore({
    connected: true,
    visible: true,
    catalog: true,
    directory: "/private/original",
    ordinaryEligible: true,
    defaultAgent: "auto",
    sessionAgent: "auto",
  })
  wiring.state = state
  const owner = { local: undefined as ReturnType<typeof useLocal> | undefined }
  function Probe() {
    const local = useLocal()
    owner.local = local
    return <output>{local.model.current()?.id ?? "none"}</output>
  }
  const history = createMemoryHistory()
  history.set({ value: `/session/original-${crypto.randomUUID()}` })
  render(() => (
    <MemoryRouter history={history}>
      <Route
        path="/session/:id?"
        component={() => (
          <PlatformProvider
            value={{
              platform: "web",
              openLink() {},
              restart: async () => {},
              back() {},
              forward() {},
              notify: async () => {},
            }}
          >
            <LocalProvider>
              <Probe />
            </LocalProvider>
          </PlatformProvider>
        )}
      />
    </MemoryRouter>
  ))
  return { setState, owner, history }
}
it("the original Local context adopts an available stored Session model ahead of global fallback", () => {
  const fixture = mount()
  expect(screen.getByRole("status").textContent).toBe("chosen")
  fixture.owner.local!.model.set({ providerID: "deepseek", modelID: "fallback" })
  expect(screen.getByRole("status").textContent).toBe("fallback")
})
it.each(["disconnected", "hidden", "missing", "foreign-directory"])(
  "stored Session selection never bypasses %s",
  (reason) => {
    const fixture = mount()
    expect(screen.getByRole("status").textContent).toBe("chosen")
    if (reason === "disconnected") fixture.setState("connected", false)
    if (reason === "hidden") fixture.setState("visible", false)
    if (reason === "missing") fixture.setState("catalog", false)
    if (reason === "foreign-directory") fixture.setState("directory", "/private/foreign")
    expect(screen.getByRole("status").textContent).toBe(reason === "disconnected" ? "none" : "fallback")
  },
)

it("a bound task displays its stored model even when a prior local model override exists", () => {
  const fixture = mount()
  fixture.owner.local!.model.set({ providerID: "deepseek", modelID: "fallback" })
  expect(screen.getByRole("status").textContent).toBe("fallback")
  fixture.owner.local!.model.variant.set("high")
  fixture.setState("ordinaryEligible", false)
  expect(screen.getByRole("status").textContent).toBe("chosen")
  expect(fixture.owner.local!.model.variant.selected()).toBeUndefined()
  fixture.owner.local!.model.set({ providerID: "deepseek", modelID: "chosen" })
  fixture.owner.local!.model.variant.set("low")
  fixture.setState("ordinaryEligible", true)
  expect(screen.getByRole("status").textContent).toBe("fallback")
  expect(fixture.owner.local!.model.variant.selected()).toBe("high")
})

it("default changes affect a new draft while the selected Session draft and execution facts stay separate", async () => {
  const fixture = mount()
  fixture.setState("defaultAgent", "loop")
  expect(fixture.owner.local!.agent.current()?.name).toBe("auto")
  expect(fixture.owner.local!.agent.effective()?.name).toBe("auto")
  fixture.owner.local!.agent.set("plan")
  expect(fixture.owner.local!.agent.current()?.name).toBe("plan")
  expect(fixture.owner.local!.agent.effective()?.name).toBe("auto")
  fixture.setState("defaultAgent", "design")
  expect(fixture.owner.local!.agent.current()?.name).toBe("plan")
  fixture.history.set({ value: "/session" })
  await waitFor(() => expect(fixture.owner.local!.agent.current()?.name).toBe("design"))
  expect(fixture.owner.local!.agent.effective()).toBeUndefined()
})
