import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { NonNegativeInt } from "@deepagent-code/core/schema"
import {
  SessionHistoryStateTable,
  SessionIntentTable,
  SessionPromptEpochMessageTable,
  SessionPromptEpochRecoveryTable,
  SessionSteerTable,
  SessionTable,
  SessionToolRequestResolutionCommandTable,
  SessionToolRequestResolutionTable,
  SessionWorldStateBaselineTable,
} from "@deepagent-code/core/session/sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { Cause, Context, Data, Effect, Exit, Layer, Option, Schema } from "effect"
import { SessionActivityProgressTable, SessionLegacyActivityTable } from "./activity-sql"
import { CompactionRunTable } from "./compaction-sql"
import { HistoryAuthority } from "./history-authority"
import { MessageV2 } from "./message-v2"
import { SessionPromptEpochTable } from "./prompt-epoch.sql"
import { MessageID, SessionID } from "./schema"
import { SessionToolRequestReceiptTable } from "./tool-request-receipt.sql"
import { EventV2Bridge } from "../event-v2-bridge"
import { WorldStateSlot } from "@deepagent-code/core/deepagent/context/world-state"
import {
  SessionActivityTable,
  SessionProviderAttemptRecoveryBridgeTable,
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
} from "@deepagent-code/core/context-federation/session-sql"
import {
  renderSessionWorldStateBaseline,
  sessionWorldStateBaselineHash,
  type SessionWorldStateBaselineSection,
} from "./context-ledger"

const REQUEST_VERSION = 1
const DEFAULT_REASON = "User chose to abandon the provider request whose outcome is unknown after process restart"

export const Expected = Schema.Struct({
  providerState: Schema.Literal("indeterminate_after_crash"),
  promptEpoch: NonNegativeInt,
  sessionMutationEpoch: NonNegativeInt,
  requestHash: Schema.String,
  historyHash: Schema.String,
  worldStateBaselineHash: Schema.String,
})

export const ResolveInput = Schema.Struct({
  sessionID: SessionID,
  commandID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  receiptID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  decision: Schema.Literal("abandoned"),
  expected: Expected,
  reason: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))),
  riskAcknowledged: Schema.optional(Schema.Boolean),
})

export const UnsupportedReason = Schema.Literals([
  "legacy_receipt_authority_incomplete",
  "source_prompt_epoch_missing",
  "source_prompt_epoch_not_recovery_required",
  "source_prompt_epoch_binding_mismatch",
  "provider_attempt_authority_incomplete",
  "provider_attempt_resolution_requires_reconciliation",
  "compaction_continuation_requires_maintenance",
  "workspace_recovery_requires_coordination",
  "source_world_state_baseline_missing",
  "source_world_state_baseline_invalid",
])

const DescriptorBase = {
  receiptID: Schema.String,
  sessionID: SessionID,
  providerID: Schema.String,
  modelID: Schema.String,
  providerState: Schema.Literal("indeterminate_after_crash"),
  sessionMutationEpoch: NonNegativeInt,
} as const

const ResolvableDescriptor = Schema.Struct({
  ...DescriptorBase,
  resolutionSupported: Schema.Literal(true),
  unsupportedReasons: Schema.Tuple([]),
  assistantMessageID: MessageID,
  promptEpoch: NonNegativeInt,
  promptWindowID: Schema.String,
  historyHash: Schema.String,
  requestHash: Schema.String,
  continuationRecoverySupported: Schema.Boolean,
  workspaceRecoverySupported: Schema.Boolean,
  sourceWorldStateBaselineStatus: Schema.Literal("available"),
  worldStateBaselineHash: Schema.String,
})

const MaintenanceDescriptor = Schema.Struct({
  ...DescriptorBase,
  resolutionSupported: Schema.Literal(false),
  unsupportedReasons: Schema.NonEmptyArray(UnsupportedReason),
  assistantMessageID: Schema.optional(MessageID),
  promptEpoch: Schema.optional(NonNegativeInt),
  promptWindowID: Schema.optional(Schema.String),
  historyHash: Schema.optional(Schema.String),
  requestHash: Schema.optional(Schema.String),
  continuationRecoverySupported: Schema.Boolean,
  workspaceRecoverySupported: Schema.Boolean,
  sourceWorldStateBaselineStatus: Schema.Literals(["available", "missing", "invalid"]),
  worldStateBaselineHash: Schema.optional(Schema.String),
})

export const Descriptor = Schema.Union([ResolvableDescriptor, MaintenanceDescriptor]).annotate({
  discriminator: "resolutionSupported",
  identifier: "SessionLegacyProviderResolution.Descriptor",
})

export const Resolution = Schema.Struct({
  resolutionID: Schema.String,
  commandID: Schema.String,
  receiptID: Schema.String,
  sessionID: SessionID,
  decision: Schema.Literal("abandoned"),
  sourcePromptEpoch: NonNegativeInt,
  successorPromptEpoch: NonNegativeInt,
  sourceMutationEpoch: NonNegativeInt,
  successorMutationEpoch: NonNegativeInt,
  safeEndMessageID: Schema.optional(MessageID),
  safeHistoryHash: Schema.String,
  successorWindowID: Schema.String,
  successorHistoryHash: Schema.String,
  createdAt: NonNegativeInt,
})

export const Event = {
  Completed: EventV2.define({
    type: "session.provider-resolution.completed",
    schema: {
      sessionID: SessionID,
      resolutionID: Schema.String,
      commandID: Schema.String,
      receiptID: Schema.String,
      decision: Schema.Literal("abandoned"),
      sourcePromptEpoch: NonNegativeInt,
      successorPromptEpoch: NonNegativeInt,
      sourceMutationEpoch: NonNegativeInt,
      successorMutationEpoch: NonNegativeInt,
      createdAt: NonNegativeInt,
    },
  }),
}

export class Conflict extends Data.TaggedError("SessionLegacyProviderResolution.Conflict")<{
  readonly code:
    | "command_id_conflict"
    | "receipt_already_resolved"
    | "continuation_recovery_not_supported"
    | "workspace_recovery_not_supported"
    | "source_world_state_baseline_missing"
    | "source_world_state_baseline_invalid"
    | "stale_recovery_state"
    | "stale_session_mutation"
    | "unsafe_history_boundary"
    | "decision_not_supported"
  readonly reason: string
}> {}

export class NotFound extends Data.TaggedError("SessionLegacyProviderResolution.NotFound")<{
  readonly reason: string
}> {}

export interface Interface {
  readonly describe: (sessionID: SessionID) => Effect.Effect<(typeof Descriptor.Type)[], NotFound>
  readonly resolve: (
    input: typeof ResolveInput.Type & { actorID: string },
  ) => Effect.Effect<typeof Resolution.Type, Conflict | NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionLegacyProviderResolution") {}

const requestHash = (input: typeof ResolveInput.Type) =>
  Hash.sha256(
    CanonicalJson.stringify({
      version: REQUEST_VERSION,
      sessionID: input.sessionID,
      commandID: input.commandID,
      receiptID: input.receiptID,
      decision: input.decision,
      expected: input.expected,
      reason: input.reason ?? DEFAULT_REASON,
      riskAcknowledged: input.riskAcknowledged ?? false,
    }),
  )

const resolutionID = (input: Pick<typeof ResolveInput.Type, "sessionID" | "receiptID" | "commandID">) =>
  `res_${Hash.sha256(`${input.sessionID}:${input.receiptID}:${input.commandID}`).slice(0, 40)}`

const fromResolution = (
  commandID: string,
  row: typeof SessionToolRequestResolutionTable.$inferSelect,
): typeof Resolution.Type => ({
  resolutionID: row.resolution_id,
  commandID,
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
})

const service = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service

  const describe: Interface["describe"] = Effect.fn("SessionLegacyProviderResolution.describe")(function* (sessionID) {
    const session = yield* db
      .select({ mutationEpoch: SessionTable.mutation_epoch, workspaceID: SessionTable.workspace_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session) return yield* new NotFound({ reason: "session was not found" })
    const rows = yield* db
      .select({
        receipt: SessionToolRequestReceiptTable,
        providerAttemptID: SessionProviderAttemptTable.attempt_id,
        providerAttemptSessionID: SessionProviderAttemptTable.session_id,
        providerAttemptProviderID: SessionProviderAttemptTable.provider_id,
        providerAttemptState: SessionProviderAttemptTable.state,
        providerAttemptResolutionID: SessionProviderAttemptResolutionTable.resolution_id,
      })
      .from(SessionToolRequestReceiptTable)
      .leftJoin(
        SessionToolRequestResolutionTable,
        eq(SessionToolRequestResolutionTable.receipt_id, SessionToolRequestReceiptTable.receipt_id),
      )
      .leftJoin(
        SessionProviderAttemptTable,
        eq(SessionProviderAttemptTable.attempt_id, SessionToolRequestReceiptTable.provider_attempt_id),
      )
      .leftJoin(
        SessionProviderAttemptResolutionTable,
        eq(SessionProviderAttemptResolutionTable.attempt_id, SessionToolRequestReceiptTable.provider_attempt_id),
      )
      .where(
        and(
          eq(SessionToolRequestReceiptTable.session_id, sessionID),
          eq(SessionToolRequestReceiptTable.provider_state, "indeterminate_after_crash"),
          isNull(SessionToolRequestResolutionTable.resolution_id),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return yield* Effect.forEach(rows, (item) =>
      Effect.gen(function* () {
        const receipt = item.receipt
        const request = receipt.final_request_hash ?? receipt.provider_request_hash ?? receipt.request_input_hash
        const assistantMessageID = Option.getOrUndefined(
          Schema.decodeUnknownOption(MessageID)(receipt.assistant_message_id),
        )
        const promptEpoch =
          receipt.prompt_epoch !== null && receipt.prompt_epoch >= 0 ? receipt.prompt_epoch : undefined
        const continuation = yield* db
          .select({ runID: CompactionRunTable.run_id })
          .from(CompactionRunTable)
          .where(
            and(
              eq(CompactionRunTable.continuation_receipt_id, receipt.receipt_id),
              eq(CompactionRunTable.continuation_state, "indeterminate"),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        const epoch =
          promptEpoch === undefined
            ? undefined
            : yield* db
                .select({
                  baselineHash: SessionPromptEpochTable.world_state_baseline_hash,
                  state: SessionPromptEpochTable.state,
                  authorityState: SessionPromptEpochTable.authority_state,
                  windowID: SessionPromptEpochTable.window_id,
                })
                .from(SessionPromptEpochTable)
                .where(
                  and(
                    eq(SessionPromptEpochTable.session_id, sessionID),
                    eq(SessionPromptEpochTable.epoch, promptEpoch),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
        const baseline =
          promptEpoch === undefined
            ? []
            : yield* db
                .select()
                .from(SessionWorldStateBaselineTable)
                .where(
                  and(
                    eq(SessionWorldStateBaselineTable.session_id, sessionID),
                    eq(SessionWorldStateBaselineTable.prompt_epoch, promptEpoch),
                  ),
                )
                .all()
                .pipe(Effect.orDie)
        const sections = baseline.flatMap((row) => {
          const snapshot = Option.getOrUndefined(Schema.decodeUnknownOption(WorldStateSlot)(row.snapshot))
          if (!snapshot) return []
          return [{ sectionID: row.section_id, snapshot, fragment: row.fragment, fragmentHash: row.fragment_hash }]
        }) satisfies SessionWorldStateBaselineSection[]
        const computed =
          sections.length === baseline.length && sections.length > 0
            ? sessionWorldStateBaselineHash({ sections, rendered: renderSessionWorldStateBaseline(sections) })
            : undefined
        const baselineStatus =
          !epoch?.baselineHash || baseline.length === 0
            ? ("missing" as const)
            : computed !== epoch.baselineHash
              ? ("invalid" as const)
              : ("available" as const)
        const incomplete =
          !assistantMessageID ||
          promptEpoch === undefined ||
          !receipt.prompt_window_id ||
          !receipt.effective_history_hash ||
          !request
        const providerAttemptIncomplete =
          receipt.provider_attempt_id !== null &&
          (item.providerAttemptID !== receipt.provider_attempt_id ||
            item.providerAttemptSessionID !== sessionID ||
            item.providerAttemptProviderID !== receipt.provider_id ||
            item.providerAttemptState !== "indeterminate_after_crash")
        const reasons: (typeof UnsupportedReason.Type)[] = [
          ...(incomplete ? (["legacy_receipt_authority_incomplete"] as const) : []),
          ...(!incomplete && !epoch ? (["source_prompt_epoch_missing"] as const) : []),
          ...(!incomplete && epoch && (epoch.state !== "active" || epoch.authorityState !== "recovery_required")
            ? (["source_prompt_epoch_not_recovery_required"] as const)
            : []),
          ...(!incomplete && epoch && epoch.windowID !== receipt.prompt_window_id
            ? (["source_prompt_epoch_binding_mismatch"] as const)
            : []),
          ...(providerAttemptIncomplete ? (["provider_attempt_authority_incomplete"] as const) : []),
          ...(item.providerAttemptResolutionID
            ? (["provider_attempt_resolution_requires_reconciliation"] as const)
            : []),
          ...(continuation ? (["compaction_continuation_requires_maintenance"] as const) : []),
          ...(session.workspaceID !== null ? (["workspace_recovery_requires_coordination"] as const) : []),
          ...(baselineStatus === "missing" ? (["source_world_state_baseline_missing"] as const) : []),
          ...(baselineStatus === "invalid" ? (["source_world_state_baseline_invalid"] as const) : []),
        ]
        const common = {
          receiptID: receipt.receipt_id,
          sessionID,
          providerID: receipt.provider_id,
          modelID: receipt.model_id,
          providerState: "indeterminate_after_crash" as const,
          sessionMutationEpoch: session.mutationEpoch,
          continuationRecoverySupported: !continuation,
          workspaceRecoverySupported: session.workspaceID === null,
          sourceWorldStateBaselineStatus: baselineStatus,
          ...(assistantMessageID ? { assistantMessageID } : {}),
          ...(promptEpoch !== undefined ? { promptEpoch } : {}),
          ...(receipt.prompt_window_id ? { promptWindowID: receipt.prompt_window_id } : {}),
          ...(receipt.effective_history_hash ? { historyHash: receipt.effective_history_hash } : {}),
          ...(request ? { requestHash: request } : {}),
          ...(baselineStatus === "available" && epoch?.baselineHash
            ? { worldStateBaselineHash: epoch.baselineHash }
            : {}),
        }
        if (reasons.length > 0)
          return {
            ...common,
            resolutionSupported: false as const,
            unsupportedReasons: reasons as [typeof UnsupportedReason.Type, ...(typeof UnsupportedReason.Type)[]],
          }
        if (
          !assistantMessageID ||
          promptEpoch === undefined ||
          !receipt.prompt_window_id ||
          !receipt.effective_history_hash ||
          !request ||
          !epoch?.baselineHash
        )
          return yield* Effect.die(new Error(`provider recovery descriptor invariant failed: ${receipt.receipt_id}`))
        return {
          ...common,
          resolutionSupported: true as const,
          unsupportedReasons: [] as const,
          assistantMessageID,
          promptEpoch,
          promptWindowID: receipt.prompt_window_id,
          historyHash: receipt.effective_history_hash,
          requestHash: request,
          sourceWorldStateBaselineStatus: "available" as const,
          worldStateBaselineHash: epoch.baselineHash,
        }
      }),
    )
  })

  const resolve: Interface["resolve"] = Effect.fn("SessionLegacyProviderResolution.resolve")(function* (input) {
    if (input.decision !== "abandoned" || input.riskAcknowledged)
      return yield* new Conflict({
        code: "decision_not_supported",
        reason: "the Incident Hotfix only supports abandoned",
      })
    const hash = requestHash(input)
    const admission = yield* Effect.exit(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const receipt = yield* tx
              .select({ receiptID: SessionToolRequestReceiptTable.receipt_id })
              .from(SessionToolRequestReceiptTable)
              .where(
                and(
                  eq(SessionToolRequestReceiptTable.receipt_id, input.receiptID),
                  eq(SessionToolRequestReceiptTable.session_id, input.sessionID),
                ),
              )
              .get()
            if (!receipt) return yield* new NotFound({ reason: "provider receipt was not found" })
            const inserted = yield* tx
              .insert(SessionToolRequestResolutionCommandTable)
              .values({
                command_id: input.commandID,
                request_hash: hash,
                session_id: input.sessionID,
                receipt_id: input.receiptID,
                result_resolution_id: null,
                created_at: Date.now(),
              })
              .onConflictDoNothing()
              .returning()
              .get()
            const command =
              inserted ??
              (yield* tx
                .select()
                .from(SessionToolRequestResolutionCommandTable)
                .where(eq(SessionToolRequestResolutionCommandTable.command_id, input.commandID))
                .get())
            if (
              !command ||
              command.request_hash !== hash ||
              command.session_id !== input.sessionID ||
              command.receipt_id !== input.receiptID
            )
              return yield* new Conflict({
                code: "command_id_conflict",
                reason: "command ID was reused with different recovery input",
              })
            return command
          }),
        { behavior: "immediate" },
      ),
    )
    if (Exit.isFailure(admission)) {
      const failure = Cause.squash(admission.cause)
      if (failure instanceof Conflict || failure instanceof NotFound) return yield* failure
      return yield* Effect.die(failure)
    }
    if (admission.value.result_resolution_id) {
      const result = yield* db
        .select()
        .from(SessionToolRequestResolutionTable)
        .where(eq(SessionToolRequestResolutionTable.resolution_id, admission.value.result_resolution_id))
        .get()
        .pipe(Effect.orDie)
      if (!result)
        return yield* Effect.die(new Error(`resolution result disappeared: ${admission.value.result_resolution_id}`))
      return fromResolution(input.commandID, result)
    }
    const proposed = {
      resolutionID: resolutionID(input),
      successorPromptEpoch: input.expected.promptEpoch + 1,
      successorMutationEpoch: input.expected.sessionMutationEpoch + 1,
      createdAt: admission.value.created_at,
    }
    const transaction = yield* Effect.exit(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const inserted = yield* tx
              .insert(SessionToolRequestResolutionCommandTable)
              .values({
                command_id: input.commandID,
                request_hash: hash,
                session_id: input.sessionID,
                receipt_id: input.receiptID,
                result_resolution_id: null,
                created_at: proposed.createdAt,
              })
              .onConflictDoNothing()
              .returning()
              .get()
            const command =
              inserted ??
              (yield* tx
                .select()
                .from(SessionToolRequestResolutionCommandTable)
                .where(eq(SessionToolRequestResolutionCommandTable.command_id, input.commandID))
                .get())
            if (
              !command ||
              command.request_hash !== hash ||
              command.session_id !== input.sessionID ||
              command.receipt_id !== input.receiptID
            )
              return yield* new Conflict({
                code: "command_id_conflict",
                reason: "command ID was reused with different recovery input",
              })
            const known = command.result_resolution_id
              ? yield* tx
                  .select()
                  .from(SessionToolRequestResolutionTable)
                  .where(eq(SessionToolRequestResolutionTable.resolution_id, command.result_resolution_id))
                  .get()
              : undefined
            if (command.result_resolution_id && !known)
              return yield* Effect.die(new Error(`resolution result disappeared: ${command.result_resolution_id}`))
            if (known) return known

            const exact = yield* tx
              .select()
              .from(SessionToolRequestResolutionTable)
              .where(eq(SessionToolRequestResolutionTable.resolution_id, proposed.resolutionID))
              .get()
            if (exact) {
              const repaired = yield* tx
                .update(SessionToolRequestResolutionCommandTable)
                .set({ result_resolution_id: exact.resolution_id })
                .where(
                  and(
                    eq(SessionToolRequestResolutionCommandTable.command_id, input.commandID),
                    eq(SessionToolRequestResolutionCommandTable.request_hash, hash),
                    isNull(SessionToolRequestResolutionCommandTable.result_resolution_id),
                  ),
                )
                .returning({ commandID: SessionToolRequestResolutionCommandTable.command_id })
                .get()
              if (!repaired) {
                const current = yield* tx
                  .select({ result: SessionToolRequestResolutionCommandTable.result_resolution_id })
                  .from(SessionToolRequestResolutionCommandTable)
                  .where(eq(SessionToolRequestResolutionCommandTable.command_id, input.commandID))
                  .get()
                if (current?.result !== exact.resolution_id)
                  return yield* Effect.die(new Error("provider recovery command result CAS failed"))
              }
              return exact
            }

            const session = yield* tx
              .select({ mutationEpoch: SessionTable.mutation_epoch, workspaceID: SessionTable.workspace_id })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sessionID))
              .get()
            if (!session) return yield* new NotFound({ reason: "session was not found" })
            if (session.workspaceID !== null)
              return yield* new Conflict({
                code: "workspace_recovery_not_supported",
                reason: "workspace ownership changed before provider recovery commit",
              })
            if (session.mutationEpoch !== input.expected.sessionMutationEpoch)
              return yield* new Conflict({ code: "stale_session_mutation", reason: "session mutation epoch changed" })
            const receipt = yield* tx
              .select()
              .from(SessionToolRequestReceiptTable)
              .where(
                and(
                  eq(SessionToolRequestReceiptTable.receipt_id, input.receiptID),
                  eq(SessionToolRequestReceiptTable.session_id, input.sessionID),
                ),
              )
              .get()
            if (!receipt) return yield* new NotFound({ reason: "provider receipt was not found" })
            const resolved = yield* tx
              .select()
              .from(SessionToolRequestResolutionTable)
              .where(eq(SessionToolRequestResolutionTable.receipt_id, input.receiptID))
              .get()
            if (resolved)
              return yield* new Conflict({
                code: "receipt_already_resolved",
                reason: `provider receipt was already resolved as ${resolved.decision}`,
              })
            const continuation = yield* tx
              .select({ runID: CompactionRunTable.run_id })
              .from(CompactionRunTable)
              .where(
                and(
                  eq(CompactionRunTable.continuation_receipt_id, input.receiptID),
                  eq(CompactionRunTable.continuation_state, "indeterminate"),
                ),
              )
              .get()
            if (continuation)
              return yield* new Conflict({
                code: "continuation_recovery_not_supported",
                reason: `compaction continuation ${continuation.runID} requires the Maintenance recovery protocol`,
              })
            const source = yield* tx
              .select()
              .from(SessionPromptEpochTable)
              .where(
                and(
                  eq(SessionPromptEpochTable.session_id, input.sessionID),
                  eq(SessionPromptEpochTable.epoch, input.expected.promptEpoch),
                  eq(SessionPromptEpochTable.state, "active"),
                ),
              )
              .get()
            const receiptRequestHash =
              receipt.final_request_hash ?? receipt.provider_request_hash ?? receipt.request_input_hash
            if (
              !source ||
              source.authority_state !== "recovery_required" ||
              receipt.provider_state !== input.expected.providerState ||
              receipt.prompt_epoch !== input.expected.promptEpoch ||
              receipt.prompt_window_id !== source.window_id ||
              receipt.effective_history_hash !== input.expected.historyHash ||
              receiptRequestHash !== input.expected.requestHash
            )
              return yield* new Conflict({
                code: "stale_recovery_state",
                reason: "provider recovery authority changed",
              })
            if (!receipt.assistant_message_id)
              return yield* new Conflict({
                code: "unsafe_history_boundary",
                reason: "ambiguous assistant binding is missing",
              })

            // The physical message snapshot and successor high-water are read under the same
            // IMMEDIATE transaction that retires the source authority and installs its successor.
            const transactionDatabase = tx as unknown as Database.Interface["db"]
            const cutoffAuthority = yield* MessageV2.promptHistoryCutoffAuthorityInTransaction(transactionDatabase, {
              sessionID: input.sessionID,
              cutoffMessageID: MessageID.make(receipt.user_message_id),
            })
            if (!cutoffAuthority)
              return yield* new Conflict({
                code: "unsafe_history_boundary",
                reason: "safe history prefix is not provable",
              })
            const chronological = cutoffAuthority.physical
            const ambiguityIndex = chronological.findIndex(
              (message) => message.info.id === receipt.assistant_message_id,
            )
            const triggerIndex = chronological.findIndex((message) => message.info.id === receipt.user_message_id)
            if (ambiguityIndex < 0 || triggerIndex < 0 || triggerIndex >= ambiguityIndex)
              return yield* new Conflict({
                code: "unsafe_history_boundary",
                reason: "ambiguous provider turn is not contiguous",
              })
            const safeMessages = cutoffAuthority.projection.messages
            if (
              safeMessages.some(
                (message) => message.info.role === "assistant" && !message.info.finish && !message.info.error,
              )
            )
              return yield* new Conflict({
                code: "unsafe_history_boundary",
                reason: "safe prefix contains unfinished assistant output",
              })

            const sourceBaseline = yield* tx
              .select()
              .from(SessionWorldStateBaselineTable)
              .where(
                and(
                  eq(SessionWorldStateBaselineTable.session_id, input.sessionID),
                  eq(SessionWorldStateBaselineTable.prompt_epoch, source.epoch),
                ),
              )
              .all()
            if (sourceBaseline.length === 0 || !source.world_state_baseline_hash)
              return yield* new Conflict({
                code: "source_world_state_baseline_missing",
                reason: "source World State baseline requires Maintenance recovery",
              })
            const sections = yield* Effect.try({
              try: () =>
                sourceBaseline.map((row) => ({
                  sectionID: row.section_id,
                  snapshot: Schema.decodeUnknownSync(WorldStateSlot)(row.snapshot),
                  fragment: row.fragment,
                  fragmentHash: row.fragment_hash,
                })) satisfies SessionWorldStateBaselineSection[],
              catch: () =>
                new Conflict({
                  code: "source_world_state_baseline_invalid",
                  reason: "source World State baseline is not decodable",
                }),
            })
            const baselineHash = sessionWorldStateBaselineHash({
              sections,
              rendered: renderSessionWorldStateBaseline(sections),
            })
            if (
              baselineHash !== source.world_state_baseline_hash ||
              baselineHash !== input.expected.worldStateBaselineHash
            )
              return yield* new Conflict({
                code: "source_world_state_baseline_invalid",
                reason: "source World State baseline hash changed or no longer matches the admitted command",
              })

            const safeHistoryHash = HistoryAuthority.hash(safeMessages)
            const successorWindowID = HistoryAuthority.windowID()
            const highWater = MessageID.make(chronological.at(-1)?.info.id ?? receipt.assistant_message_id)
            const providerAttempt = receipt.provider_attempt_id
              ? yield* tx
                  .select()
                  .from(SessionProviderAttemptTable)
                  .where(eq(SessionProviderAttemptTable.attempt_id, receipt.provider_attempt_id))
                  .get()
              : undefined
            if (
              receipt.provider_attempt_id &&
              (!providerAttempt ||
                providerAttempt.session_id !== input.sessionID ||
                providerAttempt.provider_id !== receipt.provider_id ||
                providerAttempt.state !== "indeterminate_after_crash")
            )
              return yield* new Conflict({
                code: "stale_recovery_state",
                reason: "provider attempt recovery authority changed",
              })
            const providerAttemptResolution = providerAttempt
              ? yield* tx
                  .select()
                  .from(SessionProviderAttemptResolutionTable)
                  .where(eq(SessionProviderAttemptResolutionTable.attempt_id, providerAttempt.attempt_id))
                  .get()
              : undefined
            if (providerAttemptResolution)
              return yield* new Conflict({
                code: "stale_recovery_state",
                reason: "provider attempt was independently resolved and requires Maintenance reconciliation",
              })
            const activity = yield* tx
              .select({ activityID: SessionActivityProgressTable.activity_id })
              .from(SessionActivityProgressTable)
              .innerJoin(
                SessionLegacyActivityTable,
                eq(SessionLegacyActivityTable.activity_id, SessionActivityProgressTable.activity_id),
              )
              .where(
                and(
                  eq(SessionActivityProgressTable.provider_receipt_id, input.receiptID),
                  eq(SessionActivityProgressTable.state, "recovery_required"),
                  eq(SessionLegacyActivityTable.state, "recovery_required"),
                  eq(SessionLegacyActivityTable.session_id, input.sessionID),
                ),
              )
              .get()
            const retired = yield* tx
              .update(SessionPromptEpochTable)
              .set({ state: "retired", retired_at: proposed.createdAt })
              .where(
                and(
                  eq(SessionPromptEpochTable.session_id, input.sessionID),
                  eq(SessionPromptEpochTable.epoch, source.epoch),
                  eq(SessionPromptEpochTable.state, "active"),
                  eq(SessionPromptEpochTable.authority_state, "recovery_required"),
                ),
              )
              .returning({ epoch: SessionPromptEpochTable.epoch })
              .get()
            if (!retired) return yield* Effect.die(new Error("provider recovery epoch retirement CAS failed"))
            if (providerAttempt) {
              yield* tx
                .insert(SessionProviderAttemptRecoveryBridgeTable)
                .values({
                  resolution_id: proposed.resolutionID,
                  attempt_id: providerAttempt.attempt_id,
                  receipt_id: input.receiptID,
                  command_id: input.commandID,
                  created_at: proposed.createdAt,
                })
                .run()
            }
            const resolution = yield* tx
              .insert(SessionToolRequestResolutionTable)
              .values({
                resolution_id: proposed.resolutionID,
                receipt_id: input.receiptID,
                session_id: input.sessionID,
                legacy_activity_id: activity?.activityID ?? null,
                assistant_message_id: MessageID.make(receipt.assistant_message_id),
                source_prompt_epoch: source.epoch,
                source_window_id: source.window_id!,
                source_effective_history_hash: receipt.effective_history_hash!,
                source_request_hash: receiptRequestHash!,
                source_mutation_epoch: session.mutationEpoch,
                expected_provider_state: "indeterminate_after_crash",
                decision: "abandoned",
                actor_type: "user",
                actor_id: input.actorID,
                reason: input.reason ?? DEFAULT_REASON,
                risk_acknowledged: false,
                safe_end_message_id: safeMessages.at(-1)?.info.id ?? null,
                safe_history_hash: safeHistoryHash,
                safe_message_ids: safeMessages.map((message) => message.info.id),
                ambiguity_message_id: MessageID.make(receipt.assistant_message_id),
                physical_message_high_water: highWater,
                successor_prompt_epoch: proposed.successorPromptEpoch,
                successor_window_id: successorWindowID,
                successor_history_hash: safeHistoryHash,
                successor_mutation_epoch: proposed.successorMutationEpoch,
                created_at: proposed.createdAt,
              })
              .returning()
              .get()
            if (!resolution) return yield* Effect.die(new Error("provider recovery resolution insert failed"))
            if (providerAttempt) {
              yield* tx
                .insert(SessionProviderAttemptResolutionTable)
                .values({
                  resolution_id: proposed.resolutionID,
                  attempt_id: providerAttempt.attempt_id,
                  actor_type: "user",
                  actor_id: input.actorID,
                  decision: "abandoned",
                  provider_evidence: null,
                  risk_acknowledged: false,
                  reason: input.reason ?? DEFAULT_REASON,
                  created_at: proposed.createdAt,
                })
                .run()
              const terminalAttempt = yield* tx
                .update(SessionProviderAttemptTable)
                .set({ state: "resolved_abandoned", settled_at: proposed.createdAt })
                .where(
                  and(
                    eq(SessionProviderAttemptTable.attempt_id, providerAttempt.attempt_id),
                    eq(SessionProviderAttemptTable.state, "indeterminate_after_crash"),
                  ),
                )
                .returning({ attemptID: SessionProviderAttemptTable.attempt_id })
                .get()
              if (!terminalAttempt) return yield* Effect.die(new Error("provider attempt recovery CAS failed"))
              const terminalActivity = yield* tx
                .update(SessionActivityTable)
                .set({ state: "interrupted", settled_at: proposed.createdAt })
                .where(
                  and(
                    eq(SessionActivityTable.activity_id, providerAttempt.activity_id),
                    eq(SessionActivityTable.session_id, input.sessionID),
                    eq(SessionActivityTable.state, "active"),
                  ),
                )
                .returning({ activityID: SessionActivityTable.activity_id })
                .get()
              if (!terminalActivity) return yield* Effect.die(new Error("provider activity recovery CAS failed"))
            }
            yield* tx
              .insert(SessionPromptEpochTable)
              .values({
                session_id: input.sessionID,
                epoch: proposed.successorPromptEpoch,
                state: "active",
                checkpoint_user_id: null,
                checkpoint_assistant_id: null,
                retained_tail_start_id: null,
                source_end_message_id: highWater,
                checkpoint_hash: safeHistoryHash,
                projection_version: HistoryAuthority.PROJECTION_VERSION,
                canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
                base_message_count: safeMessages.length,
                effective_history_hash: safeHistoryHash,
                first_window_id: source.first_window_id ?? source.window_id,
                previous_window_id: source.window_id,
                window_id: successorWindowID,
                world_state_baseline_hash: baselineHash,
                authority_state: "ready",
                recovery_reason: null,
                recovery_resolution_id: proposed.resolutionID,
                reason: "recovery",
                created_at: proposed.createdAt,
                retired_at: null,
              })
              .run()
            if (safeMessages.length > 0)
              yield* tx
                .insert(SessionPromptEpochMessageTable)
                .values(
                  safeMessages.map((message, ordinal) => ({
                    session_id: input.sessionID,
                    prompt_epoch: proposed.successorPromptEpoch,
                    ordinal,
                    message_id: message.info.id,
                  })),
                )
                .run()
            yield* tx
              .insert(SessionWorldStateBaselineTable)
              .values(
                sections.map((section) => ({
                  session_id: input.sessionID,
                  prompt_epoch: proposed.successorPromptEpoch,
                  section_id: section.sectionID,
                  snapshot: section.snapshot,
                  fragment: section.fragment,
                  fragment_hash: section.fragmentHash,
                  provenance: "recovery_copied" as const,
                  created_at: proposed.createdAt,
                })),
              )
              .run()
            yield* tx
              .insert(SessionPromptEpochRecoveryTable)
              .values({
                session_id: input.sessionID,
                prompt_epoch: proposed.successorPromptEpoch,
                resolution_id: proposed.resolutionID,
                source_prompt_epoch: source.epoch,
                source_mutation_epoch: session.mutationEpoch,
                successor_mutation_epoch: proposed.successorMutationEpoch,
                ambiguity_message_id: MessageID.make(receipt.assistant_message_id),
                physical_message_high_water: highWater,
                created_at: proposed.createdAt,
              })
              .run()
            const mutated = yield* tx
              .update(SessionTable)
              .set({ mutation_epoch: proposed.successorMutationEpoch, time_updated: proposed.createdAt })
              .where(and(eq(SessionTable.id, input.sessionID), eq(SessionTable.mutation_epoch, session.mutationEpoch)))
              .returning({ epoch: SessionTable.mutation_epoch })
              .get()
            if (mutated?.epoch !== proposed.successorMutationEpoch)
              return yield* Effect.die(new Error("provider recovery mutation epoch CAS failed"))
            yield* tx
              .update(SessionIntentTable)
              .set({
                state: "superseded",
                owner_token: null,
                lease_expires_at: null,
                time_updated: proposed.createdAt,
                version: sql`${SessionIntentTable.version} + 1`,
              })
              .where(
                and(
                  eq(SessionIntentTable.session_id, input.sessionID),
                  inArray(SessionIntentTable.state, ["preparing", "admitting", "failed"]),
                  sql`${SessionIntentTable.mutation_epoch} < ${proposed.successorMutationEpoch}`,
                ),
              )
              .run()
            yield* tx
              .update(SessionSteerTable)
              .set({ superseded_at: proposed.createdAt })
              .where(
                and(
                  eq(SessionSteerTable.session_id, input.sessionID),
                  isNull(SessionSteerTable.consumed_seq),
                  isNull(SessionSteerTable.superseded_at),
                  sql`${SessionSteerTable.mutation_epoch} < ${proposed.successorMutationEpoch}`,
                ),
              )
              .run()
            const history = yield* tx
              .update(SessionHistoryStateTable)
              .set({ state: "ready", reason: null, time_updated: proposed.createdAt })
              .where(
                and(
                  eq(SessionHistoryStateTable.session_id, input.sessionID),
                  eq(SessionHistoryStateTable.state, "recovery_required"),
                ),
              )
              .returning({ sessionID: SessionHistoryStateTable.session_id })
              .get()
            if (!history) return yield* Effect.die(new Error("provider recovery history state CAS failed"))
            const completed = yield* tx
              .update(SessionToolRequestResolutionCommandTable)
              .set({ result_resolution_id: proposed.resolutionID })
              .where(
                and(
                  eq(SessionToolRequestResolutionCommandTable.command_id, input.commandID),
                  eq(SessionToolRequestResolutionCommandTable.request_hash, hash),
                  isNull(SessionToolRequestResolutionCommandTable.result_resolution_id),
                ),
              )
              .returning({ commandID: SessionToolRequestResolutionCommandTable.command_id })
              .get()
            if (!completed) return yield* Effect.die(new Error("provider recovery command result CAS failed"))
          }),
        { behavior: "immediate" },
      ),
    )
    if (Exit.isFailure(transaction)) {
      const failure = Cause.squash(transaction.cause)
      if (failure instanceof Conflict || failure instanceof NotFound) return yield* failure
      return yield* Effect.die(failure)
    }
    const result = yield* db
      .select()
      .from(SessionToolRequestResolutionTable)
      .where(eq(SessionToolRequestResolutionTable.resolution_id, proposed.resolutionID))
      .get()
      .pipe(Effect.orDie)
    if (!result) return yield* Effect.die(new Error(`resolution result disappeared: ${proposed.resolutionID}`))
    yield* events
      .publish(Event.Completed, {
        sessionID: input.sessionID,
        resolutionID: proposed.resolutionID,
        commandID: input.commandID,
        receiptID: input.receiptID,
        decision: "abandoned",
        sourcePromptEpoch: input.expected.promptEpoch,
        successorPromptEpoch: proposed.successorPromptEpoch,
        sourceMutationEpoch: input.expected.sessionMutationEpoch,
        successorMutationEpoch: proposed.successorMutationEpoch,
        createdAt: proposed.createdAt,
      })
      .pipe(Effect.catchCause(() => Effect.void))
    return fromResolution(input.commandID, result)
  })

  return Service.of({ describe, resolve })
})

export const layer = Layer.effect(Service, service)
export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(EventV2Bridge.defaultLayer))

export * as SessionLegacyProviderResolution from "./legacy-provider-resolution"
