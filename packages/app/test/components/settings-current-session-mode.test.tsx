import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { SettingsCollaborationMode } from "@/components/settings-v2/general"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({
  config: undefined as { default_agent: string } | undefined,
  update: (_input: { default_agent: string }) => {},
}))
vi.mock("@/context/server-sync", () => ({
  useServerSync: () => ({
    data: {
      get config() {
        return wiring.config
      },
    },
    updateConfig: wiring.update,
  }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

function fixture(withSession = true) {
  const [state, setState] = createStore({
    sessionID: "selected",
    scope: "original",
    mode: "design",
    editable: true,
    default_agent: "auto",
  })
  wiring.config = state
  const updates: string[] = []
  wiring.update = (input) => {
    updates.push(input.default_agent)
    setState("default_agent", input.default_agent)
  }
  const selections: string[] = []
  render(() => (
    <SettingsCollaborationMode
      modes={() => [{ name: "auto" }, { name: "loop" }, { name: "design" }]}
      loading={false}
      session={
        withSession
          ? {
              current: () => state.sessionID === "selected" && state.scope === "original",
              editable: () => state.editable,
              mode: () => state.mode,
              select: (name) => {
                selections.push(name)
                setState("mode", name)
              },
            }
          : undefined
      }
    />
  ))
  const choose = async (name: string, defaultOnly = false) => {
    const trigger = document.querySelector<HTMLButtonElement>(
      defaultOnly
        ? '[data-action="settings-collaboration-default"] [role="button"]'
        : '[data-action="settings-collaboration-mode"] [role="button"]',
    )!
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    fireEvent.click(await screen.findByRole("option", { name }))
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"))
    const content = document.querySelector('[data-slot="select-v2-content"]')
    if (content) fireEvent.animationEnd(content)
  }
  return { state, setState, selections, updates, choose }
}

it("the setting changes the captured conversation even when the chosen mode already is the default", async () => {
  const test = fixture()
  expect(document.querySelector('[data-action="settings-collaboration-mode"]')!.textContent).toContain(
    dict["composer.mode.design"],
  )
  await test.choose(dict["composer.mode.auto"])
  expect(test.state.mode).toBe("auto")
  expect(test.selections).toEqual(["auto"])
  expect(test.updates).toEqual([])
})

it("a retired conversation cannot apply a late settings selection to another conversation", async () => {
  const test = fixture()
  await test.choose(dict["composer.mode.loop"])
  expect(test.state.mode).toBe("loop")
  expect(test.updates).toEqual([])
  test.setState({ sessionID: "another", scope: "another-server" })
  await test.choose(dict["composer.mode.design"], true)
  expect(test.state.mode).toBe("loop")
  expect(test.selections).toEqual(["loop"])
  expect(test.updates).toEqual(["design"])
})

it("settings without a selected conversation retain the default-only behavior", async () => {
  const test = fixture(false)
  await test.choose(dict["composer.mode.loop"], true)
  expect(test.state.default_agent).toBe("loop")
  expect(test.state.mode).toBe("design")
  expect(test.selections).toEqual([])
  expect(test.updates).toEqual(["loop"])
})

it("a controlled or unconfirmed conversation keeps current mode frozen while preserving default settings", async () => {
  const test = fixture()
  test.setState("editable", false)
  expect(
    document
      .querySelector('[data-action="settings-collaboration-mode"] [role="button"]')!
      .getAttribute("aria-disabled") === "true",
  ).toBe(true)
  await test.choose(dict["composer.mode.loop"], true)
  expect(test.state.mode).toBe("design")
  expect(test.selections).toEqual([])
  expect(test.updates).toEqual(["loop"])
  expect(screen.getByText(dict["settings.general.row.collaborationMode.title"])).toBeDefined()
  expect(screen.getByText(dict["settings.general.row.collaborationMode.currentTitle"])).toBeDefined()
})

it("a new conversation default never changes the selected conversation draft", async () => {
  const test = fixture()
  await test.choose(dict["composer.mode.loop"], true)
  expect(test.state.mode).toBe("design")
  expect(test.selections).toEqual([])
  expect(test.updates).toEqual(["loop"])
  await test.choose(dict["composer.mode.auto"])
  expect(test.state.default_agent).toBe("loop")
  expect(test.selections).toEqual(["auto"])
})
