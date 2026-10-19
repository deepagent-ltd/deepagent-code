import { afterEach, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { Popover } from "@deepagent-code/ui/popover"
import userEvent from "@testing-library/user-event"
import { Dialog } from "@kobalte/core/dialog"

afterEach(cleanup)

async function closed(trigger: HTMLElement) {
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"))
  const content = screen.queryByRole("dialog")
  if (content) fireEvent.animationEnd(content, { animationName: getComputedStyle(content).animationName })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
}

it("preserves default outside dismissal and restores the trigger only for an explicit close", async () => {
  const user = userEvent.setup()
  render(() => (
    <>
      <input aria-label="Chat input" />
      <Popover title="Default details" triggerAs="button" trigger="Default trigger">
        <button>Card action</button>
      </Popover>
    </>
  ))
  const trigger = screen.getByRole("button", { name: "Default trigger" })
  await user.click(trigger)
  await screen.findByRole("dialog")
  const input = screen.getByRole("textbox", { name: "Chat input" })
  await user.click(input)
  await closed(trigger)
  expect(document.activeElement).toBe(input)
  await user.click(trigger)
  await screen.findByRole("dialog")
  const action = screen.getByRole("button", { name: "Card action" })
  await user.click(action)
  await user.keyboard("{Escape}")
  await closed(trigger)
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})

it("keeps a nonmodal card open without stealing or trapping input focus, and allows trigger, X and Escape closes", async () => {
  const user = userEvent.setup()
  const [state, setState] = createStore({ open: false })
  render(() => (
    <>
      <input aria-label="Chat input" />
      <Popover
        title="Resident details"
        triggerAs="button"
        trigger="Resident trigger"
        open={state.open}
        onOpenChange={(open) => setState("open", open)}
        dismissOnOutside={false}
      >
        <button>Card action</button>
      </Popover>
    </>
  ))
  const input = screen.getByRole("textbox", { name: "Chat input" })
  const trigger = screen.getByRole("button", { name: "Resident trigger" })
  await user.click(input)
  setState("open", true)
  await screen.findByRole("dialog")
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(document.activeElement).toBe(input)
  await user.click(input)
  expect(screen.getByRole("dialog")).toBeTruthy()
  const action = screen.getByRole("button", { name: "Card action" })
  await user.click(action)
  await user.click(input)
  expect(document.activeElement).toBe(input)
  expect(screen.getByRole("dialog")).toBeTruthy()
  await user.click(trigger)
  await closed(trigger)
  await user.click(trigger)
  await screen.findByRole("dialog")
  const close = screen.getByRole("button", { name: "Close" })
  await user.click(close)
  await closed(trigger)
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  await user.click(trigger)
  await screen.findByRole("dialog")
  await user.click(input)
  await user.keyboard("{Escape}")
  await closed(trigger)
  await waitFor(() => expect(document.activeElement).toBe(input))
})

it("lets the existing Kobalte layer stack close a foreground dialog before the resident card", async () => {
  const user = userEvent.setup()
  const [state, setState] = createStore({ dialog: false })
  render(() => (
    <>
      <Popover title="Resident details" triggerAs="button" trigger="Resident trigger" dismissOnOutside={false}>
        <button>Card action</button>
      </Popover>
      <Dialog open={state.dialog} onOpenChange={(dialog) => setState("dialog", dialog)}>
        <Dialog.Trigger>Open settings</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Content>
            <Dialog.Title>Foreground settings</Dialog.Title>
            <Dialog.CloseButton aria-label="Close settings">Close settings</Dialog.CloseButton>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </>
  ))
  const trigger = screen.getByRole("button", { name: "Resident trigger" })
  await user.click(trigger)
  await user.click(screen.getByRole("button", { name: "Open settings" }))
  const dialog = await screen.findByRole("dialog", { name: "Foreground settings" })
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  await user.keyboard("{Escape}")
  await waitFor(() => expect(state.dialog).toBe(false))
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
  const settings = screen.queryByRole("dialog", { name: "Foreground settings" })
  if (settings) fireEvent.animationEnd(settings, { animationName: getComputedStyle(settings).animationName })
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Foreground settings" })).toBeNull())
  await user.keyboard("{Escape}")
  await closed(trigger)
})
