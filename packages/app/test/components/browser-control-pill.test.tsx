import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { BrowserControlPill, type BrowserControlPillProps } from "@/components/browser-control-pill"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mount(input: Partial<BrowserControlPillProps> = {}) {
  const [state, setState] = createStore<BrowserControlPillProps>({
    resourceID: "browser-a",
    ownershipEpoch: 1,
    state: "agent_owned",
    ...input,
  })
  render(() => <BrowserControlPill {...state} />)
  return setState
}

it("uses the observed control duration, advances only while Agent-owned, and never invents a start time", () => {
  vi.useFakeTimers()
  const clock = { now: 100 }
  vi.spyOn(performance, "now").mockImplementation(() => clock.now)
  const setState = mount()
  expect(screen.getByRole("timer").textContent).toBe("—")
  setState("elapsedMs", 49_000)
  expect(screen.getByRole("timer").textContent).toBe("0:49")
  clock.now += 2000
  vi.advanceTimersByTime(2000)
  expect(screen.getByRole("timer").textContent).toBe("0:51")
  setState({ state: "human_owned", ownershipEpoch: 2, elapsedMs: 51_000 })
  expect(screen.queryByRole("timer")).toBeNull()
  clock.now += 60_000
  vi.advanceTimersByTime(60_000)
  setState({ state: "agent_owned", ownershipEpoch: 3, elapsedMs: 2000 })
  expect(screen.getByRole("timer").textContent).toBe("0:02")
})

it("coalesces the click and waits for actual Main ownership instead of optimistically showing success", async () => {
  const request = Promise.withResolvers<void>()
  const takeover = vi.fn(() => request.promise)
  const back = vi.fn()
  const setState = mount({ onTakeover: takeover, onReturnToSession: back })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.takeover"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.requesting"] }))
  expect(takeover).toHaveBeenCalledTimes(1)
  expect(screen.getByRole("status").textContent).toBe(dict["browser.shared.agent_owned"])
  request.resolve()
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["browser.shared.takeover"] })).toHaveProperty("disabled", false),
  )
  expect(screen.queryByText(dict["browser.shared.human_owned"])).toBeNull()
  setState({ state: "takeover_pending", ownershipEpoch: 2 })
  expect(screen.getByRole("button", { name: dict["browser.shared.requesting"] })).toHaveProperty("disabled", true)
  setState("state", "human_owned")
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.returnToSession"] }))
  expect(back).toHaveBeenCalledTimes(1)
  expect(takeover).toHaveBeenCalledTimes(1)
  expect(screen.getByText(dict["browser.shared.humanHint"])).toBeTruthy()
  expect(screen.queryByRole("button", { name: /resume|restore|continue/i })).toBeNull()
})

it("allows a new takeover during acquire and only original cleanup plus explicit close when blocked", async () => {
  const takeover = vi.fn().mockResolvedValue(undefined)
  const retry = vi.fn().mockRejectedValue(new Error("Input release is unconfirmed"))
  const close = vi.fn()
  const setState = mount({
    state: "acquire_pending",
    onTakeover: takeover,
    onRetryTakeover: retry,
    onCloseResource: close,
  })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.takeover"] }))
  await waitFor(() => expect(takeover).toHaveBeenCalledTimes(1))
  setState({ state: "fenced_blocked", ownershipEpoch: 2 })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.retryTakeover"] }))
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Input release is unconfirmed"))
  expect(retry).toHaveBeenCalledTimes(1)
  expect(takeover).toHaveBeenCalledTimes(1)
  expect(screen.getByRole("status").textContent).toBe(dict["browser.shared.fenced_blocked"])
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.close"] }))
  expect(close).toHaveBeenCalledTimes(1)
})

it("discards a late failure after the displayed resource or ownership epoch changes", async () => {
  const request = Promise.withResolvers<void>()
  const setState = mount({ onTakeover: () => request.promise })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.takeover"] }))
  setState({ resourceID: "browser-b", ownershipEpoch: 8, state: "human_owned" })
  request.reject(new Error("Old browser error"))
  await request.promise.catch(() => undefined)
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.getByRole("status").textContent).toBe(dict["browser.shared.human_owned"])
})
