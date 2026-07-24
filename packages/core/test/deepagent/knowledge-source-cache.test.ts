import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  configure,
  isConfiguredFor,
  projectStoreFor,
  reset,
  reviewSummaryForWorkspace,
  userGlobalStoreFor,
} from "../../src/deepagent/knowledge-source"

const roots: string[] = []

const root = () => {
  const value = mkdtempSync(path.join(tmpdir(), "deepagent-knowledge-cache-"))
  roots.push(value)
  return value
}

afterEach(() => {
  reset()
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe("knowledge source cache", () => {
  test("reuses stores when the configured storage root is unchanged", () => {
    const base = root()
    configure(base)
    const first = userGlobalStoreFor()

    configure(path.join(base, "."))

    expect(isConfiguredFor(path.join(base, "."))).toBe(true)
    expect(userGlobalStoreFor()).toBe(first)
  })

  test("replaces stores when the configured storage root changes", () => {
    configure(root())
    const first = userGlobalStoreFor()

    configure(root())

    expect(userGlobalStoreFor()).not.toBe(first)
  })

  test("summarizes pending review items from the live cache", () => {
    const base = root()
    const workspace = path.join(base, "workspace")
    configure(base)
    projectStoreFor(workspace).stageCandidate({
      type: "memory",
      description: "review this learned behavior",
      body: "review this learned behavior",
      domain: "code",
      scope: "project-shared",
      projectId: "project-test",
      sensitivity: "public",
      risk: "low",
      confidence: { evidence_strength: "medium", support_count: 1 },
      provenance: { source: "runner", run_ref: "run-1", evidence_refs: [] },
    })

    expect(reviewSummaryForWorkspace(workspace)).toEqual({ pendingCount: 1 })
  })
})
