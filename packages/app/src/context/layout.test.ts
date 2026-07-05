import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createSessionKeyReader,
  ensureSessionKey,
  isPanelOpen,
  pruneSessionKeys,
  toggledPanelMode,
} from "./layout-helpers"

describe("right-side-panel mode reducer", () => {
  // Regression guard for the IM panel "进去出不来" bug: opening a panel must be
  // reversible. These exercise the exact reducer the LayoutProvider's
  // rightPanel.open/close/toggle delegate to.
  test("opening a mode from closed sets that mode", () => {
    expect(toggledPanelMode(undefined, "im")).toBe("im")
  })

  test("toggling the active mode closes the panel", () => {
    // open IM, then toggle IM again → closed. This is the click-to-open,
    // click-to-close contract the IM tab relies on.
    const opened = toggledPanelMode(undefined, "im")
    expect(opened).toBe("im")
    expect(toggledPanelMode(opened, "im")).toBeUndefined()
  })

  test("toggling a different mode switches instead of closing", () => {
    expect(toggledPanelMode("review", "im")).toBe("im")
  })

  test("isPanelOpen reflects presence of a mode", () => {
    expect(isPanelOpen(undefined)).toBe(false)
    expect(isPanelOpen("im")).toBe(true)
    expect(isPanelOpen("review")).toBe(true)
  })
})

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})
