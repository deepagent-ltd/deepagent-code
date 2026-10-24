import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { SettingsModelsV2 } from "@/components/settings-v2/models"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({ models: (): unknown => ({}) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key }) }))
vi.mock("@/context/models", () => ({ useModels: () => runtime.models() }))
afterEach(cleanup)

it("keeps model search, visibility persistence and complete identifiers available after the shared page migration", async () => {
  const [state, setState] = createStore({ visible: true })
  const id = `deployment/${"long-model-id-".repeat(12)}`
  const setVisibility = vi.fn((_key: unknown, visible: boolean) => setState("visible", visible))
  runtime.models = () => ({
    list: () => [{ id, name: "DeepSeek Flash", provider: { id: "deepseek", name: "DeepSeek" } }],
    visible: () => state.visible,
    setVisibility,
  })
  render(() => <SettingsModelsV2 />)
  const toggle = await screen.findByRole("switch")
  fireEvent.click(toggle)
  expect(setVisibility).toHaveBeenCalledWith({ providerID: "deepseek", modelID: id }, false)
  expect(state.visible).toBe(false)
  const disclosure = screen.getByText(dict["settings.details.title"])
  fireEvent.click(disclosure)
  expect(screen.getByText(id)).toBeTruthy()
  const search = screen.getByRole("searchbox")
  fireEvent.input(search, { target: { value: "missing-model" } })
  await waitFor(() => expect(screen.queryByRole("switch")).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: dict["settings.search.clear"] }))
  expect(await screen.findByRole("switch")).toBeTruthy()
  expect(setVisibility).toHaveBeenCalledTimes(1)
})
