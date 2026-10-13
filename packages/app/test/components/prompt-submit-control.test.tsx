import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createStore } from "solid-js/store"
import { PromptSubmitControl } from "@/components/prompt-input/submit-control"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

it("missing current model visibly disables send while keeping the draft, then reacts to a valid selection", async () => {
  const [state, setState] = createStore({ selectionRequired: true })
  const submit = vi.fn()
  render(() => <form id="original-composer" onSubmit={(event) => { event.preventDefault(); submit() }}>
    <textarea aria-label="draft">Original draft</textarea>
    <PromptSubmitControl form="original-composer" disabled={false} finished={false} preparing={false}
      working={false} blank={false} stopping={false} recovery={false} selectionRequired={state.selectionRequired}
      mode="normal" tip="Send" />
  </form>)
  const button = screen.getByRole("button", { name: dict["prompt.action.send"] })
  expect(button.hasAttribute("disabled")).toBe(true)
  expect(screen.getByRole("status").textContent).toBe(dict["prompt.toast.modelAgentRequired.description"])
  await userEvent.click(button)
  expect(submit).not.toHaveBeenCalled()
  expect((screen.getByRole("textbox", { name: "draft" }) as HTMLTextAreaElement).value).toBe("Original draft")
  setState("selectionRequired", false)
  expect(button.hasAttribute("disabled")).toBe(false)
  expect(screen.queryByRole("status")).toBeNull()
  await userEvent.click(button)
  expect(submit).toHaveBeenCalledOnce()
})
it.each([{ preparing: true, working: false }, { preparing: false, working: true }])(
  "missing selection does not disable the original Stop action (preparing=$preparing, working=$working)",
  async ({ preparing, working }) => {
    const submit = vi.fn()
    render(() => <form id="original-composer" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <PromptSubmitControl form="original-composer" disabled={false} finished={false} preparing={preparing}
        working={working} blank={true} stopping={true} recovery={false} selectionRequired={true} mode="normal" tip="Stop" />
    </form>)
    const button = screen.getByRole("button", { name: dict["prompt.action.stop"] })
    expect(button.hasAttribute("disabled")).toBe(false)
    await userEvent.click(button)
    expect(submit).toHaveBeenCalledOnce()
  },
)
it("recovery and finished Session controls remain blocked even with a model", () => {
  render(() => <PromptSubmitControl form="original-composer" disabled={true} finished={true} preparing={false}
    working={false} blank={false} stopping={false} recovery={true} selectionRequired={false} mode="normal" tip="Recover" />)
  expect(screen.getByRole("button", { name: dict["composer.recovery.action"] }).hasAttribute("disabled")).toBe(true)
})
