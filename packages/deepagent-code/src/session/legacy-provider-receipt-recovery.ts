import { Effect } from "effect"
import { and, eq, gt, inArray, isNull, notExists, notInArray, or } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { NamedError } from "@deepagent-code/core/util/error"
import { Session } from "./session"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { SessionProviderAttempt } from "@deepagent-code/core/context-federation/provider-attempt"
import {
  SessionContextSelectionTable,
  SessionProviderAttemptTable,
  SessionProviderOwnerLeaseTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { SessionToolRequestReceiptTable } from "./tool-request-receipt.sql"
import { SessionToolRequestResolutionTable, SessionHistoryStateTable } from "@deepagent-code/core/session/sql"
import { SessionPromptEpochTable } from "./prompt-epoch.sql"
import { CompactionRunTable } from "./compaction-sql"
import { SessionID } from "./schema"

// v2w-l2 prompt monolith teardown: the legacy provider-receipt crash-recovery sweeps moved here
// VERBATIM from session/prompt.ts. Production caller census at extraction time: NONE — the only
// production caller was the legacy layer-build startup path behind `!flags.coreV2Only`, which is
// unreachable (RuntimeFlags hard-wires coreV2Only=true) and was deleted with the monolith. The
// functions remain because they are the documented classification authority for LEGACY receipt
// rows a pre-migration database can still contain, and the incident-regression /
// provider-receipt-recovery / legacy-provider-resolution suites drive them directly as the
// recovery-machinery oracle and fixture.

export const recoverProviderReceiptsOnStartup = Effect.fn("SessionPrompt.recoverProviderReceiptsOnStartup")(
  function* (input: { readonly ownerToken: string; readonly now?: number }) {
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const recovered = yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const observedAt = yield* SessionProviderOwner.observedAtInTransaction(tx)
            const staleOwner = or(
              isNull(SessionToolRequestReceiptTable.owner_token),
              notExists(
                tx
                  .select({ ownerToken: SessionProviderOwnerLeaseTable.owner_token })
                  .from(SessionProviderOwnerLeaseTable)
                  .where(
                    and(
                      eq(SessionProviderOwnerLeaseTable.owner_token, SessionToolRequestReceiptTable.owner_token),
                      isNull(SessionProviderOwnerLeaseTable.released_at),
                      gt(SessionProviderOwnerLeaseTable.lease_expires_at, observedAt),
                    ),
                  ),
              ),
            )
            const recoveryOwner = yield* tx
              .select({ ownerToken: SessionProviderOwnerLeaseTable.owner_token })
              .from(SessionProviderOwnerLeaseTable)
              .where(
                and(
                  eq(SessionProviderOwnerLeaseTable.owner_token, input.ownerToken),
                  isNull(SessionProviderOwnerLeaseTable.released_at),
                  gt(SessionProviderOwnerLeaseTable.lease_expires_at, observedAt),
                ),
              )
              .get()
            if (!recoveryOwner) return yield* Effect.die(new Error("provider recovery owner lease is not live"))
            const exactProviderAttemptBinding = and(
              eq(SessionProviderAttemptTable.session_id, SessionToolRequestReceiptTable.session_id),
              or(
                and(
                  isNull(SessionProviderAttemptTable.owner_token),
                  isNull(SessionToolRequestReceiptTable.owner_token),
                ),
                eq(SessionProviderAttemptTable.owner_token, SessionToolRequestReceiptTable.owner_token),
              ),
              eq(SessionProviderAttemptTable.selection_id, SessionToolRequestReceiptTable.context_selection_id),
              eq(SessionProviderAttemptTable.activity_id, SessionContextSelectionTable.activity_id),
              eq(SessionProviderAttemptTable.session_id, SessionContextSelectionTable.session_id),
              eq(SessionProviderAttemptTable.projection_hash, SessionContextSelectionTable.projection_hash),
              eq(SessionProviderAttemptTable.provider_id, SessionToolRequestReceiptTable.provider_id),
              eq(SessionProviderAttemptTable.request_hash, SessionToolRequestReceiptTable.request_input_hash),
              or(
                and(
                  isNull(SessionProviderAttemptTable.prepared_turn_hash),
                  isNull(SessionProviderAttemptTable.wire_request_hash),
                ),
                and(
                  eq(SessionProviderAttemptTable.prepared_turn_hash, SessionToolRequestReceiptTable.prepared_turn_hash),
                  eq(SessionProviderAttemptTable.wire_request_hash, SessionToolRequestReceiptTable.wire_request_hash),
                ),
              ),
            )
            const lostUndispatchedReceipts = yield* tx
              .select({
                receiptID: SessionToolRequestReceiptTable.receipt_id,
                sessionID: SessionToolRequestReceiptTable.session_id,
                assistantMessageID: SessionToolRequestReceiptTable.assistant_message_id,
                providerAttemptID: SessionToolRequestReceiptTable.provider_attempt_id,
              })
              .from(SessionToolRequestReceiptTable)
              .where(
                and(
                  inArray(SessionToolRequestReceiptTable.provider_state, ["preparing", "prepared"] as const),
                  staleOwner,
                ),
              )
              .all()
            const lostStartedReceipts = yield* tx
              .select({
                receiptID: SessionToolRequestReceiptTable.receipt_id,
                sessionID: SessionToolRequestReceiptTable.session_id,
                assistantMessageID: SessionToolRequestReceiptTable.assistant_message_id,
                providerAttemptID: SessionToolRequestReceiptTable.provider_attempt_id,
              })
              .from(SessionToolRequestReceiptTable)
              .leftJoin(
                SessionToolRequestResolutionTable,
                eq(SessionToolRequestResolutionTable.receipt_id, SessionToolRequestReceiptTable.receipt_id),
              )
              .where(
                and(
                  inArray(SessionToolRequestReceiptTable.provider_state, ["dispatching", "streaming"] as const),
                  staleOwner,
                  isNull(SessionToolRequestResolutionTable.resolution_id),
                ),
              )
              .all()
            const exactProviderAttemptReceipts = yield* tx
              .select({
                receiptID: SessionToolRequestReceiptTable.receipt_id,
                sessionID: SessionToolRequestReceiptTable.session_id,
                assistantMessageID: SessionToolRequestReceiptTable.assistant_message_id,
                providerState: SessionToolRequestReceiptTable.provider_state,
                providerAttemptID: SessionToolRequestReceiptTable.provider_attempt_id,
                attemptID: SessionProviderAttemptTable.attempt_id,
                attemptState: SessionProviderAttemptTable.state,
                ownerToken: SessionProviderAttemptTable.owner_token,
              })
              .from(SessionToolRequestReceiptTable)
              .innerJoin(
                SessionProviderAttemptTable,
                eq(SessionProviderAttemptTable.attempt_id, SessionToolRequestReceiptTable.provider_attempt_id),
              )
              .innerJoin(
                SessionContextSelectionTable,
                eq(SessionContextSelectionTable.selection_id, SessionProviderAttemptTable.selection_id),
              )
              .where(
                and(
                  inArray(SessionToolRequestReceiptTable.provider_state, [
                    "preparing",
                    "prepared",
                    "dispatching",
                    "streaming",
                  ] as const),
                  staleOwner,
                  exactProviderAttemptBinding,
                ),
              )
              .all()
            const exactProviderAttemptReceiptIDs = new Set(
              exactProviderAttemptReceipts.map((receipt) => receipt.receiptID),
            )
            const providerAttemptIdentityMismatches = [...lostUndispatchedReceipts, ...lostStartedReceipts].filter(
              (receipt) => receipt.providerAttemptID !== null && !exactProviderAttemptReceiptIDs.has(receipt.receiptID),
            )
            const crossStateStartedReceipts = exactProviderAttemptReceipts.filter(
              (receipt) =>
                (receipt.providerState === "preparing" || receipt.providerState === "prepared") &&
                receipt.attemptState !== "prepared",
            )
            const physicalStartedReceipts = [...lostStartedReceipts, ...crossStateStartedReceipts].filter(
              (receipt, index, receipts) =>
                receipts.findIndex((other) => other.receiptID === receipt.receiptID) === index,
            )
            const terminalAttemptReceiptMismatches = exactProviderAttemptReceipts.filter(
              (receipt) => receipt.attemptState === "settled" || receipt.attemptState === "failed",
            )
            const unresolvedContinuationReceipts = yield* tx
              .select({
                receiptID: SessionToolRequestReceiptTable.receipt_id,
                sessionID: SessionToolRequestReceiptTable.session_id,
                assistantMessageID: SessionToolRequestReceiptTable.assistant_message_id,
              })
              .from(CompactionRunTable)
              .innerJoin(
                SessionToolRequestReceiptTable,
                eq(SessionToolRequestReceiptTable.receipt_id, CompactionRunTable.continuation_receipt_id),
              )
              .where(
                and(
                  eq(CompactionRunTable.state, "committed"),
                  eq(CompactionRunTable.continuation_state, "indeterminate"),
                  isNull(SessionToolRequestReceiptTable.response_fingerprint),
                ),
              )
              .all()
            const unresolvedContinuationSessions = yield* tx
              .select({ sessionID: CompactionRunTable.session_id })
              .from(CompactionRunTable)
              .where(
                and(
                  eq(CompactionRunTable.state, "committed"),
                  eq(CompactionRunTable.continuation_state, "indeterminate"),
                ),
              )
              .all()
            const retryableUndispatchedReceiptIDs = lostUndispatchedReceipts
              .filter(
                (receipt) =>
                  receipt.providerAttemptID === null ||
                  exactProviderAttemptReceipts.some(
                    (exact) => exact.receiptID === receipt.receiptID && exact.attemptState === "prepared",
                  ),
              )
              .map((receipt) => receipt.receiptID)
            const recoverableStartedReceiptIDs = physicalStartedReceipts
              .filter(
                (receipt) =>
                  receipt.providerAttemptID === null || exactProviderAttemptReceiptIDs.has(receipt.receiptID),
              )
              .map((receipt) => receipt.receiptID)
            const startedProviderAttemptIDs = exactProviderAttemptReceipts.filter(
              (receipt) =>
                (receipt.providerState === "dispatching" ||
                  receipt.providerState === "streaming" ||
                  receipt.attemptState === "dispatching" ||
                  receipt.attemptState === "streaming") &&
                ["prepared", "dispatching", "streaming"].includes(receipt.attemptState),
            )
            const undispatchedProviderAttemptIDs = exactProviderAttemptReceipts.filter(
              (receipt) =>
                (receipt.providerState === "preparing" || receipt.providerState === "prepared") &&
                receipt.attemptState === "prepared",
            )
            const orphanProviderAttempts = yield* tx
              .select({
                sessionID: SessionProviderAttemptTable.session_id,
                attemptID: SessionProviderAttemptTable.attempt_id,
                ownerToken: SessionProviderAttemptTable.owner_token,
              })
              .from(SessionProviderAttemptTable)
              .where(
                and(
                  eq(SessionProviderAttemptTable.state, "prepared"),
                  or(
                    isNull(SessionProviderAttemptTable.owner_token),
                    notExists(
                      tx
                        .select({ ownerToken: SessionProviderOwnerLeaseTable.owner_token })
                        .from(SessionProviderOwnerLeaseTable)
                        .where(
                          and(
                            eq(SessionProviderOwnerLeaseTable.owner_token, SessionProviderAttemptTable.owner_token),
                            isNull(SessionProviderOwnerLeaseTable.released_at),
                            gt(SessionProviderOwnerLeaseTable.lease_expires_at, observedAt),
                          ),
                        ),
                    ),
                  ),
                  notExists(
                    tx
                      .select({ receiptID: SessionToolRequestReceiptTable.receipt_id })
                      .from(SessionToolRequestReceiptTable)
                      .where(
                        eq(SessionToolRequestReceiptTable.provider_attempt_id, SessionProviderAttemptTable.attempt_id),
                      ),
                  ),
                ),
              )
              .all()
            if (retryableUndispatchedReceiptIDs.length > 0)
              yield* tx
                .update(CompactionRunTable)
                .set({
                  continuation_state: "pending",
                  continuation_receipt_id: null,
                  continuation_admitted_at: null,
                  continuation_dispatching_at: null,
                  continuation_terminal_at: null,
                  continuation_error_code: "provider_not_dispatched_before_process_restart",
                  continuation_wakeup_at: null,
                })
                .where(
                  and(
                    eq(CompactionRunTable.state, "committed"),
                    eq(CompactionRunTable.continuation_state, "admitted"),
                    inArray(CompactionRunTable.continuation_receipt_id, retryableUndispatchedReceiptIDs),
                  ),
                )
                .run()
            if (crossStateStartedReceipts.length > 0)
              yield* tx
                .update(CompactionRunTable)
                .set({
                  continuation_state: "dispatching",
                  continuation_dispatching_at: now,
                  continuation_error_code: "provider_attempt_started_before_receipt_state_recovery",
                })
                .where(
                  and(
                    eq(CompactionRunTable.state, "committed"),
                    eq(CompactionRunTable.continuation_state, "admitted"),
                    inArray(
                      CompactionRunTable.continuation_receipt_id,
                      crossStateStartedReceipts.map((receipt) => receipt.receiptID),
                    ),
                  ),
                )
                .run()
            const recoveryGroups = [
              ...undispatchedProviderAttemptIDs.map((attempt) => ({ ...attempt, kind: "undispatched" as const })),
              ...startedProviderAttemptIDs.map((attempt) => ({ ...attempt, kind: "started" as const })),
              ...orphanProviderAttempts.map((attempt) => ({ ...attempt, kind: "undispatched" as const })),
            ].reduce(
              (groups, attempt) => {
                const key = JSON.stringify([attempt.sessionID, attempt.ownerToken])
                const current = groups.get(key) ?? {
                  sessionID: attempt.sessionID,
                  ownerToken: attempt.ownerToken,
                  undispatchedAttemptIDs: [] as string[],
                  startedAttemptIDs: [] as string[],
                }
                current[attempt.kind === "started" ? "startedAttemptIDs" : "undispatchedAttemptIDs"].push(
                  attempt.attemptID,
                )
                groups.set(key, current)
                return groups
              },
              new Map<
                string,
                {
                  sessionID: string
                  ownerToken: string | null
                  undispatchedAttemptIDs: string[]
                  startedAttemptIDs: string[]
                }
              >(),
            )
            yield* Effect.forEach(
              recoveryGroups.values(),
              (group) =>
                SessionProviderAttempt.recoverExactInTransaction(tx, {
                  sessionId: SessionID.make(group.sessionID),
                  staleOwnerToken: group.ownerToken,
                  recoveryOwnerToken: input.ownerToken,
                  undispatchedAttemptIds: group.undispatchedAttemptIDs,
                  startedAttemptIds: group.startedAttemptIDs,
                  now,
                }),
              { discard: true },
            )
            if (recoverableStartedReceiptIDs.length > 0)
              yield* tx
                .update(CompactionRunTable)
                .set({
                  continuation_state: "indeterminate",
                  continuation_terminal_at: now,
                  continuation_error_code: "provider_started_outcome_unknown_after_process_restart",
                })
                .where(
                  and(
                    eq(CompactionRunTable.state, "committed"),
                    eq(CompactionRunTable.continuation_state, "dispatching"),
                    inArray(CompactionRunTable.continuation_receipt_id, recoverableStartedReceiptIDs),
                  ),
                )
                .run()
            yield* tx
              .update(SessionToolRequestReceiptTable)
              .set({
                provider_state: "indeterminate_after_crash",
                terminal_at: now,
                request_error_code: "provider_started_outcome_unknown_after_process_restart",
              })
              .where(
                and(
                  inArray(SessionToolRequestReceiptTable.provider_state, ["dispatching", "streaming"] as const),
                  staleOwner,
                  notInArray(
                    SessionToolRequestReceiptTable.receipt_id,
                    tx
                      .select({ receiptID: SessionToolRequestResolutionTable.receipt_id })
                      .from(SessionToolRequestResolutionTable),
                  ),
                ),
              )
              .run()
            if (crossStateStartedReceipts.length > 0)
              yield* tx
                .update(SessionToolRequestReceiptTable)
                .set({
                  provider_state: "indeterminate_after_crash",
                  terminal_at: now,
                  request_error_code: "provider_started_outcome_unknown_after_process_restart",
                })
                .where(
                  inArray(
                    SessionToolRequestReceiptTable.receipt_id,
                    crossStateStartedReceipts.map((receipt) => receipt.receiptID),
                  ),
                )
                .run()
            if (terminalAttemptReceiptMismatches.length > 0)
              yield* tx
                .update(SessionToolRequestReceiptTable)
                .set({ request_error_code: "terminal_attempt_receipt_mismatch_after_process_restart" })
                .where(
                  inArray(
                    SessionToolRequestReceiptTable.receipt_id,
                    terminalAttemptReceiptMismatches.map((receipt) => receipt.receiptID),
                  ),
                )
                .run()
            yield* tx
              .update(SessionToolRequestReceiptTable)
              .set({
                provider_state: "failed",
                terminal_at: now,
                request_error_code: "provider_not_dispatched_before_process_restart",
              })
              .where(
                and(
                  inArray(SessionToolRequestReceiptTable.provider_state, ["preparing", "prepared"] as const),
                  staleOwner,
                ),
              )
              .run()
            if (providerAttemptIdentityMismatches.length > 0)
              yield* tx
                .update(SessionToolRequestReceiptTable)
                .set({ request_error_code: "provider_attempt_identity_mismatch_after_process_restart" })
                .where(
                  inArray(
                    SessionToolRequestReceiptTable.receipt_id,
                    providerAttemptIdentityMismatches.map((receipt) => receipt.receiptID),
                  ),
                )
                .run()
            yield* Effect.forEach(
              [
                ...new Set([
                  ...lostStartedReceipts.map((receipt) => receipt.sessionID),
                  ...crossStateStartedReceipts.map((receipt) => receipt.sessionID),
                  ...providerAttemptIdentityMismatches.map((receipt) => receipt.sessionID),
                  ...unresolvedContinuationSessions.map((continuation) => continuation.sessionID),
                ]),
              ],
              (sessionID) =>
                Effect.gen(function* () {
                  const reason = "provider outcome is unknown after process restart"
                  yield* tx
                    .update(SessionPromptEpochTable)
                    .set({ authority_state: "recovery_required", recovery_reason: reason })
                    .where(
                      and(
                        eq(SessionPromptEpochTable.session_id, sessionID),
                        eq(SessionPromptEpochTable.state, "active"),
                      ),
                    )
                    .run()
                  yield* tx
                    .insert(SessionHistoryStateTable)
                    .values([
                      {
                        session_id: SessionID.make(sessionID),
                        state: "recovery_required",
                        reason,
                        time_created: now,
                        time_updated: now,
                      },
                    ])
                    .onConflictDoUpdate({
                      target: SessionHistoryStateTable.session_id,
                      set: { state: "recovery_required", reason, time_updated: now },
                    })
                    .run()
                }),
              { discard: true },
            )
            return {
              lostUndispatchedReceipts,
              lostStartedReceipts: physicalStartedReceipts,
              providerAttemptIdentityMismatches,
              unresolvedContinuationReceipts,
            }
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      [
        ...recovered.lostUndispatchedReceipts,
        ...recovered.lostStartedReceipts,
        ...recovered.unresolvedContinuationReceipts,
      ],
      (receipt) =>
        Effect.gen(function* () {
          if (!receipt.assistantMessageID) return
          const messages = yield* sessions.messages({ sessionID: SessionID.make(receipt.sessionID) }).pipe(Effect.orDie)
          const assistant = messages.find(
            (message) => message.info.id === receipt.assistantMessageID && message.info.role === "assistant",
          )
          if (!assistant || assistant.info.role !== "assistant" || assistant.info.time.completed) return
          yield* sessions.updateMessage({
            ...assistant.info,
            finish: "error",
            error: new NamedError.Unknown({
              message: recovered.providerAttemptIdentityMismatches.some(
                (mismatch) => mismatch.receiptID === receipt.receiptID,
              )
                ? `Provider request ${receipt.receiptID} has an inconsistent durable attempt binding; explicit recovery is required.`
                : recovered.lostStartedReceipts.some((started) => started.receiptID === receipt.receiptID) ||
                    recovered.unresolvedContinuationReceipts.some(
                      (unresolved) => unresolved.receiptID === receipt.receiptID,
                    )
                  ? `Provider request ${receipt.receiptID} may have been dispatched before restart; explicit recovery is required.`
                  : `Provider request ${receipt.receiptID} was not dispatched before restart; the durable continuation will be retried.`,
            }).toObject(),
            time: { ...assistant.info.time, completed: Date.now() },
          })
        }),
      { discard: true },
    )
  },
)

export const rejectUndispatchedProviderTurn = Effect.fn("SessionPrompt.rejectUndispatchedProviderTurn")(
  function* (input: {
    readonly receiptID: string
    readonly ownerToken: string
    readonly providerAttemptID?: string
    readonly errorCode: string
    readonly now?: number
  }) {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const observedAt = yield* SessionProviderOwner.observedAtInTransaction(tx)
            const owner = yield* tx
              .select({ ownerToken: SessionProviderOwnerLeaseTable.owner_token })
              .from(SessionProviderOwnerLeaseTable)
              .where(
                and(
                  eq(SessionProviderOwnerLeaseTable.owner_token, input.ownerToken),
                  isNull(SessionProviderOwnerLeaseTable.released_at),
                  gt(SessionProviderOwnerLeaseTable.lease_expires_at, observedAt),
                ),
              )
              .get()
            if (!owner) return yield* Effect.die(new Error("provider owner lease is not live"))
            yield* tx
              .update(CompactionRunTable)
              .set({
                continuation_state: "pending",
                continuation_receipt_id: null,
                continuation_admitted_at: null,
                continuation_dispatching_at: null,
                continuation_terminal_at: null,
                continuation_error_code: input.errorCode,
                continuation_wakeup_at: null,
              })
              .where(
                and(
                  eq(CompactionRunTable.continuation_receipt_id, input.receiptID),
                  eq(CompactionRunTable.continuation_state, "admitted"),
                ),
              )
              .run()
            const receipt = yield* tx
              .update(SessionToolRequestReceiptTable)
              .set({
                provider_state: "failed",
                request_state: "rejected",
                terminal_at: now,
                request_error_code: input.errorCode,
              })
              .where(
                and(
                  eq(SessionToolRequestReceiptTable.receipt_id, input.receiptID),
                  eq(SessionToolRequestReceiptTable.owner_token, input.ownerToken),
                  inArray(SessionToolRequestReceiptTable.provider_state, ["preparing", "prepared"] as const),
                ),
              )
              .returning({
                receiptID: SessionToolRequestReceiptTable.receipt_id,
                providerAttemptID: SessionToolRequestReceiptTable.provider_attempt_id,
              })
              .get()
            if (!receipt)
              return yield* Effect.die(new Error(`provider receipt is not undispatched: ${input.receiptID}`))
            if ((receipt.providerAttemptID ?? undefined) !== input.providerAttemptID)
              return yield* Effect.die(new Error(`provider receipt attempt binding mismatch: ${input.receiptID}`))

            if (input.providerAttemptID) {
              yield* SessionProviderAttempt.transitionInTransaction(tx, {
                attemptId: input.providerAttemptID,
                expectedOwnerToken: input.ownerToken,
                from: ["prepared"],
                to: "failed",
                now,
                errorCode: input.errorCode,
              })
            }
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  },
)

export * as LegacyProviderReceiptRecovery from "./legacy-provider-receipt-recovery"
