import { afterEach, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { Popover } from "@deepagent-code/ui/popover"
import userEvent from "@testing-library/user-event"

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
