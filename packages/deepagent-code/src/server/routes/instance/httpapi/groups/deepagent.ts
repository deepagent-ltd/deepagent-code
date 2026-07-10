import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
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

// V3.8.1 §G environment-fact use-gate. Provisional user-global environment facts (verifiable,
// non-directive, desensitized operational facts — test servers/containers/endpoints) surface here so
// each project decides, at first use, whether to adopt them. Credentials are NEVER carried in the
// body: only secret_ref pointers. `degraded` = the last connection attempt failed (§G.6).
export const DeepAgentEnvFactBody = Schema.Struct({
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  container: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
  secret_refs: Schema.optional(Schema.Array(Schema.String)),
  last_confirmed_at: Schema.String,
  notes: Schema.optional(Schema.String),
})
export const DeepAgentEnvFactItem = Schema.Struct({
  fact_id: Schema.String,
  version: Schema.Number,
  description: Schema.String,
  body: Schema.NullOr(DeepAgentEnvFactBody),
  degraded: Schema.Boolean,
})
export const DeepAgentEnvFactList = Schema.Struct({
  adopted: Schema.Array(DeepAgentEnvFactItem),
  pending: Schema.Array(DeepAgentEnvFactItem),
})
export const DeepAgentEnvFactDecisionInput = Schema.Struct({
  factId: Schema.String,
  decision: Schema.Literals(["adopt", "reject"]),
})
export const DeepAgentEnvFactModifyInput = Schema.Struct({
  factId: Schema.String,
  description: Schema.String,
  body: DeepAgentEnvFactBody,
  domain: Schema.optional(Schema.NullOr(Schema.String)),
  mode: Schema.Literals(["global", "project"]),
})
export const DeepAgentEnvFactResult = Schema.Struct({ ok: Schema.Boolean, factId: Schema.String })

// ── V3.9 §C Expert Panel + §D Goal Loop ─────────────────────────────────────
// Panel consult (会诊) is convened on demand for a session; the goal lifecycle drives the autonomous
// loop. Both are gated by their independent experimental flags server-side (the handler fail-closes).

const PanelLensSchema = Schema.Literals(["correctness", "security", "performance", "architecture", "repro"])

/** POST /deepagent/panel/consult — convene the Expert Panel on the current session context. */
export const DeepAgentPanelConsultInput = Schema.Struct({
  sessionID: Schema.String,
  /** The frozen question. When omitted the handler builds one from the session's recent context. */
  question: Schema.optional(Schema.String),
  codeRefs: Schema.optional(Schema.Array(Schema.String)),
  lenses: Schema.optional(Schema.Array(PanelLensSchema)),
  maxRounds: Schema.optional(Schema.Number),
  policy: Schema.optional(Schema.Literals(["default", "security"])),
})

export const DeepAgentPanelFinding = Schema.Struct({
  severity: Schema.String,
  category: Schema.String,
  file: Schema.optional(Schema.NullOr(Schema.String)),
  line: Schema.optional(Schema.NullOr(Schema.Number)),
  summary: Schema.String,
  failureScenario: Schema.String,
  confidence: Schema.Number,
})
export const DeepAgentPanelDissent = Schema.Struct({
  lens: Schema.String,
  verdict: Schema.String,
  confidence: Schema.Number,
  findings: Schema.Array(DeepAgentPanelFinding),
})
export const DeepAgentPanelVerdict = Schema.Struct({
  decision: Schema.Literals(["approve", "revise", "block", "needs_human"]),
  confidence: Schema.Number,
  rounds: Schema.Number,
  evidence: Schema.Array(Schema.String),
  dissent: Schema.Array(DeepAgentPanelDissent),
})

/** POST /deepagent/panel/arm — set the per-session armed flag (button toggle). */
export const DeepAgentPanelArmInput = Schema.Struct({
  sessionID: Schema.String,
  armed: Schema.Boolean,
})
export const DeepAgentPanelArmResult = Schema.Struct({ sessionID: Schema.String, armed: Schema.Boolean })

/** POST /deepagent/goal/start */
export const DeepAgentGoalStartInput = Schema.Struct({
  sessionID: Schema.String,
  criteria: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["tests_pass", "no_diagnostics", "reviewer_clean", "panel_approves", "plan_complete"]),
        commands: Schema.optional(Schema.Array(Schema.String)),
        maxSeverity: Schema.optional(Schema.String),
        severityAtMost: Schema.optional(Schema.String),
      }),
    ),
  ),
  limits: Schema.optional(
    Schema.Struct({
      maxTicks: Schema.optional(Schema.Number),
      maxTokens: Schema.optional(Schema.Number),
      maxWallclockMs: Schema.optional(Schema.Number),
      maxCost: Schema.optional(Schema.Number),
    }),
  ),
  stallThreshold: Schema.optional(Schema.Number),
})

/** Goal lifecycle mutations that only need the session id. */
export const DeepAgentGoalSessionInput = Schema.Struct({ sessionID: Schema.String })

export const DeepAgentGoalSnapshot = Schema.Struct({
  goalId: Schema.String,
  planDocId: Schema.String,
  phase: Schema.String,
  running: Schema.Boolean,
})
export const DeepAgentGoalStatusResult = Schema.Struct({ goal: Schema.NullOr(DeepAgentGoalSnapshot) })
export const DeepAgentGoalMutateResult = Schema.Struct({ ok: Schema.Boolean })

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
    .add(
      HttpApiEndpoint.get("envFacts", `${root}/env-facts`, {
        query: WorkspaceRoutingQuery,
        success: described(DeepAgentEnvFactList, "Provisional environment facts: adopted + pending for this project"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.envFacts.list",
          summary: "List environment facts for the use-gate",
          description:
            "V3.8.1 §G: provisional user-global environment facts, partitioned into adopted (silently used) and pending (needs a decision) for the active project.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("envFactsDecide", `${root}/env-facts/decide`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentEnvFactDecisionInput,
        success: described(DeepAgentEnvFactResult, "Adopt or reject a provisional environment fact for this project"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.envFacts.decide",
          summary: "Adopt or reject an environment fact",
          description:
            "V3.8.1 §G.5: adopt (silently use in this project, never ask again) or reject (never ask again here; other projects unaffected).",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("envFactsModify", `${root}/env-facts/modify`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentEnvFactModifyInput,
        success: described(DeepAgentEnvFactResult, "Modified environment fact (global correction or project override)"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.envFacts.modify",
          summary: "Modify an environment fact and adopt it",
          description:
            "V3.8.1 §G.5: edit a fact then adopt it. mode=global corrects the shared fact for all projects; mode=project writes a project-local override, leaving the global fact untouched.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("panelConsult", `${root}/panel/consult`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentPanelConsultInput,
        success: described(DeepAgentPanelVerdict, "Expert Panel verdict for the convened question"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.panel.consult",
          summary: "Convene the Expert Panel (会诊)",
          description:
            "V3.9 §C: freeze the question, fan out the lens panelists (equal-footing debate), and return the deterministic arbiter verdict. Gated by the expert-panel flag.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("panelArm", `${root}/panel/arm`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentPanelArmInput,
        success: described(DeepAgentPanelArmResult, "The session's new panel armed state"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.panel.arm",
          summary: "Arm or disarm the Expert Panel for a session",
          description: "V3.9 §C: per-conversation toggle for the panel button; seeded from the global default.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("goalStart", `${root}/goal/start`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentGoalStartInput,
        success: described(DeepAgentGoalSnapshot, "The started goal (goalId + initial phase)"),
        error: DeepAgentPromotionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "deepagent.goal.start",
          summary: "Start a Goal Loop from the session's plan",
          description:
            "V3.9 §D: materialize the session plan into the graded doc and drive the autonomous loop as a resident background task. Gated by the goal-loop flag.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("goalPause", `${root}/goal/pause`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentGoalSessionInput,
        success: described(DeepAgentGoalMutateResult, "Whether the goal was paused"),
        error: DeepAgentPromotionError,
      }),
    )
    .add(
      HttpApiEndpoint.post("goalResume", `${root}/goal/resume`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentGoalSessionInput,
        success: described(DeepAgentGoalMutateResult, "Whether the goal was resumed"),
        error: DeepAgentPromotionError,
      }),
    )
    .add(
      HttpApiEndpoint.post("goalStop", `${root}/goal/stop`, {
        query: WorkspaceRoutingQuery,
        payload: DeepAgentGoalSessionInput,
        success: described(DeepAgentGoalMutateResult, "Whether the goal was stopped"),
        error: DeepAgentPromotionError,
      }),
    )
    .add(
      HttpApiEndpoint.get("goalStatus", `${root}/goal/status`, {
        query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: Schema.String }),
        success: described(DeepAgentGoalStatusResult, "The active goal for the session, or null"),
        error: DeepAgentPromotionError,
      }),
    )
    .annotateMerge(OpenApi.annotations({ title: "deepagent", description: "DeepAgent setup routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
