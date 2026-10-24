import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { batch, createSignal } from "solid-js"
import { WorkPanelTabs } from "@/pages/session/work-panel-tabs"
import type { WorkPanelView } from "@/context/work-panel-state"
import { terminalAutoFocusAllowed, terminalAutoFocusRequest } from "@/utils/terminal-autofocus"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

it("selects tools by keyboard, exposes overflow and closes a view without hiding the whole panel", () => {
  const [active, focus] = createSignal("files")
  const close = vi.fn()
  const hide = vi.fn()
  const expand = vi.fn()
  render(() => (
    <WorkPanelTabs
      tabs={[
        { id: "files", kind: "files" },
        { id: "browser:original", kind: "browser", resourceID: "original" },
        { id: "terminal", kind: "terminal" },
      ]}
      active={active()}
      expanded={false}
      title={(view) => view.id}
      focus={focus}
      close={close}
      home={vi.fn()}
      expand={expand}
      hide={hide}
    />
  ))
  const files = screen.getByRole<HTMLButtonElement>("tab", { name: "files" })
  files.focus()
  fireEvent.keyDown(files, { key: "ArrowRight" })
  expect(active()).toBe("browser:original")
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "browser:original" }))
  fireEvent.keyDown(document.activeElement!, { key: "End" })
  expect(active()).toBe("terminal")
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "files" } })
  expect(active()).toBe("files")
  fireEvent.click(screen.getByRole("button", { name: "workPanel.closeView: browser:original" }))
  expect(close).toHaveBeenCalledWith("browser:original")
  expect(hide).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "workPanel.expand" }))
  expect(expand).toHaveBeenCalledTimes(1)
})

it("shows only the usable IM return action in compact layout and retains desktop tabs for widening", () => {
  const [compact, setCompact] = createSignal(true)
  const hide = vi.fn()
  const focus = vi.fn()
  const editor = document.createElement("div")
  editor.dataset.component = "prompt-input"
  editor.setAttribute("contenteditable", "true")
  editor.tabIndex = 0
  document.body.append(editor)
  render(() => (
    <WorkPanelTabs
      compact={compact()}
      tabs={[
        { id: "files", kind: "files" },
        { id: "im", kind: "im" },
        { id: "terminal", kind: "terminal" },
      ]}
      active="im"
      expanded={false}
      title={(view) => view.id}
      focus={focus}
      close={vi.fn()}
      home={vi.fn()}
      expand={vi.fn()}
      hide={hide}
    />
  ))
  expect(screen.queryByRole("tab")).toBeNull()
  expect(screen.queryByRole("combobox")).toBeNull()
  expect(screen.queryByRole("button", { name: "workPanel.home" })).toBeNull()
  expect(screen.queryByRole("button", { name: "workPanel.expand" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "workPanel.returnMain" }))
  expect(hide).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(editor)
  expect(focus).not.toHaveBeenCalled()
  setCompact(false)
  expect(screen.getAllByRole("tab")).toHaveLength(3)
  expect(screen.getByRole("tab", { name: "im" }).getAttribute("aria-selected")).toBe("true")
  editor.remove()
})

it("keeps overflow selected with a newly inserted external active view and selects the original view back", () => {
  const [tabs, setTabs] = createSignal<WorkPanelView[]>([
    { id: "home", kind: "home" },
    { id: "files", kind: "files" },
    { id: "review", kind: "review" },
  ])
  const [active, focus] = createSignal("home")
  render(() => (
    <WorkPanelTabs
      tabs={tabs()}
      active={active()}
      expanded={false}
      title={(view) => view.id}
      focus={focus}
      close={vi.fn()}
      home={vi.fn()}
      expand={vi.fn()}
      hide={vi.fn()}
    />
  ))
  const overflow = screen.getByRole<HTMLSelectElement>("combobox")
  expect(overflow.value).toBe("home")
  // The active value can arrive before For inserts the matching native option.
  batch(() => {
    focus("browser:new-page")
    setTabs((old) => [...old, { id: "browser:new-page", kind: "browser", resourceID: "new-page" }])
  })
  expect(screen.getByRole("tab", { name: "browser:new-page" }).getAttribute("aria-selected")).toBe("true")
  expect(overflow.value).toBe("browser:new-page")
  expect(screen.getByRole<HTMLOptionElement>("option", { name: "browser:new-page" }).selected).toBe(true)
  expect(screen.getAllByRole<HTMLOptionElement>("option").filter((option) => option.selected)).toHaveLength(1)
  focus("files")
  expect(overflow.value).toBe("files")
  fireEvent.change(overflow, { target: { value: "home" } })
  expect(active()).toBe("home")
  expect(overflow.value).toBe("home")
  expect(screen.getByRole("tab", { name: "home" }).getAttribute("aria-selected")).toBe("true")
  expect(tabs().filter((view) => view.id === "browser:new-page")).toHaveLength(1)
})

it("retains keyboard tab focus across downstream terminal autofocus and releases it for pointer or manual focus", async () => {
  const [active, setActive] = createSignal("home")
  const input = document.createElement("textarea")
  input.setAttribute("aria-label", "Actual downstream input")
  const approval = document.createElement("button")
  approval.textContent = "Actual approval action"
  document.body.append(input, approval)
  const focusDownstream = () => {
    if (terminalAutoFocusAllowed()) input.focus()
  }
  render(() => (
    <WorkPanelTabs
      tabs={[
        { id: "home", kind: "home" },
        { id: "files", kind: "files" },
        { id: "terminal", kind: "terminal" },
      ]}
      active={active()}
      expanded={false}
      title={(view) => view.id}
      focus={(id) => {
        setActive(id)
        if (id === "terminal") focusDownstream()
      }}
      close={vi.fn()}
      home={vi.fn()}
      expand={vi.fn()}
      hide={vi.fn()}
    />
  ))
  const home = screen.getByRole<HTMLButtonElement>("tab", { name: "home" })
  const files = screen.getByRole<HTMLButtonElement>("tab", { name: "files" })
  const terminal = screen.getByRole<HTMLButtonElement>("tab", { name: "terminal" })
  home.focus()
  fireEvent.keyDown(home, { key: "End" })
  expect(active()).toBe("terminal")
  expect(document.activeElement).toBe(terminal)
  focusDownstream()
  expect(document.activeElement).toBe(terminal)
  fireEvent.keyDown(terminal, { key: "ArrowLeft" })
  expect(active()).toBe("files")
  expect(document.activeElement).toBe(files)
  fireEvent.pointerDown(terminal)
  terminal.focus()
  fireEvent.click(terminal)
  expect(document.activeElement).toBe(input)
  home.focus()
  fireEvent.keyDown(home, { key: "End" })
  expect(document.activeElement).toBe(terminal)
  const keyboardMount = terminalAutoFocusRequest(() => input)
  approval.focus()
  await Promise.resolve()
  if (keyboardMount()) input.focus()
  expect(document.activeElement).toBe(approval)
  expect(terminal.hasAttribute("data-work-panel-keyboard-focus")).toBe(false)
  expect(terminalAutoFocusAllowed()).toBe(true)
  terminal.focus()
  const pointerMount = terminalAutoFocusRequest(() => input)
  expect(pointerMount()).toBe(true)
  input.focus()
  expect(pointerMount()).toBe(true)
  approval.focus()
  await Promise.resolve()
  expect(pointerMount()).toBe(false)
  input.focus()
  expect(document.activeElement).toBe(input)
  expect(terminalAutoFocusAllowed()).toBe(true)
  input.remove()
  approval.remove()
})
