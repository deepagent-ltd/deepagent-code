import { afterEach, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { DialogProvider, useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"

afterEach(cleanup)

function fixture() {
  function Caller() {
    const dialog = useDialog()
    const select = (name: string) => <SelectV2 data-testid={name} options={["First", "Second"]} current="First" />
    return (
      <>
        {select("outside")}
        <button
          onClick={() =>
            dialog.show(() => (
              <Dialog title="Parent">
                {select("parent")}
                <button onClick={() => dialog.push(() => <Dialog title="Child">{select("child")}</Dialog>)}>
                  Nested
                </button>
              </Dialog>
            ))
          }
        >
          Open
        </button>
      </>
    )
  }
  return render(() => (
    <DialogProvider>
      <Caller />
    </DialogProvider>
  ))
}

async function open(name: string) {
  const trigger = within(screen.getByTestId(name)).getByRole("button", { name: "First" })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  const option = await screen.findByRole("option", { name: "First" })
  await waitFor(() =>
    expect(option.closest('[data-slot="select-v2-content"]')?.contains(document.activeElement)).toBe(true),
  )
  return { trigger, option }
}

async function close(menu: Awaited<ReturnType<typeof open>>) {
  fireEvent.keyDown(menu.option, { key: "Escape" })
  await waitFor(() => expect(menu.trigger.getAttribute("aria-expanded")).toBe("false"))
  // Happy DOM does not complete CSS animations; deliver the browser's close event.
  const content = menu.option.closest('[data-slot="select-v2-content"]')
  if (content) fireEvent.animationEnd(content, { animationName: getComputedStyle(content).animationName })
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0))
  await waitFor(() => expect(document.activeElement).toBe(menu.trigger))
}

it("keeps the original body portal when the trigger has no dialog", async () => {
  fixture()
  const menu = await open("outside")
  expect(menu.option.closest('[role="dialog"]')).toBeNull()
  expect(menu.option.closest('[aria-hidden="true"]')).toBeNull()
  expect(menu.option.closest('[data-component="select-v2-root"]')).toBeNull()
  await close(menu)
  expect(document.activeElement).toBe(menu.trigger)
})

it("exposes options inside their modal and closes only the menu on the first Escape", async () => {
  fixture()
  fireEvent.click(screen.getByRole("button", { name: "Open" }))
  const dialog = await screen.findByRole("dialog", { name: "Parent" })
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  const menu = await open("parent")
  expect(dialog.contains(menu.option)).toBe(true)
  expect(menu.option.closest('[aria-hidden="true"]')).toBeNull()
  expect(screen.getByTestId("outside").closest('[aria-hidden="true"]')).not.toBeNull()
  await close(menu)
  expect(screen.getByRole("dialog", { name: "Parent" })).toBe(dialog)
  expect(document.activeElement).toBe(menu.trigger)
  expect(menu.trigger.hasAttribute("data-dialog-escape-boundary")).toBe(false)
  fireEvent.keyDown(menu.trigger, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})

it("binds a nested menu to the trigger's child modal and removes its portal on disposal", async () => {
  const mounted = fixture()
  fireEvent.click(screen.getByRole("button", { name: "Open" }))
  const parent = await screen.findByRole("dialog", { name: "Parent" })
  await waitFor(() => expect(parent.contains(document.activeElement)).toBe(true))
  fireEvent.click(screen.getByRole("button", { name: "Nested" }))
  const child = await screen.findByRole("dialog", { name: "Child" })
  await waitFor(() => expect(child.contains(document.activeElement)).toBe(true))
  const menu = await open("child")
  expect(menu.option.closest('[role="dialog"]')).toBe(child)
  expect(menu.option.closest('[aria-hidden="true"]')).toBeNull()
  expect(screen.getByTestId("parent").closest('[aria-hidden="true"]')).not.toBeNull()
  await close(menu)
  expect(screen.getByRole("dialog", { name: "Child" })).toBe(child)
  expect(document.activeElement).toBe(menu.trigger)
  await open("child")
  mounted.unmount()
  expect(screen.queryAllByRole("option")).toHaveLength(0)
  expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0)
})
