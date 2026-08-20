export * as DeepAgentActivityAuthority from "./activity-authority"

import { and, asc, desc, eq, gt, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { PermissionSaved } from "../permission/saved"
import { PermissionSavedEpochTable, PermissionTable } from "../permission/sql"
import { SessionActivityTable } from "../context-federation/session-sql"
import { SessionTable } from "../session/sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { Wildcard } from "../util/wildcard"
import type { CompletionCriterion } from "./goal-loop"
import {
  type ActivityKind,
  type ActivityObjectiveState,
  SessionActivityEffectReceiptTable,
  SessionActivityEvidenceTable,
  SessionActivityObjectiveTable,
  SessionActivityPermissionDecisionTable,
  SessionActivityPermissionEffectDispatchTable,
  SessionActivityPermissionOwnerLeaseTable,
  SessionActivityPermissionOnceConsumptionTable,
  SessionActivityPermissionRequestTable,
  SessionActivityProgressObservationTable,
  SessionFacadeActivityTable,
} from "./activity-authority.sql"

type DatabaseClient = Database.Interface["db"]
type Transaction = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer T) => unknown ? T : never

export type ActivityRef = {
  readonly activityKind: ActivityKind
  readonly activityID: string
}

export type Evidence = {
  readonly fingerprint: string
  readonly kind: string
  readonly sourceReceiptID?: string
}

export type EffectReceipt = {
  readonly receiptID: string
  readonly fingerprint: string
}

export type PermissionEffectDispatch = {
  readonly receiptID: string
  readonly requestID: string
  readonly activityKind: ActivityKind
  readonly activityID: string
  readonly sessionID: string
  readonly projectID: string
  readonly workspaceID?: string
  readonly toolMessageID: string
  readonly toolCallID: string
  readonly toolName: string
  readonly consumerID: string
  readonly ownerID: string
  readonly state: "started" | "settled" | "unknown"
  readonly version: number
  readonly outcome?: "success" | "failure"
  readonly result?: unknown
  readonly resultHash?: string
  readonly startedAt: number
  readonly settledAt?: number
}

export type PermissionOwnerRotation = {
  readonly previousOwnerID: string
  readonly ownerID: string
  readonly quarantinedEffectCount: number
  readonly recoveredPendingCount: number
}

export type Objective = ActivityRef & {
  readonly sessionID: string
  readonly version: number
  readonly admissionFingerprint: string
  readonly objectiveFingerprint?: string
  readonly objectiveText?: string
  readonly completionCriteria: readonly CompletionCriterion[]
  readonly enforcementState: "disabled" | "monitoring"
  readonly stallThreshold?: number
  readonly state: ActivityObjectiveState
  readonly noProgressCount: number
  readonly latestObservationRevision: number
  readonly latestVectorHash?: string
  readonly nextAction?: string
  readonly terminalReason?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly settledAt?: number
}

export type Observation = ActivityRef & {
  readonly revision: number
  readonly idempotencyKey: string
  readonly observationFingerprint: string
  readonly expectedObjectiveVersion: number
  readonly workspaceRevision?: string
  readonly planVersion?: number
  readonly validationFingerprint?: string
  readonly evidenceSetHash: string
  readonly effectReceiptSetHash: string
  readonly vectorHash: string
  readonly nextAction?: string
  readonly changed: boolean
  readonly noProgressCount: number
  readonly observedAt: number
}

export type Reconstructed = {
  readonly objective: Objective
  readonly latestObservation?: Observation
  readonly evidence: readonly Evidence[]
  readonly effectReceipts: readonly EffectReceipt[]
  readonly pendingPermissionRequestIDs: readonly string[]
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ActivityAuthority.NotFoundError", {
  activityKind: Schema.Literals(["legacy", "v2", "facade"]),
  activityID: Schema.String,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("ActivityAuthority.ConflictError", {
  entity: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()(
  "ActivityAuthority.InvalidInputError",
  {
    reason: Schema.String,
  },
) {}

export const configure = Effect.fn("DeepAgentActivityAuthority.configure")(function* (
  input: ActivityRef & {
    readonly expectedVersion: number
    readonly objectiveText: string
    readonly completionCriteria: readonly CompletionCriterion[]
    readonly enforcementState: "disabled" | "monitoring"
    readonly stallThreshold?: number
  },
) {
  const objectiveText = input.objectiveText.trim()
  if (!objectiveText) return yield* new InvalidInputError({ reason: "objective text is required" })
  if (!input.completionCriteria.length)
    return yield* new InvalidInputError({ reason: "at least one completion criterion is required" })
  if (input.enforcementState === "monitoring" && (!input.stallThreshold || input.stallThreshold < 1))
    return yield* new InvalidInputError({ reason: "monitoring requires a positive stall threshold" })
  if (input.enforcementState === "disabled" && input.stallThreshold !== undefined)
    return yield* new InvalidInputError({ reason: "disabled enforcement cannot carry a stall threshold" })

  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx.select().from(SessionActivityObjectiveTable).where(activityWhere(input)).get()
          if (!current) return yield* notFound(input)
          if (current.state !== "active")
            return yield* new ConflictError({ entity: input.activityID, expected: "active", actual: current.state })
          const objectiveFingerprint = fingerprint({
            admissionFingerprint: current.admission_fingerprint,
            objectiveText,
            completionCriteria: input.completionCriteria,
          })
          const exact =
            current.objective_fingerprint === objectiveFingerprint &&
            current.objective_text === objectiveText &&
            fingerprint(current.completion_criteria) === fingerprint(input.completionCriteria) &&
            current.enforcement_state === input.enforcementState &&
            current.stall_threshold === (input.stallThreshold ?? null)
          if (exact) return objective(current)
          if (current.objective_fingerprint)
            return yield* new ConflictError({
              entity: input.activityID,
              expected: current.objective_fingerprint,
              actual: objectiveFingerprint,
            })
          if (current.version !== input.expectedVersion)
            return yield* versionConflict(input.activityID, input.expectedVersion, current.version)
          const now = yield* observedAtInTransaction(tx)
          const updated = yield* tx
            .update(SessionActivityObjectiveTable)
            .set({
              version: current.version + 1,
              objective_fingerprint: objectiveFingerprint,
              objective_text: objectiveText,
              completion_criteria: input.completionCriteria,
              enforcement_state: input.enforcementState,
              stall_threshold: input.stallThreshold ?? null,
              no_progress_count: 0,
              updated_at: now,
            })
            .where(and(activityWhere(input), eq(SessionActivityObjectiveTable.version, input.expectedVersion)))
            .returning()
            .get()
          if (!updated) return yield* versionConflict(input.activityID, input.expectedVersion, current.version)
          return objective(updated)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

export const observe = Effect.fn("DeepAgentActivityAuthority.observe")(function* (
  input: ActivityRef & {
    readonly idempotencyKey: string
    readonly expectedVersion: number
    readonly workspaceRevision?: string
    readonly planVersion?: number
    readonly validationFingerprint?: string
    readonly evidence: readonly Evidence[]
    readonly effectReceipts: readonly EffectReceipt[]
    readonly nextAction?: string
  },
) {
  if (!input.idempotencyKey) return yield* new InvalidInputError({ reason: "observation idempotency key is required" })
  if (input.evidence.some((item) => !item.fingerprint || !item.kind))
    return yield* new InvalidInputError({ reason: "evidence fingerprint and kind are required" })
  if (input.effectReceipts.some((item) => !item.receiptID || !item.fingerprint))
    return yield* new InvalidInputError({ reason: "effect receipt identity and fingerprint are required" })
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const observationFingerprint = fingerprint({
            activityKind: input.activityKind,
            activityID: input.activityID,
            expectedVersion: input.expectedVersion,
            workspaceRevision: input.workspaceRevision ?? null,
            planVersion: input.planVersion ?? null,
            validationFingerprint: input.validationFingerprint ?? null,
            evidence: [...input.evidence].toSorted((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
            effectReceipts: [...input.effectReceipts].toSorted((left, right) =>
              left.receiptID.localeCompare(right.receiptID),
            ),
            nextAction: input.nextAction ?? null,
          })
          const existing = yield* tx
            .select()
            .from(SessionActivityProgressObservationTable)
            .where(eq(SessionActivityProgressObservationTable.idempotency_key, input.idempotencyKey))
            .get()
          const current = yield* tx.select().from(SessionActivityObjectiveTable).where(activityWhere(input)).get()
          if (!current) return yield* notFound(input)
          if (existing) {
            if (
              existing.activity_kind !== input.activityKind ||
              existing.activity_id !== input.activityID ||
              existing.observation_fingerprint !== observationFingerprint
            )
              return yield* new ConflictError({
                entity: input.idempotencyKey,
                expected: observationFingerprint,
                actual: existing.observation_fingerprint,
              })
            return { objective: objective(current), observation: observation(existing) }
          }
          if (current.state !== "active")
            return yield* new ConflictError({ entity: input.activityID, expected: "active", actual: current.state })
          if (!current.objective_fingerprint)
            return yield* new InvalidInputError({ reason: "activity objective must be configured before observation" })
          if (current.version !== input.expectedVersion)
            return yield* versionConflict(input.activityID, input.expectedVersion, current.version)

          const revision = current.latest_observation_revision + 1
          const now = yield* observedAtInTransaction(tx)
          yield* Effect.forEach(
            input.evidence,
            (item) =>
              tx
                .insert(SessionActivityEvidenceTable)
                .values({
                  activity_kind: input.activityKind,
                  activity_id: input.activityID,
                  evidence_fingerprint: item.fingerprint,
                  evidence_kind: item.kind,
                  source_receipt_id: item.sourceReceiptID ?? null,
                  first_observation_revision: revision,
                  created_at: now,
                })
                .onConflictDoNothing()
                .run(),
            { discard: true },
          )
          yield* Effect.forEach(
            input.effectReceipts,
            (item) =>
              tx
                .insert(SessionActivityEffectReceiptTable)
                .values({
                  activity_kind: input.activityKind,
                  activity_id: input.activityID,
                  receipt_id: item.receiptID,
                  effect_fingerprint: item.fingerprint,
                  first_observation_revision: revision,
                  created_at: now,
                })
                .onConflictDoNothing()
                .run(),
            { discard: true },
          )
          yield* Effect.forEach(
            input.evidence,
            (item) =>
              Effect.gen(function* () {
                const stored = yield* tx
                  .select()
                  .from(SessionActivityEvidenceTable)
                  .where(
                    and(
                      activityEvidenceWhere(input),
                      eq(SessionActivityEvidenceTable.evidence_fingerprint, item.fingerprint),
                    ),
                  )
                  .get()
                if (
                  !stored ||
                  stored.evidence_kind !== item.kind ||
                  stored.source_receipt_id !== (item.sourceReceiptID ?? null)
                )
                  return yield* new ConflictError({
                    entity: item.fingerprint,
                    expected: fingerprint(item),
                    actual: stored ? fingerprint(stored) : "missing",
                  })
              }),
            { discard: true },
          )
          yield* Effect.forEach(
            input.effectReceipts,
            (item) =>
              Effect.gen(function* () {
                const stored = yield* tx
                  .select()
                  .from(SessionActivityEffectReceiptTable)
                  .where(
                    and(activityEffectWhere(input), eq(SessionActivityEffectReceiptTable.receipt_id, item.receiptID)),
                  )
                  .get()
                if (!stored || stored.effect_fingerprint !== item.fingerprint)
                  return yield* new ConflictError({
                    entity: item.receiptID,
                    expected: item.fingerprint,
                    actual: stored?.effect_fingerprint ?? "missing",
                  })
              }),
            { discard: true },
          )

          const evidence = yield* tx
            .select()
            .from(SessionActivityEvidenceTable)
            .where(activityEvidenceWhere(input))
            .orderBy(asc(SessionActivityEvidenceTable.evidence_fingerprint))
            .all()
          const effects = yield* tx
            .select()
            .from(SessionActivityEffectReceiptTable)
            .where(activityEffectWhere(input))
            .orderBy(asc(SessionActivityEffectReceiptTable.receipt_id))
            .all()
          const evidenceSetHash = fingerprint(
            evidence.map((item) => ({
              fingerprint: item.evidence_fingerprint,
              kind: item.evidence_kind,
              sourceReceiptID: item.source_receipt_id,
            })),
          )
          const effectReceiptSetHash = fingerprint(
            effects.map((item) => ({ receiptID: item.receipt_id, fingerprint: item.effect_fingerprint })),
          )
          const vectorHash = fingerprint({
            objectiveFingerprint: current.objective_fingerprint,
            workspaceRevision: input.workspaceRevision ?? null,
            planVersion: input.planVersion ?? null,
            validationFingerprint: input.validationFingerprint ?? null,
            evidenceSetHash,
            effectReceiptSetHash,
          })
          const changed = current.latest_vector_hash !== vectorHash
          const noProgressCount = changed ? 0 : current.no_progress_count + 1
          const observationRow = {
            activity_kind: input.activityKind,
            activity_id: input.activityID,
            revision,
            idempotency_key: input.idempotencyKey,
            observation_fingerprint: observationFingerprint,
            expected_objective_version: input.expectedVersion,
            workspace_revision: input.workspaceRevision ?? null,
            plan_version: input.planVersion ?? null,
            validation_fingerprint: input.validationFingerprint ?? null,
            evidence_set_hash: evidenceSetHash,
            effect_receipt_set_hash: effectReceiptSetHash,
            vector_hash: vectorHash,
            next_action: input.nextAction ?? null,
            changed,
            no_progress_count: noProgressCount,
            observed_at: now,
          }
          yield* tx.insert(SessionActivityProgressObservationTable).values(observationRow).run()
          const stalled =
            current.enforcement_state === "monitoring" &&
            current.stall_threshold !== null &&
            noProgressCount >= current.stall_threshold
          const updated = yield* tx
            .update(SessionActivityObjectiveTable)
            .set({
              version: current.version + 1,
              state: stalled ? "needs_human" : "active",
              no_progress_count: noProgressCount,
              latest_observation_revision: revision,
              latest_vector_hash: vectorHash,
              next_action: input.nextAction ?? null,
              terminal_reason: stalled ? "no_progress" : null,
              updated_at: now,
              settled_at: stalled ? now : null,
            })
            .where(and(activityWhere(input), eq(SessionActivityObjectiveTable.version, input.expectedVersion)))
            .returning()
            .get()
          if (!updated) return yield* versionConflict(input.activityID, input.expectedVersion, current.version)
          return { objective: objective(updated), observation: observation(observationRow) }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

export const settle = Effect.fn("DeepAgentActivityAuthority.settle")(function* (
  input: ActivityRef & {
    readonly expectedVersion: number
    readonly state: "completed" | "interrupted" | "recovery_required"
    readonly terminalReason: string
  },
) {
  if (!input.terminalReason.trim()) return yield* new InvalidInputError({ reason: "terminal reason is required" })
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          // FEAT-011 T2 — facade activities are fully isolated from the federation objective
          // machinery (the objective/permission child tables keep ('legacy','v2') CHECKs), so
          // settlement is raw CAS on the facade base table keyed by activity_id, mirroring the
          // legacy branch shape. expectedVersion is the mutation_epoch CAS token.
          if (input.activityKind === "facade") return yield* settleFacade(tx, input)
          const current = yield* tx.select().from(SessionActivityObjectiveTable).where(activityWhere(input)).get()
          if (!current) return yield* notFound(input)
          if (
            current.state === input.state &&
            current.terminal_reason === input.terminalReason &&
            current.settled_at !== null
          )
            return objective(current)
          if (current.version !== input.expectedVersion)
            return yield* versionConflict(input.activityID, input.expectedVersion, current.version)
          if (!["active", "needs_human"].includes(current.state))
            return yield* new ConflictError({ entity: input.activityID, expected: "active", actual: current.state })
          const outstanding = yield* tx
            .select()
            .from(SessionActivityPermissionEffectDispatchTable)
            .where(
              and(
                effectDispatchActivityWhere(input),
                inArray(SessionActivityPermissionEffectDispatchTable.state, ["started", "unknown"]),
              ),
            )
            .all()
          if (outstanding.length && input.state !== "recovery_required")
            return yield* new ConflictError({
              entity: input.activityID,
              expected: "settled permission effects",
              actual: outstanding[0]!.state,
            })
          const now = yield* observedAtInTransaction(tx)
          if (outstanding.length)
            yield* tx
              .update(SessionActivityPermissionEffectDispatchTable)
              .set({
                state: "unknown",
                version: sql`${SessionActivityPermissionEffectDispatchTable.version} + 1`,
                settled_at: now,
              })
              .where(
                and(
                  effectDispatchActivityWhere(input),
                  eq(SessionActivityPermissionEffectDispatchTable.state, "started"),
                ),
              )
              .run()
          const baseState = input.state === "completed" ? "settled" : input.state
          const updated = yield* tx
            .update(SessionActivityObjectiveTable)
            .set({
              version: current.version + 1,
              state: input.state,
              terminal_reason: input.terminalReason,
              updated_at: now,
              settled_at: now,
            })
            .where(and(activityWhere(input), eq(SessionActivityObjectiveTable.version, input.expectedVersion)))
            .returning()
            .get()
          if (!updated) return yield* versionConflict(input.activityID, input.expectedVersion, current.version)
          const base =
            input.activityKind === "legacy"
              ? yield* tx.get<{ activity_id: string }>(sql`
                  UPDATE session_legacy_activity
                  SET state = ${baseState}, terminal_reason = ${input.terminalReason}, settled_at = ${now}
                  WHERE activity_id = ${input.activityID} AND state = 'active'
                  RETURNING activity_id
                `)
              : yield* tx
                  .update(SessionActivityTable)
                  .set({
                    state: baseState === "recovery_required" ? "failed" : baseState,
                    settled_at: now,
                  })
                  .where(
                    and(
                      eq(SessionActivityTable.activity_id, input.activityID),
                      eq(SessionActivityTable.state, "active"),
                    ),
                  )
                  .returning({ activityID: SessionActivityTable.activity_id })
                  .get()
          if (!base)
            return yield* new ConflictError({
              entity: input.activityID,
              expected: "active base activity",
              actual: "changed",
            })
          return objective(updated)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

// FEAT-011 T2 — facade settlement path. Facade activities never own a federation objective
// row (the objective/permission child tables keep ('legacy','v2') CHECKs by design), so this
// settles the facade base table directly with a CAS keyed by activity_id. Three-state mapping
// mirrors the v2 branch: completed→'settled', interrupted→'interrupted', and
// recovery_required→'failed' — the facade base has no recovery_required shape of its own, so a
// recovery-required settlement is persisted as base state 'failed' (same modeling as the v2
// federation base, where 'failed' means recovery is required). expectedVersion is the
// mutation_epoch CAS token; the base legal-update trigger additionally enforces the one-shot
// active→terminal transition with reason_code + settled_at.
function settleFacade(
  tx: Transaction,
  input: ActivityRef & {
    readonly expectedVersion: number
    readonly state: "completed" | "interrupted" | "recovery_required"
    readonly terminalReason: string
  },
) {
  return Effect.gen(function* () {
    const current = yield* tx
      .select()
      .from(SessionFacadeActivityTable)
      .where(eq(SessionFacadeActivityTable.activity_id, input.activityID))
      .get()
    if (!current) return yield* notFound(input)
    const baseState = input.state === "completed" ? "settled" : input.state === "recovery_required" ? "failed" : "interrupted"
    const mapped = facadeObjective(current, input.state)
    if (current.state === baseState && current.reason_code === input.terminalReason && current.settled_at !== null)
      return mapped
    if (current.mutation_epoch !== input.expectedVersion)
      return yield* versionConflict(input.activityID, input.expectedVersion, current.mutation_epoch)
    if (current.state !== "active")
      return yield* new ConflictError({ entity: input.activityID, expected: "active", actual: current.state })
    const now = yield* observedAtInTransaction(tx)
    const updated = yield* tx
      .update(SessionFacadeActivityTable)
      .set({
        state: baseState,
        reason_code: input.terminalReason,
        settled_at: now,
        mutation_epoch: sql`${SessionFacadeActivityTable.mutation_epoch} + 1`,
      })
      .where(
        and(
          eq(SessionFacadeActivityTable.activity_id, input.activityID),
          eq(SessionFacadeActivityTable.state, "active"),
          eq(SessionFacadeActivityTable.mutation_epoch, input.expectedVersion),
        ),
      )
      .returning()
      .get()
    if (!updated) return yield* versionConflict(input.activityID, input.expectedVersion, current.mutation_epoch)
    return facadeObjective(updated, input.state)
  })
}

// Projects a facade base row as the Objective shape settle callers expect (facade activities
// carry no objective row). version maps mutation_epoch; settlement state maps back from the
// base shape ('settled'→completed, 'failed'→recovery_required, otherwise as-is).
function facadeObjective(
  row: typeof SessionFacadeActivityTable.$inferSelect,
  state: ActivityObjectiveState,
): Objective {
  return {
    activityKind: "facade",
    activityID: row.activity_id,
    sessionID: row.parent_session_id,
    version: row.mutation_epoch,
    admissionFingerprint: "facade-spawn:" + (row.spawn_tool_call_id ?? row.activity_id),
    ...(row.objective_text ? { objectiveText: row.objective_text } : {}),
    completionCriteria: [],
    enforcementState: "disabled",
    state,
    noProgressCount: 0,
    latestObservationRevision: -1,
    ...(row.reason_code ? { terminalReason: row.reason_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.settled_at ?? row.created_at,
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
  }
}

export const reconstruct = Effect.fn("DeepAgentActivityAuthority.reconstruct")(function* (input: ActivityRef) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(SessionActivityObjectiveTable)
    .where(activityWhere(input))
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* notFound(input)
  const [latest, evidence, effects, pending] = yield* Effect.all([
    db
      .select()
      .from(SessionActivityProgressObservationTable)
      .where(activityObservationWhere(input))
      .orderBy(desc(SessionActivityProgressObservationTable.revision))
      .get(),
    db
      .select()
      .from(SessionActivityEvidenceTable)
      .where(activityEvidenceWhere(input))
      .orderBy(asc(SessionActivityEvidenceTable.evidence_fingerprint))
      .all(),
    db
      .select()
      .from(SessionActivityEffectReceiptTable)
      .where(activityEffectWhere(input))
      .orderBy(asc(SessionActivityEffectReceiptTable.receipt_id))
      .all(),
    db
      .select({ requestID: SessionActivityPermissionRequestTable.request_id })
      .from(SessionActivityPermissionRequestTable)
      .where(and(permissionActivityWhere(input), eq(SessionActivityPermissionRequestTable.state, "pending")))
      .orderBy(asc(SessionActivityPermissionRequestTable.created_at))
      .all(),
  ]).pipe(Effect.orDie)
  return {
    objective: objective(row),
    ...(latest ? { latestObservation: observation(latest) } : {}),
    evidence: evidence.map((item) => ({
      fingerprint: item.evidence_fingerprint,
      kind: item.evidence_kind,
      ...(item.source_receipt_id ? { sourceReceiptID: item.source_receipt_id } : {}),
    })),
    effectReceipts: effects.map((item) => ({ receiptID: item.receipt_id, fingerprint: item.effect_fingerprint })),
    pendingPermissionRequestIDs: pending.map((item) => item.requestID),
  } satisfies Reconstructed
})

export const requestPermission = Effect.fn("DeepAgentActivityAuthority.requestPermission")(function* (
  input: ActivityRef & {
    readonly requestID: string
    readonly requestKind: "tool" | "no_progress"
    readonly idempotencyKey: string
    readonly permission: string
    readonly patterns: readonly string[]
    readonly alwaysPatterns: readonly string[]
    readonly metadata: Readonly<Record<string, unknown>>
    readonly tool?: { readonly messageID: string; readonly callID: string }
    readonly ownerID: string
    readonly workspaceID?: string
    readonly expiresAt?: number
  },
) {
  if (!input.requestID || !input.idempotencyKey || !input.permission || !input.patterns.length)
    return yield* new InvalidInputError({
      reason: "permission request identity, permission, and patterns are required",
    })
  if (input.requestKind === "tool" && (!input.tool?.messageID || !input.tool.callID))
    return yield* new InvalidInputError({ reason: "tool permission requests require message and call identity" })
  if (input.requestKind === "no_progress" && input.tool)
    return yield* new InvalidInputError({ reason: "no-progress permission requests cannot bind a tool call" })
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(SessionActivityPermissionRequestTable)
            .where(
              or(
                eq(SessionActivityPermissionRequestTable.request_id, input.requestID),
                eq(SessionActivityPermissionRequestTable.idempotency_key, input.idempotencyKey),
              ),
            )
            .get()
          const metadataHash = fingerprint(input.metadata)
          if (existing) {
            const exact =
              existing.request_id === input.requestID &&
              existing.activity_kind === input.activityKind &&
              existing.activity_id === input.activityID &&
              existing.request_kind === input.requestKind &&
              existing.idempotency_key === input.idempotencyKey &&
              existing.permission === input.permission &&
              fingerprint(existing.patterns) === fingerprint(input.patterns) &&
              fingerprint(existing.always_patterns) === fingerprint(input.alwaysPatterns) &&
              existing.metadata_hash === metadataHash &&
              existing.tool_message_id === (input.tool?.messageID ?? null) &&
              existing.tool_call_id === (input.tool?.callID ?? null) &&
              (existing.state !== "pending" || existing.owner_id === input.ownerID) &&
              existing.workspace_id === (input.workspaceID ?? null) &&
              existing.expires_at === (input.expiresAt ?? null)
            if (!exact)
              return yield* new ConflictError({
                entity: input.requestID,
                expected: input.idempotencyKey,
                actual: existing.idempotency_key,
              })
            return permissionRequest(existing)
          }
          const now = yield* observedAtInTransaction(tx)
          if (input.expiresAt !== undefined && input.expiresAt <= now)
            return yield* new InvalidInputError({ reason: "permission request expiry must be in the future" })
          const activity = yield* tx.select().from(SessionActivityObjectiveTable).where(activityWhere(input)).get()
          if (!activity) return yield* notFound(input)
          if (input.requestKind === "no_progress" && activity.state !== "needs_human")
            return yield* new ConflictError({
              entity: input.activityID,
              expected: "needs_human",
              actual: activity.state,
            })
          if (input.requestKind === "tool" && activity.state !== "active")
            return yield* new ConflictError({ entity: input.activityID, expected: "active", actual: activity.state })
          if (input.requestKind === "no_progress") {
            const pending = yield* tx
              .select({ requestID: SessionActivityPermissionRequestTable.request_id })
              .from(SessionActivityPermissionRequestTable)
              .where(
                and(
                  permissionActivityWhere(input),
                  eq(SessionActivityPermissionRequestTable.request_kind, "no_progress"),
                  eq(SessionActivityPermissionRequestTable.state, "pending"),
                ),
              )
              .get()
            if (pending)
              return yield* new ConflictError({
                entity: input.activityID,
                expected: "one pending no-progress challenge",
                actual: pending.requestID,
              })
          }
          const session = yield* tx
            .select({ projectID: SessionTable.project_id, workspaceID: SessionTable.workspace_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, activity.session_id))
            .get()
          if (!session) return yield* Effect.die(new Error("activity session is missing: " + activity.session_id))
          if (session.workspaceID !== (input.workspaceID ?? null))
            return yield* new ConflictError({
              entity: input.requestID,
              expected: session.workspaceID ?? "implicit-local",
              actual: input.workspaceID ?? "implicit-local",
            })
          yield* tx
            .insert(PermissionSavedEpochTable)
            .values({ project_id: session.projectID, epoch: 0, updated_at: now })
            .onConflictDoNothing()
            .run()
          const epoch = yield* tx
            .select()
            .from(PermissionSavedEpochTable)
            .where(eq(PermissionSavedEpochTable.project_id, session.projectID))
            .get()
          if (!epoch) return yield* Effect.die(new Error("permission authority is missing: " + session.projectID))
          const row = {
            request_id: input.requestID,
            activity_kind: input.activityKind,
            activity_id: input.activityID,
            session_id: activity.session_id,
            project_id: session.projectID,
            workspace_id: input.workspaceID,
            request_kind: input.requestKind,
            idempotency_key: input.idempotencyKey,
            permission: input.permission,
            patterns: input.patterns,
            always_patterns: input.alwaysPatterns,
            metadata_hash: metadataHash,
            tool_message_id: input.tool?.messageID ?? null,
            tool_call_id: input.tool?.callID ?? null,
            state: "pending" as const,
            authority_epoch: epoch.epoch,
            requested_scope: input.alwaysPatterns.length ? ("project" as const) : ("once" as const),
            owner_type: "runtime" as const,
            owner_id: input.ownerID,
            created_at: now,
            expires_at: input.expiresAt ?? null,
            decided_at: null,
          }
          yield* tx.insert(SessionActivityPermissionRequestTable).values(row).run()
          return permissionRequest({ ...row, workspace_id: input.workspaceID ?? null })
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

type DecidePermissionInput = {
  readonly requestID: string
  readonly idempotencyKey: string
  readonly decision: "approved_once" | "approved_always" | "denied" | "expired" | "interrupted"
  readonly actorType: "user" | "administrator" | "system"
  readonly actorID: string
  readonly feedback?: string
  readonly expiresAt?: number
}

const decidePermissionInternal = Effect.fn("DeepAgentActivityAuthority.decidePermissionInternal")(function* (
  input: DecidePermissionInput & { readonly sessionFanout?: "reject" | "always" },
) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const prior = yield* tx
            .select()
            .from(SessionActivityPermissionDecisionTable)
            .where(
              or(
                eq(SessionActivityPermissionDecisionTable.request_id, input.requestID),
                eq(SessionActivityPermissionDecisionTable.idempotency_key, input.idempotencyKey),
              ),
            )
            .get()
          if (prior) {
            if (
              prior.request_id !== input.requestID ||
              prior.idempotency_key !== input.idempotencyKey ||
              prior.decision !== input.decision ||
              prior.actor_type !== input.actorType ||
              prior.actor_id !== input.actorID ||
              prior.feedback !== (input.feedback ?? null) ||
              prior.expires_at !== (input.expiresAt ?? null)
            )
              return yield* new ConflictError({
                entity: input.requestID,
                expected: input.decision,
                actual: prior.decision,
              })
            return permissionDecision(prior)
          }
          if (input.decision !== "approved_once" && input.expiresAt !== undefined)
            return yield* new InvalidInputError({ reason: "only approve-once decisions support expiry" })
          const now = yield* observedAtInTransaction(tx)
          if (input.expiresAt !== undefined && input.expiresAt <= now)
            return yield* new InvalidInputError({ reason: "permission decision expiry must be in the future" })
          const request = yield* tx
            .select()
            .from(SessionActivityPermissionRequestTable)
            .where(eq(SessionActivityPermissionRequestTable.request_id, input.requestID))
            .get()
          if (!request)
            return yield* new ConflictError({ entity: input.requestID, expected: "pending", actual: "missing" })
          if (request.state !== "pending")
            return yield* new ConflictError({ entity: input.requestID, expected: "pending", actual: request.state })
          if (request.request_kind === "tool") {
            const objective = yield* tx
              .select({ state: SessionActivityObjectiveTable.state })
              .from(SessionActivityObjectiveTable)
              .where(
                and(
                  eq(SessionActivityObjectiveTable.activity_kind, request.activity_kind),
                  eq(SessionActivityObjectiveTable.activity_id, request.activity_id),
                ),
              )
              .get()
            const base =
              request.activity_kind === "legacy"
                ? yield* tx.get<{ state: string }>(sql`
                    SELECT state FROM session_legacy_activity WHERE activity_id = ${request.activity_id}
                  `)
                : request.activity_kind === "facade"
                  ? yield* tx
                      .select({ state: SessionFacadeActivityTable.state })
                      .from(SessionFacadeActivityTable)
                      .where(eq(SessionFacadeActivityTable.activity_id, request.activity_id))
                      .get()
                  : yield* tx
                      .select({ state: SessionActivityTable.state })
                      .from(SessionActivityTable)
                      .where(eq(SessionActivityTable.activity_id, request.activity_id))
                      .get()
            if (objective?.state !== "active" || base?.state !== "active")
              return yield* new ConflictError({
                entity: request.activity_id,
                expected: "active activity",
                actual: objective?.state ?? base?.state ?? "missing",
              })
          }
          const requestExpired = request.expires_at !== null && request.expires_at <= now
          if (requestExpired && input.decision !== "expired")
            return yield* new ConflictError({ entity: input.requestID, expected: "unexpired", actual: "expired" })
          if (!requestExpired && input.decision === "expired")
            return yield* new ConflictError({ entity: input.requestID, expected: "expired", actual: "unexpired" })
          if (input.decision === "approved_always" && !request.always_patterns.length)
            return yield* new InvalidInputError({ reason: "always approval requires at least one saved pattern" })
          if (input.sessionFanout === "always" && input.decision !== "approved_always")
            return yield* new InvalidInputError({ reason: "always fanout requires an always approval" })
          if (input.sessionFanout === "reject" && input.decision !== "denied" && input.decision !== "interrupted")
            return yield* new InvalidInputError({ reason: "reject fanout requires a denied or interrupted decision" })

          const authorityEpoch =
            input.decision !== "approved_always"
              ? request.authority_epoch
              : yield* Effect.gen(function* () {
                  const epoch = yield* tx
                    .select()
                    .from(PermissionSavedEpochTable)
                    .where(eq(PermissionSavedEpochTable.project_id, request.project_id))
                    .get()
                  if (!epoch)
                    return yield* Effect.die(new Error("permission authority is missing: " + request.project_id))
                  const existing = yield* tx
                    .select({ resource: PermissionTable.resource })
                    .from(PermissionTable)
                    .where(
                      and(
                        eq(PermissionTable.project_id, request.project_id),
                        eq(PermissionTable.action, request.permission),
                        inArray(PermissionTable.resource, request.always_patterns),
                      ),
                    )
                    .all()
                  const known = new Set(existing.map((item) => item.resource))
                  const missing = request.always_patterns.filter((resource) => !known.has(resource))
                  if (!missing.length) return epoch.epoch
                  const nextEpoch = request.authority_epoch + 1
                  const updated = yield* tx
                    .update(PermissionSavedEpochTable)
                    .set({ epoch: nextEpoch, updated_at: now })
                    .where(
                      and(
                        eq(PermissionSavedEpochTable.project_id, request.project_id),
                        eq(PermissionSavedEpochTable.epoch, request.authority_epoch),
                      ),
                    )
                    .returning()
                    .get()
                  if (!updated)
                    return yield* new ConflictError({
                      entity: request.project_id,
                      expected: String(request.authority_epoch),
                      actual: String(epoch.epoch),
                    })
                  yield* tx
                    .insert(PermissionTable)
                    .values(
                      missing.map((resource) => ({
                        id: PermissionSaved.ID.create(),
                        project_id: request.project_id,
                        action: request.permission,
                        resource,
                      })),
                    )
                    .onConflictDoNothing()
                    .run()
                  return nextEpoch
                })
          const row = {
            decision_id: "permission-decision:" + input.requestID,
            request_id: input.requestID,
            idempotency_key: input.idempotencyKey,
            decision: input.decision,
            actor_type: input.actorType,
            actor_id: input.actorID,
            scope:
              input.decision === "approved_always"
                ? ("project" as const)
                : input.decision === "approved_once"
                  ? ("once" as const)
                  : request.requested_scope,
            authority_epoch: authorityEpoch,
            decided_at: now,
            expires_at: input.expiresAt ?? null,
            feedback: input.feedback ?? null,
          }
          yield* tx.insert(SessionActivityPermissionDecisionTable).values(row).run()
          const settled = yield* tx
            .update(SessionActivityPermissionRequestTable)
            .set({ state: input.decision, decided_at: now })
            .where(
              and(
                eq(SessionActivityPermissionRequestTable.request_id, input.requestID),
                eq(SessionActivityPermissionRequestTable.state, "pending"),
              ),
            )
            .returning({ requestID: SessionActivityPermissionRequestTable.request_id })
            .get()
          if (!settled)
            return yield* new ConflictError({ entity: input.requestID, expected: "pending", actual: "changed" })

          if (request.request_kind === "no_progress") {
            const current = yield* tx
              .select()
              .from(SessionActivityObjectiveTable)
              .where(
                and(
                  eq(SessionActivityObjectiveTable.activity_kind, request.activity_kind),
                  eq(SessionActivityObjectiveTable.activity_id, request.activity_id),
                ),
              )
              .get()
            if (!current) return yield* Effect.die(new Error("activity objective is missing: " + request.activity_id))
            if (input.decision === "approved_once" || input.decision === "approved_always") {
              if (current.state !== "needs_human")
                return yield* new ConflictError({
                  entity: request.activity_id,
                  expected: "needs_human",
                  actual: current.state,
                })
              const resumed = yield* tx
                .update(SessionActivityObjectiveTable)
                .set({
                  version: current.version + 1,
                  state: "active",
                  no_progress_count: 0,
                  terminal_reason: null,
                  updated_at: now,
                  settled_at: null,
                })
                .where(
                  and(
                    eq(SessionActivityObjectiveTable.activity_kind, request.activity_kind),
                    eq(SessionActivityObjectiveTable.activity_id, request.activity_id),
                    eq(SessionActivityObjectiveTable.version, current.version),
                  ),
                )
                .returning({ activityID: SessionActivityObjectiveTable.activity_id })
                .get()
              if (!resumed)
                return yield* new ConflictError({
                  entity: request.activity_id,
                  expected: String(current.version),
                  actual: "changed",
                })
            }
            if (input.decision === "interrupted" && current.state === "needs_human") {
              const terminalReason = "permission_interrupted"
              const base =
                request.activity_kind === "legacy"
                  ? yield* tx.get<{ activity_id: string }>(sql`
                      UPDATE session_legacy_activity
                      SET state = 'interrupted', terminal_reason = ${terminalReason}, settled_at = ${now}
                      WHERE activity_id = ${request.activity_id} AND state = 'active'
                      RETURNING activity_id
                    `)
                  : request.activity_kind === "facade"
                    ? // FEAT-011 T2 — facade interruption mirrors the v2 branch (CAS on active).
                      yield* tx
                        .update(SessionFacadeActivityTable)
                        .set({ state: "interrupted", reason_code: terminalReason, settled_at: now })
                        .where(
                          and(
                            eq(SessionFacadeActivityTable.activity_id, request.activity_id),
                            eq(SessionFacadeActivityTable.state, "active"),
                          ),
                        )
                        .returning({ activityID: SessionFacadeActivityTable.activity_id })
                        .get()
                    : yield* tx
                        .update(SessionActivityTable)
                        .set({ state: "interrupted", settled_at: now })
                        .where(
                          and(
                            eq(SessionActivityTable.activity_id, request.activity_id),
                            eq(SessionActivityTable.state, "active"),
                          ),
                        )
                        .returning({ activityID: SessionActivityTable.activity_id })
                        .get()
              if (!base)
                return yield* new ConflictError({
                  entity: request.activity_id,
                  expected: "active base activity",
                  actual: "changed",
                })
              yield* tx
                .update(SessionActivityObjectiveTable)
                .set({
                  version: current.version + 1,
                  state: "interrupted",
                  terminal_reason: terminalReason,
                  updated_at: now,
                  settled_at: now,
                })
                .where(
                  and(
                    eq(SessionActivityObjectiveTable.activity_kind, request.activity_kind),
                    eq(SessionActivityObjectiveTable.activity_id, request.activity_id),
                    eq(SessionActivityObjectiveTable.version, current.version),
                  ),
                )
                .run()
            }
          }
          if (input.sessionFanout)
            yield* reconcilePermissionFanout(tx, request, {
              primaryRequestID: input.requestID,
              fanout: input.sessionFanout,
              actorType: input.actorType,
              actorID: input.actorID,
              approvedPatterns: request.always_patterns,
              decidedAt: now,
            })
          return permissionDecision(row)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

export const decidePermission = Effect.fn("DeepAgentActivityAuthority.decidePermission")(function* (
  input: DecidePermissionInput,
) {
  if (input.idempotencyKey.includes(":fanout:"))
    return yield* new InvalidInputError({ reason: "fanout decisions require the fanout authority API" })
  return yield* decidePermissionInternal(input)
})

export const decidePermissionWithFanout = Effect.fn("DeepAgentActivityAuthority.decidePermissionWithFanout")(function* (
  input: DecidePermissionInput & { readonly sessionFanout: "reject" | "always" },
) {
  if (!input.idempotencyKey.endsWith(`:fanout:${input.sessionFanout}`))
    return yield* new InvalidInputError({ reason: "fanout idempotency key must identify the fanout mode" })
  return yield* decidePermissionInternal(input)
})

export const permissionDecisionForRequest = Effect.fn("DeepAgentActivityAuthority.permissionDecisionForRequest")(
  function* (requestID: string) {
    const { db } = yield* Database.Service
    const row = yield* db
      .select()
      .from(SessionActivityPermissionDecisionTable)
      .where(eq(SessionActivityPermissionDecisionTable.request_id, requestID))
      .get()
      .pipe(Effect.orDie)
    return row ? permissionDecision(row) : undefined
  },
)

export const permissionRequestForRequest = Effect.fn("DeepAgentActivityAuthority.permissionRequestForRequest")(
  function* (requestID: string) {
    const { db } = yield* Database.Service
    const row = yield* db
      .select()
      .from(SessionActivityPermissionRequestTable)
      .where(eq(SessionActivityPermissionRequestTable.request_id, requestID))
      .get()
      .pipe(Effect.orDie)
    return row ? permissionRequest(row) : undefined
  },
)

export const heartbeatPermissionOwner = Effect.fn("DeepAgentActivityAuthority.heartbeatPermissionOwner")(
  function* (input: { readonly ownerID: string; readonly leaseMs: number }) {
    if (!input.ownerID.trim()) return yield* new InvalidInputError({ reason: "permission owner ID is required" })
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > PermissionOwnerMaxLeaseMs)
      return yield* new InvalidInputError({ reason: "permission owner lease must be a bounded positive integer" })
    const { db } = yield* Database.Service
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(SessionActivityPermissionOwnerLeaseTable)
              .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, input.ownerID))
              .get()
            const row = {
              owner_id: input.ownerID,
              heartbeat_at: databaseNow,
              lease_expires_at: sql`${databaseNow} + ${input.leaseMs}`,
            }
            if (!existing) {
              const inserted = yield* tx.insert(SessionActivityPermissionOwnerLeaseTable).values(row).returning().get()
              if (!inserted) return yield* Effect.die(new Error("permission owner lease insert disappeared"))
              return inserted
            }
            const updated = yield* tx
              .update(SessionActivityPermissionOwnerLeaseTable)
              .set(row)
              .where(
                and(
                  eq(SessionActivityPermissionOwnerLeaseTable.owner_id, input.ownerID),
                  gt(SessionActivityPermissionOwnerLeaseTable.lease_expires_at, databaseNow),
                ),
              )
              .returning()
              .get()
            if (!updated)
              return yield* new ConflictError({
                entity: input.ownerID,
                expected: "live permission owner lease",
                actual: "expired",
              })
            return updated
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
  },
)

export const releasePermissionOwner = Effect.fn("DeepAgentActivityAuthority.releasePermissionOwner")(function* (
  ownerID: string,
) {
  const { db } = yield* Database.Service
  yield* db
    .delete(SessionActivityPermissionOwnerLeaseTable)
    .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, ownerID))
    .run()
    .pipe(Effect.orDie)
})

export const rotatePermissionOwner = Effect.fn("DeepAgentActivityAuthority.rotatePermissionOwner")(function* (input: {
  readonly previousOwnerID: string
  readonly ownerID: string
  readonly leaseMs: number
}) {
  if (!input.previousOwnerID.trim() || !input.ownerID.trim() || input.previousOwnerID === input.ownerID)
    return yield* new InvalidInputError({ reason: "permission owner rotation requires distinct owner IDs" })
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > PermissionOwnerMaxLeaseMs)
    return yield* new InvalidInputError({ reason: "permission owner lease must be a bounded positive integer" })
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const now = yield* observedAtInTransaction(tx)
          const previous = yield* tx
            .select({ ownerID: SessionActivityPermissionOwnerLeaseTable.owner_id })
            .from(SessionActivityPermissionOwnerLeaseTable)
            .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, input.previousOwnerID))
            .get()
          if (!previous)
            return yield* new ConflictError({
              entity: input.previousOwnerID,
              expected: "registered permission owner",
              actual: "missing",
            })
          const existing = yield* tx
            .select({ ownerID: SessionActivityPermissionOwnerLeaseTable.owner_id })
            .from(SessionActivityPermissionOwnerLeaseTable)
            .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, input.ownerID))
            .get()
          if (existing)
            return yield* new ConflictError({
              entity: input.ownerID,
              expected: "fresh permission owner",
              actual: "registered",
            })
          yield* tx
            .insert(SessionActivityPermissionOwnerLeaseTable)
            .values({
              owner_id: input.ownerID,
              heartbeat_at: databaseNow,
              lease_expires_at: sql`${databaseNow} + ${input.leaseMs}`,
            })
            .run()
          yield* tx
            .delete(SessionActivityPermissionOwnerLeaseTable)
            .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, input.previousOwnerID))
            .run()
          const abandoned = yield* tx
            .select()
            .from(SessionActivityPermissionEffectDispatchTable)
            .where(
              and(
                eq(SessionActivityPermissionEffectDispatchTable.owner_id, input.previousOwnerID),
                eq(SessionActivityPermissionEffectDispatchTable.state, "started"),
              ),
            )
            .orderBy(asc(SessionActivityPermissionEffectDispatchTable.started_at))
            .all()
          const abandonedPending = yield* tx
            .select({ requestID: SessionActivityPermissionRequestTable.request_id })
            .from(SessionActivityPermissionRequestTable)
            .where(
              and(
                eq(SessionActivityPermissionRequestTable.owner_id, input.previousOwnerID),
                eq(SessionActivityPermissionRequestTable.state, "pending"),
              ),
            )
            .all()
          yield* Effect.forEach(
            abandoned,
            (dispatch) =>
              tx
                .update(SessionActivityPermissionEffectDispatchTable)
                .set({ state: "unknown", version: dispatch.version + 1, settled_at: now })
                .where(
                  and(
                    eq(SessionActivityPermissionEffectDispatchTable.receipt_id, dispatch.receipt_id),
                    eq(SessionActivityPermissionEffectDispatchTable.state, "started"),
                    eq(SessionActivityPermissionEffectDispatchTable.version, dispatch.version),
                    eq(SessionActivityPermissionEffectDispatchTable.owner_id, input.previousOwnerID),
                  ),
                )
                .returning({ receiptID: SessionActivityPermissionEffectDispatchTable.receipt_id })
                .get()
                .pipe(
                  Effect.flatMap((quarantined) =>
                    quarantined
                      ? Effect.void
                      : new ConflictError({
                          entity: dispatch.receipt_id,
                          expected: `started:${dispatch.version}:${input.previousOwnerID}`,
                          actual: "changed",
                        }),
                  ),
                ),
            { discard: true },
          )
          yield* Effect.forEach(abandoned, (dispatch) => recoverActivityForPermissionEffect(tx, dispatch, now), {
            discard: true,
          })
          yield* recoverPendingPermissionsInTransaction(tx, input.ownerID, input.previousOwnerID, now)
          const remainingPending = yield* tx
            .select({ requestID: SessionActivityPermissionRequestTable.request_id })
            .from(SessionActivityPermissionRequestTable)
            .where(
              and(
                eq(SessionActivityPermissionRequestTable.owner_id, input.previousOwnerID),
                eq(SessionActivityPermissionRequestTable.state, "pending"),
              ),
            )
            .all()
          return {
            previousOwnerID: input.previousOwnerID,
            ownerID: input.ownerID,
            quarantinedEffectCount: abandoned.length,
            recoveredPendingCount: abandonedPending.length - remainingPending.length,
          } satisfies PermissionOwnerRotation
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

export const consumeOnce = Effect.fn("DeepAgentActivityAuthority.consumeOnce")(function* (input: {
  readonly requestID: string
  readonly consumerID: string
  readonly idempotencyKey: string
}) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(SessionActivityPermissionOnceConsumptionTable)
            .where(
              or(
                eq(SessionActivityPermissionOnceConsumptionTable.request_id, input.requestID),
                eq(SessionActivityPermissionOnceConsumptionTable.idempotency_key, input.idempotencyKey),
              ),
            )
            .get()
          if (existing) {
            if (
              existing.request_id !== input.requestID ||
              existing.consumer_id !== input.consumerID ||
              existing.idempotency_key !== input.idempotencyKey
            )
              return yield* new ConflictError({
                entity: input.requestID,
                expected: input.consumerID,
                actual: existing.consumer_id,
              })
            return existing
          }
          const request = yield* tx
            .select()
            .from(SessionActivityPermissionRequestTable)
            .where(eq(SessionActivityPermissionRequestTable.request_id, input.requestID))
            .get()
          const decision = yield* tx
            .select()
            .from(SessionActivityPermissionDecisionTable)
            .where(eq(SessionActivityPermissionDecisionTable.request_id, input.requestID))
            .get()
          const now = yield* observedAtInTransaction(tx)
          if (!request || request.state !== "approved_once" || !decision || decision.decision !== "approved_once")
            return yield* new ConflictError({
              entity: input.requestID,
              expected: "approved_once",
              actual: request?.state ?? "missing",
            })
          const objective = yield* tx
            .select({ state: SessionActivityObjectiveTable.state })
            .from(SessionActivityObjectiveTable)
            .where(
              and(
                eq(SessionActivityObjectiveTable.activity_kind, request.activity_kind),
                eq(SessionActivityObjectiveTable.activity_id, request.activity_id),
              ),
            )
            .get()
          const base =
            request.activity_kind === "legacy"
              ? yield* tx.get<{ state: string }>(sql`
                  SELECT state FROM session_legacy_activity WHERE activity_id = ${request.activity_id}
                `)
              : request.activity_kind === "facade"
                ? yield* tx
                    .select({ state: SessionFacadeActivityTable.state })
                    .from(SessionFacadeActivityTable)
                    .where(eq(SessionFacadeActivityTable.activity_id, request.activity_id))
                    .get()
                : yield* tx
                    .select({ state: SessionActivityTable.state })
                    .from(SessionActivityTable)
                    .where(eq(SessionActivityTable.activity_id, request.activity_id))
                    .get()
          if (objective?.state !== "active" || base?.state !== "active")
            return yield* new ConflictError({
              entity: request.activity_id,
              expected: "active activity",
              actual: objective?.state ?? base?.state ?? "missing",
            })
          if (
            (request.expires_at !== null && request.expires_at <= now) ||
            (decision.expires_at !== null && decision.expires_at <= now)
          )
            return yield* new ConflictError({ entity: input.requestID, expected: "unexpired", actual: "expired" })
          const row = {
            request_id: input.requestID,
            consumer_id: input.consumerID,
            idempotency_key: input.idempotencyKey,
            consumed_at: now,
          }
          yield* tx.insert(SessionActivityPermissionOnceConsumptionTable).values(row).run()
          return row
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

export const beginPermissionEffect = Effect.fn("DeepAgentActivityAuthority.beginPermissionEffect")(function* (input: {
  readonly requestID: string
  readonly toolName: string
  readonly consumerID: string
  readonly idempotencyKey: string
  readonly ownerID: string
}) {
  if (!input.requestID || !input.toolName || !input.consumerID || !input.idempotencyKey || !input.ownerID)
    return yield* new InvalidInputError({ reason: "permission effect dispatch identity is required" })
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(SessionActivityPermissionEffectDispatchTable)
            .where(
              or(
                eq(SessionActivityPermissionEffectDispatchTable.request_id, input.requestID),
                eq(SessionActivityPermissionEffectDispatchTable.idempotency_key, input.idempotencyKey),
              ),
            )
            .get()
          if (existing) {
            const exact =
              existing.request_id === input.requestID &&
              existing.tool_name === input.toolName &&
              existing.consumer_id === input.consumerID &&
              existing.idempotency_key === input.idempotencyKey
            if (!exact)
              return yield* new ConflictError({
                entity: input.requestID,
                expected: input.idempotencyKey,
                actual: existing.idempotency_key,
              })
            if (existing.state !== "settled")
              return yield* new ConflictError({
                entity: input.requestID,
                expected: "settled exact retry",
                actual: existing.state,
              })
            return permissionEffectDispatch(existing)
          }
          const request = yield* tx
            .select()
            .from(SessionActivityPermissionRequestTable)
            .where(eq(SessionActivityPermissionRequestTable.request_id, input.requestID))
            .get()
          const decision = yield* tx
            .select()
            .from(SessionActivityPermissionDecisionTable)
            .where(eq(SessionActivityPermissionDecisionTable.request_id, input.requestID))
            .get()
          if (!request || request.request_kind !== "tool" || !request.tool_message_id || !request.tool_call_id)
            return yield* new ConflictError({
              entity: input.requestID,
              expected: "decided tool permission",
              actual: request?.request_kind ?? "missing",
            })
          if (!decision || !["approved_once", "approved_always"].includes(decision.decision))
            return yield* new ConflictError({
              entity: input.requestID,
              expected: "approved permission",
              actual: decision?.decision ?? request.state,
            })
          if (request.state !== decision.decision)
            return yield* new ConflictError({
              entity: input.requestID,
              expected: decision.decision,
              actual: request.state,
            })
          const now = yield* observedAtInTransaction(tx)
          if (
            (request.expires_at !== null && request.expires_at <= now) ||
            (decision.expires_at !== null && decision.expires_at <= now)
          )
            return yield* new ConflictError({ entity: input.requestID, expected: "unexpired", actual: "expired" })
          const lease = yield* tx
            .select()
            .from(SessionActivityPermissionOwnerLeaseTable)
            .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, input.ownerID))
            .get()
          if (!lease || lease.lease_expires_at <= now)
            return yield* new ConflictError({
              entity: input.requestID,
              expected: "live permission owner",
              actual: lease ? "expired" : "missing",
            })
          const objective = yield* tx
            .select({ state: SessionActivityObjectiveTable.state })
            .from(SessionActivityObjectiveTable)
            .where(
              and(
                eq(SessionActivityObjectiveTable.activity_kind, request.activity_kind),
                eq(SessionActivityObjectiveTable.activity_id, request.activity_id),
              ),
            )
            .get()
          const base =
            request.activity_kind === "legacy"
              ? yield* tx.get<{ state: string }>(sql`
                  SELECT state FROM session_legacy_activity WHERE activity_id = ${request.activity_id}
                `)
              : request.activity_kind === "facade"
                ? yield* tx
                    .select({ state: SessionFacadeActivityTable.state })
                    .from(SessionFacadeActivityTable)
                    .where(eq(SessionFacadeActivityTable.activity_id, request.activity_id))
                    .get()
                : yield* tx
                    .select({ state: SessionActivityTable.state })
                    .from(SessionActivityTable)
                    .where(eq(SessionActivityTable.activity_id, request.activity_id))
                    .get()
          if (objective?.state !== "active" || base?.state !== "active")
            return yield* new ConflictError({
              entity: request.activity_id,
              expected: "active activity",
              actual: objective?.state ?? base?.state ?? "missing",
            })
          if (decision.decision === "approved_once") {
            const consumed = yield* tx
              .select()
              .from(SessionActivityPermissionOnceConsumptionTable)
              .where(eq(SessionActivityPermissionOnceConsumptionTable.request_id, input.requestID))
              .get()
            if (consumed)
              return yield* new ConflictError({
                entity: input.requestID,
                expected: "unconsumed approved_once",
                actual: consumed.consumer_id,
              })
            yield* tx
              .insert(SessionActivityPermissionOnceConsumptionTable)
              .values({
                request_id: input.requestID,
                consumer_id: input.consumerID,
                idempotency_key: `permission-consumption:${input.requestID}`,
                consumed_at: now,
              })
              .run()
          }
          const row = {
            receipt_id: `permission-effect:${input.requestID}`,
            request_id: input.requestID,
            activity_kind: request.activity_kind,
            activity_id: request.activity_id,
            session_id: request.session_id,
            project_id: request.project_id,
            workspace_id: request.workspace_id,
            tool_message_id: request.tool_message_id,
            tool_call_id: request.tool_call_id,
            tool_name: input.toolName,
            consumer_id: input.consumerID,
            idempotency_key: input.idempotencyKey,
            owner_id: input.ownerID,
            state: "started" as const,
            version: 1,
            outcome: null,
            result_json: null,
            result_hash: null,
            started_at: now,
            settled_at: null,
          }
          yield* tx.insert(SessionActivityPermissionEffectDispatchTable).values(row).run()
          return permissionEffectDispatch(row)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

export const settlePermissionEffect = Effect.fn("DeepAgentActivityAuthority.settlePermissionEffect")(function* (input: {
  readonly receiptID: string
  readonly expectedVersion: number
  readonly ownerID: string
  readonly outcome: "success" | "failure"
  readonly result: unknown
}) {
  if (!input.receiptID || !input.ownerID)
    return yield* new InvalidInputError({ reason: "permission effect terminal identity is required" })
  const resultHash = fingerprint(input.result)
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select()
            .from(SessionActivityPermissionEffectDispatchTable)
            .where(eq(SessionActivityPermissionEffectDispatchTable.receipt_id, input.receiptID))
            .get()
          if (!current)
            return yield* new ConflictError({ entity: input.receiptID, expected: "started", actual: "missing" })
          if (current.state === "settled") {
            if (current.outcome !== input.outcome || current.result_hash !== resultHash)
              return yield* new ConflictError({
                entity: input.receiptID,
                expected: current.result_hash ?? "terminal result",
                actual: resultHash,
              })
            return permissionEffectDispatch(current)
          }
          if (
            current.state !== "started" ||
            current.version !== input.expectedVersion ||
            current.owner_id !== input.ownerID
          )
            return yield* new ConflictError({
              entity: input.receiptID,
              expected: `started:${input.expectedVersion}:${input.ownerID}`,
              actual: `${current.state}:${current.version}:${current.owner_id}`,
            })
          const now = yield* observedAtInTransaction(tx)
          const lease = yield* tx
            .select({ expiresAt: SessionActivityPermissionOwnerLeaseTable.lease_expires_at })
            .from(SessionActivityPermissionOwnerLeaseTable)
            .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, input.ownerID))
            .get()
          if (!lease || lease.expiresAt <= now)
            return yield* new ConflictError({
              entity: input.receiptID,
              expected: "live permission owner",
              actual: lease ? "expired" : "missing",
            })
          const updated = yield* tx
            .update(SessionActivityPermissionEffectDispatchTable)
            .set({
              state: "settled",
              version: current.version + 1,
              outcome: input.outcome,
              result_json: input.result,
              result_hash: resultHash,
              settled_at: now,
            })
            .where(
              and(
                eq(SessionActivityPermissionEffectDispatchTable.receipt_id, input.receiptID),
                eq(SessionActivityPermissionEffectDispatchTable.state, "started"),
                eq(SessionActivityPermissionEffectDispatchTable.version, input.expectedVersion),
                eq(SessionActivityPermissionEffectDispatchTable.owner_id, input.ownerID),
              ),
            )
            .returning()
            .get()
          if (!updated)
            return yield* new ConflictError({ entity: input.receiptID, expected: "started CAS", actual: "changed" })
          return permissionEffectDispatch(updated)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

export const permissionEffectsForToolCall = Effect.fn("DeepAgentActivityAuthority.permissionEffectsForToolCall")(
  function* (input: {
    readonly sessionID: string
    readonly toolMessageID: string
    readonly toolCallID: string
    readonly toolName: string
  }) {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionActivityPermissionEffectDispatchTable)
      .where(
        and(
          sql`${SessionActivityPermissionEffectDispatchTable.session_id} = ${input.sessionID}`,
          eq(SessionActivityPermissionEffectDispatchTable.tool_message_id, input.toolMessageID),
          eq(SessionActivityPermissionEffectDispatchTable.tool_call_id, input.toolCallID),
          eq(SessionActivityPermissionEffectDispatchTable.tool_name, input.toolName),
        ),
      )
      .orderBy(asc(SessionActivityPermissionEffectDispatchTable.started_at))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(permissionEffectDispatch)),
      )
  },
)

export const recoverPermissionEffects = Effect.fn("DeepAgentActivityAuthority.recoverPermissionEffects")(function* (
  ownerID: string,
) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const now = yield* observedAtInTransaction(tx)
          const recoveryOwner = yield* tx
            .select({ expiresAt: SessionActivityPermissionOwnerLeaseTable.lease_expires_at })
            .from(SessionActivityPermissionOwnerLeaseTable)
            .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, ownerID))
            .get()
          if (!recoveryOwner || recoveryOwner.expiresAt <= now)
            return yield* new ConflictError({
              entity: ownerID,
              expected: "live permission recovery owner",
              actual: recoveryOwner ? "expired" : "missing",
            })
          const abandoned = yield* tx
            .select()
            .from(SessionActivityPermissionEffectDispatchTable)
            .where(
              and(
                eq(SessionActivityPermissionEffectDispatchTable.state, "started"),
                ne(SessionActivityPermissionEffectDispatchTable.owner_id, ownerID),
                notExists(
                  tx
                    .select({ ownerID: SessionActivityPermissionOwnerLeaseTable.owner_id })
                    .from(SessionActivityPermissionOwnerLeaseTable)
                    .where(
                      and(
                        eq(
                          SessionActivityPermissionOwnerLeaseTable.owner_id,
                          SessionActivityPermissionEffectDispatchTable.owner_id,
                        ),
                        gt(SessionActivityPermissionOwnerLeaseTable.lease_expires_at, now),
                      ),
                    ),
                ),
              ),
            )
            .orderBy(asc(SessionActivityPermissionEffectDispatchTable.started_at))
            .all()
          yield* Effect.forEach(
            abandoned,
            (dispatch) =>
              Effect.gen(function* () {
                const quarantined = yield* tx
                  .update(SessionActivityPermissionEffectDispatchTable)
                  .set({ state: "unknown", version: dispatch.version + 1, settled_at: now })
                  .where(
                    and(
                      eq(SessionActivityPermissionEffectDispatchTable.receipt_id, dispatch.receipt_id),
                      eq(SessionActivityPermissionEffectDispatchTable.state, "started"),
                      eq(SessionActivityPermissionEffectDispatchTable.version, dispatch.version),
                    ),
                  )
                  .returning({ receiptID: SessionActivityPermissionEffectDispatchTable.receipt_id })
                  .get()
                if (!quarantined) return
                yield* recoverActivityForPermissionEffect(tx, dispatch, now)
              }),
            { discard: true },
          )
          return abandoned.length
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

export const recoverActivity = Effect.fn("DeepAgentActivityAuthority.recoverActivity")(function* (
  input: ActivityRef & {
    readonly expectedVersion: number
    readonly terminalReason: string
    readonly recoveryOwnerID: string
  },
) {
  if (!input.terminalReason.trim() || !input.recoveryOwnerID.trim())
    return yield* new InvalidInputError({ reason: "activity recovery reason and owner are required" })
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const now = yield* observedAtInTransaction(tx)
          const recoveryOwner = yield* tx
            .select({ expiresAt: SessionActivityPermissionOwnerLeaseTable.lease_expires_at })
            .from(SessionActivityPermissionOwnerLeaseTable)
            .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, input.recoveryOwnerID))
            .get()
          if (!recoveryOwner || recoveryOwner.expiresAt <= now)
            return yield* new ConflictError({
              entity: input.recoveryOwnerID,
              expected: "live permission recovery owner",
              actual: recoveryOwner ? "expired" : "missing",
            })
          const current = yield* tx.select().from(SessionActivityObjectiveTable).where(activityWhere(input)).get()
          if (!current) return yield* notFound(input)
          if (current.state === "recovery_required") return true
          if (current.version !== input.expectedVersion)
            return yield* versionConflict(input.activityID, input.expectedVersion, current.version)
          if (!["active", "needs_human"].includes(current.state))
            return yield* new ConflictError({ entity: input.activityID, expected: "active", actual: current.state })
          const started = yield* tx
            .select()
            .from(SessionActivityPermissionEffectDispatchTable)
            .where(
              and(
                effectDispatchActivityWhere(input),
                eq(SessionActivityPermissionEffectDispatchTable.state, "started"),
              ),
            )
            .orderBy(asc(SessionActivityPermissionEffectDispatchTable.started_at))
            .all()
          const liveEffectOwner = started.length
            ? yield* tx
                .select({ ownerID: SessionActivityPermissionOwnerLeaseTable.owner_id })
                .from(SessionActivityPermissionOwnerLeaseTable)
                .where(
                  and(
                    inArray(
                      SessionActivityPermissionOwnerLeaseTable.owner_id,
                      started.map((dispatch) => dispatch.owner_id),
                    ),
                    gt(SessionActivityPermissionOwnerLeaseTable.lease_expires_at, now),
                  ),
                )
                .get()
            : undefined
          if (liveEffectOwner) return false
          yield* Effect.forEach(
            started,
            (dispatch) =>
              tx
                .update(SessionActivityPermissionEffectDispatchTable)
                .set({ state: "unknown", version: dispatch.version + 1, settled_at: now })
                .where(
                  and(
                    eq(SessionActivityPermissionEffectDispatchTable.receipt_id, dispatch.receipt_id),
                    eq(SessionActivityPermissionEffectDispatchTable.state, "started"),
                    eq(SessionActivityPermissionEffectDispatchTable.version, dispatch.version),
                  ),
                )
                .returning({ receiptID: SessionActivityPermissionEffectDispatchTable.receipt_id })
                .get()
                .pipe(
                  Effect.flatMap((quarantined) =>
                    quarantined
                      ? Effect.void
                      : new ConflictError({
                          entity: dispatch.receipt_id,
                          expected: `started:${dispatch.version}`,
                          actual: "changed",
                        }),
                  ),
                ),
            { discard: true },
          )
          yield* recoverActivityToRequired(tx, current, input.terminalReason, now)
          return true
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

export const recoverPendingPermissions = Effect.fn("DeepAgentActivityAuthority.recoverPendingPermissions")(function* (
  ownerID: string,
) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const now = yield* observedAtInTransaction(tx)
          const recoveryOwner = yield* tx
            .select({ expiresAt: SessionActivityPermissionOwnerLeaseTable.lease_expires_at })
            .from(SessionActivityPermissionOwnerLeaseTable)
            .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, ownerID))
            .get()
          if (recoveryOwner && recoveryOwner.expiresAt <= now)
            return yield* new ConflictError({
              entity: ownerID,
              expected: "live permission recovery owner",
              actual: "expired",
            })
          return yield* recoverPendingPermissionsInTransaction(tx, ownerID, undefined, now)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

function recoverPendingPermissionsInTransaction(
  tx: Transaction,
  ownerID: string,
  abandonedOwnerID: string | undefined,
  now: number,
) {
  return Effect.gen(function* () {
    const pending = yield* tx
      .select()
      .from(SessionActivityPermissionRequestTable)
      .where(
        and(
          eq(SessionActivityPermissionRequestTable.state, "pending"),
          abandonedOwnerID
            ? eq(SessionActivityPermissionRequestTable.owner_id, abandonedOwnerID)
            : ne(SessionActivityPermissionRequestTable.owner_id, ownerID),
          notExists(
            tx
              .select({ ownerID: SessionActivityPermissionOwnerLeaseTable.owner_id })
              .from(SessionActivityPermissionOwnerLeaseTable)
              .where(
                and(
                  eq(SessionActivityPermissionOwnerLeaseTable.owner_id, SessionActivityPermissionRequestTable.owner_id),
                  gt(SessionActivityPermissionOwnerLeaseTable.lease_expires_at, now),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(SessionActivityPermissionRequestTable.created_at))
      .all()
    yield* Effect.forEach(
      pending,
      (request) =>
        Effect.gen(function* () {
          const decision =
            request.expires_at !== null && request.expires_at <= now ? ("expired" as const) : ("interrupted" as const)
          yield* tx.insert(SessionActivityPermissionDecisionTable).values({
            decision_id: "permission-recovery:" + request.request_id,
            request_id: request.request_id,
            idempotency_key: "permission-recovery:" + request.request_id,
            decision,
            actor_type: "system",
            actor_id: ownerID,
            scope: request.requested_scope,
            authority_epoch: request.authority_epoch,
            decided_at: now,
            expires_at: null,
          })
          const updated = yield* tx
            .update(SessionActivityPermissionRequestTable)
            .set({ state: decision, decided_at: now })
            .where(
              and(
                eq(SessionActivityPermissionRequestTable.request_id, request.request_id),
                eq(SessionActivityPermissionRequestTable.state, "pending"),
              ),
            )
            .returning({ requestID: SessionActivityPermissionRequestTable.request_id })
            .get()
          if (!updated)
            return yield* new ConflictError({
              entity: request.request_id,
              expected: "pending permission request",
              actual: "changed",
            })
          const objective = yield* tx
            .select()
            .from(SessionActivityObjectiveTable)
            .where(
              and(
                eq(SessionActivityObjectiveTable.activity_kind, request.activity_kind),
                eq(SessionActivityObjectiveTable.activity_id, request.activity_id),
              ),
            )
            .get()
          const state =
            request.request_kind === "no_progress" && objective?.state === "needs_human"
              ? ("interrupted" as const)
              : request.request_kind === "tool" && objective?.state === "active"
                ? ("recovery_required" as const)
                : undefined
          if (!objective || !state) return
          const terminalReason =
            state === "interrupted"
              ? "pending_permission_interrupted_after_restart"
              : "pending_permission_recovery_required"
          if (state === "recovery_required") {
            yield* recoverActivityToRequired(tx, objective, terminalReason, now)
            return
          }
          const interrupted = yield* tx
            .update(SessionActivityObjectiveTable)
            .set({
              version: objective.version + 1,
              state,
              terminal_reason: terminalReason,
              updated_at: now,
              settled_at: now,
            })
            .where(
              and(
                eq(SessionActivityObjectiveTable.activity_kind, request.activity_kind),
                eq(SessionActivityObjectiveTable.activity_id, request.activity_id),
                eq(SessionActivityObjectiveTable.version, objective.version),
              ),
            )
            .returning({ activityID: SessionActivityObjectiveTable.activity_id })
            .get()
          if (!interrupted)
            return yield* new ConflictError({
              entity: request.activity_id,
              expected: String(objective.version),
              actual: "changed",
            })
          const base =
            request.activity_kind === "legacy"
              ? yield* tx.get<{ activity_id: string }>(sql`
                  UPDATE session_legacy_activity
                  SET state = 'interrupted', terminal_reason = ${terminalReason}, settled_at = ${now}
                  WHERE activity_id = ${request.activity_id} AND state = 'active'
                  RETURNING activity_id
                `)
              : request.activity_kind === "facade"
                ? // FEAT-011 T2 — facade interruption mirrors the v2 branch (CAS on active).
                  yield* tx
                    .update(SessionFacadeActivityTable)
                    .set({ state: "interrupted", reason_code: terminalReason, settled_at: now })
                    .where(
                      and(
                        eq(SessionFacadeActivityTable.activity_id, request.activity_id),
                        eq(SessionFacadeActivityTable.state, "active"),
                      ),
                    )
                    .returning({ activityID: SessionFacadeActivityTable.activity_id })
                    .get()
                : yield* tx
                    .update(SessionActivityTable)
                    .set({ state: "interrupted", settled_at: now })
                    .where(
                      and(
                        eq(SessionActivityTable.activity_id, request.activity_id),
                        eq(SessionActivityTable.state, "active"),
                      ),
                    )
                    .returning({ activityID: SessionActivityTable.activity_id })
                    .get()
          if (!base)
            return yield* new ConflictError({
              entity: request.activity_id,
              expected: "active base activity",
              actual: "changed",
            })
        }),
      { discard: true },
    )
    return pending.length
  })
}

const databaseNow = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`
const PermissionOwnerMaxLeaseMs = 31_536_000_000

function observedAtInTransaction(tx: Transaction) {
  return tx.get<{ observedAt: number }>(sql`SELECT ${databaseNow} AS observedAt`).pipe(
    Effect.flatMap((row) =>
      row ? Effect.succeed(row.observedAt) : Effect.die(new Error("database clock unavailable")),
    ),
    Effect.orDie,
  )
}

function activityWhere(input: ActivityRef) {
  return and(
    eq(SessionActivityObjectiveTable.activity_kind, input.activityKind),
    eq(SessionActivityObjectiveTable.activity_id, input.activityID),
  )
}

function activityEvidenceWhere(input: ActivityRef) {
  return and(
    eq(SessionActivityEvidenceTable.activity_kind, input.activityKind),
    eq(SessionActivityEvidenceTable.activity_id, input.activityID),
  )
}

function activityEffectWhere(input: ActivityRef) {
  return and(
    eq(SessionActivityEffectReceiptTable.activity_kind, input.activityKind),
    eq(SessionActivityEffectReceiptTable.activity_id, input.activityID),
  )
}

function effectDispatchActivityWhere(input: ActivityRef) {
  return and(
    eq(SessionActivityPermissionEffectDispatchTable.activity_kind, input.activityKind),
    eq(SessionActivityPermissionEffectDispatchTable.activity_id, input.activityID),
  )
}

function activityObservationWhere(input: ActivityRef) {
  return and(
    eq(SessionActivityProgressObservationTable.activity_kind, input.activityKind),
    eq(SessionActivityProgressObservationTable.activity_id, input.activityID),
  )
}

function permissionActivityWhere(input: ActivityRef) {
  return and(
    eq(SessionActivityPermissionRequestTable.activity_kind, input.activityKind),
    eq(SessionActivityPermissionRequestTable.activity_id, input.activityID),
  )
}

function notFound(input: ActivityRef) {
  return new NotFoundError({ activityKind: input.activityKind, activityID: input.activityID })
}

function versionConflict(activityID: string, expected: number, actual: number) {
  return new ConflictError({ entity: activityID, expected: String(expected), actual: String(actual) })
}

function objective(row: typeof SessionActivityObjectiveTable.$inferSelect): Objective {
  return {
    activityKind: row.activity_kind,
    activityID: row.activity_id,
    sessionID: row.session_id,
    version: row.version,
    admissionFingerprint: row.admission_fingerprint,
    ...(row.objective_fingerprint ? { objectiveFingerprint: row.objective_fingerprint } : {}),
    ...(row.objective_text ? { objectiveText: row.objective_text } : {}),
    completionCriteria: row.completion_criteria,
    enforcementState: row.enforcement_state,
    ...(row.stall_threshold !== null ? { stallThreshold: row.stall_threshold } : {}),
    state: row.state,
    noProgressCount: row.no_progress_count,
    latestObservationRevision: row.latest_observation_revision,
    ...(row.latest_vector_hash ? { latestVectorHash: row.latest_vector_hash } : {}),
    ...(row.next_action ? { nextAction: row.next_action } : {}),
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
  }
}

function observation(row: typeof SessionActivityProgressObservationTable.$inferSelect): Observation {
  return {
    activityKind: row.activity_kind,
    activityID: row.activity_id,
    revision: row.revision,
    idempotencyKey: row.idempotency_key,
    observationFingerprint: row.observation_fingerprint,
    expectedObjectiveVersion: row.expected_objective_version,
    ...(row.workspace_revision ? { workspaceRevision: row.workspace_revision } : {}),
    ...(row.plan_version !== null ? { planVersion: row.plan_version } : {}),
    ...(row.validation_fingerprint ? { validationFingerprint: row.validation_fingerprint } : {}),
    evidenceSetHash: row.evidence_set_hash,
    effectReceiptSetHash: row.effect_receipt_set_hash,
    vectorHash: row.vector_hash,
    ...(row.next_action ? { nextAction: row.next_action } : {}),
    changed: row.changed,
    noProgressCount: row.no_progress_count,
    observedAt: row.observed_at,
  }
}

function permissionRequest(row: typeof SessionActivityPermissionRequestTable.$inferSelect) {
  return {
    requestID: row.request_id,
    activityKind: row.activity_kind,
    activityID: row.activity_id,
    sessionID: row.session_id,
    projectID: row.project_id,
    ...(row.workspace_id !== null ? { workspaceID: row.workspace_id } : {}),
    requestKind: row.request_kind,
    state: row.state,
    authorityEpoch: row.authority_epoch,
    requestedScope: row.requested_scope,
    createdAt: row.created_at,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
  }
}

function permissionEffectDispatch(row: typeof SessionActivityPermissionEffectDispatchTable.$inferSelect) {
  return {
    receiptID: row.receipt_id,
    requestID: row.request_id,
    activityKind: row.activity_kind,
    activityID: row.activity_id,
    sessionID: row.session_id,
    projectID: row.project_id,
    ...(row.workspace_id !== null ? { workspaceID: row.workspace_id } : {}),
    toolMessageID: row.tool_message_id,
    toolCallID: row.tool_call_id,
    toolName: row.tool_name,
    consumerID: row.consumer_id,
    ownerID: row.owner_id,
    state: row.state,
    version: row.version,
    ...(row.outcome !== null ? { outcome: row.outcome } : {}),
    ...(row.result_json !== null ? { result: row.result_json } : {}),
    ...(row.result_hash !== null ? { resultHash: row.result_hash } : {}),
    startedAt: row.started_at,
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
  } satisfies PermissionEffectDispatch
}

function recoverActivityForPermissionEffect(
  tx: Transaction,
  dispatch: typeof SessionActivityPermissionEffectDispatchTable.$inferSelect,
  now: number,
) {
  return Effect.gen(function* () {
    const objective = yield* tx
      .select()
      .from(SessionActivityObjectiveTable)
      .where(
        and(
          eq(SessionActivityObjectiveTable.activity_kind, dispatch.activity_kind),
          eq(SessionActivityObjectiveTable.activity_id, dispatch.activity_id),
        ),
      )
      .get()
    if (!objective || objective.state === "recovery_required") return
    if (objective.state !== "active" && objective.state !== "needs_human")
      return yield* new ConflictError({
        entity: dispatch.activity_id,
        expected: "active permission effect activity",
        actual: objective.state,
      })
    yield* recoverActivityToRequired(tx, objective, "permission_effect_outcome_unknown_after_restart", now)
  })
}

function recoverActivityToRequired(
  tx: Transaction,
  objective: typeof SessionActivityObjectiveTable.$inferSelect,
  terminalReason: string,
  now: number,
) {
  return Effect.gen(function* () {
    const recovered = yield* tx
      .update(SessionActivityObjectiveTable)
      .set({
        version: objective.version + 1,
        state: "recovery_required",
        terminal_reason: terminalReason,
        updated_at: now,
        settled_at: now,
      })
      .where(
        and(
          eq(SessionActivityObjectiveTable.activity_kind, objective.activity_kind),
          eq(SessionActivityObjectiveTable.activity_id, objective.activity_id),
          eq(SessionActivityObjectiveTable.version, objective.version),
          inArray(SessionActivityObjectiveTable.state, ["active", "needs_human"]),
        ),
      )
      .returning({ activityID: SessionActivityObjectiveTable.activity_id })
      .get()
    if (!recovered)
      return yield* new ConflictError({
        entity: objective.activity_id,
        expected: String(objective.version),
        actual: "changed",
      })
    const base =
      objective.activity_kind === "legacy"
        ? yield* tx.get<{ activity_id: string }>(sql`
            UPDATE session_legacy_activity
            SET state = 'recovery_required', terminal_reason = ${terminalReason}, settled_at = ${now}
            WHERE activity_id = ${objective.activity_id} AND state = 'active'
            RETURNING activity_id
          `)
        : objective.activity_kind === "facade"
          ? // FEAT-011 T2 — facade recovery follows the v2 mapping: recovery_required is persisted
            // as base state 'failed' (CAS on active), unlike legacy which keeps 'recovery_required'.
            yield* tx
              .update(SessionFacadeActivityTable)
              .set({ state: "failed", reason_code: terminalReason, settled_at: now })
              .where(
                and(
                  eq(SessionFacadeActivityTable.activity_id, objective.activity_id),
                  eq(SessionFacadeActivityTable.state, "active"),
                ),
              )
              .returning({ activityID: SessionFacadeActivityTable.activity_id })
              .get()
          : yield* tx
              .update(SessionActivityTable)
              .set({ state: "failed", settled_at: now })
              .where(
                and(
                  eq(SessionActivityTable.activity_id, objective.activity_id),
                  eq(SessionActivityTable.state, "active"),
                ),
              )
              .returning({ activityID: SessionActivityTable.activity_id })
              .get()
    if (!base)
      return yield* new ConflictError({
        entity: objective.activity_id,
        expected: "active base activity",
        actual: "changed",
      })
  })
}

function reconcilePermissionFanout(
  tx: Transaction,
  request: typeof SessionActivityPermissionRequestTable.$inferSelect,
  input: {
    readonly primaryRequestID: string
    readonly fanout: "reject" | "always"
    readonly actorType: "user" | "administrator" | "system"
    readonly actorID: string
    readonly approvedPatterns: readonly string[]
    readonly decidedAt: number
  },
) {
  return Effect.gen(function* () {
    const pending = yield* tx
      .select()
      .from(SessionActivityPermissionRequestTable)
      .where(
        and(
          eq(SessionActivityPermissionRequestTable.session_id, request.session_id),
          eq(SessionActivityPermissionRequestTable.state, "pending"),
          ne(SessionActivityPermissionRequestTable.request_id, input.primaryRequestID),
          request.workspace_id === null
            ? isNull(SessionActivityPermissionRequestTable.workspace_id)
            : eq(SessionActivityPermissionRequestTable.workspace_id, request.workspace_id),
        ),
      )
      .all()
    const siblings =
      input.fanout === "reject"
        ? pending.toSorted(
            (left, right) => Number(left.request_kind === "no_progress") - Number(right.request_kind === "no_progress"),
          )
        : pending.filter(
            (sibling) =>
              sibling.permission === request.permission &&
              sibling.patterns.every((pattern) =>
                input.approvedPatterns.some((approved) => Wildcard.match(pattern, approved)),
              ),
          )
    for (const sibling of siblings) {
      const objective = yield* tx
        .select()
        .from(SessionActivityObjectiveTable)
        .where(
          and(
            eq(SessionActivityObjectiveTable.activity_kind, sibling.activity_kind),
            eq(SessionActivityObjectiveTable.activity_id, sibling.activity_id),
          ),
        )
        .get()
      const base =
        sibling.activity_kind === "legacy"
          ? yield* tx.get<{ state: string }>(sql`
              SELECT state FROM session_legacy_activity WHERE activity_id = ${sibling.activity_id}
            `)
          : sibling.activity_kind === "facade"
            ? yield* tx
                .select({ state: SessionFacadeActivityTable.state })
                .from(SessionFacadeActivityTable)
                .where(eq(SessionFacadeActivityTable.activity_id, sibling.activity_id))
                .get()
            : yield* tx
                .select({ state: SessionActivityTable.state })
                .from(SessionActivityTable)
                .where(eq(SessionActivityTable.activity_id, sibling.activity_id))
                .get()
      const expired = sibling.expires_at !== null && sibling.expires_at <= input.decidedAt
      const activityTerminal =
        !objective ||
        !base ||
        objective.state === "completed" ||
        objective.state === "interrupted" ||
        objective.state === "recovery_required" ||
        base.state !== "active"
      const decision = expired
        ? ("expired" as const)
        : activityTerminal
          ? ("interrupted" as const)
          : input.fanout === "always"
            ? ("approved_once" as const)
            : sibling.request_kind === "no_progress"
              ? ("interrupted" as const)
              : ("denied" as const)
      const idempotencyKey = `permission-fanout:${input.primaryRequestID}:${decision}:${sibling.request_id}`
      if (decision === "approved_once" && !objective)
        return yield* Effect.die(new Error("activity objective is missing: " + sibling.activity_id))
      if (decision === "approved_once" && sibling.request_kind === "tool" && objective?.state !== "active") continue
      if (decision === "approved_once" && sibling.request_kind === "no_progress" && objective?.state !== "needs_human")
        continue
      yield* tx
        .insert(SessionActivityPermissionDecisionTable)
        .values({
          decision_id: "permission-decision:" + sibling.request_id,
          request_id: sibling.request_id,
          idempotency_key: idempotencyKey,
          decision,
          actor_type: input.actorType,
          actor_id: input.actorID,
          scope: decision === "approved_once" ? "once" : sibling.requested_scope,
          authority_epoch: sibling.authority_epoch,
          decided_at: input.decidedAt,
          expires_at: null,
          feedback: null,
        })
        .run()
      const settled = yield* tx
        .update(SessionActivityPermissionRequestTable)
        .set({ state: decision, decided_at: input.decidedAt })
        .where(
          and(
            eq(SessionActivityPermissionRequestTable.request_id, sibling.request_id),
            eq(SessionActivityPermissionRequestTable.state, "pending"),
          ),
        )
        .returning({ requestID: SessionActivityPermissionRequestTable.request_id })
        .get()
      if (!settled)
        return yield* new ConflictError({ entity: sibling.request_id, expected: "pending", actual: "changed" })
      if (decision === "approved_once" && sibling.request_kind === "no_progress") {
        if (!objective) return yield* Effect.die(new Error("activity objective is missing: " + sibling.activity_id))
        const resumed = yield* tx
          .update(SessionActivityObjectiveTable)
          .set({
            version: objective.version + 1,
            state: "active",
            no_progress_count: 0,
            terminal_reason: null,
            updated_at: input.decidedAt,
            settled_at: null,
          })
          .where(
            and(
              eq(SessionActivityObjectiveTable.activity_kind, sibling.activity_kind),
              eq(SessionActivityObjectiveTable.activity_id, sibling.activity_id),
              eq(SessionActivityObjectiveTable.version, objective.version),
              eq(SessionActivityObjectiveTable.state, "needs_human"),
            ),
          )
          .returning({ activityID: SessionActivityObjectiveTable.activity_id })
          .get()
        if (!resumed)
          return yield* new ConflictError({
            entity: sibling.activity_id,
            expected: String(objective.version),
            actual: "changed",
          })
      }
      if (decision === "approved_once" && sibling.request_kind === "tool") continue
      if (decision === "approved_once") {
        yield* tx.insert(SessionActivityPermissionOnceConsumptionTable).values({
          request_id: sibling.request_id,
          consumer_id: `no-progress:${sibling.request_id}`,
          idempotency_key: `permission-consumption:${sibling.request_id}`,
          consumed_at: input.decidedAt,
        })
        continue
      }
      if (decision !== "interrupted" || activityTerminal || sibling.request_kind === "tool") continue
      const terminalReason = "permission_interrupted"
      const interrupted =
        sibling.activity_kind === "legacy"
          ? yield* tx.get<{ activity_id: string }>(sql`
              UPDATE session_legacy_activity
              SET state = 'interrupted', terminal_reason = ${terminalReason}, settled_at = ${input.decidedAt}
              WHERE activity_id = ${sibling.activity_id} AND state = 'active'
              RETURNING activity_id
            `)
          : sibling.activity_kind === "facade"
            ? // FEAT-011 T2 — facade interruption mirrors the v2 branch (CAS on active).
              yield* tx
                .update(SessionFacadeActivityTable)
                .set({ state: "interrupted", reason_code: terminalReason, settled_at: input.decidedAt })
                .where(
                  and(
                    eq(SessionFacadeActivityTable.activity_id, sibling.activity_id),
                    eq(SessionFacadeActivityTable.state, "active"),
                  ),
                )
                .returning({ activityID: SessionFacadeActivityTable.activity_id })
                .get()
            : yield* tx
                .update(SessionActivityTable)
                .set({ state: "interrupted", settled_at: input.decidedAt })
                .where(
                  and(
                    eq(SessionActivityTable.activity_id, sibling.activity_id),
                    eq(SessionActivityTable.state, "active"),
                  ),
                )
                .returning({ activityID: SessionActivityTable.activity_id })
                .get()
      if (!interrupted)
        return yield* new ConflictError({
          entity: sibling.activity_id,
          expected: "active base activity",
          actual: "changed",
        })
      const objectiveSettled = yield* tx
        .update(SessionActivityObjectiveTable)
        .set({
          version: objective.version + 1,
          state: "interrupted",
          terminal_reason: terminalReason,
          updated_at: input.decidedAt,
          settled_at: input.decidedAt,
        })
        .where(
          and(
            eq(SessionActivityObjectiveTable.activity_kind, sibling.activity_kind),
            eq(SessionActivityObjectiveTable.activity_id, sibling.activity_id),
            eq(SessionActivityObjectiveTable.version, objective.version),
            eq(SessionActivityObjectiveTable.state, "needs_human"),
          ),
        )
        .returning({ activityID: SessionActivityObjectiveTable.activity_id })
        .get()
      if (!objectiveSettled)
        return yield* new ConflictError({
          entity: sibling.activity_id,
          expected: String(objective.version),
          actual: "changed",
        })
    }
  })
}

function permissionDecision(row: typeof SessionActivityPermissionDecisionTable.$inferSelect) {
  return {
    decisionID: row.decision_id,
    requestID: row.request_id,
    decision: row.decision,
    actorType: row.actor_type,
    actorID: row.actor_id,
    scope: row.scope,
    authorityEpoch: row.authority_epoch,
    decidedAt: row.decided_at,
    ...(row.feedback !== null ? { feedback: row.feedback } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
  }
}

function fingerprint(value: unknown) {
  return Hash.sha256(CanonicalJson.stringify(value))
}
