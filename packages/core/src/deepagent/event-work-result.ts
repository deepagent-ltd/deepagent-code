export * as EventWorkResult from "./event-work-result"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import type { Database } from "../database/database"
import { WorkAuthority } from "../session/work-authority"
import { WorkAuthorityPolicy } from "../session/work-authority-policy"
import { WorkDispatchReservationTable } from "../session/work-authority.sql"
import { SessionMessage } from "../session/message"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { EventWorkNodeAuthorityTable } from "./event-work-rule.sql"
import { EventWorkDagSchema } from "./event-work-dag.schema"
import { EventWorkDagPolicy } from "./event-work-dag.policy"
import { EventWorkAdmission } from "./event-work-admission"
import { WorkToolPolicy } from "../session/work-tool-policy"
import { EventTaskWorkspaceTable, SessionTable } from "../session/sql"

const hash = EventWorkDagPolicy.hash
const failure = EventWorkDagPolicy.failure

/** E1 compatibility: a management read returns the original receipt and immutable Work facts,
 * never an event payload pretending to be an agent result or fresh execution permission. */
export const read = Effect.fn("EventWorkResult.read")(function* (tx: WorkAuthority.Transaction, receiptID: string) {
  const original = yield* EventWorkAdmission.get(tx, receiptID)
  if (!original) return undefined
  const work = yield* WorkAuthority.get(tx, original.receipt.workID)
  if (work && (work.parent_work_id !== null || work.authority_id !== original.receipt.receiptID ||
    work.session_id !== original.receipt.sessionID || work.input_id !== original.receipt.inputID ||
    work.binding_hash !== original.bindingHash || hash(work.binding) !== work.binding_hash ||
    work.source_record_hash !== original.receipt.authorityHash || work.binding.auditedText.hash !== original.receipt.auditedTextHash))
    return yield* failure("EVENT_DAG_CONFLICT")
  return { ...original, work }
})

/** Cold Native authentication remains outside SQL; no file re-read, model or retry occurs. */
export const prepareTerminal = (db: Database.Interface["db"], workID: string) => Effect.gen(function* () {
  const work = yield* WorkAuthority.get(db, workID)
  if (!work) return yield* failure("EVENT_DAG_NOT_READY")
  const proof = yield* Effect.serviceOption(WorkToolPolicy.LeafProof)
  const effects = yield* db.all<{ effect_id: string }>(sql`SELECT e.effect_id FROM session_v2_tool_effect e
    JOIN session_v2_tool_effect_admission a ON a.session_id=e.session_id AND a.receipt_id=e.receipt_id
      AND a.provider_attempt_id=e.provider_attempt_id AND a.tool_call_id=e.tool_call_id AND a.owner_token=e.owner_token
    WHERE e.session_id=${work.session_id} ORDER BY e.effect_id LIMIT 129`)
  if (effects.length > 128) return yield* failure("EVENT_DAG_UNAVAILABLE")
  if (effects.length) {
    if (Option.isNone(proof) || !proof.value.authenticateEventTerminal) return yield* failure("EVENT_DAG_UNAVAILABLE")
    for (const effect of effects) yield* proof.value.authenticateEventTerminal(effect.effect_id)
  }
})

/** Reads already-occurred facts only. Expiry/revocation never grants a new node, but must not
 * prevent a known physical result from being accounted or replace it with event payload text. */
const readKnownExecution = Effect.fn("EventWorkResult.readKnownExecution")(function* (tx: WorkAuthority.Transaction, workID: string, requireWorkspace: boolean) {
  const row = yield* tx.select().from(EventWorkNodeAuthorityTable).where(eq(EventWorkNodeAuthorityTable.work_id, workID)).get()
  if (!row || row.record_bytes !== Buffer.byteLength(row.record, "utf8") || row.record_bytes > 131_072) return yield* failure()
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(EventWorkDagSchema.Authority), { onExcessProperty: "error" })(row.record)
  if (Option.isNone(decoded)) return yield* failure()
  const authority = decoded.value
  const ids = EventWorkDagPolicy.identities(authority.receiptID, authority.nodeID)
  if (!("authorityID" in ids) || row.record_hash !== hash(authority) || row.authority_id !== authority.authorityID || row.receipt_id !== authority.receiptID ||
    row.node_id !== authority.nodeID || authority.authorityID !== ids.authorityID || authority.childWorkID !== ids.workID ||
    authority.childSessionID !== ids.sessionID || authority.childInputID !== ids.inputID || row.work_id !== authority.childWorkID ||
    authority.childBindingHash !== hash(authority.childBinding) || authority.rootBindingHash !== hash(authority.rootBinding)) return yield* failure()
  const work = yield* WorkAuthority.get(tx, workID)
  const root = yield* WorkAuthority.get(tx, authority.rootWorkID)
  if (!work || !root || work.work_id !== authority.childWorkID || work.root_work_id !== root.work_id || work.parent_work_id !== root.work_id ||
    work.session_id !== authority.childSessionID || work.input_id !== authority.childInputID || work.binding_hash !== authority.childBindingHash ||
    hash(work.binding) !== work.binding_hash || root.binding_hash !== authority.rootBindingHash || hash(root.binding) !== root.binding_hash ||
    work.source_record_hash !== root.source_record_hash || work.route_evidence_hash !== root.route_evidence_hash ||
    !EventWorkDagPolicy.profileMatches(work.binding.profile) || !EventWorkDagPolicy.profileMatches(root.binding.profile) ||
    work.outcome !== "succeeded" && work.outcome !== "failed") return yield* failure("EVENT_DAG_NOT_READY")
  const activity = yield* tx.get<{ activity_id: string; state: string; final_message_id: string; final_data: string; settled_at: number }>(sql`SELECT
    a.activity_id,a.state,a.final_message_id,m.data final_data,a.settled_at FROM session_activity a
    JOIN session_message m ON m.session_id=a.session_id AND m.id=a.final_message_id
    JOIN session_input i ON i.session_id=a.session_id AND i.id=a.trigger_input_id
    JOIN session s ON s.id=a.session_id WHERE a.session_id=${work.session_id} AND a.trigger_input_id=${work.input_id}
      AND i.promoted_seq IS NOT NULL AND s.parent_id=${authority.parentSessionID} AND s.project_id=${work.binding.schemaVersion === "work-execution.v2" ? work.binding.projectScope.projectID : ""}
      AND s.directory=${SessionTable.directory.mapToDriverValue(work.binding.location.directory)} AND s.workspace_id IS NULL AND s.v2_authority=1
      AND a.state IN ('settled','failed') AND a.settled_at IS NOT NULL AND a.final_message_id IS NOT NULL
      AND m.type='assistant' AND m.seq>i.promoted_seq AND length(CAST(m.data AS BLOB)) BETWEEN 2 AND 1048576`)
  if (!activity || activity.state !== (work.outcome === "succeeded" ? "settled" : "failed")) return yield* failure("EVENT_DAG_NOT_READY")
  const data = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(activity.final_data)
  const assistant = Option.isSome(data) && data.value !== null && typeof data.value === "object" && !Array.isArray(data.value)
    ? Schema.decodeUnknownOption(SessionMessage.Assistant)({ ...data.value, id: activity.final_message_id, type: "assistant" })
    : Option.none<SessionMessage.Assistant>()
  if (Option.isNone(assistant) || assistant.value.error !== undefined || assistant.value.time.completed === undefined ||
    assistant.value.agent !== work.agent_id || assistant.value.model.providerID !== work.binding.provider.providerID ||
    assistant.value.model.id !== work.binding.provider.modelID || assistant.value.content.some((part) => part.type === "tool")) return yield* failure()
  const text = assistant.value.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  if (Buffer.byteLength(text, "utf8") > 65_536) return yield* failure("EVENT_DAG_CAPACITY")
  const providers = yield* tx.all<{ receipt_id: string; attempt_id: string; wire_request_hash: string; outcome_hash: string; terminal_at: number; outcome_artifact: string }>(sql`SELECT
    r.receipt_id,p.attempt_id,r.wire_request_hash,r.outcome_hash,r.terminal_at,r.outcome_artifact FROM session_v2_provider_turn_receipt r
    JOIN session_provider_attempt p ON p.attempt_id=r.provider_attempt_id AND p.session_id=r.session_id AND p.activity_id=r.activity_id
      AND p.owner_token=r.owner_token AND p.wire_request_hash=r.wire_request_hash
    WHERE r.session_id=${work.session_id} AND r.activity_id=${activity.activity_id} AND r.state='settled' AND p.state='settled'
      AND r.error_code IS NULL AND p.error_code IS NULL AND r.terminal_at IS NOT NULL AND r.outcome_hash IS NOT NULL
      AND r.owner_mode='v2' AND r.provider_id=${work.binding.provider.providerID} AND r.model_id=${work.binding.provider.modelID}
      AND r.protocol=${work.binding.provider.protocol} AND r.user_message_id=${work.input_id}
      AND p.provider_id=r.provider_id AND length(CAST(r.outcome_artifact AS BLOB)) BETWEEN 2 AND 1048576
    ORDER BY r.provider_turn_seq,r.receipt_id LIMIT 33`)
  const charges = yield* tx.select().from(WorkDispatchReservationTable).where(and(eq(WorkDispatchReservationTable.work_id, workID), sql`${WorkDispatchReservationTable.state}<>'released'`)).all()
  const total = yield* tx.get<{ receipts: number; attempts: number }>(sql`SELECT
    (SELECT count(*) FROM session_v2_provider_turn_receipt WHERE session_id=${work.session_id} AND activity_id=${activity.activity_id}) receipts,
    (SELECT count(*) FROM session_provider_attempt WHERE session_id=${work.session_id} AND activity_id=${activity.activity_id}) attempts`)
  if (!total || providers.length === 0 || providers.length > work.binding.budget.maxProviderDispatches ||
    total.receipts !== providers.length || total.attempts !== providers.length || charges.length !== providers.length ||
    charges.some((charge) => !charge.actual_usage || charge.state !== "settled" || charge.root_work_id !== root.work_id ||
      charge.receipt_id !== providers.find((provider) => provider.attempt_id === charge.attempt_id)?.receipt_id ||
      charge.wire_hash !== providers.find((provider) => provider.receipt_id === charge.receipt_id)?.wire_request_hash ||
      !WorkAuthorityPolicy.usageTotal(charge.actual_usage).ok || charge.charged_tokens !== charge.actual_usage.inputTokens + charge.actual_usage.completionTokens)) return yield* failure("EVENT_DAG_UNKNOWN")
  for (const provider of providers) {
    const artifact = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(LLMEvent)))(provider.outcome_artifact)
    const charge = charges.find((item) => item.receipt_id === provider.receipt_id)
    if (Option.isNone(artifact) || hash(artifact.value) !== provider.outcome_hash || !charge?.actual_usage) return yield* failure()
    const finish = artifact.value.filter(LLMEvent.is.finish)
    if (finish.length !== 1 || finish[0]!.usage?.inputTokens !== charge.actual_usage.inputTokens ||
      finish[0]!.usage?.outputTokens !== charge.actual_usage.completionTokens ||
      finish[0]!.usage?.reasoningTokens !== charge.actual_usage.reasoningTokens) return yield* failure()
  }
  const effects = yield* tx.all<{ admission_id: string; effect_id: string | null; outcome_hash: string | null; state: string | null;
    grant_state: string | null; grant_receipt_id: string | null; grant_owner_id: string | null; grant_version: number | null; tool_name: string }>(sql`SELECT
    d.admission_id,e.effect_id,e.outcome_hash,e.state,e.grant_state,e.grant_receipt_id,e.grant_owner_id,e.grant_version,d.tool_name FROM session_v2_tool_effect_admission d
    JOIN session_v2_provider_turn_receipt r ON r.receipt_id=d.receipt_id
    LEFT JOIN session_v2_tool_effect e ON e.session_id=d.session_id AND e.receipt_id=d.receipt_id AND e.provider_attempt_id=d.provider_attempt_id
      AND e.tool_call_id=d.tool_call_id AND e.owner_token=d.owner_token AND e.tool_name=d.tool_name AND e.effect_kind=d.effect_kind
    WHERE r.session_id=${work.session_id} AND r.activity_id=${activity.activity_id} AND d.session_id=r.session_id
      AND d.provider_attempt_id=r.provider_attempt_id AND d.owner_token=r.owner_token ORDER BY r.provider_turn_seq,d.tool_call_id LIMIT 129`)
  const effectCount = yield* tx.get<{ admissions: number; effects: number }>(sql`SELECT
    (SELECT count(*) FROM session_v2_tool_effect_admission d JOIN session_v2_provider_turn_receipt r ON r.receipt_id=d.receipt_id
      WHERE r.session_id=${work.session_id} AND r.activity_id=${activity.activity_id}) admissions,
    (SELECT count(*) FROM session_v2_tool_effect e JOIN session_v2_provider_turn_receipt r ON r.receipt_id=e.receipt_id
      WHERE r.session_id=${work.session_id} AND r.activity_id=${activity.activity_id}) effects`)
  if (!effectCount || effects.length > work.binding.budget.maxToolCalls || effectCount.admissions !== effects.length || effectCount.effects !== effects.length ||
    effects.some((effect) => !effect.effect_id || !effect.outcome_hash || effect.state !== "settled" && effect.state !== "failed" ||
      !(effect.grant_state === null && effect.grant_receipt_id === null && effect.grant_owner_id === null && effect.grant_version === null ||
        effect.grant_state === "settled" && !!effect.grant_receipt_id?.trim() && !!effect.grant_owner_id?.trim() &&
        effect.grant_version !== null && Number.isSafeInteger(effect.grant_version) && effect.grant_version >= 0)))
    return yield* failure("EVENT_DAG_UNKNOWN")
  if (effects.length) {
    const proof = yield* Effect.serviceOption(WorkToolPolicy.LeafProof)
    if (Option.isNone(proof) || !proof.value.requireEventTerminal) return yield* failure("EVENT_DAG_UNAVAILABLE")
    for (const effect of effects) {
      const known = yield* proof.value.requireEventTerminal(effect.effect_id!)
      if (known.workID !== work.work_id || known.bindingHash !== work.binding_hash || known.admissionID !== effect.admission_id ||
        known.outcomeHash !== effect.outcome_hash || known.toolID !== effect.tool_name) return yield* failure()
    }
  }
  const workspace = authority.placement ? yield* tx.select().from(EventTaskWorkspaceTable).where(and(
    eq(EventTaskWorkspaceTable.event_id, authority.placement.eventID), eq(EventTaskWorkspaceTable.task_id, authority.nodeID),
    eq(EventTaskWorkspaceTable.generation, 0))).get() : undefined
  if (requireWorkspace && authority.placement && (!workspace || workspace.state !== "retained" &&
    !(workspace.state === "reclaimed" && authority.artifactCustody?.cleanup?.state === "collected") || workspace.error !== null ||
    workspace.directory !== authority.placement.workspace.directory || workspace.branch !== authority.placement.workspace.branch ||
    workspace.base_commit !== authority.placement.workspace.baseCommit || !workspace.continuation_ref || workspace.time_settled === null ||
    !authority.artifactCustody || authority.artifactCustody.commit !== workspace.continuation_ref))
    return yield* failure("EVENT_DAG_NOT_READY")
  // The native producer stores known artifact identity separately from dispatch permission;
  // the durable original ref itself must be an immutable commit, never a moving branch tip.
  if (requireWorkspace && workspace && !/^[a-f0-9]{40,64}$/.test(workspace.continuation_ref!)) return yield* failure("EVENT_DAG_NOT_READY")
  const terminal = Schema.decodeUnknownSync(EventWorkDagSchema.Terminal)({ version: 1, workID, sessionID: work.session_id, inputID: work.input_id,
    nodeID: authority.nodeID, controllerID: authority.controllerID, bindingHash: work.binding_hash, sourceHash: root.source_record_hash,
    controlRevision: charges[0]!.control_revision, outcome: work.outcome, activityID: activity.activity_id, finalMessageID: activity.final_message_id,
    // Preserve the original terminal digest projection while validating the complete
    // grant columns above. Additional validation facts must not rewrite old hashes.
    finalMessageHash: Hash.sha256(activity.final_data), providerChainHash: hash(providers), effectChainHash: hash(effects.map((effect) => ({
      admission_id: effect.admission_id, effect_id: effect.effect_id, outcome_hash: effect.outcome_hash,
      state: effect.state, grant_state: effect.grant_state, tool_name: effect.tool_name }))),
    chargedTokens: charges.reduce((sum, charge) => sum + charge.charged_tokens, 0), resultHash: Hash.sha256(text), settledAt: activity.settled_at,
    ...(workspace?.continuation_ref ? { workspaceCommit: workspace.continuation_ref, workspaceRef: workspace.continuation_ref } : {}) })
  if (requireWorkspace && authority.terminal !== undefined && CanonicalJson.stringify(authority.terminal) !== CanonicalJson.stringify(terminal)) return yield* failure("EVENT_DAG_CONFLICT")
  return { terminal, text }
})

export const readTerminal = (tx: WorkAuthority.Transaction, workID: string) => readKnownExecution(tx, workID, true)
/** Trusted artifact producers first consume the same complete provider/usage/effect result.
 * This returns no terminal or controller permission before immutable preservation finishes. */
export const requireKnownExecution = (tx: WorkAuthority.Transaction, workID: string) => readKnownExecution(tx, workID, false).pipe(Effect.asVoid)
