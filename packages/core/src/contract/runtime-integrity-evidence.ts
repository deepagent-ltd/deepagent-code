export * as RuntimeIntegrityEvidenceContract from "./runtime-integrity-evidence"

import { Schema } from "effect"
import { sign, verify } from "node:crypto"
import { contentDigest } from "./digest"
import { NonNegativeInt, PositiveInt } from "../schema"
import { CanonicalJson } from "../util/canonical-json"
import type { PreparedProviderTurn } from "../session/runner/prepared-provider-turn"

/**
 * RI-24 runtime-integrity evidence contract. This is deliberately a digest-only bundle: prompt
 * bodies, tool schemas, permissions and provider responses stay in their existing encrypted or
 * durable stores, while this record proves which exact values were used by one provider attempt.
 */
export const RuntimeIntegrityEvidenceVersion = {
  schema: "runtime-integrity-evidence.v1",
  terminal: 1,
} as const

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export const PromptSource = Schema.Struct({
  source: Schema.String,
  digest: Digest,
})
export type PromptSource = typeof PromptSource.Type

export const ToolDefinition = Schema.Struct({
  toolID: Schema.String,
  definitionDigest: Digest,
})
export type ToolDefinition = typeof ToolDefinition.Type

export const EffectivePermission = Schema.Struct({
  scope: Schema.String,
  rulesDigest: Digest,
})
export type EffectivePermission = typeof EffectivePermission.Type

export const Route = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  protocol: Schema.String,
  origin: Schema.String,
  endpointOriginDigest: Digest,
  capabilityDigest: Digest,
  loweringVersion: PositiveInt,
  protocolRevision: PositiveInt,
})
export type Route = typeof Route.Type

export const Receipt = Schema.Struct({
  kind: Schema.String,
  id: Schema.String,
  digest: Digest,
})
export type Receipt = typeof Receipt.Type

export const Terminal = Schema.Struct({
  status: Schema.Literals([
    "settled",
    "failed_terminal",
    "indeterminate_after_crash",
    "abandoned_before_dispatch",
    "resolved_abandoned",
    "resolved_settled",
  ]),
  outcomeDigest: Digest.pipe(Schema.optional),
  reason: Schema.String.pipe(Schema.optional),
})
export type Terminal = typeof Terminal.Type

export const RuntimeIdentity = Schema.Struct({
  candidateID: Schema.String,
  commit: Schema.String,
  tree: Schema.String,
  packageDigest: Digest,
  schemaDigest: Digest,
  rootCompositionDigest: Digest,
  databaseSchemaDigest: Digest,
  eventSchemaDigest: Digest,
  capabilityManifestDigest: Digest,
})
export type RuntimeIdentity = typeof RuntimeIdentity.Type

export const RuntimeIntegrityEvidence = Schema.Struct({
  schemaVersion: Schema.Literal(RuntimeIntegrityEvidenceVersion.schema),
  sessionID: Schema.String,
  attemptID: Schema.String,
  requestHash: Digest,
  preparedTurnHash: Digest,
  promptSources: Schema.Array(PromptSource),
  toolDefinitions: Schema.Array(ToolDefinition),
  effectivePermissions: Schema.Array(EffectivePermission),
  route: Route,
  receipts: Schema.Array(Receipt),
  physicalCallCount: NonNegativeInt,
  terminal: Terminal,
  identity: RuntimeIdentity,
  issuedAt: Schema.String,
})
export type RuntimeIntegrityEvidence = typeof RuntimeIntegrityEvidence.Type

const SignatureDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/))

/** Ed25519 signature envelope. Private keys never enter this contract or the durable receipt. */
export const SignedRuntimeIntegrityEvidence = Schema.Struct({
  schemaVersion: Schema.Literal("runtime-integrity-evidence-signature.v1"),
  evidence: RuntimeIntegrityEvidence,
  evidenceDigest: Digest,
  algorithm: Schema.Literal("ed25519"),
  keyID: Schema.String.check(Schema.isPattern(/^(?=\S)[\s\S]+$/)),
  signature: SignatureDigest,
})
export type SignedRuntimeIntegrityEvidence = typeof SignedRuntimeIntegrityEvidence.Type

export class RuntimeIntegrityEvidenceError extends Schema.TaggedErrorClass<RuntimeIntegrityEvidenceError>()(
  "RuntimeIntegrityEvidenceError",
  { reason: Schema.String },
) {}

/** Build one evidence record and reject impossible call/terminal combinations before persistence. */
export function makeRuntimeIntegrityEvidence(
  input: Omit<RuntimeIntegrityEvidence, "schemaVersion">,
): RuntimeIntegrityEvidence {
  const evidence = RuntimeIntegrityEvidence.make({
    schemaVersion: RuntimeIntegrityEvidenceVersion.schema,
    ...input,
  })
  if (evidence.terminal.status === "abandoned_before_dispatch" && evidence.physicalCallCount !== 0)
    throw new RuntimeIntegrityEvidenceError({ reason: "abandoned_before_dispatch_requires_zero_physical_calls" })
  if (evidence.terminal.status === "settled" && evidence.physicalCallCount !== 1)
    throw new RuntimeIntegrityEvidenceError({ reason: "settled_attempt_requires_exactly_one_physical_call" })
  if (evidence.physicalCallCount > 1)
    throw new RuntimeIntegrityEvidenceError({ reason: "physical_call_count_exceeds_single_attempt" })
  if (evidence.receipts.length === 0)
    throw new RuntimeIntegrityEvidenceError({ reason: "evidence_requires_at_least_one_receipt" })
  return evidence
}

/** Issuance-time-independent content digest for signatures and candidate binding. */
export function runtimeIntegrityEvidenceDigest(evidence: RuntimeIntegrityEvidence): string {
  const { issuedAt: _, ...stable } = evidence
  return contentDigest(stable)
}

/** Canonical bytes signed by the external key owner. The signature covers both the stable digest and full envelope. */
export function runtimeIntegrityEvidenceSigningPayload(evidence: RuntimeIntegrityEvidence): string {
  return CanonicalJson.stringify({
    schemaVersion: "runtime-integrity-evidence-signature.v1",
    evidenceDigest: runtimeIntegrityEvidenceDigest(evidence),
    evidence,
  })
}

export function signRuntimeIntegrityEvidence(input: {
  readonly evidence: RuntimeIntegrityEvidence
  readonly keyID: string
  readonly privateKeyPem: string
}): SignedRuntimeIntegrityEvidence {
  return SignedRuntimeIntegrityEvidence.make({
    schemaVersion: "runtime-integrity-evidence-signature.v1",
    evidence: input.evidence,
    evidenceDigest: runtimeIntegrityEvidenceDigest(input.evidence),
    algorithm: "ed25519",
    keyID: input.keyID,
    signature: sign(null, Buffer.from(runtimeIntegrityEvidenceSigningPayload(input.evidence)), input.privateKeyPem).toString(
      "hex",
    ),
  })
}

export function verifySignedRuntimeIntegrityEvidence(input: {
  readonly signed: SignedRuntimeIntegrityEvidence
  readonly publicKeyPem: string
}): boolean {
  if (input.signed.evidenceDigest !== runtimeIntegrityEvidenceDigest(input.signed.evidence)) return false
  try {
    return verify(
      null,
      Buffer.from(runtimeIntegrityEvidenceSigningPayload(input.signed.evidence)),
      input.publicKeyPem,
      Buffer.from(input.signed.signature, "hex"),
    )
  } catch {
    return false
  }
}

export function validateRuntimeIntegrityEvidence(
  evidence: RuntimeIntegrityEvidence,
  identity: RuntimeIdentity,
): void {
  if (evidence.identity.candidateID !== identity.candidateID)
    throw new RuntimeIntegrityEvidenceError({ reason: "candidate_identity_mismatch" })
  if (evidence.identity.commit !== identity.commit)
    throw new RuntimeIntegrityEvidenceError({ reason: "commit_identity_mismatch" })
  if (evidence.identity.tree !== identity.tree)
    throw new RuntimeIntegrityEvidenceError({ reason: "tree_identity_mismatch" })
  if (runtimeIntegrityEvidenceDigest(evidence) !== runtimeIntegrityEvidenceDigest({ ...evidence, identity }))
    throw new RuntimeIntegrityEvidenceError({ reason: "runtime_identity_digest_mismatch" })
}

/**
 * Derive the digest-only bundle from the canonical prepared-turn record. The caller supplies the
 * terminal outcome and candidate identity because those facts are only known at settlement/build
 * time; every request-shape field comes from the exact prepared record, never from a second cache.
 */
export function runtimeIntegrityEvidenceFromPreparedTurn(input: {
  readonly prepared: PreparedProviderTurn
  readonly identity: RuntimeIdentity
  readonly terminal: Terminal
  readonly physicalCallCount: number
  readonly receipts?: readonly Receipt[]
  readonly issuedAt?: string
}): RuntimeIntegrityEvidence {
  const protocol = input.prepared.protocol_attempt_identity
  if (!protocol)
    throw new RuntimeIntegrityEvidenceError({ reason: "prepared_turn_missing_protocol_attempt_identity" })
  const toolDigest = input.prepared.tool_definition_hash ?? contentDigest([])
  return makeRuntimeIntegrityEvidence({
    sessionID: input.prepared.session_id,
    attemptID: input.prepared.provider_attempt_id ?? input.prepared.receipt_id,
    requestHash: input.prepared.request_hash,
    preparedTurnHash: input.prepared.prepared_turn_hash,
    promptSources: [
      { source: "system.stable", digest: input.prepared.system_stable_hash },
      { source: "system.volatile", digest: input.prepared.system_volatile_hash },
      { source: "history", digest: input.prepared.history_hash },
      ...(input.prepared.context_projection_hash
        ? [{ source: "context", digest: input.prepared.context_projection_hash }]
        : []),
    ],
    toolDefinitions: input.prepared.tool_final_offered_ids.map((toolID) => ({ toolID, definitionDigest: toolDigest })),
    effectivePermissions: [
      {
        scope: "session",
        rulesDigest: contentDigest(input.prepared.tool_permission_filtered_ids),
      },
    ],
    route: {
      providerID: input.prepared.sampling_provider_id,
      modelID: input.prepared.sampling_model_id,
      protocol: protocol.protocol,
      origin: protocol.originId,
      endpointOriginDigest: protocol.endpointOriginHash,
      capabilityDigest: protocol.capabilityFingerprint,
      loweringVersion: protocol.loweringVersion,
      protocolRevision: protocol.protocolRevision,
    },
    receipts: input.receipts ?? [
      { kind: "provider_turn", id: input.prepared.receipt_id, digest: input.prepared.prepared_turn_hash },
    ],
    physicalCallCount: input.physicalCallCount,
    terminal: input.terminal,
    identity: input.identity,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  })
}
