import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { seedCoreKnowledge } from "../../src/deepagent/knowledge-seed"
import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import * as Registry from "../../src/deepagent/domain-pack-registry"
import { retrieve } from "../../src/deepagent/knowledge-retriever"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"

// V3.2.1 decision-B: old in-code gpuPack / activate / domainKnowledge / registeredDomains
// deleted. Domain activation now goes through DomainPackRegistry (reads manifests from
// packages/domain-packs/); knowledge lives in pack documents/ and DocumentStore.

const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }
const gpuTask: TaskContext = {
  userRequest: "optimize the sgemm cuda kernel for shared memory",
  taskType: "code_modification",
  domain: "code",
  goals: [], successCriteria: [], riskBoundaries: [], validationCommands: [],
}

let base: string

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "deepagent-dom-"))
  base = dir
  knowledgeSource.configure(dir)
  seedCoreKnowledge(openUserGlobalStore(dir))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe("V3 domain pack activation (registry-based, docs/35)", () => {
  test("built-in gpu-kernel pack is registered and discovers pack-scoped docs", () => {
    Registry.configureRegistry(undefined)
    const ids = Registry.discover().map((m) => m.id)
    expect(ids).toContain("code.gpu-kernel")
    const store = openUserGlobalStore(base)
    const gpuDocs = store.retrieve({ types: ["strategy", "methodology", "skill"], activePackIds: ["code.gpu-kernel"], limit: 50 })
      .filter(({ doc }) => doc.domain === "gpu_kernel")
    // docs/review_38 Round 1: the genuine migrated GPU core is 3 strategies + 1 methodology
    // (docs/35 §20) + 2 authored skills. The old >=6/>=4 thresholds asserted the deleted scaffold.
    expect(gpuDocs.filter(({ doc }) => doc.type === "strategy").length).toBeGreaterThanOrEqual(3)
    expect(gpuDocs.filter(({ doc }) => doc.type === "methodology").length).toBeGreaterThanOrEqual(1)
    expect(gpuDocs.filter(({ doc }) => doc.type === "skill").length).toBeGreaterThanOrEqual(2)
  })

  test("registry activates gpu-kernel for cuda backend profile", () => {
    Registry.configureRegistry(undefined)
    const { resolution } = Registry.activateForProfile({
      scenario_mode: "wish", agent_strength: "max", task_kind: "optimize",
      code_domains: ["code", "gpu_kernel"], business_domains: [], platforms: [],
      languages: ["cpp"], frameworks: [], data_classes: [], risk_markers: [],
      repo_signals: ["optimize sgemm cuda kernel"], round_signals: [], user_overrides: [],
    })
    expect(resolution.activePackIds).toContain("code.gpu-kernel")
  })

  test("detect: unrelated profile does NOT activate gpu-kernel", () => {
    Registry.configureRegistry(undefined)
    const { resolution } = Registry.activateForProfile({
      scenario_mode: "wish", agent_strength: "max", task_kind: "implement",
      code_domains: ["code"], business_domains: [], platforms: [],
      languages: ["typescript"], frameworks: ["react"], data_classes: [], risk_markers: [],
      repo_signals: [], round_signals: [], user_overrides: [],
    })
    expect(resolution.activePackIds).not.toContain("code.gpu-kernel")
  })

  test("retrieve: gpu task returns gpu-domain strategies for max mode", () => {
    const r = retrieve({ mode: "max", task: gpuTask, tools, round: 1, previousFailures: 0 })
    expect(r).not.toBeNull()
    // gpu strategies are in DocumentStore via seed; they should appear in selected refs
    const refs = r?.strategyRefs ?? []
    expect(refs.some((id) => id.includes("gpu"))).toBe(true)
  })
})
