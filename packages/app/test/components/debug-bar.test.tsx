import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createMemoryHistory, MemoryRouter, Route, useNavigate } from "@solidjs/router"
import { lazy, type JSX } from "solid-js"
import { DebugBar } from "@/components/debug-bar"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))

const frames = new Map<number, FrameRequestCallback>()
const polls = new Map<number, () => void>()
const observers: BrowserObserver[] = []
const memory = vi.fn(() => ({ usedJSHeapSize: 25, jsHeapSizeLimit: 100 }))
const originalMemory = Object.getOwnPropertyDescriptor(performance, "memory")
let visibility: DocumentVisibilityState = "visible"
let sequence = 0

class BrowserObserver {
  static supportedEntryTypes = ["layout-shift", "longtask", "event"]
  options: PerformanceObserverInit | undefined
  connected = false
  constructor(readonly callback: PerformanceObserverCallback) {
    observers.push(this)
  }
  observe(options: PerformanceObserverInit) {
    this.options = options
    this.connected = true
  }
  disconnect() {
    this.connected = false
  }
  emit(entries: PerformanceEntry[]) {
    this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver)
  }
}

beforeEach(() => {
  frames.clear()
  polls.clear()
  observers.length = 0
  memory.mockClear()
  visibility = "visible"
  sequence = 0
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
  vi.stubGlobal("PerformanceObserver", BrowserObserver)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++sequence
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.spyOn(window, "setInterval").mockImplementation((handler: TimerHandler) => {
    if (typeof handler !== "function") throw new Error("Expected an interval callback")
    const id = ++sequence
    polls.set(id, () => handler())
    return id as unknown as ReturnType<typeof window.setInterval>
  })
  vi.stubGlobal("clearInterval", (id: number) => polls.delete(id))
  Object.defineProperty(performance, "memory", { configurable: true, get: memory })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (originalMemory) Object.defineProperty(performance, "memory", originalMemory)
  if (!originalMemory) Reflect.deleteProperty(performance, "memory")
})

function mount() {
  const history = createMemoryHistory()
  history.set({ value: "/session/one", replace: true, scroll: false })
  return render(() => (
    <MemoryRouter history={history} root={() => <DebugBar />}>
      <Route path="/session/:id" component={() => <div />} />
    </MemoryRouter>
  ))
}

function frame(at: number) {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(at))
}

function visible(value: DocumentVisibilityState) {
  visibility = value
  document.dispatchEvent(new Event("visibilitychange"))
}

function toggle() {
  fireEvent.click(screen.getByRole("button", { name: dict["debugBar.ariaLabel"] }))
}

it("leaves a collapsed diagnostic idle and owns sampling only while expanded", () => {
  const view = mount()
  expect(frames.size).toBe(0)
  expect(polls.size).toBe(0)
  expect(observers).toHaveLength(0)
  expect(memory).not.toHaveBeenCalled()
  toggle()
  expect(frames.size).toBe(1)
  expect(polls.size).toBe(1)
  expect(observers).toHaveLength(3)
  expect(observers.every((observer) => observer.connected && !observer.options?.buffered)).toBe(true)
  expect(memory).toHaveBeenCalledTimes(1)
  const pending = [...frames.values()][0]
  const poll = [...polls.values()][0]
  frame(100)
  frame(350)
  poll()
  expect(memory).toHaveBeenCalledTimes(2)
  toggle()
  expect(frames.size).toBe(0)
  expect(polls.size).toBe(0)
  expect(observers.every((observer) => !observer.connected)).toBe(true)
  pending(600)
  poll()
  expect(frames.size).toBe(0)
  expect(memory).toHaveBeenCalledTimes(2)
  toggle()
  expect(frames.size).toBe(1)
  expect(polls.size).toBe(1)
  expect(observers.filter((observer) => observer.connected)).toHaveLength(3)
  view.unmount()
  expect(frames.size).toBe(0)
  expect(polls.size).toBe(0)
  expect(observers.every((observer) => !observer.connected)).toBe(true)
})

it("stops on page hiding, restarts one fresh window on return, and ignores stale observer callbacks", () => {
  mount()
  toggle()
  const old = observers.find((observer) => observer.options?.type === "layout-shift")!
  old.emit([{ entryType: "layout-shift", value: 0.25, hadRecentInput: false } as unknown as PerformanceEntry])
  expect(screen.getByText("0.25")).toBeTruthy()
  visible("hidden")
  expect(frames.size).toBe(0)
  expect(polls.size).toBe(0)
  expect(observers.every((observer) => !observer.connected)).toBe(true)
  old.emit([{ entryType: "layout-shift", value: 9, hadRecentInput: false } as unknown as PerformanceEntry])
  visible("visible")
  expect(frames.size).toBe(1)
  expect(polls.size).toBe(1)
  expect(observers.filter((observer) => observer.connected)).toHaveLength(3)
  expect(screen.getByText("0.00")).toBeTruthy()
  old.emit([{ entryType: "layout-shift", value: 9, hadRecentInput: false } as unknown as PerformanceEntry])
  expect(screen.getByText("0.00")).toBeTruthy()
  frame(100_000)
  frame(100_016)
  expect(screen.getByText("63")).toBeTruthy()
  toggle()
  visible("hidden")
  visible("visible")
  expect(frames.size).toBe(0)
  expect(polls.size).toBe(0)
  expect(observers.filter((observer) => observer.connected)).toHaveLength(0)
})

it("does not start sampling when first expanded in a hidden page", () => {
  visible("hidden")
  mount()
  toggle()
  expect(frames.size).toBe(0)
  expect(polls.size).toBe(0)
  expect(observers).toHaveLength(0)
  expect(memory).not.toHaveBeenCalled()
  visible("visible")
  expect(frames.size).toBe(1)
  expect(polls.size).toBe(1)
  expect(memory).toHaveBeenCalledTimes(1)
})

it("preserves the finite navigation measurement while the sampler remains collapsed", async () => {
  const pending = Promise.withResolvers<{ default: () => JSX.Element }>()
  const Next = lazy(() => pending.promise)
  const history = createMemoryHistory()
  history.set({ value: "/session/one", replace: true, scroll: false })
  function Shell(props: { children?: JSX.Element }) {
    const navigate = useNavigate()
    return (
      <>
        <DebugBar />
        <button onClick={() => navigate("/session/two")}>Navigate</button>
        {props.children}
      </>
    )
  }
  const view = render(() => (
    <MemoryRouter history={history} root={Shell}>
      <Route path="/session/one" component={() => <div>First</div>} />
      <Route path="/session/two" component={Next} />
    </MemoryRouter>
  ))
  fireEvent.click(screen.getByRole("button", { name: "Navigate" }))
  await waitFor(() => expect(screen.getByText("...")).toBeTruthy())
  expect(frames.size).toBe(0)
  pending.resolve({ default: () => <div>Second</div> })
  await screen.findByText("Second")
  await waitFor(() => expect(frames.size).toBe(1))
  frame(100)
  expect(frames.size).toBe(1)
  frame(116)
  expect(frames.size).toBe(0)
  expect(polls.size).toBe(0)
  expect(observers).toHaveLength(0)
  expect(memory).not.toHaveBeenCalled()
  expect(screen.queryByText("...")).toBeNull()
  view.unmount()
  expect(frames.size).toBe(0)
})
