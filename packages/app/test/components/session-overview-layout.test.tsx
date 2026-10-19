import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { useSessionOverviewLayout } from "@/components/session/session-overview-layout"

const observers: Observer[] = []
class Observer implements ResizeObserver {
  readonly observed = new Set<Element>()
  readonly disconnect = vi.fn(() => this.observed.clear())
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this)
  }
  observe(element: Element) {
    this.observed.add(element)
  }
  unobserve(element: Element) {
    this.observed.delete(element)
  }
  resize() {
    this.callback([], this)
  }
}

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal("ResizeObserver", Observer)
  vi.stubGlobal("innerWidth", 1200)
  vi.stubGlobal("innerHeight", 900)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount(kind: "context" | "tasks", scoped = true) {
  const geometry = { panel: new DOMRect(100, 50, 800, 700), trigger: new DOMRect(830, 70, 32, 32) }
  const [opened, setOpened] = createSignal(false)
  const fixture = render(() => {
    const [trigger, setTrigger] = createSignal<HTMLElement>()
    const layout = useSessionOverviewLayout(trigger, kind, opened)
    return (
      <section
        data-session-overview-scope={scoped ? "" : undefined}
        ref={(element) => vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => geometry.panel)}
      >
        <button
          ref={(element) => {
            vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => geometry.trigger)
            setTrigger(element)
          }}
        >
          Open
        </button>
        <aside data-testid="card" style={layout()} />
      </section>
    )
  })
  return { ...fixture, geometry, setOpened, card: fixture.getByTestId("card") }
}

it("measures only an open card and releases its observer on close and unmount", () => {
  const fixture = mount("context")
  expect(observers).toHaveLength(0)
  fixture.setOpened(true)
  expect(observers).toHaveLength(1)
  expect(observers[0].observed.size).toBe(2)
  expect(fixture.card.style.width).toBe("320px")
  fixture.setOpened(false)
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
  fixture.setOpened(true)
  expect(observers).toHaveLength(2)
  fixture.unmount()
  expect(observers[1].disconnect).toHaveBeenCalledOnce()
})

it("shrinks and regrows with the conversation while the application viewport stays the same", () => {
  const fixture = mount("tasks")
  fixture.setOpened(true)
  expect(fixture.card.style.width).toBe("380px")
  fixture.geometry.panel = new DOMRect(100, 50, 250, 700)
  fixture.geometry.trigger = new DOMRect(306, 70, 32, 32)
  observers[0].resize()
  expect(fixture.card.style.width).toBe("226px")
  expect(fixture.card.style.minWidth).toBe("0")
  fixture.geometry.panel = new DOMRect(100, 50, 800, 700)
  fixture.geometry.trigger = new DOMRect(830, 70, 32, 32)
  observers[0].resize()
  expect(fixture.card.style.width).toBe("380px")
})

it("bounds the whole card below its anchor and inside a short conversation without flipping", () => {
  const fixture = mount("context")
  fixture.geometry.panel = new DOMRect(100, 50, 800, 220)
  fixture.geometry.trigger = new DOMRect(830, 120, 32, 32)
  fixture.setOpened(true)
  expect(fixture.card.style.maxHeight).toContain("102px")
  expect(fixture.card.style.display).toBe("flex")
  expect(fixture.card.style.flexDirection).toBe("column")
  expect(fixture.card.style.overflow).toBe("hidden")
  expect(fixture.card.style.minHeight).toBe("0")
  fixture.geometry.panel = new DOMRect(100, 50, 800, 90)
  observers[0].resize()
  expect(fixture.card.style.maxHeight).toBe("0px")
})

it("handles window resizing without a scope and preserves a twelve pixel right inset", () => {
  const fixture = mount("tasks", false)
  fixture.geometry.trigger = new DOMRect(350, 30, 32, 32)
  fixture.setOpened(true)
  expect(fixture.card.style.width).toBe("370px")
  vi.stubGlobal("innerWidth", 380)
  vi.stubGlobal("innerHeight", 200)
  window.dispatchEvent(new Event("resize"))
  expect(fixture.card.style.width).toBe("356px")
  expect(fixture.card.style.getPropertyValue("translate")).toBe("-14px 0")
  expect(fixture.card.style.maxHeight).toContain("122px")
  fixture.setOpened(false)
  const retained = fixture.card.style.cssText
  vi.stubGlobal("innerHeight", 100)
  window.dispatchEvent(new Event("resize"))
  expect(fixture.card.style.cssText).toBe(retained)
})

it("hides a portalled card while its real workbench is hidden and restores it without reopening", () => {
  const fixture = mount("tasks")
  fixture.setOpened(true)
  expect(fixture.card.style.visibility).toBe("visible")
  fixture.geometry.panel = new DOMRect()
  fixture.geometry.trigger = new DOMRect()
  observers[0].resize()
  expect(fixture.card.style.visibility).toBe("hidden")
  expect(fixture.card.style.pointerEvents).toBe("none")
  expect(fixture.card.style.maxHeight).toBe("0px")
  fixture.geometry.panel = new DOMRect(100, 50, 800, 700)
  fixture.geometry.trigger = new DOMRect(830, 70, 32, 32)
  observers[0].resize()
  expect(fixture.card.style.visibility).toBe("visible")
  expect(fixture.card.style.pointerEvents).toBe("auto")
  expect(fixture.card.style.width).toBe("380px")
  expect(observers).toHaveLength(1)
  fixture.unmount()
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
})
