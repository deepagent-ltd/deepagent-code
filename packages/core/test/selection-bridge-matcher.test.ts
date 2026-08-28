import { describe, expect, test } from "bun:test"
import ts from "typescript"
import {
  isCommittedValueLiteral,
  selectionBridgeSites,
} from "../script/legacy-zero-gate/selection-bridge"

// C0-08 matcher precision regression (2026-08-28): the selection-bridge counter must count a
// `v2-none` literal only when COMMITTED as a value (the bridge shape); literals used by the
// SOLUTION side (defensive comparison / consumption) must not be counted. F2/C3-05's writer
// references the forbidden value defensively (status === "v2-none") — before the precision
// fix those were miscounted as 2 extra bridge usages (4 -> 6).

function visitLiterals(source: string): ts.StringLiteral[] {
  const file = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: ts.StringLiteral[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && node.text === "v2-none") out.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

describe("selection-bridge matcher precision", () => {
  test("object-literal property value IS a committed bridge usage", () => {
    const literals = visitLiterals('const g = { code: "v2-none" }')
    expect(literals.length).toBe(1)
    expect(isCommittedValueLiteral(literals[0]!)).toBe(true)
  })

  test("variable initializer IS a committed bridge usage", () => {
    const literals = visitLiterals('const fallback = "v2-none"')
    expect(isCommittedValueLiteral(literals[0]!)).toBe(true)
  })

  test("equality comparison is NOT a committed bridge usage (solution side)", () => {
    const literals = visitLiterals('const bad = status.status === "v2-none"')
    expect(isCommittedValueLiteral(literals[0]!)).toBe(false)
  })

  test("switch case is NOT a committed bridge usage", () => {
    const literals = visitLiterals('switch (x) { case "v2-none": return 1 }')
    expect(isCommittedValueLiteral(literals[0]!)).toBe(false)
  })

  test("diagnostic string argument is NOT a committed bridge usage", () => {
    const literals = visitLiterals('throw new Error("v2-none")')
    expect(isCommittedValueLiteral(literals[0]!)).toBe(false)
  })

  test("real tree: zero committed v2-none bridge sites after C3-08 migration", () => {
    const sites = selectionBridgeSites()
    expect(sites.length).toBe(0)
    // The defensive solution-side references (selection-writer status === "v2-none") must NOT appear.
    expect(sites.some((site) => site.repoFile.includes("context-federation/selection-writer"))).toBe(false)
  })
})
