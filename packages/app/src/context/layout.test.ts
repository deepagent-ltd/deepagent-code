import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createSessionKeyReader,
  movePanel,
  panelIsVisible,
  ensureSessionKey,
  isPanelOpen,
  pruneSessionKeys,
  revealPanel,
  toggleBottomPanel,
  togglePanel,
  toggledPanelMode,
  type PanelSessionState,
  type PanelTransitionInput,
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

describe("movable panel state machine", () => {
  const locations = {
    terminal: "bottom",
    "debug-console": "bottom",
    problems: "bottom",
  } as const
  const state: PanelSessionState = { bottomPanel: { opened: false } }
  const input = (overrides: Partial<PanelTransitionInput> = {}): PanelTransitionInput => ({
    locations,
    sideAvailable: true,
    state,
    ...overrides,
  })

  test("reveal opens the correct host for bottom and side views", () => {
    expect(revealPanel(input(), "terminal")).toEqual({ bottomPanel: { opened: true, activeView: "terminal" } })
    expect(revealPanel(input({ locations: { ...locations, terminal: "side" } }), "terminal")).toEqual({
      bottomPanel: { opened: false },
      rightPanelMode: "terminal",
    })
  })

  test("toggle only closes the host currently displaying the requested view", () => {
    const terminalOpen = revealPanel(input(), "terminal")
    expect(togglePanel(input({ state: terminalOpen }), "terminal")).toEqual({
      bottomPanel: { opened: false, activeView: "terminal" },
    })
    expect(togglePanel(input({ state: terminalOpen }), "debug-console")).toEqual({
      bottomPanel: { opened: true, activeView: "debug-console" },
    })
  })

  test("independent bottom toggle remains closed when no view remains", () => {
    const allSide = { terminal: "side", "debug-console": "side", problems: "side" } as const
    expect(toggleBottomPanel(input({ locations: allSide }))).toEqual({ bottomPanel: { opened: false } })
  })

  test("bottom toggle replaces a stale active view with a valid fallback", () => {
    const locationsWithTerminalSide = { terminal: "side", "debug-console": "bottom", problems: "bottom" } as const
    expect(
      toggleBottomPanel(input({ locations: locationsWithTerminalSide, state: { bottomPanel: { opened: false, activeView: "terminal" } } })),
    ).toEqual({ bottomPanel: { opened: true, activeView: "debug-console" } })
  })

  test("moving a visible bottom view reveals it on the side and falls back", () => {
    const opened = revealPanel(input(), "terminal")
    const moved = movePanel(input({ state: opened }), "terminal", "side")
    expect(moved.locations.terminal).toBe("side")
    expect(moved.state).toEqual({ bottomPanel: { opened: true, activeView: "debug-console" }, rightPanelMode: "terminal" })
  })

  test("moving the final bottom view closes the bottom panel", () => {
    const onlyTerminalBottom = { terminal: "bottom", "debug-console": "side", problems: "side" } as const
    const opened = revealPanel(input({ locations: onlyTerminalBottom }), "terminal")
    const moved = movePanel(input({ locations: onlyTerminalBottom, state: opened }), "terminal", "side")
    expect(moved.state).toEqual({ bottomPanel: { opened: false }, rightPanelMode: "terminal" })
  })

  test("moving a visible side view to bottom clears stale side mode", () => {
    const terminalSide = { ...locations, terminal: "side" } as const
    const opened = revealPanel(input({ locations: terminalSide }), "terminal")
    const moved = movePanel(input({ locations: terminalSide, state: opened }), "terminal", "bottom")
    expect(moved.state).toEqual({ bottomPanel: { opened: true, activeView: "terminal" }, rightPanelMode: undefined })
  })

  test("session snapshots remain isolated", () => {
    const sessionA = revealPanel(input(), "terminal")
    const sessionB = revealPanel(input(), "problems")
    expect(panelIsVisible(sessionA, "terminal", "bottom", true)).toBe(true)
    expect(panelIsVisible(sessionB, "terminal", "bottom", true)).toBe(false)
    expect(sessionB.bottomPanel.activeView).toBe("problems")
  })

  test("mobile refuses a side move and reveals an old side preference in bottom", () => {
    const mobile = input({ sideAvailable: false })
    expect(movePanel(mobile, "terminal", "side")).toEqual({ locations, state })
    expect(revealPanel(input({ sideAvailable: false, locations: { ...locations, terminal: "side" } }), "terminal")).toEqual({
      bottomPanel: { opened: true, activeView: "terminal" },
    })
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
