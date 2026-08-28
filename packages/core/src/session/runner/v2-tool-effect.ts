export * as V2ToolEffect from "./v2-tool-effect"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../../database/database"
import { Identifier } from "../../id/id"
import { V2ToolEffectTable } from "./v2-tool-effect.sql"

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

export interface Interface {
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    const record: Interface["record"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* db
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
        yield* db
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

    const listForSession: Interface["listForSession"] = (sessionId) =>
      db
        .select()
        .from(V2ToolEffectTable)
        .where(eq(V2ToolEffectTable.session_id, sessionId))
        .all()
        .pipe(Effect.map((rows) => rows.map(fromRow)), Effect.orDie)

    return { record, listForSession }
  }),
)
