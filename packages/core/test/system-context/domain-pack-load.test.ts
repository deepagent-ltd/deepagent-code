import { beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { DurableKnowledgeStore } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { Tool } from "@deepagent-code/core/tool/tool"
import {
  makeDomainPackLoadTool,
  resetDomainPackLoadState,
  type DomainPackLoadOutput,
} from "@deepagent-code/core/system-context/domain-pack-load-tool"
import { tmpRoot } from "../fixture/tmpdir"

// P2-a (WS3 chain repair, design §4.5): the production `domain_pack_load` tool against a REAL
// tmp-root DurableKnowledgeStore (no mocks) — active-doc body loads with the ~600 token bound, the
// per-turn budget of 2 NEW documents as a ToolFailure, session-scoped already_loaded dedupe, and
// typed not_found states for candidate/unknown refs and an unavailable store.

const SESSION = SessionV2.ID.make("ses_domain_pack_load")
const AGENT = AgentV2.ID.make("build")

const toolContext = (callID: string, turn = "turn-1"): Tool.Context => ({
  sessionID: SESSION,
  agent: AGENT,
  assistantMessageID: SessionMessage.ID.make(`msg_domain_pack_load_${turn}`),
  toolCallID: callID,
})

const seedDoc = (
  store: DurableKnowledgeStore,
  slug: string,
  description: string,
  body: string,
  pack = "hardware.power",
) =>
  store.seedActive({
    type: "strategy",
    description,
    body,
    domain: "power_design",
    tags: [`scope:${pack}:strategies`, `provenance:domain_pack:${pack}`, `pack:${pack}`],
    packId: pack,
    scope: "user-global",
    sensitivity: "public",
    risk: "low",
    confidence: { evidence_strength: "strong", support_count: 3 },
    provenance: { source: "human", run_ref: null, evidence_refs: [] },
    idSlug: slug,
  })

const settle = (tool: Tool.AnyTool, ref: string, callID: string, turn?: string) =>
  Tool.settle(tool, { type: "tool-call", id: callID, name: "domain_pack_load", input: { ref } }, toolContext(callID, turn))

const structured = (settlement: { structured: unknown }): DomainPackLoadOutput =>
  settlement.structured as DomainPackLoadOutput

beforeEach(() => resetDomainPackLoadState())

describe("domain_pack_load", () => {
  test("loads the body of an active seeded pack document", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const doc = seedDoc(store, "apply-clock-gating", "Gate clocks to idle registers.", "Insert a glitch-free ICG cell.")
        const tool = makeDomainPackLoadTool({ store: () => store })
        const out = structured(yield* settle(tool, doc.id, "call-load-1"))
        expect(out.state).toBe("loaded")
        expect(out.ref).toBe(doc.id)
        expect(out.pack).toBe("hardware.power")
        expect(out.name).toBe("apply-clock-gating")
        expect(out.type).toBe("strategy")
        expect(out.summary).toBe("Gate clocks to idle registers.")
        expect(out.body).toBe("Insert a glitch-free ICG cell.")
        expect(out.truncated).toBe(false)
        expect(out.total_chars).toBe("Insert a glitch-free ICG cell.".length)
      }),
    ))

  test("bounds the body to ~600 tokens with a truncation marker", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const body = "x".repeat(3000) // 750 tokens by the 4 chars/token estimate
        const doc = seedDoc(store, "long-body", "A very long document body.", body)
        const tool = makeDomainPackLoadTool({ store: () => store })
        const settlement = yield* settle(tool, doc.id, "call-load-long")
        const out = structured(settlement)
        expect(out.state).toBe("loaded")
        expect(out.truncated).toBe(true)
        expect(out.total_chars).toBe(3000)
        expect(out.token_count).toBeLessThanOrEqual(620)
        const text = settlement.content.map((part) => (part.type === "text" ? part.text : "")).join("")
        expect(text).toContain("(truncated, 3000 chars total)")
      }),
    ))

  test("the 3rd new load in one turn fails with the load-budget ToolFailure", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const a = seedDoc(store, "doc-a", "Document A.", "body a")
        const b = seedDoc(store, "doc-b", "Document B.", "body b")
        const c = seedDoc(store, "doc-c", "Document C.", "body c")
        const tool = makeDomainPackLoadTool({ store: () => store })
        expect(structured(yield* settle(tool, a.id, "call-a")).state).toBe("loaded")
        expect(structured(yield* settle(tool, b.id, "call-b")).state).toBe("loaded")
        const failure = yield* settle(tool, c.id, "call-c").pipe(Effect.flip)
        expect(failure.message).toContain("load budget exhausted for this turn")
      }),
    ))

  test("an already-loaded document re-loads in a later turn without consuming the turn budget", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const a = seedDoc(store, "doc-a", "Document A.", "body a")
        const b = seedDoc(store, "doc-b", "Document B.", "body b")
        const c = seedDoc(store, "doc-c", "Document C.", "body c")
        const d = seedDoc(store, "doc-d", "Document D.", "body d")
        const e = seedDoc(store, "doc-e", "Document E.", "body e")
        const tool = makeDomainPackLoadTool({ store: () => store })
        expect(structured(yield* settle(tool, a.id, "call-t1-a", "turn-1")).state).toBe("loaded")
        expect(structured(yield* settle(tool, b.id, "call-t1-b", "turn-1")).state).toBe("loaded")
        // turn 2: the retry of A is session-deduped (already_loaded, uncharged), so two NEW loads
        // still fit the turn budget and only the 3rd new one trips it.
        const retry = structured(yield* settle(tool, a.id, "call-t2-a", "turn-2"))
        expect(retry.state).toBe("already_loaded")
        expect(retry.body).toBe("body a")
        expect(structured(yield* settle(tool, c.id, "call-t2-c", "turn-2")).state).toBe("loaded")
        expect(structured(yield* settle(tool, d.id, "call-t2-d", "turn-2")).state).toBe("loaded")
        const failure = yield* settle(tool, e.id, "call-t2-e", "turn-2").pipe(Effect.flip)
        expect(failure.message).toContain("load budget exhausted for this turn")
      }),
    ))

  test("a candidate document settles as the typed not_found(not_active) state", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const candidate = store.stageCandidate({
          type: "strategy",
          description: "A learned candidate not yet approved.",
          body: "candidate body",
          domain: "power_design",
          tags: ["pack:hardware.power"],
          packId: "hardware.power",
          scope: "user-global",
          sensitivity: "public",
          risk: "low",
          confidence: { evidence_strength: "weak", support_count: 1 },
          provenance: { source: "runner", run_ref: null, evidence_refs: [] },
          idSlug: "candidate-doc",
        })
        expect(candidate.status).toBe("candidate")
        const tool = makeDomainPackLoadTool({ store: () => store })
        const out = structured(yield* settle(tool, candidate.id, "call-candidate"))
        expect(out.state).toBe("not_found")
        expect(out.reason).toBe("domain_pack_document_not_active")
        expect(out.body).toBeUndefined()
      }),
    ))

  test("an unknown ref (or a non-pack document) settles as the typed not_found(unknown) state", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const learned = store.seedActive({
          type: "knowledge",
          description: "User-learned knowledge, not part of a pack.",
          body: "learned body",
          domain: null,
          scope: "user-global",
          sensitivity: "public",
          risk: "low",
          confidence: { evidence_strength: "medium", support_count: 1 },
          provenance: { source: "runner", run_ref: null, evidence_refs: [] },
          idSlug: "learned-doc",
        })
        const tool = makeDomainPackLoadTool({ store: () => store })
        const missing = structured(yield* settle(tool, "doc:strategy:power_design:no-such-doc", "call-missing"))
        expect(missing.state).toBe("not_found")
        expect(missing.reason).toBe("domain_pack_document_unknown")
        const nonPack = structured(yield* settle(tool, learned.id, "call-non-pack"))
        expect(nonPack.state).toBe("not_found")
        expect(nonPack.reason).toBe("domain_pack_document_unknown")
      }),
    ))

  test("an unavailable store settles as the typed not_found(store_unavailable) state", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tool = makeDomainPackLoadTool({ store: () => null })
        const out = structured(yield* settle(tool, "doc:strategy:power_design:anything", "call-no-store"))
        expect(out.state).toBe("not_found")
        expect(out.reason).toBe("domain_pack_store_unavailable")
      }),
    ))
})
