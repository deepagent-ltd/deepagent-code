import { describe, expect, test } from "bun:test"
import type { SnapshotFileDiff } from "@deepagent-code/sdk"
import type { Message } from "@deepagent-code/sdk/client"
import { DIFF_PROJECTION_LIMITS, diffs, message } from "./diffs"

const item = {
  file: "src/app.ts",
  patch: "@@ -1 +1 @@\n-old\n+new\n",
  additions: 1,
  deletions: 1,
  status: "modified",
} satisfies SnapshotFileDiff

describe("diffs", () => {
  test("keeps valid arrays", () => {
    expect(diffs([item])).toEqual([item])
  })

  test("wraps a single diff object", () => {
    expect(diffs(item)).toEqual([item])
  })

  test("reads keyed diff objects", () => {
    expect(diffs({ a: item })).toEqual([item])
  })

  test("drops invalid entries", () => {
    expect(
      diffs([
        item,
        { file: "src/metadata-only.ts", additions: 1, deletions: 1 },
        { patch: item.patch, additions: 1, deletions: 1 },
      ]),
    ).toEqual([item, { file: "src/metadata-only.ts", additions: 1, deletions: 1, patch: "" }])
  })

  test("keeps metadata-only summary diffs emitted by the server", () => {
    expect(diffs([{ file: "src/app.ts", additions: 2, deletions: 1, status: "modified" }])).toEqual([
      { file: "src/app.ts", patch: "", additions: 2, deletions: 1, status: "modified" },
    ])
  })

  test("bounds legacy diff arrays and strips oversized patches", () => {
    const oversized = {
      ...item,
      file: "src/oversized.ts",
      patch: "x".repeat(DIFF_PROJECTION_LIMITS.patchCharsPerFile + 1),
    }
    const input = [
      oversized,
      ...Array.from({ length: DIFF_PROJECTION_LIMITS.files + 10 }, (_, index) => ({
        ...item,
        file: `src/file-${index}.ts`,
      })),
    ]

    const result = diffs(input)
    expect(result).toHaveLength(DIFF_PROJECTION_LIMITS.files)
    expect(result[0]).toMatchObject({ file: "src/oversized.ts", patch: "" })
  })

  test("bounds cumulative patch text retained by the client store", () => {
    const patch = "x".repeat(Math.floor(DIFF_PROJECTION_LIMITS.patchCharsTotal / 3))
    const result = diffs(
      Array.from({ length: 5 }, (_, index) => ({
        ...item,
        file: `src/file-${index}.ts`,
        patch,
      })),
    )

    expect(result.reduce((total, value) => total + (value.patch?.length ?? 0), 0)).toBeLessThanOrEqual(
      DIFF_PROJECTION_LIMITS.patchCharsTotal,
    )
    expect(result.some((value) => value.patch === "")).toBe(true)
  })
})

describe("message", () => {
  test("normalizes user summaries with object diffs", () => {
    const input = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      summary: {
        title: "Edit",
        diffs: { a: item },
      },
    } as unknown as Message

    expect(message(input)).toMatchObject({
      summary: {
        title: "Edit",
        diffs: [item],
      },
    })
  })

  test("drops invalid user summaries", () => {
    const input = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      summary: true,
    } as unknown as Message

    expect(message(input)).toMatchObject({ summary: undefined })
  })
})
