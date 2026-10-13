import { expect, test } from "bun:test"
import { createAgentSelection, parseModel, recentModels } from "../../src/context/local"
import { createRoot, createSignal } from "solid-js"
import type { Agent } from "@deepagent-code/sdk"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

const primary: Agent = { name: "approved", mode: "primary", permission: [], options: {} }

test("pending agent data has no current selection and cannot accept composer actions", () => {
  createRoot((dispose) => {
    const warnings: string[] = []
    const selected = createAgentSelection({
      agents: () => undefined,
      loading: () => true,
      warn: (message) => warnings.push(message),
    })
    expect(selected.status()).toBe("loading")
    expect(selected.list()).toEqual([])
    expect(selected.current()).toBeUndefined()
    expect(selected.move(1)).toBe(false)
    expect(selected.set(primary.name)).toBe(false)
    expect(warnings).toEqual(["Agents are still loading"])
    dispose()
  })
})

test("unavailable agent data stays blocked and recovers only from the real loaded list", () => {
  createRoot((dispose) => {
    const [agents, setAgents] = createSignal<Agent[]>()
    const [loading, setLoading] = createSignal(false)
    const selected = createAgentSelection({ agents, loading, warn: () => {} })
    expect(selected.status()).toBe("unavailable")
    expect(selected.current()).toBeUndefined()
    expect(selected.set(primary.name)).toBe(false)
    setLoading(true)
    setAgents([primary])
    expect(selected.current()).toBeUndefined()
    setLoading(false)
    expect(selected.status()).toBe("ready")
    expect(selected.current()).toEqual(primary)
    expect(selected.set(primary.name)).toBe(true)
    setAgents(undefined)
    expect(selected.status()).toBe("unavailable")
    expect(selected.current()).toBeUndefined()
    dispose()
  })
})

test("empty or hidden agent lists never manufacture a default agent", () => {
  createRoot((dispose) => {
    const [agents, setAgents] = createSignal<Agent[]>([])
    const selected = createAgentSelection({ agents, loading: () => false, warn: () => {} })
    expect(selected.status()).toBe("empty")
    expect(selected.current()).toBeUndefined()
    setAgents([
      { ...primary, hidden: true },
      { ...primary, name: "child", mode: "subagent" },
    ])
    expect(selected.list()).toEqual([])
    expect(selected.current()).toBeUndefined()
    expect(selected.move(-1)).toBe(false)
    dispose()
  })
})

test("loaded agent selection preserves actual cycling and clears while reloading", () => {
  createRoot((dispose) => {
    const [loading, setLoading] = createSignal(false)
    const selected = createAgentSelection({
      agents: () => [primary, { ...primary, name: "second" }],
      loading,
      warn: () => {},
    })
    expect(selected.current()?.name).toBe("approved")
    expect(selected.move(-1)).toBe(true)
    expect(selected.current()?.name).toBe("second")
    setLoading(true)
    expect(selected.list()).toEqual([])
    expect(selected.current()).toBeUndefined()
    expect(selected.move(1)).toBe(false)
    setLoading(false)
    expect(selected.current()?.name).toBe("second")
    dispose()
  })
})

test("the server default selects new TUI work without replacing an explicit conversation choice", () => {
  createRoot((dispose) => {
    const [preferred, setPreferred] = createSignal("design")
    const selected = createAgentSelection({
      agents: () => [
        { ...primary, name: "auto" },
        { ...primary, name: "loop" },
        { ...primary, name: "design" },
      ],
      loading: () => false,
      preferred,
      warn: () => {},
    })
    expect(selected.current()?.name).toBe("design")
    setPreferred("build")
    expect(selected.current()?.name).toBe("auto")
    expect(selected.set("loop")).toBe(true)
    setPreferred("design")
    expect(selected.current()?.name).toBe("loop")
    dispose()
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})
