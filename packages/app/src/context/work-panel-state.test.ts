import { expect, test } from "bun:test"
import { closeWorkPanelView, openWorkPanel, workPanelState } from "./work-panel-state"

test("first opening uses home and temporarily hiding preserves the active resource", () => {
  const fresh = workPanelState()
  expect(fresh.active).toBe("home")
  expect(fresh.visible).toBe(false)
  const opened = openWorkPanel(fresh, "browser", "original-resource")
  const restored = workPanelState({ ...opened, visible: false })
  expect(restored.active).toBe("browser:original-resource")
  expect(restored.tabs).toEqual(opened.tabs)
  expect({ ...restored, visible: true }.active).toBe(opened.active)
})

test("tool views are singleton while browser identity uses the actual resource", () => {
  const files = openWorkPanel(openWorkPanel(workPanelState(), "files"), "files")
  expect(files.tabs.filter((tab) => tab.kind === "files")).toHaveLength(1)
  const pages = openWorkPanel(openWorkPanel(files, "browser", "one"), "browser", "two")
  expect(pages.tabs.filter((tab) => tab.kind === "browser").map((tab) => tab.resourceID)).toEqual(["one", "two"])
  expect(openWorkPanel(pages, "browser", "one").tabs).toHaveLength(pages.tabs.length)
})

test("closing a view retains the remaining identities and last close returns home", () => {
  const pages = openWorkPanel(openWorkPanel(workPanelState(), "browser", "resource"), "terminal")
  const closed = closeWorkPanelView(pages, "terminal")
  expect(closed.active).toBe("browser:resource")
  expect(closed.tabs.some((tab) => tab.resourceID === "resource")).toBe(true)
  const empty = closeWorkPanelView(closeWorkPanelView(closed, "home"), "browser:resource")
  expect(empty.tabs).toEqual([{ id: "home", kind: "home" }])
  expect(empty.visible).toBe(true)
})

test("legacy mode migrates without changing a persisted resource or accepting a malformed identity", () => {
  expect(workPanelState(undefined, "oversight").active).toBe("subagents")
  expect(workPanelState(undefined, "retired-tool").active).toBe("home")
  const state = openWorkPanel(workPanelState(), "browser", "real")
  expect(
    workPanelState({ ...state, tabs: [{ id: "browser:other", kind: "browser", resourceID: "real" }] }).active,
  ).toBe("home")
  expect(workPanelState({ ...state, active: "gone" }).active).toBe("home")
})
