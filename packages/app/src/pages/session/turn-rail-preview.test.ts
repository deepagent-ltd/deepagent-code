import { describe, expect, test } from "bun:test"
import type { Part } from "@deepagent-code/sdk/v2"
import { turnPreview } from "./helpers"

const text = (over: Partial<Extract<Part, { type: "text" }>>): Part =>
  ({ id: "p", sessionID: "s", messageID: "m", type: "text", text: "", ...over }) as Part

// U-NAV 验收 (b): hover 段弹该轮预览（首行标题 + 截断正文，跳过 synthetic/comment）。
describe("turnPreview", () => {
  test("takes first line as title and the rest as body", () => {
    expect(turnPreview([text({ text: "Fix the login bug\nit crashes on submit\nwith a 500" })])).toEqual({
      title: "Fix the login bug",
      body: "it crashes on submit with a 500",
    })
  })

  test("title only when there is a single line", () => {
    expect(turnPreview([text({ text: "rename getUserName" })])).toEqual({
      title: "rename getUserName",
      body: undefined,
    })
  })

  test("skips synthetic (comment) parts", () => {
    expect(
      turnPreview([
        text({ text: "// review note", synthetic: true }),
        text({ text: "Add pagination\nto the users endpoint" }),
      ]),
    ).toEqual({ title: "Add pagination", body: "to the users endpoint" })
  })

  test("skips ignored and empty parts", () => {
    expect(
      turnPreview([text({ text: "stale", ignored: true }), text({ text: "   " }), text({ text: "Real prompt" })]),
    ).toEqual({ title: "Real prompt", body: undefined })
  })

  test("returns empty when no usable text part exists", () => {
    expect(turnPreview([])).toEqual({})
    expect(turnPreview([text({ text: "x", synthetic: true })])).toEqual({})
  })

  test("truncates an overly long title with an ellipsis", () => {
    const long = "a".repeat(200)
    const result = turnPreview([text({ text: long })])
    expect(result.title!.endsWith("…")).toBe(true)
    expect(result.title!.length).toBeLessThanOrEqual(80)
  })

  test("normalizes CRLF and collapses blank lines", () => {
    expect(turnPreview([text({ text: "Title here\r\n\r\nbody line one\r\nbody line two" })])).toEqual({
      title: "Title here",
      body: "body line one body line two",
    })
  })
})
