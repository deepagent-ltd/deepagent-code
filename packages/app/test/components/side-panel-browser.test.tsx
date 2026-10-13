import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { SidePanelBrowser } from "@/pages/session/side-panel-browser"
import type { BrowserViewState } from "@/context/platform"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({
  update: undefined as ((state: BrowserViewState) => void) | undefined,
  navigate: vi.fn(),
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
      show: vi.fn(),
      setBounds: vi.fn(),
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
