import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AgentContext } from "../src/im/agent-executor"
import { AgentContextBuilderService } from "../src/im/agent-executor"
import { AgentContextBuilderLive } from "../src/im/context-builder"
import { IMRepository, type IMRepositoryInterface, type MessagePage } from "../src/im/repository"
import * as knowledgeSource from "../src/deepagent/knowledge-source"
import { openProjectStore } from "../src/deepagent/durable-knowledge-store"
import type { CreateDocInput, DocType, Provenance } from "../src/deepagent/document-store"
import { Schema } from "effect"

// V3.8 Phase 3 (roadmap C4, v3.8.1 §B.4): the context-builder now issues ONE UnifiedContextGraph
// query. These tests prove: the AgentContext shape is preserved, the conversation logic is intact,
// the code/documents buckets (dead pre-Phase-3) now return real hits, and degradation to empty
// buckets (unconfigured graph) never throws.

const prov: Provenance = { source: "runner", run_ref: "run:t", evidence_refs: [] }

let base: string
const WORK = "/work/repo-ctxbuilder"

const node = (store: ReturnType<typeof openProjectStore>, type: DocType, description: string, over: Partial<CreateDocInput> = {}) =>
  store.documentStore.create({
    type,
    scope: "durable",
    body: over.body ?? description,
    description,
    domain: over.domain ?? null,
    tags: over.tags ?? [],
    links: over.links ?? [],
    provenance: prov,
    ...(over.confidence ? { confidence: over.confidence } : {}),
    ...(over.idSlug ? { idSlug: over.idSlug } : {}),
  }).id

// Fake repo returning a fixed page of messages; only listMessages is exercised by build().
const makeRepo = (messages: MessagePage["messages"]): IMRepositoryInterface =>
  ({
    listMessages: () => Effect.succeed({ messages, nextCursor: null, hasMore: false } as MessagePage),
  }) as unknown as IMRepositoryInterface

const buildWith = (repo: IMRepositoryInterface, input: { workspaceID: string; groupID: string; task: string }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const builder = yield* AgentContextBuilderService
      return yield* builder.build({ workspaceID: input.workspaceID, groupID: input.groupID, messageID: "m1", task: input.task })
    }).pipe(Effect.provide(AgentContextBuilderLive.pipe(Layer.provide(Layer.succeed(IMRepository, repo))))),
  )

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-ctxbuilder-"))
})
afterEach(() => {
  knowledgeSource.invalidateCache()
  rmSync(base, { recursive: true, force: true })
})

describe("AgentContextBuilder (Phase 3 — single UnifiedContextGraph query)", () => {
  it("returns a valid AgentContext shape", async () => {
    knowledgeSource.configure(base)
    const ctx = await buildWith(makeRepo([]), { workspaceID: WORK, groupID: "g1", task: "anything" })
    // Structurally validates against the AgentContext schema (V3.8-compatible shape).
    expect(() => Schema.decodeUnknownSync(AgentContext)(ctx)).not.toThrow()
    expect(ctx.conversation.groupID).toBe("g1")
    expect(Array.isArray(ctx.knowledge)).toBe(true)
    expect(Array.isArray(ctx.code)).toBe(true)
    expect(Array.isArray(ctx.documents)).toBe(true)
  })

  it("preserves conversation logic (recent messages sorted oldest-first)", async () => {
    knowledgeSource.configure(base)
    const now = Date.now()
    const mk = (id: string, createdAt: number) => ({
      id,
      groupID: "g1",
      senderID: "u1",
      senderType: "user",
      type: "text",
      content: `msg ${id}`,
      mentions: [],
      metadata: null,
      replyToID: null,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    })
    const ctx = await buildWith(makeRepo([mk("b", now + 100), mk("a", now)]), {
      workspaceID: WORK,
      groupID: "g1",
      task: "hi",
    })
    expect(ctx.conversation.recentMessages.map((m) => m.id)).toEqual(["a", "b"])
    expect(ctx.conversation.recentMessages[0]!.content).toBe("msg a")
  })

  it("fills code + documents buckets (dead pre-Phase-3) via the unified graph", async () => {
    knowledgeSource.configure(base)
    const proj = openProjectStore(base, WORK)
    const designId = node(proj, "design", "payment retry design shared token")
    const codeId = node(proj, "code_symbol", "payment retry shared token implementation")
    knowledgeSource.invalidateCache() // force re-read of the just-written nodes

    const ctx = await buildWith(makeRepo([]), { workspaceID: WORK, groupID: "g1", task: "payment retry shared token" })
    expect(ctx.documents.map((d) => d.id)).toContain(designId)
    expect((ctx.code ?? []).map((c) => c.id)).toContain(codeId)
  })

  it("routes knowledge and memory to distinct buckets (memory not folded into knowledge)", async () => {
    knowledgeSource.configure(base)
    const proj = openProjectStore(base, WORK)
    const kId = node(proj, "knowledge", "caching heuristics shared phrase", {
      confidence: { evidence_strength: "medium", support_count: 2 },
    })
    const memId = node(proj, "memory", "caching heuristics shared phrase remembered", {
      confidence: { evidence_strength: "weak", support_count: 1 },
    })
    knowledgeSource.invalidateCache()

    const ctx = await buildWith(makeRepo([]), { workspaceID: WORK, groupID: "g1", task: "caching heuristics shared phrase" })
    expect(ctx.knowledge.map((k) => k.id)).toContain(kId)
    expect(ctx.memory.map((m) => m.id)).toContain(memId)
    expect(ctx.knowledge.map((k) => k.id)).not.toContain(memId)
  })

  it("degrades to empty buckets without throwing when the graph is empty/unconfigured", async () => {
    // Fresh base with no nodes → GraphQuery returns empty buckets (the degradation path). Deterministic
    // regardless of cross-test knowledge-source singleton state, and proves build() never throws.
    knowledgeSource.configure(base)
    knowledgeSource.invalidateCache()
    const ctx = await buildWith(makeRepo([]), { workspaceID: WORK, groupID: "g1", task: "anything at all" })
    expect(ctx.knowledge).toEqual([])
    expect(ctx.memory).toEqual([])
    expect(ctx.documents).toEqual([])
    expect(ctx.code).toEqual([])
    // conversation still produced
    expect(ctx.conversation.groupID).toBe("g1")
  })
})
