export * as V2ToolEffect from "./v2-tool-effect"

import { and, eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../../database/database"
import { Identifier } from "../../id/id"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "./v2-tool-effect.sql"

type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

export type ToolEffectGrant = {
  readonly receiptId: string
  readonly ownerId: string
  readonly state: "started" | "settled" | "unknown"
  readonly version: number
}

export type ToolEffect = {
  readonly effectId: string
  readonly sessionId: string
  readonly providerAttemptId: string
  readonly receiptId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly effectKind: "mutating" | "read_only"
  readonly state: "settled" | "failed"
  readonly outcomeHash: string
  readonly errorCode?: string
  readonly grant?: ToolEffectGrant
  readonly ownerToken: string
  readonly timeCreated: number
}

export type ToolEffectAdmission = {
  readonly admissionId: string
  readonly sessionId: string
  readonly providerAttemptId: string
  readonly receiptId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly effectKind: "mutating" | "read_only"
  readonly ownerToken: string
  readonly timeCreated: number
}

// Optional capability seam: compositions that wire the V2 permission capability provide a lookup
// from tool call to its permission effect grants, and recorded effects bind the first grant.
// Compositions without the capability leave effects grant-less; the insert guard keeps grant
// evidence all-or-nothing.
export const CurrentPermissionGrantLookup = Context.Reference<
  | ((input: { readonly sessionID: string; readonly toolCallID: string; readonly toolName: string }) => Effect.Effect<
      readonly { readonly receiptID: string; readonly ownerID: string; readonly state: "started" | "settled" | "unknown"; readonly version: number }[]
    >)
  | undefined
>("@deepagent-code/v2/ToolEffect/CurrentPermissionGrantLookup", { defaultValue: () => undefined })

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("V2ToolEffect.ConflictError", {
  reason: Schema.String,
}) {}

export class RecoveryRequiredError extends Schema.TaggedErrorClass<RecoveryRequiredError>()(
  "V2ToolEffect.RecoveryRequiredError",
  {
    sessionId: Schema.String,
    pending: Schema.Number,
  },
) {}

export interface Interface {
  readonly admit: (input: {
    readonly sessionId: string
    readonly providerAttemptId: string
    readonly receiptId: string
    readonly toolCallId: string
    readonly toolName: string
    readonly effectKind: "mutating" | "read_only"
    readonly ownerToken: string
    readonly now: number
  }) => Effect.Effect<ToolEffectAdmission, ConflictError>
  readonly record: (input: {
    readonly sessionId: string
    readonly providerAttemptId: string
    readonly receiptId: string
    readonly toolCallId: string
    readonly toolName: string
    readonly effectKind: "mutating" | "read_only"
    readonly state: "settled" | "failed"
    readonly outcomeHash: string
    readonly errorCode?: string
    readonly grant?: ToolEffectGrant
    readonly ownerToken: string
    readonly now: number
  }) => Effect.Effect<ToolEffect, ConflictError>
  readonly listAdmissionsForSession: (sessionId: string) => Effect.Effect<readonly ToolEffectAdmission[], never>
  readonly listPendingForSession: (sessionId: string) => Effect.Effect<readonly ToolEffectAdmission[], never>
  readonly listForSession: (sessionId: string) => Effect.Effect<readonly ToolEffect[], never>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/ToolEffect") {}

function fromRow(row: typeof V2ToolEffectTable.$inferSelect): ToolEffect {
  return {
    effectId: row.effect_id,
    sessionId: row.session_id,
    providerAttemptId: row.provider_attempt_id,
    receiptId: row.receipt_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    effectKind: row.effect_kind,
    state: row.state,
    outcomeHash: row.outcome_hash,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.grant_receipt_id === null || row.grant_owner_id === null || row.grant_state === null || row.grant_version === null
      ? {}
      : {
          grant: {
            receiptId: row.grant_receipt_id,
            ownerId: row.grant_owner_id,
            state: row.grant_state,
            version: row.grant_version,
          },
        }),
    ownerToken: row.owner_token,
    timeCreated: row.time_created,
  }
}

function admissionFromRow(row: typeof V2ToolEffectAdmissionTable.$inferSelect): ToolEffectAdmission {
  return {
    admissionId: row.admission_id,
    sessionId: row.session_id,
    providerAttemptId: row.provider_attempt_id,
    receiptId: row.receipt_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    effectKind: row.effect_kind,
    ownerToken: row.owner_token,
    timeCreated: row.time_created,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    const admitInTransaction = (tx: Transaction, input: Parameters<Interface["admit"]>[0]) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(V2ToolEffectAdmissionTable)
          .where(
            and(
              eq(V2ToolEffectAdmissionTable.receipt_id, input.receiptId),
              eq(V2ToolEffectAdmissionTable.tool_call_id, input.toolCallId),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (existing) {
          if (
            existing.session_id !== input.sessionId ||
            existing.provider_attempt_id !== input.providerAttemptId ||
            existing.tool_name !== input.toolName ||
            existing.effect_kind !== input.effectKind ||
            existing.owner_token !== input.ownerToken
          )
            return yield* new ConflictError({ reason: "tool_effect_admission_divergence" })
          return admissionFromRow(existing)
        }
        const admission: ToolEffectAdmission = {
          admissionId: "admission_" + Identifier.ascending("tool"),
          sessionId: input.sessionId,
          providerAttemptId: input.providerAttemptId,
          receiptId: input.receiptId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          effectKind: input.effectKind,
          ownerToken: input.ownerToken,
          timeCreated: input.now,
        }
        yield* tx
          .insert(V2ToolEffectAdmissionTable)
          .values({
            admission_id: admission.admissionId,
            session_id: admission.sessionId,
            provider_attempt_id: admission.providerAttemptId,
            receipt_id: admission.receiptId,
            tool_call_id: admission.toolCallId,
            tool_name: admission.toolName,
            effect_kind: admission.effectKind,
            owner_token: admission.ownerToken,
            time_created: admission.timeCreated,
          })
          .run()
          .pipe(Effect.orDie)
        return admission
      })

    const admit: Interface["admit"] = (input) =>
      db.transaction((tx) => admitInTransaction(tx, input), { behavior: "immediate" }).pipe(
        Effect.catchIf((error) => !(error instanceof ConflictError), (error) => Effect.die(error)),
      )

    const recordInTransaction = (tx: Transaction, input: Parameters<Interface["record"]>[0]) =>
      Effect.gen(function* () {
        const admission = yield* tx
          .select()
          .from(V2ToolEffectAdmissionTable)
          .where(
            and(
              eq(V2ToolEffectAdmissionTable.receipt_id, input.receiptId),
              eq(V2ToolEffectAdmissionTable.tool_call_id, input.toolCallId),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!admission) return yield* new ConflictError({ reason: "tool_effect_admission_missing" })
        if (
          admission.session_id !== input.sessionId ||
          admission.provider_attempt_id !== input.providerAttemptId ||
          admission.tool_name !== input.toolName ||
          admission.effect_kind !== input.effectKind ||
          admission.owner_token !== input.ownerToken
        )
          return yield* new ConflictError({ reason: "tool_effect_admission_divergence" })
        const existing = yield* tx
          .select()
          .from(V2ToolEffectTable)
          .where(
            and(eq(V2ToolEffectTable.receipt_id, input.receiptId), eq(V2ToolEffectTable.tool_call_id, input.toolCallId)),
          )
          .get()
          .pipe(Effect.orDie)
        // Exact-retry convergence: re-settling the same call with the identical outcome returns
        // the recorded effect; any divergence is a conflict and never overwrites evidence.
        if (existing) {
          // A grant-less re-settlement converges on the recorded grant evidence: replay
          // determinism must not depend on a possibly unavailable grant lookup, and existing
          // durable evidence is never weakened. A present grant that diverges stays a conflict.
          const grantMatches =
            input.grant === undefined ||
            (existing.grant_receipt_id === input.grant.receiptId &&
              existing.grant_owner_id === input.grant.ownerId &&
              existing.grant_state === input.grant.state &&
              existing.grant_version === input.grant.version)
          if (
            existing.outcome_hash !== input.outcomeHash ||
            existing.state !== input.state ||
            existing.error_code !== (input.errorCode ?? null) ||
            existing.effect_kind !== input.effectKind ||
            existing.tool_name !== input.toolName ||
            !grantMatches
          )
            return yield* new ConflictError({ reason: "tool_effect_outcome_divergence" })
          return fromRow(existing)
        }
        const effect: ToolEffect = {
          effectId: Identifier.ascending("tool"),
          sessionId: input.sessionId,
          providerAttemptId: input.providerAttemptId,
          receiptId: input.receiptId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          effectKind: input.effectKind,
          state: input.state,
          outcomeHash: input.outcomeHash,
          ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
          ...(input.grant === undefined ? {} : { grant: input.grant }),
          ownerToken: input.ownerToken,
          timeCreated: input.now,
        }
        yield* tx
          .insert(V2ToolEffectTable)
          .values({
            effect_id: effect.effectId,
            session_id: effect.sessionId,
            provider_attempt_id: effect.providerAttemptId,
            receipt_id: effect.receiptId,
            tool_call_id: effect.toolCallId,
            tool_name: effect.toolName,
            effect_kind: effect.effectKind,
            state: effect.state,
            outcome_hash: effect.outcomeHash,
            error_code: effect.errorCode ?? null,
            grant_receipt_id: effect.grant?.receiptId ?? null,
            grant_owner_id: effect.grant?.ownerId ?? null,
            grant_state: effect.grant?.state ?? null,
            grant_version: effect.grant?.version ?? null,
            owner_token: effect.ownerToken,
            time_created: effect.timeCreated,
          })
          .run()
          .pipe(Effect.orDie)
        return effect
      })

    const record: Interface["record"] = (input) =>
      db.transaction((tx) => recordInTransaction(tx, input), { behavior: "immediate" }).pipe(
        Effect.catchIf((error) => !(error instanceof ConflictError), (error) => Effect.die(error)),
      )

    const listAdmissionsForSession: Interface["listAdmissionsForSession"] = (sessionId) =>
      db
        .select()
        .from(V2ToolEffectAdmissionTable)
        .where(eq(V2ToolEffectAdmissionTable.session_id, sessionId))
        .all()
        .pipe(Effect.map((rows) => rows.map(admissionFromRow)), Effect.orDie)

    const listPendingForSession: Interface["listPendingForSession"] = (sessionId) =>
      db
        .select({ admission: V2ToolEffectAdmissionTable })
        .from(V2ToolEffectAdmissionTable)
        .leftJoin(
          V2ToolEffectTable,
          and(
            eq(V2ToolEffectAdmissionTable.receipt_id, V2ToolEffectTable.receipt_id),
            eq(V2ToolEffectAdmissionTable.tool_call_id, V2ToolEffectTable.tool_call_id),
          ),
        )
        .where(and(eq(V2ToolEffectAdmissionTable.session_id, sessionId), isNull(V2ToolEffectTable.effect_id)))
        .all()
        .pipe(Effect.map((rows) => rows.map((row) => admissionFromRow(row.admission))), Effect.orDie)

    const listForSession: Interface["listForSession"] = (sessionId) =>
      db
        .select()
        .from(V2ToolEffectTable)
        .where(eq(V2ToolEffectTable.session_id, sessionId))
        .all()
        .pipe(Effect.map((rows) => rows.map(fromRow)), Effect.orDie)

    return { admit, record, listAdmissionsForSession, listPendingForSession, listForSession }
  }),
)
