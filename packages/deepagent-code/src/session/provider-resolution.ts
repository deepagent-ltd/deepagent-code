import { Database } from "@deepagent-code/core/database/database"
import { RecoveryCommandContract } from "@deepagent-code/core/contract/recovery-command"
import {
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { SessionProviderRecovery, SessionProviderRecoveryDurable } from "@deepagent-code/core/session/runner"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { SessionToolRequestResolutionCommandTable, SessionToolRequestResolutionTable } from "@deepagent-code/core/session/sql"
import { and, eq } from "drizzle-orm"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { SessionToolRequestReceiptTable } from "./tool-request-receipt.sql"
import { SessionLegacyProviderResolution } from "./legacy-provider-resolution"
import { Session } from "./session"
import { MessageID, SessionID } from "./schema"

// K-01 R-1/R-2 — the unified provider-resolution command facade.
//
// Two durable recovery authorities coexist: the legacy provider-receipt authority
// (session_tool_request_receipt + prompt-epoch successor state machine, resolved by
// SessionLegacyProviderResolution) and the Context Federation attempt authority
// (session_provider_attempt + the durable recovery store, applied in one transaction by
// applyExactAbandon/applyExactSettled — the same authority the recovery executor drains
// after a kill-9). Until now each authority had its own surface, and the V2-only runtime
// refused the legacy mutation routes outright — a crashed legacy receipt had NO exit.
//
// This facade is the ONE command entry: the vocabulary is the frozen contract's
// RecoveryCommand union (recover / abandon_exact / repair_baseline_and_abandon /
// fork_from_safe_boundary / confirm_settled / query_command — contract/recovery-command.ts),
// and routing is INTERNAL, by receipt source: a command naming a legacy receipt goes to the
// legacy authority; a command naming a federation attempt goes to the durable CF authority
// unless an unresolved legacy receipt owns that attempt (then the legacy authority does —
// its resolve bridges the attempt in its own transaction).
//
// Red lines (docs/v2.0.1-v2.0.2-core-design.md §4.3) hold by construction:
//   - post-dispatch ambiguity is NEVER auto-replayed — no facade path dispatches a provider
//     request or wakes an execution loop; `replayed` is not in the vocabulary;
//   - the legacy abandon is the legacy authority's append-only DB transaction — it never
//     invokes legacy execution, so it is safe under the V2-only runtime (R-2).

export const Authority = Schema.Literals(["legacy_provider_receipt", "context_federation_attempt"])
export type Authority = typeof Authority.Type

/** The legacy-receipt abandon binding — the authority block the legacy listing proves. */
export const LegacyReceiptBinding = SessionLegacyProviderResolution.Expected

const targetCommon = {
  sessionID: SessionID,
  /** The legacy provider receipt the command targets (the legacy authority's listing key). */
  receiptID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(Schema.optional),
  /** The Context Federation provider attempt the command targets. */
  attemptID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(Schema.optional),
}

export const RecoverCommandInput = Schema.Struct({
  ...targetCommon,
  commandKind: Schema.Literal("recover"),
  intent: Schema.Literal("inspect"),
})

export const AbandonExactCommandInput = Schema.Struct({
  ...targetCommon,
  commandKind: Schema.Literal("abandon_exact"),
  /** Legacy admission key (the legacy authority's command idempotency). */
  commandID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(Schema.optional),
  /** Required for the legacy-receipt route: the binding the legacy listing proved. */
  expected: Schema.optional(LegacyReceiptBinding),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).pipe(Schema.optional),
})

export const RepairBaselineCommandInput = Schema.Struct({
  ...targetCommon,
  commandKind: Schema.Literal("repair_baseline_and_abandon"),
})

export const ForkFromSafeBoundaryCommandInput = Schema.Struct({
  ...targetCommon,
  commandKind: Schema.Literal("fork_from_safe_boundary"),
  /** Legacy admission key for the fork intent (defaults to a receipt-derived id). */
  commandID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(Schema.optional),
})

export const ConfirmSettledCommandInput = Schema.Struct({
  ...targetCommon,
  commandKind: Schema.Literal("confirm_settled"),
  /** Typed external provider evidence (free text is refused by the frozen contract). */
  evidence: RecoveryCommandContract.RecoveryEvidence,
})

export const QueryCommandInput = Schema.Struct({
  ...targetCommon,
  commandKind: Schema.Literal("query_command"),
  /** The durable recovery command id, or the legacy resolution command id, to read. */
  commandRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})

/** The unified command vocabulary — one entry, the frozen contract's six kinds. */
export const CommandInput = Schema.Union([
  RecoverCommandInput,
  AbandonExactCommandInput,
  RepairBaselineCommandInput,
  ForkFromSafeBoundaryCommandInput,
  ConfirmSettledCommandInput,
  QueryCommandInput,
]).pipe(Schema.toTaggedUnion("commandKind"))
export type CommandInput = typeof CommandInput.Type

// ---------------------------------------------------------------------------
// Typed outcomes (per command kind; semantically unique, never overloaded)
// ---------------------------------------------------------------------------

export type AbandonExactOutcome =
  | {
    readonly commandKind: "abandon_exact"
    readonly authority: "legacy_provider_receipt"
    readonly resolution: typeof SessionLegacyProviderResolution.Resolution.Type
  }
  | {
    readonly commandKind: "abandon_exact"
    readonly authority: "context_federation_attempt"
    readonly commandID: string
    readonly commandState: "abandoned"
    readonly attemptState: "resolved_abandoned"
    readonly resolutionID: string
  }

export type ConfirmSettledOutcome = {
  readonly commandKind: "confirm_settled"
  readonly authority: "context_federation_attempt"
  readonly commandID: string
  readonly commandState: "settled"
  readonly attemptState: "resolved_settled"
  readonly resolutionID: string
  readonly evidenceDigest: string
}

export type ForkFromSafeBoundaryOutcome = {
  readonly commandKind: "fork_from_safe_boundary"
  readonly authority: "legacy_provider_receipt"
  readonly forkSessionID: string
  readonly forkCutoffMessageID: string
}

export type RecoverOutcome = {
  readonly commandKind: "recover"
  readonly legacyReceiptDescriptors: readonly (typeof SessionLegacyProviderResolution.Descriptor.Type)[]
  readonly federationAttemptDescriptors: readonly SessionProviderRecoveryDurable.DescriptorRow[]
}

export type QueryCommandOutcome =
  | {
    readonly commandKind: "query_command"
    readonly authority: "context_federation_attempt"
    readonly command: SessionProviderRecoveryDurable.CommandRow
  }
  | {
    readonly commandKind: "query_command"
    readonly authority: "legacy_provider_receipt"
    /** The legacy resolution the command produced (absent while it is still pending). */
    readonly resolution?: typeof SessionLegacyProviderResolution.Resolution.Type
  }

export type CommandOutcome =
  | AbandonExactOutcome
  | ConfirmSettledOutcome
  | ForkFromSafeBoundaryOutcome
  | RecoverOutcome
  | QueryCommandOutcome

// ---------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------

export class NotFound extends Data.TaggedError("SessionProviderResolution.NotFound")<{
  readonly reason: string
}> {}

export class Conflict extends Data.TaggedError("SessionProviderResolution.Conflict")<{
  readonly code:
    | "command_id_conflict"
    | "recovery_authority_conflict"
    | "recovery_command_hash_mismatch"
    | "recovery_exit_not_applied"
  readonly reason: string
}> {}

/** An exit this facade refuses honestly: unavailable on the owning authority (yet). */
export class Unsupported extends Data.TaggedError("SessionProviderResolution.Unsupported")<{
  readonly code:
    | "exit_requires_maintenance_authority"
    | "exit_not_available_on_authority"
    | "target_required"
    | "target_ambiguous"
    | "command_id_required"
    | "legacy_binding_required"
    | "legacy_receipt_bound_use_legacy_authority"
  readonly reason: string
}> {}

export type Error = NotFound | Conflict | Unsupported

export interface Interface {
  /**
   * The ONE command entry. The vocabulary is the frozen `RecoveryCommand` union; routing to
   * the owning authority is internal (by receipt source). Never dispatches a provider
   * request; never replays a post-dispatch outcome.
   */
  readonly execute: (
    input: CommandInput & { readonly actorID: string },
  ) => Effect.Effect<CommandOutcome, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionProviderResolution") {}

// ---------------------------------------------------------------------------
// Authority routing + the durable CF exit (mirrors the maintenance command authority)
// ---------------------------------------------------------------------------

type FederationAttemptAuthorityRow = {
  readonly attemptId: string
  readonly sessionId: string
  readonly activityId: string
  readonly attemptVersion: number
  readonly providerTurnSeq: number
  readonly selectionId: string
  readonly projectionHash: string
  readonly requestHash: string
  readonly preparedTurnHash: string | null
  readonly wireRequestHash: string | null
  readonly providerId: string
  readonly ownerToken: string | null
  readonly idempotencyKey: string | null
  readonly attemptState: string
  readonly receiptActivityId: string
  readonly receiptTurnSeq: number
  readonly receiptProviderId: string
  readonly receiptOwnerToken: string | null
  readonly receiptState: string
  readonly protocol: string
}

const service = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const legacyAuthority = yield* SessionLegacyProviderResolution.Service
  const sessions = yield* Session.Service
  const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)

  /** Route an attempt-targeted command: a bound unresolved legacy receipt owns the attempt. */
  const attemptAuthorityRoute = function* (sessionID: SessionID, attemptID: string) {
    const legacyReceipt = yield* db
      .select({ receiptID: SessionToolRequestReceiptTable.receipt_id })
      .from(SessionToolRequestReceiptTable)
      .where(
        and(
          eq(SessionToolRequestReceiptTable.session_id, sessionID),
          eq(SessionToolRequestReceiptTable.provider_attempt_id, attemptID),
          eq(SessionToolRequestReceiptTable.provider_state, "indeterminate_after_crash"),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    return legacyReceipt
      ? ({ authority: "legacy_provider_receipt", receiptID: legacyReceipt.receiptID } as const)
      : ({ authority: "context_federation_attempt" } as const)
  }

/** The durable resolution id the federation authority recorded for an attempt. */
  const federationResolutionID = (attemptID: string) =>
    Effect.map(
      db
        .select({ resolutionID: SessionProviderAttemptResolutionTable.resolution_id })
        .from(SessionProviderAttemptResolutionTable)
        .where(eq(SessionProviderAttemptResolutionTable.attempt_id, attemptID))
        .get()
        .pipe(Effect.orDie),
      (row) => row?.resolutionID ?? `unresolved:${attemptID}`,
    )

  /** Classify + record + apply ONE durable CF exit through the recovery-command authority. */
  const applyFederationExit = function* (input: {
    readonly sessionID: SessionID
    readonly attemptID: string
    readonly actorID: string
    readonly exit: "abandon_exact" | "confirm_settled"
    readonly evidence?: RecoveryCommandContract.RecoveryEvidence
  }) {
    const rows = yield* db
      .select({
        attemptId: SessionProviderAttemptTable.attempt_id,
        sessionId: SessionProviderAttemptTable.session_id,
        activityId: SessionProviderAttemptTable.activity_id,
        attemptVersion: SessionProviderAttemptTable.attempt_version,
        providerTurnSeq: SessionProviderAttemptTable.provider_turn_seq,
        selectionId: SessionProviderAttemptTable.selection_id,
        projectionHash: SessionProviderAttemptTable.projection_hash,
        requestHash: SessionProviderAttemptTable.request_hash,
        preparedTurnHash: SessionProviderAttemptTable.prepared_turn_hash,
        wireRequestHash: SessionProviderAttemptTable.wire_request_hash,
        providerId: SessionProviderAttemptTable.provider_id,
        ownerToken: SessionProviderAttemptTable.owner_token,
        idempotencyKey: SessionProviderAttemptTable.idempotency_key,
        attemptState: SessionProviderAttemptTable.state,
        receiptActivityId: V2ProviderTurnReceiptTable.activity_id,
        receiptTurnSeq: V2ProviderTurnReceiptTable.provider_turn_seq,
        receiptProviderId: V2ProviderTurnReceiptTable.provider_id,
        receiptOwnerToken: V2ProviderTurnReceiptTable.owner_token,
        receiptState: V2ProviderTurnReceiptTable.state,
        protocol: V2ProviderTurnReceiptTable.protocol,
      })
      .from(SessionProviderAttemptTable)
      .innerJoin(
        V2ProviderTurnReceiptTable,
        eq(V2ProviderTurnReceiptTable.provider_attempt_id, SessionProviderAttemptTable.attempt_id),
      )
      .where(
        and(
          eq(SessionProviderAttemptTable.session_id, input.sessionID),
          eq(SessionProviderAttemptTable.attempt_id, input.attemptID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    const attempt = rows as FederationAttemptAuthorityRow | undefined
    if (!attempt) return yield* new NotFound({ reason: `provider attempt was not found: ${input.attemptID}` })
    // Idempotent convergence FIRST: the attempt's command slot is the single-writer record.
    // A terminal slot for the SAME exit answers the retry with the applied outcome; a terminal
    // slot for the OTHER exit or a different request hash is a typed conflict (never clobbered).
    const expectedState = input.exit === "confirm_settled" ? "settled" : "abandoned"
    const otherTerminal = input.exit === "confirm_settled" ? "abandoned" : "settled"
    const slot = yield* store.getCommandForAttempt(input.sessionID, input.attemptID)
    if (slot && slot.requestHash !== attempt.requestHash)
      return yield* new Conflict({
        code: "recovery_command_hash_mismatch",
        reason: "the attempt's command slot holds a different request hash",
      })
    if (slot && slot.state === expectedState)
      return {
        commandID: slot.commandId,
        commandState: expectedState,
        resolutionID: yield* federationResolutionID(input.attemptID),
      }
    if (slot && slot.state === otherTerminal)
      return yield* new Conflict({
        code: "recovery_authority_conflict",
        reason: `the attempt's command slot already committed the ${slot.state} exit`,
      })
    if (
      attempt.attemptState !== "indeterminate_after_crash" ||
      attempt.receiptState !== "indeterminate_after_crash" ||
      attempt.ownerToken === null ||
      attempt.ownerToken !== attempt.receiptOwnerToken ||
      attempt.activityId !== attempt.receiptActivityId ||
      attempt.providerTurnSeq !== attempt.receiptTurnSeq ||
      attempt.providerId !== attempt.receiptProviderId
    )
      return yield* new Conflict({
        code: "recovery_authority_conflict",
        reason: `attempt/receipt authority is ${attempt.attemptState}/${attempt.receiptState}`,
      })
    // Network-unknown gate: a recorded settled terminal for this request hash means the
    // attempt may have produced a result — abandon is not offered (design §9.1).
    if (input.exit === "abandon_exact") {
      const terminals = yield* store.listDescriptorsByRequestHash(attempt.requestHash)
      if (
        terminals.some(
          (row) => row.payload.descriptorKind === "resolved" && row.payload.resolved.terminal === "settled",
        )
      )
        return yield* new Conflict({
          code: "recovery_authority_conflict",
          reason: "a settled terminal already exists for this request hash; use confirm_settled",
        })
    }
    const attemptIdentity = {
      sessionId: attempt.sessionId,
      activityId: attempt.activityId,
      attemptId: attempt.attemptId,
      providerTurnSeq: attempt.providerTurnSeq,
      selectionId: attempt.selectionId,
      projectionHash: attempt.projectionHash,
      requestHash: attempt.requestHash,
      providerId: attempt.providerId,
      protocol: attempt.protocol,
      ...(attempt.idempotencyKey === null ? {} : { idempotencyKey: attempt.idempotencyKey }),
    }
    const descriptor = SessionProviderRecovery.classify({
      attempt: attemptIdentity,
      attemptState: attempt.attemptState,
      expectedAttemptState: "indeterminate_after_crash",
      ownerToken: attempt.ownerToken,
      expectedVersion: attempt.attemptVersion,
      baseline: {
        state: "present",
        baselineHash: attempt.preparedTurnHash ?? undefined,
        verified: attempt.preparedTurnHash !== null,
      },
      historyVerified:
        attempt.preparedTurnHash !== null &&
        attempt.wireRequestHash !== null &&
        attempt.projectionHash.length > 0 &&
        attempt.selectionId.length > 0,
      providerLookupComplete: attempt.protocol.length > 0 && attempt.providerId.length > 0,
      placementUnresolved: false,
      permissionIncomplete: false,
      workspaceConflict: false,
    })
    const required = SessionProviderRecovery.requiredPermissionFor(descriptor.descriptorKind)
    yield* SessionProviderRecovery.assertPermission({ type: "user" }, required).pipe(
      Effect.mapError(() =>
        new Conflict({
          code: "recovery_authority_conflict",
          reason: `the ${descriptor.descriptorKind} exit requires ${required} permission`,
        }),
      ),
    )
    const commandID = SessionProviderRecovery.recoveryCommandContentAddress({
      requestHash: attempt.requestHash,
      attemptIdentity,
    })
    const recorded = yield* store.putDescriptorAndCommand({
      descriptor,
      sessionId: attempt.sessionId,
      activityId: attempt.activityId,
      turnId: String(attempt.providerTurnSeq),
      commandId: commandID,
      requestHash: attempt.requestHash,
      attemptIdentity,
      actorType: "user",
      actorId: input.actorID,
      expectedOwnerToken: attempt.ownerToken,
      ...(input.exit === "confirm_settled" && input.evidence
        ? { commandKind: "confirm_settled" as const, evidence: input.evidence }
        : {}),
    })
    if (recorded.status === "mismatch")
      return yield* new Conflict({
        code: "recovery_command_hash_mismatch",
        reason: "the attempt's command slot holds a different request hash",
      })
    const applied =
      input.exit === "confirm_settled"
        ? yield* store.applyExactSettled({ commandId: recorded.commandId })
        : yield* store.applyExactAbandon({ commandId: recorded.commandId, reason: "network_unknown" })
    if (applied === "authority_conflict")
      return yield* new Conflict({
        code: "recovery_authority_conflict",
        reason: "the durable recovery authority refused the exact command CAS",
      })
    if (applied === "evidence_rejected")
      return yield* new Conflict({
        code: "recovery_authority_conflict",
        reason: "the typed evidence failed the durable attempt binding",
      })
    // The durable authority row is the outcome of record (an `already` verdict means an
    // exact retry converged on the previously applied exit).
    const command = yield* store.getCommand(recorded.commandId)
    if (command?.state !== expectedState)
      return yield* new Conflict({ code: "recovery_exit_not_applied", reason: `apply verdict: ${applied}` })
    return {
      commandID: recorded.commandId,
      commandState: expectedState,
      resolutionID: yield* federationResolutionID(attempt.attemptId),
    }
  }

  const mapLegacyResolutionError = (error: SessionLegacyProviderResolution.NotFound | SessionLegacyProviderResolution.Conflict): Error =>
  error instanceof SessionLegacyProviderResolution.NotFound
    ? new NotFound({ reason: error.reason })
    : new Conflict({ code: "command_id_conflict", reason: error.reason })

/** The legacy resolution a legacy command id produced (the durable read-back). */
  const legacyResolutionForCommand = function* (sessionID: SessionID, commandRef: string) {
    const command = yield* db
      .select()
      .from(SessionToolRequestResolutionCommandTable)
      .where(
        and(
          eq(SessionToolRequestResolutionCommandTable.command_id, commandRef),
          eq(SessionToolRequestResolutionCommandTable.session_id, sessionID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!command) return yield* new NotFound({ reason: `recovery command ${commandRef} was not found for this session` })
    if (!command.result_resolution_id) return undefined
    const row = yield* db
      .select()
      .from(SessionToolRequestResolutionTable)
      .where(eq(SessionToolRequestResolutionTable.resolution_id, command.result_resolution_id))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return {
      resolutionID: row.resolution_id,
      commandID: command.command_id,
      receiptID: row.receipt_id,
      sessionID: row.session_id,
      decision: row.decision,
      sourcePromptEpoch: row.source_prompt_epoch,
      successorPromptEpoch: row.successor_prompt_epoch,
      sourceMutationEpoch: row.source_mutation_epoch,
      successorMutationEpoch: row.successor_mutation_epoch,
      ...(row.safe_end_message_id ? { safeEndMessageID: row.safe_end_message_id } : {}),
      safeHistoryHash: row.safe_history_hash,
      successorWindowID: row.successor_window_id,
      successorHistoryHash: row.successor_history_hash,
      createdAt: row.created_at,
    } satisfies typeof SessionLegacyProviderResolution.Resolution.Type
  }

  const execute: Interface["execute"] = Effect.fn("SessionProviderResolution.execute")(function* (
    input: CommandInput & { readonly actorID: string },
  ) {
    if (input.commandKind === "recover")
      return {
        commandKind: "recover" as const,
        legacyReceiptDescriptors: yield* legacyAuthority.describe(input.sessionID).pipe(
          Effect.mapError((error) => new NotFound({ reason: error.reason })),
        ),
        federationAttemptDescriptors: yield* store.listDescriptorsBySession(input.sessionID),
      }

    if (input.commandKind === "query_command") {
      const command = yield* store.getCommand(input.commandRef)
      if (command) {
        if (command.attempt.sessionId !== input.sessionID)
          return yield* new NotFound({ reason: `recovery command ${input.commandRef} was not found for this session` })
        return {
          commandKind: "query_command" as const,
          authority: "context_federation_attempt" as const,
          command,
        }
      }
      return {
        commandKind: "query_command" as const,
        authority: "legacy_provider_receipt" as const,
        resolution: yield* legacyResolutionForCommand(input.sessionID, input.commandRef),
      }
    }

    if (input.commandKind === "repair_baseline_and_abandon")
      return yield* new Unsupported({
        code: "exit_requires_maintenance_authority",
        reason:
          "baseline reconstruction stays a maintenance-authority exit; the recovery executor keeps it pending",
      })

    if (input.commandKind === "fork_from_safe_boundary") {
      if (!input.receiptID)
        return yield* new Unsupported({ code: "target_required", reason: "a legacy receipt id is required" })
      if (input.attemptID)
        return yield* new Unsupported({ code: "target_ambiguous", reason: "name either a receipt or an attempt, not both" })
      const receipt = yield* db
        .select()
        .from(SessionToolRequestReceiptTable)
        .where(
          and(
            eq(SessionToolRequestReceiptTable.receipt_id, input.receiptID),
            eq(SessionToolRequestReceiptTable.session_id, input.sessionID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!receipt) return yield* new NotFound({ reason: `provider receipt was not found: ${input.receiptID}` })
      // The cutoff-aware fork admission (session.ts) enforces the safe-boundary rule: a
      // cutoff at the receipt's user boundary or earlier is provable, anything past the
      // receipt's user turn fails closed. The facade never re-derives that proof.
      const forked = yield* sessions
        .fork({
          sessionID: input.sessionID,
          intentID: `recovery_fork_${input.commandID ?? receipt.receipt_id}`,
          messageID: MessageID.make(receipt.user_message_id),
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "NotFoundError"
              ? new NotFound({ reason: `session was not found: ${input.sessionID}` })
              : new Conflict({
                  code: "recovery_authority_conflict",
                  reason: "the cutoff-aware fork admission refused this boundary",
                }),
          ),
        )
      return {
        commandKind: "fork_from_safe_boundary" as const,
        authority: "legacy_provider_receipt" as const,
        forkSessionID: forked.id,
        forkCutoffMessageID: receipt.user_message_id,
      }
    }

    if (input.commandKind === "confirm_settled") {
      if (!input.attemptID)
        return yield* new Unsupported({ code: "target_required", reason: "a provider attempt id is required" })
      if (input.receiptID)
        return yield* new Unsupported({
          code: "legacy_receipt_bound_use_legacy_authority",
          reason: "legacy receipts support the abandoned exit only; settle is a federation-attempt exit",
        })
      try {
        RecoveryCommandContract.assertEvidenceTyped(input.evidence)
      } catch {
        return yield* new Unsupported({ code: "exit_not_available_on_authority", reason: "free text is never evidence" })
      }
      const applied = yield* applyFederationExit({
        sessionID: input.sessionID,
        attemptID: input.attemptID,
        actorID: input.actorID,
        exit: "confirm_settled",
        evidence: input.evidence,
      })
      return {
        commandKind: "confirm_settled" as const,
        authority: "context_federation_attempt" as const,
        commandID: applied.commandID,
        commandState: "settled" as const,
        attemptState: "resolved_settled" as const,
        resolutionID: applied.resolutionID,
        evidenceDigest: RecoveryCommandContract.recoveryEvidenceDigest(input.evidence),
      }
    }

    // abandon_exact — route by receipt source.
    if (!input.receiptID && !input.attemptID)
      return yield* new Unsupported({ code: "target_required", reason: "name a receipt or an attempt to abandon" })
    if (input.receiptID && input.attemptID)
      return yield* new Unsupported({ code: "target_ambiguous", reason: "name either a receipt or an attempt, not both" })
    if (input.receiptID) {
      if (!input.commandID)
        return yield* new Unsupported({
          code: "command_id_required",
          reason: "the legacy-receipt abandon requires the caller's command id",
        })
      if (!input.expected)
        return yield* new Unsupported({
          code: "legacy_binding_required",
          reason: "the legacy-receipt abandon requires the expected authority binding",
        })
      const resolution = yield* legacyAuthority.resolve({
        sessionID: input.sessionID,
        commandID: input.commandID,
        receiptID: input.receiptID,
        decision: "abandoned",
        expected: input.expected,
        actorID: input.actorID,
        ...(input.reason ? { reason: input.reason } : {}),
      }).pipe(Effect.mapError(mapLegacyResolutionError))
      return {
        commandKind: "abandon_exact" as const,
        authority: "legacy_provider_receipt" as const,
        resolution,
      }
    }
    const attemptID = input.attemptID!
    const route = yield* attemptAuthorityRoute(input.sessionID, attemptID)
    if (route.authority === "legacy_provider_receipt")
      return yield* new Unsupported({
        code: "legacy_receipt_bound_use_legacy_authority",
        reason: "an unresolved legacy receipt owns this attempt; resolve it through the legacy authority binding",
      })
    const applied = yield* applyFederationExit({
      sessionID: input.sessionID,
      attemptID,
      actorID: input.actorID,
      exit: "abandon_exact",
    })
    return {
      commandKind: "abandon_exact" as const,
      authority: "context_federation_attempt" as const,
      commandID: applied.commandID,
      commandState: "abandoned" as const,
      attemptState: "resolved_abandoned" as const,
      resolutionID: applied.resolutionID,
    }
  })

  return Service.of({ execute })
})

export const layer = Layer.effect(Service, service)
export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionLegacyProviderResolution.defaultLayer),
  Layer.provide(Session.defaultLayer),
)

export * as SessionProviderResolution from "./provider-resolution"
