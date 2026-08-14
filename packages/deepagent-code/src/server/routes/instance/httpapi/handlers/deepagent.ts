import path from "node:path"
import * as nodeFs from "node:fs"
import * as Log from "@deepagent-code/core/util/log"
import { Config } from "@/config/config"
import { configureGateway, reviewRunsDir } from "@/deepagent/config"
import { buildProfile } from "@/deepagent/profile-detector"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Effect } from "effect"
import { buildRunReview, listRunIds } from "@/deepagent/run-review"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { InstanceHttpApi } from "../api"
import {
  DeepAgentGoalPlanBusyError,
  DeepAgentGoalPlanChallengeError,
  DeepAgentGoalPlanConflictError,
  DeepAgentGoalPlanUnavailableError,
  DeepAgentGoalPlanValidationError,
  DeepAgentKnowledgeReviewConflictError,
  DeepAgentPromotionError,
  type DeepAgentShipGateMetric,
} from "../groups/deepagent"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SettingsStore } from "@/settings/store"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { GoalManager } from "@/session/goal-manager"
import { SessionID } from "@/session/schema"
import { consultPanel } from "@/panel/consult"
import { makeTaskSubagentRunner } from "@/session/goal-loop-wiring"
import { openWikiGraph, openWikiService, openWikiSearchIndex, buildWikiEditGate } from "@/wiki/session-archive"
import { WIKI_EDITABLE_TYPES, type WikiPage } from "@/wiki/wiki-service"
import type { PanelTurnRunner } from "@/panel/panelist-runner"
import type { PanelVerdict } from "@/agent/schema/panel"
import type { CompletionCriterion } from "@deepagent-code/core/deepagent/goal-loop"
import { PlanConflictError, PlanValidationError } from "@deepagent-code/core/deepagent/plan-controller"
import { Database } from "@deepagent-code/core/database/database"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { AbsolutePath } from "@deepagent-code/core/schema"
import {
  PlanEditBusyError,
  PlanEditChallengeError,
  PlanEditMailboxConflictError,
  PlanEditProtocolCorruptionError,
  PlanEditRequestConflictError,
  PlanEditTargetUnavailableError,
  type PlanEditReceipt,
} from "@deepagent-code/core/deepagent/plan-edit-protocol"
import { SERVER_USER_ID } from "../utils/workspace-context"

export const mapGoalPlanError = (error: GoalManager.GoalPlanEditAdmissionError) => {
  if (error instanceof PlanValidationError) {
    return new DeepAgentGoalPlanValidationError({
      message: error.message,
      code: error.code,
      offending_step_ids: [...error.offending_step_ids],
      previous_plan_id: error.previous_plan_id,
      previous_plan_version: error.previous_plan_version,
    })
  }
  if (error instanceof PlanConflictError) {
    return new DeepAgentGoalPlanConflictError({
      message: error.message,
      expected_plan_id: error.expected?.plan_id ?? null,
      expected_version: error.expected?.version ?? null,
      actual_plan_id: error.actual?.plan_id ?? null,
      actual_version: error.actual?.version ?? null,
    })
  }
  if (error instanceof PlanEditBusyError) {
    return new DeepAgentGoalPlanBusyError({ message: error.message, activity_id: error.activity_id })
  }
  if (error instanceof PlanEditChallengeError) {
    return new DeepAgentGoalPlanChallengeError({ message: error.message, reason: error.reason })
  }
  if (error instanceof PlanEditRequestConflictError || error instanceof PlanEditMailboxConflictError) {
    return new DeepAgentGoalPlanConflictError({
      message: error.message,
      expected_plan_id: null,
      expected_version: null,
      actual_plan_id: null,
      actual_version: null,
    })
  }
  if (
    error instanceof PlanEditTargetUnavailableError ||
    error instanceof PlanEditProtocolCorruptionError ||
    error instanceof GoalManager.GoalPlanEditUnavailableError
  ) {
    return new DeepAgentGoalPlanUnavailableError({ message: error.message })
  }
  return new DeepAgentGoalPlanUnavailableError({ message: "unknown plan edit failure" })
}

const projectPlanReceipt = (receipt: PlanEditReceipt) => ({
  state: receipt.state,
  activity_id: receipt.command.activity_id,
  request_id: receipt.command.request_id,
  candidate_hash: receipt.command.candidate_hash,
  ...(receipt.challenge ? { challenge: receipt.challenge } : {}),
  ...(receipt.result ? { result: receipt.result } : {}),
  ...(receipt.failure ? { failure: receipt.failure } : {}),
})

const dbgLog = Log.create({ service: "deepagent.packs.debug" })

// §C.4 — the server-side ceiling on Expert-Panel debate rounds a single consult may request. Round 1
// plus up to 2 debate rounds: enough for opinions to converge (the orchestrator also early-stops on a
// stable verdict distribution) while bounding the fan-out (one subagent turn per lens per round).
const PANEL_MAX_ROUNDS_CEILING = 3

const shipGateGroups = ["general", "high", "max"] as const

const validateShipGateMatrix = (
  tasks: readonly string[],
  metrics: readonly DeepAgentShipGateMetric[],
  repeats: number | undefined,
) => {
  if (tasks.length === 0) return "ship gate requires at least one task"
  if (repeats !== undefined && repeats !== 1) return "ship gate repeats must be 1 for aggregated metrics"

  const taskSet = new Set(tasks)
  if (taskSet.size !== tasks.length) return "ship gate tasks must be unique"

  const byKey = new Map<string, number>()
  for (const metric of metrics) {
    if (!Number.isFinite(metric.metric)) return `ship gate metric must be finite: ${metric.group}:${metric.task}`
    if (!taskSet.has(metric.task)) return `ship gate metric references an extra task: ${metric.task}`
    const key = `${metric.group}:${metric.task}`
    if (byKey.has(key)) return `duplicate ship gate metric: ${key}`
    byKey.set(key, metric.metric)
  }

  const missing = tasks
    .flatMap((task) => shipGateGroups.map((group) => `${group}:${task}`))
    .filter((key) => !byKey.has(key))
  if (missing.length > 0) return `ship gate metrics are incomplete: missing ${missing.join(", ")}`
  return byKey
}

export const deepagentHandlers = HttpApiBuilder.group(InstanceHttpApi, "deepagent", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    // V3.9 §C/§D services — provided by the app runtime the server executes in.
    const flags = yield* RuntimeFlags.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const goals = yield* GoalManager.Service
    const database = yield* Database.Service
    const locationIdentity = yield* LocationIdentity.Service

    // Build a reviewer-subagent turn runner scoped to a session — the panelist seam consultPanel needs.
    // Reuses makeTaskSubagentRunner (the same child-session + permission-derivation path the goal loop
    // and the task tool use) and adapts its SubagentTurnResult to the PanelTurnRunner shape.
    const panelTurnRunnerFor = (sessionID: string): Effect.Effect<PanelTurnRunner> =>
      Effect.gen(function* () {
        const model = yield* provider.defaultModel().pipe(Effect.orDie)
        const runTurn = makeTaskSubagentRunner({
          sessions,
          agents,
          sessionPrompt,
          parentSessionID: SessionID.make(sessionID),
          model: { providerID: model.providerID, modelID: model.modelID },
        })
        return (turnInput) =>
          runTurn({
            agentType: turnInput.agentType,
            prompt: turnInput.prompt,
            outputSchema: turnInput.outputSchema,
          }).pipe(Effect.map((r) => ({ structured: r.structured })))
      })

    const resolveReviewRunsDir = Effect.fn("DeepAgentHttpApi.resolveReviewRunsDir")(function* () {
      const route = yield* WorkspaceRouteContext
      void route.directory
      const cfg = yield* config.get()
      return reviewRunsDir(cfg)
    })

    const reviews = Effect.fn("DeepAgentHttpApi.reviews")(function* () {
      const runsDir = yield* resolveReviewRunsDir()
      const ids = (yield* Effect.promise(() => listRunIds(runsDir))).slice(0, 50)
      const list = yield* Effect.promise(() => Promise.all(ids.map((id) => buildRunReview(path.join(runsDir, id)))))
      return { reviews: list }
    })

    // The active workspace directory — durable knowledge stores root under the gateway baseDir, keyed
    // by this path (docs/34 §8). configureGateway points the knowledge-source at baseDir first.
    const workspaceDir = Effect.fn("DeepAgentHttpApi.workspaceDir")(function* () {
      const route = yield* WorkspaceRouteContext
      const cfg = yield* config.get()
      configureGateway(cfg)
      return route.directory
    })

    // The durable memory dir for the active workspace (RejectedBuffer fingerprint cache lives here).
    const workspaceMemoryDir = Effect.fn("DeepAgentHttpApi.workspaceMemoryDir")(function* () {
      const route = yield* WorkspaceRouteContext
      void route.directory
      const cfg = yield* config.get()
      configureGateway(cfg)
      return path.join(path.dirname(reviewRunsDir(cfg)), "memory")
    })

    const promote = Effect.fn("DeepAgentHttpApi.promote")(function* (ctx) {
      // P1-2: bind to the active workspace store before any read/write.
      const memoryDir = yield* workspaceMemoryDir()
      const dir = yield* workspaceDir()
      const now = new Date().toISOString()
      // F30-3 (v4.0.4): promotions should be associated with a passed ship-gate snapshot.
      // Soft enforcement: warn if absent so operators can update callers before v4.0.6 hardens this.
      if (!ctx.payload.snapshotId) {
        console.warn(
          "[DeepAgent promote] snapshotId not supplied — promotion should be associated with a passed ship-gate snapshot (F30-3). This will become a hard requirement in v4.0.6.",
        )
      }
      const promoted = yield* Effect.try({
        try: () => {
          // P1-A: the promotion gate is enforced SERVER-SIDE. The client-supplied `verdict` is NOT
          // trusted for the pass decision (a caller could otherwise POST verdict:{pass:true} and
          // bypass replay/regression entirely). Instead we run promotion.validate(), which dedupes
          // against the RejectedBuffer (contract R3) AND runs the replay/regression gate, and we
          // pass the SERVER-COMPUTED verdict into promote().
          const buffer = new AgentGateway.DeepAgentPromotion.RejectedBuffer(memoryDir)
          // Server-owned replay runner. There is no live replay sandbox in the route yet, so the
          // runner enforces the objective, server-checkable invariant: a promotable candidate must
          // carry real evidence (non-empty evidence_refs) and must not regress (metricDelta 0). This
          // is the single seam to wire a real eval-replay harness into later — the contract
          // (validate() owns the verdict) does not change when that lands.
          const replay: AgentGateway.DeepAgentPromotion.ReplayRunner = (candidate) => ({
            pass: candidate.evidence_refs.length > 0,
            metricDelta: 0,
            evidenceRef: candidate.evidence_refs[0],
          })
          const verdict = AgentGateway.DeepAgentPromotion.validate(ctx.payload.candidate, buffer, replay)
          if (!verdict.pass) {
            throw new Error(
              `promotion validation gate failed: ${verdict.reason ?? "candidate did not pass server-side validation"}`,
            )
          }
          return AgentGateway.DeepAgentPromotion.approveCandidate(
            AgentGateway.DeepAgentPromotion.promote(
              ctx.payload.candidate,
              ctx.payload.origin,
              verdict,
              ctx.payload.approval,
              now,
            ),
            AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace(dir),
            {
              ...(ctx.payload.snapshotId ? { reviewRef: ctx.payload.snapshotId } : {}),
              transitionedAt: Date.parse(now),
            },
          )
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
      return { promoted }
    })

    const reject = Effect.fn("DeepAgentHttpApi.reject")(function* (ctx) {
      const memoryDir = yield* workspaceMemoryDir()
      const dir = yield* workspaceDir()
      const rejected = yield* Effect.try({
        try: () => {
          const buffer = new AgentGateway.DeepAgentPromotion.RejectedBuffer(memoryDir)
          const fingerprint = AgentGateway.DeepAgentPromotion.fingerprint(ctx.payload.candidate)
          const doc = AgentGateway.DeepAgentPromotion.rejectCandidate(
            ctx.payload.candidate,
            AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace(dir),
            ctx.payload.reason,
            { type: "human", id: "legacy-knowledge-reject-route" },
          )
          // RejectedBuffer is a rebuildable anti-relearning projection. Write it only after the
          // immutable document governance revision commits; retrying this route reuses the same doc.
          AgentGateway.DeepAgentPromotion.reject(ctx.payload.candidate, buffer, ctx.payload.reason)
          return { candidateId: doc.id, fingerprint, reason: ctx.payload.reason }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
      return { rejected }
    })

    const REVIEW_TYPES = ["knowledge", "strategy", "methodology", "memory", "skill", "failure_dossier"] as const
    type ReviewType = (typeof REVIEW_TYPES)[number]
    const asReviewType = (type: string): ReviewType => {
      if (!REVIEW_TYPES.includes(type as ReviewType)) throw new Error(`unsupported knowledge review type: ${type}`)
      return type as ReviewType
    }
    const knowledgeItem = (item: AgentGateway.DeepAgentKnowledgeSource.ReviewItem) => ({
      sourceStore: item.sourceStore,
      id: item.id,
      version: item.version,
      hash: item.hash,
      candidateId: item.candidateId,
      fingerprint: item.fingerprint,
      governanceRevision: item.governanceRevision,
      type: asReviewType(item.type),
      summary: item.summary,
      evidence_strength: item.evidence_strength,
      evidence_refs: item.evidence_refs,
      approval_status: item.approval_status,
      scope: item.scope,
    })

    const knowledgePending = Effect.fn("DeepAgentHttpApi.knowledgePending")(function* () {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => {
          // P0-1b: return ALL three states so the Review UI can also revoke an already-approved
          // entry. Sorted by id for a stable list (the UI filters/groups by approval_status).
          const items = [...AgentGateway.DeepAgentKnowledgeSource.listAllForWorkspace(dir)]
            // Skills are agent-executable procedures, not human-readable facts — the governance UI
            // only surfaces learned facts (knowledge/memory/strategy/methodology/failure_dossier).
            // (Domain-pack seed docs are already excluded upstream by knowledge-source.)
            .filter((e) => e.type !== "skill")
            .map(knowledgeItem)
            .sort((a, b) => a.id.localeCompare(b.id) || a.sourceStore.localeCompare(b.sourceStore))
          return { items }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const knowledgeReviewSummary = Effect.fn("DeepAgentHttpApi.knowledgeReviewSummary")(function* () {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => AgentGateway.DeepAgentKnowledgeSource.reviewSummaryForWorkspace(dir),
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const commitKnowledgeReviewDecision = Effect.fn("DeepAgentHttpApi.commitKnowledgeReviewDecision")(function* (
      dir: string,
      payload: {
        readonly sourceStore: "user_global" | "project"
        readonly id: string
        readonly version: number
        readonly hash: string
        readonly candidateId: string
        readonly fingerprint: string
        readonly expectedGovernanceRevision: string
      },
      decision: "approve" | "reject",
    ) {
      return yield* Effect.try({
        try: () => ({
          updated: knowledgeItem(
            AgentGateway.DeepAgentKnowledgeSource.commitReviewDecisionForWorkspace(
              dir,
              {
                sourceStore: payload.sourceStore,
                id: payload.id,
                version: payload.version,
                hash: payload.hash,
                candidateId: payload.candidateId,
                fingerprint: payload.fingerprint,
                governanceRevision: payload.expectedGovernanceRevision,
              },
              decision,
              { type: "human", id: SERVER_USER_ID },
            ),
          ),
        }),
        catch: (error) =>
          error instanceof AgentGateway.DeepAgentKnowledgeSource.ReviewAuthorityConflictError
            ? new DeepAgentKnowledgeReviewConflictError({
                message: error.message,
                sourceStore: payload.sourceStore,
                id: payload.id,
              })
            : new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const knowledgeApprove = Effect.fn("DeepAgentHttpApi.knowledgeApprove")(function* (ctx) {
      const dir = yield* workspaceDir()
      return yield* commitKnowledgeReviewDecision(dir, ctx.payload, "approve")
    })

    const knowledgeRejectIds = Effect.fn("DeepAgentHttpApi.knowledgeRejectIds")(function* (ctx) {
      const dir = yield* workspaceDir()
      const scope = yield* releasedScope(dir)
      const parent = yield* AgentGateway.DeepAgentReleasedSnapshot.current(database.db, scope)
      const decision = yield* commitKnowledgeReviewDecision(dir, ctx.payload, "reject")
      const actor = { type: "human" as const, id: SERVER_USER_ID }
      const exactDocument = {
        sourceStore: ctx.payload.sourceStore,
        id: ctx.payload.id,
        version: ctx.payload.version,
        hash: ctx.payload.hash,
      }
      const document = parent?.documents.find(
        (candidate) =>
          candidate.sourceStore === ctx.payload.sourceStore &&
          candidate.id === ctx.payload.id &&
          candidate.version === ctx.payload.version &&
          candidate.hash === ctx.payload.hash,
      )
      const prior = document
        ? undefined
        : yield* AgentGateway.DeepAgentReleasedSnapshot.findRevocation(database.db, {
            scope,
            document: exactDocument,
            actor,
          })
      if (!parent || (!document && !prior)) return { ...decision, release_revocation: { state: "not_released" as const } }
      const revocation = prior ?? (yield* AgentGateway.DeepAgentReleasedSnapshot.revoke(
        database.db,
        {
          scope,
          expectedParent: parent,
          document: document!,
          actor,
        },
        releaseDocumentAuthority(dir),
      ).pipe(
        Effect.mapError((error) =>
          error instanceof AgentGateway.DeepAgentReleasedSnapshot.SnapshotConflictError ||
          error instanceof AgentGateway.DeepAgentReleasedSnapshot.SnapshotIdentityConflictError ||
          error instanceof AgentGateway.DeepAgentReleasedSnapshot.SnapshotDocumentError
            ? new DeepAgentKnowledgeReviewConflictError({
                message:
                  error instanceof AgentGateway.DeepAgentReleasedSnapshot.SnapshotConflictError ||
                    error instanceof AgentGateway.DeepAgentReleasedSnapshot.SnapshotIdentityConflictError
                    ? "released knowledge parent changed while the rejection was committing; retry the same decision"
                    : error.reason,
                sourceStore: ctx.payload.sourceStore,
                id: ctx.payload.id,
              })
            : new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
        ),
      ))
      return {
        ...decision,
        release_revocation: {
          state: revocation.state,
          previous_snapshot_id: revocation.previousSnapshotId,
          active_snapshot_id: revocation.selection.snapshotId,
          generation: revocation.selection.generation,
          membership_hash: revocation.selection.membershipHash,
          manifest_hash: revocation.selection.manifestHash,
          document_count: revocation.selection.documents.length,
        },
      }
    })

    const releasedScope = Effect.fn("DeepAgentHttpApi.releasedScope")(function* (dir: string) {
      const identity = yield* locationIdentity.resolve({
        boundary: { kind: "implicit_local" },
        directory: AbsolutePath.make(dir),
        project: {
          kind: "registered_root",
          observedProjectId: AgentGateway.DeepAgentDurableKnowledgeStore.projectIdForWorkspace(dir),
        },
      })
      return {
        securityNamespaceId: identity.securityNamespaceId,
        projectScopeKey: identity.projectScopeKey,
        legacyProjectId: AgentGateway.DeepAgentDurableKnowledgeStore.projectIdForWorkspace(dir),
      }
    })

    const releaseDocumentAuthority = (dir: string) => {
      const stores = AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace(dir)
      const userGlobal = stores[0]?.documentStore
      const project = stores[1]?.documentStore
      if (!userGlobal || !project) throw new Error("durable release document authority is unavailable")
      return { userGlobal, project }
    }

    const knowledgeReleaseBaseline = Effect.fn("DeepAgentHttpApi.knowledgeReleaseBaseline")(function* (ctx) {
      const dir = yield* workspaceDir()
      return yield* Effect.gen(function* () {
        const scope = yield* releasedScope(dir)
        const current = yield* AgentGateway.DeepAgentReleasedSnapshot.current(database.db, scope)
        if (current)
          return yield* new DeepAgentPromotionError({ message: "released knowledge baseline already exists" })
        const documents = ctx.payload.candidateRefs
        const selection = yield* AgentGateway.DeepAgentReleasedSnapshot.publish(
          database.db,
          {
            snapshotId: ctx.payload.snapshotId,
            evaluationId: ctx.payload.evaluationId,
            scope,
            expectedParentSnapshotId: null,
            expectedGeneration: 0,
            releaseKind: "legacy_baseline",
            verdict: "passed",
            documents,
            evaluationMatrix: { kind: "legacy_baseline", documents },
            baselineRef: ctx.payload.baselineRef,
            repetitions: 1,
            actor: { type: "system", id: "legacy-knowledge-baseline-route" },
          },
          releaseDocumentAuthority(dir),
        )
        if (!selection) return yield* Effect.die("passing baseline did not produce an active selection")
        return {
          release_snapshot_id: ctx.payload.snapshotId,
          active_snapshot_id: selection.snapshotId,
          generation: selection.generation,
          membership_hash: selection.membershipHash,
          manifest_hash: selection.manifestHash,
          document_count: selection.documents.length,
        }
      }).pipe(
        Effect.mapError((error) =>
          error instanceof DeepAgentPromotionError
            ? error
            : new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
        ),
      )
    })

    // CI/eval posts the measured matrix and candidate refs. The durable release service records the
    // exact doc revisions and advances the namespace/project head only for a passing verdict. A failed
    // gate remains auditable but leaves both the previous head and document governance untouched.
    const knowledgeShipGate = Effect.fn("DeepAgentHttpApi.knowledgeShipGate")(function* (ctx) {
      const dir = yield* workspaceDir()
      return yield* Effect.gen(function* () {
        const scope = yield* releasedScope(dir)
        const parent = yield* AgentGateway.DeepAgentReleasedSnapshot.current(database.db, scope)
        if (!parent) return yield* new DeepAgentPromotionError({ message: "released knowledge baseline is required" })
        if (
          ctx.payload.expectedParent.snapshotId !== parent.snapshotId ||
          ctx.payload.expectedParent.generation !== parent.generation ||
          ctx.payload.expectedParent.membershipHash !== parent.membershipHash
        ) {
          return yield* new DeepAgentPromotionError({ message: "released knowledge parent changed since evaluation" })
        }
        const byKey = validateShipGateMatrix(ctx.payload.tasks, ctx.payload.metrics, ctx.payload.repeats)
        if (typeof byKey === "string") return yield* new DeepAgentPromotionError({ message: byKey })
        const decision = AgentGateway.DeepAgentKnowledgeGate.evaluateSnapshot(
          ctx.payload.snapshotId,
          ctx.payload.tasks,
          (group, task) => byKey.get(`${group}:${task}`)!,
          {
            ...(ctx.payload.tolerance !== undefined ? { tolerance: ctx.payload.tolerance } : {}),
          },
        )
        const documents = yield* Effect.try({
          try: () => AgentGateway.DeepAgentReleasedSnapshot.mergeDocuments(parent.documents, ctx.payload.candidateRefs),
          catch: (error) =>
            error instanceof AgentGateway.DeepAgentReleasedSnapshot.SnapshotDocumentError
              ? new DeepAgentPromotionError({ message: error.reason })
              : error instanceof Error
                ? new DeepAgentPromotionError({ message: error.message })
                : new DeepAgentPromotionError({ message: String(error) }),
        })
        const selection = yield* AgentGateway.DeepAgentReleasedSnapshot.publish(
          database.db,
          {
            snapshotId: ctx.payload.snapshotId,
            evaluationId: ctx.payload.evaluationId,
            scope,
            expectedParentSnapshotId: parent.snapshotId,
            expectedGeneration: parent.generation,
            releaseKind: "evaluated",
            verdict: decision.ship ? "passed" : "failed",
            ...(!decision.ship ? { failureReason: decision.reason } : {}),
            documents,
            evaluationMatrix: {
              tasks: ctx.payload.tasks,
              metrics: ctx.payload.metrics,
              tolerance: ctx.payload.tolerance ?? 0,
              offenders: decision.offenders,
            },
            baselineRef: "knowledge-ship-gate:high",
            repetitions: ctx.payload.repeats ?? 1,
            actor: { type: "system", id: "legacy-knowledge-ship-gate-route" },
          },
          releaseDocumentAuthority(dir),
        )
        if (!selection) return yield* Effect.die("released knowledge publish lost the active selection")
        return {
          ship: decision.ship,
          reason: decision.reason,
          offenders: decision.offenders,
          demoted: [],
          not_in_store: [],
          per_group: decision.perGroup,
          release_snapshot_id: ctx.payload.snapshotId,
          active_snapshot_id: selection.snapshotId,
          generation: selection.generation,
          membership_hash: selection.membershipHash,
          manifest_hash: selection.manifestHash,
          document_count: selection.documents.length,
        }
      }).pipe(
        Effect.mapError((error) =>
          error instanceof DeepAgentPromotionError
            ? error
            : new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
        ),
      )
    })

    // docs/34 §9 S10: pinned packs persist per-workspace as a small JSON file under the memory dir.
    const pinnedPacksFile = (memoryDir: string) => path.join(memoryDir, "pinned-packs.json")
    const readPinned = (memoryDir: string): string[] => {
      try {
        const raw = nodeFs.readFileSync(pinnedPacksFile(memoryDir), "utf8")
        const arr = JSON.parse(raw)
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []
      } catch {
        return []
      }
    }
    const writePinned = (memoryDir: string, ids: readonly string[]): void => {
      nodeFs.mkdirSync(memoryDir, { recursive: true })
      nodeFs.writeFileSync(pinnedPacksFile(memoryDir), JSON.stringify([...new Set(ids)].sort(), null, 2), "utf8")
    }

    const packsActive = Effect.fn("DeepAgentHttpApi.packsActive")(function* () {
      const dir = yield* workspaceDir()
      const memoryDir = yield* workspaceMemoryDir()
      return yield* Effect.try({
        try: () => {
          const pinned = new Set(readPinned(memoryDir))
          const manifests = AgentGateway.DeepAgentDomainPackRegistry.discover()
          // Build a profile from the workspace so detection reflects reality; user overrides = pinned.
          const profile = buildProfile({
            cwd: dir,
            agentMode: "max",
            scenarioMode: "intelligence",
            userRequest: "",
            userOverrides: [...pinned],
          })
          const { snapshot, resolution } = AgentGateway.DeepAgentDomainPackRegistry.activateForProfile(
            profile,
            0.5,
            manifests,
          )
          const byId = new Map(manifests.map((m) => [m.id, m]))
          const packs = resolution.activePackIds.flatMap((id) => {
            const m = byId.get(id)
            if (!m) return []
            return [
              {
                id: m.id,
                name: m.name,
                version: m.version,
                risk: m.risk,
                domains: m.domains,
                pinned: pinned.has(m.id),
              },
            ]
          })
          return { packs, snapshotId: snapshot.id }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const packsAll = Effect.fn("DeepAgentHttpApi.packsAll")(function* () {
      dbgLog.info("packsAll: handler entered")
      const memoryDir = yield* workspaceMemoryDir()
      return yield* Effect.try({
        try: () => {
          const pinned = new Set(readPinned(memoryDir))
          const manifests = AgentGateway.DeepAgentDomainPackRegistry.discover()
          const scanDbg = AgentGateway.DeepAgentDomainPackRegistry.dirsToScanDebug()
          dbgLog.info("packsAll: discover", {
            count: manifests.length,
            dirs: scanDbg.dirs.join(" | "),
            builtin: String(scanDbg.builtin),
            metaUrl: scanDbg.metaUrl,
            sample: manifests
              .slice(0, 2)
              .map((m) => m.id)
              .join(","),
          })
          const packs = manifests
            .map((m) => ({
              id: m.id,
              name: m.name,
              ...(m.description ? { description: m.description } : {}),
              version: m.version,
              risk: m.risk,
              domains: m.domains,
              builtin: m.scope === "system",
              pinned: pinned.has(m.id),
            }))
            .sort((a, b) => a.id.localeCompare(b.id))
          dbgLog.info("packsAll: returning", { packs: packs.length })
          return { packs }
        },
        catch: (error) => {
          dbgLog.error("packsAll: failed", { error: error instanceof Error ? error.message : String(error) })
          return new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) })
        },
      })
    })

    const packsPin = Effect.fn("DeepAgentHttpApi.packsPin")(function* (ctx) {
      const memoryDir = yield* workspaceMemoryDir()
      return yield* Effect.try({
        try: () => {
          writePinned(memoryDir, [...readPinned(memoryDir), ctx.payload.packId])
          return { ok: true, packId: ctx.payload.packId }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const packsUnpin = Effect.fn("DeepAgentHttpApi.packsUnpin")(function* (ctx) {
      const memoryDir = yield* workspaceMemoryDir()
      return yield* Effect.try({
        try: () => {
          writePinned(
            memoryDir,
            readPinned(memoryDir).filter((id) => id !== ctx.payload.packId),
          )
          return { ok: true, packId: ctx.payload.packId }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    // V3.8.1 §G environment-fact use-gate handlers. The adoption service roots at the same gateway
    // baseDir the retriever reads, keyed by the active workspace path — so a project's adopt/reject
    // decisions are isolated per project (§G.8).
    const now = () => new Date().toISOString()

    const envFacts = Effect.fn("DeepAgentHttpApi.envFacts")(function* () {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => AgentGateway.DeepAgentKnowledgeSource.environmentFactAdoptionFor(dir).resolve(),
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const envFactsDecide = Effect.fn("DeepAgentHttpApi.envFactsDecide")(function* (ctx) {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => {
          const adoption = AgentGateway.DeepAgentKnowledgeSource.environmentFactAdoptionFor(dir)
          if (ctx.payload.decision === "adopt") adoption.adopt(ctx.payload.factId, now())
          else adoption.reject(ctx.payload.factId, now())
          return { ok: true, factId: ctx.payload.factId }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const envFactsModify = Effect.fn("DeepAgentHttpApi.envFactsModify")(function* (ctx) {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => {
          const adoption = AgentGateway.DeepAgentKnowledgeSource.environmentFactAdoptionFor(dir)
          const { updatedId } = adoption.modify({
            factId: ctx.payload.factId,
            description: ctx.payload.description,
            body: ctx.payload.body,
            ...(ctx.payload.domain !== undefined ? { domain: ctx.payload.domain } : {}),
            mode: ctx.payload.mode,
            now: now(),
          })
          return { ok: true, factId: updatedId }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    // ── V3.9 §C Expert Panel ────────────────────────────────────────────────
    const toVerdictResult = (v: PanelVerdict) => ({
      decision: v.decision,
      confidence: v.confidence,
      rounds: v.rounds,
      evidence: [...v.evidence],
      dissent: v.dissent.map((d) => ({
        lens: d.lens,
        verdict: d.verdict,
        confidence: d.confidence,
        findings: d.findings.map((f) => ({
          severity: f.severity,
          category: f.category,
          file: f.file ?? null,
          line: f.line ?? null,
          summary: f.summary,
          failureScenario: f.failureScenario,
          confidence: f.confidence,
        })),
      })),
    })

    const panelConsult = Effect.fn("DeepAgentHttpApi.panelConsult")(function* (ctx) {
      // §C: the panel is independently gated. Flag off ⇒ 400 (never silently run a disabled capability).
      if (!flags.experimentalExpertPanel)
        return yield* Effect.fail(new DeepAgentPromotionError({ message: "expert panel is disabled" }))
      const { sessionID } = ctx.payload
      const runTurn = yield* panelTurnRunnerFor(sessionID)
      // Clamp the requested debate depth to [1, PANEL_MAX_ROUNDS_CEILING]. The orchestrator already
      // floors/mins internally, but each round fans out one subagent turn PER lens, so an unbounded
      // client-supplied maxRounds would let one request spawn arbitrarily many panelist turns. Cap it
      // server-side (defense-in-depth) so a hostile/buggy client can't amplify a single consult.
      const requestedRounds = ctx.payload.maxRounds
      const maxRounds =
        requestedRounds != null
          ? Math.max(1, Math.min(PANEL_MAX_ROUNDS_CEILING, Math.floor(requestedRounds)))
          : undefined
      const verdict = yield* consultPanel(
        {
          question:
            ctx.payload.question ??
            "Review the current changes in this conversation for correctness, security, and design.",
          codeRefs: ctx.payload.codeRefs ? [...ctx.payload.codeRefs] : [],
          parentSessionID: sessionID,
          ...(ctx.payload.lenses ? { lenses: [...ctx.payload.lenses] } : {}),
          ...(maxRounds != null ? { maxRounds } : {}),
          ...(ctx.payload.policy ? { policy: ctx.payload.policy } : {}),
        },
        { runTurn },
      )
      return toVerdictResult(verdict)
    })

    // The global Expert Panel default (§C): the effective armed state falls back to this when a session
    // has never explicitly toggled. Read from the first-party SettingsStore (expertPanelDefault).
    const expertPanelDefault = () =>
      Effect.promise(() => SettingsStore.read()).pipe(Effect.map((s) => s.deepagent?.expertPanelDefault ?? false))

    const panelArm = Effect.fn("DeepAgentHttpApi.panelArm")(function* (ctx) {
      const { sessionID, armed, rounds } = ctx.payload
      AgentGateway.DeepAgentSessionState.setPanelArmed(sessionID, armed)
      // Persist the debate depth when arming (the three-state control's Single/Multi choice). On disarm
      // we leave the stored depth untouched so re-arming restores the user's last choice.
      if (armed && rounds) AgentGateway.DeepAgentSessionState.setPanelRounds(sessionID, rounds)
      const globalDefault = yield* expertPanelDefault()
      return {
        sessionID,
        armed: AgentGateway.DeepAgentSessionState.resolvePanelArmed(sessionID, globalDefault),
        rounds: AgentGateway.DeepAgentSessionState.panelRounds(sessionID),
      }
    })

    const panelStatus = Effect.fn("DeepAgentHttpApi.panelStatus")(function* (ctx) {
      const sessionID = ctx.query.sessionID
      const globalDefault = yield* expertPanelDefault()
      const choice = AgentGateway.DeepAgentSessionState.panelArmedChoice(sessionID)
      return {
        sessionID,
        armed: choice ?? globalDefault,
        explicit: choice != null,
        rounds: AgentGateway.DeepAgentSessionState.panelRounds(sessionID),
      }
    })

    // ── V3.9 §D Goal Loop lifecycle ─────────────────────────────────────────
    const goalStart = Effect.fn("DeepAgentHttpApi.goalStart")(function* (ctx) {
      if (!flags.experimentalGoalLoop)
        return yield* Effect.fail(new DeepAgentPromotionError({ message: "goal loop is disabled" }))
      type CriterionPayload = {
        kind: CompletionCriterion["kind"]
        commands?: readonly string[]
        maxSeverity?: string
        severityAtMost?: string
      }
      const criteria = ctx.payload.criteria?.map(
        (c: CriterionPayload) =>
          ({
            kind: c.kind,
            ...(c.commands ? { commands: [...c.commands] } : {}),
            ...(c.maxSeverity != null ? { maxSeverity: c.maxSeverity } : {}),
            ...(c.severityAtMost != null ? { severityAtMost: c.severityAtMost } : {}),
          }) as CompletionCriterion,
      )
      const snapshot = yield* goals
        .start({
          sessionID: ctx.payload.sessionID,
          ...(ctx.payload.objective != null ? { objective: ctx.payload.objective } : {}),
          ...(criteria ? { criteria } : {}),
          ...(ctx.payload.limits ? { limits: ctx.payload.limits } : {}),
          ...(ctx.payload.stallThreshold != null ? { stallThreshold: ctx.payload.stallThreshold } : {}),
        })
        .pipe(Effect.mapError((e) => new DeepAgentPromotionError({ message: e.reason })))
      return snapshot
    })

    // The goal MUTATION handlers gate on experimentalGoalLoop too (defense-in-depth, matching goalStart):
    // with the flag off no goal can be started, so these are already no-ops (getControl → null ⇒ ok:false),
    // but gating here makes the posture explicit and uniform across the whole goal-lifecycle surface.
    const goalPause = Effect.fn("DeepAgentHttpApi.goalPause")(function* (ctx) {
      if (!flags.experimentalGoalLoop) return { ok: false }
      return { ok: yield* goals.pause(ctx.payload.sessionID) }
    })
    const goalResume = Effect.fn("DeepAgentHttpApi.goalResume")(function* (ctx) {
      if (!flags.experimentalGoalLoop) return { ok: false }
      return { ok: yield* goals.resume(ctx.payload.sessionID) }
    })
    const goalStop = Effect.fn("DeepAgentHttpApi.goalStop")(function* (ctx) {
      if (!flags.experimentalGoalLoop) return { ok: false }
      return { ok: yield* goals.stop(ctx.payload.sessionID) }
    })
    const goalEditPlan = Effect.fn("DeepAgentHttpApi.goalEditPlan")(function* (ctx) {
      if (!flags.experimentalGoalLoop) {
        return yield* Effect.fail(new DeepAgentGoalPlanUnavailableError({ message: "goal loop is disabled" }))
      }
      const receipt = yield* goals
        .editPlan({
          sessionID: ctx.payload.sessionID,
          requestID: ctx.payload.request_id,
          planWrite: {
            operation: ctx.payload.plan_write.operation,
            expected_plan_id: ctx.payload.plan_write.expected_plan_id,
            expected_version: ctx.payload.plan_write.expected_version,
            goal: ctx.payload.plan_write.goal,
            assumptions: ctx.payload.plan_write.assumptions,
            steps: ctx.payload.plan_write.steps,
            active_step_id: ctx.payload.plan_write.active_step_id,
            ...(ctx.payload.plan_write.replan_reason !== undefined
              ? { replan_reason: ctx.payload.plan_write.replan_reason }
              : {}),
          },
          ...(ctx.payload.quality_challenge_id !== undefined
            ? { qualityChallengeID: ctx.payload.quality_challenge_id }
            : {}),
        })
        .pipe(Effect.mapError(mapGoalPlanError))
      return projectPlanReceipt(receipt)
    })
    const goalStatus = Effect.fn("DeepAgentHttpApi.goalStatus")(function* (ctx) {
      return { goal: yield* goals.status(ctx.query.sessionID) }
    })
    const goalStartable = Effect.fn("DeepAgentHttpApi.goalStartable")(function* (ctx) {
      return yield* goals.startable(ctx.query.sessionID)
    })

    // ── V3.9 §B Repo & Wiki ─────────────────────────────────────────────────
    // Read-only projection + governed knowledge edit + full-text search. All fail-closed on the wiki
    // flag. The graph union / search index / edit gate are all built from the active workspace dir.
    const requireWiki = Effect.fn("DeepAgentHttpApi.requireWiki")(function* () {
      if (!flags.experimentalWiki)
        return yield* Effect.fail(new DeepAgentPromotionError({ message: "wiki is disabled" }))
    })

    // Flatten a rendered WikiPage into the wire shape (crossLinks lists → plain arrays).
    const toWikiPageResult = (page: WikiPage) => ({
      docId: page.docId,
      type: page.type,
      title: page.title,
      markdown: page.markdown,
      editable: page.editable,
      version: page.version,
      crossLinks: {
        toCode: page.crossLinks.toCode.map((r) => ({
          docId: r.docId,
          rel: r.rel,
          path: r.path,
          line: r.line,
          symbolPath: r.symbolPath,
          stale: r.stale,
        })),
        toDocs: page.crossLinks.toDocs.map((r) => ({
          docId: r.docId,
          rel: r.rel,
          type: r.type,
          title: r.title,
          stale: r.stale,
        })),
      },
    })

    const wikiPages = Effect.fn("DeepAgentHttpApi.wikiPages")(function* (ctx) {
      yield* requireWiki()
      const workspacePath = yield* workspaceDir()
      const typeFilter = ctx.query.type
      const graph = openWikiGraph({ workspacePath })
      const pages = graph
        .allDocs()
        .filter((doc) => (typeFilter ? doc.type === typeFilter : true))
        .map((doc) => ({
          docId: doc.id,
          type: doc.type,
          title: doc.description,
          scope: doc.scope,
          editable: WIKI_EDITABLE_TYPES.has(doc.type),
          version: doc.version,
        }))
      return { pages }
    })

    const wikiPage = Effect.fn("DeepAgentHttpApi.wikiPage")(function* (ctx) {
      yield* requireWiki()
      const workspacePath = yield* workspaceDir()
      const service = openWikiService({ workspacePath })
      const page = yield* service
        .renderPage({ docId: ctx.query.docId, scope: ctx.query.scope })
        .pipe(Effect.mapError((e) => new DeepAgentPromotionError({ message: e.reason ?? "page not found" })))
      return toWikiPageResult(page)
    })

    const wikiSearch = Effect.fn("DeepAgentHttpApi.wikiSearch")(function* (ctx) {
      yield* requireWiki()
      const workspacePath = yield* workspaceDir()
      const index = openWikiSearchIndex({ workspacePath })
      // The index is a rebuildable projection with no auto-refresh — rebuild from the graph before the
      // query, then close the sqlite handle. Both are default-safe (never fail).
      yield* index.rebuild()
      const hits = yield* index.search({
        text: ctx.query.text,
        ...(ctx.query.type ? { type: ctx.query.type as WikiPage["type"] } : {}),
        ...(ctx.query.scope ? { scope: ctx.query.scope } : {}),
      })
      index.close()
      return {
        hits: hits.map((h) => ({ docId: h.docId, type: h.type, scope: h.scope, title: h.title, score: h.score })),
      }
    })

    const wikiEdit = Effect.fn("DeepAgentHttpApi.wikiEdit")(function* (ctx) {
      yield* requireWiki()
      const workspacePath = yield* workspaceDir()
      const memoryDir = yield* workspaceMemoryDir()
      // Inject the REAL evidence-gate (same validate() promotion uses) — not the trivial default.
      const service = openWikiService({ workspacePath, gate: buildWikiEditGate(memoryDir) })
      const page = yield* service
        .editKnowledge({
          docId: ctx.payload.docId,
          body: ctx.payload.body,
          editor: { id: ctx.payload.editor.id, ...(ctx.payload.editor.name ? { name: ctx.payload.editor.name } : {}) },
        })
        .pipe(Effect.mapError((e) => new DeepAgentPromotionError({ message: e.message })))
      return toWikiPageResult(page)
    })

    // §B.6 read side (T2.2): render a completed session's execution archive. The run-scoped trajectory
    // stores are only unioned into the graph when the sessionID is passed to openWikiService (see
    // openWikiGraph), so the archive is empty unless we thread sessionID through — which is exactly the
    // gap that made renderExecutionArchive unreachable before this route existed.
    const wikiExecutionArchive = Effect.fn("DeepAgentHttpApi.wikiExecutionArchive")(function* (ctx) {
      yield* requireWiki()
      const workspacePath = yield* workspaceDir()
      const service = openWikiService({ workspacePath, sessionID: ctx.query.sessionID })
      const archive = yield* service.renderExecutionArchive({ sessionId: ctx.query.sessionID })
      return {
        sessionId: archive.sessionId,
        title: archive.title,
        markdown: archive.markdown,
        entries: archive.entries.map((e) => ({
          docId: e.docId,
          type: e.type,
          title: e.title,
          body: e.body,
          version: e.version,
        })),
      }
    })

    return handlers
      .handle("reviews", reviews)
      .handle("promote", promote)
      .handle("reject", reject)
      .handle("knowledgePending", knowledgePending)
      .handle("knowledgeReviewSummary", knowledgeReviewSummary)
      .handle("knowledgeApprove", knowledgeApprove)
      .handle("knowledgeRejectIds", knowledgeRejectIds)
      .handle("knowledgeReleaseBaseline", knowledgeReleaseBaseline)
      .handle("knowledgeShipGate", knowledgeShipGate)
      .handle("packsActive", packsActive)
      .handle("packsAll", packsAll)
      .handle("packsPin", packsPin)
      .handle("packsUnpin", packsUnpin)
      .handle("envFacts", envFacts)
      .handle("envFactsDecide", envFactsDecide)
      .handle("envFactsModify", envFactsModify)
      .handle("panelConsult", panelConsult)
      .handle("panelArm", panelArm)
      .handle("panelStatus", panelStatus)
      .handle("goalStart", goalStart)
      .handle("goalPause", goalPause)
      .handle("goalResume", goalResume)
      .handle("goalStop", goalStop)
      .handle("goalEditPlan", goalEditPlan)
      .handle("goalStatus", goalStatus)
      .handle("goalStartable", goalStartable)
      .handle("wikiPages", wikiPages)
      .handle("wikiPage", wikiPage)
      .handle("wikiSearch", wikiSearch)
      .handle("wikiEdit", wikiEdit)
      .handle("wikiExecutionArchive", wikiExecutionArchive)
  }),
)
