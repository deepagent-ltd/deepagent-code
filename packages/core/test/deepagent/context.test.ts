import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { LLMResponse, LLMEvent, Model } from "@deepagent-code/llm"
import { LLMClient } from "@deepagent-code/llm/route"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { DocumentStore } from "../../src/deepagent/document-store"
import type { DocumentStore as DocumentStoreT } from "../../src/deepagent/document-store"
import { GraphQuery } from "../../src/deepagent/graph-query"
import * as Config from "../../src/deepagent/context/config"
import * as TokenMeter from "../../src/deepagent/context/token-meter"
import * as Ledger from "../../src/deepagent/context/ledger"
import * as WorkingSet from "../../src/deepagent/context/working-set"
import * as Curator from "../../src/deepagent/context/curator"
import * as Ingest from "../../src/deepagent/context/ingest"
import * as ConversationLog from "../../src/deepagent/context/conversation-log"
import * as Bridge from "../../src/deepagent/context/bridge"
import * as Orchestrator from "../../src/deepagent/orchestrator"
import * as PromptPolicy from "../../src/deepagent/prompt-policy"
import * as SessionState from "../../src/deepagent/session-state"
import { projectIdForWorkspace } from "../../src/deepagent/durable-knowledge-store"

// V3.8 Appendix-A (Phase 7 附-A) — context-management redesign. These tests lock the audit-critical
// invariants: the HARD 50% working-set ceiling (incl. the pathological over-budget single item), the
// Curator recall going through the REAL GraphQuery / in-ledger keyword scorer (NO embeddings), and
// default-safe degradation when the run store construction throws SYNCHRONOUSLY (Phase-3 D1 lesson).

let base: string
const cfg = Config.DEFAULT_CONTEXT_CONFIG

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-context-"))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  knowledgeSource.invalidateCache()
})

const runStore = (): DocumentStoreT => new DocumentStore(path.join(base, "run"))

describe("token-meter (C5)", () => {
  test("CJK counted ~1 token/char; ASCII ~chars/4", () => {
    expect(TokenMeter.estimate("你好世界")).toBe(4)
    expect(TokenMeter.estimate("abcdefgh")).toBe(2) // 8/4
    expect(TokenMeter.estimate("")).toBe(0)
  })
  test("preferReal wins over estimate when a real total is reported", () => {
    expect(TokenMeter.preferReal({ total: 999 }, "你好")).toBe(999)
    expect(TokenMeter.preferReal(undefined, "你好世界")).toBe(4)
    expect(TokenMeter.preferReal({ input: 10, output: 5 }, "ignored")).toBe(15)
  })
})

describe("working-set 50% HARD ceiling (C1)", () => {
  test("budget = floor(context * fraction), fraction clamped to <= 0.5", () => {
    const clamped = Config.resolveContextConfig({ budgetFraction: 0.9 })
    expect(clamped.budgetFraction).toBe(0.5)
    expect(Config.workingSetBudgetTokens(1000, clamped)).toBe(500)
  })

  test("PATHOLOGICAL: a single item larger than the whole budget is DROPPED to overflow, never emitted", () => {
    // budget = floor(100 * 0.5) = 50. One anchor item priced at 400 tokens (way over budget).
    const ws = WorkingSet.assemble({
      contextTokens: 100,
      config: cfg,
      anchor: [{ id: "a1", kind: "anchor", text: "x", tokens: 400 }],
      nearField: [],
      references: [],
      recall: [],
    })
    expect(ws.budget).toBe(50)
    expect(ws.items).toHaveLength(0) // over-budget anchor NOT admitted
    expect(ws.tokens).toBe(0)
    expect(ws.tokens).toBeLessThanOrEqual(ws.budget) // the invariant
    expect(ws.overflow.map((o) => o.id)).toContain("a1")
  })

  test("mixed priority fill never exceeds the ceiling; overflow captures the remainder", () => {
    // budget = floor(1000 * 0.5) = 500. Anchor 100 + near 100 + ref 100 = 300 admitted; recall 400
    // would push to 700 > 500 so it overflows.
    const ws = WorkingSet.assemble({
      contextTokens: 1000,
      config: cfg,
      anchor: [{ id: "a", kind: "anchor", text: "goal", tokens: 100 }],
      nearField: [{ id: "n", kind: "near_field", text: "turn", tokens: 100 }],
      references: [{ id: "r", kind: "reference", text: "file", tokens: 100 }],
      recall: [{ id: "c", kind: "recall", text: "old", tokens: 400, score: 1 }],
    })
    expect(ws.tokens).toBe(300)
    expect(ws.tokens).toBeLessThanOrEqual(ws.budget)
    expect(ws.items.map((i) => i.id)).toEqual(["a", "n", "r"])
    expect(ws.overflow.map((o) => o.id)).toContain("c")
  })

  test("randomized: result.tokens <= budget for arbitrary inputs (fuzz the ceiling)", () => {
    for (let iter = 0; iter < 200; iter++) {
      const rnd = (n: number) => Math.floor(Math.random() * n)
      const mk = (kind: WorkingSet.WorkingSetItemKind) =>
        Array.from({ length: rnd(6) }, (_, i) => ({
          id: `${kind}${i}`,
          kind,
          text: "t",
          tokens: rnd(2000),
          score: Math.random(),
        }))
      const ctx = 1 + rnd(4000)
      const ws = WorkingSet.assemble({
        contextTokens: ctx,
        config: cfg,
        anchor: mk("anchor"),
        nearField: mk("near_field"),
        references: mk("reference"),
        recall: mk("recall"),
      })
      expect(ws.tokens).toBeLessThanOrEqual(ws.budget)
    }
  })

  test("reasoning is excluded from the working set (C1)", () => {
    const ws = WorkingSet.assemble({
      contextTokens: 1000,
      config: cfg,
      anchor: [],
      nearField: [{ id: "think", kind: "near_field", text: "reasoning", tokens: 10, isReasoning: true }],
      references: [],
      recall: [],
    })
    expect(ws.items).toHaveLength(0)
    expect(ws.overflow).toHaveLength(0) // routed nowhere, not overflow
  })
})

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

describe("curator (C1/C2 Stage 2) — real recall + default-safe", () => {
  const curate = (store: DocumentStoreT | undefined) =>
    Effect.runSync(
      Effect.gen(function* () {
        const svc = yield* Curator.Service
        return yield* svc.curate({
          task: "fix the matmul tiling bug",
          ...(store ? { store } : {}),
          sessionId: "sess",
          contextTokens: 1000,
          nearField: [{ id: "n1", kind: "near_field", text: "latest turn", tokens: 20 }],
        })
      }).pipe(Effect.provide(Curator.defaultLayer)),
    )

  test("recall runs through GraphQuery/in-ledger keyword scorer (NO embeddings) and respects the ceiling", () => {
    // Seed a run-scoped ledger. GraphQuery only unions durable stores (unconfigured here) so the
    // Curator's documented fallback scores the loaded ledger with knowledgeSimilarity (same primitive
    // GraphQuery uses — overlap coefficient, no vectors).
    const store = runStore()
    let l = Ledger.emptyLedger("sess", 1)
    l = Ledger.applyUpdate(l, { append: [
      { kind: "goal", text: "ship the matmul tiling optimization", id: "g1" },
      { kind: "decision", text: "matmul tiling uses 64x64 blocks", id: "d1" },
      { kind: "decision", text: "unrelated logging format choice", id: "d2" },
    ] }, 2)
    Ledger.persistLedger(store, l)

    const ws = curate(store)
    expect(ws).toBeDefined()
    expect(ws!.tokens).toBeLessThanOrEqual(ws!.budget) // ceiling holds
    const anchorIds = ws!.items.filter((i) => i.kind === "anchor").map((i) => i.id)
    expect(anchorIds).toContain("g1") // active goal is the never-drop anchor
    // The tiling-related decision is recalled by keyword similarity; the unrelated one scores 0.
    const recallIds = ws!.items.filter((i) => i.kind === "recall").map((i) => i.id)
    expect(recallIds).toContain("d1")
    expect(recallIds).not.toContain("d2")
  })

  test("unknown context window (contextTokens <= 0) -> undefined (caller falls back)", () => {
    const ws = Effect.runSync(
      Effect.gen(function* () {
        const svc = yield* Curator.Service
        return yield* svc.curate({ task: "t", sessionId: "s", contextTokens: 0, nearField: [] })
      }).pipe(Effect.provide(Curator.defaultLayer)),
    )
    expect(ws).toBeUndefined()
  })

  test("DEFAULT-SAFE: a store that throws SYNCHRONOUSLY degrades to undefined, never crashes the loop", () => {
    // Phase-3 D1: DocumentStore.list/get throw synchronously on a corrupt store. Effect.catch would
    // miss the defect; matchCauseEffect recovers it. Simulate with a store whose reads throw.
    const throwing = {
      list: () => {
        throw new Error("corrupt store: JSON.parse failed")
      },
      get: () => {
        throw new Error("corrupt store")
      },
    } as unknown as DocumentStoreT
    let ws: WorkingSet.WorkingSet | undefined
    expect(() => {
      ws = curate(throwing)
    }).not.toThrow()
    expect(ws).toBeUndefined()
  })

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

describe("chunked ingest (C1.5)", () => {
  test("chunkByStructure splits by heading and stays under the token target; offsets re-read", () => {
    const text = "# A\n" + "alpha ".repeat(50) + "\n# B\n" + "beta ".repeat(50) + "\n"
    const chunks = Ingest.chunkByStructure(text, 40)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) {
      // re-read by position reference returns the original slice
      expect(Ingest.rereadChunk(text, c)).toBe(text.slice(c.startOffset, c.endOffset))
    }
  })

  test("map-reduce ingest lands a retrievable memory doc with position refs", () => {
    const store = runStore()
    const text = "# One\n" + "foo ".repeat(30) + "\n# Two\n" + "bar ".repeat(30) + "\n"
    const res = Ingest.ingest({
      sourceName: "book.md",
      text,
      config: Config.resolveContextConfig({ ingestChunkTokens: 20 }), // tiny target -> multiple chunks
      summarize: (c) => `sum:${c.heading}`,
      store,
    })
    expect(res.chunkSummaries.length).toBeGreaterThanOrEqual(2)
    expect(res.memoryDocId).toBeDefined()
    const doc = store.get(res.memoryDocId!)
    expect(doc?.type).toBe("memory")
  })

  test("LLM summarizer adapter: ingestEffect pre-summarizes each chunk via the injected LLM client", async () => {
    const store = runStore()
    const text = "# One\n" + "foo ".repeat(30) + "\n# Two\n" + "bar ".repeat(30) + "\n"

    // Mock the LLM client: capture the prompts and return a canned summary per chunk. This asserts the
    // adapter actually calls the LLM (map step) and folds the results through the pure ingest pipeline.
    const prompts: string[] = []
    const mockClient = LLMClient.Service.of({
      prepare: (() => Effect.die("prepare not used in this test")) as never,
      stream: (() => {
        throw new Error("stream not used in this test")
      }) as never,
      generate: ((request: { messages: readonly { content: readonly { type: string; text?: string }[] }[] }) => {
        const prompt = request.messages
          .flatMap((m) => m.content)
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("")
        prompts.push(prompt)
        return Effect.succeed(
          new LLMResponse({
            events: [LLMEvent.textDelta({ id: "text-0", text: `LLM:${prompts.length}` })],
          }),
        )
      }) as never,
    })

    const res = await Effect.runPromise(
      Ingest.ingestEffect({
        sourceName: "book.md",
        text,
        config: Config.resolveContextConfig({ ingestChunkTokens: 20 }),
        summarizer: {
          // A schema-valid Model instance; the mock generate never touches the route.
          model: Model.make({ id: "test-model", provider: "test", route: { id: "test-route" } as never }),
          concurrency: 1,
        },
        store,
      }).pipe(Effect.provideService(LLMClient.Service, mockClient)),
    )

    // Every chunk was summarized through the LLM (one generate call per chunk).
    expect(prompts.length).toBe(res.chunkSummaries.length)
    expect(prompts.length).toBeGreaterThanOrEqual(2)
    // The LLM output flowed into the chunk summaries (not the test stub).
    expect(res.chunkSummaries.every((s) => s.summary.startsWith("LLM:"))).toBe(true)
    // And landed as a retrievable memory doc.
    expect(res.memoryDocId).toBeDefined()
    expect(store.get(res.memoryDocId!)?.type).toBe("memory")
  })
})
