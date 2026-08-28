export * as SessionRunnerCanonical from "./canonical-turn"

import { and, asc, desc, eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../../database/database"
import { ContextArtifactStore } from "../../context-federation/artifact-store"
import { SessionProviderAttempt } from "../../context-federation/provider-attempt"
import { ContextReference } from "../../context-federation/reference"
import { SessionContext } from "../../context-federation/session-context"
import { resolveGraphs, GraphOrder, type QueryEnvelope } from "../../context-federation/resolver-v2"
import { budgetSelection } from "../../context-federation/selection-budget"
import {
  buildSelectionEnvelope,
  isLegacyIncompleteRow,
  writeSelectionRow,
  assertAttemptBoundSelection,
} from "../../context-federation/selection-writer"
import { stagedV2Adapters } from "../../context-federation/staged-adapters-v2"
import type { GraphKind, SelectionEnvelope } from "../../contract/selection"
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
import { SessionSchema } from "../schema"
import { Hash } from "../../util/hash"
import { V2ProviderTurn } from "./v2-provider-turn"

// V2 runner turns bind Context Federation authority through the same admission chain as the legacy
// durable runtime (activity -> selection -> validation -> attempt). Since C3-08 the selection is a
// REAL four-graph V2 selection produced by the F1 resolver + F2 writer (never the legacy v2-none
// fallback), so a V2 attempt is always bound to real graph statuses/revisions. The runner
// composition uses the staged adapter set until production graph sources are wired (C7).
export const SelectionLifetimeMs = 14 * 60_000
export const ValidationMs = 60_000

const V2Namespace = ContextReference.SecurityNamespaceID.make("v2:local")
const V2Scope = ContextReference.ProjectScopeKey.make("v2:local")
const StagedPerGraphTimeoutMs = 5_000

// §16.3 order 4 package D — the legacy federation selection evidence seam is DELETED by C3-08.
// A V2 turn no longer copies legacy evidence (or the v2-none fallback) into the selection; the
// selection is produced by the F1 resolver + F2 writer and always carries real graph statuses.
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
      .select()
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
    // Reuse an existing V2 selection for this activity (exact-retry/continuation): ONLY a real V2
    // selection is dispatchable. A legacy_incomplete row (C3-08 read-side marking) stays readable
    // for history but is NOT reusable for a new dispatch — build a V2 successor instead.
    if (latest && !isLegacyIncompleteRow(latest)) return yield* admissionFromRow(latest, activity, input, now)
    const revision = latest ? latest.revision + 1 : 0
    return yield* buildV2Selection(input, activity, now, locationKey, revision)
  })
}

/** Derive the selection admission from an existing V2 selection row (read-only reuse). */
function admissionFromRow(
  row: typeof SessionContextSelectionTable.$inferSelect,
  activity: { readonly activityId: string },
  input: AdmitSelectionInput,
  now: number,
): Effect.Effect<SelectionAdmission, AdmissionError> {
  return Effect.gen(function* () {
    return {
      activityId: activity.activityId,
      selectionId: row.selection_id,
      projectionHash: row.projection_hash,
      authorizationEpoch: row.authorization_epoch,
      egressEpoch: input.system.baselineSeq,
      observedLocationMutationEpoch: row.observed_location_mutation_epoch,
      selectedSourceFingerprint: row.selected_source_fingerprint,
      nextRevalidationAt: row.next_revalidation_at,
    }
  })
}

/**
 * C3-08 — build a REAL V2 selection (never v2-none) through the F1 resolver-v2 + F2 selection-budget
 * + selection-writer flow, write the selection row, and derive the admission. A staged adapter set
 * yields explicit `degraded_unavailable` statuses until production graph sources are wired; every
 * graph still produces an explicit status + revision, so a V2 attempt is NEVER a v2-none fallback.
 */
function buildV2Selection(
  input: AdmitSelectionInput,
  activity: { readonly activityId: string; readonly triggerInputId: string },
  now: number,
  locationKey: string,
  revision: number,
): Effect.Effect<SelectionAdmission, AdmissionError> {
  const inputs = activityInputIds(input, activity.activityId)
  return Effect.gen(function* () {
    const ids = yield* inputs
    const envelope = buildV2Envelope(input, activity, ids, locationKey, now)
    const resolved = yield* resolveGraphs(envelope, stagedV2Adapters(), StagedPerGraphTimeoutMs)
    const batch = budgetSelection(resolved, envelope)
    const selectionEnvelope = buildSelectionEnvelope(batch, resolved, envelope, {
      revision,
      triggerInputId: activity.triggerInputId,
      providerTurnSeq: 0,
      now,
    })
    const written = yield* writeSelectionRow(input.db, selectionEnvelope, now).pipe(
      Effect.mapError((error) => new AdmissionError({ reason: `selection_commit_failed:${selectionErrorDetail(error)}` })),
    )
    if (written.conflict && !selectionRowsEqual(written.selectionId, selectionEnvelope.selectionId)) {
      // A different selection already owns this (session, activity, revision) slot. Build a
      // successor at the next revision so the attempt binds THIS turn's selection (design §6.4).
      const successor = buildSelectionEnvelope(batch, resolved, envelope, {
        revision: revision + 1,
        triggerInputId: activity.triggerInputId,
        providerTurnSeq: 0,
        now,
      })
      const successorWritten = yield* writeSelectionRow(input.db, successor, now).pipe(
        Effect.mapError((error) => new AdmissionError({ reason: `selection_commit_failed:${selectionErrorDetail(error)}` })),
      )
      return admissionOf(successorWritten.selectionId, successor, input, activity, now)
    }
    return admissionOf(written.selectionId, selectionEnvelope, input, activity, now)
  })
}

function admissionOf(
  selectionId: string,
  envelope: SelectionEnvelope,
  input: AdmitSelectionInput,
  activity: { readonly activityId: string },
  now: number,
): SelectionAdmission {
  return {
    activityId: activity.activityId,
    selectionId,
    projectionHash: envelope.projectionHash,
    authorizationEpoch: envelope.principal.authorizationEpoch,
    egressEpoch: envelope.egress.epoch,
    observedLocationMutationEpoch: envelope.identity.observedLocationMutationEpoch,
    selectedSourceFingerprint: envelope.identity.selectedSourceFingerprint,
    nextRevalidationAt: envelope.validation.validUntil,
  }
}

/** Build the F1 resolver QueryEnvelope for a V2 runner turn (v2:local authority scope). */
function buildV2Envelope(
  input: AdmitSelectionInput,
  activity: { readonly activityId: string; readonly triggerInputId: string },
  inputIds: readonly string[],
  locationKey: string,
  now: number,
): QueryEnvelope {
  const location = ContextReference.LocationKey.make(locationKey)
  const principal = {
    securityNamespaceId: V2Namespace,
    principalId: input.sessionID,
    authorizationEpoch: input.system.revision,
    locationKeys: [location],
    projectScopeKeys: [V2Scope],
    sessionIds: [input.sessionID],
    subjectIds: [],
    allowBuiltin: false,
  }
  const graphs: GraphKind[] = [...GraphOrder]
  return {
    membership: { sessionId: input.sessionID, activityId: activity.activityId, inputIds },
    location: { locationKey, ...(input.location.workspaceID === undefined ? {} : { workspaceId: input.location.workspaceID }) },
    principal,
    workspace: { workspaceId: input.location.workspaceID ?? "" },
    securityNamespace: { securityNamespaceId: V2Namespace },
    projectScope: { projectScopeKey: V2Scope },
    egress: { policyId: "v2:history-context", epoch: input.system.baselineSeq, graphs, sensitivities: [] },
    agentPolicy: { agentId: input.agent, autonomyCeiling: "medium", permitDegraded: true },
    modelCapability: { modelId: "", providerId: "", protocol: "openai.responses", contextWindow: 0, structuredOutput: false },
    releasedKnowledge: { snapshotId: "", binding: "unavailable" },
    queryIntent: "search",
    query: "session context",
    observedLocationMutationEpoch: 0,
    now,
  }
}

function selectionRowsEqual(a: string, b: string) {
  return a === b
}

function selectionErrorDetail(error: unknown): string {
  return typeof error === "object" && error !== null && "_tag" in error
    ? String((error as { readonly _tag: unknown })._tag)
    : String(error)
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
  const result = yield* input.db
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
  // C3-08 dispatch seam: before ONE physical dispatch, the attempt must be bound to a real
  // (never v2-none, never legacy_incomplete) selection with a valid, unexpired validation. A
  // legacy_incomplete or v2-none/absent selection refuses here (no request is dispatched).
  yield* assertAttemptBoundSelection(input.db, {
    attemptId: result.attempt.attemptId,
    selectionId: input.admission.selectionId,
    now,
  }).pipe(Effect.mapError((error) => new AdmissionError({ reason: `selection_dispatch_refused:${selectionErrorDetail(error)}` })))
  return result
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
