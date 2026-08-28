export * as SelectionWriter from "./selection-writer"

import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Hash } from "../util/hash"
import { CanonicalJson } from "../util/canonical-json"
import { Database } from "../database/database"
import {
  SelectionEnvelope,
  type SelectionArtifactBinding,
  type SelectionRef,
  type SelectionValidation,
} from "../contract/selection"
import type { GraphKind, GraphStatus } from "../contract/selection"
import { DeepAgentReleasedSnapshot } from "../deepagent/released-snapshot"
import { canonicalContextRef, ProjectScopeKey, SecurityNamespaceID } from "./reference"
import { type ContextCandidate } from "./federation"
import {
  SessionContextSelectionTable,
  SessionContextValidationTable,
  SessionProviderAttemptTable,
} from "./session-sql"
import { type QueryResultV2 } from "./resolver-v2"
import { type QueryEnvelope } from "./resolver-v2"
import { type SelectionCandidateBatch, type RankedCandidate } from "./selection-budget"

/**
 * C3-05 — production selection/validation write (V2 sole writer).
 *
 * Builds the frozen `SelectionEnvelope` from the C3-04 budgeted batch + the F1 resolver result, and
 * writes the selection + validation rows through the existing `session_context_selection` /
 * `session_context_validation` tables. The FK to the provider attempt is REQUIRED: every production
 * V2 attempt must be bound to a real (never v2-none) selection, and the write path refuses a missing
 * or inconsistent attempt binding with a typed error rather than silently proceeding.
 *
 * Exact retry: the same envelope content derives the same selectionId / validationId (byte-stable); a
 * second write with the same identity is a typed no-op/existing, never a duplicate row; a changed
 * envelope (graph-status drift) derives a NEW identity and must be written as a successor (higher
 * revision) before dispatch. The design §6.4 immutability rule holds: a dispatched selection is never
 * rewritten — a CAS-lost/conflict on a slot returns typed existing.
 */

/** Selection lifetime / validation window (same authority as the V3.9 admission chain). */
export const SelectionLifetimeMs = 14 * 60_000
export const ValidationMs = 60_000

// ---------------------------------------------------------------------------
// typed errors
// ---------------------------------------------------------------------------

/** A production V2 attempt is not bound to a real selection (required FK absent / mismatched). */
export class RequiredAttemptFkError extends Schema.TaggedErrorClass<RequiredAttemptFkError>()(
  "SelectionWriter.RequiredAttemptFkError",
  { reason: Schema.String },
) {}

/** A V2 selection/attempt carries the forbidden legacy v2-none graph revision. */
export class V2NoneForbiddenError extends Schema.TaggedErrorClass<V2NoneForbiddenError>()(
  "SelectionWriter.V2NoneForbiddenError",
  { graph: Schema.String },
) {}

/** The committed slot for (session, activity, revision) already holds a DIFFERENT selection. */
export class SelectionExistsConflictError extends Schema.TaggedErrorClass<SelectionExistsConflictError>()(
  "SelectionWriter.SelectionExistsConflictError",
  { revision: Schema.Int },
) {}

/** The attempt's validation identity drifted from the prepared selection (design §6.3 successor). */
export class ValidationMismatchError extends Schema.TaggedErrorClass<ValidationMismatchError>()(
  "SelectionWriter.ValidationMismatchError",
  { reason: Schema.String },
) {}

/** The selection row itself failed to decode from storage. */
export class SelectionRowCorruptError extends Schema.TaggedErrorClass<SelectionRowCorruptError>()(
  "SelectionWriter.SelectionRowCorruptError",
  { field: Schema.String },
) {}

export type Error =
  | RequiredAttemptFkError
  | V2NoneForbiddenError
  | SelectionExistsConflictError
  | ValidationMismatchError
  | SelectionRowCorruptError

// ---------------------------------------------------------------------------
// envelope builder (pure) + successor (pure)
// ---------------------------------------------------------------------------

/** Options the envelope builder needs that are NOT carried by the F1 result/envelope. */
export type BuildEnvelopeOptions = {
  readonly revision: number
  readonly triggerInputId: string
  readonly providerTurnSeq: number
  readonly selectionId?: string
  readonly outcome?: SelectionValidation["outcome"]
  readonly validUntil?: number
  readonly now?: number
}

/**
 * Build a frozen `SelectionEnvelope` from the budgeted batch + resolver result + query envelope.
 * Pure and deterministic: identity is content-addressed on stable selection fields only (no clock, no
 * absolute path, no random). Never produces v2-none — graph statuses always come from the four
 * explicit resolver statuses, and an all-denied/degraded result still yields an explicit selection
 * with an identity and an empty `selectedRefs`.
 */
export function buildSelectionEnvelope(
  batch: SelectionCandidateBatch,
  result: QueryResultV2,
  envelope: QueryEnvelope,
  opts: BuildEnvelopeOptions,
): SelectionEnvelope {
  const selectedRefs = batch.selected.map((ranked) => toSelectionRef(ranked))
  const projectionText = buildProjection(batch)
  const projectionHash = Hash.sha256(projectionText)
  const now = opts.now ?? Date.now()
  const seed = {
    schemaVersion: "context-selection.v1" as const,
    selectionMode: "v2" as const,
    revision: opts.revision,
    triggerInputId: opts.triggerInputId,
    membership: envelope.membership,
    location: envelope.location,
    principal: {
      principalId: envelope.principal.principalId,
      authorizationEpoch: envelope.principal.authorizationEpoch,
    },
    workspace: envelope.workspace,
    securityNamespace: envelope.securityNamespace,
    projectScope: envelope.projectScope,
    egress: envelope.egress,
    agentPolicy: envelope.agentPolicy,
    modelCapability: envelope.modelCapability,
    releasedKnowledge: envelope.releasedKnowledge,
    queryIntent: envelope.queryIntent,
    queryFingerprint: result.queryFingerprint,
    authorizationFingerprint: result.authorizationFingerprint,
    executionFingerprint: result.executionFingerprint,
    observedLocationMutationEpoch: envelope.observedLocationMutationEpoch ?? 0,
    selectedSourceFingerprint: selectedSourceFingerprint(batch, result),
    graphStatuses: result.graphStatuses,
    selectedRefs,
    projectionHash,
    tokenCount: batch.tokenCount,
  }
  const selectionId = opts.selectionId ?? selectionIdOf(seed)
  const outcome = opts.outcome ?? "valid"
  const validUntil = opts.validUntil ?? now + ValidationMs
  const validationId = validationIdOf({ selectionId, providerTurnSeq: opts.providerTurnSeq, seed, outcome })
  const artifactBinding: SelectionArtifactBinding = batch.selected.length > 0
    ? { status: "available", ref: `context-selection:${selectionId}` }
    : { status: "degraded_unavailable", inlineAudit: "deterministic_budget_no_selected_refs" }
  return {
    schemaVersion: seed.schemaVersion,
    selectionMode: seed.selectionMode,
    selectionId,
    revision: seed.revision,
    triggerInputId: seed.triggerInputId,
    membership: seed.membership,
    location: seed.location,
    principal: seed.principal,
    workspace: seed.workspace,
    securityNamespace: seed.securityNamespace,
    projectScope: seed.projectScope,
    egress: seed.egress,
    agentPolicy: seed.agentPolicy,
    modelCapability: seed.modelCapability,
    releasedKnowledge: seed.releasedKnowledge,
    queryIntent: seed.queryIntent,
    identity: {
      selectionId,
      revision: seed.revision,
      queryFingerprint: seed.queryFingerprint,
      authorizationFingerprint: seed.authorizationFingerprint,
      executionFingerprint: seed.executionFingerprint,
      observedLocationMutationEpoch: seed.observedLocationMutationEpoch,
      selectedSourceFingerprint: seed.selectedSourceFingerprint,
    },
    validation: { validationId, outcome, validUntil },
    graphStatuses: seed.graphStatuses,
    selectedRefs: seed.selectedRefs,
    projectionHash: seed.projectionHash,
    tokenCount: seed.tokenCount,
    artifactBinding,
  }
}

/**
 * Build the SELECTION successor (design §6.3) after a validation drift. The successor carries a NEW
 * identity (new digest content) at the NEXT revision, and an `invalidated` outcome so the caller/DB
 * records that the previous selection was superseded before the new one may dispatch. A rebuilt
 * attempt must be bound to THIS successor, never to the stale prior selection.
 */
export function rebuildForDrift(
  base: SelectionEnvelope,
  batch: SelectionCandidateBatch,
  result: QueryResultV2,
  envelope: QueryEnvelope,
  opts: { readonly triggerInputId: string; readonly providerTurnSeq: number; readonly now?: number },
): SelectionEnvelope {
  return buildSelectionEnvelope(batch, result, envelope, {
    revision: base.revision + 1,
    triggerInputId: opts.triggerInputId,
    providerTurnSeq: opts.providerTurnSeq,
    outcome: "invalidated",
    now: opts.now,
  })
}

// ---------------------------------------------------------------------------
// write / assert dispatch seam (Effect service over the DB)
// ---------------------------------------------------------------------------

/** The required attempt binding declaration. The FK to the provider attempt is non-optional. */
export type SelectionAttemptBinding = {
  readonly attemptId: string
  readonly providerTurnSeq: number
  readonly requestHash: string
  readonly providerId: string
}

export type WriteInput = {
  readonly envelope: SelectionEnvelope
  /** REQUIRED: the provider attempt this selection is bound to. Absent => required-FK error. */
  readonly attempt: SelectionAttemptBinding
  readonly now?: number
}

export type WriteResult =
  | { readonly kind: "written"; readonly selectionId: string; readonly validationId: string; readonly revision: number }
  | { readonly kind: "existing"; readonly selectionId: string; readonly validationId: string; readonly revision: number; readonly conflict: boolean }

/** The bound dispatch record proving an attempt references a real (non-v2-none) selection. */
export type SelectionDispatchRecord = {
  readonly attemptId: string
  readonly selectionId: string
  readonly revision: number
  readonly outcome: "valid" | "invalidated" | "denied" | "timeout"
}

export type AttemptBoundInput = {
  readonly attemptId: string
  readonly selectionId: string
  readonly now?: number
}

export type RevalidateInput = {
  readonly selectionId: string
  readonly providerTurnSeq: number
  readonly authorizationEpoch: number
  readonly egressEpoch: number
  readonly observedLocationMutationEpoch: number
  readonly selectedSourceFingerprint: string
  readonly validUntil: number
  readonly now?: number
}

export interface Interface {
  /** Write the selection + validation rows for a prepared attempt. Idempotent, FK-enforced. */
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, Error>
  /** Verify a production attempt is bound to a real (never v2-none) selection before dispatch. */
  readonly assertAttemptBound: (input: AttemptBoundInput) => Effect.Effect<SelectionDispatchRecord, Error>
  /** Re-validate a selection after a drift/rebuild (design §4.1 step 7), producing a valid validation. */
  readonly revalidate: (input: RevalidateInput) => Effect.Effect<string, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SelectionWriter") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const write = Effect.fn("SelectionWriter.write")(function* (input: WriteInput) {
      if (!input.attempt.attemptId || !input.attempt.requestHash || !input.attempt.providerId) {
        return yield* new RequiredAttemptFkError({ reason: "attempt_binding_absent" })
      }
      const envelope = input.envelope
      if (hasV2None(envelope.graphStatuses)) {
        return yield* new V2NoneForbiddenError({ graph: v2NoneGraph(envelope.graphStatuses) })
      }
      const now = input.now ?? Date.now()
      const existing = yield* db
        .select()
        .from(SessionContextSelectionTable)
        .where(
          and(
            eq(SessionContextSelectionTable.session_id, envelope.membership.sessionId),
            eq(SessionContextSelectionTable.activity_id, envelope.membership.activityId),
            eq(SessionContextSelectionTable.revision, envelope.revision),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        if (selectionRowsMatch(existing, envelope)) {
          const validationId = yield* ensureValidationRow(db, envelope, input.attempt, existing.selection_id, now)
          return { kind: "existing", selectionId: existing.selection_id, validationId, revision: existing.revision, conflict: false } as const
        }
        // CAS-lost: the slot for (session, activity, revision) already holds a DIFFERENT selection.
        // Design §6.4: never rewrite a dispatched selection — the caller must build a successor.
        return {
          kind: "existing",
          selectionId: existing.selection_id,
          validationId: "",
          revision: existing.revision,
          conflict: true,
        } as const
      }
      const created = yield* db
        .insert(SessionContextSelectionTable)
        .values(rowValues(envelope, now))
        .onConflictDoNothing()
        .returning({ selection_id: SessionContextSelectionTable.selection_id })
        .get()
        .pipe(Effect.orDie)
      const selectionId = created?.selection_id ?? envelope.selectionId
      const validationId = yield* ensureValidationRow(db, envelope, input.attempt, selectionId, now)
      return { kind: "written", selectionId, validationId, revision: envelope.revision } as const
    })

    const assertAttemptBound = Effect.fn("SelectionWriter.assertAttemptBound")(function* (input: AttemptBoundInput) {
        const attempt = yield* db
          .select()
          .from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.attempt_id, input.attemptId))
          .get()
          .pipe(Effect.orDie)
        if (!attempt) return yield* new RequiredAttemptFkError({ reason: "attempt_not_found" })
        if (attempt.selection_id !== input.selectionId) {
          return yield* new RequiredAttemptFkError({ reason: "attempt_selection_mismatch" })
        }
        const selection = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, input.selectionId))
          .get()
          .pipe(Effect.orDie)
        if (!selection) return yield* new RequiredAttemptFkError({ reason: "selection_not_found" })
        const statuses = parseStatuses(selection)
        if (hasV2None(statuses)) {
          return yield* new V2NoneForbiddenError({ graph: v2NoneGraph(statuses) })
        }
        const now = input.now ?? Date.now()
        const validation = yield* db
          .select()
          .from(SessionContextValidationTable)
          .where(
            and(
              eq(SessionContextValidationTable.selection_id, input.selectionId),
              eq(SessionContextValidationTable.provider_turn_seq, attempt.provider_turn_seq),
            ),
          )
          .orderBy(desc(SessionContextValidationTable.validated_at))
          .get()
          .pipe(Effect.orDie)
        if (!validation || validation.outcome !== "valid") {
          return yield* new ValidationMismatchError({ reason: "attempt_validation_not_valid" })
        }
        if (validation.valid_until <= now) {
          return yield* new ValidationMismatchError({ reason: "attempt_validation_expired" })
        }
        return {
          attemptId: attempt.attempt_id,
          selectionId: selection.selection_id,
          revision: selection.revision,
          outcome: validation.outcome,
        }
      },
    )

    const revalidate = Effect.fn("SelectionWriter.revalidate")(function* (input: RevalidateInput) {
      const now = input.now ?? Date.now()
      const validationId = validationIdOf({
        selectionId: input.selectionId,
        providerTurnSeq: input.providerTurnSeq,
        seed: {
          selectionId: input.selectionId,
          providerTurnSeq: input.providerTurnSeq,
          authorizationEpoch: input.authorizationEpoch,
          egressEpoch: input.egressEpoch,
          observedLocationMutationEpoch: input.observedLocationMutationEpoch,
          selectedSourceFingerprint: input.selectedSourceFingerprint,
        },
        outcome: "valid",
      })
      const inserted = yield* db
        .insert(SessionContextValidationTable)
        .values({
          validation_id: validationId,
          selection_id: input.selectionId,
          provider_turn_seq: input.providerTurnSeq,
          authorization_epoch: input.authorizationEpoch,
          egress_epoch: input.egressEpoch,
          observed_location_mutation_epoch: input.observedLocationMutationEpoch,
          selected_source_fingerprint: input.selectedSourceFingerprint,
          validated_at: now,
          valid_until: input.validUntil,
          outcome: "valid",
          reason_code: "selection_revalidated",
        })
        .onConflictDoNothing()
        .returning({ validation_id: SessionContextValidationTable.validation_id })
        .get()
        .pipe(Effect.orDie)
      if (inserted) return inserted.validation_id
      const existing = yield* db
        .select({ validation_id: SessionContextValidationTable.validation_id })
        .from(SessionContextValidationTable)
        .where(
          and(
            eq(SessionContextValidationTable.selection_id, input.selectionId),
            eq(SessionContextValidationTable.provider_turn_seq, input.providerTurnSeq),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return existing?.validation_id ?? validationId
    })

    return Service.of({ write, assertAttemptBound, revalidate })
  }),
)

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function selectionIdOf(seed: unknown): string {
  return Hash.sha256(CanonicalJson.stringify(seed))
}

function validationIdOf(input: {
  readonly selectionId: string
  readonly providerTurnSeq: number
  readonly seed: unknown
  readonly outcome: SelectionValidation["outcome"]
}): string {
  return Hash.sha256(
    CanonicalJson.stringify({
      selectionId: input.selectionId,
      providerTurnSeq: input.providerTurnSeq,
      genesis: input.seed,
      outcome: input.outcome,
    }),
  )
}

function selectedSourceFingerprint(batch: SelectionCandidateBatch, result: QueryResultV2): string {
  return Hash.sha256(
    CanonicalJson.stringify({
      selected: batch.selected.map((ranked) => canonicalContextRef(ranked.candidate.ref)),
      graphRevisions: Object.fromEntries(
        Object.keys(result.graphStatuses).map((graph) => [
          graph,
          result.graphStatuses[graph as GraphKind].revision,
        ]),
      ),
    }),
  )
}

function toSelectionRef(ranked: RankedCandidate): SelectionRef {
  const candidate = ranked.candidate
  return {
    graph: candidate.ref.graph,
    ref: canonicalContextRef(candidate.ref),
    token: candidate.title,
    score: ranked.score,
    freshness: "current",
    sensitivity: sensitivityOf(candidate),
    reason: `deterministic_rank:value_tier_${ranked.valueTier}`,
  }
}

function sensitivityOf(candidate: ContextCandidate): SelectionRef["sensitivity"] {
  if (candidate.trust === "governed_guidance") return "public"
  if (candidate.visibility === "governance_only") return "secret_adjacent"
  return "source_code"
}

function buildProjection(batch: SelectionCandidateBatch): string {
  return CanonicalJson.stringify({
    mode: "v2",
    refs: batch.selected.map((ranked) => ({
      graph: ranked.candidate.ref.graph,
      ref: canonicalContextRef(ranked.candidate.ref),
    })),
  })
}

function hasV2None(statuses: Readonly<Record<GraphKind, GraphStatus>>): boolean {
  return Object.values(statuses).some((status) => String(status.status) === "v2-none")
}

function v2NoneGraph(statuses: Readonly<Record<GraphKind, GraphStatus>>): string {
  return Object.keys(statuses).find((name) => String(statuses[name as GraphKind].status) === "v2-none") ?? "unknown"
}

function parseStatuses(row: typeof SessionContextSelectionTable.$inferSelect): Readonly<Record<GraphKind, GraphStatus>> {
  try {
    return JSON.parse(row.graph_statuses) as Readonly<Record<GraphKind, GraphStatus>>
  } catch {
    throw new SelectionRowCorruptError({ field: "graph_statuses" })
  }
}

function graphRevisions(statuses: Readonly<Record<GraphKind, GraphStatus>>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(statuses).map((graph) => [graph, statuses[graph as GraphKind].revision])))
}

/** Build the `session_context_selection` insert row from a frozen envelope. */
function rowValues(envelope: SelectionEnvelope, now: number): typeof SessionContextSelectionTable.$inferInsert {
  const projectionText = CanonicalJson.stringify({
    mode: "v2",
    refs: envelope.selectedRefs.map((ref) => ({ graph: ref.graph, ref: ref.ref })),
  })
  const bound = envelope.releasedKnowledge.binding === "bound"
  return {
    selection_id: envelope.selectionId,
    session_id: envelope.membership.sessionId,
    activity_id: envelope.membership.activityId,
    revision: envelope.revision,
    trigger_input_id: envelope.triggerInputId,
    location_key: envelope.location.locationKey,
    security_namespace_id: SecurityNamespaceID.make(envelope.securityNamespace.securityNamespaceId),
    project_scope_key: ProjectScopeKey.make(envelope.projectScope.projectScopeKey),
    query_fingerprint: envelope.identity.queryFingerprint,
    authorization_fingerprint: envelope.identity.authorizationFingerprint,
    authorization_epoch: envelope.principal.authorizationEpoch,
    execution_fingerprint: envelope.identity.executionFingerprint,
    selected_source_fingerprint: envelope.identity.selectedSourceFingerprint,
    observed_location_mutation_epoch: envelope.identity.observedLocationMutationEpoch,
    next_revalidation_at: envelope.validation.validUntil,
    released_knowledge_binding_state: envelope.releasedKnowledge.binding,
    released_knowledge_snapshot_id: bound ? envelope.releasedKnowledge.snapshotId : null,
    released_knowledge_generation: null,
    released_knowledge_membership_hash: null,
    released_knowledge_manifest_hash: null,
    released_knowledge_exact_refs: [],
    released_knowledge_exact_refs_fingerprint: DeepAgentReleasedSnapshot.exactRefsFingerprint([]),
    graph_revisions: graphRevisions(envelope.graphStatuses),
    graph_statuses: JSON.stringify(envelope.graphStatuses),
    selected_refs: JSON.stringify(envelope.selectedRefs),
    projection: projectionText,
    projection_hash: envelope.projectionHash,
    token_count: envelope.tokenCount,
    artifact_write_status: envelope.artifactBinding.status,
    artifact_ref: envelope.artifactBinding.status === "available" ? envelope.artifactBinding.ref : null,
    inline_audit: envelope.artifactBinding.status === "degraded_unavailable" ? envelope.artifactBinding.inlineAudit : null,
    created_at: now,
  }
}

/** Compare an existing row against an incoming envelope's stable selection payload. */
function selectionRowsMatch(
  row: typeof SessionContextSelectionTable.$inferSelect,
  envelope: SelectionEnvelope,
): boolean {
  return (
    row.session_id === envelope.membership.sessionId &&
    row.activity_id === envelope.membership.activityId &&
    row.query_fingerprint === envelope.identity.queryFingerprint &&
    row.authorization_fingerprint === envelope.identity.authorizationFingerprint &&
    row.execution_fingerprint === envelope.identity.executionFingerprint &&
    row.selected_source_fingerprint === envelope.identity.selectedSourceFingerprint &&
    row.projection_hash === envelope.projectionHash &&
    row.token_count === envelope.tokenCount &&
    row.graph_statuses === JSON.stringify(envelope.graphStatuses) &&
    row.selected_refs === JSON.stringify(envelope.selectedRefs)
  )
}

/** Idempotently write the validation row for a (selection, attempt turn) pair. */
function ensureValidationRow(
  db: Database.Interface["db"],
  envelope: SelectionEnvelope,
  attempt: SelectionAttemptBinding,
  selectionId: string,
  now: number,
): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const authorizationEpoch = envelope.principal.authorizationEpoch
    const egressEpoch = envelope.egress.epoch
    const observedLocationMutationEpoch = envelope.identity.observedLocationMutationEpoch
    const selectedSourceFingerprint = envelope.identity.selectedSourceFingerprint
    const validationId = validationIdOf({
      selectionId,
      providerTurnSeq: attempt.providerTurnSeq,
      seed: {
        selectionId,
        providerTurnSeq: attempt.providerTurnSeq,
        authorizationEpoch,
        egressEpoch,
        observedLocationMutationEpoch,
        selectedSourceFingerprint,
      },
      outcome: envelope.validation.outcome,
    })
    const inserted = yield* db
      .insert(SessionContextValidationTable)
      .values({
        validation_id: validationId,
        selection_id: selectionId,
        provider_turn_seq: attempt.providerTurnSeq,
        authorization_epoch: authorizationEpoch,
        egress_epoch: egressEpoch,
        observed_location_mutation_epoch: observedLocationMutationEpoch,
        selected_source_fingerprint: selectedSourceFingerprint,
        validated_at: now,
        valid_until: envelope.validation.validUntil,
        outcome: envelope.validation.outcome,
        reason_code: envelope.validation.outcome === "valid" ? "selection_current" : "selection_superseded",
      })
      .onConflictDoNothing()
      .returning({ validation_id: SessionContextValidationTable.validation_id })
      .get()
      .pipe(Effect.orDie)
    if (inserted) return inserted.validation_id
    const existing = yield* db
      .select({ validation_id: SessionContextValidationTable.validation_id })
      .from(SessionContextValidationTable)
      .where(
        and(
          eq(SessionContextValidationTable.selection_id, selectionId),
          eq(SessionContextValidationTable.provider_turn_seq, attempt.providerTurnSeq),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    return existing?.validation_id ?? validationId
  })
}
