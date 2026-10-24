export const workPanelKinds = [
  "home",
  "review",
  "files",
  "subagents",
  "im",
  "browser",
  "worktree",
  "dev",
  "profile",
  "context",
  "terminal",
  "debug-console",
  "problems",
] as const
export type WorkPanelKind = (typeof workPanelKinds)[number]
export type WorkPanelView = { id: string; kind: WorkPanelKind; resourceID?: string }
export type WorkPanelState = {
  tabs: WorkPanelView[]
  active: string
  visible: boolean
  expanded: boolean
  taskID?: string
}

export function workPanelState(value?: WorkPanelState, legacy?: string): WorkPanelState {
  const tabs = Array.isArray(value?.tabs)
    ? value.tabs.filter(
        (tab) =>
          tab &&
          typeof tab.id === "string" &&
          workPanelKinds.includes(tab.kind) &&
          (tab.resourceID === undefined || typeof tab.resourceID === "string") &&
          tab.id === workPanelID(tab.kind, tab.resourceID),
      )
    : []
  if (tabs.length) {
    const valid = tabs.some((tab) => tab.id === value?.active)
    const restored = valid || tabs.some((tab) => tab.id === "home") ? tabs : [workPanelView("home"), ...tabs]
    return {
      ...value!,
      visible: value?.visible === true,
      expanded: value?.expanded === true,
      tabs: [...new Map(restored.map((tab) => [tab.id, tab])).values()],
      active: valid ? value!.active : "home",
    }
  }
  const kind = legacy === "oversight" ? "subagents" : legacy
  const tab = workPanelView(workPanelKinds.includes(kind as WorkPanelKind) ? (kind as WorkPanelKind) : "home")
  return { tabs: [tab], active: tab.id, visible: !!legacy && tab.kind !== "home", expanded: false }
}

export function workPanelID(kind: WorkPanelKind, resourceID?: string) {
  return kind === "browser" && resourceID ? `browser:${resourceID}` : kind
}

export function workPanelView(kind: WorkPanelKind, resourceID?: string): WorkPanelView {
  return { id: workPanelID(kind, resourceID), kind, ...(kind === "browser" && resourceID ? { resourceID } : {}) }
}

export function openWorkPanel(state: WorkPanelState, kind: WorkPanelKind, resourceID?: string): WorkPanelState {
  const tab = workPanelView(kind, resourceID)
  return {
    ...state,
    tabs: state.tabs.some((item) => item.id === tab.id) ? state.tabs : [...state.tabs, tab],
    active: tab.id,
    visible: true,
  }
}

export function closeWorkPanelView(state: WorkPanelState, id: string): WorkPanelState {
  if (!state.tabs.some((tab) => tab.id === id)) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  if (!tabs.length) return { ...state, tabs: [workPanelView("home")], active: "home" }
  return {
    ...state,
    tabs,
    active: state.active === id ? tabs[Math.max(0, state.tabs.findIndex((tab) => tab.id === id) - 1)].id : state.active,
  }
}
