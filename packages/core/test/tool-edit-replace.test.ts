import { describe, expect, test } from "bun:test"
import { EditReplace } from "../src/tool/edit-replace"

const { replace } = EditReplace

describe("EditReplace (RI-26 W2 fuzzy parity)", () => {
  test("exact single match replaces once", () => {
    expect(replace("line1\nline2\nline3", "line2", "NEW")).toEqual({
      ok: true,
      text: "line1\nNEW\nline3",
      replacements: 1,
    })
  })

  test("exact multiple matches without replaceAll refuse", () => {
    expect(replace("a\nb\na", "a", "c")).toEqual({ ok: false, reason: "multiple_matches" })
  })

  test("exact multiple matches with replaceAll replace all occurrences", () => {
    expect(replace("a\nb\na", "a", "c", true)).toEqual({ ok: true, text: "c\nb\nc", replacements: 2 })
  })

  test("missing text reports not_found", () => {
    expect(replace("a\nb", "zzz", "c")).toEqual({ ok: false, reason: "not_found" })
  })

  test("line-trimmed matching absorbs indentation drift", () => {
    const content = "function foo() {\n  if (x) {\n    return 1\n  }\n}"
    // The find block carries different (heavier) indentation than the file.
    const find = "    if (x) {\n        return 1\n    }"
    expect(replace(content, find, "REPLACED")).toEqual({
      ok: true,
      text: "function foo() {\nREPLACED\n}",
      replacements: 1,
    })
  })

  test("block-anchor fallback matches a block with drifted middle lines", () => {
    const content = ["export const alpha = 1", "const beta = 2", "const gamma = 3", "export const delta = 4"].join("\n")
    // First and last lines match exactly; the middle line drifted.
    const find = ["export const alpha = 1", "const beta = 22", "export const delta = 4"].join("\n")
    expect(replace(content, find, "BLOCK")).toEqual({
      ok: true,
      text: "BLOCK",
      replacements: 1,
    })
  })

  test("whitespace-normalized matching collapses runs of spaces", () => {
    expect(replace("const   value   =   1", "const value = 1", "V")).toEqual({
      ok: true,
      text: "V",
      replacements: 1,
    })
  })

  test("indentation-flexible matching lifts a whole indented block", () => {
    const content = "top\n  inner1\n  inner2\nbottom"
    const find = "inner1\ninner2"
    expect(replace(content, find, "X")).toEqual({
      ok: true,
      text: "top\nX\nbottom",
      replacements: 1,
    })
  })

  test("escape-normalized matching unescapes the find text", () => {
    const content = 'const text = "line1\\nline2"'
    const find = 'const text = "line1\\\\nline2"'
    expect(replace(content, find, "GONE")).toEqual({ ok: true, text: "GONE", replacements: 1 })
  })

  test("a fuzzy span occurring twice does not apply without replaceAll", () => {
    const content = "  alpha\nbeta\n  alpha\nbeta"
    const find = "alpha\nbeta"
    expect(replace(content, find, "X")).toEqual({ ok: false, reason: "multiple_matches" })
  })

  test("a disproportionate fuzzy span is refused", () => {
    // Line-trimmed matching spans two heavily indented lines (>1.1kB, ~552 after trim) for a 3-char find —
    // far past the max(old+500, old*4) bound, so the guard refuses the replacement.
    const content = `${" ".repeat(550)}a\n${" ".repeat(550)}b`
    const find = "a\nb"
    expect(replace(content, find, "X")).toEqual({ ok: false, reason: "disproportionate_match" })
  })

  test("exact matching stays first: previously-exact edits behave identically", () => {
    // Whitespace drift exists ONLY in the find text where a trimmed match would also succeed —
    // the exact strategy must win with the verbatim span when the text is truly present.
    const content = "  keep\n  value"
    expect(replace(content, "  value", "  NEW")).toEqual({ ok: true, text: "  keep\n  NEW", replacements: 1 })
  })
})
