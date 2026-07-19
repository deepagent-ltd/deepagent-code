import type { Accessor } from "solid-js"

export type PanelView = "terminal" | "debug-console" | "problems"
export type PanelLocation = "bottom" | "side"

export const PANEL_VIEWS: readonly PanelView[] = ["terminal", "debug-console", "problems"]

export type BottomPanelState = {
  opened: boolean
  activeView?: PanelView
}

export type PanelSessionState<Mode extends string = string> = {
  bottomPanel: BottomPanelState
  rightPanelMode?: Mode
}

export type PanelTransitionInput<Mode extends string = string> = {
  locations: Record<PanelView, PanelLocation>
  sideAvailable: boolean
  state: PanelSessionState<Mode>
}

const clonePanelState = <Mode extends string>(state: PanelSessionState<Mode>): PanelSessionState<Mode> => ({
  bottomPanel: { ...state.bottomPanel },
  rightPanelMode: state.rightPanelMode,
})

export const panelHost = (location: PanelLocation, sideAvailable: boolean): PanelLocation =>
  location === "side" && !sideAvailable ? "bottom" : location

export const bottomPanelFallback = (
  locations: Record<PanelView, PanelLocation>,
  sideAvailable: boolean,
): PanelView | undefined => PANEL_VIEWS.find((view) => panelHost(locations[view], sideAvailable) === "bottom")

export const panelIsVisible = <Mode extends string>(
  state: PanelSessionState<Mode>,
  view: PanelView,
  location: PanelLocation,
  sideAvailable: boolean,
) => {
  const host = panelHost(location, sideAvailable)
  return host === "bottom"
    ? state.bottomPanel.opened && state.bottomPanel.activeView === view
    : state.rightPanelMode === view
}

export const revealPanel = <Mode extends string>(
  input: PanelTransitionInput<Mode>,
  view: PanelView,
): PanelSessionState<Mode> => {
  const state = clonePanelState(input.state)
  const host = panelHost(input.locations[view], input.sideAvailable)
  if (host === "bottom") {
    state.bottomPanel = { opened: true, activeView: view }
  } else {
    state.rightPanelMode = view as Mode
  }
  return state
}

export const togglePanel = <Mode extends string>(
  input: PanelTransitionInput<Mode>,
  view: PanelView,
): PanelSessionState<Mode> => {
  if (!panelIsVisible(input.state, view, input.locations[view], input.sideAvailable)) {
    return revealPanel(input, view)
  }

  const state = clonePanelState(input.state)
  if (panelHost(input.locations[view], input.sideAvailable) === "bottom") {
    state.bottomPanel.opened = false
  } else {
    state.rightPanelMode = undefined
  }
  return state
}

export const toggleBottomPanel = <Mode extends string>(
  input: PanelTransitionInput<Mode>,
): PanelSessionState<Mode> => {
  const state = clonePanelState(input.state)
  if (state.bottomPanel.opened) {
    state.bottomPanel.opened = false
    return state
  }
  const fallback = bottomPanelFallback(input.locations, input.sideAvailable)
  if (!fallback) return { bottomPanel: { opened: false }, rightPanelMode: state.rightPanelMode }
  state.bottomPanel = {
    opened: true,
    activeView:
      state.bottomPanel.activeView && panelHost(input.locations[state.bottomPanel.activeView], input.sideAvailable) === "bottom"
        ? state.bottomPanel.activeView
        : fallback,
  }
  return state
}

export const movePanel = <Mode extends string>(
  input: PanelTransitionInput<Mode>,
  view: PanelView,
  target: PanelLocation,
): { locations: Record<PanelView, PanelLocation>; state: PanelSessionState<Mode> } => {
  if (target === "side" && !input.sideAvailable) return { locations: input.locations, state: input.state }

  const source = input.locations[view]
  if (source === target) return { locations: input.locations, state: input.state }

  const locations = { ...input.locations, [view]: target }
  const wasVisible = panelIsVisible(input.state, view, source, input.sideAvailable)
  let state = clonePanelState(input.state)

  if (source === "bottom" && state.bottomPanel.activeView === view) {
    const fallback = bottomPanelFallback(locations, input.sideAvailable)
    state.bottomPanel = fallback ? { opened: state.bottomPanel.opened, activeView: fallback } : { opened: false }
  }
  if (source === "side" && state.rightPanelMode === view) state.rightPanelMode = undefined

  if (wasVisible) state = revealPanel({ locations, sideAvailable: input.sideAvailable, state }, view)
  return { locations, state }
}

// Pure reducer for the right-side-panel mode. Kept out of the provider so the
// open/close/toggle contract — most importantly "toggling the active tab closes
// the panel" — is unit-testable without constructing the full LayoutProvider.
// `undefined` means the panel is closed.
export function toggledPanelMode<Mode extends string>(current: Mode | undefined, mode: Mode): Mode | undefined {
  return current === mode ? undefined : mode
}

export function isPanelOpen(current: string | undefined): boolean {
  return current !== undefined
}

export function ensureSessionKey(key: string, touch: (key: string) => void, seed: (key: string) => void) {
  touch(key)
  seed(key)
  return key
}

export function createSessionKeyReader(sessionKey: string | Accessor<string>, ensure: (key: string) => void) {
  const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey
  return () => {
    const value = key()
    ensure(value)
    return value
  }
}

export function pruneSessionKeys(input: {
  keep?: string
  max: number
  used: Map<string, number>
  view: string[]
  tabs: string[]
}) {
  if (!input.keep) return []

  const keys = new Set<string>([...input.view, ...input.tabs])
  if (keys.size <= input.max) return []

  const score = (key: string) => {
    if (key === input.keep) return Number.MAX_SAFE_INTEGER
    return input.used.get(key) ?? 0
  }

  return Array.from(keys)
    .sort((a, b) => score(b) - score(a))
    .slice(input.max)
}
