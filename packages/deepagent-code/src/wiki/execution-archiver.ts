import { Effect } from "effect"
import type { DurableKnowledgeStore } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import {
  buildExecutionArchive,
  GateRejectedError,
  WikiNotFoundError,
  WikiService,
  type ExecutionArchive,
  type HumanRef,
  type WikiEditGate,
  type WikiGraph,
  type WikiPage,
} from "./wiki-service"

/**
 * V3.9 §B.6 — ExecutionArchiver (session-internal form).
 *
 * archiveSession aggregates one session's Document-Graph trajectory (plan + worklog + diagnosis +
 * decision + validation, scope run:<sessionId>) into a read-only archive page. In V3.9 it is
 * triggered from the existing session-completion path (persistSuggestion / onMacroRound), NOT an
 * event bus — V4.0 upgrades it to a `session.completed` event with the SAME output shape.
 *
 * promoteToWiki is the human "pin → governed knowledge page" step (§B.2 / §B.6): the archive is
 * read-only by default; a human promotes it into a governed KNOWLEDGE page through the evidence-gate.
 * We reuse the EXISTING knowledge governance pipeline (DurableKnowledgeStore.stageCandidate → human
 * approve), which is exactly the promote/reject path the Review UI already drives — knowledge is
 * ALWAYS staged as a candidate first (DAP-8) and only a human flips it active. The injected
 * `WikiEditGate` is the evidence-gate check applied before staging; a rejection surfaces as
 * `GateRejectedError`, never a silent write.
 *
 * archiveId == sessionId: the archive is a PURE projection of the run:<sessionId> subgraph (no
 * independent storage, §B.1), so it is fully rebuildable and needs no separate id space.
 */

export interface ExecutionArchiverPorts {
  readonly graph: WikiGraph
  // The governed durable store a promoted archive lands in (user-global knowledge store in prod).
  readonly promotionStore: DurableKnowledgeStore
  // The WikiService used to render the resulting governed page (shares the same graph union).
  readonly wiki: WikiService
  // The evidence-gate applied before a promote. Defaults to the WikiService's default gate.
  readonly gate?: WikiEditGate
}

export class ExecutionArchiver {
  constructor(private readonly ports: ExecutionArchiverPorts) {}

  // §B.6 archiveSession: aggregate the session trajectory into a read-only archive. Never fails.
  archiveSession(sessionId: string): Effect.Effect<ExecutionArchive, never> {
    return Effect.sync(() => buildExecutionArchive(this.ports.graph, sessionId))
  }

  // §B.6 promoteToWiki: human pins an archive → governed knowledge page (evidence-gate + human
  // approve). `archiveId` is the sessionId. Fails with GateRejectedError if the gate rejects or the
  // session has no trajectory to promote.
  promoteToWiki(input: {
    archiveId: string
    editor: HumanRef
  }): Effect.Effect<WikiPage, GateRejectedError | WikiNotFoundError> {
    return Effect.suspend(() => {
      const archive = buildExecutionArchive(this.ports.graph, input.archiveId)
      if (archive.entries.length === 0)
        return Effect.fail(
          new GateRejectedError({
            docId: input.archiveId,
            reason: "no trajectory documents to promote for this session",
          }),
        )
      const body = archive.markdown
      const gate = this.ports.gate
      if (gate) {
        // No prior doc exists yet (this is a fresh promotion), so gate against a synthetic current
        // whose body is empty — the default gate only rejects a blanked-out body, which a non-empty
        // archive never is; a stricter injected gate can inspect archive content.
        const verdict = gate({
          current: {
            id: input.archiveId,
            type: "knowledge",
            scope: "durable",
            status: "candidate",
            version: 0,
            superseded_by: null,
            hash: "",
            created_round: null,
            domain: null,
            tags: [],
            description: archive.title,
            provenance: { source: "human" },
            links: [],
            body: "",
          },
          body,
          editor: input.editor,
        })
        if (!verdict.pass)
          return Effect.fail(new GateRejectedError({ docId: input.archiveId, reason: verdict.reason ?? "rejected" }))
      }
      return Effect.try({
        try: () => {
          // Stage as a knowledge candidate (DAP-8: never written directly active), then the human
          // editor's pin approves it → active. This IS the evidence-gate governance path.
          const staged = this.ports.promotionStore.stageCandidate({
            type: "knowledge",
            description: archive.title,
            body,
            domain: null,
            tags: ["wiki", "execution-archive", `session:${input.archiveId}`],
            scope: "user-global",
            sensitivity: "source_code",
            risk: "low",
            confidence: { evidence_strength: "medium", support_count: 1 },
            provenance: {
              source: "human",
              evidence_refs: [`human:${input.editor.id}${input.editor.name ? `:${input.editor.name}` : ""}`],
            },
            idSlug: `execution-archive-${input.archiveId}`,
          })
          this.ports.promotionStore.approve(staged.id)
          return staged.id
        },
        catch: (error) =>
          new GateRejectedError({
            docId: input.archiveId,
            reason: `promotion failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }).pipe(
        Effect.flatMap((docId) =>
          this.ports.wiki
            .renderPage({ docId, scope: "durable" })
            .pipe(
              Effect.catchTag("WikiNotFoundError", (e) =>
                Effect.fail(new GateRejectedError({ docId, reason: e.message })),
              ),
            ),
        ),
      )
    })
  }
}
