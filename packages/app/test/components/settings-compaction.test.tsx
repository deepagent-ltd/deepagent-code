import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { dict } from "@/i18n/en"
import { SettingsCompaction } from "@/components/settings-v2/compaction"

const runtime = vi.hoisted(() => ({ server: (): unknown => ({}) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key }) }))
vi.mock("@/context/server-sync", () => ({ useServerSync: () => runtime.server() }))
afterEach(cleanup)

it("offers the three approved profiles and persists only an explicit selection while preserving other settings", async () => {
  const [data, setData] = createStore({ config: { compaction: { mode: "adaptive", auto: false, prune: true } } })
  const updateConfig = vi.fn(async (patch: typeof data.config) => setData("config", patch))
  runtime.server = () => ({ data, updateConfig })
  render(() => <SettingsCompaction />)
  expect(screen.getByText(dict["settings.compaction.adaptive"])).toBeTruthy()
  expect(updateConfig).not.toHaveBeenCalled()
  screen.getByRole("button").focus()
  fireEvent.keyDown(screen.getByRole("button"), { key: "ArrowDown" })
  fireEvent.click(await screen.findByRole("option", { name: dict["settings.compaction.long"] }))
  await waitFor(() =>
    expect(updateConfig).toHaveBeenCalledWith({ compaction: { mode: "long", auto: false, prune: true } }),
  )
  expect(data.config.compaction.mode).toBe("long")
  await waitFor(() => expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false"))
  const content = document.querySelector('[data-slot="select-v2-content"]')
  if (content) fireEvent.animationEnd(content)
  screen.getByRole("button").focus()
  fireEvent.keyDown(screen.getByRole("button"), { key: "ArrowDown" })
  fireEvent.click(await screen.findByRole("option", { name: dict["settings.compaction.extreme"] }))
  await waitFor(() => expect(data.config.compaction.mode).toBe("extreme"))
  expect(updateConfig).toHaveBeenCalledTimes(2)
})
