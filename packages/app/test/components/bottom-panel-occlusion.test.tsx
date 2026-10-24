import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { TerminalPanel } from "@/pages/session/terminal-panel"

const runtime = vi.hoisted(() => ({
  terminal: {} as Record<string, unknown>,
  panel: {} as Record<string, unknown>,
  focus: vi.fn(),
  toggle: vi.fn(),
  create: vi.fn(),
  mounted: 0,
  disposed: 0,
}))
vi.mock("@/context/terminal", () => ({
  BottomTerminalProvider: (props: { children: JSX.Element }) => props.children,
  useTerminal: () => runtime.terminal,
}))
vi.mock("@/context/layout", () => ({
  useLayout: () => ({ terminal: { height: () => 180, resize() {} }, ready: () => true }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key, locale: () => "en" }) }))
vi.mock("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: { dir: "owned" },
    workspaceKey: () => "owned",
    view: () => ({ panel: runtime.panel }),
  }),
}))
vi.mock("@/pages/session/handoff", () => ({ setTerminalHandoff() {} }))
vi.mock("@/pages/session/helpers", () => ({
  createSizing: () => ({ active: () => false, start() {}, touch() {} }),
  focusTerminalById: (id: string) => runtime.focus(id),
}))
vi.mock("@/pages/session/terminal-view", async (original) => ({
  ...(await original<typeof import("@/pages/session/terminal-view")>()),
  TerminalActions: () => null,
  TerminalPanes: () => {
    onMount(() => runtime.mounted++)
    onCleanup(() => runtime.disposed++)
    return <input aria-label="Owned existing terminal" />
  },
}))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

it("occludes the actual bottom host without closing its PTY, cancels focus work and restores the same mounted view", async () => {
  vi.useFakeTimers()
  runtime.mounted = 0
  runtime.disposed = 0
  runtime.terminal = {
    ready: () => true,
    runtimeId: () => "owned-host",
    all: () => [{ id: "owned-pty", title: "Owned terminal", titleNumber: 1 }],
    root: () => ({ kind: "leaf" }),
    closeRequest: () => 0,
    active: () => "owned-pty",
    focusedPaneId: () => "owned-pane",
    creating: () => false,
    createError: () => undefined,
    new: runtime.create,
  }
  runtime.panel = {
    bottom: { opened: () => true, activeView: () => "terminal", toggle: runtime.toggle },
    toggle: runtime.toggle,
  }
  const [occluded, setOccluded] = createSignal(false)
  runtime.focus.mockImplementation(() =>
    (screen.queryByRole("textbox", { name: "Owned existing terminal", hidden: true }) as HTMLElement | null)?.focus(),
  )
  render(() => (
    <>
      <button>Outside terminal</button>
      <TerminalPanel occluded={occluded()} onOpenFile={() => {}} />
    </>
  ))
  const input = screen.getByRole("textbox", { name: "Owned existing terminal" })
  const host = input.closest<HTMLElement>("#bottom-panel")!
  expect(document.activeElement).toBe(input)
  const focused = runtime.focus.mock.calls.length
  setOccluded(true)
  expect(host.style.display).toBe("none")
  expect(host.getAttribute("aria-hidden")).toBe("true")
  expect(host.hasAttribute("inert")).toBe(true)
  screen.getByRole("button", { name: "Outside terminal" }).focus()
  await vi.advanceTimersByTimeAsync(300)
  expect(runtime.focus).toHaveBeenCalledTimes(focused)
  expect(document.activeElement).not.toBe(input)
  expect(runtime.toggle).not.toHaveBeenCalled()
  expect(runtime.create).not.toHaveBeenCalled()
  expect(runtime.mounted).toBe(1)
  expect(runtime.disposed).toBe(0)
  setOccluded(false)
  expect(host.style.display).toBe("")
  expect(host.getAttribute("aria-hidden")).toBe("false")
  expect(host.hasAttribute("inert")).toBe(false)
  expect(screen.getByRole("textbox", { name: "Owned existing terminal" })).toBe(input)
  expect(document.activeElement).toBe(input)
  expect(runtime.mounted).toBe(1)
  expect(runtime.disposed).toBe(0)
})
