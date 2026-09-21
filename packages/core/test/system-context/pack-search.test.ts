import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { DurableKnowledgeStore, openUserGlobalStore } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { seedCoreKnowledgeAt } from "@deepagent-code/core/deepagent/knowledge-seed"
import { Tool } from "@deepagent-code/core/tool/tool"
import {
  makeDomainPackLoadTool,
  type DomainPackLoadOutput,
} from "@deepagent-code/core/system-context/domain-pack-load-tool"
import {
  makePackSearchTool,
  PackSearchBudget,
  type PackSearchOutput,
} from "@deepagent-code/core/system-context/pack-search-tool"
import { tmpRoot } from "../fixture/tmpdir"

// P2-a (WS3 chain repair, design §4.5): the sibling `pack_search` L1 surface against a REAL
// tmp-root DurableKnowledgeStore (no mocks) — seeded active pack documents surface as cards whose
// refs point at `domain_pack_load`, results stay bounded (5 cards, ~200 tokens rendered), and an
// unavailable store degrades to an empty result.

const toolContext = (callID: string): Tool.Context => ({
  sessionID: SessionV2.ID.make("ses_pack_search"),
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_pack_search"),
  toolCallID: callID,
})

const seedDoc = (
  store: DurableKnowledgeStore,
  slug: string,
  description: string,
  pack = "hardware.power",
) =>
  store.seedActive({
    type: "strategy",
    description,
    body: `body of ${slug}`,
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

const search = (tool: Tool.AnyTool, input: { query: string; pack?: string }, callID: string) =>
  Tool.settle(tool, { type: "tool-call", id: callID, name: "pack_search", input }, toolContext(callID))

const structured = (settlement: { structured: unknown }): PackSearchOutput =>
  settlement.structured as PackSearchOutput

const settleLoad = (tool: Tool.AnyTool, ref: string, callID: string) =>
  Tool.settle(tool, { type: "tool-call", id: callID, name: "domain_pack_load", input: { ref } }, toolContext(callID))

const loadStructured = (settlement: { structured: unknown }): DomainPackLoadOutput =>
  settlement.structured as DomainPackLoadOutput

const textOf = (settlement: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  settlement.content.map((part) => (part.type === "text" ? part.text : "")).join("")

describe("pack_search", () => {
  test("surfaces a seeded pack document card pointing at domain_pack_load", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const doc = seedDoc(store, "apply-clock-gating", "Gate clocks to idle registers so they stop toggling.")
        seedDoc(store, "partition-voltage-domains", "Group logic by voltage domain to scale supply.")
        const tool = makePackSearchTool({ store: () => store })
        const settlement = yield* search(tool, { query: "clock gating" }, "call-search-1")
        const out = structured(settlement)
        expect(out.count).toBe(1)
        const entry = out.entries[0]!
        expect(entry.ref).toBe(doc.id)
        expect(entry.pack).toBe("hardware.power")
        expect(entry.name).toBe("apply-clock-gating")
        expect(entry.type).toBe("strategy")
        expect(entry.summary).toContain("Gate clocks")
        // The card never carries a body, and the rendered text routes the model to the load tool.
        expect(JSON.stringify(settlement.structured)).not.toContain("body of apply-clock-gating")
        const text = textOf(settlement)
        expect(text).toContain(`domain_pack_load({ ref: "${doc.id}" })`)
      }),
    ))

  test("returns an empty result when nothing matches", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        seedDoc(store, "apply-clock-gating", "Gate clocks to idle registers.")
        const tool = makePackSearchTool({ store: () => store })
        const settlement = yield* search(tool, { query: "nonexistentterm" }, "call-search-empty")
        expect(structured(settlement).count).toBe(0)
        expect(textOf(settlement)).toBe("No matching domain pack documents for this request.")
      }),
    ))

  test("narrows results to one pack when the pack filter is given", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        seedDoc(store, "apply-clock-gating", "Shared gating guidance from hardware.")
        seedDoc(store, "merchant-gating-rules", "Shared gating guidance from commerce.", "business.ecommerce")
        const tool = makePackSearchTool({ store: () => store })
        const out = structured(yield* search(tool, { query: "gating", pack: "business.ecommerce" }, "call-search-pack"))
        expect(out.count).toBe(1)
        expect(out.entries[0]!.pack).toBe("business.ecommerce")
        expect(out.entries[0]!.name).toBe("merchant-gating-rules")
      }),
    ))

  test("bounds results to 5 cards in deterministic order", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        for (const slug of ["doc-g", "doc-b", "doc-e", "doc-a", "doc-f", "doc-c", "doc-d"])
          seedDoc(store, slug, `Shared term guidance for ${slug}.`)
        const tool = makePackSearchTool({ store: () => store })
        const out = structured(yield* search(tool, { query: "shared" }, "call-search-bound"))
        expect(out.count).toBe(PackSearchBudget.maxEntries)
        const refs = out.entries.map((entry) => entry.ref)
        expect(refs).toEqual([...refs].sort((a, b) => a.localeCompare(b)))
      }),
    ))

  test("renders within the ~200 token budget even with long summaries", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        for (const slug of ["doc-a", "doc-b", "doc-c", "doc-d", "doc-e"])
          seedDoc(store, slug, `Shared term guidance for ${slug}. ${"verbose detail ".repeat(12)}`)
        const tool = makePackSearchTool({ store: () => store })
        const settlement = yield* search(tool, { query: "shared" }, "call-search-render")
        const text = textOf(settlement)
        expect(structured(settlement).count).toBe(PackSearchBudget.maxEntries)
        expect(text).toContain("(truncated,")
        expect(text.length).toBeLessThanOrEqual(PackSearchBudget.renderMaxChars + 60)
      }),
    ))

  test("an unavailable store degrades to an empty result", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tool = makePackSearchTool({ store: () => null })
        const out = structured(yield* search(tool, { query: "anything" }, "call-search-no-store"))
        expect(out.count).toBe(0)
      }),
    ))
})

describe("pack_search + domain_pack_load over the real seeded corpus", () => {
  test("the L1 -> L2 chain walks from a search card to a real pack document body", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // The real boot path: knowledge-seed.ts scans packages/domain-packs/ into the user-global
        // store; the tools read a second store instance over the same root (the production
        // seeder/reader split), never a fixture copy.
        const baseDir = tmpRoot()
        const report = seedCoreKnowledgeAt(baseDir)
        expect(report.total).toBeGreaterThan(0)
        const store = openUserGlobalStore(baseDir)
        const searchTool = makePackSearchTool({ store: () => store })
        const loadTool = makeDomainPackLoadTool({ store: () => store })
        const found = structured(yield* search(searchTool, { query: "clock gating" }, "call-real-search"))
        expect(found.count).toBeGreaterThan(0)
        const entry = found.entries.find((candidate) => candidate.name.includes("apply-clock-gating"))
        expect(entry).toBeDefined()
        expect(entry!.pack).toBe("hardware.power")
        const loaded = loadStructured(yield* settleLoad(loadTool, entry!.ref, "call-real-load"))
        expect(loaded.state).toBe("loaded")
        expect(loaded.summary).toBe(entry!.summary)
        expect(loaded.body).toContain("clock")
        expect(loaded.token_count).toBeLessThanOrEqual(620)
      }),
    ))
})
