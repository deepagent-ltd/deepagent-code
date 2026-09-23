export * as KnowledgeProposeTool from "./knowledge-propose"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { projectIdForWorkspace, type DurableKnowledgeStore } from "../deepagent/durable-knowledge-store"
import { isConfigured, projectStoreFor, userGlobalStoreFor } from "../deepagent/knowledge-source"
import { looksSensitive } from "../deepagent/memory-governance"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { Tool } from "./tool"
import { Tools } from "./tools"

// P3-b (WS7/B6, docs/V2.0.1-001-llm-agent-system-manual.md §8.1): the model's "remember this" write
// path. A proposal is staged through `DurableKnowledgeStore.stageCandidate` — status is ALWAYS
// `candidate` (DAP-8: durable knowledge is never written active), invisible to retrieval (the
// retrieve whitelist only serves `active`), and immediately present in the existing human review
// queue (HTTP /deepagent/knowledge/pending + the GUI Review dialog). The store's own dedup-merge
// (`findSimilarKnowledge` token overlap ≥ 0.8 → `reinforceConfidence`) folds a repeat proposal into
// the existing row instead of flooding the queue.
//
// Anti-pollution (design §8.1 三道):
//   1. sensitivity scrub — the memory-governance credential patterns; a hit REJECTS the proposal
//      (the tool path has no auto-review routing, so fail-closed is the honest action).
//   2. a per-session cap of 10 staged proposals, counted in module state keyed by sessionID (the
//      domain_pack_load budget pattern: process-local, keyed by globally unique session ids).
//   3. the store's dedup-merge (above); a human-rejected fingerprint stays `rejected` and is never
//      resurrected (findSimilarKnowledge skips rejected docs).
//
// Permission: plain Tool.make default — the action is the tool name `knowledge_propose`, effectKind
// mutating (NOT in readOnlyActions), no execution-time assert. A proposal only ever lands in the
// human review queue (never in retrieval), so the default posture is allow; a configured
// `knowledge_propose: * = deny` rule hides the definition at materialization (design §8.1 默认
// allow, deny 可配).
//
// Scope: BOTH scopes are supported. `project` (the default) stages into the workspace's
// project-shared store, resolved from the session row's directory through knowledge-source's
// projectStoreFor (the write side derives the project id from the same path, so write/read scope
// strings agree); `global` stages into the user-global store.

export const name = "knowledge_propose"

/** Anti-pollution budget: at most this many proposals stage per session (design §8.1). */
export const KnowledgeProposeBudget = {
  perSessionMax: 10,
} as const

const DESCRIPTION = [
  "Propose a durable knowledge or memory entry for the human review queue.",
  "Use it when the user says 'remember this', or when a fact emerges that will still be valuable across sessions (a project convention, an environment fact, a durable preference).",
  "Never use it for task-local scratch — anything only useful to the current task belongs in the conversation or a file, not in durable knowledge.",
  "The entry is staged as a review CANDIDATE: it is invisible to knowledge retrieval until a human approves it in the review queue, and a near-duplicate of an existing entry merges into that entry instead of creating a new one.",
  "Content carrying credentials or secrets (tokens, passwords, private keys, connection strings) is rejected outright, and a session may stage at most 10 proposals.",
  "Default scope is project (visible to this workspace); pass scope global only for facts that genuinely apply to every project.",
].join(" ")

const Input = Schema.Struct({
  type: Schema.Literals(["memory", "knowledge"]).annotate({
    description: "memory for a project/environment fact; knowledge for a reusable insight or convention",
  }),
  description: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "One-line summary used for retrieval scoring and the review queue listing",
  }),
  body: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "The full durable content",
  }),
  domain: Schema.optional(Schema.String).annotate({
    description: "Optional knowledge domain (e.g. orchestration, reliability)",
  }),
  tags: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional free-form tags",
  }),
  scope: Schema.optional(Schema.Literals(["project", "global"])).annotate({
    description:
      "project (default) scopes the entry to this workspace's project store; global proposes it into the user-global store visible to every workspace",
  }),
})

const Output = Schema.Struct({
  candidate_id: Schema.String,
  status: Schema.Literals(["pending_review", "already_active"]),
  scope: Schema.Literals(["project", "global"]),
  output: Schema.String,
})

/** Store seams; production resolves the gateway-configured durable stores (guarded isConfigured). */
export interface KnowledgeProposeToolOptions {
  readonly globalStore?: () => DurableKnowledgeStore | null
  readonly projectStore?: (workspacePath: string) => DurableKnowledgeStore | null
}

const productionGlobalStore = () => (isConfigured() ? userGlobalStoreFor() : null)
const productionProjectStore = (workspacePath: string) => (isConfigured() ? projectStoreFor(workspacePath) : null)

// Per-session staged-proposal counts (see the module header). Process-local like the
// domain_pack_load budget maps; a reset hook keeps tests isolated.
const sessionProposals = new Map<string, number>()

/** Test hook: clear all per-session proposal counts (mirrors resetDomainPackLoadState). */
export function resetKnowledgeProposeState(): void {
  sessionProposals.clear()
}

type ResolvedStore = {
  readonly store: DurableKnowledgeStore
  readonly scope: "user-global" | "project-shared"
  readonly projectId?: string
}

/** A ready-to-register `knowledge_propose` tool (plain default permission: action = tool name). */
export function makeKnowledgeProposeTool(options: KnowledgeProposeToolOptions = {}): Tool.AnyTool {
  const resolveGlobal = options.globalStore ?? productionGlobalStore
  const resolveProject = options.projectStore ?? productionProjectStore
  return Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [toolText({ type: "text", text: output.output })],
    execute: (input, context) =>
      Effect.gen(function* () {
        const scope = input.scope ?? "project"
        const content = [input.description, input.body, input.domain ?? "", ...(input.tags ?? [])].join("\n")
        if (looksSensitive(content))
          return yield* new ToolFailure({
            message:
              "knowledge_propose refused: the description or body matches a credential/secret pattern " +
              "(token, password, private key, connection string or similar). Durable knowledge must never " +
              "carry secrets — restate the fact without the sensitive value, or do not propose it.",
          })

        const staged = sessionProposals.get(context.sessionID) ?? 0
        if (staged >= KnowledgeProposeBudget.perSessionMax)
          return yield* new ToolFailure({
            message:
              `knowledge_propose budget exhausted: at most ${KnowledgeProposeBudget.perSessionMax} proposals ` +
              "stage per session. Propose only the few facts that genuinely outlive this session.",
          })

        const resolved = yield* resolveStore(scope, context.sessionID, resolveGlobal, resolveProject)
        const doc = yield* Effect.try({
          try: () =>
            resolved.store.stageCandidate({
              type: input.type,
              description: input.description,
              body: input.body,
              domain: input.domain ?? null,
              tags: input.tags ?? [],
              scope: resolved.scope,
              ...(resolved.projectId !== undefined ? { projectId: resolved.projectId } : {}),
              sensitivity: "public",
              risk: input.type === "memory" ? "low" : "medium",
              // knowledge-class docs (memory included) require a confidence structure; an
              // unverified model observation starts at the lowest non-zero evidence tier.
              confidence: { evidence_strength: "weak", support_count: 1 },
              provenance: { source: "model", run_ref: `${context.sessionID}/${context.assistantMessageID}` },
            }),
          catch: (error) =>
            new ToolFailure({
              message: `knowledge_propose failed to stage the candidate: ${error instanceof Error ? error.message : String(error)}`,
            }),
        })

        sessionProposals.set(context.sessionID, staged + 1)

        const status = doc.status === "candidate" ? ("pending_review" as const) : ("already_active" as const)
        return {
          candidate_id: doc.id,
          status,
          scope,
          output:
            status === "pending_review"
              ? `Staged as a review candidate (${doc.id}). It becomes visible to retrieval only after human approval.`
              : `This matches the already-active entry ${doc.id}; the proposal merged into it (support count reinforced) instead of creating a duplicate.`,
        }
      }),
  })
}

// The store a proposal lands in. Global scope reads the configured user-global handle. Project scope
// reads the session's own durable row (the same SessionTable read task_status performs) and opens the
// project store for its directory — projectStoreFor derives the canonical project id from that path,
// so the staged doc's scope string and the retriever's visibility filter agree by construction.
function resolveStore(
  scope: "project" | "global",
  sessionID: SessionSchema.ID,
  resolveGlobal: () => DurableKnowledgeStore | null,
  resolveProject: (workspacePath: string) => DurableKnowledgeStore | null,
): Effect.Effect<ResolvedStore, ToolFailure> {
  if (scope === "global") {
    const store = resolveGlobal()
    if (!store)
      return Effect.fail(
        new ToolFailure({
          message: "knowledge_propose is unavailable: the durable knowledge base is not configured",
        }),
      )
    return Effect.succeed({ store, scope: "user-global" as const })
  }
  return Effect.gen(function* () {
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    if (!database)
      return yield* new ToolFailure({
        message: "knowledge_propose is unavailable: the database service is missing from the runner context",
      })
    const row = yield* database.db
      .select({ directory: SessionTable.directory })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row)
      return yield* new ToolFailure({
        message: `knowledge_propose: session ${sessionID} is not visible in the durable session store`,
      })
    const store = resolveProject(row.directory)
    if (!store)
      return yield* new ToolFailure({
        message: "knowledge_propose is unavailable: the project knowledge store is not configured for this workspace",
      })
    return { store, scope: "project-shared" as const, projectId: projectIdForWorkspace(row.directory) }
  })
}

/** Production registration (design §8.1): register `knowledge_propose` into the Location tool registry. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools.register({ [name]: makeKnowledgeProposeTool() }).pipe(Effect.orDie)
  }),
)
