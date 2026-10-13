import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { SettingsIMModel } from "@/components/settings-v2/im-model"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)
const options = [
  { value: "deepseek/deepseek-flash", label: "DeepSeek Flash" },
  { value: "other/model", label: "Other model" },
]
async function choose(name: string) {
  const trigger = screen.getByRole("button")
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  fireEvent.click(await screen.findByRole("option", { name }))
}

it("saves an available IM model reference without selecting an ordinary Session model", async () => {
  const [state, setState] = createStore({ model: "deepseek/deepseek-flash", ordinary: "ordinary/model" })
  const save = vi.fn(async (model: string) => {
    setState("model", model)
  })
  render(() => <SettingsIMModel options={() => options} value={() => state.model} current={() => true} save={save} />)
  await choose("Other model")
  await screen.findByText(dict["settings.im.model.saved"])
  expect(save.mock.calls).toEqual([["other/model"]])
  expect(state.model).toBe("other/model")
  expect(state.ordinary).toBe("ordinary/model")
})

it("an unavailable saved reference is visible and an empty or retired server cannot select a model", () => {
  const [state, setState] = createStore({ current: true, available: true })
  render(() => (
    <SettingsIMModel
      options={() => (state.available ? options : [])}
      value={() => "missing/model"}
      current={() => state.current}
      save={vi.fn()}
    />
  ))
  expect(screen.getByRole("alert").textContent).toContain("missing/model")
  setState("available", false)
  expect(screen.getByRole("button").hasAttribute("data-disabled")).toBe(true)
  expect(screen.getByText(dict["settings.im.model.empty"])).toBeTruthy()
  setState({ available: true, current: false })
  expect(screen.getByRole("button").hasAttribute("data-disabled")).toBe(true)
})

it("a changed server ignores late save feedback and a known save failure is explicit", async () => {
  const [state, setState] = createStore({ current: true })
  const reply = Promise.withResolvers<void>()
  const view = render(() => (
    <SettingsIMModel
      options={() => options}
      value={() => options[0]!.value}
      current={() => state.current}
      save={() => reply.promise}
    />
  ))
  await choose("Other model")
  setState("current", false)
  reply.resolve()
  await Promise.resolve()
  expect(screen.queryByText(dict["settings.im.model.saved"])).toBeNull()
  view.unmount()
  render(() => (
    <SettingsIMModel
      options={() => options}
      value={() => options[0]!.value}
      current={() => true}
      save={async () => {
        throw new Error("write refused")
      }}
    />
  ))
  await choose("Other model")
  await waitFor(() => expect(screen.getByText(dict["settings.im.model.failed"])).toBeTruthy())
})
