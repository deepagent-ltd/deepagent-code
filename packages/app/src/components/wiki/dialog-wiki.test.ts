import { describe, expect, test } from "bun:test"
import { resolveWikiExpandedGroup, type WikiGroup } from "./dialog-wiki"

const groups = (counts: Partial<Record<WikiGroup, number>>) =>
  (["knowledge", "memory", "code", "document"] as const).map((group) => ({
    group,
    items: Array.from({ length: counts[group] ?? 0 }, (_, index) => ({ id: index })),
  }))

describe("wiki graph expansion", () => {
  test("search reveals the first graph containing a result", () => {
    expect(resolveWikiExpandedGroup(groups({ code: 2, document: 1 }), "knowledge", true)).toBe("code")
  })

  test("empty search results close the prior graph instead of showing a misleading empty group", () => {
    expect(resolveWikiExpandedGroup(groups({}), "knowledge", true)).toBeUndefined()
  })

  test("manual expansion is preserved outside search", () => {
    expect(resolveWikiExpandedGroup(groups({ document: 1 }), "memory", false)).toBe("memory")
  })
})
