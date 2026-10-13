export * as WorkProviderDispatch from "./work-provider-dispatch"

import { Finish } from "@deepagent-code/llm"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { asc, eq } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionContextSelectionTable, SessionProviderAttemptTable } from "../context-federation/session-sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { SessionInputTable, SessionMessageTable } from "./sql"
import { PreparedProviderTurn } from "./runner/prepared-provider-turn"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import { WorkAuthority } from "./work-authority"
import { WorkAuthorityPolicy } from "./work-authority-policy"
import { WorkAuthoritySchema } from "./work-authority.schema"
import { WorkDispatchReservationTable, WorkExecutionTable } from "./work-authority.sql"
import { WorkRoutePolicy } from "./work-route-policy"
import { WorkExecutionProfile } from "./work-execution-profile"
import { WorkToolPolicy } from "./work-tool-policy"
import { WorkCountAcquisition } from "./work-count-acquisition"

/** Trusted main-runner boundary, deliberately absent by default. Observe the actually resolved
 * model/client and installed encoder/transport, never synthesize these identities from a Work
 * binding or HTTP metadata. Read already captured runtime evidence only: no model re-resolution,
 * filesystem/registry discovery or network inside this transaction. Counting happens BEFORE seal. */
export class Runtime extends Context.Service<
  Runtime,
  {
    readonly observe: (input: {
      readonly sessionID: string
      readonly receiptID: string
      readonly providerID: string
      readonly modelID: string
      readonly protocol: string
    }) => Effect.Effect<WorkRoutePolicy.Runtime, WorkAuthoritySchema.Error>
  }
>()("@deepagent-code/WorkProviderDispatch/Runtime") {}

/** Runs inside the ACTUAL receipt preparing -> dispatching transaction. No second transaction
 * commits a permit, and no counter/network call is allowed in the evidence services here. */
export const authorizeInTransaction = Effect.fn("WorkProviderDispatch.authorizeInTransaction")(function* (
  tx: WorkAuthority.Transaction,
  db: Database.Interface["db"],
  receipt: typeof V2ProviderTurnReceiptTable.$inferSelect,
  prepared: PreparedProviderTurn.PreparedProviderTurn,
  wire: RequestExecutor.RequestSealInput,
) {
  const bound = yield* tx
    .select()
    .from(WorkExecutionTable)
    .where(eq(WorkExecutionTable.session_id, receipt.session_id))
    .get()
  // This slice does not migrate historical unbound IM/event execution.
  if (!bound) return
  const work = yield* WorkAuthority.requireContext(db, { sessionID: SessionSchema.ID.make(receipt.session_id) })
  if (!work) return yield* denied("WORK_AUTHORITY_MISSING", "Bound provider turn has no current Work authority")
  const profile = WorkAuthorityPolicy.profileFor(work.binding.profile)
  if (!profile) return yield* denied("PROFILE_UNAVAILABLE", "Provider instructions require the verified execution profile")
  yield* WorkExecutionProfile.requirePlacement(tx, work)
  const runtime = yield* Effect.serviceOption(Runtime)
  if (Option.isNone(runtime))
    return yield* denied("PROFILE_UNAVAILABLE", "Actual restricted runtime observation is not installed")
  const admitted = yield* tx
    .select()
    .from(SessionInputTable)
    .where(eq(SessionInputTable.id, SessionMessage.ID.make(work.input_id)))
    .get()
  const attempt = receipt.provider_attempt_id
    ? yield* tx
        .select()
        .from(SessionProviderAttemptTable)
        .where(eq(SessionProviderAttemptTable.attempt_id, receipt.provider_attempt_id))
        .get()
    : undefined
  const selection = attempt
    ? yield* tx
        .select()
        .from(SessionContextSelectionTable)
        .where(eq(SessionContextSelectionTable.selection_id, attempt.selection_id))
        .get()
    : undefined
  if (!admitted || admitted.promoted_seq === null || admitted.id !== receipt.user_message_id || !attempt || !selection)
    return yield* denied("WORK_BINDING_CONFLICT", "Actual admitted input, attempt or selection is missing")
  const audited = WorkAuthorityPolicy.checkAuditedText(work.binding, admitted.prompt.text)
  if (!audited.ok) return yield* audited.error
  const project = work.binding.schemaVersion === "work-execution.v2"
  const history = project ? yield* tx.select().from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, SessionSchema.ID.make(work.session_id))).orderBy(asc(SessionMessageTable.seq)).limit(34).all() : undefined
  const instructions = profile.instructions
  const previous = project ? yield* WorkToolPolicy.previous(tx, work, receipt.receipt_id) : undefined
  const previousCount = previous ? yield* WorkCountAcquisition.getTurn(tx, work.work_id,
    Hash.sha256(CanonicalJson.stringify(["work-provider-turn.v1", work.work_id, previous.receipt.session_id,
      previous.receipt.activity_id, previous.receipt.provider_turn_seq]))) : undefined
  if (project && (receipt.activity_id === null || receipt.provider_turn_seq === null ||
    !history || history.length > 33 || (previous && (!previousCount || !previous.receipt.outcome_hash))))
    return yield* denied("WORK_BINDING_CONFLICT", "Project provider predecessor is incomplete")
  const queryFingerprint = Hash.sha256(
    CanonicalJson.stringify({
      profileHash: work.binding.profile.hash,
      instructions,
      inputID: admitted.id,
      text: admitted.prompt.text,
      ...(history ? { historyHash: Hash.sha256(CanonicalJson.stringify(history)) } : {}),
    }),
  )
  const authorizationFingerprint = Hash.sha256(
    CanonicalJson.stringify({
      workID: work.work_id,
      bindingHash: work.binding_hash,
      controlRevision: work.control_revision,
      sourceRecordHash: work.source_record_hash,
      scope: work.binding.scope,
    }),
  )
  const refs = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(selection.selected_refs)
  const graphs = Schema.decodeUnknownOption(
    Schema.UnknownFromJsonString.pipe(
      Schema.decodeTo(
        Schema.Record(Schema.String, Schema.Struct({ status: Schema.String, reasonCode: Schema.String })),
      ),
    ),
  )(selection.graph_statuses)
  if (
    selection.query_fingerprint !== queryFingerprint ||
    selection.authorization_fingerprint !== authorizationFingerprint ||
    selection.authorization_epoch !== work.control_revision ||
    Option.isNone(refs) ||
    !Array.isArray(refs.value) ||
    refs.value.length !== 0 ||
    Option.isNone(graphs) ||
    !["code", "documents", "knowledge", "memory"].every((key) => {
      const graph = Option.isSome(graphs) ? graphs.value[key] : undefined
      return graph?.status === "denied" && graph.reasonCode === "agent_policy_denied"
    }) ||
    prepared.session_id !== receipt.session_id ||
    prepared.receipt_id !== receipt.receipt_id ||
    (prepared.provider_attempt_id !== undefined && prepared.provider_attempt_id !== attempt.attempt_id) ||
    prepared.user_message_id !== admitted.id ||
    prepared.activity_id !== attempt.activity_id ||
    prepared.provider_turn_seq !== attempt.provider_turn_seq ||
    prepared.context_selection_id !== selection.selection_id ||
    prepared.context_projection_hash !== selection.projection_hash ||
    prepared.context_selected_refs.length !== 0 ||
    (!project && (prepared.tool_registry_ids.length !== 0 ||
      prepared.tool_permission_filtered_ids.length !== 0 || prepared.tool_final_offered_ids.length !== 0 ||
      prepared.tool_result_reference_ids.length !== 0 || prepared.tool_definition_hash !== null)) ||
    prepared.system_stable_parts.length !== 1 ||
    prepared.system_stable_parts[0] !== instructions ||
    prepared.system_volatile_parts.length !== 0 ||
    (!project && prepared.history_message_count !== 1) ||
    prepared.sampling_model_id !== receipt.model_id ||
    prepared.sampling_provider_id !== receipt.provider_id ||
    prepared.prepared_turn_hash !== PreparedProviderTurn.preparedTurnHash(prepared)
  )
    return yield* denied("WORK_BINDING_CONFLICT", "Provider turn differs from the restricted canonical selection")
  const observed = yield* runtime.value.observe({
    sessionID: receipt.session_id,
    receiptID: receipt.receipt_id,
    providerID: receipt.provider_id,
    modelID: receipt.model_id,
    protocol: receipt.protocol,
  })
  const inspected = WorkRoutePolicy.inspect({ binding: work.binding, auditedText: admitted.prompt.text, runtime: observed, wire }, { allowLoopbackHTTP: work.loopback_http })
  if (!inspected.ok) return yield* inspected.error
  const projectDispatch = project && receipt.activity_id !== null && receipt.provider_turn_seq !== null ? {
    rootWorkID: work.root_work_id,
    turn: { key: Hash.sha256(CanonicalJson.stringify(["work-provider-turn.v1", work.work_id, receipt.session_id, receipt.activity_id, receipt.provider_turn_seq])),
      activityID: receipt.activity_id, providerTurnSeq: receipt.provider_turn_seq, contextSelectionID: attempt.selection_id,
      contextProjectionHash: attempt.projection_hash, historyPromptEpoch: receipt.history_prompt_epoch,
      historySourceEndMessageID: receipt.history_source_end_message_id },
    predecessor: previous && previousCount && previous.receipt.outcome_hash ? { acquisitionID: previousCount.acquisitionID,
      receiptID: previous.receipt.receipt_id, outcomeHash: previous.receipt.outcome_hash, toolTerminalHash: previous.toolTerminalHash } : null,
    toolAdvertisementHash: inspected.value.toolAdvertisementHash,
  } : undefined
  const proof = yield* WorkRoutePolicy.verify(
    {
      binding: work.binding,
      auditedText: admitted.prompt.text,
      runtime: observed,
      wire,
      dispatch: {
        workID: work.work_id, inputID: work.input_id, sessionID: work.session_id,
        bindingHash: work.binding_hash, controlRevision: work.control_revision,
        sourceAuthorityID: work.authority_id, sourceRevision: work.source_revision,
        sourceRecordHash: work.source_record_hash, providerReceiptID: receipt.receipt_id,
        providerAttemptID: attempt.attempt_id, sessionClaimToken: attempt.execution_claim_token,
        providerOwnerToken: receipt.owner_token,
        ...(projectDispatch ? { project: projectDispatch } : {}),
      },
    },
    { allowLoopbackHTTP: work.loopback_http },
  )
  if (prepared.sampling_max_output_tokens !== proof.completionTokens)
    return yield* denied("WORK_BINDING_CONFLICT", "Prepared completion cap differs from final encoded bytes")
  const reservation = yield* WorkAuthority.reserveDispatchInTransaction(tx, {
    workID: work.work_id,
    dispatchKey: receipt.receipt_id,
    receiptID: receipt.receipt_id,
    attemptID: attempt.attempt_id,
    sessionClaimToken: attempt.execution_claim_token,
    ownerToken: receipt.owner_token,
    contextSelectionID: selection.selection_id,
    contextProjectionHash: selection.projection_hash,
    inputUpperBound: proof.inputBound,
    completionTokens: proof.completionTokens,
    expectedRevision: work.control_revision,
  })
  yield* WorkAuthority.authorizeDispatchInTransaction(tx, {
    reservationID: reservation.reservation_id,
    expectedRevision: work.control_revision,
    wireHash: proof.wireHash,
    method: wire.method,
    endpoint: wire.url,
    contextSelectionID: selection.selection_id,
    contextProjectionHash: selection.projection_hash,
  })
})

/** The existing terminal-descriptor writer calls this in its own transaction, including stale
 * canonical attempts and cold/fenced owner recovery. Unknown evidence never releases a charge. */
export const terminalInTransaction = Effect.fn("WorkProviderDispatch.terminalInTransaction")(function* (
  tx: WorkAuthority.Transaction,
  receipt: typeof V2ProviderTurnReceiptTable.$inferSelect,
  now: number,
) {
  const reservation = yield* tx
    .select()
    .from(WorkDispatchReservationTable)
    .where(eq(WorkDispatchReservationTable.receipt_id, receipt.receipt_id))
    .get()
  if (!reservation) return
  if (reservation.state === "settled" || reservation.state === "released" || reservation.state === "unknown") return
  if (reservation.state === "reserved") {
    if (receipt.dispatching_at !== null || receipt.wire_request_hash !== null)
      return yield* denied("WORK_DISPATCH_CONFLICT", "A dispatched receipt has no consumed Work permit")
    yield* WorkAuthority.settleDispatchInTransaction(tx, {
      reservationID: reservation.reservation_id,
      outcome: "released",
      now,
    })
    return
  }
  const artifact = receipt.outcome_artifact ?? []
  const work = yield* WorkAuthority.get(tx, reservation.work_id)
  const usage =
    receipt.state === "settled" && receipt.outcome_hash === Hash.sha256(CanonicalJson.stringify(artifact))
      ? terminalUsage(artifact, work?.binding.schemaVersion === "work-execution.v2")
      : undefined
  yield* WorkAuthority.settleDispatchInTransaction(tx, {
    reservationID: reservation.reservation_id,
    outcome: usage ? "settled" : "unknown",
    ...(usage ? { usage } : {}),
    now,
  })
})

function terminalUsage(events: readonly unknown[], project = false): WorkAuthoritySchema.Usage | undefined {
  const finishes = events.filter(
    (event) => typeof event === "object" && event !== null && "type" in event && event.type === "finish",
  )
  if (
    finishes.length !== 1 ||
    events.at(-1) !== finishes[0] ||
    events.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        (event.type === "provider-error" ||
          (typeof event.type === "string" && event.type.startsWith("tool-") && (!project ||
            event.type === "tool-result" || event.type === "tool-error" || ("providerExecuted" in event && event.providerExecuted === true)))),
    )
  )
    return
  const finish = Schema.decodeUnknownOption(Finish)(finishes[0])
  if (Option.isNone(finish) || !(project ? ["stop", "length", "content-filter", "tool-calls"] : ["stop", "length", "content-filter"]).includes(finish.value.reason)) return
  const usage = finish.value.usage
  if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined) return
  const candidate = {
    inputTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
  const valid = WorkAuthorityPolicy.usageTotal(candidate)
  if (!valid.ok || (usage.totalTokens !== undefined && usage.totalTokens !== valid.value)) return
  return candidate
}

function denied(code: WorkAuthoritySchema.Error["code"], message: string) {
  return new WorkAuthoritySchema.Error({ code, message })
}
