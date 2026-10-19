import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { closePromptPopoverOnBlur, PromptPopover } from "@/components/prompt-input/slash-popover"

afterEach(cleanup)

it("keeps slash and mention selections mounted on internal focus transfer and closes only on outside blur", () => {
  const [open, setOpen] = createSignal<"at" | "slash" | null>("slash")
  const slash = vi.fn()
  const mention = vi.fn()
  let popover: HTMLDivElement | undefined
  render(() => (
    <>
      <input aria-label="Request" onBlur={(event) => closePromptPopoverOnBlur(event, popover, () => setOpen(null))} />
      <button>Outside</button>
      <PromptPopover
        popover={open()}
        onClose={() => setOpen(null)}
        setSlashPopoverRef={(element) => (popover = element)}
        atFlat={[{ type: "agent", name: "assistant", display: "assistant" }]}
        atKey={(item) => item.display}
        setAtActive={() => {}}
        onAtSelect={(item) => {
          mention(item)
          setOpen(null)
        }}
        slashFlat={[{ id: "browser.connect", trigger: "browser", title: "Browser", type: "builtin" }]}
        setSlashActive={() => {}}
        onSlashSelect={(item) => {
          slash(item.id)
          setOpen(null)
        }}
        commandKeybind={() => undefined}
        t={(key) => key}
      />
    </>
  ))
  const input = screen.getByRole("textbox", { name: "Request" })
  input.focus()
  const browser = screen.getByRole("button", { name: "/browser" })
  browser.focus()
  expect(browser.isConnected).toBe(true)
  fireEvent.click(browser)
  expect(slash).toHaveBeenCalledExactlyOnceWith("browser.connect")

  setOpen("at")
  input.focus()
  const agent = screen.getByRole("button", { name: "@assistant" })
  agent.focus()
  expect(agent.isConnected).toBe(true)
  fireEvent.click(agent)
  expect(mention).toHaveBeenCalledTimes(1)

  setOpen("slash")
  input.focus()
  screen.getByRole("button", { name: "/browser" }).focus()
  screen.getByRole("button", { name: "Outside" }).focus()
  expect(screen.queryByRole("button", { name: "/browser" })).toBeNull()
  expect(slash).toHaveBeenCalledTimes(1)

  setOpen("slash")
  input.focus()
  const abandoned = screen.getByRole("button", { name: "/browser" })
  abandoned.focus()
  abandoned.blur()
  expect(screen.queryByRole("button", { name: "/browser" })).toBeNull()
})
