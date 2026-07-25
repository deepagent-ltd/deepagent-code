import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  configure,
  reset,
  reviewSummaryForWorkspace,
  userGlobalStoreFor,
} from "@deepagent-code/core/deepagent/knowledge-source"
import { stageAndReviewMemories } from "../../src/import/writer/memory"

const roots: string[] = []

afterEach(() => {
  reset()
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe("knowledge import cache", () => {
  test("writes through the configured store without invalidating it", () => {
    const base = mkdtempSync(path.join(tmpdir(), "deepagent-knowledge-import-cache-"))
    roots.push(base)
    configure(base)
    const store = userGlobalStoreFor()

    expect(
      stageAndReviewMemories(
        [
          {
            source: "codex",
            slug: "safe-memory",
            title: "Safe memory",
            body: "Use the repository typecheck command before submitting a change.",
          },
        ],
        base,
      ),
    ).toEqual({ staged: 1, writtenToInstructions: false, approved: 1, pending: 0 })
    expect(userGlobalStoreFor()).toBe(store)
  })

  test("makes imported project candidates visible in the live review summary", () => {
    const base = mkdtempSync(path.join(tmpdir(), "deepagent-knowledge-import-cache-"))
    const workspace = path.join(base, "workspace")
    roots.push(base)
    configure(base)

    const result = stageAndReviewMemories(
      [
        {
          source: "codex",
          slug: "secret-memory",
          title: "Secret memory",
          body: "API_TOKEN=example-secret-value-that-needs-human-review",
          cwd: workspace,
        },
      ],
      base,
    )

    expect(result.pending).toBe(1)
    expect(reviewSummaryForWorkspace(workspace)).toEqual({ pendingCount: 1 })
  })
})
