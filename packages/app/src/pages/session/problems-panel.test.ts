import { describe, expect, test } from "bun:test"
import { parseWorkspaceDiagnostics } from "./problems-helpers"

describe("parseWorkspaceDiagnostics", () => {
  test("validates unknown SDK payloads and sorts by severity, file, and range", () => {
    const diagnostics = parseWorkspaceDiagnostics(
      {
        "/workspace/z.ts": [
          { message: "late warning", severity: 2, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 3 } } },
        ],
        "/workspace/a.ts": [
          { message: "error", severity: 1, source: "ts", code: 2322, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } },
          { message: "early warning", severity: 2, range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } } },
        ],
        "/workspace/ignored.ts": [{ message: 1 }],
      },
      (path) => path.replace("/workspace/", ""),
    )

    expect(diagnostics.map((item) => [item.level, item.relativeFile, item.range.start.line])).toEqual([
      ["error", "a.ts", 1],
      ["warning", "a.ts", 0],
      ["warning", "z.ts", 4],
    ])
    expect(diagnostics[0]).toMatchObject({ source: "ts", code: 2322 })
  })

  test("treats omitted severity as error and ignores malformed root values", () => {
    expect(parseWorkspaceDiagnostics(null, String)).toEqual([])
    expect(parseWorkspaceDiagnostics([], String)).toEqual([])
    expect(
      parseWorkspaceDiagnostics(
        { "/workspace/a.ts": [{ message: "unknown severity", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] },
        String,
      )[0]?.level,
    ).toBe("error")
  })
})
