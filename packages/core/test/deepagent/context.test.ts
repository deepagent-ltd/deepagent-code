import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { DocumentStore } from "../../src/deepagent/document-store"
import type { DocumentStore as DocumentStoreT } from "../../src/deepagent/document-store"
import * as Config from "../../src/deepagent/context/config"
import * as Ledger from "../../src/deepagent/context/ledger"
import * as ConversationLog from "../../src/deepagent/context/conversation-log"
import * as Bridge from "../../src/deepagent/context/bridge"
import * as Orchestrator from "../../src/deepagent/orchestrator"
import * as PromptPolicy from "../../src/deepagent/prompt-policy"
import * as SessionState from "../../src/deepagent/session-state"
import { projectIdForWorkspace } from "../../src/deepagent/durable-knowledge-store"

// V3.8 Appendix-A (Phase 7 附-A) — context-management substrate. These tests lock the audit-critical
// invariants of the LIVE members: the session Ledger, the Conversation Log, the Project Bridge, and the
// Config knobs — including default-safe degradation when the run store construction throws SYNCHRONOUSLY
// (Phase-3 D1 lesson). The main-session Curator/WorkingSet/Ingest cluster was removed in V4.1 T2.5
// (never wired to the prompt loop), so their tests are gone with them.

let base: string

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-context-"))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  knowledgeSource.invalidateCache()
})

const runStore = (): DocumentStoreT => new DocumentStore(path.join(base, "run"))

describe("session ledger (C2)", () => {
  test("applyUpdate appends, marks done/superseded, and keeps a single active next", () => {
    let l = Ledger.emptyLedger("s1", 1)
    l = Ledger.applyUpdate(l, { append: [{ kind: "goal", text: "ship feature", id: "g1" }] }, 2)
    l = Ledger.applyUpdate(l, { next: { text: "write tests" } }, 3)
    l = Ledger.applyUpdate(l, { next: { text: "run tests" } }, 4) // supersedes prior next
    const anchor = Ledger.taskAnchor(l)
    expect(anchor.map((e) => e.id)).toContain("g1")
    const next = Ledger.currentNext(l)
    expect(next?.text).toBe("run tests")
    const actives = l.entries.filter((e) => e.kind === "next" && e.status === "active")
    expect(actives).toHaveLength(1)
  })

  test("persist + load round-trips through the run-scoped ledger DocType", () => {
    const store = runStore()
    let l = Ledger.emptyLedger("sess", 10)
    l = Ledger.applyUpdate(l, { append: [{ kind: "goal", text: "G", id: "g1" }, { kind: "decision", text: "D", id: "d1" }] }, 11)
    Ledger.persistLedger(store, l)
    const loaded = Ledger.loadLedger(store, "sess")
    expect(loaded.entries.map((e) => e.id).sort()).toEqual(["d1", "g1"])
  })

  test("recallCandidates excludes anchor kinds + superseded", () => {
    let l = Ledger.emptyLedger("s", 1)
    l = Ledger.applyUpdate(l, { append: [
      { kind: "goal", text: "goal", id: "g" },
      { kind: "decision", text: "keep", id: "d1" },
      { kind: "decision", text: "drop", id: "d2" },
    ] }, 2)
    l = Ledger.applyUpdate(l, { markSuperseded: ["d2"] }, 3)
    const ids = Ledger.recallCandidates(l).map((e) => e.id)
    expect(ids).toContain("d1")
    expect(ids).not.toContain("g") // anchor kind excluded
    expect(ids).not.toContain("d2") // superseded excluded
  })
})

describe("session ledger (C2) — corrupt-store recovery", () => {
  test("REGRESSION: constructing + reading a genuinely corrupt on-disk store degrades to a safe default", () => {
    // Faithful reproduction of the Stage-1 seam (context-ledger.ts): DocumentStore construction parses
    // every doc file EAGERLY (rebuildIndex -> JSON.parse) and THROWS SYNCHRONOUSLY on a corrupt file.
    // The seam wraps `new DocumentStore(...)` + loadLedger inside Effect.sync guarded by
    // matchCauseEffect. Prove that pattern turns the sync throw into a recovered default (0 / fallback),
    // NOT a thrown exception into the caller. (Effect.catch would MISS this defect — Phase-3 D1.)
    const root = path.join(base, "corrupt")
    const ledgerDir = path.join(root, "docs", "ledger")
    mkdirSync(ledgerDir, { recursive: true })
    writeFileSync(path.join(ledgerDir, "bad.json"), "{ this is : not valid json ]")

    // First: construction alone throws synchronously (documents the defect this guard must catch).
    expect(() => new DocumentStore(root)).toThrow()

    // Now the seam's exact shape: construct + read inside Effect.sync, recover the CAUSE.
    const SENTINEL = -1
    const guarded = Effect.sync(() => {
      const store = new DocumentStore(root)
      return Ledger.loadLedger(store, "sess").entries.length
    }).pipe(
      Effect.matchCauseEffect({
        onFailure: () => Effect.succeed(SENTINEL),
        onSuccess: (n) => Effect.succeed(n),
      }),
    )
    let result: number | undefined
    expect(() => {
      result = Effect.runSync(guarded)
    }).not.toThrow()
    expect(result).toBe(SENTINEL) // recovered the construction defect to the safe default
  })
})

describe("conversation log (C2.5 / Stage 5) — append-only, non-throwing reads", () => {
  test("append assigns monotonic seq; query filters + returns most-recent-first", () => {
    const file = path.join(base, "log", "s.jsonl")
    const log = new ConversationLog.ConversationLog(file)
    log.append({ event: "user_message", text: "hello world", messageId: "m1" })
    log.append({ event: "reasoning", text: "secret thinking" })
    log.append({ event: "tool_call", text: "run grep", data: { cmd: "grep" } })
    const recent = log.query({ limit: 2 })
    expect(recent).toHaveLength(2)
    expect(recent[0]!.seq).toBe(3) // most-recent first
    const kw = log.query({ keyword: "thinking" })
    expect(kw.map((e) => e.event)).toEqual(["reasoning"])
    const byEvent = log.query({ events: ["user_message"] })
    expect(byEvent[0]!.messageId).toBe("m1")
  })

  test("seq recovers across reconstruction (monotonic across process restarts)", () => {
    const file = path.join(base, "log2", "s.jsonl")
    new ConversationLog.ConversationLog(file).append({ event: "user_message", text: "a" })
    const reopened = new ConversationLog.ConversationLog(file)
    const stored = reopened.append({ event: "assistant_message", text: "b" })
    expect(stored.seq).toBe(2)
  })

  test("NON-THROWING: a corrupt trailing line is skipped, never throws on read", () => {
    const file = path.join(base, "log3", "s.jsonl")
    const log = new ConversationLog.ConversationLog(file)
    log.append({ event: "user_message", text: "good" })
    writeFileSync(file, `{"seq":1,"ts":1,"event":"user_message","text":"good"}\n{ corrupt tail`, { flag: "w" })
    expect(() => log.readAll()).not.toThrow()
    expect(log.readAll()).toHaveLength(1) // corrupt tail skipped
  })
})

describe("project bridge (C3) — DocType 'bridge', not knowledge", () => {
  test("carryOver projects active carried entries into a project-scoped bridge doc + renders handoff", () => {
    const store = runStore()
    let l = Ledger.emptyLedger("sessX", 1)
    l = Ledger.applyUpdate(l, { append: [
      { kind: "goal", text: "ship v2", id: "g1" },
      { kind: "done", text: "finished setup", id: "dn1" }, // NOT carried
    ] }, 2)
    l = Ledger.applyUpdate(l, { next: { text: "write the migration" } }, 3)
    const bridge = Bridge.carryOver(store, "projP", l, 100)
    const kinds = bridge.entries.map((e) => e.kind)
    expect(kinds).toContain("goal")
    expect(kinds).toContain("next")
    expect(kinds).not.toContain("done") // done is session-local, not handed off
    // Persisted as the `bridge` DocType (non-knowledge, no confidence required).
    const reloaded = Bridge.loadBridge(store, "projP")
    expect(reloaded.entries.map((e) => e.text)).toContain("ship v2")
    const handoff = Bridge.renderHandoff(reloaded)
    expect(handoff).toContain("ship v2")
    expect(handoff).toContain("write the migration")
  })

  test("shouldLoadBridge gates at the knowledge door (mode !== general/disabled)", () => {
    expect(Bridge.shouldLoadBridge("general")).toBe(false)
    expect(Bridge.shouldLoadBridge("disabled")).toBe(false)
    expect(Bridge.shouldLoadBridge("high")).toBe(true)
  })

  test("orchestrator injects the project bridge handoff into the system prompt (B2 read wiring)", () => {
    // Seed a project bridge into the SAME physical project-scoped durable store the orchestrator reads
    // from (openProjectStore(base, workspacePath) === knowledge-source.projectStoreFor(workspacePath)).
    knowledgeSource.configure(base)
    const workspacePath = path.join(base, "ws")
    const projectStore = knowledgeSource.projectStoreFor(workspacePath).documentStore
    const projectId = projectIdForWorkspace(workspacePath)
    let l = Ledger.emptyLedger("sesPrev", 1)
    l = Ledger.applyUpdate(l, { append: [{ kind: "goal", text: "migrate to v3", id: "g1" }] }, 2)
    l = Ledger.applyUpdate(l, { next: { text: "wire the bridge injection" } }, 3)
    Bridge.carryOver(projectStore, projectId, l, 100)

    // A NEW high-mode session in that workspace must open with the handoff injected.
    const sessionId = "ses_bridge_read"
    SessionState.getOrCreate(sessionId, "high")
    SessionState.update(sessionId, { userRequest: "continue the work", workspacePath })
    const ctx = Orchestrator.buildPromptContext({
      sessionId,
      mode: "high",
      environment: {
        os: "test", shell: "sh", cwd: workspacePath, homedir: base, gitBranch: null,
        gitRoot: null, isGitRepo: false, date: "2026-07-07", platform: "test",
      },
      tools: { availableTools: [], mcpServers: [], totalToolCount: 0 },
      userRequest: "continue the work",
      workspacePath,
    })
    expect(ctx.bridge).toBeDefined()
    expect(ctx.bridge).toContain("migrate to v3")
    const prompt = PromptPolicy.buildSystemPrompt(ctx)
    expect(prompt).toContain("Project Handoff")
    expect(prompt).toContain("migrate to v3")
    expect(prompt).toContain("wire the bridge injection")

    // Gate: general mode does NOT inject the handoff even with a populated bridge.
    const genSession = "ses_bridge_general"
    SessionState.getOrCreate(genSession, "general")
    SessionState.update(genSession, { userRequest: "continue", workspacePath })
    const genCtx = Orchestrator.buildPromptContext({
      sessionId: genSession,
      mode: "general",
      environment: {
        os: "test", shell: "sh", cwd: workspacePath, homedir: base, gitBranch: null,
        gitRoot: null, isGitRepo: false, date: "2026-07-07", platform: "test",
      },
      tools: { availableTools: [], mcpServers: [], totalToolCount: 0 },
      userRequest: "continue",
      workspacePath,
    })
    expect(genCtx.bridge).toBeUndefined()
  })
})

describe("config (C-config) — lenient, configurable knobs (user constraint: 不要限制的太死)", () => {
  test("defaults are lenient, not tight; only the budget FRACTION is a hard clamp", () => {
    const d = Config.DEFAULT_CONTEXT_CONFIG
    expect(d.queryLogMaxLimit).toBe(200)
    expect(d.queryLogDefaultLimit).toBe(20)
    expect(d.ingestChunkTokens).toBe(4000)
    // An override may RAISE lenient limits freely (no tight hardcode blocks it).
    const raised = Config.resolveContextConfig({ queryLogMaxLimit: 100000, ingestChunkTokens: 32000 })
    expect(raised.queryLogMaxLimit).toBe(100000)
    expect(raised.ingestChunkTokens).toBe(32000)
    // But the budget fraction can NEVER exceed the 50% hard ceiling regardless of override.
    expect(Config.resolveContextConfig({ budgetFraction: 5 }).budgetFraction).toBe(0.5)
  })
})
