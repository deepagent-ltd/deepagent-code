export * as LongContext from "./long-context"

import { and, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { SessionActivityEvidenceTable, SessionActivityObjectiveTable, SessionActivityPermissionRequestTable } from "../deepagent/activity-authority.sql"
import { SessionContextSelectionTable } from "../context-federation/session-sql"
import type { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionContextCheckpointTable, SessionModelPolicyReceiptTable } from "./long-context.sql"
import type { SessionSchema } from "./schema"
import { TaskRunTable } from "./sql"
import type { ModelHardPolicy } from "./runner/model-hard-policy"

type DB = Database.Interface["db"]

export const recordPolicy = Effect.fn("LongContext.recordPolicy")(function* (input: {
  readonly db: DB
  readonly sessionID: SessionSchema.ID
  readonly activityID: string
  readonly userMessageID: string
  readonly promptEpoch: number
  readonly requestHash: string
  readonly providerID: string
  readonly runtimeModelID: string
  readonly apiModelID: string
  readonly policy: ModelHardPolicy.Decision
  readonly estimatedFullRequestTokens: number
  readonly reservedOutputTokens: number
  readonly selectionID: string
  readonly projectionHash: string
  readonly graphSnapshotRefs: readonly string[]
  readonly offeredToolIDs: readonly string[]
  readonly degradedToolIDs: readonly string[]
}) {
  const receiptID = `model_policy_${Hash.sha256(CanonicalJson.stringify({
    sessionID: input.sessionID,
    activityID: input.activityID,
    promptEpoch: input.promptEpoch,
    requestHash: input.requestHash,
    policy: input.policy,
    estimatedFullRequestTokens: input.estimatedFullRequestTokens,
  }))}`
  yield* input.db.insert(SessionModelPolicyReceiptTable).values({
    receipt_id: receiptID,
    session_id: input.sessionID,
    activity_id: input.activityID,
    user_message_id: input.userMessageID,
    prompt_epoch: input.promptEpoch,
    request_hash: input.requestHash,
    provider_id: input.providerID,
    runtime_model_id: input.runtimeModelID,
    api_model_id: input.apiModelID,
    policy: input.policy,
    estimated_full_request_tokens: input.estimatedFullRequestTokens,
    estimator_version: "full_request_json_v1",
    reserved_output_tokens: input.reservedOutputTokens,
    context_selection_id: input.selectionID,
    context_projection_hash: input.projectionHash,
    graph_snapshot_refs: [...input.graphSnapshotRefs],
    offered_tool_ids: [...input.offeredToolIDs],
    degraded_tool_ids: [...input.degradedToolIDs],
    trigger_source: input.policy.state === "managed" && input.policy.action.startsWith("hard_gate") ? "threshold" : "none",
    created_at: Date.now(),
  }).onConflictDoNothing().pipe(Effect.orDie)
  return receiptID
})

export const settlePolicy = Effect.fn("LongContext.settlePolicy")(function* (
  db: DB,
  receiptID: string,
  outcome: { readonly checkpointID: string; readonly checkpointHash: string } | { readonly blockedReason: string },
) {
  yield* db.update(SessionModelPolicyReceiptTable).set(
    "blockedReason" in outcome
      ? { blocked_reason: outcome.blockedReason }
      : { checkpoint_id: outcome.checkpointID, checkpoint_hash: outcome.checkpointHash },
  ).where(eq(SessionModelPolicyReceiptTable.receipt_id, receiptID)).pipe(Effect.orDie)
})

export const bindProviderAttempt = Effect.fn("LongContext.bindProviderAttempt")(function* (
  db: DB,
  receiptID: string,
  providerAttemptID: string,
) {
  yield* db.update(SessionModelPolicyReceiptTable).set({ provider_attempt_id: providerAttemptID })
    .where(eq(SessionModelPolicyReceiptTable.receipt_id, receiptID)).pipe(Effect.orDie)
})

/** The EventV2 compaction-start fact is the durable run admission. This artifact is written after
 * that fact and before any summary provider work; Ended verifies the binding before epoch change. */
export const writeCheckpoint = Effect.fn("LongContext.writeCheckpoint")(function* (input: {
  readonly db: DB
  readonly sessionID: SessionSchema.ID
  readonly activityID: string
  readonly checkpointID: string
  readonly promptEpoch: number
  readonly sourceEndMessageID: string | null
  readonly selectionID: string
}) {
  const selection = yield* input.db.select({
    selectionID: SessionContextSelectionTable.selection_id,
    artifactRef: SessionContextSelectionTable.artifact_ref,
    projectionHash: SessionContextSelectionTable.projection_hash,
    graphRevisions: SessionContextSelectionTable.graph_revisions,
    graphStatuses: SessionContextSelectionTable.graph_statuses,
    selectedRefs: SessionContextSelectionTable.selected_refs,
  }).from(SessionContextSelectionTable).where(and(
    eq(SessionContextSelectionTable.selection_id, input.selectionID),
    eq(SessionContextSelectionTable.session_id, input.sessionID),
  )).get().pipe(Effect.orDie)
  if (!selection) return yield* Effect.fail(new Error("context_checkpoint_selection_missing"))
  const [objective, evidence, approvals, tasks] = yield* Effect.all([
    input.db.select({
      activityID: SessionActivityObjectiveTable.activity_id,
      version: SessionActivityObjectiveTable.version,
      state: SessionActivityObjectiveTable.state,
      nextAction: SessionActivityObjectiveTable.next_action,
    }).from(SessionActivityObjectiveTable).where(and(
      eq(SessionActivityObjectiveTable.activity_kind, "v2"),
      eq(SessionActivityObjectiveTable.activity_id, input.activityID),
      eq(SessionActivityObjectiveTable.session_id, input.sessionID),
    )).get().pipe(Effect.orDie),
    input.db.select({ fingerprint: SessionActivityEvidenceTable.evidence_fingerprint, kind: SessionActivityEvidenceTable.evidence_kind })
      .from(SessionActivityEvidenceTable).where(and(
        eq(SessionActivityEvidenceTable.activity_kind, "v2"),
        eq(SessionActivityEvidenceTable.activity_id, input.activityID),
      )).limit(100).all().pipe(Effect.orDie),
    input.db.select({ requestID: SessionActivityPermissionRequestTable.request_id, state: SessionActivityPermissionRequestTable.state })
      .from(SessionActivityPermissionRequestTable).where(and(
        eq(SessionActivityPermissionRequestTable.activity_kind, "v2"),
        eq(SessionActivityPermissionRequestTable.activity_id, input.activityID),
        eq(SessionActivityPermissionRequestTable.session_id, input.sessionID),
      )).limit(100).all().pipe(Effect.orDie),
    input.db.select({ runID: TaskRunTable.run_id, state: TaskRunTable.state, generation: TaskRunTable.generation })
      .from(TaskRunTable).where(and(
        eq(TaskRunTable.parent_session_id, input.sessionID),
        inArray(TaskRunTable.state, ["admitted", "provisioning", "researching", "finalizing", "queued", "running", "recovery_required"]),
      )).limit(100).all().pipe(Effect.orDie),
  ])
  const { hasRoot, planDocRef } = yield* Effect.promise(() => import("../deepagent/plan-store"))
  const plan = hasRoot()
    ? yield* Effect.sync(() => planDocRef(input.sessionID)).pipe(Effect.catchCause(() => Effect.succeed(null)))
    : null
  const content = {
    schema_version: "context_checkpoint.v1",
    checkpoint_id: input.checkpointID,
    session_id: input.sessionID,
    activity_id: input.activityID,
    from_prompt_epoch: input.promptEpoch,
    source_end_message_id: input.sourceEndMessageID,
    retained_tail_start_id: null,
    goal: {
      plan_ref: plan ? `doc:plan:${plan.id}@${plan.version}` : null,
      goal_ref: objective ? `activity_objective:v2:${objective.activityID}@${objective.version}` : null,
      state: objective?.state ?? null,
    },
    task_refs: tasks.map((item) => `task_run:${item.runID}@${item.generation}:${item.state}`).sort(),
    approval_refs: approvals.map((item) => `permission_request:${item.requestID}:${item.state}`).sort(),
    evidence_refs: evidence.map((item) => `activity_evidence:${item.kind}:${item.fingerprint}`).sort(),
    context_selection_refs: [
      `selection:${selection.selectionID}`,
      ...(selection.artifactRef ? [`artifact_ref_hash:${Hash.sha256(selection.artifactRef)}`] : []),
    ],
    source_selection_id: selection.selectionID,
    graph_revisions: selection.graphRevisions,
    graph_statuses: selection.graphStatuses,
    selected_refs: selection.selectedRefs,
    projection_hash: selection.projectionHash,
    open_items: objective?.nextAction ? [{ ref: `activity_objective:v2:${objective.activityID}@${objective.version}`, hash: Hash.sha256(objective.nextAction) }] : [],
    decisions: [],
    next_actions: objective?.nextAction ? [{ ref: `activity_objective:v2:${objective.activityID}@${objective.version}`, hash: Hash.sha256(objective.nextAction) }] : [],
    narrative_summary_ref: null,
    degraded: [
      ...(objective ? [] : ["goal_authority_unavailable"]),
      ...(plan ? [] : ["plan_authority_unavailable"]),
      "retained_tail_boundary_unbound",
      ...(selection.artifactRef ? [] : ["selection_artifact_unavailable"]),
    ],
  }
  const hash = Hash.sha256(CanonicalJson.stringify(content))
  yield* input.db.insert(SessionContextCheckpointTable).values({
    checkpoint_id: input.checkpointID,
    session_id: input.sessionID,
    activity_id: input.activityID,
    prompt_epoch: input.promptEpoch,
    content_hash: hash,
    content,
    created_at: Date.now(),
  }).onConflictDoNothing().pipe(Effect.orDie)
  yield* assertCheckpoint(input.db, input.sessionID, input.checkpointID, hash)
  return { checkpointID: input.checkpointID, checkpointHash: hash }
})

export const assertCheckpoint = Effect.fn("LongContext.assertCheckpoint")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  checkpointID: string,
  expectedHash: string,
) {
  const row = yield* db.select().from(SessionContextCheckpointTable)
    .where(and(eq(SessionContextCheckpointTable.checkpoint_id, checkpointID), eq(SessionContextCheckpointTable.session_id, sessionID)))
    .get().pipe(Effect.orDie)
  if (!row || row.content_hash !== expectedHash || Hash.sha256(CanonicalJson.stringify(row.content)) !== expectedHash)
    return yield* Effect.fail(new Error("context_checkpoint_hash_mismatch"))
  return row.content
})

export const sourceSelectionID = Effect.fn("LongContext.sourceSelectionID")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  checkpointID: string,
  checkpointHash: string,
) {
  const content = yield* assertCheckpoint(db, sessionID, checkpointID, checkpointHash)
  if (typeof content !== "object" || content === null || !("source_selection_id" in content) ||
      typeof content.source_selection_id !== "string")
    return yield* Effect.fail(new Error("context_checkpoint_source_selection_missing"))
  return content.source_selection_id
})
