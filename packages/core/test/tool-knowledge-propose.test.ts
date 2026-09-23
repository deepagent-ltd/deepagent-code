import { beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import {
  DurableKnowledgeStore,
  projectIdForWorkspace,
} from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { KnowledgeProposeTool } from "@deepagent-code/core/tool/knowledge-propose"
import { Tool } from "@deepagent-code/core/tool/tool"
import { tmpRoot } from "./fixture/tmpdir"

// P3-b (WS7/B6, design §8.1): knowledge_propose against a REAL tmp-root DurableKnowledgeStore (no
// mocks) — a proposal stages as a review candidate that retrieval cannot see, the sensitivity scrub
// and the per-session budget fail closed, the store's dedup-merge folds repeats, and both scopes
// resolve (global direct; project through the session row's directory).

const SESSION = SessionV2.ID.make("ses_knowledge_propose")
const AGENT = AgentV2.ID.make("build")

const toolContext = (callID: string): Tool.Context => ({
  sessionID: SESSION,
  agent: AGENT,
  assistantMessageID: SessionMessage.ID.make("msg_knowledge_propose"),
  toolCallID: callID,
})

const settle = (tool: Tool.AnyTool, input: unknown, callID: string) =>
  Tool.settle(tool, { type: "tool-call", id: callID, name: KnowledgeProposeTool.name, input }, toolContext(callID))

type ProposeOutput = {
  candidate_id: string
  status: "pending_review" | "already_active"
  scope: "project" | "global"
  output: string
}

const structured = (settlement: { structured: unknown }): ProposeOutput => settlement.structured as ProposeOutput

beforeEach(() => KnowledgeProposeTool.resetKnowledgeProposeState())

describe("knowledge_propose (WS7)", () => {
  test("stages a global-scope proposal as a review candidate that retrieval cannot see", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const tool = KnowledgeProposeTool.makeKnowledgeProposeTool({ globalStore: () => store })

        const settlement = yield* settle(
          tool,
          {
            type: "memory",
            description: "Staging deploys freeze every Friday afternoon.",
            body: "The staging environment is frozen every Friday after 14:00; schedule deploys around it.",
            tags: ["deploy"],
            scope: "global",
          },
          "call-kp-global",
        )
        const out = structured(settlement)
        expect(out.status).toBe("pending_review")
        expect(out.scope).toBe("global")

        // Present in the human review queue...
        expect(store.listByStatus("candidate").map((ref) => ref.id)).toContain(out.candidate_id)
        // ...but invisible to retrieval (the whitelist only serves active docs).
        expect(store.retrieve({ types: ["memory"], keywords: ["staging", "deploys"] })).toHaveLength(0)

        const doc = store.documentStore.get(out.candidate_id)
        expect(doc?.status).toBe("candidate")
        expect(doc?.scope).toBe("durable")
        expect(doc?.confidence).toMatchObject({ evidence_strength: "weak", support_count: 1 })
        expect(doc?.provenance.source).toBe("model")
        expect(String(doc?.provenance.run_ref)).toContain(SESSION)
        expect(String(doc?.provenance.run_ref)).toContain("msg_knowledge_propose")
        // memory → low risk; risk/sensitivity travel as tags + extensions.
        expect(doc?.tags).toContain("risk:low")
        expect(doc?.tags).toContain("sensitivity:public")
        expect(doc?.tags).toContain("deploy")
      }),
    ))

  test("stages a project-scope proposal into the project-shared store resolved from the session row", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const directory = tmpRoot()
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        let resolvedPath: string | undefined
        const tool = KnowledgeProposeTool.makeKnowledgeProposeTool({
          projectStore: (workspacePath) => {
            resolvedPath = workspacePath
            return store
          },
        })

        const database = yield* Database.Service
        yield* database.db
          .insert(ProjectTable)
          .values({
            id: Project.ID.global,
            worktree: AbsolutePath.make(directory),
            sandboxes: [],
            time_created: 1,
            time_updated: 1,
          })
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionTable)
          .values({
            id: SESSION,
            project_id: Project.ID.global,
            slug: SESSION,
            directory,
            title: "knowledge propose",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        // No scope input → default project.
        const settlement = yield* settle(
          tool,
          {
            type: "knowledge",
            description: "Integration tests run against a disposable postgres container.",
            body: "Always start the disposable postgres container before running the integration suite.",
          },
          "call-kp-project",
        )
        const out = structured(settlement)
        expect(out.status).toBe("pending_review")
        expect(out.scope).toBe("project")
        expect(resolvedPath).toBe(directory)

        const doc = store.documentStore.get(out.candidate_id)
        expect(doc?.status).toBe("candidate")
        // The staged scope string matches the retriever's project visibility encoding.
        expect(doc?.scope).toBe(`durable:project:${projectIdForWorkspace(directory)}`)
        // knowledge → medium risk.
        expect(doc?.tags).toContain("risk:medium")
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    ))

  test("merges a repeat proposal into the existing candidate instead of flooding the queue", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const tool = KnowledgeProposeTool.makeKnowledgeProposeTool({ globalStore: () => store })
        const input = {
          type: "knowledge" as const,
          description: "Prefer structured concurrency over ad-hoc detachment.",
          body: "Forked fibers must stay scoped so interruption propagates.",
          scope: "global" as const,
        }

        const first = structured(yield* settle(tool, input, "call-kp-dup-1"))
        const second = structured(yield* settle(tool, input, "call-kp-dup-2"))
        expect(second.candidate_id).toBe(first.candidate_id)
        expect(second.status).toBe("pending_review")

        const candidates = store.listByStatus("candidate")
        expect(candidates).toHaveLength(1)
        const doc = store.documentStore.get(first.candidate_id)
        expect(doc?.confidence).toMatchObject({ evidence_strength: "weak", support_count: 2 })
      }),
    ))

  test("rejects credential-shaped content before anything stages", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const tool = KnowledgeProposeTool.makeKnowledgeProposeTool({ globalStore: () => store })

        const failure = yield* settle(
          tool,
          {
            type: "memory",
            description: "The shared database password for the staging box.",
            body: "The password is hunter2; it is rotated monthly.",
            scope: "global",
          },
          "call-kp-sensitive",
        ).pipe(Effect.flip)
        expect(failure.message).toContain("credential/secret pattern")
        expect(store.listByStatus("candidate")).toHaveLength(0)
      }),
    ))

  test("stages at most 10 proposals per session, then fails closed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = new DurableKnowledgeStore(path.join(tmpRoot(), "knowledge"))
        const tool = KnowledgeProposeTool.makeKnowledgeProposeTool({ globalStore: () => store })

        for (let i = 0; i < KnowledgeProposeTool.KnowledgeProposeBudget.perSessionMax; i++) {
          // Distinct domains keep the store's dedup-merge out of this budget assertion.
          const settlement = yield* settle(
            tool,
            {
              type: "knowledge",
              description: `Fact ${i} about this repository's conventions.`,
              body: `Convention detail ${i}.`,
              domain: `domain_${i}`,
              scope: "global",
            },
            `call-kp-budget-${i}`,
          )
          expect(structured(settlement).status).toBe("pending_review")
        }

        const failure = yield* settle(
          tool,
          {
            type: "knowledge",
            description: "One convention too many.",
            body: "This one must not stage.",
            domain: "domain_overflow",
            scope: "global",
          },
          "call-kp-budget-overflow",
        ).pipe(Effect.flip)
        expect(failure.message).toContain("budget exhausted")
        expect(failure.message).toContain("10 proposals")
        expect(store.listByStatus("candidate")).toHaveLength(KnowledgeProposeTool.KnowledgeProposeBudget.perSessionMax)
      }),
    ))

  test("fails typed when the durable knowledge base is not configured", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tool = KnowledgeProposeTool.makeKnowledgeProposeTool({ globalStore: () => null })
        const failure = yield* settle(
          tool,
          {
            type: "memory",
            description: "A durable fact.",
            body: "Body.",
            scope: "global",
          },
          "call-kp-unconfigured",
        ).pipe(Effect.flip)
        expect(failure.message).toContain("not configured")
      }),
    ))
})
