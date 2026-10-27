import { fireEvent, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { dict } from "@/i18n/en"

export async function findIMAction(name: string) {
  const trigger = screen.getByRole("button", { name: dict["im.sidebar.actions"] })
  if (trigger.getAttribute("aria-expanded") !== "true") await userEvent.click(trigger)
  return screen.findByRole("menuitem", { name })
}

export function closeIMActions() {
  const menu = screen.queryByRole("menu")
  if (menu) fireEvent.keyDown(menu, { key: "Escape" })
}

export async function clickIMAction(name: string) {
  const item = await findIMAction(name)
  await userEvent.click(item)
  return item
}
