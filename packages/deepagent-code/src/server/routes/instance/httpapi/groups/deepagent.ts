import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/deepagent"

export class DeepAgentPromotionError extends Schema.ErrorClass<DeepAgentPromotionError>("DeepAgentPromotionError")(
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

// V3 reviewer (F4): expose recent run reviews so the reviewer UI is no longer a dead link.
export const DeepAgentCandidateNode = Schema.Struct({
  round: Schema.Number,
  ref: Schema.String,
  parent: Schema.NullOr(Schema.String),
  status: Schema.String,
  decisionRef: Schema.NullOr(Schema.String),
  notes: Schema.Array(Schema.String),
})

export const DeepAgentLearningCandidate = Schema.Struct({
  candidateId: Schema.String,
  type: Schema.Literals(["memory", "strategy", "methodology"]),
  status: Schema.String,
  sourceRunId: Schema.String,
  sourceRound: Schema.Number,
  summary: Schema.String,
  evidenceRefs: Schema.Array(Schema.String),
  confidence: Schema.Number,
})

export const DeepAgentRunReview = Schema.Struct({
  runId: Schema.String,
  agentMode: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  nextAction: Schema.NullOr(Schema.String),
  candidates: Schema.Array(DeepAgentCandidateNode),
  diagnosis: Schema.NullOr(
    Schema.Struct({
      status: Schema.NullOr(Schema.String),
      rootCause: Schema.NullOr(Schema.String),
      nextAction: Schema.NullOr(Schema.String),
    }),
  ),
  runContext: Schema.NullOr(Schema.String),
  learningCandidates: Schema.Array(DeepAgentLearningCandidate),
})

export const DeepAgentReviewList = Schema.Struct({ reviews: Schema.Array(DeepAgentRunReview) })

export const DeepAgentPromotionInput = Schema.Struct({
  candidate: Schema.Struct({
    candidate_id: Schema.String,
    type: Schema.Literals(["memory", "strategy", "methodology"]),
    status: Schema.Literal("staged"),
    source_run_id: Schema.String,
    source_round: Schema.Number,
    summary: Schema.String,
    evidence_refs: Schema.Array(Schema.String),
    confidence: Schema.Number,
  }),
  origin: Schema.Literals(["run_local", "external_trace", "sealed"]),
  // P1-A: `verdict` is advisory/audit ONLY and is no longer trusted for the pass decision. The
  // server recomputes the verdict via promotion.validate() (RejectedBuffer dedup + replay/regression
  // gate); a client cannot promote by asserting verdict.pass=true. Kept optional for back-compat and
  // so a UI can still display the client's view of the candidate.
  verdict: Schema.optional(
    Schema.Struct({
      pass: Schema.Boolean,
      reason: Schema.optional(Schema.String),
      evidence: Schema.Array(Schema.String),
    }),
  ),
  approval: Schema.Struct({
    approver: Schema.String,
    approved: Schema.Boolean,
    note: Schema.optional(Schema.String),
  }),
})

export const DeepAgentPromotionResult = Schema.Struct({
  promoted: Schema.Struct({
    id: Schema.String,
    source_candidate_id: Schema.String,
    type: Schema.String,
    summary: Schema.String,
    evidence_refs: Schema.Array(Schema.String),
    evidence_strength: Schema.String,
    promoted_by: Schema.String,
    promoted_at: Schema.String,
  }),
})

export const DeepAgentRejectionInput = Schema.Struct({
  candidate: DeepAgentPromotionInput.fields.candidate,
  reason: Schema.String,
})

export const DeepAgentRejectionResult = Schema.Struct({
  rejected: Schema.Struct({
    candidateId: Schema.String,
    fingerprint: Schema.String,
    reason: Schema.String,
  }),
})

// V3.2.1 (docs/34) self-learning Review UI: list candidate/active/rejected durable knowledge and
// batch approve/reject by id. Accessibility is the DocStatus flag (approval_status), never a move.
export const DeepAgentKnowledgeItem = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["knowledge", "strategy", "methodology", "memory", "skill", "failure_dossier"]),
  summary: Schema.String,
  // Evidence strength of the durable doc (strong/medium/weak/none) — the durable model carries
  // discrete strength, not a raw confidence number.
  evidence_strength: Schema.Literals(["strong", "medium", "weak", "none"]),
  evidence_refs: Schema.Array(Schema.String),
  approval_status: Schema.Literals(["pending", "approved", "rejected"]),
})

export const DeepAgentKnowledgeList = Schema.Struct({ items: Schema.Array(DeepAgentKnowledgeItem) })

export const DeepAgentKnowledgeStatusInput = Schema.Struct({ ids: Schema.Array(Schema.String) })

export const DeepAgentKnowledgeStatusResult = Schema.Struct({ updated: Schema.Array(Schema.String) })

// docs/34 §9 S10: domain pack pin/unpin and active pack set query.
export const DeepAgentPackInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  risk: Schema.Literals(["low", "medium", "high", "regulated"]),
  domains: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
})
export const DeepAgentPacksResult = Schema.Struct({
  packs: Schema.Array(DeepAgentPackInfo),
  snapshotId: Schema.String,
})
export const DeepAgentPackPinInput = Schema.Struct({ packId: Schema.String })
export const DeepAgentPackPinResult = Schema.Struct({ ok: Schema.Boolean, packId: Schema.String })

// docs/34 §9 S10: the full installed pack catalog (built-in + external), independent of which packs
// are active for the current workspace. Shown in the packs UI so users see every available pack.
export const DeepAgentPackCatalogItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  version: Schema.String,
  risk: Schema.Literals(["low", "medium", "high", "regulated"]),
  domains: Schema.Array(Schema.String),
  builtin: Schema.Boolean, // scope === "system" => bundled built-in pack
  pinned: Schema.Boolean,
})
export const DeepAgentPackCatalogResult = Schema.Struct({ packs: Schema.Array(DeepAgentPackCatalogItem) })

// V3.2 ablation ship gate (docs/30 §7). The CI/eval harness POSTs the REAL measured primary
// metric for each (group, task) cell — this is the honest seam: the runtime never fabricates eval
// numbers, it consumes them. candidateRefs are the durable ids whose shipping is under test; on a
// FAIL verdict they are demoted (approval_status=rejected) so misleading knowledge cannot ship.
export const DeepAgentShipGateMetric = Schema.Struct({
  group: Schema.Literals(["general", "high", "max"]),
  task: Schema.String,
  metric: Schema.Number, // higher is better (pass-rate / correctness / score)
})

export const DeepAgentShipGateInput = Schema.Struct({
  tasks: Schema.Array(Schema.String),
  metrics: Schema.Array(DeepAgentShipGateMetric),
  candidateRefs: Schema.Array(Schema.String),
  tolerance: Schema.optional(Schema.Number),
  repeats: Schema.optional(Schema.Number),
})

export const DeepAgentShipGateResult = Schema.Struct({
  ship: Schema.Boolean,
  reason: Schema.String,
  offenders: Schema.Array(Schema.String), // offending TASKS
  demoted: Schema.Array(Schema.String), // candidate REFS actually demoted (had a durable row)
  not_in_store: Schema.Array(Schema.String), // refs with no durable row (in-code/domain) — demote was a no-op
  per_group: Schema.Struct({ gen: Schema.Number, high: Schema.Number, max: Schema.Number }),
})

export const DeepAgentApi = HttpApi.make("deepagent").add(
  HttpApiGroup.make("deepagent")
    .add(
      HttpApiEndpoint.get("reviews", `${root}/reviews`, {
        query: WorkspaceRoutingQuery,
        success: described(
          DeepAgentReviewList,
          "Recent DeepAgent run reviews (candidate lineage, diagnosis, decision)",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.reviews",
          summary: "List recent DeepAgent run reviews",
          description: "Project recent DeepAgent run control-plane artifacts into reviewer views.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("promote", `${root}/knowledge/promote`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentPromotionInput,
        success: described(DeepAgentPromotionResult, "Human-approved promoted DeepAgent knowledge record"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.knowledge.promote",
          summary: "Promote reviewed DeepAgent knowledge",
          description:
            "Apply the V3 promotion gate and persist a human-approved candidate as durable retrievable knowledge.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("reject", `${root}/knowledge/reject`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentRejectionInput,
        success: described(DeepAgentRejectionResult, "Rejected DeepAgent knowledge candidate"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.knowledge.reject",
          summary: "Reject reviewed DeepAgent knowledge",
          description: "Record a reviewed candidate fingerprint in the V3 rejection buffer so it is not relearned.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("knowledgePending", `${root}/knowledge/pending`, {
        query: WorkspaceRoutingQuery,
        success: described(DeepAgentKnowledgeList, "Pending and rejected durable knowledge awaiting review"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.knowledge.pending",
          summary: "List DeepAgent knowledge awaiting review",
          description: "List durable knowledge that is pending approval or rejected, for the self-learning Review UI.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("knowledgeApprove", `${root}/knowledge/approve`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentKnowledgeStatusInput,
        success: described(DeepAgentKnowledgeStatusResult, "Ids that were marked approved (accessible)"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.knowledge.approve",
          summary: "Approve DeepAgent knowledge by id",
          description: "Flag durable knowledge entries as approved (retrievable). Reversible; does not move files.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("knowledgeRejectIds", `${root}/knowledge/reject-ids`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentKnowledgeStatusInput,
        success: described(DeepAgentKnowledgeStatusResult, "Ids that were marked rejected (inaccessible)"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.knowledge.rejectIds",
          summary: "Reject DeepAgent knowledge by id",
          description: "Flag durable knowledge entries as rejected (not retrievable). Reversible; does not move files.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("knowledgeShipGate", `${root}/knowledge/ship-gate`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentShipGateInput,
        success: described(DeepAgentShipGateResult, "Ablation ship-gate verdict; offending refs demoted on failure"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.knowledge.shipGate",
          summary: "Run the ablation regression ship gate",
          description:
            "CI/eval posts measured per-group/per-task metrics; if MAX regresses vs HIGH the candidate refs are demoted (rejected) so misleading knowledge cannot ship (docs/30 §7).",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("packsActive", `${root}/packs/active`, {
        query: WorkspaceRoutingQuery,
        success: described(DeepAgentPacksResult, "Active domain pack set for this workspace"),
        error: DeepAgentPromotionError,
      }),
    )
    .add(
      HttpApiEndpoint.get("packsAll", `${root}/packs/all`, {
        query: WorkspaceRoutingQuery,
        success: described(DeepAgentPackCatalogResult, "Full installed domain pack catalog (built-in + external)"),
        error: DeepAgentPromotionError,
      }),
    )
    .add(
      HttpApiEndpoint.post("packsPin", `${root}/packs/pin`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentPackPinInput,
        success: described(DeepAgentPackPinResult, "Pin a domain pack for this workspace"),
        error: DeepAgentPromotionError,
      }),
    )
    .add(
      HttpApiEndpoint.post("packsUnpin", `${root}/packs/unpin`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentPackPinInput,
        success: described(DeepAgentPackPinResult, "Unpin a domain pack for this workspace"),
        error: DeepAgentPromotionError,
      }),
    )
    .annotateMerge(OpenApi.annotations({ title: "deepagent", description: "DeepAgent setup routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
