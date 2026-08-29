import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { buildWikiEditGate, openWikiSearchIndex } from "@/wiki/session-archive"
import { WikiSearchIndex } from "@/wiki/search-index"
import { freshStore } from "./helpers"

// V3.9 §B closeout — the two production-wiring factories the audit flagged as holes:
//   1. buildWikiEditGate  — the REAL evidence-gate (promotion.validate) for editKnowledge, not the
//      trivial DEFAULT_WIKI_EDIT_GATE.
//   2. openWikiSearchIndex — a construction factory (the class previously had none in production).

const roots: string[] = []
const freshMemoryDir = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "deepagent-wiki-mem-"))
  roots.push(d)
  return d
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe("buildWikiEditGate — real evidence-gate", () => {
  test("rejects an edit whose page carries NO supporting evidence links", () => {
    const memoryDir = freshMemoryDir()
    const gate = buildWikiEditGate(memoryDir)
    // A knowledge doc with no outbound links → no evidence_refs → validate() fails the replay gate.
    const current = {
      id: "doc:knowledge:x",
      type: "knowledge" as const,
      scope: "durable",
      version: 1,
      status: "active",
      description: "a governed fact",
      links: [],
      body: "old body",
      confidence: { evidence_strength: "medium" as const, support_count: 2 },
    } as never
    const verdict = gate({ current, body: "a revised, non-empty body", editor: { id: "human-1" } })
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toBeDefined()
  })

  test("rejects when the editor identity is missing (human provenance required)", () => {
    const gate = buildWikiEditGate(freshMemoryDir())
    const current = {
      id: "doc:knowledge:y",
      type: "knowledge" as const,
      scope: "durable",
      version: 1,
      status: "active",
      description: "fact",
      links: [{ rel: "references", to: "doc:design:z" }],
      body: "old",
    } as never
    const verdict = gate({ current, body: "new body", editor: { id: "  " } })
    expect(verdict.pass).toBe(false)
  })

  test("passes an edit whose page has evidence links + a real editor", () => {
    const gate = buildWikiEditGate(freshMemoryDir())
    const current = {
      id: "doc:knowledge:ok",
      type: "knowledge" as const,
      scope: "durable",
      version: 3,
      status: "active",
      description: "well-supported fact",
      links: [{ rel: "references", to: "doc:design:src" }],
      body: "old",
    } as never
    const verdict = gate({ current, body: "improved body", editor: { id: "human-1", name: "Dev" } })
    expect(verdict.pass).toBe(true)
  })
})

describe("openWikiSearchIndex — production construction factory", () => {
  // NOTE: the factory builds its graph via openWikiGraph → the KnowledgeSource facade + session stores,
  // not an arbitrary raw DocumentStore. Search behavior over a known graph is covered by
  // search-index.test.ts (explicit WikiGraph). Here we only assert the factory CONSTRUCTS a valid,
  // defect-safe index (the prod-wiring hole the audit flagged: the class had no factory at all).
  test("constructs a real WikiSearchIndex over the workspace projection", () => {
    const { root } = freshStore()
    roots.push(root)
    const index = openWikiSearchIndex({ workspacePath: root })
    try {
      expect(index).toBeInstanceOf(WikiSearchIndex)
    } finally {
      index.close()
    }
  })

  test("rebuild() + search() run cleanly (defect-safe, never throw) on an unconfigured workspace", async () => {
    const { root } = freshStore()
    roots.push(root)
    const index = openWikiSearchIndex({ workspacePath: root })
    try {
      await Effect.runPromise(index.rebuild())
      await Effect.runPromise(index.rebuild()) // idempotent
      const hits = await Effect.runPromise(index.search({ text: "anything" }))
      expect(Array.isArray(hits)).toBe(true)
    } finally {
      index.close()
    }
  })
})
