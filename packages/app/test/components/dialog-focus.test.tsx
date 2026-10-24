import { afterEach, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createSignal, Show } from "solid-js"
import { DialogProvider, useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
const kobalte = await import("@kobalte/core/dialog")
const dialogV2 = await import("@deepagent-code/ui/v2/dialog-v2")

afterEach(cleanup)

function fixture() {
  const captured: { api?: ReturnType<typeof useDialog> } = {}
  function Caller() {
    captured.api = useDialog()
    return (
      <>
        <button>Original opener</button>
        <button>Other control</button>
      </>
    )
  }
  const rendered = render(() => (
    <DialogProvider>
      <Caller />
    </DialogProvider>
  ))
  if (!captured.api) throw new Error("The original DialogProvider did not mount")
  return {
    ...rendered,
    api: captured.api,
    opener: screen.getByRole<HTMLButtonElement>("button", { name: "Original opener" }),
    other: screen.getByRole<HTMLButtonElement>("button", { name: "Other control" }),
  }
}

async function focusedClose(title: string) {
  const content = await screen.findByRole("dialog", { name: title })
  const close = within(content).getByRole<HTMLButtonElement>("button", { name: "Close" })
  await waitFor(() => expect(document.activeElement).toBe(close))
  return close
}

it("captures the opener before startTransition and restores it after the actual V2 Content cleanup", async () => {
  const { api, opener, other } = fixture()
  opener.focus()
  const shown = api.show(() => <dialogV2.Dialog title="Asynchronous modal">Content</dialogV2.Dialog>)
  other.focus()
  await shown
  fireEvent.keyDown(await focusedClose("Asynchronous modal"), { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(opener))
})

it("returns a nested confirmation to the real parent button, then returns the parent to its external opener", async () => {
  const { api, opener } = fixture()
  opener.focus()
  await api.show(() => (
    <Dialog title="Parent">
      <button>Open confirmation</button>
    </Dialog>
  ))
  await focusedClose("Parent")
  const parent = screen.getByRole<HTMLButtonElement>("button", { name: "Open confirmation" })
  parent.focus()
  await api.push(() => (
    <dialogV2.Dialog title="Confirmation">
      <button>Confirm</button>
    </dialogV2.Dialog>
  ))
  fireEvent.click(await focusedClose("Confirmation"))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirmation" })).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(parent))
  fireEvent.keyDown(parent, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(opener))
})

it("inherits the external opener across show replacement instead of restoring a removed dialog button", async () => {
  const { api, opener } = fixture()
  opener.focus()
  await api.show(() => (
    <Dialog title="Replaced">
      <button>Replace this modal</button>
    </Dialog>
  ))
  await focusedClose("Replaced")
  screen.getByRole<HTMLButtonElement>("button", { name: "Replace this modal" }).focus()
  await api.show(() => <dialogV2.Dialog title="Replacement">Replacement content</dialogV2.Dialog>)
  expect(screen.queryByRole("dialog", { name: "Replaced" })).toBeNull()
  fireEvent.click(await focusedClose("Replacement"))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(opener))
})

it.each(["show", "push"] as const)(
  "does not let a closing modal steal focus from %s during its 100ms exit",
  async (operation) => {
    const { api, opener } = fixture()
    opener.focus()
    await api.show(() => <Dialog title="Closing">Old content</Dialog>)
    await focusedClose("Closing")
    api.close()
    await api[operation](() => <dialogV2.Dialog title="New owner">New content</dialogV2.Dialog>)
    const close = await focusedClose("New owner")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(document.activeElement).toBe(close)
    expect(screen.queryByRole("dialog", { name: "Closing" })).toBeNull()
    fireEvent.keyDown(close, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  },
)

it.each(["removed", "disabled", "inert", "hidden"] as const)(
  "does not force focus onto a %s opener",
  async (condition) => {
    const { api, opener } = fixture()
    opener.focus()
    await api.show(() => <dialogV2.Dialog title="Invalid return target">Content</dialogV2.Dialog>)
    const close = await focusedClose("Invalid return target")
    if (condition === "removed") opener.remove()
    if (condition === "disabled") opener.disabled = true
    if (condition === "inert") opener.setAttribute("inert", "")
    if (condition === "hidden") opener.hidden = true
    fireEvent.click(close)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.activeElement).not.toBe(opener)
  },
)

it("captures a different external opener when show replaces a modal during its closing window", async () => {
  const { api, opener, other } = fixture()
  opener.focus()
  await api.show(() => <Dialog title="Retiring modal">Old content</Dialog>)
  await focusedClose("Retiring modal")
  api.close()
  other.focus()
  await api.show(() => <dialogV2.Dialog title="Different opener">New content</dialogV2.Dialog>)
  fireEvent.click(await focusedClose("Different opener"))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(other))
})

it("preserves a different control deliberately focused during closing", async () => {
  const { api, opener, other } = fixture()
  opener.focus()
  await api.show(() => <Dialog title="User focus">Content</Dialog>)
  await focusedClose("User focus")
  api.close()
  other.focus()
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(document.activeElement).toBe(other)
})

it("retires nested and closing roots on Provider unmount without delayed focus or portal leftovers", async () => {
  const { api, opener, unmount } = fixture()
  const outside = document.createElement("button")
  outside.textContent = "Outside the Provider"
  document.body.append(outside)
  try {
    opener.focus()
    await api.show(() => (
      <Dialog title="Disposed parent">
        <button>Nested opener</button>
      </Dialog>
    ))
    await focusedClose("Disposed parent")
    screen.getByRole<HTMLButtonElement>("button", { name: "Nested opener" }).focus()
    await api.push(() => <dialogV2.Dialog title="Disposed child">Child</dialogV2.Dialog>)
    await focusedClose("Disposed child")
    api.close()
    unmount()
    outside.focus()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(document.activeElement).toBe(outside)
    expect(document.querySelector("[data-dialog-id]")).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
  } finally {
    outside.remove()
  }
})

it("keeps the shared V2 wrapper compatible with an original Kobalte Root outside this Provider", async () => {
  render(() => {
    const [opened, setOpened] = createSignal(true)
    return (
      <kobalte.Dialog open={opened()} onOpenChange={setOpened}>
        <kobalte.Dialog.Trigger>Native Kobalte opener</kobalte.Dialog.Trigger>
        <kobalte.Dialog.Portal>
          <Show when={opened()}>
            <dialogV2.Dialog title="Direct Kobalte">Content</dialogV2.Dialog>
          </Show>
        </kobalte.Dialog.Portal>
      </kobalte.Dialog>
    )
  })
  fireEvent.click(await focusedClose("Direct Kobalte"))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Native Kobalte opener" })),
  )
})
