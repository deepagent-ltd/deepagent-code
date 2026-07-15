import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { parseSummaryToEntries, carryOverToBridge, contextStoreRoot } from "../../src/session/context-ledger"
import { DeepAgentContext, DeepAgentDocumentStore, DeepAgentDurableKnowledgeStore } from "@deepagent-code/core/deepagent/index"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Global } from "@deepagent-code/core/global"
import type { SessionID } from "../../src/session/schema"

// V3.8 Appendix-A Stage 1 seam — the pure "structured diff from prose" parser that mirrors a
// compaction summary into typed Session Ledger entries. Tolerant: unknown sections skipped, never
// fatal. (The Effect-wrapped updateLedgerFromSummary + its default-safe matchCauseEffect guard and
// gated compaction call site are exercised through the compaction path; this locks the parse logic.)

describe("parseSummaryToEntries (Stage 1)", () => {
  test("maps known headings to typed ledger entries", () => {
    const summary = [
      "# Goal",
      "- ship the feature",
      "## Constraints",
      "- keep it backward compatible",
      "## Key Decisions",
      "- use the existing DocumentStore",
      "## Next Steps",
      "- write tests",
      "## Files",
      "- src/foo.ts",
    ].join("\n")
    const entries = parseSummaryToEntries(summary)
    const byKind = (k: string) => entries.filter((e) => e.kind === k).map((e) => e.text)
    expect(byKind("goal")).toEqual(["ship the feature"])
    expect(byKind("constraint")).toEqual(["keep it backward compatible"])
    expect(byKind("decision")).toEqual(["use the existing DocumentStore"])
    expect(byKind("next")).toEqual(["write tests"])
    expect(byKind("artifact")).toEqual(["src/foo.ts"])
  })

  // V4.0.1 P1 §3.4 — the narrowed four-bucket template's headings parse into the right ledger kinds; the
  // "Data References" bucket → artifact (reference only, never content).
  test("maps the narrowed four-bucket headings (Progress & Key Decisions / Data References)", () => {
    const summary = [
      "## Progress & Key Decisions",
      "- chose DocumentStore for persistence",
      "## Constraints & Preferences",
      "- keep it backward compatible",
      "## Next Steps",
      "- wire the re-injection",
      "## Data References",
      "- src/foo.ts: the entry point",
    ].join("\n")
    const entries = parseSummaryToEntries(summary)
    const byKind = (k: string) => entries.filter((e) => e.kind === k).map((e) => e.text)
    expect(byKind("decision")).toEqual(["chose DocumentStore for persistence"])
    expect(byKind("constraint")).toEqual(["keep it backward compatible"])
    expect(byKind("next")).toEqual(["wire the re-injection"])
    expect(byKind("artifact")).toEqual(["src/foo.ts: the entry point"])
  })

  test("skips placeholders and bullets outside a known heading", () => {
    const summary = [
      "# Goal",
      "- (none)",
      "- [placeholder]",
      "Some prose not under a bullet",
      "## Unknown Heading",
      "- ignored because heading is unknown",
      "# Next",
      "- real next step",
    ].join("\n")
    const entries = parseSummaryToEntries(summary)
    expect(entries).toEqual([{ kind: "next", text: "real next step" }])
  })

  test("empty / non-structured summary yields no entries (never throws)", () => {
    expect(parseSummaryToEntries("")).toEqual([])
    expect(parseSummaryToEntries("just some free text with no headings")).toEqual([])
  })
})

// V3.8 App-A C3 (Stage 3) write side — carryOverToBridge projects the session ledger into the
// PROJECT-scoped durable bridge so a future session in the same workspace opens with the handoff.
describe("carryOverToBridge (Stage 3 write side)", () => {
  const { SessionLedger, ProjectBridge } = DeepAgentContext
  const { DocumentStore } = DeepAgentDocumentStore

  test("projects the session ledger's active carried entries into the project bridge doc", async () => {
    const prevHome = process.env.DEEPAGENT_CODE_HOME
    const home = mkdtempSync(path.join(tmpdir(), "deepagent-bridge-write-"))
    process.env.DEEPAGENT_CODE_HOME = home
    // Establish a known knowledge-source base (== Global.Path.agent.data for this env) so the write
    // path (projectStoreFor when configured) and the disk read-back below agree, hermetically —
    // independent of any baseDir another test file leaked (invalidateCache does not reset baseDir).
    AgentGateway.DeepAgentKnowledgeSource.configure(Global.Path.agent.data)
    try {
      const sessionID = "ses_carry" as unknown as SessionID
      const workspacePath = path.join(home, "ws")

      // Seed the session ledger the way the compaction path does (run-scoped store).
      const ledgerStore = new DocumentStore(contextStoreRoot(sessionID))
      let l = SessionLedger.emptyLedger(sessionID)
      l = SessionLedger.applyUpdate(l, {
        append: [
          { kind: "goal", text: "finish the bridge write side" },
          { kind: "done", text: "wrote the adapter" }, // session-local, NOT carried
        ],
      })
      l = SessionLedger.applyUpdate(l, { next: { text: "wire compaction call site" } })
      SessionLedger.persistLedger(ledgerStore, l)

      const count = await Effect.runPromise(carryOverToBridge({ sessionID, workspacePath }))
      expect(count).toBeGreaterThanOrEqual(2) // goal + next carried (done excluded)

      // The bridge landed in the SAME physical project store the orchestrator read side loads from.
      const projectStore = DeepAgentDurableKnowledgeStore.openProjectStore(
        Global.Path.agent.data,
        workspacePath,
      ).documentStore
      const projectId = DeepAgentDurableKnowledgeStore.projectIdForWorkspace(workspacePath)
      const bridge = ProjectBridge.loadBridge(projectStore, projectId)
      const texts = bridge.entries.map((e) => e.text)
      expect(texts).toContain("finish the bridge write side")
      expect(texts).toContain("wire compaction call site")
      expect(texts).not.toContain("wrote the adapter")
      expect(ProjectBridge.renderHandoff(bridge)).toContain("Project Handoff")
    } finally {
      AgentGateway.DeepAgentKnowledgeSource.invalidateCache()
      if (prevHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
      else process.env.DEEPAGENT_CODE_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  // Regression: with knowledge-source configured (the live server/desktop path), the write MUST be
  // visible through the SAME module-cached projectStoreFor instance the orchestrator reads — the
  // reader never re-reads disk after construction, so a write through a separate fresh instance would
  // be invisible in-process. Proves same-process write-then-read coherence via the cache.
  test("write is visible through the cached projectStoreFor instance the orchestrator reads (no stale cache)", async () => {
    const prevHome = process.env.DEEPAGENT_CODE_HOME
    const home = mkdtempSync(path.join(tmpdir(), "deepagent-bridge-cache-"))
    process.env.DEEPAGENT_CODE_HOME = home
    AgentGateway.DeepAgentKnowledgeSource.configure(Global.Path.agent.data)
    try {
      const sessionID = "ses_cache" as unknown as SessionID
      const workspacePath = path.join(home, "ws")

      // Warm the reader's cache FIRST (as code-index-trigger / the orchestrator do on first prompt) so
      // the cached instance predates the bridge write — the exact stale-cache condition.
      const cached = AgentGateway.DeepAgentKnowledgeSource.projectStoreFor(workspacePath).documentStore
      const projectId = DeepAgentDurableKnowledgeStore.projectIdForWorkspace(workspacePath)
      expect(ProjectBridge.loadBridge(cached, projectId).entries).toHaveLength(0) // cold: nothing yet

      const ledgerStore = new DocumentStore(contextStoreRoot(sessionID))
      let l = SessionLedger.emptyLedger(sessionID)
      l = SessionLedger.applyUpdate(l, { append: [{ kind: "goal", text: "cross-session handoff works" }] })
      SessionLedger.persistLedger(ledgerStore, l)

      await Effect.runPromise(carryOverToBridge({ sessionID, workspacePath }))

      // Read back through the SAME cached instance the reader holds — must now see the write.
      const after = ProjectBridge.loadBridge(cached, projectId)
      expect(after.entries.map((e) => e.text)).toContain("cross-session handoff works")
    } finally {
      AgentGateway.DeepAgentKnowledgeSource.invalidateCache()
      if (prevHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
      else process.env.DEEPAGENT_CODE_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("empty ledger degrades to a no-op (returns 0, never throws)", async () => {
    const prevHome = process.env.DEEPAGENT_CODE_HOME
    const home = mkdtempSync(path.join(tmpdir(), "deepagent-bridge-empty-"))
    process.env.DEEPAGENT_CODE_HOME = home
    try {
      const count = await Effect.runPromise(
        carryOverToBridge({ sessionID: "ses_empty" as unknown as SessionID, workspacePath: path.join(home, "ws") }),
      )
      expect(count).toBe(0)
    } finally {
      if (prevHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
      else process.env.DEEPAGENT_CODE_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
