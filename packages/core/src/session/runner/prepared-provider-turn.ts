import type { Model } from "@deepagent-code/llm"
import type { ProtocolAttemptIdentity } from "../../contract/model-protocol"
import type { PreparedCapabilitySnapshotRef } from "../../contract/prepared-turn"
import { CanonicalJson } from "../../util/canonical-json"
import { Hash } from "../../util/hash"

export type Owner = "legacy_aisdk" | "legacy_native" | "v2" | "shadow_v2"
export type ContextReadiness = "ready" | "fallback" | "unavailable"
export type ToolCapability = "supported" | "unsupported" | "unknown"
export type ToolLoweringOutcome = "ok" | "schema_rejected" | "omitted_no_support"

export interface Budget {
  readonly decision: "ok" | "unavailable"
  readonly reason?: "context_limit_unknown" | "context_limit_invalid" | "physical_budget_exceeded"
  readonly estimatedFullRequestTokens: number
  readonly physicalInputBudget: number
  readonly reservedOutputTokens: number
  readonly safetyMargin: number
  readonly provenance: "model_limit" | "host_guard"
}

export interface Input {
  readonly sessionID: string
  readonly requestOrdinal: number
  readonly activityID: string
  readonly providerTurnSeq: number
  readonly owner: Owner
  readonly stableSystemParts: readonly string[]
  readonly volatileSystemParts: readonly string[]
  readonly historyMessages: readonly unknown[]
  readonly historyPromptEpoch: number
  readonly historySourceEndMessageID: string | null
  readonly contextSelectionID: string | null
  readonly contextProjectionHash: string | null
  readonly contextReadiness: ContextReadiness
  readonly contextSelectedRefs: readonly string[]
  readonly toolRegistryIDs: readonly string[]
  readonly toolPermissionFilteredIDs: readonly string[]
  readonly toolFinalOfferedIDs: readonly string[]
  readonly toolDefinitions: unknown
  readonly toolChoice: "auto" | "required" | "none" | null
  readonly toolCapability: ToolCapability
  readonly toolLoweringOutcome: ToolLoweringOutcome
  readonly toolResultReferences: readonly string[]
  readonly samplingModelID: string
  readonly samplingProviderID: string
  readonly samplingMaxOutputTokens?: number
  readonly samplingTemperature?: number
  readonly budget: Budget
  readonly wireRequest?: unknown
  readonly wireRequestHash?: string
  readonly receiptID: string
  readonly providerAttemptID?: string
  readonly userMessageID: string
  readonly assistantMessageID?: string
  readonly preparedAt?: number
  /** C2-04 route/protocol/origin/capability/lowering identity (optional, runtime-record home). */
  readonly protocolAttemptIdentity?: ProtocolAttemptIdentity
  readonly protocolAttemptIdentityHash?: string
  /** C4-08 capability catalog/load snapshot bound at prepare (design §4.1 step 5, §7.5). */
  readonly capabilitySnapshot?: PreparedCapabilitySnapshotRef
}

export interface PreparedProviderTurn {
  readonly session_id: string
  readonly request_ordinal: number
  readonly activity_id: string
  readonly provider_turn_seq: number
  readonly owner: Owner
  readonly system_stable_hash: string
  readonly system_volatile_hash: string
  readonly system_stable_parts: readonly string[]
  readonly system_volatile_parts: readonly string[]
  readonly history_hash: string
  readonly history_prompt_epoch: number
  readonly history_source_end_message_id: string | null
  readonly history_message_count: number
  readonly context_selection_id: string | null
  readonly context_projection_hash: string | null
  readonly context_readiness: ContextReadiness
  readonly context_selected_refs: readonly string[]
  readonly tool_definition_hash: string | null
  readonly tool_registry_ids: readonly string[]
  readonly tool_permission_filtered_ids: readonly string[]
  readonly tool_final_offered_ids: readonly string[]
  readonly tool_choice: "auto" | "required" | "none" | null
  readonly tool_capability: ToolCapability
  readonly tool_lowering_outcome: ToolLoweringOutcome
  readonly tool_result_reference_ids: readonly string[]
  readonly tool_result_reference_count: number
  readonly sampling_model_id: string
  readonly sampling_provider_id: string
  readonly sampling_max_output_tokens: number | undefined
  readonly sampling_temperature: number | undefined
  readonly budget: Budget
  readonly wire_request_hash: string
  readonly request_hash: string
  readonly cache_prefix_hash: string
  readonly volatile_tail_hash: string
  readonly receipt_id: string
  readonly provider_attempt_id: string | undefined
  readonly user_message_id: string
  readonly assistant_message_id: string | undefined
  readonly prepared_at: number
  /** C2-04 route/protocol/origin/capability/lowering identity on the runtime attempt record. */
  readonly protocol_attempt_identity?: ProtocolAttemptIdentity
  readonly protocol_attempt_identity_hash?: string
  /** C4-08 capability catalog/load snapshot on the runtime attempt record (design §7.5). */
  readonly capability_snapshot?: PreparedCapabilitySnapshotRef
  readonly capability_snapshot_hash?: string
}

/**
 * Full prepared attempt identity (design §4.1 step 8). Composes the content
 * identity (`request_hash`) with the C2-04 protocol attempt identity hash and
 * the C4-08 capability snapshot hash so an exact retry is byte-stable only when
 * the payload, the route/protocol/origin/capability/lowering binding AND the
 * capability catalog/load snapshot are identical; a config or catalog drift
 * changes this value and is detected before dispatch.
 */
export function attemptIdentityHash(turn: PreparedProviderTurn): string {
  return Hash.sha256(
    CanonicalJson.stringify({
      request_hash: turn.request_hash,
      ...(turn.protocol_attempt_identity_hash === undefined
        ? {}
        : { protocol_attempt_identity_hash: turn.protocol_attempt_identity_hash }),
      ...(turn.capability_snapshot_hash === undefined
        ? {}
        : { capability_snapshot_hash: turn.capability_snapshot_hash }),
    }),
  )
}

export function prepare(input: Input): PreparedProviderTurn {
  const systemStableParts = [...input.stableSystemParts]
  const systemVolatileParts = [...input.volatileSystemParts]
  const systemStableHash = fingerprint(systemStableParts)
  const systemVolatileHash = fingerprint(systemVolatileParts)
  const historyHash = fingerprint(input.historyMessages)
  const toolDefinitionHash = input.toolFinalOfferedIDs.length === 0 ? null : fingerprint(input.toolDefinitions)
  const toolResultReferenceIDs = sorted(
    [...new Set(input.toolResultReferences)].filter((reference) => reference.length > 0),
  )
  const wireRequestHash = input.wireRequestHash ?? fingerprint(input.wireRequest)
  if (!/^[0-9a-f]{64}$/.test(wireRequestHash)) throw new Error("Prepared provider turn requires a SHA-256 wire hash")
  const fields = {
    session_id: input.sessionID,
    request_ordinal: input.requestOrdinal,
    activity_id: input.activityID,
    provider_turn_seq: input.providerTurnSeq,
    system_stable_hash: systemStableHash,
    system_volatile_hash: systemVolatileHash,
    history_hash: historyHash,
    history_prompt_epoch: input.historyPromptEpoch,
    history_source_end_message_id: input.historySourceEndMessageID,
    context_selection_id: input.contextSelectionID,
    context_projection_hash: input.contextProjectionHash,
    context_readiness: input.contextReadiness,
    context_selected_refs: sorted(input.contextSelectedRefs),
    tool_definition_hash: toolDefinitionHash,
    tool_registry_ids: sorted(input.toolRegistryIDs),
    tool_permission_filtered_ids: sorted(input.toolPermissionFilteredIDs),
    tool_final_offered_ids: sorted(input.toolFinalOfferedIDs),
    tool_choice: input.toolChoice,
    tool_capability: input.toolCapability,
    tool_lowering_outcome: input.toolLoweringOutcome,
    tool_result_reference_ids: toolResultReferenceIDs,
    tool_result_reference_count: toolResultReferenceIDs.length,
    sampling_model_id: input.samplingModelID,
    sampling_provider_id: input.samplingProviderID,
    sampling_max_output_tokens: input.samplingMaxOutputTokens,
    sampling_temperature: input.samplingTemperature,
    budget: input.budget,
    wire_request_hash: wireRequestHash,
  }
  return {
    ...fields,
    owner: input.owner,
    system_stable_parts: systemStableParts,
    system_volatile_parts: systemVolatileParts,
    history_message_count: input.historyMessages.length,
    request_hash: fingerprint(fields),
    cache_prefix_hash: Hash.sha256(`${systemStableHash}:${input.historyPromptEpoch}`),
    volatile_tail_hash: systemVolatileHash,
    receipt_id: input.receiptID,
    provider_attempt_id: input.providerAttemptID,
    user_message_id: input.userMessageID,
    assistant_message_id: input.assistantMessageID,
    prepared_at: input.preparedAt ?? Date.now(),
    ...(input.protocolAttemptIdentityHash === undefined
      ? {}
      : { protocol_attempt_identity_hash: input.protocolAttemptIdentityHash }),
    ...(input.protocolAttemptIdentity === undefined ? {} : { protocol_attempt_identity: input.protocolAttemptIdentity }),
    ...(input.capabilitySnapshot === undefined
      ? {}
      : {
          capability_snapshot: input.capabilitySnapshot,
          capability_snapshot_hash: Hash.sha256(CanonicalJson.stringify(input.capabilitySnapshot)),
        }),
  }
}

export function mergeSystemParts(...groups: ReadonlyArray<ReadonlyArray<string | undefined>>) {
  return groups.flatMap((group) => group.filter((part): part is string => part !== undefined && part.length > 0))
}

// Shared by the session runner and the compaction summary turn so every durable receipt budgets the
// same way; compaction cannot import the runner layer without a module cycle.
export function budget(model: Model): Budget {
  const context = model.route.defaults.limits?.input ?? model.route.defaults.limits?.context
  const output = model.route.defaults.limits?.output ?? 0
  if (!context || !Number.isFinite(context) || context <= 0)
    return {
      decision: "unavailable",
      reason: context === undefined ? "context_limit_unknown" : "context_limit_invalid",
      estimatedFullRequestTokens: 0,
      physicalInputBudget: 0,
      reservedOutputTokens: output,
      safetyMargin: 0,
      provenance: "host_guard",
    }
  return {
    decision: "ok",
    estimatedFullRequestTokens: 0,
    physicalInputBudget: context,
    reservedOutputTokens: output,
    safetyMargin: 0,
    provenance: "model_limit",
  }
}

function fingerprint(value: unknown) {
  return Hash.sha256(CanonicalJson.stringify(value))
}

function sorted(values: readonly string[]) {
  return [...values].sort((a, b) => a.localeCompare(b))
}

export * as PreparedProviderTurn from "./prepared-provider-turn"
