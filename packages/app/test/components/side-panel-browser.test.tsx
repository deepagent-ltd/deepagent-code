import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { SidePanelBrowser } from "@/pages/session/side-panel-browser"
import type { BrowserViewState } from "@/context/platform"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({
  update: undefined as ((state: BrowserViewState) => void) | undefined,
  navigate: vi.fn(),
  show: vi.fn(),
  setBounds: vi.fn(),
  hide: vi.fn(),
  unsubscribe: vi.fn(),
}))
vi.mock("@/context/platform", () => ({
  usePlatform: () => ({
    browser: {
      onState: (update: (state: BrowserViewState) => void) => {
        wiring.update = update
        return wiring.unsubscribe
      },
      show: wiring.show,
      setBounds: wiring.setBounds,
      navigate: wiring.navigate,
      back: vi.fn(),
      forward: vi.fn(),
      reload: vi.fn(),
      openExternal: vi.fn(),
      hide: wiring.hide,
    },
  }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  wiring.update = undefined
  wiring.show.mockClear()
  wiring.setBounds.mockClear()
  wiring.navigate.mockClear()
  wiring.hide.mockClear()
  wiring.unsubscribe.mockClear()
})

it("retains an active address draft but consumes original navigation state when the native page owns focus", () => {
  const focus = { renderer: true }
  vi.spyOn(document, "hasFocus").mockImplementation(() => focus.renderer)
  render(() => <SidePanelBrowser onClose={() => {}} />)
  const input = screen.getByPlaceholderText(dict["browser.address"]) as HTMLInputElement
  const observed = { url: "http://127.0.0.1/one", title: "One", canGoBack: false, canGoForward: false, loading: false }
  wiring.update?.(observed)
  expect(input.value).toBe(observed.url)
  input.focus()
  fireEvent.input(input, { target: { value: "http://127.0.0.1/draft" } })
  wiring.update?.({ ...observed, url: "http://127.0.0.1/two", canGoBack: true })
  expect(input.value).toBe("http://127.0.0.1/draft")
  expect(screen.getByRole("button", { name: dict["browser.back"] })).toHaveProperty("disabled", false)
  focus.renderer = false
  wiring.update?.({ ...observed, url: "http://127.0.0.1/two", canGoBack: true })
  expect(input.value).toBe("http://127.0.0.1/two")
  focus.renderer = true
  input.focus()
  fireEvent.input(input, { target: { value: "http://127.0.0.1/submitted" } })
  fireEvent.keyDown(input, { key: "Enter" })
  expect(wiring.navigate).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1/submitted")
  expect(document.activeElement).not.toBe(input)
  wiring.update?.({ ...observed, url: "http://127.0.0.1/redirected" })
  expect(input.value).toBe("http://127.0.0.1/redirected")
  cleanup()
  expect(wiring.hide).toHaveBeenCalledTimes(1)
  expect(wiring.unsubscribe).toHaveBeenCalledTimes(1)
})

it("hides only an intersecting trusted app overlay, restores the same personal viewport and retires its observer", async () => {
  const bounds = new DOMRect(100, 100, 500, 400)
  const overlay = document.createElement("div")
  overlay.dataset.component = "popover-content"
  let overlayBounds = new DOMRect(10, 10, 20, 20)
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.slot === "personal-browser-viewport") return bounds
    if (this === overlay) return overlayBounds
    return new DOMRect()
  })
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++sequence, callback)
    return sequence
  })
  const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id)
  })
  const paint = async () => {
    await waitFor(() => expect(frames.size).toBeGreaterThan(0))
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(performance.now()))
  }
  const app = render(() => <SidePanelBrowser onClose={() => {}} />)
  expect(wiring.show).toHaveBeenCalledExactlyOnceWith({ x: 100, y: 100, width: 500, height: 400 })
  document.body.append(overlay)
  await paint()
  expect(wiring.hide).not.toHaveBeenCalled()
  overlayBounds = new DOMRect(350, 120, 180, 100)
  overlay.style.transform = "translateX(1px)"
  await paint()
  expect(wiring.hide).toHaveBeenCalledTimes(1)
  overlay.hidden = true
  await paint()
  expect(wiring.show).toHaveBeenCalledTimes(2)
  expect(wiring.show.mock.calls[1][0]).toEqual(wiring.show.mock.calls[0][0])
  overlay.hidden = false
  await paint()
  expect(wiring.hide).toHaveBeenCalledTimes(2)
  overlay.style.transform = "translateX(2px)"
  await waitFor(() => expect(frames.size).toBeGreaterThan(0))
  app.unmount()
  expect(cancel).toHaveBeenCalled()
  expect(frames.size).toBe(0)
  expect(wiring.hide).toHaveBeenCalledTimes(3)
  overlay.hidden = true
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(frames.size).toBe(0)
  expect(wiring.show).toHaveBeenCalledTimes(2)
  expect(wiring.unsubscribe).toHaveBeenCalledTimes(1)
  overlay.remove()
})
