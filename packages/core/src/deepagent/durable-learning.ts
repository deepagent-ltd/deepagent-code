export * as DeepAgentDurableLearning from "./durable-learning"

import path from "node:path"
import { existsSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { eq } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import { Database } from "../database/database"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { LearningWorker, type LearningGovernanceInput } from "./background-learning"
import {
  DurableKnowledgeStore,
  openUserGlobalStore,
  projectIdForWorkspace,
  type KnowledgeDocInput,
} from "./durable-knowledge-store"
import { DeepAgentLearningAdmissionOutbox } from "./learning-admission-outbox"
import { DeepAgentLearningGovernance } from "./learning-governance"
import { DeepAgentLearningJob } from "./learning-job"
import { DeepAgentLearningReviewerAttempt } from "./learning-reviewer-attempt"
import { extract, type LearningCandidate } from "./learning"
import { createInitialRoundState } from "./round-state"
import { DeepAgentCodeHome } from "./workspace"
import { writeFileAtomic, writeFileExclusive } from "./atomic-write"

type DatabaseClient = Database.Interface["db"]

const AgentMode = Schema.Union([
  Schema.Literal("general"),
  Schema.Literal("high"),
  Schema.Literal("xhigh"),
  Schema.Literal("max"),
  Schema.Literal("ultra"),
])
const Trigger = Schema.Union([
  Schema.Literal("idle"),
  Schema.Literal("pause"),
  Schema.Literal("project_switch"),
  Schema.Literal("session_finalization"),
])
const Policy = Schema.Union([Schema.Literal("auto_merge_safe_project"), Schema.Literal("manual_review")])
const Candidate = Schema.Struct({
  candidate_id: Schema.String,
  type: Schema.Union([
    Schema.Literal("memory"),
    Schema.Literal("strategy"),
    Schema.Literal("methodology"),
    Schema.Literal("anti_pattern"),
  ]),
  status: Schema.Union([Schema.Literal("staged"), Schema.Literal("rejected")]),
  source_run_id: Schema.String,
  source_round: Schema.Number,
  summary: Schema.String,
  evidence_refs: Schema.Array(Schema.String),
  confidence: Schema.Number,
})
const Diagnosis = Schema.Struct({
  round: Schema.Number,
  root_cause: Schema.NullOr(Schema.String),
  root_cause_category: Schema.optional(Schema.NullOr(Schema.String)),
  evidence_refs: Schema.Array(Schema.String),
  next_action: Schema.Union([
    Schema.Literal("continue"),
    Schema.Literal("revise"),
    Schema.Literal("rollback"),
    Schema.Literal("escalate"),
    Schema.Literal("complete"),
    Schema.Literal("block"),
  ]),
})
const ArtifactRef = Schema.Struct({
  schema_version: Schema.Literal("deepagent-code.learning_artifact_ref.v1"),
  authority_root: Schema.String,
  path: Schema.String,
  sha256: Schema.String,
})
const TerminalArtifact = Schema.Struct({
  schema_version: Schema.Literal("deepagent-code.learning_terminal_artifact.v1"),
  path: Schema.String,
  sha256: Schema.String,
  learning_admission_fingerprint: Schema.String,
})
const LifecycleTriggerArtifact = Schema.Struct({
  schema_version: Schema.Literal("deepagent-code.learning_lifecycle_trigger_artifact.v1"),
  path: Schema.String,
  sha256: Schema.String,
  learning_admission_fingerprint: Schema.String,
  source_terminal_path: Schema.String,
  source_terminal_sha256: Schema.String,
  source_learning_admission_fingerprint: Schema.String,
  source_admission_path: Schema.String,
  source_admission_sha256: Schema.String,
  trigger: Schema.Union([Schema.Literal("idle"), Schema.Literal("pause"), Schema.Literal("project_switch")]),
  boundary_key: Schema.String,
  boundary_subject: Schema.String,
  goal_id: Schema.NullOr(Schema.String),
  source_session_relation: Schema.Union([
    Schema.Literal("session"),
    Schema.Literal("parent"),
    Schema.Literal("workspace"),
  ]),
})
const LearningTerminalArtifact = Schema.Union([TerminalArtifact, LifecycleTriggerArtifact])
const AdmissionManifest = Schema.Struct({
  schema_version: Schema.Literal("deepagent-code.learning_input.v1"),
  base_dir: Schema.String,
  workspace_path: Schema.String,
  rejected_buffer_dir: Schema.NullOr(Schema.String),
  database_project_id: Schema.String,
  knowledge_project_id: Schema.String,
  session_id: Schema.String,
  run_id: Schema.String,
  mode: AgentMode,
  diagnoses: Schema.Array(Diagnosis),
  total_rounds: Schema.Number,
  final_status: Schema.Union([Schema.Literal("completed"), Schema.Literal("failed")]),
  trigger: Trigger,
  policy: Policy,
  terminal_artifact: LearningTerminalArtifact,
})
const AdmissionIntent = Schema.Struct({
  schema_version: Schema.Literal("deepagent-code.learning_admission_intent.v1"),
  base_dir: Schema.String,
  workspace_path: Schema.String,
  rejected_buffer_dir: Schema.NullOr(Schema.String),
  requested_project_id: Schema.String,
  session_id: Schema.String,
  run_id: Schema.String,
  mode: AgentMode,
  diagnoses: Schema.Array(Diagnosis),
  total_rounds: Schema.Number,
  final_status: Schema.Union([Schema.Literal("completed"), Schema.Literal("failed")]),
  trigger: Trigger,
  policy: Policy,
  terminal_artifact: LearningTerminalArtifact,
})
const LocalAdmissionReceipt = Schema.Struct({
  schema_version: Schema.Literal("deepagent-code.learning_admission_receipt.v1"),
  state: Schema.Union([
    Schema.Literal("local_pending"),
    Schema.Literal("durable_pending"),
    Schema.Literal("submitted"),
  ]),
  admission_intent: AdmissionIntent,
  last_error: Schema.NullOr(
    Schema.Struct({
      code: Schema.String,
      detail: Schema.String,
    }),
  ),
  updated_at: Schema.String,
})
const ExtractionManifest = Schema.Struct({
  schema_version: Schema.Literal("deepagent-code.learning_extraction.v1"),
  job_id: Schema.String,
  run_id: Schema.String,
  phase: Schema.Literal("extraction"),
  source_input_ref: Schema.String,
  candidates: Schema.Array(Candidate),
  promotion_decision: Schema.Union([
    Schema.Literal("staged"),
    Schema.Literal("rejected"),
    Schema.Literal("needs_review"),
  ]),
  rejection_reasons: Schema.Array(Schema.String),
})
const ReviewManifest = Schema.Struct({
  schema_version: Schema.Literal("deepagent-code.learning_review.v1"),
  job_id: Schema.String,
  run_id: Schema.String,
  phase: Schema.Literal("reviewer"),
  review_job_id: Schema.String,
  source_extraction_ref: Schema.String,
  request_ref: Schema.optional(Schema.String),
  response_hash: Schema.optional(Schema.String),
  provider_id: Schema.optional(Schema.String),
  model_id: Schema.optional(Schema.String),
  policy_hash: Schema.optional(Schema.String),
  disposition: Schema.Union([Schema.Literal("isolated_reviewer"), Schema.Literal("reviewer_unavailable_fail_closed")]),
  verdict: Schema.optional(
    Schema.Union([Schema.Literal("approve"), Schema.Literal("reject"), Schema.Literal("manual_review")]),
  ),
  selected_candidate_ids: Schema.optional(Schema.Array(Schema.String)),
  candidates: Schema.Array(Candidate),
})
const GovernanceDocumentPayload = Schema.Struct({
  document: Schema.Unknown,
  decision: Schema.optional(Schema.Union([Schema.Literal("auto_admit"), Schema.Literal("manual_review")])),
  review_ref: Schema.optional(Schema.String),
})
const GovernanceInboxPayload = Schema.Struct({
  item: Schema.Unknown,
  path: Schema.String,
  content: Schema.String,
  content_hash: Schema.String,
})

type AdmissionManifest = Schema.Schema.Type<typeof AdmissionManifest>
type AdmissionIntent = Schema.Schema.Type<typeof AdmissionIntent>
export type LocalAdmissionReceipt = Schema.Schema.Type<typeof LocalAdmissionReceipt>
type ExtractionManifest = Schema.Schema.Type<typeof ExtractionManifest>
type ReviewManifest = Schema.Schema.Type<typeof ReviewManifest>
type ArtifactRef = Schema.Schema.Type<typeof ArtifactRef>
type TerminalArtifact = Schema.Schema.Type<typeof LearningTerminalArtifact>
type Decoder<A> = (input: unknown) => Option.Option<A>
type ArtifactPlan = {
  readonly authorityRoot: string
  readonly path: string
  readonly content: string
  readonly ref: string
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeArtifactRef = Schema.decodeUnknownOption(ArtifactRef)
const decodeAdmissionManifest = Schema.decodeUnknownOption(AdmissionManifest)
const decodeAdmissionIntent = Schema.decodeUnknownOption(AdmissionIntent)
const decodeLocalAdmissionReceipt = Schema.decodeUnknownOption(LocalAdmissionReceipt)
const decodeExtractionManifest = Schema.decodeUnknownOption(ExtractionManifest)
const decodeReviewManifest = Schema.decodeUnknownOption(ReviewManifest)
const decodeString = Schema.decodeUnknownOption(Schema.String)
const decodeGovernanceDocumentPayload = Schema.decodeUnknownOption(GovernanceDocumentPayload)
const decodeGovernanceInboxPayload = Schema.decodeUnknownOption(GovernanceInboxPayload)

export type Admission = {
  readonly baseDir: string
  readonly workspacePath: string
  readonly rejectedBufferDir?: string | null
  readonly terminalArtifact: TerminalArtifact
  readonly input: LearningGovernanceInput
}

/**
 * Binds a local learning receipt to the immutable run identity and its terminal
 * artifact without including the terminal artifact hash itself (which would be
 * circular because the fingerprint is persisted inside that artifact).
 */
export const admissionFingerprint = (admission: Admission): string =>
  Hash.sha256(
    CanonicalJson.stringify({
      schema_version: "deepagent-code.learning_admission_binding.v1",
      base_dir: path.resolve(admission.baseDir),
      workspace_path: path.resolve(admission.workspacePath),
      rejected_buffer_dir: admission.rejectedBufferDir ? path.resolve(admission.rejectedBufferDir) : null,
      requested_project_id: admission.input.projectID,
      session_id: admission.input.sessionID,
      run_id: admission.input.runID,
      mode: admission.input.mode,
      diagnoses: admission.input.roundState.diagnoses,
      total_rounds: admission.input.totalRounds,
      final_status: admission.input.finalStatus,
      trigger: admission.input.trigger,
      policy: admission.input.policy ?? "auto_merge_safe_project",
      terminal_schema_version: admission.terminalArtifact.schema_version,
      terminal_path: path.resolve(admission.terminalArtifact.path),
      ...(admission.terminalArtifact.schema_version === "deepagent-code.learning_lifecycle_trigger_artifact.v1"
        ? {
            lifecycle_boundary_key: admission.terminalArtifact.boundary_key,
            lifecycle_boundary_subject: admission.terminalArtifact.boundary_subject,
            lifecycle_source_session_relation: admission.terminalArtifact.source_session_relation,
            lifecycle_goal_id: admission.terminalArtifact.goal_id,
            lifecycle_source_admission_path: path.resolve(admission.terminalArtifact.source_admission_path),
            lifecycle_source_admission_sha256: admission.terminalArtifact.source_admission_sha256,
          }
        : {}),
    }),
  )

export const localAdmissionReceipt = (
  admission: Admission,
  state: LocalAdmissionReceipt["state"],
  lastError: LocalAdmissionReceipt["last_error"] = null,
): LocalAdmissionReceipt => ({
  schema_version: "deepagent-code.learning_admission_receipt.v1",
  state,
  admission_intent: admissionIntent(admission),
  last_error: lastError,
  updated_at: new Date().toISOString(),
})

export const admissionFromLocalReceipt = (input: unknown) => {
  const receipt = decodeLocalAdmissionReceipt(input)
  if (Option.isNone(receipt)) return undefined
  return { receipt: receipt.value, admission: fromIntent(receipt.value.admission_intent) }
}

/**
 * Validate a receipt before handing it to a recovery authority. The durable
 * authority repeats the terminal verification during reconciliation, but the
 * gateway must reject forged or cross-run local receipts even when its injected
 * authority is only a test/process boundary.
 */
export const validateLocalAdmissionReceipt = async (admission: Admission, expectedRunDir: string): Promise<boolean> => {
  if (admission.terminalArtifact.schema_version !== "deepagent-code.learning_terminal_artifact.v1") return false
  const runDir = path.resolve(expectedRunDir)
  const expectedRunID = path.basename(runDir)
  const terminalPath = path.join(runDir, "DEEPAGENT_RUN_STATE.json")
  if (admission.input.runID !== expectedRunID) return false
  if (path.resolve(admission.terminalArtifact.path) !== terminalPath) return false
  if (!/^[0-9a-f]{64}$/.test(admission.terminalArtifact.sha256)) return false
  if (!/^[0-9a-f]{64}$/.test(admission.terminalArtifact.learning_admission_fingerprint)) return false
  const expectedFingerprint = admissionFingerprint(admission)
  if (admission.terminalArtifact.learning_admission_fingerprint !== expectedFingerprint) return false

  const [runReal, terminalReal] = await Promise.all([
    realpath(runDir).catch(() => undefined),
    realpath(terminalPath).catch(() => undefined),
  ])
  if (!runReal || terminalReal !== path.join(runReal, "DEEPAGENT_RUN_STATE.json")) return false

  const content = await Bun.file(terminalPath)
    .text()
    .catch(() => undefined)
  if (content === undefined || Hash.sha256(content) !== admission.terminalArtifact.sha256) return false
  const decoded = decodeJson(content)
  if (Option.isNone(decoded) || typeof decoded.value !== "object" || decoded.value === null) return false
  const value = decoded.value as Record<string, unknown>
  return (
    value.schema_version === "deepagent_global_run_state.v1" &&
    value.run_id === admission.input.runID &&
    value.generic_agent_session_id === admission.input.sessionID &&
    value.agent_mode === admission.input.mode &&
    value.state === admission.input.finalStatus &&
    value.learning_admission_fingerprint === expectedFingerprint
  )
}

export type DrainInput = {
  readonly owner: string
  readonly authorityRoot: string
  readonly reviewer?: ReviewerPort
  readonly reviewerForWorkspace?: (workspacePath: string) => ReviewerPort | undefined
  readonly leaseMs?: number
  readonly limit?: number
}

export type ReviewerPort = {
  readonly identity: (input: {
    readonly attemptId: string
    readonly jobId: string
    readonly workspacePath: string
  }) => Effect.Effect<
    {
      readonly reviewSessionId: string
      readonly providerId: string
      readonly modelId: string
      readonly policyHash: string
    },
    unknown
  >
  readonly execute: (input: {
    readonly attemptId: string
    readonly reviewSessionId: string
    readonly workspacePath: string
    readonly providerId: string
    readonly modelId: string
    readonly policyHash: string
    readonly requestRef: string
    readonly request: string
  }) => Effect.Effect<
    {
      readonly verdict: DeepAgentLearningReviewerAttempt.Verdict
      readonly selectedCandidateIds: readonly string[]
    },
    unknown
  >
}

export type ReconcileInput = {
  readonly authorityRoot: string
  readonly limit?: number
}

export class AdmissionRejectedError extends Schema.TaggedErrorClass<AdmissionRejectedError>()(
  "DeepAgentDurableLearning.AdmissionRejectedError",
  { intentId: Schema.String, code: Schema.String, detail: Schema.String },
) {}

export class TerminalArtifactPendingError extends Schema.TaggedErrorClass<TerminalArtifactPendingError>()(
  "DeepAgentDurableLearning.TerminalArtifactPendingError",
  { intentId: Schema.String, path: Schema.String },
) {}

export const record = Effect.fn("DeepAgentDurableLearning.record")(function* (
  db: DatabaseClient,
  admission: Admission,
) {
  const intent = admissionIntent(admission)
  return yield* DeepAgentLearningAdmissionOutbox.record(db, {
    sessionId: intent.session_id,
    runId: intent.run_id,
    trigger: intent.trigger,
    dedupeKey: `${intent.trigger}:${intent.session_id}:${intent.run_id}`,
    payload: intent,
  })
})

export const admit = Effect.fn("DeepAgentDurableLearning.admit")(function* (
  db: DatabaseClient,
  admission: Admission,
  input: { readonly authorityRoot: string },
) {
  const intent = yield* record(db, admission)
  return yield* reconcileIntent(db, intent.intent, path.resolve(input.authorityRoot))
})

export const reconcile = Effect.fn("DeepAgentDurableLearning.reconcile")(function* (
  db: DatabaseClient,
  input: ReconcileInput,
) {
  const authorityRoot = path.resolve(input.authorityRoot)
  const intents = yield* DeepAgentLearningAdmissionOutbox.pending(db, input)
  return yield* Effect.forEach(intents, (intent) =>
    reconcileIntent(db, intent, authorityRoot).pipe(
      Effect.as(intent.intentId),
      Effect.catch((error) => {
        if (error instanceof AdmissionRejectedError || error instanceof TerminalArtifactPendingError) {
          return Effect.succeed(intent.intentId)
        }
        return Effect.fail(error)
      }),
    ),
  )
})

const reconcileIntent = Effect.fn("DeepAgentDurableLearning.reconcileIntent")(function* (
  db: DatabaseClient,
  intent: DeepAgentLearningAdmissionOutbox.Record,
  authorityRoot: string,
) {
  if (intent.state === "admitted") {
    const job = intent.jobId ? yield* DeepAgentLearningJob.get(db, intent.jobId) : undefined
    if (job) return { created: false, job } as const
    return yield* new DeepAgentLearningAdmissionOutbox.FenceError({
      intentId: intent.intentId,
      reason: "admitted intent is missing its exact learning job",
    })
  }
  if (intent.state === "rejected") {
    return yield* new AdmissionRejectedError({
      intentId: intent.intentId,
      code: intent.rejectionCode!,
      detail: intent.rejectionDetail!,
    })
  }

  const outcome = yield* reconcilePendingIntent(db, intent, authorityRoot).pipe(Effect.exit)
  if (outcome._tag === "Success") return outcome.value
  const error = Cause.squash(outcome.cause)
  if (error instanceof TerminalArtifactPendingError) return yield* error
  yield* rejectIntent(db, intent, error)
  return yield* new AdmissionRejectedError({
    intentId: intent.intentId,
    code: rejectionCode(error),
    detail: errorDetail(error),
  })
})

const reconcilePendingIntent = Effect.fn("DeepAgentDurableLearning.reconcilePendingIntent")(function* (
  db: DatabaseClient,
  intent: DeepAgentLearningAdmissionOutbox.Record,
  authorityRoot: string,
) {
  const admission = decode(decodeAdmissionIntent, intent.payloadJson)
  yield* verifyAdmissionRoot(admission, authorityRoot)
  const session = yield* requireCanonicalSession(db, fromIntent(admission))
  yield* verifyTerminalArtifact(intent.intentId, admission, authorityRoot)
  const manifest = admissionManifest(fromIntent(admission), session)
  const run = new DeepAgentCodeHome(manifest.base_dir).ensureRun(
    manifest.knowledge_project_id,
    manifest.session_id,
    manifest.run_id,
  )
  const candidateInputRef = yield* Effect.promise(() =>
    writeArtifact(manifest.base_dir, run.artifactsDir, "learning-input", manifest),
  )
  const enqueued = yield* DeepAgentLearningJob.enqueueAdmitted(db, {
    projectId: manifest.database_project_id,
    sessionId: manifest.session_id,
    runId: manifest.run_id,
    trigger: manifest.trigger,
    dedupeKey: `${manifest.trigger}:${manifest.database_project_id}:${manifest.session_id}:${manifest.run_id}`,
    candidateInputRef,
    policy: manifest.policy,
    intentId: intent.intentId,
    payloadFingerprint: intent.payloadFingerprint,
  })
  return enqueued
})

export const drain = Effect.fn("DeepAgentDurableLearning.drain")(function* (db: DatabaseClient, input: DrainInput) {
  yield* requireText("owner", input.owner)
  const leaseMs = input.leaseMs ?? 30_000
  const limit = input.limit ?? 32
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return yield* new DeepAgentLearningJob.InputError({ field: "limit", reason: "must be a positive safe integer" })
  }
  const authorityRoot = path.resolve(input.authorityRoot)
  yield* reconcile(db, { limit, authorityRoot })
  yield* DeepAgentLearningReviewerAttempt.recoverStaleDispatching(db)
  const preparedReview = yield* DeepAgentLearningReviewerAttempt.takeoverPrepared(db, {
    owner: input.owner,
    leaseMs,
  })
  if (preparedReview) {
    const job = yield* DeepAgentLearningJob.get(db, preparedReview.jobId)
    if (!job) {
      return yield* new DeepAgentLearningJob.FenceError({
        jobId: preparedReview.jobId,
        reason: "prepared reviewer job disappeared",
      })
    }
    const admission = yield* readBoundAdmission(job, authorityRoot)
    const reviewer = input.reviewer ?? input.reviewerForWorkspace?.(admission.workspace_path)
    if (!reviewer) {
      return yield* new DeepAgentLearningJob.FenceError({
        jobId: preparedReview.jobId,
        reason: "prepared isolated reviewer has no runtime port",
      })
    }
    const reviewed = yield* resumePreparedReview(
      db,
      job,
      admission,
      leaseMs,
      reviewer,
      preparedReview.attempt,
      preparedReview.jobVersion,
    )
    const completed = yield* governancePhase(db, reviewed, admission, leaseMs)
    return yield* drainNext(
      db,
      {
        owner: input.owner,
        authorityRoot,
        leaseMs,
        reviewer: input.reviewer,
        reviewerForWorkspace: input.reviewerForWorkspace,
      },
      limit - 1,
      [completed],
    )
  }
  yield* recoverGovernanceCompensations(db, { owner: input.owner, authorityRoot, leaseMs })
  yield* recoverArtifactSideEffects(db, { authorityRoot })
  yield* DeepAgentLearningJob.recoverStale(db)
  const resumed = yield* DeepAgentLearningGovernance.takeoverNext(db, {
    owner: input.owner,
    leaseMs,
  })
  if (resumed) {
    const job = yield* DeepAgentLearningJob.get(db, resumed.plan.jobId)
    if (!job)
      return yield* new DeepAgentLearningJob.FenceError({ jobId: resumed.plan.jobId, reason: "job disappeared" })
    const admission = yield* readBoundAdmission(job, authorityRoot)
    const completed = yield* governancePhase(db, job, admission, leaseMs)
    return yield* drainNext(
      db,
      {
        owner: input.owner,
        authorityRoot,
        leaseMs,
        reviewer: input.reviewer,
        reviewerForWorkspace: input.reviewerForWorkspace,
      },
      limit - 1,
      [completed],
    )
  }
  return yield* drainNext(
    db,
    {
      owner: input.owner,
      authorityRoot,
      leaseMs,
      reviewer: input.reviewer,
      reviewerForWorkspace: input.reviewerForWorkspace,
    },
    limit,
    [],
  )
})

export const recoverGovernanceCompensations = Effect.fn("DeepAgentDurableLearning.recoverGovernanceCompensations")(
  function* (
    db: DatabaseClient,
    input: { readonly owner: string; readonly authorityRoot: string; readonly leaseMs: number },
  ) {
    return yield* recoverGovernanceCompensationsLoop(db, input)
  },
)

function recoverGovernanceCompensationsLoop(
  db: DatabaseClient,
  input: { readonly owner: string; readonly authorityRoot: string; readonly leaseMs: number },
): Effect.Effect<readonly DeepAgentLearningGovernance.CompensationRecord[], unknown> {
  return Effect.gen(function* () {
    const compensation = yield* DeepAgentLearningGovernance.claimNextCompensation(db, input)
    if (!compensation) return [] as const
    const action = yield* DeepAgentLearningGovernance.getAction(db, compensation.actionId)
    const plan = yield* DeepAgentLearningGovernance.get(db, compensation.planId)
    if (!action || !plan || action.payloadFingerprint !== compensation.sourcePayloadFingerprint) {
      yield* DeepAgentLearningGovernance.failCompensation(db, {
        compensationId: compensation.compensationId,
        owner: input.owner,
        expectedVersion: compensation.version,
        errorCode: "governance_compensation_identity_mismatch",
        errorDetail: compensation.actionId,
      })
      return [compensation] as const
    }
    const job = yield* DeepAgentLearningJob.get(db, plan.plan.jobId)
    if (!job) return yield* new DeepAgentLearningJob.FenceError({ jobId: plan.plan.jobId, reason: "job disappeared" })
    const admission = yield* readBoundAdmission(job, path.resolve(input.authorityRoot))
    const store = new DurableKnowledgeStore(
      path.join(
        new DeepAgentCodeHome(admission.base_dir).ensureProject(
          admission.knowledge_project_id,
          admission.workspace_path,
        ).root,
        "knowledge",
      ),
    )
    const result = yield* applyGovernanceCompensation(compensation, action, store, input.authorityRoot).pipe(
      Effect.exit,
    )
    if (result._tag === "Failure") {
      yield* DeepAgentLearningGovernance.failCompensation(db, {
        compensationId: compensation.compensationId,
        owner: input.owner,
        expectedVersion: compensation.version,
        errorCode: "governance_compensation_apply_failed",
        errorDetail: Cause.pretty(result.cause),
      })
      return yield* Effect.failCause(result.cause)
    }
    yield* DeepAgentLearningGovernance.settleCompensation(db, {
      compensationId: compensation.compensationId,
      owner: input.owner,
      expectedVersion: compensation.version,
      resultRef: result.value.ref,
      resultHash: result.value.hash,
    })
    return [compensation, ...(yield* recoverGovernanceCompensationsLoop(db, input))] as const
  })
}

function drainNext(
  db: DatabaseClient,
  input: {
    readonly owner: string
    readonly authorityRoot: string
    readonly leaseMs: number
    readonly reviewer?: ReviewerPort
    readonly reviewerForWorkspace?: (workspacePath: string) => ReviewerPort | undefined
  },
  remaining: number,
  completed: readonly DeepAgentLearningJob.Record[],
): Effect.Effect<readonly DeepAgentLearningJob.Record[], unknown> {
  if (remaining === 0) return Effect.succeed(completed)
  return DeepAgentLearningJob.claim(db, input).pipe(
    Effect.flatMap((claimed) => {
      if (!claimed) return Effect.succeed(completed)
      return processClaim(
        db,
        claimed,
        input.authorityRoot,
        input.leaseMs,
        input.reviewer,
        input.reviewerForWorkspace,
      ).pipe(Effect.flatMap((settled) => drainNext(db, input, remaining - 1, [...completed, settled])))
    }),
  )
}

const processClaim = Effect.fn("DeepAgentDurableLearning.processClaim")(function* (
  db: DatabaseClient,
  claimed: DeepAgentLearningJob.Record,
  authorityRoot: string,
  leaseMs: number,
  reviewer?: ReviewerPort,
  reviewerForWorkspace?: (workspacePath: string) => ReviewerPort | undefined,
) {
  const admission = yield* readBoundAdmission(claimed, authorityRoot)
  const selectedReviewer = reviewer ?? reviewerForWorkspace?.(admission.workspace_path)
  const extracted = claimed.state === "running" ? yield* extractPhase(db, claimed, admission, leaseMs) : claimed
  const reviewed =
    extracted.state === "reviewing"
      ? yield* reviewPhase(db, extracted, admission, leaseMs, selectedReviewer)
      : extracted
  if (reviewed.state !== "governance") {
    return yield* new DeepAgentLearningJob.FenceError({
      jobId: reviewed.jobId,
      reason: `claimed learning job stopped in unexpected state ${reviewed.state}`,
    })
  }
  return yield* governancePhase(db, reviewed, admission, leaseMs)
})

export const recoverArtifactSideEffects = Effect.fn("DeepAgentDurableLearning.recoverArtifactSideEffects")(function* (
  db: DatabaseClient,
  input: { readonly authorityRoot: string; readonly now?: number },
) {
  const authorityRoot = path.resolve(input.authorityRoot)
  const jobs = yield* DeepAgentLearningJob.staleArtifactSideEffects(db, input)
  return yield* Effect.forEach(jobs, (job) =>
    Effect.gen(function* () {
      const admission = yield* readBoundAdmission(job, authorityRoot)
      const artifact = yield* expectedArtifact(job, admission)
      if (artifact.ref !== job.expectedResultRef) {
        return yield* new DeepAgentLearningJob.FenceError({
          jobId: job.jobId,
          reason: "stale learning phase expected artifact does not match its deterministic plan",
        })
      }
      yield* Effect.promise(() => publishArtifact(artifact))
      return yield* DeepAgentLearningJob.reconcileArtifactSideEffect(db, {
        jobId: job.jobId,
        expectedVersion: job.version,
        state: job.state as "running" | "reviewing",
        kind: job.sideEffectKind as "extraction" | "reviewer",
        expectedResultRef: artifact.ref,
        ...(input.now === undefined ? {} : { now: input.now }),
      })
    }).pipe(
      Effect.catchCause((cause) =>
        DeepAgentLearningJob.get(db, job.jobId).pipe(
          Effect.flatMap((current) => {
            if (
              current &&
              (current.version !== job.version ||
                current.state !== job.state ||
                current.sideEffectState !== job.sideEffectState ||
                current.sideEffectKind !== job.sideEffectKind ||
                current.expectedResultRef !== job.expectedResultRef)
            ) {
              return Effect.succeed(current)
            }
            return DeepAgentLearningJob.quarantineArtifactSideEffect(db, {
              jobId: job.jobId,
              expectedVersion: job.version,
              code: "artifact_reconciliation_mismatch",
              detail: errorDetail(Cause.squash(cause)),
              ...(input.now === undefined ? {} : { now: input.now }),
            })
          }),
        ),
      ),
    ),
  )
})

const expectedArtifact = Effect.fn("DeepAgentDurableLearning.expectedArtifact")(function* (
  job: DeepAgentLearningJob.Record,
  admission: AdmissionManifest,
) {
  if (job.state === "running" && job.sideEffectKind === "extraction") {
    return extractionArtifact(job, admission)
  }
  if (
    job.state === "reviewing" &&
    job.sideEffectKind === "reviewer" &&
    job.reviewJobId === `review-unavailable:${job.jobId}`
  ) {
    const extraction = yield* readBoundExtraction(job, admission)
    return artifactPlan(admission.base_dir, artifactDirectory(admission), "learning-review", {
      schema_version: "deepagent-code.learning_review.v1",
      job_id: job.jobId,
      run_id: admission.run_id,
      phase: "reviewer",
      review_job_id: job.reviewJobId,
      source_extraction_ref: job.resultRef!,
      disposition: "reviewer_unavailable_fail_closed",
      candidates: extraction.candidates,
    } satisfies ReviewManifest)
  }
  return yield* new DeepAgentLearningJob.FenceError({
    jobId: job.jobId,
    reason: "stale learning phase has no deterministic artifact protocol",
  })
})

const extractPhase = Effect.fn("DeepAgentDurableLearning.extractPhase")(function* (
  db: DatabaseClient,
  job: DeepAgentLearningJob.Record,
  admission: AdmissionManifest,
  leaseMs: number,
) {
  const artifact = extractionArtifact(job, admission)
  const started = yield* DeepAgentLearningJob.beginSideEffect(db, {
    jobId: job.jobId,
    owner: job.owner!,
    expectedVersion: job.version,
    state: "running",
    kind: "extraction",
    expectedResultRef: artifact.ref,
    leaseMs,
  })
  yield* Effect.promise(() => publishArtifact(artifact))
  const settled = yield* DeepAgentLearningJob.settleSideEffect(db, {
    jobId: job.jobId,
    owner: job.owner!,
    expectedVersion: started.version,
    resultRef: artifact.ref,
  })
  return yield* DeepAgentLearningJob.advance(db, {
    jobId: job.jobId,
    owner: job.owner!,
    expectedVersion: settled.version,
    state: "reviewing",
    leaseMs,
  })
})

const reviewPhase = Effect.fn("DeepAgentDurableLearning.reviewPhase")(function* (
  db: DatabaseClient,
  job: DeepAgentLearningJob.Record,
  admission: AdmissionManifest,
  leaseMs: number,
  reviewer?: ReviewerPort,
) {
  const extraction = yield* readBoundExtraction(job, admission)
  const reviewJobId = reviewer ? `review:${job.jobId}` : `review-unavailable:${job.jobId}`
  if (reviewer) {
    const request = CanonicalJson.stringify({
      schema_version: "deepagent-code.learning_review_request.v1",
      candidates: extraction.candidates.map((candidate) => ({
        candidate_id: candidate.candidate_id,
        type: candidate.type,
        summary: Array.from(candidate.summary).slice(0, 512).join(""),
        evidence_refs: candidate.evidence_refs,
        source_run_id: candidate.source_run_id,
        confidence: candidate.confidence,
      })),
      instructions: "Return verdict and selected_candidate_ids. Never invent candidates or modify evidence.",
    })
    const requestRef = yield* Effect.promise(() =>
      writeArtifact(admission.base_dir, artifactDirectory(admission), "learning-review-request", request),
    )
    const identity = yield* reviewer.identity({
      attemptId: reviewJobId,
      jobId: job.jobId,
      workspacePath: admission.workspace_path,
    })
    const prepared = yield* DeepAgentLearningReviewerAttempt.prepare(db, {
      attemptId: reviewJobId,
      jobId: job.jobId,
      owner: job.owner!,
      expectedJobVersion: job.version,
      leaseMs,
      reviewSessionId: identity.reviewSessionId,
      requestRef,
      requestHash: Hash.sha256(request),
      sourceCandidateIds: extraction.candidates.map((candidate) => candidate.candidate_id),
      providerId: identity.providerId,
      modelId: identity.modelId,
      policyHash: identity.policyHash,
    })
    return yield* executePreparedReview(
      db,
      job,
      admission,
      extraction,
      leaseMs,
      reviewer,
      prepared.attempt,
      prepared.jobVersion,
      request,
    )
  }
  const artifact = artifactPlan(admission.base_dir, artifactDirectory(admission), "learning-review", {
    schema_version: "deepagent-code.learning_review.v1",
    job_id: job.jobId,
    run_id: admission.run_id,
    phase: "reviewer",
    review_job_id: reviewJobId,
    source_extraction_ref: job.resultRef!,
    disposition: "reviewer_unavailable_fail_closed",
    candidates: extraction.candidates,
  } satisfies ReviewManifest)
  const started = yield* DeepAgentLearningJob.beginSideEffect(db, {
    jobId: job.jobId,
    owner: job.owner!,
    expectedVersion: job.version,
    state: "reviewing",
    kind: "reviewer",
    expectedResultRef: artifact.ref,
    reviewJobId,
    leaseMs,
  })
  // No isolated model reviewer is wired yet. Preserve the immutable extracted candidates and let
  // governance auto-admit only the safe subset while retaining review-required candidates pending.
  yield* Effect.promise(() => publishArtifact(artifact))
  const settled = yield* DeepAgentLearningJob.settleSideEffect(db, {
    jobId: job.jobId,
    owner: job.owner!,
    expectedVersion: started.version,
    resultRef: artifact.ref,
  })
  return yield* DeepAgentLearningJob.advance(db, {
    jobId: job.jobId,
    owner: job.owner!,
    expectedVersion: settled.version,
    state: "governance",
    leaseMs,
  })
})

const resumePreparedReview = Effect.fn("DeepAgentDurableLearning.resumePreparedReview")(function* (
  db: DatabaseClient,
  job: DeepAgentLearningJob.Record,
  admission: AdmissionManifest,
  leaseMs: number,
  reviewer: ReviewerPort,
  attempt: DeepAgentLearningReviewerAttempt.Record,
  jobVersion: number,
) {
  const extraction = yield* readBoundExtraction(job, admission)
  const frozen = yield* readArtifact(attempt.requestRef, admission.base_dir, decodeString)
  if (
    Hash.sha256(frozen.value) !== attempt.requestHash ||
    CanonicalJson.stringify(attempt.sourceCandidateIds) !==
      CanonicalJson.stringify(extraction.candidates.map((candidate) => candidate.candidate_id).toSorted())
  ) {
    return yield* new DeepAgentLearningReviewerAttempt.FenceError({
      attemptId: attempt.attemptId,
      reason: "prepared reviewer request does not match its frozen artifact and source candidate set",
    })
  }
  return yield* executePreparedReview(
    db,
    job,
    admission,
    extraction,
    leaseMs,
    reviewer,
    attempt,
    jobVersion,
    frozen.value,
  )
})

const executePreparedReview = Effect.fn("DeepAgentDurableLearning.executePreparedReview")(function* (
  db: DatabaseClient,
  job: DeepAgentLearningJob.Record,
  admission: AdmissionManifest,
  extraction: ExtractionManifest,
  leaseMs: number,
  reviewer: ReviewerPort,
  attempt: DeepAgentLearningReviewerAttempt.Record,
  jobVersion: number,
  request: string,
) {
  const dispatched = yield* DeepAgentLearningReviewerAttempt.dispatch(db, {
    attemptId: attempt.attemptId,
    owner: attempt.owner!,
    expectedVersion: attempt.version,
  })
  const result = yield* reviewer
    .execute({
      attemptId: attempt.attemptId,
      reviewSessionId: attempt.reviewSessionId,
      workspacePath: admission.workspace_path,
      providerId: attempt.providerId,
      modelId: attempt.modelId,
      policyHash: attempt.policyHash,
      requestRef: attempt.requestRef,
      request,
    })
    .pipe(Effect.exit)
  if (result._tag === "Failure") {
    yield* DeepAgentLearningReviewerAttempt.quarantineDispatching(db, {
      attemptId: attempt.attemptId,
      owner: attempt.owner!,
      expectedAttemptVersion: dispatched.version,
      expectedJobVersion: jobVersion,
      errorCode: "reviewer_dispatch_indeterminate",
      errorDetail: Cause.pretty(result.cause),
    })
    return yield* Effect.failCause(result.cause)
  }
  const selectedCandidateIds = [...result.value.selectedCandidateIds].toSorted()
  const sourceCandidateIds = extraction.candidates.map((candidate) => candidate.candidate_id)
  if (
    selectedCandidateIds.length !== new Set(selectedCandidateIds).size ||
    selectedCandidateIds.some((candidateId) => !sourceCandidateIds.includes(candidateId)) ||
    (result.value.verdict === "reject" && selectedCandidateIds.length > 0)
  ) {
    yield* DeepAgentLearningReviewerAttempt.quarantineDispatching(db, {
      attemptId: attempt.attemptId,
      owner: attempt.owner!,
      expectedAttemptVersion: dispatched.version,
      expectedJobVersion: jobVersion,
      errorCode: "reviewer_response_invalid",
      errorDetail: "The isolated reviewer response did not authorize an exact candidate subset.",
    })
    return yield* new DeepAgentLearningReviewerAttempt.FenceError({
      attemptId: attempt.attemptId,
      reason: "reviewer response did not authorize an exact candidate subset",
    })
  }
  const responseHash = Hash.sha256(
    CanonicalJson.stringify({
      schema_version: "deepagent-code.learning_review_response.v1",
      job_id: job.jobId,
      run_id: admission.run_id,
      review_job_id: attempt.attemptId,
      request_ref: attempt.requestRef,
      verdict: result.value.verdict,
      selected_candidate_ids: selectedCandidateIds,
    }),
  )
  const artifact = {
    schema_version: "deepagent-code.learning_review.v1" as const,
    job_id: job.jobId,
    run_id: admission.run_id,
    phase: "reviewer" as const,
    review_job_id: attempt.attemptId,
    source_extraction_ref: job.resultRef!,
    request_ref: attempt.requestRef,
    response_hash: responseHash,
    provider_id: attempt.providerId,
    model_id: attempt.modelId,
    policy_hash: attempt.policyHash,
    disposition: "isolated_reviewer" as const,
    verdict: result.value.verdict,
    selected_candidate_ids: selectedCandidateIds,
    candidates: extraction.candidates,
  } satisfies ReviewManifest
  const responseRef = yield* Effect.promise(() =>
    writeArtifact(admission.base_dir, artifactDirectory(admission), "learning-review", artifact),
  )
  const settled = yield* DeepAgentLearningReviewerAttempt.settle(db, {
    attemptId: attempt.attemptId,
    owner: attempt.owner!,
    expectedAttemptVersion: dispatched.version,
    expectedJobVersion: jobVersion,
    responseRef,
    responseHash,
    verdict: result.value.verdict,
    selectedCandidateIds,
  })
  return yield* DeepAgentLearningJob.advance(db, {
    jobId: job.jobId,
    owner: attempt.owner!,
    expectedVersion: settled.jobVersion,
    state: "governance",
    leaseMs,
  })
})

const governancePhase = Effect.fn("DeepAgentDurableLearning.governancePhase")(function* (
  db: DatabaseClient,
  job: DeepAgentLearningJob.Record,
  admission: AdmissionManifest,
  leaseMs: number,
) {
  const review = yield* readBoundReview(db, job, admission)
  const candidates =
    review.disposition === "isolated_reviewer"
      ? review.candidates.filter((candidate) => review.selected_candidate_ids?.includes(candidate.candidate_id))
      : review.candidates
  const governanceAdmission =
    review.disposition === "isolated_reviewer" && review.verdict === "manual_review"
      ? { ...admission, policy: "manual_review" as const }
      : admission
  const home = new DeepAgentCodeHome(admission.base_dir)
  const project = home.ensureProject(admission.knowledge_project_id, admission.workspace_path)
  const projectStore = new DurableKnowledgeStore(path.join(project.root, "knowledge"))
  const rejectionStores = [openUserGlobalStore(admission.base_dir), projectStore]
  const worker = new LearningWorker(project, admission.knowledge_project_id, projectStore, {
    has: (fingerprint) => rejectionStores.some((store) => store.hasRejectedFingerprint(fingerprint)),
  })
  const existing = yield* DeepAgentLearningGovernance.getByJob(db, job.jobId)
  const prepared = existing
    ? existing
    : yield* prepareGovernancePlan(db, job, governanceAdmission, worker, candidates, project.docsDir, leaseMs)
  yield* executeGovernanceActions(db, prepared, job.owner!, projectStore, admission.base_dir, leaseMs)
  const result = governanceResult(admission.trigger, candidates, prepared.actions, prepared.plan.createdAt)
  const resultRef = yield* Effect.promise(() =>
    writeArtifact(admission.base_dir, artifactDirectory(admission), "learning-result", result),
  )
  const resultArtifact = decode(decodeArtifactRef, resultRef)
  const settledPlan = yield* DeepAgentLearningGovernance.settlePlan(db, {
    planId: prepared.plan.planId,
    owner: job.owner!,
    expectedVersion: prepared.plan.version,
    resultRef,
    resultHash: resultArtifact.sha256,
  })
  return yield* DeepAgentLearningJob.settle(db, {
    jobId: job.jobId,
    owner: job.owner!,
    expectedVersion: settledPlan.plan.jobStartedVersion + 1,
    state: "completed",
    resultRef,
  })
})

function prepareGovernancePlan(
  db: DatabaseClient,
  job: DeepAgentLearningJob.Record,
  admission: AdmissionManifest,
  worker: LearningWorker,
  candidates: readonly LearningCandidate[],
  docsDir: string,
  leaseMs: number,
) {
  const planned = worker.planDurableGovernance(governanceInput(admission), candidates, true)
  return DeepAgentLearningGovernance.prepare(db, {
    jobId: job.jobId,
    owner: job.owner!,
    expectedJobVersion: job.version,
    leaseMs,
    actions: planned.flatMap((item): readonly DeepAgentLearningGovernance.ActionInput[] => {
      if (item.action === "skip") return []
      if (item.action === "auto_admit") {
        return [
          {
            candidateId: item.candidate.candidate_id,
            kind: "document_stage",
            payload: { document: item.document, decision: "auto_admit", review_ref: job.resultRef! },
          },
        ]
      }
      const inbox = { ...item.inbox!, created_at: new Date(job.updatedAt).toISOString() }
      const content = CanonicalJson.stringify(inbox)
      const predecessorSequence = planned
        .slice(0, planned.indexOf(item))
        .reduce(
          (count, prior) => count + (prior.action === "manual_review" ? 2 : prior.action === "auto_admit" ? 1 : 0),
          0,
        )
      return [
        {
          candidateId: item.candidate.candidate_id,
          kind: "document_stage",
          payload: { document: item.document, decision: "manual_review" },
        },
        {
          candidateId: item.candidate.candidate_id,
          kind: "memory_inbox",
          predecessorSequence,
          payload: {
            item: inbox,
            path: path.join(docsDir, "memory-inbox", safeInboxFile(inbox.id)),
            content,
            content_hash: Hash.sha256(content),
          },
        },
      ]
    }),
  })
}

function executeGovernanceActions(
  db: DatabaseClient,
  snapshot: DeepAgentLearningGovernance.Snapshot,
  owner: string,
  store: DurableKnowledgeStore,
  authorityRoot: string,
  leaseMs: number,
): Effect.Effect<void, unknown> {
  return DeepAgentLearningGovernance.claimAction(db, {
    planId: snapshot.plan.planId,
    owner,
    leaseMs,
  }).pipe(
    Effect.flatMap((action) => {
      if (!action) return Effect.void
      return Effect.gen(function* () {
        yield* executeClaimedGovernanceAction(db, action, owner, store, authorityRoot)
        return yield* executeGovernanceActions(db, snapshot, owner, store, authorityRoot, leaseMs)
      })
    }),
  )
}

export function executeClaimedGovernanceAction(
  db: DatabaseClient,
  action: DeepAgentLearningGovernance.ActionRecord,
  owner: string,
  store: DurableKnowledgeStore,
  authorityRoot: string,
  now?: number,
) {
  return Effect.gen(function* () {
    const result = yield* applyGovernanceAction(action, store, authorityRoot).pipe(Effect.exit)
    if (result._tag === "Failure") {
      yield* DeepAgentLearningGovernance.failAction(db, {
        actionId: action.actionId,
        owner,
        expectedVersion: action.version,
        errorCode: "governance_action_apply_failed",
        errorDetail: Cause.pretty(result.cause),
        ...(now === undefined ? {} : { now }),
      })
      return yield* Effect.failCause(result.cause)
    }
    return yield* DeepAgentLearningGovernance.settleAction(db, {
      actionId: action.actionId,
      owner,
      expectedVersion: action.version,
      resultRef: result.value.ref,
      resultHash: result.value.hash,
      ...(now === undefined ? {} : { now }),
    })
  })
}

export function applyGovernanceAction(
  action: DeepAgentLearningGovernance.ActionRecord,
  store: DurableKnowledgeStore,
  authorityRoot: string,
) {
  if (action.kind === "document_stage") {
    return Effect.sync(() => {
      const payload = decodePayload(decodeGovernanceDocumentPayload, action.payloadJson)
      const document = payload.document as KnowledgeDocInput
      const result =
        payload.decision === "auto_admit" && payload.review_ref
          ? store.autoAdmitExactCandidate(
              document,
              { type: "system", id: "durable-learning-governance" },
              {
                reviewRef: payload.review_ref,
              },
            )
          : payload.decision === "manual_review"
            ? store.stageReviewCandidate(document)
            : store.stageCandidate(document, { allowActiveReinforcement: false, requireExactCandidate: true })
      const content = CanonicalJson.stringify(result)
      return { ref: `${result.id}@v${result.version}`, hash: Hash.sha256(content) }
    })
  }
  return Effect.promise(async () => {
    const payload = decodePayload(decodeGovernanceInboxPayload, action.payloadJson)
    if (!/^[0-9a-f]{64}$/.test(payload.content_hash) || Hash.sha256(payload.content) !== payload.content_hash) {
      throw new Error(`Learning governance inbox payload hash mismatch: ${action.actionId}`)
    }
    await assertContainedPath(authorityRoot, payload.path)
    if (existsSync(payload.path)) {
      const existing = await Bun.file(payload.path).text()
      if (existing !== payload.content) throw new Error(`Learning governance inbox conflict at ${payload.path}`)
    } else {
      writeFileAtomic(payload.path, payload.content)
    }
    await assertContainedPath(authorityRoot, payload.path)
    return { ref: payload.path, hash: payload.content_hash }
  })
}

export function applyGovernanceCompensation(
  compensation: DeepAgentLearningGovernance.CompensationRecord,
  action: DeepAgentLearningGovernance.ActionRecord,
  store: DurableKnowledgeStore,
  authorityRoot: string,
) {
  if (compensation.kind === "document_quarantine") {
    return Effect.sync(() => {
      const payload = decodePayload(decodeGovernanceDocumentPayload, action.payloadJson)
      return store.compensateGovernanceAction(
        payload.document as KnowledgeDocInput,
        action.resultRef && action.resultHash ? { ref: action.resultRef, hash: action.resultHash } : undefined,
        {
          planId: compensation.planId,
          actionId: action.actionId,
        },
      )
    })
  }
  return Effect.promise(async () => {
    const payload = decodePayload(decodeGovernanceInboxPayload, action.payloadJson)
    await assertContainedPath(authorityRoot, payload.path)
    if (!existsSync(payload.path)) {
      const content = CanonicalJson.stringify({
        schema_version: "deepagent-code.memory_inbox_revocation.v1",
        plan_id: compensation.planId,
        action_id: action.actionId,
        source_path: payload.path,
        source_hash: payload.content_hash,
        state: "absent",
      })
      return { ref: `${payload.path}.absent`, hash: Hash.sha256(content) }
    }
    if ((await Bun.file(payload.path).text()) !== payload.content)
      throw new Error(`Learning governance inbox material changed before compensation: ${payload.path}`)
    const marker = `${payload.path}.revoked`
    const content = CanonicalJson.stringify({
      schema_version: "deepagent-code.memory_inbox_revocation.v1",
      plan_id: compensation.planId,
      action_id: action.actionId,
      source_path: payload.path,
      source_hash: payload.content_hash,
    })
    if (existsSync(marker)) {
      if ((await Bun.file(marker).text()) !== content)
        throw new Error(`Learning governance inbox revocation conflict: ${marker}`)
    } else writeFileAtomic(marker, content)
    await assertContainedPath(authorityRoot, marker)
    return { ref: marker, hash: Hash.sha256(content) }
  })
}

function governanceResult(
  trigger: AdmissionManifest["trigger"],
  candidates: readonly LearningCandidate[],
  actions: readonly DeepAgentLearningGovernance.ActionRecord[],
  startedAt: number,
) {
  const acted = new Set(actions.map((action) => action.candidateId))
  return {
    trigger,
    enqueue_ms: 0,
    candidate_count: candidates.length,
    auto_merged_ids: actions
      .filter(
        (action) =>
          action.kind === "document_stage" &&
          decodePayload(decodeGovernanceDocumentPayload, action.payloadJson).decision === "auto_admit",
      )
      .map((action) => action.candidateId),
    inbox_ids: actions
      .filter((action) => action.kind === "memory_inbox")
      .map((action) => `inbox:${action.candidateId}`),
    skipped_ids: candidates
      .filter((candidate) => !acted.has(candidate.candidate_id))
      .map((candidate) => candidate.candidate_id),
    governance_started_at: startedAt,
  }
}

function safeInboxFile(id: string) {
  return `${id.replace(/[^A-Za-z0-9._:-]/g, "_").replace(/:/g, "__")}.json`
}

function decodePayload<A>(decoder: Decoder<A>, value: string): A {
  const decoded = decoder(decodeJson(value).pipe(Option.getOrThrow))
  if (Option.isNone(decoded)) throw new Error("Learning governance action payload does not match its schema")
  return decoded.value
}

function admissionManifest(
  admission: Admission,
  session: { readonly projectId: string; readonly directory: string },
): AdmissionManifest {
  return {
    schema_version: "deepagent-code.learning_input.v1",
    base_dir: path.resolve(admission.baseDir),
    workspace_path: path.resolve(admission.workspacePath),
    rejected_buffer_dir: admission.rejectedBufferDir ? path.resolve(admission.rejectedBufferDir) : null,
    database_project_id: session.projectId,
    knowledge_project_id: projectIdForWorkspace(session.directory),
    session_id: admission.input.sessionID,
    run_id: admission.input.runID,
    mode: admission.input.mode,
    diagnoses: admission.input.roundState.diagnoses,
    total_rounds: admission.input.totalRounds,
    final_status: admission.input.finalStatus,
    trigger: admission.input.trigger,
    policy: admission.input.policy ?? "auto_merge_safe_project",
    terminal_artifact: admission.terminalArtifact,
  }
}

function admissionIntent(admission: Admission): AdmissionIntent {
  return {
    schema_version: "deepagent-code.learning_admission_intent.v1",
    base_dir: path.resolve(admission.baseDir),
    workspace_path: path.resolve(admission.workspacePath),
    rejected_buffer_dir: admission.rejectedBufferDir ? path.resolve(admission.rejectedBufferDir) : null,
    requested_project_id: admission.input.projectID,
    session_id: admission.input.sessionID,
    run_id: admission.input.runID,
    mode: admission.input.mode,
    diagnoses: admission.input.roundState.diagnoses,
    total_rounds: admission.input.totalRounds,
    final_status: admission.input.finalStatus,
    trigger: admission.input.trigger,
    policy: admission.input.policy ?? "auto_merge_safe_project",
    terminal_artifact: {
      ...admission.terminalArtifact,
      path: path.resolve(admission.terminalArtifact.path),
      ...(admission.terminalArtifact.schema_version === "deepagent-code.learning_lifecycle_trigger_artifact.v1"
        ? {
            source_terminal_path: path.resolve(admission.terminalArtifact.source_terminal_path),
            source_admission_path: path.resolve(admission.terminalArtifact.source_admission_path),
          }
        : {}),
    },
  }
}

function fromIntent(intent: AdmissionIntent): Admission {
  const roundState = createInitialRoundState(intent.mode)
  roundState.round = intent.total_rounds
  roundState.diagnoses.push(...intent.diagnoses)
  return {
    baseDir: intent.base_dir,
    workspacePath: intent.workspace_path,
    rejectedBufferDir: intent.rejected_buffer_dir,
    terminalArtifact: intent.terminal_artifact,
    input: {
      projectID: intent.requested_project_id,
      sessionID: intent.session_id,
      runID: intent.run_id,
      mode: intent.mode,
      roundState,
      totalRounds: intent.total_rounds,
      finalStatus: intent.final_status,
      trigger: intent.trigger,
      policy: intent.policy,
    },
  }
}

const verifyTerminalArtifact = Effect.fn("DeepAgentDurableLearning.verifyTerminalArtifact")(function* (
  intentId: string,
  intent: AdmissionIntent,
  authorityRoot: string,
) {
  if (intent.terminal_artifact.schema_version === "deepagent-code.learning_lifecycle_trigger_artifact.v1") {
    return yield* verifyLifecycleTriggerArtifact(intentId, intent, authorityRoot)
  }
  yield* Effect.promise(() => assertContainedPath(authorityRoot, intent.terminal_artifact.path))
  if (!/^[0-9a-f]{64}$/.test(intent.terminal_artifact.sha256)) {
    return yield* Effect.fail(new Error("Learning terminal artifact has an invalid SHA-256"))
  }
  const file = Bun.file(intent.terminal_artifact.path)
  if (!(yield* Effect.promise(() => file.exists()))) {
    return yield* new TerminalArtifactPendingError({ intentId, path: intent.terminal_artifact.path })
  }
  const content = yield* Effect.promise(() => file.text())
  const state = decodeJson(content)
  if (Option.isNone(state) || typeof state.value !== "object" || state.value === null) {
    return yield* Effect.fail(new Error("Learning terminal artifact is not a JSON object"))
  }
  const value = state.value as Record<string, unknown>
  const identityMatches =
    value.schema_version === "deepagent_global_run_state.v1" &&
    value.run_id === intent.run_id &&
    value.generic_agent_session_id === intent.session_id &&
    value.agent_mode === intent.mode
  if (identityMatches && (value.state === "opened" || value.state === "streaming")) {
    return yield* new TerminalArtifactPendingError({ intentId, path: intent.terminal_artifact.path })
  }
  if (Hash.sha256(content) !== intent.terminal_artifact.sha256) {
    return yield* Effect.fail(new Error("Learning terminal artifact hash does not match the durable admission intent"))
  }
  const fingerprint = admissionFingerprint(fromIntent(intent))
  if (
    intent.terminal_artifact.learning_admission_fingerprint !== fingerprint ||
    value.learning_admission_fingerprint !== fingerprint
  ) {
    return yield* Effect.fail(
      new Error("Learning terminal artifact fingerprint does not match the durable admission intent"),
    )
  }
  if (!identityMatches || value.state !== intent.final_status) {
    return yield* Effect.fail(
      new Error("Learning terminal artifact identity does not match its durable admission intent"),
    )
  }
})

const verifyLifecycleTriggerArtifact = Effect.fn("DeepAgentDurableLearning.verifyLifecycleTriggerArtifact")(function* (
  intentId: string,
  intent: AdmissionIntent,
  authorityRoot: string,
) {
  const artifact = intent.terminal_artifact
  if (artifact.schema_version !== "deepagent-code.learning_lifecycle_trigger_artifact.v1") return
  if (artifact.trigger !== intent.trigger) {
    return yield* Effect.fail(new Error("Learning lifecycle artifact trigger does not match its admission"))
  }
  yield* Effect.promise(() => assertContainedPath(authorityRoot, artifact.path))
  yield* Effect.promise(() => assertContainedPath(authorityRoot, artifact.source_terminal_path))
  yield* Effect.promise(() => assertContainedPath(authorityRoot, artifact.source_admission_path))
  if (
    !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
    !/^[0-9a-f]{64}$/.test(artifact.source_terminal_sha256) ||
    !/^[0-9a-f]{64}$/.test(artifact.source_learning_admission_fingerprint) ||
    !/^[0-9a-f]{64}$/.test(artifact.source_admission_sha256)
  ) {
    return yield* Effect.fail(new Error("Learning lifecycle artifact contains an invalid SHA-256"))
  }
  const lifecycleFile = Bun.file(artifact.path)
  const terminalFile = Bun.file(artifact.source_terminal_path)
  const sourceAdmissionFile = Bun.file(artifact.source_admission_path)
  if (!(yield* Effect.promise(() => lifecycleFile.exists()))) {
    return yield* new TerminalArtifactPendingError({ intentId, path: artifact.path })
  }
  if (!(yield* Effect.promise(() => terminalFile.exists()))) {
    return yield* new TerminalArtifactPendingError({ intentId, path: artifact.source_terminal_path })
  }
  if (!(yield* Effect.promise(() => sourceAdmissionFile.exists()))) {
    return yield* new TerminalArtifactPendingError({ intentId, path: artifact.source_admission_path })
  }
  const [content, terminalContent, sourceAdmissionContent] = yield* Effect.all([
    Effect.promise(() => lifecycleFile.text()),
    Effect.promise(() => terminalFile.text()),
    Effect.promise(() => sourceAdmissionFile.text()),
  ])
  if (Hash.sha256(content) !== artifact.sha256 || Hash.sha256(terminalContent) !== artifact.source_terminal_sha256) {
    return yield* Effect.fail(new Error("Learning lifecycle artifact hash does not match its immutable source"))
  }
  const lifecycle = decodeJson(content)
  const terminal = decodeJson(terminalContent)
  const sourceAdmissionJson = decodeJson(sourceAdmissionContent)
  const sourceAdmission = Option.flatMap(sourceAdmissionJson, decodeLocalAdmissionReceipt)
  if (
    Option.isNone(lifecycle) ||
    typeof lifecycle.value !== "object" ||
    lifecycle.value === null ||
    Option.isNone(terminal) ||
    typeof terminal.value !== "object" ||
    terminal.value === null ||
    Option.isNone(sourceAdmission)
  ) {
    return yield* Effect.fail(new Error("Learning lifecycle artifact or source terminal is not a JSON object"))
  }
  const value = lifecycle.value as Record<string, unknown>
  const source = terminal.value as Record<string, unknown>
  const sourceIntent = sourceAdmission.value.admission_intent
  const fingerprint = admissionFingerprint(fromIntent(intent))
  if (
    artifact.learning_admission_fingerprint !== fingerprint ||
    value.schema_version !== "deepagent-code.learning_lifecycle_trigger_receipt.v1" ||
    value.trigger !== intent.trigger ||
    value.boundary_key !== artifact.boundary_key ||
    value.boundary_subject !== artifact.boundary_subject ||
    value.goal_id !== artifact.goal_id ||
    value.source_session_relation !== artifact.source_session_relation ||
    value.session_id !== intent.session_id ||
    value.run_id !== intent.run_id ||
    value.source_admission_path !== artifact.source_admission_path ||
    value.source_admission_sha256 !== artifact.source_admission_sha256 ||
    value.source_terminal_path !== artifact.source_terminal_path ||
    value.source_terminal_sha256 !== artifact.source_terminal_sha256 ||
    value.source_learning_admission_fingerprint !== artifact.source_learning_admission_fingerprint ||
    value.learning_admission_fingerprint !== fingerprint ||
    source.schema_version !== "deepagent_global_run_state.v1" ||
    source.run_id !== intent.run_id ||
    source.generic_agent_session_id !== intent.session_id ||
    source.agent_mode !== intent.mode ||
    source.state !== intent.final_status ||
    source.learning_admission_fingerprint !== artifact.source_learning_admission_fingerprint ||
    sourceAdmission.value.state !== "submitted" ||
    sourceIntent.trigger !== "session_finalization" ||
    sourceIntent.terminal_artifact.schema_version !== "deepagent-code.learning_terminal_artifact.v1" ||
    sourceIntent.terminal_artifact.path !== artifact.source_terminal_path ||
    sourceIntent.terminal_artifact.sha256 !== artifact.source_terminal_sha256 ||
    sourceIntent.terminal_artifact.learning_admission_fingerprint !== artifact.source_learning_admission_fingerprint ||
    Hash.sha256(CanonicalJson.stringify(sourceIntent)) !== artifact.source_admission_sha256 ||
    admissionFingerprint(fromIntent(sourceIntent)) !== artifact.source_learning_admission_fingerprint ||
    !sameSourceAdmission(sourceIntent, intent)
  ) {
    return yield* Effect.fail(new Error("Learning lifecycle artifact identity does not match its durable admission"))
  }
  if (
    (artifact.source_session_relation === "session" &&
      (intent.trigger !== "idle" || artifact.boundary_subject !== intent.session_id)) ||
    (artifact.source_session_relation === "parent" &&
      (intent.trigger !== "pause" ||
        artifact.goal_id === null ||
        source.parent_generic_agent_session_id !== artifact.boundary_subject ||
        source.goal_id !== artifact.goal_id)) ||
    (artifact.source_session_relation === "workspace" &&
      (intent.trigger !== "project_switch" || path.resolve(artifact.boundary_subject) !== intent.workspace_path))
  ) {
    return yield* Effect.fail(new Error("Learning lifecycle artifact does not prove its safe-boundary subject"))
  }
})

function sameSourceAdmission(source: AdmissionIntent, lifecycle: AdmissionIntent) {
  return (
    source.base_dir === lifecycle.base_dir &&
    source.workspace_path === lifecycle.workspace_path &&
    source.rejected_buffer_dir === lifecycle.rejected_buffer_dir &&
    source.requested_project_id === lifecycle.requested_project_id &&
    source.session_id === lifecycle.session_id &&
    source.run_id === lifecycle.run_id &&
    source.mode === lifecycle.mode &&
    CanonicalJson.stringify(source.diagnoses) === CanonicalJson.stringify(lifecycle.diagnoses) &&
    source.total_rounds === lifecycle.total_rounds &&
    source.final_status === lifecycle.final_status &&
    source.policy === lifecycle.policy
  )
}

const rejectIntent = (db: DatabaseClient, intent: DeepAgentLearningAdmissionOutbox.Record, error: unknown) =>
  DeepAgentLearningAdmissionOutbox.reject(db, {
    intentId: intent.intentId,
    payloadFingerprint: intent.payloadFingerprint,
    code: rejectionCode(error),
    detail: errorDetail(error),
  })

function rejectionCode(error: unknown) {
  if (typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string") {
    return error._tag
  }
  return "learning_admission_reconciliation_failed"
}

function errorDetail(error: unknown) {
  if (typeof error === "object" && error !== null && "reason" in error && typeof error.reason === "string") {
    if (error.reason.trim().length > 0) return error.reason
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  const detail = String(error)
  return detail.trim().length > 0 ? detail : rejectionCode(error)
}

function governanceInput(manifest: AdmissionManifest): LearningGovernanceInput {
  return {
    projectID: manifest.knowledge_project_id,
    sessionID: manifest.session_id,
    runID: manifest.run_id,
    mode: manifest.mode,
    roundState: roundStateFrom(manifest),
    totalRounds: manifest.total_rounds,
    finalStatus: manifest.final_status,
    trigger: manifest.trigger,
    policy: manifest.policy,
  }
}

function roundStateFrom(manifest: AdmissionManifest) {
  const roundState = createInitialRoundState(manifest.mode)
  roundState.round = manifest.total_rounds
  roundState.diagnoses.push(...manifest.diagnoses)
  return roundState
}

function artifactDirectory(manifest: AdmissionManifest) {
  return new DeepAgentCodeHome(manifest.base_dir).ensureRun(
    manifest.knowledge_project_id,
    manifest.session_id,
    manifest.run_id,
  ).artifactsDir
}

async function writeArtifact(authorityRoot: string, directory: string, kind: string, value: unknown) {
  const artifact = artifactPlan(authorityRoot, directory, kind, value)
  await publishArtifact(artifact)
  return artifact.ref
}

function artifactPlan(authorityRoot: string, directory: string, kind: string, value: unknown): ArtifactPlan {
  const content = CanonicalJson.stringify(value)
  const sha256 = Hash.sha256(content)
  const file = path.join(directory, `${kind}-${sha256}.json`)
  return {
    authorityRoot,
    path: file,
    content,
    ref: CanonicalJson.stringify({
      schema_version: "deepagent-code.learning_artifact_ref.v1",
      authority_root: path.resolve(authorityRoot),
      path: file,
      sha256,
    } satisfies ArtifactRef),
  }
}

async function publishArtifact(artifact: ArtifactPlan) {
  await assertContainedPath(artifact.authorityRoot, artifact.path)
  if (await Bun.file(artifact.path).exists()) {
    if ((await Bun.file(artifact.path).text()) !== artifact.content) {
      throw new Error(`Learning artifact collision at ${artifact.path}`)
    }
  } else {
    try {
      writeFileExclusive(artifact.path, artifact.content)
    } catch (error) {
      if (!isAlreadyExists(error) || (await Bun.file(artifact.path).text()) !== artifact.content) throw error
    }
  }
  await assertContainedPath(artifact.authorityRoot, artifact.path)
  if ((await Bun.file(artifact.path).text()) !== artifact.content) {
    throw new Error(`Learning artifact collision at ${artifact.path}`)
  }
  return artifact.ref
}

function isAlreadyExists(error: unknown): error is { readonly code: "EEXIST" } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

function verifyAdmissionRoot(admission: AdmissionIntent, authorityRoot: string) {
  if (admission.base_dir !== path.resolve(authorityRoot)) {
    return Effect.fail(new Error("Learning admission base_dir does not match the canonical authority root"))
  }
  return Effect.void
}

async function assertContainedPath(authorityRoot: string, candidatePath: string) {
  const configuredRoot = path.resolve(authorityRoot)
  const root = await realpath(configuredRoot)
  const candidate = path.resolve(candidatePath)
  const lexical = path.relative(configuredRoot, candidate)
  if (lexical.startsWith("..") || path.isAbsolute(lexical)) {
    throw new Error(`Learning artifact escapes its authority root: ${candidatePath}`)
  }
  const resolved = await realpath(closestExistingPath(candidate))
  const relative = path.relative(root, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Learning artifact escapes its authority root: ${candidatePath}`)
  }
}

function closestExistingPath(candidate: string): string {
  if (existsSync(candidate)) return candidate
  const parent = path.dirname(candidate)
  if (parent === candidate) return candidate
  return closestExistingPath(parent)
}

const readAdmission = (ref: string, authorityRoot: string) =>
  readArtifact(ref, authorityRoot, decodeAdmissionManifest).pipe(
    Effect.filterOrFail(
      ({ value, artifact }) => value.base_dir === artifact.authority_root,
      () => new Error("Learning input base_dir does not match its artifact authority root"),
    ),
    Effect.map(({ value }) => value),
  )

const readBoundAdmission = (job: DeepAgentLearningJob.Record, authorityRoot: string) =>
  readAdmission(job.candidateInputRef, authorityRoot).pipe(
    Effect.filterOrFail(
      (manifest) =>
        manifest.database_project_id === job.projectId &&
        manifest.session_id === job.sessionId &&
        manifest.run_id === job.runId &&
        manifest.trigger === job.trigger &&
        manifest.policy === job.policy,
      () =>
        new DeepAgentLearningJob.FenceError({
          jobId: job.jobId,
          reason: "learning input manifest identity does not match its durable job",
        }),
    ),
  )
const readBoundExtraction = Effect.fn("DeepAgentDurableLearning.readBoundExtraction")(function* (
  job: DeepAgentLearningJob.Record,
  admission: AdmissionManifest,
) {
  const manifest = yield* requireArtifact(job.resultRef, admission.base_dir, decodeExtractionManifest)
  if (
    manifest.job_id === job.jobId &&
    manifest.run_id === admission.run_id &&
    manifest.phase === "extraction" &&
    manifest.source_input_ref === job.candidateInputRef
  ) {
    return manifest
  }
  return yield* new DeepAgentLearningJob.FenceError({
    jobId: job.jobId,
    reason: "learning extraction artifact identity does not match its durable phase",
  })
})

const readBoundReview = Effect.fn("DeepAgentDurableLearning.readBoundReview")(function* (
  db: DatabaseClient,
  job: DeepAgentLearningJob.Record,
  admission: AdmissionManifest,
) {
  const manifest = yield* requireArtifact(job.resultRef, admission.base_dir, decodeReviewManifest)
  if (
    manifest.disposition === "reviewer_unavailable_fail_closed" &&
    manifest.job_id === job.jobId &&
    manifest.run_id === admission.run_id &&
    manifest.phase === "reviewer" &&
    manifest.review_job_id === `review-unavailable:${job.jobId}` &&
    job.reviewJobId === manifest.review_job_id &&
    manifest.source_extraction_ref === extractionArtifact(job, admission).ref
  ) {
    return manifest
  }
  if (manifest.disposition !== "isolated_reviewer") {
    return yield* new DeepAgentLearningJob.FenceError({
      jobId: job.jobId,
      reason: "learning review artifact disposition does not match its durable phase",
    })
  }
  const attempt = yield* DeepAgentLearningReviewerAttempt.getByJob(db, job.jobId)
  const candidateIds = manifest.candidates.map((candidate) => candidate.candidate_id).toSorted()
  const selectedCandidateIds = [...(manifest.selected_candidate_ids ?? [])].toSorted()
  const responseHash = Hash.sha256(
    CanonicalJson.stringify({
      schema_version: "deepagent-code.learning_review_response.v1",
      job_id: manifest.job_id,
      run_id: manifest.run_id,
      review_job_id: manifest.review_job_id,
      request_ref: manifest.request_ref,
      verdict: manifest.verdict,
      selected_candidate_ids: selectedCandidateIds,
    }),
  )
  if (
    attempt?.state === "settled" &&
    attempt.attemptId === manifest.review_job_id &&
    attempt.attemptId === job.reviewJobId &&
    attempt.responseRef === job.resultRef &&
    attempt.requestRef === manifest.request_ref &&
    attempt.responseHash === manifest.response_hash &&
    manifest.response_hash === responseHash &&
    attempt.providerId === manifest.provider_id &&
    attempt.modelId === manifest.model_id &&
    attempt.policyHash === manifest.policy_hash &&
    attempt.verdict === manifest.verdict &&
    CanonicalJson.stringify(attempt.sourceCandidateIds) === CanonicalJson.stringify(candidateIds) &&
    CanonicalJson.stringify(attempt.selectedCandidateIds ?? []) === CanonicalJson.stringify(selectedCandidateIds) &&
    manifest.job_id === job.jobId &&
    manifest.run_id === admission.run_id &&
    manifest.phase === "reviewer" &&
    manifest.source_extraction_ref === extractionArtifact(job, admission).ref
  ) {
    return manifest
  }
  return yield* new DeepAgentLearningJob.FenceError({
    jobId: job.jobId,
    reason: "learning review artifact identity does not match its durable phase",
  })
})

function extractionArtifact(job: DeepAgentLearningJob.Record, admission: AdmissionManifest) {
  const extraction = extract({
    runId: admission.run_id,
    mode: admission.mode,
    roundState: roundStateFrom(admission),
    totalRounds: admission.total_rounds,
    finalStatus: admission.final_status,
  })
  return artifactPlan(admission.base_dir, artifactDirectory(admission), "learning-extraction", {
    schema_version: "deepagent-code.learning_extraction.v1",
    job_id: job.jobId,
    run_id: admission.run_id,
    phase: "extraction",
    source_input_ref: job.candidateInputRef,
    candidates: extraction.candidates,
    promotion_decision: extraction.promotion_decision,
    rejection_reasons: extraction.rejection_reasons,
  } satisfies ExtractionManifest)
}

function requireArtifact<A>(ref: string | null, baseDir: string, decoder: Decoder<A>) {
  if (!ref) return Effect.fail(new Error("Learning job is missing its prior phase result ref"))
  return readArtifact(ref, baseDir, decoder).pipe(Effect.map(({ value }) => value))
}

function readArtifact<A>(ref: string, expectedBaseDir: string | undefined, decoder: Decoder<A>) {
  return Effect.promise(async () => {
    const artifact = decode(decodeArtifactRef, ref)
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error("Learning artifact ref has an invalid SHA-256")
    const expectedAuthorityRoot = path.resolve(expectedBaseDir ?? artifact.authority_root)
    if (artifact.authority_root !== expectedAuthorityRoot) {
      throw new Error("Learning artifact ref does not match the expected authority root")
    }
    const baseDir = await realpath(expectedAuthorityRoot)
    const artifactPath = await realpath(path.resolve(artifact.path))
    const relative = path.relative(baseDir, artifactPath)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Learning artifact escapes its authority root: ${artifact.path}`)
    }
    const content = await Bun.file(artifactPath).text()
    if (Hash.sha256(content) !== artifact.sha256) throw new Error(`Learning artifact hash mismatch: ${artifact.path}`)
    return { artifact, value: decode(decoder, content) }
  })
}

function decode<A>(decoder: Decoder<A>, value: string): A {
  const json = decodeJson(value)
  if (Option.isNone(json)) throw new Error("Learning artifact is not valid JSON")
  const decoded = decoder(json.value)
  if (Option.isNone(decoded)) throw new Error("Learning artifact does not match its schema")
  return decoded.value
}

function requireText(field: string, value: string) {
  if (value.trim().length > 0) return Effect.void
  return new DeepAgentLearningJob.InputError({ field, reason: "must be non-empty" })
}

const requireCanonicalSession = Effect.fn("DeepAgentDurableLearning.requireCanonicalSession")(function* (
  db: DatabaseClient,
  admission: Admission,
) {
  const session = yield* db
    .select({ projectId: SessionTable.project_id, directory: SessionTable.directory })
    .from(SessionTable)
    .where(eq(SessionTable.id, SessionSchema.ID.make(admission.input.sessionID)))
    .get()
  if (!session) {
    return yield* new DeepAgentLearningJob.InputError({
      field: "sessionID",
      reason: "must reference an existing canonical Session",
    })
  }
  if (path.resolve(session.directory) !== path.resolve(admission.workspacePath)) {
    return yield* new DeepAgentLearningJob.InputError({
      field: "workspacePath",
      reason: "must match the canonical Session directory",
    })
  }
  return session
})
