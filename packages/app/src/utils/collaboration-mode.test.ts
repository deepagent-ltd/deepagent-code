import { describe, expect, test } from "bun:test"
import { isCollaborationModeName, isSelectableCollaborationMode } from "./collaboration-mode"

describe("collaboration mode selection", () => {
  test("accepts only the built-in collaboration mode names", () => {
    expect(isCollaborationModeName("auto")).toBe(true)
    expect(isCollaborationModeName("loop")).toBe(true)
    expect(isCollaborationModeName("design")).toBe(true)
    expect(isCollaborationModeName("wazero")).toBe(false)
    expect(isCollaborationModeName("build")).toBe(false)
  })

  test("excludes custom, hidden, and non-primary agents from the selection port", () => {
    expect(isSelectableCollaborationMode({ name: "auto", mode: "primary" })).toBe(true)
    expect(isSelectableCollaborationMode({ name: "wazero", mode: "all" })).toBe(false)
    expect(isSelectableCollaborationMode({ name: "wazero", mode: "primary" })).toBe(false)
    expect(isSelectableCollaborationMode({ name: "design", mode: "primary", hidden: true })).toBe(false)
    expect(isSelectableCollaborationMode({ name: "general", mode: "subagent" })).toBe(false)
  })
})
