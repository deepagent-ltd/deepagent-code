export * as SessionContext from "./session-context"

import { randomBytes } from "node:crypto"
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import { SessionInputTable } from "../session/sql"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { DeepAgentReleasedSnapshot, type Binding } from "../deepagent/released-snapshot"
import { GraphKind } from "./contract"
import { ContextArtifactStore, type AuditArtifact } from "./artifact-store"
import { GraphQueryStatus } from "./federation"
import { Sensitivity } from "./authorization"
import type { Rendered } from "./projection"
import { ContextRef, LocationKey, ProjectScopeKey, SecurityNamespaceID } from "./reference"
import { isLegacyIncompleteRow } from "./selection-writer"
import {
  SessionActivityInputTable,
  SessionActivityTable,
  SessionContextSelectionInputTable,
  SessionContextSelectionTable,
  SessionContextValidationTable,
} from "./session-sql"

export type Activity = {
  readonly activityId: string
  readonly sessionId: SessionSchema.ID
  readonly ordinal: number
  readonly triggerInputId: string
  readonly delivery: "steer" | "queue" | "goal_steer"
  readonly state: "active" | "settled" | "failed" | "interrupted"
  readonly createdAt: number
  readonly settledAt?: number
}

export type SelectedRef = {
  readonly ref: ContextRef
  readonly token: string
  readonly provenanceTokens: readonly string[]
  readonly relations: readonly {
    readonly relation: string
    readonly token: string
    readonly freshness: "exact" | "rebound" | "broken"
  }[]
  readonly freshness: "current" | "historical" | "expired" | "superseded" | "conflict" | "unknown"
  readonly sensitivity: Sensitivity
  readonly score: number
  readonly reason: string
  readonly excerpt: string
  readonly projectionStart: number
  readonly projectionEnd: number
}

const SelectedRef = Schema.Struct({
  ref: ContextRef,
  token: Schema.String,
  provenanceTokens: Schema.Array(Schema.String),
  relations: Schema.Array(
    Schema.Struct({
      relation: Schema.String,
      token: Schema.String,
      freshness: Schema.Literals(["exact", "rebound", "broken"]),
    }),
  ),
  freshness: Schema.Literals(["current", "historical", "expired", "superseded", "conflict", "unknown"]),
  sensitivity: Sensitivity,
  score: Schema.Finite,
  reason: Schema.String,
  excerpt: Schema.String,
  projectionStart: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  projectionEnd: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

export type MinimalAudit = {
  readonly schemaVersion: "minimal-context-audit.v1"
  readonly reasonCode: string
  readonly projectionHash: string
  readonly exposureHash: string
  readonly refTokens: readonly string[]
  readonly graphStatuses: readonly GraphQueryStatus[]
  readonly authorizationFingerprint: string
  readonly executionFingerprint: string
}

const MinimalAudit = Schema.Struct({
  schemaVersion: Schema.Literal("minimal-context-audit.v1"),
  reasonCode: Schema.String,
  projectionHash: Schema.String,
  exposureHash: Schema.String,
  refTokens: Schema.Array(Schema.String),
  graphStatuses: Schema.Array(GraphQueryStatus),
  authorizationFingerprint: Schema.String,
  executionFingerprint: Schema.String,
})

const GraphRevisions = Schema.Struct({
  code: Schema.String,
  knowledge: Schema.String,
  memory: Schema.String,
  documents: Schema.String,
}) satisfies Schema.Schema<Readonly<Record<typeof GraphKind.Type, string>>>

export type ArtifactBinding =
  | { readonly status: "available"; readonly ref: string }
  | { readonly status: "degraded_unavailable"; readonly inlineAudit: MinimalAudit }

export type Selection = {
  readonly selectionId: string
  readonly sessionId: SessionSchema.ID
  readonly activityId: string
  readonly revision: number
  readonly triggerInputId: string
  readonly locationKey: LocationKey
  readonly securityNamespaceId: SecurityNamespaceID
  readonly projectScopeKey: ProjectScopeKey
  readonly promotedInputIds: readonly string[]
  readonly queryFingerprint: string
  readonly authorizationFingerprint: string
  readonly authorizationEpoch: number
  readonly executionFingerprint: string
  readonly selectedSourceFingerprint: string
  readonly observedLocationMutationEpoch: number
  readonly nextRevalidationAt: number
  readonly releasedKnowledgeBinding: Binding
  readonly graphRevisions: Readonly<Record<GraphKind, string>>
  readonly graphStatuses: readonly GraphQueryStatus[]
  readonly selectedRefs: readonly SelectedRef[]
  readonly projection: string
  readonly projectionHash: string
  readonly tokenCount: number
  readonly artifactBinding: ArtifactBinding
  readonly createdAt: number
  /**
   * C3-08 read-side marking (no schema column): true when the row was committed by the pre-switch
   * legacy evidence bridge (graph_statuses is the legacy GraphQueryStatus ARRAY shape or
   * graph_revisions carries the forbidden v2-none value). Such rows stay READABLE for history/export
   * but are NOT usable for a new V2 dispatch (the dispatch seam refuses them).
   */
  readonly legacyIncomplete?: boolean
}

export class InputError extends Schema.TaggedErrorClass<InputError>()("SessionContext.InputError", {
  reason: Schema.Literals(["missing", "not_promoted", "wrong_session", "wrong_delivery", "already_owned", "order"]),
}) {}

export class ActivityBlockedError extends Schema.TaggedErrorClass<ActivityBlockedError>()(
  "SessionContext.ActivityBlockedError",
  {},
) {}

export class ActivityStateError extends Schema.TaggedErrorClass<ActivityStateError>()(
  "SessionContext.ActivityStateError",
  {},
) {}

export class SelectionConflictError extends Schema.TaggedErrorClass<SelectionConflictError>()(
  "SessionContext.SelectionConflictError",
  {},
) {}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("SessionContext.ValidationError", {}) {}

export class AuditStorageUnavailableError extends Schema.TaggedErrorClass<AuditStorageUnavailableError>()(
  "SessionContext.AuditStorageUnavailableError",
  { reasonCode: Schema.String },
) {}

export class StoredDataError extends Schema.TaggedErrorClass<StoredDataError>()("SessionContext.StoredDataError", {
  field: Schema.String,
}) {}

export type Error =
  | InputError
  | ActivityBlockedError
  | ActivityStateError
  | SelectionConflictError
  | ValidationError
  | AuditStorageUnavailableError
  | StoredDataError

export interface Interface {
  readonly openActivity: (input: {
    readonly sessionId: SessionSchema.ID
    readonly triggerInputId: string
    readonly now?: number
  }) => Effect.Effect<Activity, Error>
  readonly attachInputs: (input: {
    readonly activityId: string
    readonly inputIds: readonly string[]
    readonly now?: number
  }) => Effect.Effect<readonly string[], Error>
  readonly settleActivity: (input: {
    readonly activityId: string
    readonly state: "settled" | "failed" | "interrupted"
    readonly now?: number
  }) => Effect.Effect<Activity | undefined, Error>
  readonly commitSelection: (input: CommitSelectionInput) => Effect.Effect<Selection, Error>
  readonly appendValidation: (input: ValidationInput) => Effect.Effect<string, Error>
  readonly hasValidValidation: (input: {
    readonly selectionId: string
    readonly providerTurnSeq: number
    readonly authorizationEpoch: number
    readonly egressEpoch: number
    readonly observedLocationMutationEpoch: number
    readonly selectedSourceFingerprint: string
    readonly now?: number
  }) => Effect.Effect<boolean>
  readonly getSelection: (selectionId: string) => Effect.Effect<Selection | undefined, StoredDataError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionContext") {}

export type CommitSelectionInput = {
  readonly securityNamespaceId: SecurityNamespaceID
  readonly projectScopeKey: ProjectScopeKey
  readonly sessionId: SessionSchema.ID
  readonly activityId: string
  readonly revision: number
  readonly triggerInputId: string
  readonly locationKey: LocationKey
  readonly promotedInputIds: readonly string[]
  readonly queryFingerprint: string
  readonly authorizationFingerprint: string
  readonly authorizationEpoch: number
  readonly executionFingerprint: string
  readonly selectedSourceFingerprint: string
  readonly observedLocationMutationEpoch: number
  readonly nextRevalidationAt: number
  readonly releasedKnowledgeBinding: Binding
  readonly graphRevisions: Readonly<Record<GraphKind, string>>
  readonly graphStatuses: readonly GraphQueryStatus[]
  readonly selectedRefs: readonly SelectedRef[]
  readonly rendered: Rendered
  readonly artifact: Omit<
    AuditArtifact,
    "schemaVersion" | "selectionId" | "queryFingerprint" | "authorizationFingerprint" | "graphStatuses" | "selected"
  >
  readonly now?: number
}

export type ValidationInput = {
  readonly selectionId: string
  readonly providerTurnSeq: number
  readonly authorizationEpoch: number
  readonly egressEpoch: number
  readonly observedLocationMutationEpoch: number
  readonly selectedSourceFingerprint: string
  readonly validatedAt: number
  readonly validUntil: number
  readonly outcome: "valid" | "invalidated" | "denied" | "timeout"
  readonly reasonCode: string
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const artifacts = yield* ContextArtifactStore.Service

    const openActivity = Effect.fn("SessionContext.openActivity")(function* (input: {
      readonly sessionId: SessionSchema.ID
      readonly triggerInputId: string
      readonly now?: number
    }) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const admitted = yield* tx
              .select()
              .from(SessionInputTable)
              .where(eq(SessionInputTable.id, SessionMessage.ID.make(input.triggerInputId)))
              .get()
            if (!admitted) return yield* new InputError({ reason: "missing" })
            if (admitted.session_id !== input.sessionId) return yield* new InputError({ reason: "wrong_session" })
            if (admitted.promoted_seq === null) return yield* new InputError({ reason: "not_promoted" })
            yield* tx.run(sql`
              INSERT INTO session_activity_admission (
                admission_id, session_id, source_kind, session_input_id, admitted_message_id,
                delivery, payload_fingerprint_kind, payload_fingerprint, created_at
              ) VALUES (
                ${`v2:${admitted.id}`}, ${admitted.session_id}, 'session_input', ${admitted.id}, ${admitted.id},
                ${admitted.delivery}, 'payload_hash', ${Hash.sha256(JSON.stringify(admitted.prompt))}, ${admitted.time_created}
              )
              ON CONFLICT(session_input_id) DO NOTHING
            `)
            const owned = yield* tx
              .select({ activity_id: SessionActivityInputTable.activity_id })
              .from(SessionActivityInputTable)
              .where(eq(SessionActivityInputTable.input_id, input.triggerInputId))
              .get()
            if (owned) {
              const existing = yield* tx
                .select()
                .from(SessionActivityTable)
                .where(eq(SessionActivityTable.activity_id, owned.activity_id))
                .get()
              if (!existing) return yield* new ActivityStateError()
              return activity(existing)
            }
            const active = yield* tx
              .select()
              .from(SessionActivityTable)
              .where(
                and(eq(SessionActivityTable.session_id, input.sessionId), eq(SessionActivityTable.state, "active")),
              )
              .get()
            if (active && admitted.delivery === "queue") return yield* new ActivityBlockedError()
            const now = input.now ?? Date.now()
            if (active) {
              const ordinal = yield* nextInputOrdinal(tx, active.activity_id)
              yield* tx
                .insert(SessionActivityInputTable)
                .values({
                  activity_id: active.activity_id,
                  input_id: admitted.id,
                  ordinal,
                  admitted_seq: admitted.admitted_seq,
                  role: "steer",
                  promoted_at: now,
                })
                .run()
              return activity(active)
            }
            const latest = yield* tx
              .select({ ordinal: max(SessionActivityTable.ordinal) })
              .from(SessionActivityTable)
              .where(eq(SessionActivityTable.session_id, input.sessionId))
              .get()
            const created = {
              activity_id: opaque("activity"),
              session_id: input.sessionId,
              ordinal: (latest?.ordinal ?? -1) + 1,
              trigger_input_id: admitted.id,
              delivery: admitted.delivery,
              state: "active" as const,
              created_at: now,
              settled_at: null,
            }
            yield* tx.insert(SessionActivityTable).values(created).run()
            yield* tx
              .insert(SessionActivityInputTable)
              .values({
                activity_id: created.activity_id,
                input_id: admitted.id,
                ordinal: 0,
                admitted_seq: admitted.admitted_seq,
                role: "trigger",
                promoted_at: now,
              })
              .run()
            return activity(created)
          }),
        )
        .pipe(preserveErrors)
    })

    const attachInputs = Effect.fn("SessionContext.attachInputs")(function* (input: {
      readonly activityId: string
      readonly inputIds: readonly string[]
      readonly now?: number
    }) {
      if (new Set(input.inputIds).size !== input.inputIds.length) return yield* new InputError({ reason: "order" })
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const owner = yield* tx
              .select()
              .from(SessionActivityTable)
              .where(eq(SessionActivityTable.activity_id, input.activityId))
              .get()
            if (!owner || owner.state !== "active") return yield* new ActivityStateError()
            const rows = input.inputIds.length
              ? yield* tx
                  .select()
                  .from(SessionInputTable)
                  .where(
                    inArray(
                      SessionInputTable.id,
                      input.inputIds.map((id) => SessionMessage.ID.make(id)),
                    ),
                  )
                  .all()
              : []
            if (rows.length !== input.inputIds.length) return yield* new InputError({ reason: "missing" })
            if (rows.some((row) => row.session_id !== owner.session_id))
              return yield* new InputError({ reason: "wrong_session" })
            if (rows.some((row) => row.promoted_seq === null)) return yield* new InputError({ reason: "not_promoted" })
            if (rows.some((row) => row.delivery === "queue")) return yield* new InputError({ reason: "wrong_delivery" })
            const ordered = rows.toSorted((a, b) => a.admitted_seq - b.admitted_seq)
            if (ordered.some((row, index) => row.id !== input.inputIds[index])) {
              return yield* new InputError({ reason: "order" })
            }
            const existing = input.inputIds.length
              ? yield* tx
                  .select()
                  .from(SessionActivityInputTable)
                  .where(inArray(SessionActivityInputTable.input_id, [...input.inputIds]))
                  .all()
              : []
            if (existing.some((row) => row.activity_id !== input.activityId)) {
              return yield* new InputError({ reason: "already_owned" })
            }
            const already = new Set(existing.map((row) => row.input_id))
            const firstOrdinal = yield* nextInputOrdinal(tx, input.activityId)
            const missing = ordered.filter((row) => !already.has(row.id))
            if (missing.length > 0) {
              yield* tx
                .insert(SessionActivityInputTable)
                .values(
                  missing.map((row, index) => ({
                    activity_id: input.activityId,
                    input_id: row.id,
                    ordinal: firstOrdinal + index,
                    admitted_seq: row.admitted_seq,
                    role: "steer" as const,
                    promoted_at: input.now ?? Date.now(),
                  })),
                )
                .run()
            }
            return input.inputIds
          }),
        )
        .pipe(preserveErrors)
    })

    const settleActivity = Effect.fn("SessionContext.settleActivity")(function* (input: {
      readonly activityId: string
      readonly state: "settled" | "failed" | "interrupted"
      readonly now?: number
    }) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // Idempotent settle (BUG-003): a missing row or one already in a terminal state is a
            // no-op, not an error — multiple terminal paths (runLoop exit, resolve rollback,
            // restart recovery) may legitimately race to settle the same activity. Real DB
            // failures still surface through the error channel.
            const current = yield* tx
              .select()
              .from(SessionActivityTable)
              .where(eq(SessionActivityTable.activity_id, input.activityId))
              .get()
            if (!current || current.state !== "active") return undefined
            const settled = yield* tx
              .update(SessionActivityTable)
              .set({ state: input.state, settled_at: input.now ?? Date.now() })
              .where(
                and(eq(SessionActivityTable.activity_id, input.activityId), eq(SessionActivityTable.state, "active")),
              )
              .returning()
              .get()
            if (!settled) return undefined
            return activity(settled)
          }),
        )
        .pipe(preserveErrors)
    })

    const getSelection = Effect.fn("SessionContext.getSelection")(function* (selectionId: string) {
      const row = yield* db
        .select()
        .from(SessionContextSelectionTable)
        .where(eq(SessionContextSelectionTable.selection_id, selectionId))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return yield* decodeSelection(db, row)
    })

    const commitSelection = Effect.fn("SessionContext.commitSelection")(function* (input: CommitSelectionInput) {
      if (Hash.sha256(input.rendered.projection) !== input.rendered.projectionHash) {
        return yield* new SelectionConflictError()
      }
      if (
        input.selectedRefs.some(
          (selected) =>
            input.rendered.projection.slice(selected.projectionStart, selected.projectionEnd) !== selected.token,
        )
      ) {
        return yield* new SelectionConflictError()
      }
      const existing = yield* db
        .select()
        .from(SessionContextSelectionTable)
        .where(
          and(
            eq(SessionContextSelectionTable.session_id, input.sessionId),
            eq(SessionContextSelectionTable.activity_id, input.activityId),
            eq(SessionContextSelectionTable.revision, input.revision),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        const decoded = yield* decodeSelection(db, existing)
        if (!matchesSelection(decoded, input)) return yield* new SelectionConflictError()
        return decoded
      }
      const selectionId = opaque("selection")
      const now = input.now ?? Date.now()
      const artifact = {
        ...input.artifact,
        schemaVersion: 1 as const,
        selectionId,
        queryFingerprint: input.queryFingerprint,
        authorizationFingerprint: input.authorizationFingerprint,
        graphStatuses: input.graphStatuses,
        selected: input.selectedRefs.map((selected) => ({
          ref: selected.ref,
          sensitivity: selected.sensitivity,
          score: selected.score,
          reason: selected.reason,
          excerpt: selected.excerpt,
        })),
      }
      const writeArtifact = (candidate: AuditArtifact) =>
        artifacts.write({
          securityNamespaceId: input.securityNamespaceId,
          sessionId: input.sessionId,
          selectionId,
          authorizationFingerprint: input.authorizationFingerprint,
          artifact: candidate,
          now,
        })
      const artifactResult = yield* writeArtifact(artifact).pipe(
        Effect.catch((error) =>
          artifact.rejected.length > 0 ? writeArtifact({ ...artifact, rejected: [] }) : Effect.fail(error),
        ),
        Effect.map((written) => ({ status: "available" as const, ref: written.ref })),
        Effect.catch((error) =>
          artifacts.policy === "required"
            ? Effect.fail(new AuditStorageUnavailableError({ reasonCode: error._tag }))
            : Effect.succeed({
                status: "degraded_unavailable" as const,
                inlineAudit: minimalAudit(input, error._tag),
              }),
        ),
      )

      const inserted = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const owner = yield* tx
              .select()
              .from(SessionActivityTable)
              .where(eq(SessionActivityTable.activity_id, input.activityId))
              .get()
            if (!owner || owner.session_id !== input.sessionId || owner.state !== "active") {
              return yield* new ActivityStateError()
            }
            if (owner.trigger_input_id !== input.triggerInputId) return yield* new SelectionConflictError()
            if (input.revision === 0 && input.promotedInputIds[0] !== owner.trigger_input_id) {
              return yield* new InputError({ reason: "order" })
            }
            const activityInputs = input.promotedInputIds.length
              ? yield* tx
                  .select({ input_id: SessionActivityInputTable.input_id })
                  .from(SessionActivityInputTable)
                  .where(
                    and(
                      eq(SessionActivityInputTable.activity_id, input.activityId),
                      inArray(SessionActivityInputTable.input_id, [...input.promotedInputIds]),
                    ),
                  )
                  .orderBy(asc(SessionActivityInputTable.admitted_seq))
                  .all()
              : []
            if (
              activityInputs.length !== input.promotedInputIds.length ||
              activityInputs.some((item, index) => item.input_id !== input.promotedInputIds[index])
            ) {
              return yield* new InputError({ reason: "order" })
            }
            const previouslySelected = input.promotedInputIds.length
              ? yield* tx
                  .select({ input_id: SessionContextSelectionInputTable.input_id })
                  .from(SessionContextSelectionInputTable)
                  .where(inArray(SessionContextSelectionInputTable.input_id, [...input.promotedInputIds]))
                  .get()
              : undefined
            if (previouslySelected) return yield* new InputError({ reason: "already_owned" })
            const latest = yield* tx
              .select({ revision: max(SessionContextSelectionTable.revision) })
              .from(SessionContextSelectionTable)
              .where(
                and(
                  eq(SessionContextSelectionTable.session_id, input.sessionId),
                  eq(SessionContextSelectionTable.activity_id, input.activityId),
                ),
              )
              .get()
            if (input.revision !== (latest?.revision ?? -1) + 1) return yield* new SelectionConflictError()
            const row = selectionRow(selectionId, input, artifactResult, now)
            const created = yield* tx
              .insert(SessionContextSelectionTable)
              .values(row)
              .onConflictDoNothing()
              .returning()
              .get()
            if (!created) {
              const raced = yield* tx
                .select()
                .from(SessionContextSelectionTable)
                .where(
                  and(
                    eq(SessionContextSelectionTable.session_id, input.sessionId),
                    eq(SessionContextSelectionTable.activity_id, input.activityId),
                    eq(SessionContextSelectionTable.revision, input.revision),
                  ),
                )
                .get()
              if (!raced) return yield* new SelectionConflictError()
              return raced
            }
            if (input.promotedInputIds.length > 0) {
              yield* tx
                .insert(SessionContextSelectionInputTable)
                .values(
                  input.promotedInputIds.map((inputId, ordinal) => ({
                    selection_id: created.selection_id,
                    input_id: inputId,
                    ordinal,
                  })),
                )
                .run()
            }
            return created
          }),
        )
        .pipe(preserveErrors)
      const decoded = yield* decodeSelection(db, inserted)
      if (!matchesSelection(decoded, input)) return yield* new SelectionConflictError()
      return decoded
    })

    const appendValidation = Effect.fn("SessionContext.appendValidation")(function* (input: ValidationInput) {
      const selection = yield* db
        .select()
        .from(SessionContextSelectionTable)
        .where(eq(SessionContextSelectionTable.selection_id, input.selectionId))
        .get()
        .pipe(Effect.orDie)
      if (!selection) return yield* new ValidationError()
      if (
        input.outcome === "valid" &&
        (input.validUntil <= input.validatedAt ||
          input.validUntil > selection.next_revalidation_at ||
          input.selectedSourceFingerprint !== selection.selected_source_fingerprint ||
          input.observedLocationMutationEpoch < selection.observed_location_mutation_epoch)
      ) {
        return yield* new ValidationError()
      }
      const id = opaque("validation")
      yield* db
        .insert(SessionContextValidationTable)
        .values({
          validation_id: id,
          selection_id: input.selectionId,
          provider_turn_seq: input.providerTurnSeq,
          authorization_epoch: input.authorizationEpoch,
          egress_epoch: input.egressEpoch,
          observed_location_mutation_epoch: input.observedLocationMutationEpoch,
          selected_source_fingerprint: input.selectedSourceFingerprint,
          validated_at: input.validatedAt,
          valid_until: input.validUntil,
          outcome: input.outcome,
          reason_code: input.reasonCode,
        })
        .run()
        .pipe(Effect.orDie)
      return id
    })

    const hasValidValidation = Effect.fn("SessionContext.hasValidValidation")(function* (input: {
      readonly selectionId: string
      readonly providerTurnSeq: number
      readonly authorizationEpoch: number
      readonly egressEpoch: number
      readonly observedLocationMutationEpoch: number
      readonly selectedSourceFingerprint: string
      readonly now?: number
    }) {
      const row = yield* db
        .select()
        .from(SessionContextValidationTable)
        .where(
          and(
            eq(SessionContextValidationTable.selection_id, input.selectionId),
            eq(SessionContextValidationTable.provider_turn_seq, input.providerTurnSeq),
          ),
        )
        .orderBy(desc(SessionContextValidationTable.validated_at))
        .get()
        .pipe(Effect.orDie)
      return Boolean(
        row &&
          row.outcome === "valid" &&
          row.authorization_epoch === input.authorizationEpoch &&
          row.egress_epoch === input.egressEpoch &&
          row.observed_location_mutation_epoch === input.observedLocationMutationEpoch &&
          row.selected_source_fingerprint === input.selectedSourceFingerprint &&
          row.valid_until > (input.now ?? Date.now()),
      )
    })

    return Service.of({
      openActivity,
      attachInputs,
      settleActivity,
      commitSelection,
      appendValidation,
      hasValidValidation,
      getSelection,
    })
  }),
)

function opaque(prefix: string) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`
}

function activity(row: typeof SessionActivityTable.$inferSelect): Activity {
  return {
    activityId: row.activity_id,
    sessionId: SessionSchema.ID.make(row.session_id),
    ordinal: row.ordinal,
    triggerInputId: row.trigger_input_id,
    delivery: row.delivery,
    state: row.state,
    createdAt: row.created_at,
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
  }
}

function nextInputOrdinal(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  activityId: string,
) {
  return tx
    .select({ ordinal: max(SessionActivityInputTable.ordinal) })
    .from(SessionActivityInputTable)
    .where(eq(SessionActivityInputTable.activity_id, activityId))
    .get()
    .pipe(Effect.map((row) => (row?.ordinal ?? -1) + 1))
}

function selectionRow(
  selectionId: string,
  input: CommitSelectionInput,
  artifactBinding: ArtifactBinding,
  now: number,
): typeof SessionContextSelectionTable.$inferInsert {
  return {
    selection_id: selectionId,
    session_id: input.sessionId,
    activity_id: input.activityId,
    revision: input.revision,
    trigger_input_id: input.triggerInputId,
    location_key: input.locationKey,
    security_namespace_id: input.securityNamespaceId,
    project_scope_key: input.projectScopeKey,
    query_fingerprint: input.queryFingerprint,
    authorization_fingerprint: input.authorizationFingerprint,
    authorization_epoch: input.authorizationEpoch,
    execution_fingerprint: input.executionFingerprint,
    selected_source_fingerprint: input.selectedSourceFingerprint,
    observed_location_mutation_epoch: input.observedLocationMutationEpoch,
    next_revalidation_at: input.nextRevalidationAt,
    released_knowledge_binding_state: input.releasedKnowledgeBinding.state,
    released_knowledge_snapshot_id:
      input.releasedKnowledgeBinding.state === "bound" ? input.releasedKnowledgeBinding.snapshotId : null,
    released_knowledge_generation:
      input.releasedKnowledgeBinding.state === "bound" ? input.releasedKnowledgeBinding.generation : null,
    released_knowledge_membership_hash:
      input.releasedKnowledgeBinding.state === "bound" ? input.releasedKnowledgeBinding.membershipHash : null,
    released_knowledge_manifest_hash:
      input.releasedKnowledgeBinding.state === "bound" ? input.releasedKnowledgeBinding.manifestHash : null,
    released_knowledge_exact_refs: [...input.releasedKnowledgeBinding.exactRefs],
    released_knowledge_exact_refs_fingerprint: input.releasedKnowledgeBinding.exactRefsFingerprint,
    graph_revisions: JSON.stringify(input.graphRevisions),
    graph_statuses: JSON.stringify(input.graphStatuses),
    selected_refs: JSON.stringify(input.selectedRefs),
    projection: input.rendered.projection,
    projection_hash: input.rendered.projectionHash,
    token_count: input.rendered.tokenCount,
    artifact_write_status: artifactBinding.status,
    artifact_ref: artifactBinding.status === "available" ? artifactBinding.ref : null,
    inline_audit:
      artifactBinding.status === "degraded_unavailable" ? JSON.stringify(artifactBinding.inlineAudit) : null,
    created_at: now,
  }
}

function matchesSelection(selection: Selection, input: CommitSelectionInput) {
  return (
    selection.sessionId === input.sessionId &&
    selection.activityId === input.activityId &&
    selection.revision === input.revision &&
    selection.triggerInputId === input.triggerInputId &&
    selection.locationKey === input.locationKey &&
    selection.securityNamespaceId === input.securityNamespaceId &&
    selection.projectScopeKey === input.projectScopeKey &&
    JSON.stringify(selection.promotedInputIds) === JSON.stringify(input.promotedInputIds) &&
    selection.queryFingerprint === input.queryFingerprint &&
    selection.authorizationFingerprint === input.authorizationFingerprint &&
    selection.authorizationEpoch === input.authorizationEpoch &&
    selection.executionFingerprint === input.executionFingerprint &&
    selection.selectedSourceFingerprint === input.selectedSourceFingerprint &&
    selection.observedLocationMutationEpoch === input.observedLocationMutationEpoch &&
    selection.nextRevalidationAt === input.nextRevalidationAt &&
    JSON.stringify(selection.releasedKnowledgeBinding) === JSON.stringify(input.releasedKnowledgeBinding) &&
    GraphKind.literals.every((graph) => selection.graphRevisions[graph] === input.graphRevisions[graph]) &&
    JSON.stringify(selection.graphStatuses) === JSON.stringify(input.graphStatuses) &&
    JSON.stringify(selection.selectedRefs) === JSON.stringify(input.selectedRefs) &&
    selection.projection === input.rendered.projection &&
    selection.projectionHash === input.rendered.projectionHash &&
    selection.tokenCount === input.rendered.tokenCount
  )
}

function minimalAudit(input: CommitSelectionInput, reasonCode: string): MinimalAudit {
  return {
    schemaVersion: "minimal-context-audit.v1",
    reasonCode,
    projectionHash: input.rendered.projectionHash,
    exposureHash: Hash.sha256(
      JSON.stringify({
        projectionHash: input.rendered.projectionHash,
        refs: input.selectedRefs.map((selected) => selected.token),
      }),
    ),
    refTokens: input.selectedRefs.map((selected) => selected.token),
    graphStatuses: input.graphStatuses,
    authorizationFingerprint: input.authorizationFingerprint,
    executionFingerprint: input.executionFingerprint,
  }
}

function decodeSelection(
  db: Database.Interface["db"],
  row: typeof SessionContextSelectionTable.$inferSelect,
): Effect.Effect<Selection, StoredDataError> {
  return Effect.gen(function* () {
    if (!row.security_namespace_id) return yield* new StoredDataError({ field: "security_namespace_id" })
    if (!row.project_scope_key) return yield* new StoredDataError({ field: "project_scope_key" })
    const inputs = yield* db
      .select({ input_id: SessionContextSelectionInputTable.input_id })
      .from(SessionContextSelectionInputTable)
      .where(eq(SessionContextSelectionInputTable.selection_id, row.selection_id))
      .orderBy(asc(SessionContextSelectionInputTable.ordinal))
      .all()
      .pipe(Effect.orDie)
    return {
      selectionId: row.selection_id,
      sessionId: SessionSchema.ID.make(row.session_id),
      activityId: row.activity_id,
      revision: row.revision,
      triggerInputId: row.trigger_input_id,
      locationKey: LocationKey.make(row.location_key),
      securityNamespaceId: SecurityNamespaceID.make(row.security_namespace_id),
      projectScopeKey: ProjectScopeKey.make(row.project_scope_key),
      promotedInputIds: inputs.map((input) => input.input_id),
      queryFingerprint: row.query_fingerprint,
      authorizationFingerprint: row.authorization_fingerprint,
      authorizationEpoch: row.authorization_epoch,
      executionFingerprint: row.execution_fingerprint,
      selectedSourceFingerprint: row.selected_source_fingerprint,
      observedLocationMutationEpoch: row.observed_location_mutation_epoch,
      nextRevalidationAt: row.next_revalidation_at,
      releasedKnowledgeBinding: yield* decodeReleasedKnowledgeBinding(row),
      graphRevisions: yield* parseStored("graph_revisions", GraphRevisions, row.graph_revisions),
      graphStatuses: yield* parseStored("graph_statuses", Schema.Array(GraphQueryStatus), row.graph_statuses),
      selectedRefs: yield* parseStored("selected_refs", Schema.Array(SelectedRef), row.selected_refs),
      projection: row.projection,
      projectionHash: row.projection_hash,
      tokenCount: row.token_count,
      artifactBinding:
        row.artifact_write_status === "available"
          ? { status: "available", ref: row.artifact_ref! }
          : {
              status: "degraded_unavailable",
              inlineAudit: yield* parseStored("inline_audit", MinimalAudit, row.inline_audit ?? ""),
            },
      createdAt: row.created_at,
      legacyIncomplete: isLegacyIncompleteRow(row),
    }
  })
}

function decodeReleasedKnowledgeBinding(row: typeof SessionContextSelectionTable.$inferSelect) {
  return Effect.try({
    try: (): Binding => {
      if (
        row.released_knowledge_binding_state === "unavailable" &&
        row.released_knowledge_snapshot_id === null &&
        row.released_knowledge_generation === null &&
        row.released_knowledge_membership_hash === null &&
        row.released_knowledge_manifest_hash === null &&
        Array.isArray(row.released_knowledge_exact_refs) &&
        row.released_knowledge_exact_refs.length === 0 &&
        row.released_knowledge_exact_refs_fingerprint ===
          DeepAgentReleasedSnapshot.exactRefsFingerprint(row.released_knowledge_exact_refs)
      ) {
        return DeepAgentReleasedSnapshot.binding(undefined)
      }
      if (
        row.released_knowledge_binding_state !== "bound" ||
        !row.released_knowledge_snapshot_id ||
        !row.released_knowledge_generation ||
        !row.released_knowledge_membership_hash ||
        !row.released_knowledge_manifest_hash ||
        !Array.isArray(row.released_knowledge_exact_refs) ||
        row.released_knowledge_exact_refs_fingerprint !==
          DeepAgentReleasedSnapshot.exactRefsFingerprint(row.released_knowledge_exact_refs)
      ) {
        throw new Error("invalid released knowledge binding")
      }
      return {
        state: "bound",
        snapshotId: row.released_knowledge_snapshot_id,
        generation: row.released_knowledge_generation,
        membershipHash: row.released_knowledge_membership_hash,
        manifestHash: row.released_knowledge_manifest_hash,
        exactRefs: row.released_knowledge_exact_refs,
        exactRefsFingerprint: row.released_knowledge_exact_refs_fingerprint,
      }
    },
    catch: () => new StoredDataError({ field: "released_knowledge_binding" }),
  })
}

function parseStored<A>(field: string, schema: Schema.Decoder<A>, value: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(JSON.parse(value)),
    catch: () => new StoredDataError({ field }),
  })
}

function preserveErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Error, R> {
  return effect.pipe(Effect.catch((error) => (isError(error) ? Effect.fail(error) : Effect.die(error))))
}

function isError(value: unknown): value is Error {
  if (!value || typeof value !== "object" || !("_tag" in value)) return false
  return [
    "SessionContext.InputError",
    "SessionContext.ActivityBlockedError",
    "SessionContext.ActivityStateError",
    "SessionContext.SelectionConflictError",
    "SessionContext.ValidationError",
    "SessionContext.AuditStorageUnavailableError",
    "SessionContext.StoredDataError",
  ].includes(String(value._tag))
}
