export * as AdvanceSelection from "./advance-selection"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Hash } from "../util/hash"
import { CanonicalJson } from "../util/canonical-json"
import { Database } from "../database/database"
import { SelectionWriter } from "./selection-writer"
import { type SelectionEnvelope, type SelectionRef, type GraphKind, type GraphStatus } from "../contract/selection"
import { SessionContextSelectionTable, SessionProviderAttemptTable } from "./session-sql"

/**
 * C3-06b — next-revision selection feed built from tool results.
 *
 * After a dispatched attempt returns tool outcomes, the next attempt must be built on a NEW selection
 * revision that folds the tool results in as new evidence. This seam:
 *   1. inspects the CURRENT dispatched attempt (its `selection_id`);
 *   2. builds a next-revision `SelectionEnvelope` (revision + 1) whose `selectedRefs` = the prior
 *      selection's refs PLUS the tool-evidence refs;
 *   3. writes it through F2's `SelectionWriter` (deterministic, idempotent, real identity — never
 *      v2-none), binding it to the NEXT attempt turn so it is NOT bindable by the current attempt.
 *
 * The current attempt row is never modified: the seam only reads it (to learn the current
 * `selection_id` and the next `provider_turn_seq`) and writes a NEW selection row. `assertAttemptBound`
 * therefore refuses to bind the new selection to the OLD attempt (`attempt_selection_mismatch`),
 * because the old attempt's stored `selection_id` still points at the prior revision.
 */

// ---------------------------------------------------------------------------
// typed errors
// ---------------------------------------------------------------------------

/** The named attempt does not exist. */
export class AttemptNotFoundError extends Schema.TaggedErrorClass<AttemptNotFoundError>()(
  "AdvanceSelection.AttemptNotFoundError",
  {},
) {}

/** The caller's `selectionId` does not match the attempt's stored `selection_id`. */
export class SelectionMismatchError extends Schema.TaggedErrorClass<SelectionMismatchError>()(
  "AdvanceSelection.SelectionMismatchError",
  { expected: Schema.String, got: Schema.String },
) {}

/** The current selection row named by `selectionId` does not exist / could not be decoded. */
export class AdvanceSelectionNotFoundError extends Schema.TaggedErrorClass<AdvanceSelectionNotFoundError>()(
  "AdvanceSelection.NotFoundError",
  { reason: Schema.String },
) {}

export type Error = AttemptNotFoundError | SelectionMismatchError | AdvanceSelectionNotFoundError | SelectionWriter.Error

// ---------------------------------------------------------------------------
// seam
// ---------------------------------------------------------------------------

export type AdvanceInput = {
  readonly attemptId: string
  readonly selectionId: string
  readonly toolEvidence: readonly SelectionRef[]
  readonly now?: number
}

export type AdvanceResult = {
  readonly selectionId: string
  readonly revision: number
  /** The attempt's stored selection_id, unchanged by the advance. */
  readonly attemptSelectionId: string
}

export interface Interface {
  readonly advanceSelectionAfterToolResults: (input: AdvanceInput) => Effect.Effect<AdvanceResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/AdvanceSelection") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const writer = yield* SelectionWriter.Service

    const advance = Effect.fn("AdvanceSelection.advanceSelectionAfterToolResults")(function* (input: AdvanceInput) {
      const now = input.now ?? Date.now()
      const attempt = yield* db
        .select()
        .from(SessionProviderAttemptTable)
        .where(eq(SessionProviderAttemptTable.attempt_id, input.attemptId))
        .get()
        .pipe(Effect.orDie)
      if (!attempt) return yield* new AttemptNotFoundError()
      if (attempt.selection_id !== input.selectionId) {
        return yield* new SelectionMismatchError({ expected: attempt.selection_id, got: input.selectionId })
      }
      const row = yield* db
        .select()
        .from(SessionContextSelectionTable)
        .where(eq(SessionContextSelectionTable.selection_id, input.selectionId))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new AdvanceSelectionNotFoundError({ reason: "selection_row_missing" })

      const envelope = buildAdvanceEnvelope(row, input.toolEvidence, now)
      const bound = {
        attemptId: `advance:${attempt.attempt_id}`,
        providerTurnSeq: attempt.provider_turn_seq + 1,
        requestHash: requestHashOf(input.toolEvidence),
        providerId: attempt.provider_id,
      }
      const result = yield* writer.write({ envelope, attempt: bound, now })
      return {
        selectionId: result.selectionId,
        revision: result.revision,
        attemptSelectionId: attempt.selection_id,
      }
    })

    return Service.of({ advanceSelectionAfterToolResults: advance })
  }),
)

// ---------------------------------------------------------------------------
// envelope builder (pure, deterministic)
// ---------------------------------------------------------------------------

function buildAdvanceEnvelope(
  row: typeof SessionContextSelectionTable.$inferSelect,
  toolEvidence: readonly SelectionRef[],
  now: number,
): SelectionEnvelope {
  const revision = row.revision + 1
  const priorRefs = parseSelectedRefs(row.selected_refs)
  const selectedRefs = [...priorRefs, ...toolEvidence]
  const graphStatuses = parseGraphStatuses(row.graph_statuses)
  const selectionId = Hash.sha256(
    CanonicalJson.stringify({
      base: {
        sessionId: row.session_id,
        activityId: row.activity_id,
        revision,
        queryFingerprint: row.query_fingerprint,
        authorizationFingerprint: row.authorization_fingerprint,
        executionFingerprint: row.execution_fingerprint,
        observedLocationMutationEpoch: row.observed_location_mutation_epoch,
      },
      toolEvidence,
    }),
  )
  const selectedSourceFingerprint = Hash.sha256(
    CanonicalJson.stringify({
      selected: selectedRefs.map((ref) => ({ graph: ref.graph, ref: ref.ref })),
      graphRevisions: graphRevisionsMap(graphStatuses),
    }),
  )
  const projectionHash = Hash.sha256(
    CanonicalJson.stringify({
      mode: "v2",
      refs: selectedRefs.map((ref) => ({ graph: ref.graph, ref: ref.ref })),
    }),
  )
  const validationId = Hash.sha256(CanonicalJson.stringify({ selectionId, revision, toolEvidence }))
  const binding = row.released_knowledge_binding_state === "bound" ? "bound" : "unavailable"
  return {
    schemaVersion: "context-selection.v1",
    selectionMode: "v2",
    selectionId,
    revision,
    triggerInputId: row.trigger_input_id,
    membership: { sessionId: row.session_id, activityId: row.activity_id, inputIds: [row.trigger_input_id] },
    location: { locationKey: row.location_key },
    principal: { principalId: "", authorizationEpoch: row.authorization_epoch },
    workspace: { workspaceId: "" },
    securityNamespace: { securityNamespaceId: row.security_namespace_id ?? "" },
    projectScope: { projectScopeKey: row.project_scope_key ?? "" },
    egress: { policyId: "", epoch: 0, graphs: [], sensitivities: [] },
    agentPolicy: { agentId: "", autonomyCeiling: "medium", permitDegraded: false },
    modelCapability: { modelId: "", providerId: "", protocol: "openai.responses", contextWindow: 0, structuredOutput: false },
    releasedKnowledge: {
      snapshotId: row.released_knowledge_snapshot_id ?? "",
      binding,
    },
    queryIntent: "search",
    identity: {
      selectionId,
      revision,
      queryFingerprint: row.query_fingerprint,
      authorizationFingerprint: row.authorization_fingerprint,
      executionFingerprint: row.execution_fingerprint,
      observedLocationMutationEpoch: row.observed_location_mutation_epoch,
      selectedSourceFingerprint,
    },
    validation: { validationId, outcome: "valid", validUntil: now + SelectionWriter.ValidationMs },
    graphStatuses,
    selectedRefs,
    projectionHash,
    tokenCount: row.token_count + toolEvidence.length,
    artifactBinding: { status: "degraded_unavailable", inlineAudit: "tool_result_advance" },
  }
}

function parseSelectedRefs(json: string): SelectionRef[] {
  try {
    return JSON.parse(json) as SelectionRef[]
  } catch {
    throw new AdvanceSelectionNotFoundError({ reason: "selected_refs_corrupt" })
  }
}

function parseGraphStatuses(json: string): Readonly<Record<GraphKind, GraphStatus>> {
  try {
    return JSON.parse(json) as Readonly<Record<GraphKind, GraphStatus>>
  } catch {
    throw new AdvanceSelectionNotFoundError({ reason: "graph_statuses_corrupt" })
  }
}

function graphRevisionsMap(statuses: Readonly<Record<GraphKind, GraphStatus>>): Record<string, string> {
  return Object.fromEntries(Object.keys(statuses).map((graph) => [graph, statuses[graph as GraphKind].revision]))
}

function requestHashOf(toolEvidence: readonly SelectionRef[]): string {
  return Hash.sha256(
    CanonicalJson.stringify({
      kind: "tool_result_advance",
      refs: toolEvidence.map((ref) => ({ graph: ref.graph, ref: ref.ref })),
    }),
  )
}
