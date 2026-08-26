import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import path from "node:path"
import { resolveDeepAgentCodeHome } from "../../src/deepagent/workspace"
import { openUserGlobalStore, userGlobalKnowledgeRoot } from "../../src/deepagent/durable-knowledge-store"
import * as sessionState from "../../src/deepagent/session-state"

// [storage-root-dual-resolver] guard: under DEEPAGENT_CODE_TEST_HOME, durable DeepAgent writes must
// land under the tmp root, NEVER the real user home. This is the second half of the P0-0 contract
// (storage-root-single-source.test.ts locks resolver parity; this locks that writes follow it).
const realHomeKnowledge = path.join(homedir(), ".deepagent", "code", "public", "knowledge")

let created: string[] = []
afterEach(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
  created = []
})

describe("no write to real home", () => {
  test("resolveDeepAgentCodeHome under TEST_HOME points inside the tmp root, not real home", () => {
    const testHome = mkdtempSync(path.join(tmpdir(), "deepagent-testhome-"))
    created.push(testHome)
    const resolved = resolveDeepAgentCodeHome({ DEEPAGENT_CODE_TEST_HOME: testHome })
    expect(resolved.startsWith(path.resolve(testHome))).toBe(true)
    expect(resolved.startsWith(path.join(homedir(), ".deepagent"))).toBe(false)
  })

  test("durable knowledge + session-state writes land under the configured baseDir (tmp), not real home", () => {
    const testHome = mkdtempSync(path.join(tmpdir(), "deepagent-testhome-"))
    created.push(testHome)
    const baseDir = path.join(resolveDeepAgentCodeHome({ DEEPAGENT_CODE_TEST_HOME: testHome }))
    // Snapshot the real-home knowledge dir contents (if any) so we can assert we did NOT add to it.
    const before = existsSync(realHomeKnowledge) ? readdirSync(realHomeKnowledge).length : -1

    const store = openUserGlobalStore(baseDir)
    sessionState.configure(path.join(baseDir, "state"))
    const doc = store.stageCandidate({
      type: "memory",
      description: "guard entry must not touch real home",
      body: "guard",
      domain: null,
      scope: "user-global",
      sensitivity: "public",
      risk: "low",
      confidence: { evidence_strength: "strong", support_count: 1 },
      provenance: { source: "runner", run_ref: "run-guard", evidence_refs: [] },
    })
    store.approve(doc.id)

    // The write landed in tmp under public/knowledge.
    expect(existsSync(userGlobalKnowledgeRoot(baseDir))).toBe(true)
    expect(userGlobalKnowledgeRoot(baseDir).startsWith(path.resolve(testHome))).toBe(true)

    // The real-home knowledge dir gained nothing from this test.
    const after = existsSync(realHomeKnowledge) ? readdirSync(realHomeKnowledge).length : -1
    expect(after).toBe(before)
  })
})
