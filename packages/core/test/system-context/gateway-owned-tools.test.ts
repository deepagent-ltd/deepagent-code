import { expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { AgentGateway, DeepAgentKnowledgeSource } from "@deepagent-code/core/agent-gateway"
import { AgentV2 } from "@deepagent-code/core/agent"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Tool } from "@deepagent-code/core/tool/tool"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { quotaLayer, seedQuotaSession } from "../fixture/tool-quota"

import { PackSearchTool } from "../../src/system-context/pack-search-tool"
import { DomainPackLoadTool } from "../../src/system-context/domain-pack-load-tool"
import { KnowledgeProposeTool } from "../../src/tool/knowledge-propose"

const callContext = (sid: SessionV2.ID, id: string): Tool.Context => ({
  sessionID: sid,
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make(`msg_${id}`),
  toolCallID: id,
})
const settle = (tool: Tool.AnyTool, sid: SessionV2.ID, name: string, id: string, input: unknown) =>
  Tool.settle(tool, { type: "tool-call", name, id, input }, callContext(sid, id))
const row = (value: unknown) => Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value)
const registered = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const materialized = yield* registry.materialize()
  const tool = (name: string) => {
    const entry = ToolRegistry.inspect(materialized, name)
    if (!entry) throw new Error(`missing original registered tool ${name}`)
    return entry.tool
  }
  return tool
})

test("production tool layers keep their exact immutable Gateway stores outside ALS across two roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dac205-tools-layer-"))
  DeepAgentKnowledgeSource.reset()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const outputs = yield* Effect.forEach(["a", "b"], (key) =>
          Effect.gen(function* () {
            const baseDir = path.join(root, key)
            const workspace = path.join(baseDir, "workspace")
            const context = yield* Layer.build(
              Layer.mergeAll(
                AgentGateway.runtimeLayer({ enabled: true, agentMode: "general", durableLearning: false, baseDir }),
                ToolRegistry.defaultLayer,
                quotaLayer(path.join(baseDir, "test.sqlite")),
              ),
            )
            const gateway = Context.get(context, AgentGateway.Runtime)
            const sid = SessionV2.ID.make(`ses_tools_layer_${key}`)
            yield* seedQuotaSession(sid, workspace).pipe(Effect.provide(Layer.succeedContext(context)))
            const stores = gateway.withStorage(() => DeepAgentKnowledgeSource.storesForWorkspace(workspace))
            const doc = stores[0]!.seedActive({
              type: "strategy",
              scope: "user-global",
              idSlug: `owned-pack-${key}`,
              description: `SCOPEDTOOLS${key} practical guidance`,
              body: `Synthetic current root ${key} domain manual.`,
              domain: "scope-audit",
              tags: ["pack:scope.audit"],
              packId: "scope.audit",
              sensitivity: "public",
              risk: "low",
              confidence: { evidence_strength: "strong", support_count: 1 },
              provenance: { source: "human", evidence_refs: [] },
            })
            yield* Layer.build(
              Layer.mergeAll(PackSearchTool.layer, DomainPackLoadTool.layer, KnowledgeProposeTool.layer).pipe(
                Layer.provide(Layer.succeedContext(context)),
              ),
            )
            const tool = yield* registered.pipe(Effect.provide(Layer.succeedContext(context)))
            const search = yield* settle(tool("pack_search"), sid, "pack_search", `search_${key}`, {
              query: `SCOPEDTOOLS${key}`,
              pack: "scope.audit",
            }).pipe(Effect.provide(Layer.succeedContext(context)))
            const load = yield* settle(tool("domain_pack_load"), sid, "domain_pack_load", `load_${key}`, {
              ref: doc.id,
            }).pipe(Effect.provide(Layer.succeedContext(context)))
            const proposal = yield* settle(tool("knowledge_propose"), sid, "knowledge_propose", `proposal_${key}`, {
              type: "memory",
              description: `Synthetic workspace convention ${key}`,
              body: `Keep fixture root ${key} review candidates isolated.`,
              scope: "project",
            }).pipe(Effect.provide(Layer.succeedContext(context)))
            expect(row(search.structured).count).toBe(1)
            expect(row(load.structured).state).toBe("loaded")
            expect(row(load.structured).body).toBe(`Synthetic current root ${key} domain manual.`)
            expect(row(proposal.structured).scope).toBe("project")
            const id = row(proposal.structured).candidate_id
            expect(typeof id).toBe("string")
            if (typeof id !== "string") throw new Error("candidate id missing")
            const candidate = stores[1]!.documentStore.get(id)
            expect(candidate?.status).toBe("candidate")
            expect(candidate?.extensions?.project_id).toBe(projectIdForWorkspace(workspace))
            expect(stores[0]!.documentStore.get(id)).toBeNull()
            return { stores, id, body: candidate?.body }
          }),
        )
        expect(outputs[0]!.stores[1]!.documentStore.get(outputs[1]!.id)).toBeNull()
        expect(outputs[1]!.stores[1]!.documentStore.get(outputs[0]!.id)).toBeNull()
      }).pipe(Effect.scoped),
    )
  } finally {
    DeepAgentKnowledgeSource.reset()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("layers without a Gateway stay unavailable and never stage into a legacy global store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dac205-tools-no-gateway-"))
  DeepAgentKnowledgeSource.configure(root)
  try {
    const store = DeepAgentKnowledgeSource.userGlobalStoreFor()
    const doc = store.seedActive({
      type: "strategy",
      scope: "user-global",
      idSlug: "legacy-decoy",
      description: "LEGACYDECOY guidance",
      body: "Synthetic legacy decoy.",
      domain: null,
      tags: ["pack:scope.audit"],
      packId: "scope.audit",
      sensitivity: "public",
      risk: "low",
      confidence: { evidence_strength: "strong", support_count: 1 },
      provenance: { source: "human", evidence_refs: [] },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(ToolRegistry.defaultLayer)
        yield* Layer.build(
          Layer.mergeAll(PackSearchTool.layer, DomainPackLoadTool.layer, KnowledgeProposeTool.layer).pipe(
            Layer.provide(Layer.succeedContext(context)),
          ),
        )
        const tool = yield* registered.pipe(Effect.provide(Layer.succeedContext(context)))
        const sid = SessionV2.ID.make("ses_no_gateway")
        const search = yield* settle(tool("pack_search"), sid, "pack_search", "nogw_search", { query: "LEGACYDECOY" })
        const load = yield* settle(tool("domain_pack_load"), sid, "domain_pack_load", "nogw_load", { ref: doc.id })
        const proposal = yield* settle(tool("knowledge_propose"), sid, "knowledge_propose", "nogw_proposal", {
          type: "memory",
          description: "Synthetic no Gateway",
          body: "This fixture proposal must not stage anywhere.",
          scope: "global",
        }).pipe(Effect.result)
        expect(row(search.structured).count).toBe(0)
        expect(row(load.structured).reason).toBe("domain_pack_store_unavailable")
        expect(proposal._tag).toBe("Failure")
        expect(store.documentStore.list().filter((d) => d.status === "candidate")).toHaveLength(0)
        const compatibility = yield* settle(PackSearchTool.makePackSearchTool(), sid, "pack_search", "factory_compat", {
          query: "LEGACYDECOY",
        })
        expect(row(compatibility.structured).count).toBe(1)
      }).pipe(Effect.scoped),
    )
  } finally {
    DeepAgentKnowledgeSource.reset()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
