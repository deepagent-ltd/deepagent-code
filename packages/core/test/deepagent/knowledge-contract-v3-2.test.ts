import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { openUserGlobalStore, type KnowledgeDocInput } from "../../src/deepagent/durable-knowledge-store"
import { seedCoreKnowledge } from "../../src/deepagent/knowledge-seed"
import { retrieve, invalidateCache } from "../../src/deepagent/knowledge-retriever"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"

// V3.2.1 decision B (docs/34) regression guards for the knowledge-retrieval contract:
//   P1-4 dynamic global cap of selected refs across all types (docs/review_38 §八: 5/8/12 by
//     task complexity; hard ceiling 12), with per-pack quota so primaries are not preempted
//   P0-2 anti_pattern / failure_dossier never injected as positive memory
//   only status=active durable docs are retrievable
const task: TaskContext = {
  userRequest: "optimize the matmul kernel and fix the failing typecheck",
  taskType: "code_modification",
  domain: "code",
  goals: [],
  successCriteria: [],
  riskBoundaries: [],
  validationCommands: [],
}
const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }

let base: string

const memInput = (summary: string, over: Partial<KnowledgeDocInput> = {}): KnowledgeDocInput => ({
  type: "memory",
  description: summary,
  body: summary,
  domain: "code",
  scope: "user-global",
  sensitivity: "public",
  risk: "low",
  confidence: { evidence_strength: "strong", support_count: 3 },
  provenance: { source: "runner", run_ref: "run1", evidence_refs: [] },
  ...over,
})

const seedApproved = (input: KnowledgeDocInput): string => {
  const store = openUserGlobalStore(base)
  const doc = store.stageCandidate(input)
  store.approve(doc.id)
  return doc.id
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-knowledge-contract-"))
  knowledgeSource.configure(base)
  // Seed core strategies/methodologies so total selected can exceed global cap of 5 (P1-4).
  seedCoreKnowledge(openUserGlobalStore(base))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  invalidateCache()
})

describe("docs/34 knowledge retrieval contract", () => {
  test("P1-4: selected refs respect the dynamic global cap (hard ceiling 12) with overflow recorded", () => {
    for (let i = 0; i < 20; i++) {
      seedApproved(memInput(`optimize matmul kernel tip ${i}`, { idSlug: `matmul-${i}` }))
    }
    invalidateCache()
    const result = retrieve({ mode: "max", task, tools, round: 1, previousFailures: 0 })
    expect(result).not.toBeNull()
    if (!result) throw new Error("expected retrieval result")
    // dynamic cap: never exceeds the hard ceiling of 12 regardless of task complexity
    expect((result.selectedRefs ?? []).length).toBeLessThanOrEqual(12)
    // per-type top-k still trims the 20-memory pool well below the cap → recorded as topk gaps
    expect((result.gapAnalysis ?? []).some((g) => g.excluded_by === "topk")).toBe(true)
  })

  test("P0-2: failure_dossier (negative knowledge) is never injected as a positive memory", () => {
    seedApproved(memInput("optimize matmul kernel by unrolling everything (this failed)", { type: "failure_dossier" }))
    invalidateCache()
    const result = retrieve({ mode: "max", task, tools, round: 1, previousFailures: 0 })
    // failure_dossier is not a knowledge doc type → never in memoryRefs/selectedRefs
    expect(result?.memoryRefs ?? []).toHaveLength(0)
  })

  test("only active docs are retrievable (candidate excluded)", () => {
    const store = openUserGlobalStore(base)
    store.stageCandidate(memInput("optimize matmul kernel pending tip")) // left as candidate
    invalidateCache()
    const result = retrieve({ mode: "max", task, tools, round: 1, previousFailures: 0 })
    expect(result?.memoryRefs ?? []).toHaveLength(0)
  })
})
