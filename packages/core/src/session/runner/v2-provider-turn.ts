export * as V2ProviderTurn from "./v2-provider-turn"

import { RequestExecutor } from "@deepagent-code/llm/route"
import { and, eq, inArray, max, or, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Ref, Schema, Stream } from "effect"
import { Database } from "../../database/database"
import { CanonicalJson } from "../../util/canonical-json"
import { Hash } from "../../util/hash"
import { RecoveryCommandContract } from "../../contract/recovery-command"
import type { ProtocolAttemptIdentity } from "../../contract/model-protocol"
import type { PreparedCapabilitySnapshotRef } from "../../contract/prepared-turn"
import { ContextFederationExecutionParity } from "../../context-federation/execution-parity"
import { SessionProviderOwner } from "../../context-federation/provider-owner"
import { SessionProviderAttempt } from "../../context-federation/provider-attempt"
import { SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../../context-federation/session-sql"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { InstallationVersion } from "../../installation/version"
import { Global } from "../../global"
import { SessionSchema } from "../schema"
import { PreparedProviderTurn } from "./prepared-provider-turn"
import { RuntimeIntegrityEvidenceContract } from "../../contract/runtime-integrity-evidence"
import {
  RuntimeIntegrityEvidenceArtifactTable,
  V2ProviderParityBaselineTable,
  V2ProviderParityReceiptTable,
  V2ProviderTurnReceiptTable,
} from "./v2-provider-turn.sql"
import { V2OwnerAuthorization } from "./v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "./v2-owner-authorization.sql"

export const AllowlistVersion = "v2-provider-parity-allowlist.v1"
export const AllowedDifferences = [
  "owner",
  "receipt_id",
  "provider_attempt_id",
  "assistant_message_id",
  "prepared_at",
] as const

const ReleaseQualificationPayload = {
  protocol: "v2-provider-owner-release.v1",
  parityCases: [...ContextFederationExecutionParity.Case.literals].toSorted(),
  evidence: [...ContextFederationExecutionParity.EvidenceKind.literals].toSorted(),
  gates: ["packaged_e3", "upgrade_matrix", "multi_process_takeover", "rollback_kill_switch"].toSorted(),
} as const

// This seal is advanced only with the release gates that ship in the same source change. Runtime
// databases may still name a stricter shadow campaign through DEEPAGENT_CODE_V2_OWNER_CAMPAIGN.
export const ReleaseQualification = {
  ...ReleaseQualificationPayload,
  seal: "fbd00f7b97d920001f3579c3bd3066b9dcf3af6f1cfa9888873e179e49076a01",
}

export interface RequestSealInput {
  readonly wireHash: string
  readonly bodyHash: string
  readonly bodyLength: number
  readonly contentType: string | undefined
}

export interface RequestSeal {
  readonly seal: (input: RequestSealInput) => Effect.Effect<void, unknown>
}

// Context services are keyed by identifier. Keeping this shared protocol key here lets the
// location-scoped V2 runner seal the same final wire boundary as the LLM route executor.
export const CurrentRequestSeal = RequestExecutor.CurrentRequestSeal

export type Receipt = {
  readonly receiptId: string
  readonly sessionId: SessionSchema.ID
  readonly requestOrdinal: number
  readonly activityId: string
  readonly providerTurnSeq: number
  readonly providerAttemptId?: string
  readonly userMessageId: string
  readonly historyPromptEpoch: number
  readonly historySourceEndMessageId?: string
  readonly requestInputHash: string
  readonly providerId: string
  readonly modelId: string
  readonly protocol: string
  readonly ownerMode: "shadow_v2" | "v2"
  readonly ownerToken: string
  readonly state: typeof V2ProviderTurnReceiptTable.$inferSelect.state
  readonly preparedTurnHash?: string
  readonly wireRequestHash?: string
  readonly preparedTurn?: PreparedProviderTurn.PreparedProviderTurn
  readonly outcomeHash?: string
  readonly outcomeArtifact?: readonly unknown[]
  readonly errorCode?: string
  readonly createdAt: number
  readonly dispatchingAt?: number
  readonly firstEventAt?: number
  readonly terminalAt?: number
  readonly integrityEvidence?: RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidence
  readonly integrityEvidenceHash?: string
  readonly integrityEvidenceSignature?: RuntimeIntegrityEvidenceContract.SignedRuntimeIntegrityEvidence
}

export type IntegrityEvidenceArtifact = {
  readonly artifactID: string
  readonly receiptID: string
  readonly sessionID: string
  readonly attemptID: string
  readonly evidenceHash: string
  readonly evidence: RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidence
  readonly signature?: RuntimeIntegrityEvidenceContract.SignedRuntimeIntegrityEvidence
  readonly createdAt: number
  readonly signedAt?: number
}

// Same F-18 diagnostic-fidelity rule as AdmissionError: these cross the prompt boundary to
// logs/CLI, and TaggedErrorClass would otherwise render an empty message.
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("V2ProviderTurn.ConflictError", {
  reason: Schema.String,
}) {
  constructor(props: { readonly reason: string }) {
    super(props)
    this.message = props.reason
  }
}

export class UnsafeRetryError extends Schema.TaggedErrorClass<UnsafeRetryError>()("V2ProviderTurn.UnsafeRetryError", {
  state: Schema.String,
}) {
  constructor(props: { readonly state: string }) {
    super(props)
    this.message = `unsafe retry: latest receipt is ${props.state}`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("V2ProviderTurn.NotFoundError", {}) {}

export type Error =
  | ConflictError
  | UnsafeRetryError
  | NotFoundError
  | SessionProviderAttempt.Error
  | RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError

export type AdmitInput = {
  readonly sessionId: SessionSchema.ID
  readonly userMessageId: string
  readonly activityId?: string
  readonly providerTurnSeq?: number
  readonly historyPromptEpoch: number
  readonly historySourceEndMessageId?: string
  readonly requestInputHash: string
  readonly providerId: string
  readonly modelId: string
  readonly protocol: string
  readonly ownerMode: "shadow_v2" | "v2"
  readonly ownerToken: string
  readonly now?: number
}

export type PrepareInput = {
  readonly receipt: Receipt
  readonly stableSystemParts: readonly string[]
  readonly volatileSystemParts: readonly string[]
  readonly historyMessages: readonly unknown[]
  readonly toolDefinitions: unknown
  readonly toolIDs: readonly string[]
  readonly toolRegistryIDs?: readonly string[]
  readonly toolPermissionFilteredIDs?: readonly string[]
  readonly toolFinalOfferedIDs?: readonly string[]
  readonly toolChoice: "auto" | "required" | "none" | null
  readonly toolResultReferences: readonly string[]
  readonly samplingMaxOutputTokens?: number
  readonly budget: PreparedProviderTurn.Budget
  readonly userMessageID: string
  readonly activityID: string
  readonly providerTurnSeq: number
  readonly contextSelectionID?: string
  readonly contextProjectionHash?: string
  readonly contextReadiness?: PreparedProviderTurn.ContextReadiness
  readonly contextSelectedRefs?: readonly string[]
  readonly toolCapability?: PreparedProviderTurn.ToolCapability
  readonly toolLoweringOutcome?: PreparedProviderTurn.ToolLoweringOutcome
  /** C2-04 route/protocol/origin/capability/lowering identity on the prepared attempt record. */
  readonly protocolAttemptIdentity?: ProtocolAttemptIdentity
  readonly protocolAttemptIdentityHash?: string
  /** C4-08 capability catalog/load snapshot bound at prepare (design §4.1 step 5, §7.5). */
  readonly capabilitySnapshot?: PreparedCapabilitySnapshotRef
}

export type ParityInput = ContextFederationExecutionParity.Observation & {
  readonly campaignId: string
  readonly legacyReceiptId: string
  readonly coreV2ReceiptId: string
  readonly legacyPreparedTurn: PreparedProviderTurn.PreparedProviderTurn
  readonly coreV2PreparedTurn: PreparedProviderTurn.PreparedProviderTurn
  readonly allowlistedDifferences: readonly string[]
  readonly disallowedDifferences: readonly string[]
  readonly now?: number
}

export type Campaign = {
  readonly id: string
  readonly case: ContextFederationExecutionParity.Case
  readonly evidence: readonly ContextFederationExecutionParity.EvidenceKind[]
}

export const CurrentCampaign = Context.Reference<Campaign | undefined>(
  "@deepagent-code/v2/V2ProviderTurn/CurrentCampaign",
  { defaultValue: campaignFromEnv },
)

export const CurrentOwnerCampaign = Context.Reference<string | undefined>(
  "@deepagent-code/v2/V2ProviderTurn/CurrentOwnerCampaign",
  { defaultValue: defaultOwnerCampaign },
)

export interface OwnerAuthorizationInterface {
  readonly authorize: (db: Database.Interface["db"], campaignId?: string) => Effect.Effect<boolean>
}

export type BuildIdentity = {
  readonly subjectCommit: string
  readonly subjectTree: string
  readonly schemaDigest: string
  readonly buildID: string
  readonly packageDigest: string
}

// W0.3: deterministic build identity derived from an installation version. A DEFAULT installation
// has no DEEPAGENT_CODE_V2_BUILD_IDENTITY env, so the owner chain derives its identity from
// InstallationVersion; script/mint-owner-campaign.ts derives the SAME fields from its
// `--build-identity` input, so a minted authorization row qualifies a default install of the
// same version. All fields are hex digests sized to satisfy the
// session_v2_owner_authorization storage guards (40/64 hex).
export function buildIdentityFromVersion(version: string): BuildIdentity {
  const field = (label: string) => Hash.sha256(`${label}\u0000${version}`)
  return {
    subjectCommit: field("subject-commit").slice(0, 40),
    subjectTree: field("subject-tree").slice(0, 40),
    schemaDigest: field("schema-digest"),
    buildID: field("build-id"),
    packageDigest: field("package-digest"),
  }
}

export const CurrentBuildIdentity = Context.Reference<BuildIdentity | undefined>(
  "@deepagent-code/v2/V2ProviderTurn/CurrentBuildIdentity",
  { defaultValue: currentBuildIdentity },
)

/**
 * Host-owned runtime identity resolver. Core deliberately stores a resolver rather than a
 * precomputed value: the resolver executes in the calling Location/root context, so an embedded
 * or maintenance root can never borrow another root's composition digest. Unwired Core test roots
 * remain evidence-optional; the production DeepAgentCode frame provides the resolver explicitly.
 */
export type RuntimeIntegrityIdentityResolver = {
  readonly resolve: (context: Context.Context<never>) => Effect.Effect<
    RuntimeIntegrityEvidenceContract.RuntimeIdentity,
    RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError
  >
}

export const CurrentRuntimeIntegrityIdentity = Context.Reference<RuntimeIntegrityIdentityResolver | undefined>(
  "@deepagent-code/v2/V2ProviderTurn/CurrentRuntimeIntegrityIdentity",
  { defaultValue: () => undefined },
)

// The owner qualification verifier checks authorization signatures against this key only. The
// default is the per-release pinned issuance key (build-time define); tests may provide an ephemeral public key. Local
// dev key discovery is only available through ownerReferencesLayer because it needs a root.
export const CurrentOwnerAuthorizationPublicKey = Context.Reference<string>(
  "@deepagent-code/v2/V2ProviderTurn/CurrentOwnerAuthorizationPublicKey",
  {
    defaultValue: () =>
      process.env.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY?.trim() ||
      V2OwnerAuthorization.PRODUCTION_OWNER_AUTHORIZATION_PUBLIC_KEY,
  },
)

/**
 * Root-aware production values for owner qualification. The Reference default is deliberately
 * path-free: a caller that does not compose this layer can only use the explicit environment key
 * or the pinned production key, never a key discovered from another embedded runtime's home.
 */
export const ownerReferencesLayer = Layer.mergeAll(
  Layer.effect(CurrentBuildIdentity, Effect.sync(currentBuildIdentity)),
  Layer.effect(
    CurrentOwnerAuthorizationPublicKey,
    Effect.map(
      Global.Service,
      (global) =>
        process.env.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY?.trim() ||
        devVerifierPublicKey(global.state) ||
        V2OwnerAuthorization.PRODUCTION_OWNER_AUTHORIZATION_PUBLIC_KEY,
    ),
  ),
)

// §16.3 order 4 history-epoch bridge: when provided, the turn receipt records this lookup's value —
// the durable history-window boundary authority (e.g. the legacy PromptEpoch active row) — as
// `history_prompt_epoch` in the exact-retry identity tuple instead of the ContextEpoch revision,
// which tracks system-context generations, not history windows. Failure contract: a lookup failure
// degrades to the ContextEpoch revision (the pre-seam behavior), so a transient fault never blocks
// the turn; exact retries converge on the existing receipt row before any lookup runs, so replay
// determinism does not depend on this query.
export const CurrentHistoryEpochLookup = Context.Reference<
  ((sessionID: SessionSchema.ID) => Effect.Effect<number | undefined>) | undefined
>("@deepagent-code/v2/V2ProviderTurn/CurrentHistoryEpochLookup", { defaultValue: () => undefined })

export class OwnerAuthorization extends Context.Service<OwnerAuthorization, OwnerAuthorizationInterface>()(
  "@deepagent-code/v2/V2ProviderTurn/OwnerAuthorization",
) {}

export const ownerAuthorizationLayer = Layer.succeed(
  OwnerAuthorization,
  OwnerAuthorization.of({ authorize: ownerQualified }),
)

export type BaselineInput = {
  readonly campaign: Campaign
  readonly legacyReceiptId: string
  readonly preparedTurn: PreparedProviderTurn.PreparedProviderTurn
}

export interface Interface {
  /**
   * Current process owner lease token. A stalled heartbeat rotates the owner to a successor
   * generation, so every consumer MUST read this at use time and never capture it once.
   */
  readonly currentOwnerToken: () => Effect.Effect<string>
  readonly admit: (input: Omit<AdmitInput, "ownerToken">) => Effect.Effect<Receipt, Error>
  readonly seal: (
    receipt: Receipt,
    prepared: PreparedProviderTurn.PreparedProviderTurn,
    input: RequestSealInput,
  ) => Effect.Effect<Receipt, Error>
  readonly markStreaming: (receipt: Receipt) => Effect.Effect<Receipt, Error>
  /**
   * Post-dispatch "failed" is reserved for proven-terminal provider rejections (for example a
   * context-overflow refusal before any generation). Stream failures whose terminal state cannot be
   * proven must go through `quarantine` instead; `failed` always requires an errorCode.
   */
  readonly settle: (input: {
    readonly receipt: Receipt
    readonly outcome: "settled" | "failed"
    readonly outcomeArtifact: readonly unknown[]
    readonly errorCode?: string
  }) => Effect.Effect<Receipt, Error>
  readonly abandon: (receipt: Receipt, errorCode: string) => Effect.Effect<Receipt, Error>
  readonly bindAttempt: (receipt: Receipt, attemptId: string) => Effect.Effect<Receipt, Error>
  readonly quarantine: (
    receipt: Receipt,
    input?: { readonly errorCode?: string; readonly outcomeArtifact?: readonly unknown[] },
  ) => Effect.Effect<Receipt, Error>
  readonly recover: () => Effect.Effect<number, Error>
  readonly get: (receiptId: string) => Effect.Effect<Receipt | undefined>
  readonly recordBaselinePrepared: (input: BaselineInput) => Effect.Effect<void, Error>
  readonly settleBaseline: (input: {
    readonly campaign: Campaign
    readonly legacyReceiptId: string
    readonly outcomeArtifact: readonly unknown[]
    readonly legacyResponseFingerprint: string
  }) => Effect.Effect<void, Error>
  readonly recordParityForReceipt: (input: {
    readonly campaign: Campaign
    readonly receipt: Receipt
  }) => Effect.Effect<boolean, Error>
  readonly recordParity: (input: ParityInput) => Effect.Effect<boolean, Error>
  readonly parityVerified: (campaignId: string) => Effect.Effect<boolean>
  /** Export the exact prepared-turn evidence; non-terminal or identity-incomplete attempts fail closed. */
  readonly exportIntegrityEvidence: (input: {
    readonly receiptId: string
    readonly identity: RuntimeIntegrityEvidenceContract.RuntimeIdentity
  }) => Effect.Effect<RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidence, Error | RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError>
  /** Persist the exported evidence exactly once against its terminal receipt. */
  readonly persistIntegrityEvidence: (input: {
    readonly receiptId: string
    readonly identity: RuntimeIntegrityEvidenceContract.RuntimeIdentity
  }) => Effect.Effect<RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidence, Error | RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError>
  /** Attach one externally signed envelope to an already persisted evidence bundle. */
  readonly persistSignedIntegrityEvidence: (input: {
    readonly receiptId: string
    readonly signed: RuntimeIntegrityEvidenceContract.SignedRuntimeIntegrityEvidence
    readonly publicKeyPem: string
  }) => Effect.Effect<RuntimeIntegrityEvidenceContract.SignedRuntimeIntegrityEvidence, Error | RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError>
  /** Read an independently retained evidence artifact by its content-addressed id. */
  readonly getIntegrityEvidenceArtifact: (artifactID: string) => Effect.Effect<IntegrityEvidenceArtifact | undefined>
  /** Read a bounded, creation-ordered artifact page for release-ledger generation. */
  readonly listIntegrityEvidenceArtifacts: (input?: { readonly limit?: number }) => Effect.Effect<
    readonly IntegrityEvidenceArtifact[],
    Error
  >
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/V2ProviderTurn") {}

export type LayerOptions = {
  readonly ownerToken?: string
  readonly leaseMs?: number
}

export const layerWith = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const owners = yield* SessionProviderOwner.Service
      // Mutable process-level owner identity. A token captured once at layer build can be fenced by
      // lease expiry — a heartbeat gap past LeaseMs (stalled event loop, long DB wait) — while the
      // process keeps running. Treating that as terminal latched `healthy` false forever and bricked
      // every later turn. Instead the heartbeat rotates to a successor generation and terminalizes
      // the fenced generation's in-flight receipts, mirroring ContextFederationProviderOwnerRuntime
      // (the twin maintenance loop in deepagent-code, which already recovers this way).
      const ownerBase = options.ownerToken ?? `v2:${crypto.randomUUID()}`
      const leaseMs = options.leaseMs ?? envOwnerLeaseMs()
      const owner = yield* Ref.make<{ readonly token: string; readonly generation: number }>({
        token: ownerBase,
        generation: 0,
      })
      yield* owners.register({ ownerToken: ownerBase, leaseMs }).pipe(Effect.orDie)
      const healthy = yield* Ref.make(true)
      const currentOwnerToken = () => Ref.get(owner).pipe(Effect.map((state) => state.token))
      yield* Effect.addFinalizer(() =>
        currentOwnerToken().pipe(Effect.flatMap((token) => owners.release({ ownerToken: token })), Effect.ignore),
      )

      const requireHealthy = Effect.filterOrFail(
        Ref.get(healthy),
        (value) => value,
        () => new ConflictError({ reason: "v2_provider_owner_not_healthy" }),
      )

      const get = Effect.fn("V2ProviderTurn.get")(function* (receiptId: string) {
        const row = yield* db
          .select()
          .from(V2ProviderTurnReceiptTable)
          .where(eq(V2ProviderTurnReceiptTable.receipt_id, receiptId))
          .get()
          .pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      })

      /**
       * Store evidence independently from the mutable receipt projection. The artifact id is the
       * evidence digest, so a retry either observes the exact same bytes or gets a typed conflict;
       * it can never overwrite an audit record belonging to another receipt.
       */
      const persistIntegrityEvidenceArtifact = Effect.fn("V2ProviderTurn.persistIntegrityEvidenceArtifact")(function* (input: {
        readonly receiptId: string
        readonly evidence: RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidence
        readonly evidenceHash: string
        readonly signed?: RuntimeIntegrityEvidenceContract.SignedRuntimeIntegrityEvidence
      }) {
        const artifactID = `rie_${input.evidenceHash}`
        const row = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const existing = yield* tx
                  .select()
                  .from(RuntimeIntegrityEvidenceArtifactTable)
                  .where(eq(RuntimeIntegrityEvidenceArtifactTable.artifact_id, artifactID))
                  .get()
                if (existing) {
                  if (
                    existing.receipt_id !== input.receiptId ||
                    existing.evidence_hash !== input.evidenceHash ||
                    CanonicalJson.stringify(existing.evidence) !== CanonicalJson.stringify(input.evidence)
                  )
                    return yield* new ConflictError({ reason: "v2_integrity_evidence_artifact_conflict" })
                  if (input.signed !== undefined) {
                    if (existing.signature !== null && existing.signature !== undefined) {
                      if (CanonicalJson.stringify(existing.signature) !== CanonicalJson.stringify(input.signed))
                        return yield* new ConflictError({ reason: "v2_integrity_evidence_artifact_signature_conflict" })
                    } else {
                      const signed = yield* tx
                        .update(RuntimeIntegrityEvidenceArtifactTable)
                        .set({ signature: input.signed, signed_at: Date.now() })
                        .where(
                          and(
                            eq(RuntimeIntegrityEvidenceArtifactTable.artifact_id, artifactID),
                            sql`${RuntimeIntegrityEvidenceArtifactTable.signature} IS NULL`,
                          ),
                        )
                        .returning()
                        .get()
                      if (!signed)
                        return yield* new ConflictError({ reason: "v2_integrity_evidence_artifact_signature_cas_lost" })
                      return signed
                    }
                  }
                  return existing
                }
                const created = yield* tx
                  .insert(RuntimeIntegrityEvidenceArtifactTable)
                  .values({
                    artifact_id: artifactID,
                    receipt_id: input.receiptId,
                    session_id: input.evidence.sessionID,
                    attempt_id: input.evidence.attemptID,
                    evidence_hash: input.evidenceHash,
                    evidence: input.evidence,
                    ...(input.signed === undefined ? {} : { signature: input.signed, signed_at: Date.now() }),
                    created_at: Date.now(),
                  })
                  .returning()
                  .get()
                return created
              }),
            { behavior: "immediate" },
          )
          .pipe(preserveErrors)
        return fromIntegrityEvidenceArtifactRow(row)
      })

      const getIntegrityEvidenceArtifact = Effect.fn("V2ProviderTurn.getIntegrityEvidenceArtifact")(function* (
        artifactID: string,
      ) {
        const row = yield* db
          .select()
          .from(RuntimeIntegrityEvidenceArtifactTable)
          .where(eq(RuntimeIntegrityEvidenceArtifactTable.artifact_id, artifactID))
          .get()
          .pipe(Effect.orDie)
        return row ? fromIntegrityEvidenceArtifactRow(row) : undefined
      })

      const listIntegrityEvidenceArtifacts = Effect.fn("V2ProviderTurn.listIntegrityEvidenceArtifacts")(function* (
        input: { readonly limit?: number } = {},
      ) {
        const limit = input.limit ?? 10_000
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
          return yield* new ConflictError({ reason: "v2_integrity_evidence_artifact_limit_invalid" })
        const rows = yield* db
          .select()
          .from(RuntimeIntegrityEvidenceArtifactTable)
          .orderBy(sql`${RuntimeIntegrityEvidenceArtifactTable.created_at} ASC`, sql`${RuntimeIntegrityEvidenceArtifactTable.artifact_id} ASC`)
          .limit(limit)
          .all()
          .pipe(Effect.orDie)
        return rows.map(fromIntegrityEvidenceArtifactRow)
      })

      const exportIntegrityEvidence = Effect.fn("V2ProviderTurn.exportIntegrityEvidence")(function* (input: {
        readonly receiptId: string
        readonly identity: RuntimeIntegrityEvidenceContract.RuntimeIdentity
      }) {
        const receipt = yield* get(input.receiptId)
        if (!receipt) return yield* new NotFoundError()
        if (receipt.integrityEvidence) {
          RuntimeIntegrityEvidenceContract.validateRuntimeIntegrityEvidence(receipt.integrityEvidence, input.identity)
          return receipt.integrityEvidence
        }
        if (!receipt.preparedTurn)
          return yield* new RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError({
            reason: "receipt_has_no_prepared_turn",
          })
        const terminal =
          receipt.state === "settled"
            ? {
                status: "settled" as const,
                ...(receipt.outcomeHash ? { outcomeDigest: receipt.outcomeHash } : {}),
              }
            : receipt.state === "failed"
              ? {
                  status: "failed_terminal" as const,
                  ...(receipt.errorCode ? { reason: receipt.errorCode } : {}),
                }
              : receipt.state === "indeterminate_after_crash"
                ? { status: "indeterminate_after_crash" as const, reason: receipt.errorCode }
                : yield* new RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError({
                    reason: "receipt_is_not_terminal",
                  })
        return RuntimeIntegrityEvidenceContract.runtimeIntegrityEvidenceFromPreparedTurn({
          prepared: receipt.preparedTurn,
          identity: input.identity,
          terminal,
          physicalCallCount: receipt.state === "settled" || receipt.state === "failed" || receipt.state === "indeterminate_after_crash" ? 1 : 0,
        })
      })

      const persistIntegrityEvidence = Effect.fn("V2ProviderTurn.persistIntegrityEvidence")(function* (input: {
        readonly receiptId: string
        readonly identity: RuntimeIntegrityEvidenceContract.RuntimeIdentity
      }) {
        const evidence = yield* exportIntegrityEvidence(input)
        const evidenceHash = RuntimeIntegrityEvidenceContract.runtimeIntegrityEvidenceDigest(evidence)
        const row = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const current = yield* tx
                  .select()
                  .from(V2ProviderTurnReceiptTable)
                  .where(eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptId))
                  .get()
                if (!current) return yield* new NotFoundError()
                if (!["settled", "failed", "indeterminate_after_crash"].includes(current.state))
                  return yield* new RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError({
                    reason: "receipt_is_not_terminal",
                  })
                if (current.integrity_evidence_hash !== null) {
                  if (current.integrity_evidence_hash !== evidenceHash)
                    return yield* new ConflictError({ reason: "v2_integrity_evidence_conflict" })
                  return current
                }
                const stored = yield* tx
                  .update(V2ProviderTurnReceiptTable)
                  .set({ integrity_evidence: evidence, integrity_evidence_hash: evidenceHash })
                  .where(
                    and(
                      eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptId),
                      sql`${V2ProviderTurnReceiptTable.integrity_evidence_hash} IS NULL`,
                      inArray(V2ProviderTurnReceiptTable.state, ["settled", "failed", "indeterminate_after_crash"]),
                    ),
                  )
                  .returning()
                  .get()
                if (stored) return stored
                const raced = yield* tx
                  .select()
                  .from(V2ProviderTurnReceiptTable)
                  .where(eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptId))
                  .get()
                if (!raced) return yield* new NotFoundError()
                if (raced.integrity_evidence_hash !== evidenceHash)
                  return yield* new ConflictError({ reason: "v2_integrity_evidence_conflict" })
                return raced
              }),
            { behavior: "immediate" },
          )
          .pipe(preserveErrors)
        const persisted = fromRow(row).integrityEvidence ?? evidence
        yield* persistIntegrityEvidenceArtifact({
          receiptId: input.receiptId,
          evidence: persisted,
          evidenceHash,
        })
        return persisted
      })

      const persistSignedIntegrityEvidence = Effect.fn("V2ProviderTurn.persistSignedIntegrityEvidence")(function* (input: {
        readonly receiptId: string
        readonly signed: RuntimeIntegrityEvidenceContract.SignedRuntimeIntegrityEvidence
        readonly publicKeyPem: string
      }) {
        if (!RuntimeIntegrityEvidenceContract.verifySignedRuntimeIntegrityEvidence(input))
          return yield* new RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError({
            reason: "runtime_integrity_evidence_signature_invalid",
          })
        yield* persistIntegrityEvidence({ receiptId: input.receiptId, identity: input.signed.evidence.identity })
        const row = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const current = yield* tx
                  .select()
                  .from(V2ProviderTurnReceiptTable)
                  .where(eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptId))
                  .get()
                if (!current) return yield* new NotFoundError()
                if (current.integrity_evidence_hash !== input.signed.evidenceDigest)
                  return yield* new ConflictError({ reason: "v2_integrity_evidence_signature_hash_mismatch" })
                if (current.integrity_evidence_signature) {
                  if (
                    CanonicalJson.stringify(current.integrity_evidence_signature) !==
                    CanonicalJson.stringify(input.signed)
                  )
                    return yield* new ConflictError({ reason: "v2_integrity_evidence_signature_conflict" })
                }
                const artifact = yield* tx
                  .select()
                  .from(RuntimeIntegrityEvidenceArtifactTable)
                  .where(eq(RuntimeIntegrityEvidenceArtifactTable.artifact_id, `rie_${input.signed.evidenceDigest}`))
                  .get()
                if (!artifact) return yield* new ConflictError({ reason: "v2_integrity_evidence_artifact_missing" })
                if (artifact.receipt_id !== input.receiptId)
                  return yield* new ConflictError({ reason: "v2_integrity_evidence_artifact_receipt_conflict" })
                if (CanonicalJson.stringify(artifact.evidence) !== CanonicalJson.stringify(input.signed.evidence))
                  return yield* new ConflictError({ reason: "v2_integrity_evidence_artifact_content_conflict" })
                if (artifact.signature) {
                  if (CanonicalJson.stringify(artifact.signature) !== CanonicalJson.stringify(input.signed))
                    return yield* new ConflictError({ reason: "v2_integrity_evidence_artifact_signature_conflict" })
                } else {
                  const attached = yield* tx
                    .update(RuntimeIntegrityEvidenceArtifactTable)
                    .set({ signature: input.signed, signed_at: Date.now() })
                    .where(
                      and(
                        eq(RuntimeIntegrityEvidenceArtifactTable.artifact_id, `rie_${input.signed.evidenceDigest}`),
                        sql`${RuntimeIntegrityEvidenceArtifactTable.signature} IS NULL`,
                      ),
                    )
                    .returning()
                    .get()
                  if (!attached)
                    return yield* new ConflictError({ reason: "v2_integrity_evidence_artifact_signature_cas_lost" })
                }
                if (current.integrity_evidence_signature) return current
                const attachedReceipt = yield* tx
                  .update(V2ProviderTurnReceiptTable)
                  .set({ integrity_evidence_signature: input.signed })
                  .where(
                    and(
                      eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptId),
                      eq(V2ProviderTurnReceiptTable.integrity_evidence_hash, input.signed.evidenceDigest),
                      sql`${V2ProviderTurnReceiptTable.integrity_evidence_signature} IS NULL`,
                    ),
                  )
                  .returning()
                  .get()
                if (!attachedReceipt)
                  return yield* new ConflictError({ reason: "v2_integrity_evidence_signature_cas_lost" })
                return attachedReceipt
              }),
            { behavior: "immediate" },
          )
          .pipe(preserveErrors)
        return fromRow(row).integrityEvidenceSignature ?? input.signed
      })

      const admit = Effect.fn("V2ProviderTurn.admit")(function* (input: Omit<AdmitInput, "ownerToken">) {
        yield* requireHealthy
        const ownerToken = yield* currentOwnerToken()
        return yield* db
          .transaction((tx) => admitInTransaction(tx, input, ownerToken), { behavior: "immediate" })
          .pipe(preserveErrors)
      })

      const transition = (input: {
        readonly receipt: Receipt
        readonly from: readonly Receipt["state"][]
        readonly state: Receipt["state"]
        readonly preparedTurn?: PreparedProviderTurn.PreparedProviderTurn
        readonly outcomeHash?: string
        readonly outcomeArtifact?: readonly unknown[]
        readonly errorCode?: string
        readonly now?: number
      }) =>
        Effect.gen(function* () {
          yield* requireHealthy
          // A receipt's lifecycle belongs to the generation that admitted it. Resolve the owner from
          // the receipt itself, not the process-current token: after a rotation the old generation's
          // in-flight receipt must be terminalized by `recover` (not silently transitioned by the new
          // generation), and the lease-liveness check below then fails closed on the fenced token.
          const ownerToken = input.receipt.ownerToken
          return yield* db.transaction(
            (tx) =>
              Effect.gen(function* () {
                const observedAt = yield* SessionProviderOwner.observedAtInTransaction(tx)
                const owner = yield* tx
                  .select({ token: SessionProviderOwnerLeaseTable.owner_token })
                  .from(SessionProviderOwnerLeaseTable)
                  .where(
                    and(
                      eq(SessionProviderOwnerLeaseTable.owner_token, ownerToken),
                      sql`${SessionProviderOwnerLeaseTable.released_at} IS NULL`,
                      sql`${SessionProviderOwnerLeaseTable.lease_expires_at} > ${observedAt}`,
                    ),
                  )
                  .get()
                if (!owner) return yield* new ConflictError({ reason: "v2_provider_owner_lease_not_live" })
                const row = yield* tx
                  .update(V2ProviderTurnReceiptTable)
                  .set({
                    state: input.state,
                    ...(input.preparedTurn
                      ? {
                          // W8: the durable canonical hash is the identity-folded
                          // `sha256(request_hash + protocolAttemptIdentityHash)` (design §4.1 step 8),
                          // NOT the raw request hash — the audit's DEFECT 3 fixed here.
                          prepared_turn_hash: input.preparedTurn.prepared_turn_hash,
                          wire_request_hash: input.preparedTurn.wire_request_hash,
                          prepared_turn: input.preparedTurn,
                          dispatching_at: observedAt,
                        }
                      : {}),
                    ...(input.state === "streaming" ? { first_event_at: observedAt } : {}),
                    ...(input.outcomeHash ? { outcome_hash: input.outcomeHash } : {}),
                    ...(input.outcomeArtifact ? { outcome_artifact: input.outcomeArtifact } : {}),
                    ...(input.errorCode ? { error_code: input.errorCode } : {}),
                    ...(["settled", "failed", "indeterminate_after_crash"].includes(input.state)
                      ? { terminal_at: observedAt }
                      : {}),
                  })
                  .where(
                    and(
                      eq(V2ProviderTurnReceiptTable.receipt_id, input.receipt.receiptId),
                      eq(V2ProviderTurnReceiptTable.owner_token, ownerToken),
                      inArray(V2ProviderTurnReceiptTable.state, [...input.from]),
                    ),
                  )
                  .returning()
                  .get()
                if (!row) return yield* new ConflictError({ reason: "v2_receipt_cas_lost" })
                if (row.provider_attempt_id) {
                  const sync = (attempt: SessionProviderAttempt.TransitionInput) =>
                    SessionProviderAttempt.transitionInTransaction(tx, attempt).pipe(
                      Effect.catch(
                        (error): Effect.Effect<SessionProviderAttempt.Attempt, Error> =>
                          isError(error)
                            ? Effect.fail(new ConflictError({ reason: "v2_provider_attempt_sync_conflict" }))
                            : Effect.die(error),
                      ),
                    )
                  const attemptId = row.provider_attempt_id
                  if (input.state === "dispatching" && input.preparedTurn) {
                    yield* sync({
                      attemptId,
                      expectedOwnerToken: ownerToken,
                      from: ["prepared"],
                      to: "prepared",
                      now: observedAt,
                      preparedTurnHash: input.preparedTurn.prepared_turn_hash,
                      wireRequestHash: input.preparedTurn.wire_request_hash,
                    })
                    yield* sync({
                      attemptId,
                      expectedOwnerToken: ownerToken,
                      from: ["prepared"],
                      to: "dispatching",
                      now: observedAt,
                    })
                  } else if (input.state === "streaming") {
                    yield* sync({
                      attemptId,
                      expectedOwnerToken: ownerToken,
                      from: ["dispatching"],
                      to: "streaming",
                      now: observedAt,
                      firstEvent: true,
                    })
                  } else if (input.from.includes("preparing") && input.state === "failed") {
                    yield* sync({
                      attemptId,
                      expectedOwnerToken: ownerToken,
                      from: ["prepared"],
                      to: "failed",
                      now: observedAt,
                      errorCode: input.errorCode ?? "turn_aborted_before_dispatch",
                    })
                  } else if (input.state === "settled" || input.state === "failed") {
                    yield* sync({
                      attemptId,
                      expectedOwnerToken: ownerToken,
                      from: ["dispatching", "streaming"],
                      to: input.state,
                      now: observedAt,
                      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
                    })
                  } else if (input.state === "indeterminate_after_crash") {
                    // Live-owner quarantine carries the receipt's stream-failure fingerprint
                    // (`*_stream_failed:*` / consumer cancellation); `process_recovery` stays
                    // reserved for the crash recovery path with a recovery owner.
                    yield* sync({
                      attemptId,
                      expectedOwnerToken: ownerToken,
                      from: ["dispatching", "streaming"],
                      to: "indeterminate_after_crash",
                      now: observedAt,
                      errorCode: input.errorCode ?? "consumer_cancelled_after_dispatch",
                    })
                  }
                }
                // W2 — a terminal receipt carries its durable recovery descriptor in the SAME
                // transaction (settled / failed / indeterminate_after_crash).
                if (["settled", "failed", "indeterminate_after_crash"].includes(input.state)) {
                  yield* writeTurnTerminalDescriptor(tx, row, observedAt)
                }
                return fromRow(row)
              }),
            { behavior: "immediate" },
          )
        }).pipe(preserveErrors)

      // W8 — the seal is where the prepared turn is generated and bound (the stream's
      // `CurrentRequestSeal` closure prepares from the exact sealed wire hash and hands it to this
      // transition): the receipt MUTATES from `preparing` to `dispatching` carrying the full
      // prepared turn (protocol attempt identity + the identity-folded canonical `prepared_turn_hash`),
      // so from dispatch onward the drift/retry identity is the W8 canonical, never the raw request
      // hash (audit DEFECT 3).
      const seal = (receipt: Receipt, prepared: PreparedProviderTurn.PreparedProviderTurn, input: RequestSealInput) => {
        if (prepared.receipt_id !== receipt.receiptId || prepared.wire_request_hash !== input.wireHash)
          return Effect.fail(new ConflictError({ reason: "v2_wire_seal_binding_mismatch" }))
        return transition({ receipt, from: ["preparing"], state: "dispatching", preparedTurn: prepared })
      }
      const markStreaming = (receipt: Receipt) => transition({ receipt, from: ["dispatching"], state: "streaming" })
      const settle = (input: {
        readonly receipt: Receipt
        readonly outcome: "settled" | "failed"
        readonly outcomeArtifact: readonly unknown[]
        readonly errorCode?: string
      }) => {
        if (input.outcome === "failed" && !input.errorCode)
          return Effect.fail(new ConflictError({ reason: "v2_receipt_failed_requires_error_code" }))
        return transition({
          receipt: input.receipt,
          from: ["dispatching", "streaming"],
          state: input.outcome,
          outcomeHash: Hash.sha256(CanonicalJson.stringify(input.outcomeArtifact)),
          outcomeArtifact: input.outcomeArtifact,
          errorCode: input.errorCode,
        })
      }
      const abandon = (receipt: Receipt, errorCode: string) =>
        transition({ receipt, from: ["preparing"], state: "failed", errorCode })
      const bindAttempt = Effect.fn("V2ProviderTurn.bindAttempt")(function* (receipt: Receipt, attemptId: string) {
        yield* requireHealthy
        return yield* db
          .transaction((tx) => bindAttemptInTransaction(tx, receipt, attemptId), { behavior: "immediate" })
          .pipe(preserveErrors)
      })
      const quarantine = (
        receipt: Receipt,
        input?: { readonly errorCode?: string; readonly outcomeArtifact?: readonly unknown[] },
      ) => {
        return transition({
          receipt,
          from: ["dispatching", "streaming"],
          state: "indeterminate_after_crash",
          errorCode: input?.errorCode ?? "consumer_cancelled_after_dispatch",
          ...(input?.outcomeArtifact === undefined
            ? {}
            : {
                outcomeHash: Hash.sha256(CanonicalJson.stringify(input.outcomeArtifact)),
                outcomeArtifact: input.outcomeArtifact,
              }),
        })
      }

      const recover = Effect.fn("V2ProviderTurn.recover")(function* () {
        yield* requireHealthy
        const ownerToken = yield* currentOwnerToken()
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const observedAt = yield* SessionProviderOwner.observedAtInTransaction(tx)
                const rows = yield* tx
                  .select()
                  .from(V2ProviderTurnReceiptTable)
                  .leftJoin(
                    SessionProviderAttemptTable,
                    eq(V2ProviderTurnReceiptTable.provider_attempt_id, SessionProviderAttemptTable.attempt_id),
                  )
                  .leftJoin(
                    SessionProviderOwnerLeaseTable,
                    eq(V2ProviderTurnReceiptTable.owner_token, SessionProviderOwnerLeaseTable.owner_token),
                  )
                  .where(
                    and(
                      inArray(V2ProviderTurnReceiptTable.state, ["preparing", "dispatching", "streaming"]),
                      sql`${V2ProviderTurnReceiptTable.owner_token} != ${ownerToken}`,
                      or(
                        sql`${SessionProviderOwnerLeaseTable.owner_token} IS NULL`,
                        sql`${SessionProviderOwnerLeaseTable.released_at} IS NOT NULL`,
                        sql`${SessionProviderOwnerLeaseTable.lease_expires_at} <= ${observedAt}`,
                      ),
                    ),
                  )
                  .all()
                const recovered = yield* Effect.forEach(
                  rows,
                  (joined) =>
                    Effect.gen(function* () {
                      const row = joined.session_v2_provider_turn_receipt
                      const attempt = joined.session_provider_attempt
                      if (
                        !attempt ||
                        row.provider_attempt_id !== attempt.attempt_id ||
                        row.session_id !== attempt.session_id ||
                        row.activity_id !== attempt.activity_id ||
                        row.provider_turn_seq !== attempt.provider_turn_seq ||
                        row.request_input_hash !== attempt.request_hash ||
                        row.provider_id !== attempt.provider_id ||
                        row.owner_token !== attempt.owner_token ||
                        row.prepared_turn_hash !== attempt.prepared_turn_hash ||
                        row.wire_request_hash !== attempt.wire_request_hash ||
                        (row.state === "preparing" && attempt.state !== "prepared") ||
                        (row.state === "dispatching" && attempt.state !== "dispatching") ||
                        (row.state === "streaming" && attempt.state !== "streaming")
                      )
                        return yield* new ConflictError({ reason: "v2_recovery_receipt_attempt_binding_conflict" })
                      const terminalState = row.state === "preparing" ? "failed" : "indeterminate_after_crash"
                      yield* SessionProviderAttempt.recoverExactInTransaction(tx, {
                        sessionId: SessionSchema.ID.make(row.session_id),
                        staleOwnerToken: row.owner_token,
                        recoveryOwnerToken: ownerToken,
                        undispatchedAttemptIds: row.state === "preparing" ? [attempt.attempt_id] : [],
                        startedAttemptIds: row.state === "preparing" ? [] : [attempt.attempt_id],
                        now: observedAt,
                      })
                      const winner = yield* tx
                        .update(V2ProviderTurnReceiptTable)
                        .set({
                          state: terminalState,
                          error_code:
                            row.state === "preparing" ? "owner_lost_before_dispatch" : "owner_lost_after_dispatch",
                          terminal_at: observedAt,
                        })
                        .where(
                          and(
                            eq(V2ProviderTurnReceiptTable.receipt_id, row.receipt_id),
                            eq(V2ProviderTurnReceiptTable.provider_attempt_id, attempt.attempt_id),
                            eq(V2ProviderTurnReceiptTable.owner_token, row.owner_token),
                            eq(V2ProviderTurnReceiptTable.state, row.state),
                          ),
                        )
                        .returning({ receiptId: V2ProviderTurnReceiptTable.receipt_id })
                        .get()
                      if (!winner) return yield* new ConflictError({ reason: "v2_recovery_receipt_cas_lost" })
                      yield* writeTurnTerminalDescriptor(tx, { ...row, state: terminalState }, observedAt)
                      return winner
                    }),
                  { concurrency: 1 },
                )
                return recovered.filter(Boolean).length
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      })

      yield* recover().pipe(Effect.orDie)

      // Heartbeat maintenance. A heartbeat gap past the lease (stalled event loop, long DB wait)
      // fences the current token; that is correct fencing of an unknown-outcome owner, NOT a reason
      // to brick the process. Rotate to a successor generation, terminalize the fenced generation's
      // in-flight receipts through the same `recover` path, and keep serving. `healthy` never latches
      // false here — only an unrecoverable maintenance defect would stop the loop.
      yield* Effect.gen(function* () {
        while (yield* Ref.get(healthy)) {
          const beat = yield* owners.heartbeat({ ownerToken: (yield* Ref.get(owner)).token, leaseMs }).pipe(Effect.exit)
          if (Exit.isFailure(beat)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(beat.cause))
            if (
              error instanceof SessionProviderOwner.ConflictError &&
              error.reason === "provider_owner_lease_not_live"
            ) {
              const generation = (yield* Ref.get(owner)).generation + 1
              const token = `${ownerBase}:gen-${generation}:${crypto.randomUUID()}`
              const registered = yield* owners
                .register({ ownerToken: token, leaseMs, successor: true })
                .pipe(Effect.exit)
              if (Exit.isSuccess(registered)) {
                yield* Ref.set(owner, { token, generation })
                yield* Effect.logInfo(`v2 provider owner generation rotated: generation=${generation}`)
                yield* recover().pipe(Effect.ignore)
              } else
                yield* Effect.logError(`v2 provider owner rotation failed: ${Cause.pretty(registered.cause)}`)
            } else yield* Effect.logError(`v2 provider owner heartbeat failed; retrying: ${Cause.pretty(beat.cause)}`)
          }
          yield* Effect.sleep(Duration.millis(Math.max(1, Math.floor(leaseMs / 3))))
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logError(`v2 provider owner maintenance failed: ${Cause.pretty(cause)}`)),
        Effect.forkScoped,
      )

      const recordBaselinePrepared = Effect.fn("V2ProviderTurn.recordBaselinePrepared")(function* (
        input: BaselineInput,
      ) {
        yield* requireHealthy
        yield* db
          .transaction((tx) => recordBaselinePreparedInTransaction(tx, input), { behavior: "immediate" })
          .pipe(preserveErrors)
      })

      const settleBaseline = Effect.fn("V2ProviderTurn.settleBaseline")(function* (input: {
        readonly campaign: Campaign
        readonly legacyReceiptId: string
        readonly outcomeArtifact: readonly unknown[]
        readonly legacyResponseFingerprint: string
      }) {
        yield* requireHealthy
        yield* db
          .transaction((tx) => settleBaselineInTransaction(tx, input), { behavior: "immediate" })
          .pipe(preserveErrors)
      })

      const recordParity = Effect.fn("V2ProviderTurn.recordParity")(function* (input: ParityInput) {
        const differences = preparedTurnDifferences(input.legacyPreparedTurn, input.coreV2PreparedTurn)
        const allowlist = new Set<string>(AllowedDifferences)
        const allowlistedDifferences = differences.filter((field) => allowlist.has(field))
        const disallowedDifferences = differences.filter((field) => !allowlist.has(field))
        if (
          CanonicalJson.stringify([...input.allowlistedDifferences].toSorted()) !==
            CanonicalJson.stringify(allowlistedDifferences) ||
          CanonicalJson.stringify([...input.disallowedDifferences].toSorted()) !==
            CanonicalJson.stringify(disallowedDifferences)
        ) {
          return yield* new ConflictError({ reason: "v2_parity_diff_claim_mismatch" })
        }
        const fields = {
          campaign_id: input.campaignId,
          case_name: input.case,
          legacy_receipt_id: input.legacyReceiptId,
          core_v2_receipt_id: input.coreV2ReceiptId,
          legacy_request_hash: input.legacyRequestHash,
          core_v2_request_hash: input.coreV2RequestHash,
          legacy_outcome_hash: input.legacyOutcomeHash,
          core_v2_outcome_hash: input.coreV2OutcomeHash,
          legacy_prepared_turn: input.legacyPreparedTurn,
          core_v2_prepared_turn: input.coreV2PreparedTurn,
          diff_artifact: differences,
          allowlist_version: AllowlistVersion,
          allowlisted_differences: allowlistedDifferences,
          disallowed_differences: disallowedDifferences,
          evidence: [...input.evidence].toSorted(),
          verified:
            input.legacyRequestHash === input.coreV2RequestHash &&
            input.legacyOutcomeHash === input.coreV2OutcomeHash &&
            disallowedDifferences.length === 0,
        }
        const receiptHash = Hash.sha256(CanonicalJson.stringify(fields))
        const existing = yield* db
          .select()
          .from(V2ProviderParityReceiptTable)
          .where(
            and(
              eq(V2ProviderParityReceiptTable.campaign_id, input.campaignId),
              eq(V2ProviderParityReceiptTable.case_name, input.case),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (existing) {
          if (existing.receipt_hash !== receiptHash)
            return yield* new ConflictError({ reason: "v2_parity_receipt_conflict" })
          return existing.verified
        }
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const createdAt = yield* SessionProviderOwner.observedAtInTransaction(tx)
                yield* tx
                  .insert(V2ProviderParityReceiptTable)
                  .values({ ...fields, receipt_hash: receiptHash, created_at: createdAt })
                  .run()
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        return fields.verified
      })

      const recordParityForReceipt = Effect.fn("V2ProviderTurn.recordParityForReceipt")(function* (input: {
        readonly campaign: Campaign
        readonly receipt: Receipt
      }) {
        const receipt = yield* get(input.receipt.receiptId)
        if (receipt?.state !== "settled" || !receipt.preparedTurn || !receipt.preparedTurnHash || !receipt.outcomeHash)
          return yield* new ConflictError({ reason: "v2_parity_core_receipt_not_settled" })
        const campaignID = requireCampaignID(input.campaign.id)
        const baseline = yield* db
          .select()
          .from(V2ProviderParityBaselineTable)
          .where(
            and(
              eq(V2ProviderParityBaselineTable.campaign_id, campaignID),
              eq(V2ProviderParityBaselineTable.case_name, input.campaign.case),
              eq(V2ProviderParityBaselineTable.state, "settled"),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!baseline?.outcome_hash || !baseline.outcome_artifact)
          return yield* new ConflictError({ reason: "v2_parity_baseline_not_settled" })
        if (baseline.outcome_hash !== Hash.sha256(CanonicalJson.stringify(baseline.outcome_artifact)))
          return yield* new ConflictError({ reason: "v2_parity_baseline_outcome_corrupt" })
        if (
          !receipt.outcomeArtifact ||
          receipt.outcomeHash !== Hash.sha256(CanonicalJson.stringify(receipt.outcomeArtifact))
        )
          return yield* new ConflictError({ reason: "v2_parity_core_outcome_corrupt" })
        const differences = preparedTurnDifferences(baseline.prepared_turn, receipt.preparedTurn)
        const allowlist = new Set<string>(AllowedDifferences)
        const allowlistedDifferences = differences.filter((field) => allowlist.has(field))
        const disallowedDifferences = differences.filter((field) => !allowlist.has(field))
        const evidence = [...new Set([...baseline.evidence, ...input.campaign.evidence])].toSorted()
        return yield* recordParity({
          campaignId: campaignID,
          case: input.campaign.case,
          legacyReceiptId: baseline.legacy_receipt_id,
          coreV2ReceiptId: receipt.receiptId,
          // Parity compares the REQUEST identity (payload content) across legacy and V2, so the raw
          // `request_hash` is the comparable; the W8 canonical `prepared_turn_hash` (identity-folded)
          // is the exact-retry/drift identity, not a parity cross-comparison value.
          legacyRequestHash: baseline.prepared_turn.request_hash,
          coreV2RequestHash: receipt.preparedTurn.request_hash,
          legacyOutcomeHash: baseline.outcome_hash,
          coreV2OutcomeHash: receipt.outcomeHash,
          legacyPreparedTurn: baseline.prepared_turn,
          coreV2PreparedTurn: receipt.preparedTurn,
          allowlistedDifferences,
          disallowedDifferences,
          evidence: Schema.decodeUnknownSync(Schema.Array(ContextFederationExecutionParity.EvidenceKind))(evidence),
        })
      })

      const parityVerified = Effect.fn("V2ProviderTurn.parityVerified")(function* (campaignId: string) {
        return yield* campaignVerified(db, campaignId)
      })

      return Service.of({
        currentOwnerToken,
        admit,
        seal,
        markStreaming,
        settle,
        abandon,
        bindAttempt,
        quarantine,
        recover,
        get,
        recordBaselinePrepared,
        settleBaseline,
        recordParityForReceipt,
        recordParity,
        parityVerified,
        exportIntegrityEvidence,
        persistIntegrityEvidence,
        persistSignedIntegrityEvidence,
        getIntegrityEvidenceArtifact,
        listIntegrityEvidenceArtifacts,
      })
    }),
  )

export const layer = layerWith()

// Owner-lease length override. The 30s default bounds crash-takeover latency, but it also fences a
// LIVE process whenever the event loop stalls longer than the lease — measured on slow-fs hosts
// (Docker Desktop) where the synchronous FULL commit path accumulates multi-minute loop starvation
// during long provider turns. Deployment harnesses on such hosts raise the lease via this env; the
// default and the crash-takeover contract are unchanged.
export const envOwnerLeaseMs = (): number => {
  const raw = Number(process.env["DEEPAGENT_CODE_V2_OWNER_LEASE_MS"])
  return Number.isSafeInteger(raw) && raw >= 1_000 && raw <= 600_000 ? raw : SessionProviderOwner.LeaseMs
}

export function prepare(input: PrepareInput, wireRequestHash: string) {
  return PreparedProviderTurn.prepare({
    sessionID: input.receipt.sessionId,
    requestOrdinal: input.receipt.requestOrdinal,
    activityID: input.receipt.activityId,
    providerTurnSeq: input.receipt.providerTurnSeq,
    owner: input.receipt.ownerMode,
    stableSystemParts: input.stableSystemParts,
    volatileSystemParts: input.volatileSystemParts,
    historyMessages: input.historyMessages,
    historyPromptEpoch: input.receipt.historyPromptEpoch,
    historySourceEndMessageID: input.receipt.historySourceEndMessageId ?? null,
    contextSelectionID: input.contextSelectionID ?? null,
    contextProjectionHash: input.contextProjectionHash ?? null,
    contextReadiness: input.contextReadiness ?? (input.contextSelectionID === undefined ? "unavailable" : "ready"),
    contextSelectedRefs: input.contextSelectedRefs ?? [],
    toolRegistryIDs: input.toolRegistryIDs ?? input.toolIDs,
    toolPermissionFilteredIDs: input.toolPermissionFilteredIDs ?? input.toolIDs,
    toolFinalOfferedIDs: input.toolFinalOfferedIDs ?? input.toolIDs,
    toolDefinitions: input.toolDefinitions,
    toolChoice: input.toolChoice,
    toolCapability: input.toolCapability ?? "unknown",
    toolLoweringOutcome: input.toolLoweringOutcome ?? "ok",
    toolResultReferences: input.toolResultReferences,
    samplingModelID: input.receipt.modelId,
    samplingProviderID: input.receipt.providerId,
    samplingMaxOutputTokens: input.samplingMaxOutputTokens,
    budget: input.budget,
    wireRequestHash,
    receiptID: input.receipt.receiptId,
    userMessageID: input.userMessageID,
    ...(input.protocolAttemptIdentity === undefined ? {} : { protocolAttemptIdentity: input.protocolAttemptIdentity }),
    ...(input.protocolAttemptIdentityHash === undefined
      ? {}
      : { protocolAttemptIdentityHash: input.protocolAttemptIdentityHash }),
    ...(input.capabilitySnapshot === undefined ? {} : { capabilitySnapshot: input.capabilitySnapshot }),
  })
}

export function stream<A, E, R>(input: {
  readonly service: Interface
  readonly receipt: Receipt
  readonly prepare: (wireHash: string) => PreparedProviderTurn.PreparedProviderTurn
  readonly stream: Stream.Stream<A, E, R>
  readonly outcomeArtifact: () => readonly unknown[]
  readonly errorCode: (error: unknown) => string
  /** Production roots automatically persist digest-only evidence after terminal settlement. */
  readonly integrityIdentity?: RuntimeIntegrityEvidenceContract.RuntimeIdentity
  /**
   * Proven-terminal provider failures (the provider rejected the request before any generation, e.g.
   * context-overflow) may settle as `failed`. Every other typed failure after dispatch cannot prove a
   * terminal provider outcome and is quarantined as `indeterminate_after_crash` instead of becoming a
   * retryable `failed` receipt.
   */
  readonly terminalProviderFailure?: (error: unknown) => boolean
}) {
  let current = input.receipt
  let reachedEnd = false
  const persistIntegrityEvidence = (receipt: Receipt) =>
    input.integrityIdentity === undefined
      ? Effect.void
      : input.service
          .persistIntegrityEvidence({ receiptId: receipt.receiptId, identity: input.integrityIdentity })
          .pipe(Effect.asVoid, Effect.orDie)
  return input.stream.pipe(
    Stream.provideService(RequestExecutor.CurrentRetryLimit, 0),
    Stream.provideService(CurrentRequestSeal, {
      seal: (sealed) =>
        input.service.seal(current, input.prepare(sealed.wireHash), sealed).pipe(
          Effect.tap((receipt) => Effect.sync(() => (current = receipt))),
          Effect.orDie,
          Effect.asVoid,
        ),
    }),
    Stream.tap(() =>
      current.state === "dispatching"
        ? input.service.markStreaming(current).pipe(Effect.tap((receipt) => Effect.sync(() => (current = receipt))))
        : Effect.void,
    ),
    Stream.concat(
      Stream.fromEffectDrain(
        Effect.sync(() => {
          reachedEnd = true
        }),
      ),
    ),
    Stream.onExit((exit) =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          if (current.state === "preparing") {
            return input.service.abandon(current, "wire_seal_failed_before_dispatch").pipe(Effect.orDie)
          }
          if (current.state !== "dispatching" && current.state !== "streaming") return Effect.void
          if (reachedEnd && Exit.isSuccess(exit)) {
            return input.service
              .settle({ receipt: current, outcome: "settled", outcomeArtifact: input.outcomeArtifact() })
              .pipe(Effect.tap(persistIntegrityEvidence), Effect.orDie)
          }
          if (Exit.isFailure(exit) && Cause.findInterrupt(exit.cause)._tag === "Failure") {
            const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            if (input.terminalProviderFailure !== undefined && input.terminalProviderFailure(error)) {
              return input.service
                .settle({
                  receipt: current,
                  outcome: "failed",
                  outcomeArtifact: input.outcomeArtifact(),
                  errorCode: input.errorCode(exit.cause),
                })
                .pipe(Effect.tap(persistIntegrityEvidence), Effect.orDie)
            }
            return input.service
              .quarantine(current, {
                errorCode: input.errorCode(exit.cause),
                outcomeArtifact: input.outcomeArtifact(),
              })
              .pipe(Effect.tap(persistIntegrityEvidence), Effect.orDie)
          }
          return input.service.quarantine(current).pipe(Effect.tap(persistIntegrityEvidence), Effect.orDie)
        }),
      ),
    ),
  )
}

export type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

// §16.3 order 4 package B — read-only receipt lookup by the exact-retry identity tuple. Crash
// replay needs to distinguish "already settled under the identical identity" (reuse the recorded
// outcome evidence) from other refusals. Mirrors the admit lookup (highest ordinal first).
export const receiptByIdentity = (
  db: Database.Interface["db"],
  input: {
    readonly sessionId: SessionSchema.ID
    readonly userMessageId: string
    readonly historyPromptEpoch: number
    readonly requestInputHash: string
  },
) =>
  db
    .select()
    .from(V2ProviderTurnReceiptTable)
    .where(
      and(
        eq(V2ProviderTurnReceiptTable.session_id, input.sessionId),
        eq(V2ProviderTurnReceiptTable.user_message_id, input.userMessageId),
        eq(V2ProviderTurnReceiptTable.history_prompt_epoch, input.historyPromptEpoch),
        eq(V2ProviderTurnReceiptTable.request_input_hash, input.requestInputHash),
      ),
    )
    .orderBy(sql`${V2ProviderTurnReceiptTable.request_ordinal} DESC`)
    .get()

// ---------------------------------------------------------------------------
// W2 — durable recovery descriptor at the turn terminal (design §W2).
// A settled / failed / indeterminate terminal writes ONE content-addressed
// descriptor row (kind + payload + digest) in the SAME receipt transaction, so a
// kill-9 restart re-derives the same recovery classification from the table.
// ---------------------------------------------------------------------------

const terminalDescriptorCommon = (row: {
  readonly receipt_id: string
  readonly session_id: string
  readonly activity_id: string
  readonly provider_turn_seq: number
  readonly attempt_version: number
  readonly provider_attempt_id: string | null
  readonly request_input_hash: string
  readonly owner_token: string
  readonly state: string
}) => ({
  schemaVersion: "recovery-descriptor.v1" as const,
  requestHash: row.request_input_hash,
  provenance: { origin: "recorded" as const, sourceRefs: [row.provider_attempt_id ?? row.receipt_id] },
  baseline: { verified: false },
  terminalBridge: { bridgeId: "none", bridgeType: "none" },
  casTokens: {
    expectedState: row.state,
    expectedVersion: row.attempt_version,
    ownerToken: row.owner_token,
  },
})

/**
 * The five-class descriptor for a turn terminal state. settled → resolved(settled);
 * failed → resolved(unknown) — the local outcome is terminal but no provider verdict
 * exists; indeterminate_after_crash → coordination_required(network_unknown) — the
 * unknown provider result requires explicit resolution (never an automatic replay).
 */
export function turnTerminalDescriptor(row: {
  readonly receipt_id: string
  readonly session_id: string
  readonly activity_id: string
  readonly provider_turn_seq: number
  readonly attempt_version: number
  readonly provider_attempt_id: string | null
  readonly request_input_hash: string
  readonly owner_token: string
  readonly state: string
}): RecoveryCommandContract.RecoveryDescriptor | undefined {
  const common = terminalDescriptorCommon(row)
  if (row.state === "settled") {
    return {
      ...common,
      descriptorKind: "resolved",
      resolved: { resolutionRef: row.receipt_id, bridgeRef: "none", terminal: "settled" },
    }
  }
  if (row.state === "failed") {
    return {
      ...common,
      descriptorKind: "resolved",
      resolved: { resolutionRef: row.receipt_id, bridgeRef: "none", terminal: "unknown" },
    }
  }
  if (row.state === "indeterminate_after_crash") {
    return {
      ...common,
      descriptorKind: "coordination_required",
      coordination: { reason: "network_unknown", requiredActor: "admin" },
    }
  }
  return undefined
}

/**
 * Insert-or-ignore the terminal descriptor in the caller's transaction (idempotent by
 * content address — an exact retry converges on the same row). Factual transaction
 * semantics: the descriptor write and the receipt terminal update run in the SAME
 * immediate transaction — a write failure rolls back the terminal update too, so the
 * attempt stays non-terminal and the recovery authority treats it as indeterminate
 * (the descriptor is re-derivable by a later resolve/classify).
 */
export function writeTurnTerminalDescriptor(
  tx: Transaction,
  row: typeof V2ProviderTurnReceiptTable.$inferSelect,
  observedAt: number,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (!row.provider_attempt_id)
      return yield* Effect.die("terminal V2 provider receipt is missing its provider-attempt binding")
    const attempt = yield* tx
      .select({ attemptVersion: SessionProviderAttemptTable.attempt_version })
      .from(SessionProviderAttemptTable)
      .where(eq(SessionProviderAttemptTable.attempt_id, row.provider_attempt_id))
      .get()
    if (!attempt) return yield* Effect.die("terminal V2 provider receipt references a missing provider attempt")
    const descriptor = turnTerminalDescriptor({ ...row, attempt_version: attempt.attemptVersion })
    if (!descriptor) return
    const contentHash = RecoveryCommandContract.recoveryDescriptorDigest(descriptor)
    yield* tx.run(sql`
        INSERT OR IGNORE INTO session_provider_recovery_descriptor
          (descriptor_id, session_id, activity_id, turn_id, kind, payload, content_hash, created_at)
        VALUES (${`descriptor_${contentHash}`}, ${row.session_id}, ${row.activity_id},
                ${String(row.provider_turn_seq)}, ${descriptor.descriptorKind},
                ${JSON.stringify(descriptor)}, ${contentHash}, ${observedAt})
      `)
  }).pipe(Effect.orDie)
}

export function admitInTransaction(
  tx: Transaction,
  input: Omit<AdmitInput, "ownerToken">,
  ownerToken: string,
): Effect.Effect<Receipt, Error> {
  return Effect.gen(function* () {
    const existing = yield* tx
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(
        and(
          eq(V2ProviderTurnReceiptTable.session_id, input.sessionId),
          eq(V2ProviderTurnReceiptTable.user_message_id, input.userMessageId),
          eq(V2ProviderTurnReceiptTable.history_prompt_epoch, input.historyPromptEpoch),
          eq(V2ProviderTurnReceiptTable.request_input_hash, input.requestInputHash),
        ),
      )
      .orderBy(sql`${V2ProviderTurnReceiptTable.request_ordinal} DESC`)
      .get()
    if (existing) {
      if (existing.state !== "preparing") {
        // A same-owner indeterminate receipt is a live-process transport drop quarantined by this
        // owner: the bounded runner retry (and an explicit forced continuation) opens a FRESH
        // receipt at the next ordinal instead of failing the retry — §2.2 keeps the quarantined row
        // itself untouched (never replayed; explicit resolution still owns its terminal outcome).
        //
        // A PRE-dispatch owner-loss recovery is the same situation one generation later: the fenced
        // owner never reached the provider (no generation, no billing), so the legitimate successor
        // may open a fresh attempt. A post-dispatch owner loss keeps the typed refusal — its outcome
        // is unknown, and RI-11 forbids an automatic re-send.
        const sameOwnerQuarantine =
          existing.state === "indeterminate_after_crash" && existing.owner_token === ownerToken
        const recoverableOwnerLoss =
          existing.state === "failed" && existing.error_code === "owner_lost_before_dispatch"
        if (!sameOwnerQuarantine && !recoverableOwnerLoss)
          return yield* new UnsafeRetryError({ state: existing.state })
      } else if (
        existing.provider_id !== input.providerId ||
        existing.model_id !== input.modelId ||
        existing.protocol !== input.protocol ||
        existing.owner_mode !== input.ownerMode ||
        existing.owner_token !== ownerToken ||
        (existing.history_source_end_message_id ?? undefined) !== input.historySourceEndMessageId
      )
        return yield* new ConflictError({ reason: "v2_receipt_retry_binding_mismatch" })
      else return fromRow(existing)
    }
    const latest = yield* tx
      .select({ ordinal: max(V2ProviderTurnReceiptTable.request_ordinal) })
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.session_id, input.sessionId))
      .get()
    const createdAt = yield* SessionProviderOwner.observedAtInTransaction(tx)
    const row = {
      receipt_id: `v2_receipt_${Hash.sha256(
        CanonicalJson.stringify({
          sessionId: input.sessionId,
          userMessageId: input.userMessageId,
          historyPromptEpoch: input.historyPromptEpoch,
          requestInputHash: input.requestInputHash,
          ordinal: (latest?.ordinal ?? 0) + 1,
        }),
      )}`,
      session_id: input.sessionId,
      request_ordinal: (latest?.ordinal ?? 0) + 1,
      activity_id:
        input.activityId ?? `v2_activity_${Hash.sha256(`${input.sessionId}:${input.userMessageId}`).slice(0, 32)}`,
      provider_turn_seq: input.providerTurnSeq ?? (latest?.ordinal ?? 0) + 1,
      user_message_id: input.userMessageId,
      history_prompt_epoch: input.historyPromptEpoch,
      history_source_end_message_id: input.historySourceEndMessageId,
      request_input_hash: input.requestInputHash,
      provider_id: input.providerId,
      model_id: input.modelId,
      protocol: input.protocol,
      owner_mode: input.ownerMode,
      owner_token: ownerToken,
      state: "preparing" as const,
      created_at: createdAt,
    }
    yield* tx.insert(V2ProviderTurnReceiptTable).values(row).run()
    return fromRow({
      ...row,
      history_source_end_message_id: row.history_source_end_message_id ?? null,
      provider_attempt_id: null,
      prepared_turn_hash: null,
      wire_request_hash: null,
      prepared_turn: null,
      outcome_hash: null,
      outcome_artifact: null,
      error_code: null,
      dispatching_at: null,
      first_event_at: null,
      terminal_at: null,
      integrity_evidence: null,
      integrity_evidence_hash: null,
      integrity_evidence_signature: null,
    })
  }).pipe(preserveErrors)
}

export function bindAttemptInTransaction(
  tx: Transaction,
  receipt: Receipt,
  attemptId: string,
): Effect.Effect<Receipt, Error> {
  return Effect.gen(function* () {
    const current = yield* tx
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.receipt_id, receipt.receiptId))
      .get()
    if (!current) return yield* new NotFoundError()
    // A receipt binds to exactly one attempt, once; callers converge exact retries before calling.
    if (current.provider_attempt_id !== null)
      return yield* new ConflictError({ reason: "v2_provider_attempt_binding_conflict" })
    const attempt = yield* tx
      .select()
      .from(SessionProviderAttemptTable)
      .where(eq(SessionProviderAttemptTable.attempt_id, attemptId))
      .get()
    if (
      !attempt ||
      attempt.session_id !== receipt.sessionId ||
      attempt.activity_id !== receipt.activityId ||
      attempt.provider_turn_seq !== receipt.providerTurnSeq ||
      attempt.provider_id !== receipt.providerId ||
      attempt.owner_token !== receipt.ownerToken ||
      attempt.request_hash !== receipt.requestInputHash
    )
      return yield* new ConflictError({ reason: "v2_provider_attempt_binding_mismatch" })
    const row = yield* tx
      .update(V2ProviderTurnReceiptTable)
      .set({ provider_attempt_id: attemptId })
      .where(
        and(
          eq(V2ProviderTurnReceiptTable.receipt_id, receipt.receiptId),
          eq(V2ProviderTurnReceiptTable.owner_token, receipt.ownerToken),
          eq(V2ProviderTurnReceiptTable.state, "preparing"),
          sql`${V2ProviderTurnReceiptTable.provider_attempt_id} IS NULL`,
        ),
      )
      .returning()
      .get()
    if (!row) return yield* new ConflictError({ reason: "v2_provider_attempt_binding_cas_lost" })
    return fromRow(row)
  }).pipe(preserveErrors)
}

function isError(value: unknown): value is SessionProviderAttempt.Error {
  return (
    value instanceof SessionProviderAttempt.NotFoundError ||
    value instanceof SessionProviderAttempt.ConflictError ||
    value instanceof SessionProviderAttempt.InvalidStateError ||
    value instanceof SessionProviderAttempt.ValidationRequiredError ||
    value instanceof SessionProviderAttempt.UnsafeRetryError ||
    value instanceof SessionProviderAttempt.ResolutionDeniedError ||
    value instanceof SessionProviderAttempt.ResolutionEvidenceError ||
    value instanceof SessionProviderAttempt.ReplayRiskError
  )
}

function fromRow(row: typeof V2ProviderTurnReceiptTable.$inferSelect): Receipt {
  return {
    receiptId: row.receipt_id,
    sessionId: row.session_id,
    requestOrdinal: row.request_ordinal,
    activityId: row.activity_id,
    providerTurnSeq: row.provider_turn_seq,
    ...(row.provider_attempt_id === null ? {} : { providerAttemptId: row.provider_attempt_id }),
    userMessageId: row.user_message_id,
    historyPromptEpoch: row.history_prompt_epoch,
    ...(row.history_source_end_message_id === null
      ? {}
      : { historySourceEndMessageId: row.history_source_end_message_id }),
    requestInputHash: row.request_input_hash,
    providerId: row.provider_id,
    modelId: row.model_id,
    protocol: row.protocol,
    ownerMode: row.owner_mode,
    ownerToken: row.owner_token,
    state: row.state,
    ...(row.prepared_turn_hash === null ? {} : { preparedTurnHash: row.prepared_turn_hash }),
    ...(row.wire_request_hash === null ? {} : { wireRequestHash: row.wire_request_hash }),
    ...(row.prepared_turn === null ? {} : { preparedTurn: row.prepared_turn }),
    ...(row.outcome_hash === null ? {} : { outcomeHash: row.outcome_hash }),
    ...(row.outcome_artifact === null ? {} : { outcomeArtifact: row.outcome_artifact }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.integrity_evidence === null ? {} : { integrityEvidence: row.integrity_evidence }),
    ...(row.integrity_evidence_hash === null ? {} : { integrityEvidenceHash: row.integrity_evidence_hash }),
    ...(row.integrity_evidence_signature === null
      ? {}
      : { integrityEvidenceSignature: row.integrity_evidence_signature }),
    createdAt: row.created_at,
    ...(row.dispatching_at === null ? {} : { dispatchingAt: row.dispatching_at }),
    ...(row.first_event_at === null ? {} : { firstEventAt: row.first_event_at }),
    ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
  }
}

function fromIntegrityEvidenceArtifactRow(
  row: typeof RuntimeIntegrityEvidenceArtifactTable.$inferSelect,
): IntegrityEvidenceArtifact {
  return {
    artifactID: row.artifact_id,
    receiptID: row.receipt_id,
    sessionID: row.session_id,
    attemptID: row.attempt_id,
    evidenceHash: row.evidence_hash,
    evidence: row.evidence,
    ...(row.signature === null ? {} : { signature: row.signature }),
    createdAt: row.created_at,
    ...(row.signed_at === null ? {} : { signedAt: row.signed_at }),
  }
}

function preparedTurnDifferences(
  legacy: PreparedProviderTurn.PreparedProviderTurn,
  coreV2: PreparedProviderTurn.PreparedProviderTurn,
) {
  const fields = Object.keys(legacy) as Array<keyof PreparedProviderTurn.PreparedProviderTurn>
  return fields
    .filter((field) => CanonicalJson.stringify(legacy[field]) !== CanonicalJson.stringify(coreV2[field]))
    .toSorted()
}

function preserveErrors<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.catch((error) =>
      error instanceof ConflictError ||
      error instanceof UnsafeRetryError ||
      error instanceof NotFoundError ||
      error instanceof RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError
        ? Effect.fail(error)
        : Effect.die(error),
    ),
  )
}

export function campaignFromEnv(): Campaign | undefined {
  const id = process.env.DEEPAGENT_CODE_V2_PARITY_CAMPAIGN?.trim()
  const caseName = process.env.DEEPAGENT_CODE_V2_PARITY_CASE?.trim()
  if (!id && !caseName) return
  if (!id || !caseName || !Schema.is(ContextFederationExecutionParity.Case)(caseName)) return
  if (!validCampaignID(id)) return
  return {
    id,
    case: caseName,
    evidence: ["shadow_snapshot", "recorded_provider", "real_session_replay"],
  }
}

export function ownerCampaignFromEnv(): string | undefined {
  const id = process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN?.trim()
  return id && validCampaignID(id) ? id : undefined
}

// F-15 closeout: dev-build owner resolution is DETERMINISTIC — no env arming, so multi-process
// timing can never split the campaign between the minter and the verifier (the armed-env approach
// failed exactly there: a spawned child inherited pre-arm env and resolved the default campaign).
// The campaign derives from the build identity (same derivation in every process of the same
// binary), and the verifier key comes from the persisted local dev keypair the mint wrote.
export const DEV_VERSION_PREFIX = "0.0.0-"
export const isDevBuildVersion = (version: string = InstallationVersion) => version.startsWith(DEV_VERSION_PREFIX)
export const devOwnerCampaignFor = (subjectCommit: string) => `v2-owner-dev-${subjectCommit.slice(0, 12)}`

const devVerifierPublicKey = (stateDir: string): string | undefined => {
  if (!isDevBuildVersion() && process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT !== "1") return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, "v2-owner-dev", "keypair.json"), "utf8"))
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "publicKeyPem" in parsed &&
      typeof parsed.publicKeyPem === "string" &&
      parsed.publicKeyPem.includes("BEGIN PUBLIC KEY")
    )
      return parsed.publicKeyPem
  } catch {
    // Pre-keypair dev installs are read below and migrated by V2OwnerDevMint on the next boot.
  }
  try {
    const key = readFileSync(join(stateDir, "v2-owner-dev", "public.pem"), "utf8")
    return key.includes("BEGIN PUBLIC KEY") ? key : undefined
  } catch {
    return undefined
  }
}

function currentBuildIdentity(): BuildIdentity | undefined {
  const raw = process.env.DEEPAGENT_CODE_V2_BUILD_IDENTITY?.trim()
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<BuildIdentity>
      if (
        typeof parsed.subjectCommit === "string" &&
        typeof parsed.subjectTree === "string" &&
        typeof parsed.schemaDigest === "string" &&
        typeof parsed.buildID === "string" &&
        typeof parsed.packageDigest === "string"
      )
        return parsed as BuildIdentity
    } catch {
      // Invalid env values fall back to the installation-derived identity.
    }
  }
  return buildIdentityFromVersion(InstallationVersion)
}

// W0.5 (blocker-1): a DEFAULT install never sets DEEPAGENT_CODE_V2_OWNER_CAMPAIGN, so the runtime
// must resolve the same default campaign the production mint derives: `v2-owner-<buildIdentity>`
// with the build identity from the installation version (script/mint-owner-campaign.ts derives the
// SAME id from package.json version, which equals the DEEPAGENT_CODE_VERSION define of a release
// build). Without this fallback every default install failed owner qualification even with the
// correct authorization row delivered. An explicit (valid) env value still wins so a shadow or
// staging campaign can override.
export function defaultOwnerCampaign(): string | undefined {
  const id = ownerCampaignFromEnv()
  if (id) return id
  // F-15: a dev build resolves its per-build dev campaign deterministically (matches
  // V2OwnerDevMint's derivation) — the mint's row qualifies without any env wiring.
  if (isDevBuildVersion() || process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT === "1") {
    const devCampaign = devOwnerCampaignFor(buildIdentityFromVersion(InstallationVersion).subjectCommit)
    return validCampaignID(devCampaign) ? devCampaign : undefined
  }
  const derived = `v2-owner-${InstallationVersion}`
  // W0.8 (review minor-4): an installation version that cannot form a legal campaign id (e.g. a
  // `+` build-metadata suffix, which validCampaignID rejects) must fail CLOSED, not throw: return
  // undefined so the authorization gate reports unverified instead of dying inside ownerQualified.
  return validCampaignID(derived) ? derived : undefined
}

export function releaseQualified() {
  return (
    ReleaseQualification.seal === Hash.sha256(CanonicalJson.stringify(ReleaseQualificationPayload)) &&
    CanonicalJson.stringify(ReleaseQualification.parityCases) ===
      CanonicalJson.stringify([...ContextFederationExecutionParity.Case.literals].toSorted()) &&
    CanonicalJson.stringify(ReleaseQualification.evidence) ===
      CanonicalJson.stringify([...ContextFederationExecutionParity.EvidenceKind.literals].toSorted())
  )
}

export function ownerQualified(db: Database.Interface["db"], campaignId?: string) {
  return Effect.gen(function* () {
    // W0.5: an omitted campaign resolves to the installation default (`v2-owner-${InstallationVersion}`)
    // so a default install with the delivered authorization row qualifies without any env wiring.
    const resolved = campaignId ?? defaultOwnerCampaign()
    // W0.8 (review minor-4): fail closed when no legal campaign id can be resolved (invalid
    // installation version) — never throw from the authorization gate.
    if (resolved === undefined) return false
    // F-15: serviceOption on a defaulted Reference resolves None unless a layer explicitly
    // provided it — and NOTHING in production ever did, so EVERY install failed
    // v2_owner_unavailable (only the live-llm harness provided the layers). Resolve the Reference
    // directly: the env override or the version-derived default applies, and fail-closed stays
    // enforced by the row/signature/campaign/window checks below.
    const buildIdentity = yield* CurrentBuildIdentity
    if (buildIdentity === undefined) return false
    const row = yield* db
      .select()
      .from(V2OwnerAuthorizationTable)
      .where(eq(V2OwnerAuthorizationTable.campaign_id, requireCampaignID(resolved)))
      .get()
      .pipe(Effect.orDie)
    if (!row || row.status !== "active") return false
    const now = Date.now()
    if (row.valid_from > now || row.expires_at <= now) return false
    const fields: V2OwnerAuthorization.AuthorizationFields = {
      authorizationID: row.authorization_id,
      campaignID: row.campaign_id,
      subjectCommit: row.subject_commit,
      subjectTree: row.subject_tree,
      schemaDigest: row.schema_digest,
      buildID: row.build_id,
      packageDigest: row.package_digest,
      validFrom: row.valid_from,
      expiresAt: row.expires_at,
      signatureDigest: row.signature_digest,
    }
    // Tamper evidence: the stored digest must still equal the signed payload digest.
    if (row.authorization_digest !== Hash.sha256(V2OwnerAuthorization.authorizationPayload(fields))) return false
    // Authorization proof: the signature must verify against the pinned issuance public key. A
    // row anyone could write is not an authorization, regardless of its digest.
    const publicKey = yield* CurrentOwnerAuthorizationPublicKey
    if (!(yield* V2OwnerAuthorization.verifyAuthorization(publicKey, fields))) return false
    return (
      row.subject_commit === buildIdentity.subjectCommit &&
      row.subject_tree === buildIdentity.subjectTree &&
      row.schema_digest === buildIdentity.schemaDigest &&
      row.build_id === buildIdentity.buildID &&
      row.package_digest === buildIdentity.packageDigest
    )
  })
}

export function campaignVerified(db: Database.Interface["db"], campaignId: string) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(V2ProviderParityReceiptTable)
      .where(eq(V2ProviderParityReceiptTable.campaign_id, requireCampaignID(campaignId)))
      .all()
      .pipe(Effect.orDie)
    if (rows.some((row) => row.verified !== true)) return false
    return ContextFederationExecutionParity.evaluate(
      rows.map((row) => ({
        case: Schema.decodeUnknownSync(ContextFederationExecutionParity.Case)(row.case_name),
        legacyRequestHash: row.legacy_request_hash,
        coreV2RequestHash: row.core_v2_request_hash,
        legacyOutcomeHash: row.legacy_outcome_hash,
        coreV2OutcomeHash: row.core_v2_outcome_hash,
        evidence: Schema.decodeUnknownSync(Schema.Array(ContextFederationExecutionParity.EvidenceKind))(row.evidence),
      })),
    ).verified
  })
}

export function recordBaselinePreparedInTransaction(tx: Transaction, input: BaselineInput) {
  return Effect.gen(function* () {
    const evidence = baselineEvidence(input.campaign.evidence)
    const fields = {
      campaign_id: requireCampaignID(input.campaign.id),
      case_name: input.campaign.case,
      legacy_receipt_id: input.legacyReceiptId,
      state: "prepared" as const,
      prepared_turn: input.preparedTurn,
      outcome_hash: null,
      outcome_artifact: null,
      legacy_response_fingerprint: null,
      evidence,
    }
    const receiptHash = Hash.sha256(CanonicalJson.stringify(fields))
    const existing = yield* tx
      .select()
      .from(V2ProviderParityBaselineTable)
      .where(
        and(
          eq(V2ProviderParityBaselineTable.campaign_id, fields.campaign_id),
          eq(V2ProviderParityBaselineTable.case_name, fields.case_name),
        ),
      )
      .get()
    if (existing) {
      if (
        existing.legacy_receipt_id !== input.legacyReceiptId ||
        existing.receipt_hash !== receiptHash ||
        CanonicalJson.stringify(existing.prepared_turn) !== CanonicalJson.stringify(input.preparedTurn) ||
        CanonicalJson.stringify(existing.evidence) !== CanonicalJson.stringify(evidence)
      )
        return yield* new ConflictError({ reason: "v2_parity_baseline_conflict" })
      return
    }
    yield* tx
      .insert(V2ProviderParityBaselineTable)
      .values({
        ...fields,
        receipt_hash: receiptHash,
        created_at: yield* SessionProviderOwner.observedAtInTransaction(tx),
      })
      .run()
  })
}

export function settleBaselineInTransaction(
  tx: Transaction,
  input: {
    readonly campaign: Campaign
    readonly legacyReceiptId: string
    readonly outcomeArtifact: readonly unknown[]
    readonly legacyResponseFingerprint: string
  },
) {
  return Effect.gen(function* () {
    const campaignID = requireCampaignID(input.campaign.id)
    const outcomeHash = Hash.sha256(CanonicalJson.stringify(input.outcomeArtifact))
    const observedAt = yield* SessionProviderOwner.observedAtInTransaction(tx)
    const row = yield* tx
      .update(V2ProviderParityBaselineTable)
      .set({
        state: "settled",
        outcome_hash: outcomeHash,
        outcome_artifact: input.outcomeArtifact,
        legacy_response_fingerprint: input.legacyResponseFingerprint,
        settled_at: observedAt,
      })
      .where(
        and(
          eq(V2ProviderParityBaselineTable.campaign_id, campaignID),
          eq(V2ProviderParityBaselineTable.case_name, input.campaign.case),
          eq(V2ProviderParityBaselineTable.legacy_receipt_id, input.legacyReceiptId),
          eq(V2ProviderParityBaselineTable.state, "prepared"),
        ),
      )
      .returning({ outcomeHash: V2ProviderParityBaselineTable.outcome_hash })
      .get()
    if (row) return
    const existing = yield* tx
      .select({
        receiptID: V2ProviderParityBaselineTable.legacy_receipt_id,
        state: V2ProviderParityBaselineTable.state,
        outcomeHash: V2ProviderParityBaselineTable.outcome_hash,
        outcomeArtifact: V2ProviderParityBaselineTable.outcome_artifact,
        legacyResponseFingerprint: V2ProviderParityBaselineTable.legacy_response_fingerprint,
      })
      .from(V2ProviderParityBaselineTable)
      .where(
        and(
          eq(V2ProviderParityBaselineTable.campaign_id, campaignID),
          eq(V2ProviderParityBaselineTable.case_name, input.campaign.case),
        ),
      )
      .get()
    if (
      existing?.receiptID === input.legacyReceiptId &&
      existing.state === "settled" &&
      existing.outcomeHash === outcomeHash &&
      existing.legacyResponseFingerprint === input.legacyResponseFingerprint &&
      CanonicalJson.stringify(existing.outcomeArtifact) === CanonicalJson.stringify(input.outcomeArtifact)
    )
      return
    return yield* new ConflictError({ reason: "v2_parity_baseline_settlement_conflict" })
  })
}

function baselineEvidence(evidence: readonly ContextFederationExecutionParity.EvidenceKind[]) {
  return Schema.decodeUnknownSync(Schema.Array(Schema.Literals(["shadow_snapshot", "recorded_provider"])))(
    [...new Set(evidence.filter((item) => item !== "real_session_replay"))].toSorted(),
  )
}

function requireCampaignID(value: string) {
  if (!validCampaignID(value)) throw new Error("Invalid V2 parity campaign ID")
  return value
}

function validCampaignID(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}
