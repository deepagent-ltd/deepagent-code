export * as SessionRunnerCanonical from "./canonical-turn"

import { and, asc, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../../database/database"
import { ContextArtifactStore } from "../../context-federation/artifact-store"
import { ContextProjection } from "../../context-federation/projection"
import { SessionProviderAttempt } from "../../context-federation/provider-attempt"
import { ContextReference } from "../../context-federation/reference"
import { SessionContext } from "../../context-federation/session-context"
import {
  SessionActivityInputTable,
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionProviderAttemptTable,
} from "../../context-federation/session-sql"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "../../context-federation/sql"
import { DeepAgentReleasedSnapshot } from "../../deepagent/released-snapshot"
import { SessionSchema } from "../schema"
import { CanonicalJson } from "../../util/canonical-json"
import { Hash } from "../../util/hash"
import { V2ProviderTurn } from "./v2-provider-turn"

// V2 runner turns bind Context Federation authority through the same admission chain as the legacy
// durable runtime (activity -> selection -> validation -> attempt), but the selected source is the
// Session-owned history/system context epoch: no federation graphs are queried yet, so selections
// carry empty evidence and the degraded audit path records the projection fingerprints inline.
export const SelectionLifetimeMs = 14 * 60_000
export const ValidationMs = 60_000

const V2Namespace = ContextReference.SecurityNamespaceID.make("v2:local")
const V2Scope = ContextReference.ProjectScopeKey.make("v2:local")
const GraphRevisions = { code: "v2-none", documents: "v2-none", knowledge: "v2-none", memory: "v2-none" } as const

// §16.3 order 4 package D — federation selection evidence seam. When provided, a V2 turn's
// selection commit records the session's REAL federation selection evidence (the selection the
// legacy durable loop committed for that session) instead of the empty `v2:local` fingerprints.
// Read-only by construction: the seam only reads the already-committed authority, so the legacy
// loop remains the single selection writer and the two paths cannot diverge. Unwired compositions
// (or a lookup fault) keep the empty-evidence local selection exactly as before.
export type SelectionEvidence = {
  readonly graphRevisions: { readonly code: string; readonly documents: string; readonly knowledge: string; readonly memory: string }
  readonly selectedSourceFingerprint: string
  readonly observedLocationMutationEpoch: number
}
export const CurrentSelectionEvidenceLookup = Context.Reference<
  ((sessionID: SessionSchema.ID) => Effect.Effect<SelectionEvidence | undefined, unknown>) | undefined
>("@deepagent-code/v2/SessionRunnerCanonical/CurrentSelectionEvidenceLookup", { defaultValue: () => undefined })

export class AdmissionError extends Schema.TaggedErrorClass<AdmissionError>()("SessionRunnerCanonical.AdmissionError", {
  reason: Schema.String,
}) {}

export type SystemSnapshot = {
  readonly baseline: string
  readonly revision: number
  readonly baselineSeq: number
}

export type SelectionAdmission = {
  readonly activityId: string
  readonly selectionId: string
  readonly projectionHash: string
  readonly authorizationEpoch: number
  readonly egressEpoch: number
  readonly observedLocationMutationEpoch: number
  readonly selectedSourceFingerprint: string
  readonly nextRevalidationAt: number
}

export type AdmitSelectionInput = {
  readonly db: Database.Interface["db"]
  readonly contexts: SessionContext.Interface
  readonly sessionID: SessionSchema.ID
  readonly agent: string
  readonly location: { readonly directory: string; readonly workspaceID?: string }
  // Promoted inputs for this wake, in admitted_seq order; the first one triggers the activity.
  readonly promotedInputIds: readonly string[]
  // Durable identity of the surrounding turn (last promoted user input) used to reopen or lazily
  // create the canonical activity for continuation turns without a fresh promotion.
  readonly fallbackUserInputId?: string
  readonly system: SystemSnapshot
  readonly historyEndMessageId?: string
  readonly now?: number
}

export const admitSelection = Effect.fn("SessionRunnerCanonical.admitSelection")(function* (
  input: AdmitSelectionInput,
) {
  return yield* Effect.gen(function* () {
    const now = input.now ?? Date.now()
    const locationKey = `${input.location.directory}#${input.location.workspaceID ?? ""}`
    yield* ensureLocationIdentity(input.db, locationKey, now)
    const activity = yield* admitActivity(input, now)
    const selection = yield* selectContext(input, activity, now, locationKey)
    return {
      activityId: activity.activityId,
      selectionId: selection.selectionId,
      projectionHash: selection.projectionHash,
      authorizationEpoch: input.system.revision,
      egressEpoch: input.system.baselineSeq,
      observedLocationMutationEpoch: selection.observedLocationMutationEpoch,
      selectedSourceFingerprint: selection.selectedSourceFingerprint,
      nextRevalidationAt: selection.nextRevalidationAt,
    }
  }).pipe(
    Effect.catch((error) => (isContextError(error) ? Effect.fail(toAdmission(error)) : Effect.fail(error))),
  )
})

function admitActivity(input: AdmitSelectionInput, now: number) {
  const triggerInputId = input.promotedInputIds[0]
  if (triggerInputId !== undefined) {
    return input.contexts
      .openActivity({ sessionId: input.sessionID, triggerInputId, now })
      .pipe(
        // openActivity already attaches the trigger input (any delivery); only the remaining
        // promoted steers are attached afterwards — queue inputs may only ever be triggers.
        Effect.tap((opened) =>
          input.contexts.attachInputs({
            activityId: opened.activityId,
            inputIds: input.promotedInputIds.filter((id) => id !== opened.triggerInputId),
            now,
          }),
        ),
        Effect.mapError((error) => new AdmissionError({ reason: `activity_admission_failed:${contextErrorDetail(error)}` })),
        Effect.map((opened) => ({ activityId: opened.activityId, triggerInputId: opened.triggerInputId })),
      )
  }
  return Effect.gen(function* () {
    const active = yield* input.db
      .select()
      .from(SessionActivityTable)
      .where(and(eq(SessionActivityTable.session_id, input.sessionID), eq(SessionActivityTable.state, "active")))
      .get()
      .pipe(Effect.orDie)
    if (active) return { activityId: active.activity_id, triggerInputId: active.trigger_input_id }
    if (input.fallbackUserInputId === undefined)
      return yield* new AdmissionError({ reason: "canonical_activity_unavailable" })
    const opened = yield* input.contexts
      .openActivity({ sessionId: input.sessionID, triggerInputId: input.fallbackUserInputId, now })
      .pipe(
        Effect.mapError((error) => new AdmissionError({ reason: `activity_admission_failed:${contextErrorDetail(error)}` })),
      )
    return { activityId: opened.activityId, triggerInputId: opened.triggerInputId }
  })
}

// V2 selections live in a dedicated local namespace. The selection insert guard requires the
// namespace/scope/location identity chain to exist and stay unretired, so ensure it idempotently.
function ensureLocationIdentity(db: Database.Interface["db"], locationKey: string, now: number) {
  return Effect.gen(function* () {
    yield* db
      .insert(SecurityNamespaceTable)
      .values({ id: V2Namespace, kind: "implicit_local", binding_hash: Hash.sha256(V2Namespace), created_at: now })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(ProjectScopeIdentityTable)
      .values({
        security_namespace_id: V2Namespace,
        project_scope_key: V2Scope,
        project_kind: "registered_root",
        project_identity_hash: Hash.sha256(`${V2Namespace}:${V2Scope}`),
        created_at: now,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: V2Namespace,
        location_key: locationKey,
        project_scope_key: V2Scope,
        canonical_root: locationKey,
        created_at: now,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

function selectContext(
  input: AdmitSelectionInput,
  activity: { readonly activityId: string; readonly triggerInputId: string },
  now: number,
  locationKey: string,
) {
  return Effect.gen(function* () {
    const latest = yield* input.db
      .select({ selectionId: SessionContextSelectionTable.selection_id })
      .from(SessionContextSelectionTable)
      .where(
        and(
          eq(SessionContextSelectionTable.session_id, input.sessionID),
          eq(SessionContextSelectionTable.activity_id, activity.activityId),
        ),
      )
      .orderBy(desc(SessionContextSelectionTable.revision))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (latest) {
      const existing = yield* input.contexts.getSelection(latest.selectionId)
      if (!existing) return yield* new AdmissionError({ reason: "selection_missing" })
      return existing
    }
    const inputs = yield* activityInputIds(input, activity.activityId)
    const rendered = ContextProjection.render({ evidence: [], statuses: [] })
    const evidenceLookup = yield* CurrentSelectionEvidenceLookup
    const evidence = evidenceLookup
      ? yield* Effect.suspend(() => evidenceLookup(input.sessionID)).pipe(
          // Synchronous throws at construction land in the cause too; never fail the admission.
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      : undefined
    return yield* input.contexts
      .commitSelection({
        securityNamespaceId: V2Namespace,
        projectScopeKey: V2Scope,
        sessionId: input.sessionID,
        activityId: activity.activityId,
        revision: 0,
        triggerInputId: activity.triggerInputId,
        locationKey: ContextReference.LocationKey.make(locationKey),
        promotedInputIds: inputs,
        queryFingerprint: fingerprint("v2_activity_query", {
          activityId: activity.activityId,
          triggerInputId: activity.triggerInputId,
          inputIds: inputs,
        }),
        authorizationFingerprint: fingerprint("v2_history_context", {
          agent: input.agent,
          baseline: input.system.baseline,
          revision: input.system.revision,
        }),
        authorizationEpoch: input.system.revision,
        executionFingerprint: fingerprint("v2_runner_location", {
          directory: input.location.directory,
          workspaceID: input.location.workspaceID ?? null,
        }),
        selectedSourceFingerprint:
          evidence?.selectedSourceFingerprint ??
          fingerprint("v2_history_source", {
            baseline: input.system.baseline,
            revision: input.system.revision,
            historyEndMessageId: input.historyEndMessageId ?? null,
          }),
        observedLocationMutationEpoch: evidence?.observedLocationMutationEpoch ?? 0,
        nextRevalidationAt: now + SelectionLifetimeMs,
        releasedKnowledgeBinding: DeepAgentReleasedSnapshot.binding(undefined),
        graphRevisions: evidence?.graphRevisions ?? GraphRevisions,
        graphStatuses: [],
        selectedRefs: [],
        rendered,
        artifact: { rankingVersion: "v2-history-context-v1", rejected: [] },
        now,
      })
      .pipe(Effect.mapError((error) => new AdmissionError({ reason: `selection_commit_failed:${contextErrorDetail(error)}` })))
  })
}

function activityInputIds(input: AdmitSelectionInput, activityId: string) {
  return input.db
    .select({ inputId: SessionActivityInputTable.input_id })
    .from(SessionActivityInputTable)
    .where(eq(SessionActivityInputTable.activity_id, activityId))
    .orderBy(asc(SessionActivityInputTable.admitted_seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.inputId)),
    )
}

function fingerprint(kind: string, payload: unknown) {
  return Hash.sha256(CanonicalJson.stringify({ kind, ...Object(payload) }))
}

function isContextError(value: unknown): value is SessionContext.Error {
  return (
    value instanceof SessionContext.InputError ||
    value instanceof SessionContext.ActivityBlockedError ||
    value instanceof SessionContext.ActivityStateError ||
    value instanceof SessionContext.SelectionConflictError ||
    value instanceof SessionContext.ValidationError ||
    value instanceof SessionContext.AuditStorageUnavailableError ||
    value instanceof SessionContext.StoredDataError
  )
}

function toAdmission(error: SessionContext.Error) {
  return new AdmissionError({ reason: `context_admission_failed:${contextErrorDetail(error)}` })
}

function contextErrorDetail(error: SessionContext.Error) {
  return "reason" in error && typeof error.reason === "string" ? `${error._tag}:${error.reason}` : error._tag
}

export type CommitTurnInput = {
  readonly db: Database.Interface["db"]
  readonly contexts: SessionContext.Interface
  readonly sessionID: SessionSchema.ID
  readonly admission: SelectionAdmission
  readonly receipt: Omit<V2ProviderTurn.AdmitInput, "ownerToken" | "activityId" | "providerTurnSeq">
  readonly ownerToken: string
  readonly now?: number
}

// Creates the canonical provider attempt and the V2 receipt for one physical request inside a single
// transaction and binds them explicitly. Exact retries converge: a prepared attempt with the same
// binding is reused, a preparing receipt with the same identity is re-admitted, and an existing
// binding to the same attempt is idempotent.
export const commitTurn = Effect.fn("SessionRunnerCanonical.commitTurn")(function* (input: CommitTurnInput) {
  const now = input.now ?? Date.now()
  return yield* input.db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const latest = yield* tx
            .select()
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.session_id, input.sessionID))
            .orderBy(desc(SessionProviderAttemptTable.provider_turn_seq))
            .limit(1)
            .get()
          // Only attempts that may still be physically streaming block new work. An
          // `indeterminate_after_crash` attempt is known-dead with an unknown outcome: explicit
          // forced continuation may open a fresh attempt (new seq, no replay of the quarantined
          // identity); the quarantined attempt still requires explicit resolution before recovery
          // may treat its turn as terminal.
          if (latest && ["dispatching", "streaming"].includes(latest.state))
            return yield* new AdmissionError({ reason: `provider_attempt_blocked:${latest.state}` })
          // Receipt identity requires provider_turn_seq >= 1; canonical sequences are 1-based.
          const providerTurnSeq =
            latest?.state === "prepared" ? latest.provider_turn_seq : (latest?.provider_turn_seq ?? 0) + 1
          const validUntil = Math.min(now + ValidationMs, input.admission.nextRevalidationAt)
          if (validUntil <= now) return yield* new AdmissionError({ reason: "selection_revalidation_required" })
          yield* input.contexts.appendValidation({
            selectionId: input.admission.selectionId,
            providerTurnSeq,
            authorizationEpoch: input.admission.authorizationEpoch,
            egressEpoch: input.admission.egressEpoch,
            observedLocationMutationEpoch: input.admission.observedLocationMutationEpoch,
            selectedSourceFingerprint: input.admission.selectedSourceFingerprint,
            validatedAt: now,
            validUntil,
            outcome: "valid",
            reasonCode: "v2_history_context_current",
          })
          const attempt = yield* SessionProviderAttempt.prepareInTransaction(tx, {
            sessionId: input.sessionID,
            activityId: input.admission.activityId,
            providerTurnSeq,
            selectionId: input.admission.selectionId,
            projectionHash: input.admission.projectionHash,
            requestHash: input.receipt.requestInputHash,
            providerId: input.receipt.providerId,
            ownerToken: input.ownerToken,
            authorizationEpoch: input.admission.authorizationEpoch,
            egressEpoch: input.admission.egressEpoch,
            selectedSourceFingerprint: input.admission.selectedSourceFingerprint,
            observedLocationMutationEpoch: input.admission.observedLocationMutationEpoch,
            now,
          })
          const receipt = yield* V2ProviderTurn.admitInTransaction(
            tx,
            { ...input.receipt, activityId: input.admission.activityId, providerTurnSeq },
            input.ownerToken,
          )
          // Exact-retry convergence: an existing receipt already bound to the reused attempt is
          // returned as-is; first-time admission binds once.
          const bound =
            receipt.providerAttemptId === attempt.attemptId
              ? receipt
              : yield* V2ProviderTurn.bindAttemptInTransaction(tx, receipt, attempt.attemptId)
          return { receipt: bound, attempt, providerTurnSeq }
        }),
      { behavior: "immediate" },
    )
    .pipe(
      Effect.catch((error) =>
        error instanceof AdmissionError ||
        error instanceof V2ProviderTurn.ConflictError ||
        error instanceof V2ProviderTurn.UnsafeRetryError ||
        error instanceof V2ProviderTurn.NotFoundError ||
        error instanceof SessionProviderAttempt.NotFoundError ||
        error instanceof SessionProviderAttempt.ConflictError ||
        error instanceof SessionProviderAttempt.InvalidStateError ||
        error instanceof SessionProviderAttempt.ValidationRequiredError ||
        error instanceof SessionProviderAttempt.UnsafeRetryError
          ? Effect.fail(error)
          : isContextError(error)
            ? Effect.fail(toAdmission(error))
            : Effect.die(error),
      ),
    )
})

// Best-effort audit store for V2 selections: V2 has no federation security namespace yet, so writes
// are refused and commitSelection records the degraded inline audit (projection fingerprints) instead
// of silently skipping it.
export const degradedArtifactStore = Layer.succeed(
  ContextArtifactStore.Service,
  ContextArtifactStore.Service.of({
    policy: "best_effort",
    write: () => Effect.fail(new ContextArtifactStore.BindingError()),
    read: () => Effect.fail(new ContextArtifactStore.NotFoundError()),
    sweep: () => Effect.succeed(0),
    sweepOrphans: () => Effect.succeed(0),
  }),
)
