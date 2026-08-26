export * as V2ProviderTurn from "./v2-provider-turn"

import { RequestExecutor } from "@deepagent-code/llm/route"
import { and, eq, inArray, max, or, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Ref, Schedule, Schema, Stream } from "effect"
import { Database } from "../../database/database"
import { CanonicalJson } from "../../util/canonical-json"
import { Hash } from "../../util/hash"
import { ContextFederationExecutionParity } from "../../context-federation/execution-parity"
import { SessionProviderOwner } from "../../context-federation/provider-owner"
import { SessionProviderAttempt } from "../../context-federation/provider-attempt"
import { SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../../context-federation/session-sql"
import { SessionSchema } from "../schema"
import { PreparedProviderTurn } from "./prepared-provider-turn"
import {
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
}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("V2ProviderTurn.ConflictError", {
  reason: Schema.String,
}) {}

export class UnsafeRetryError extends Schema.TaggedErrorClass<UnsafeRetryError>()("V2ProviderTurn.UnsafeRetryError", {
  state: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("V2ProviderTurn.NotFoundError", {}) {}

export type Error = ConflictError | UnsafeRetryError | NotFoundError | SessionProviderAttempt.Error

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
  readonly toolChoice: "auto" | "required" | "none" | null
  readonly toolResultReferences: readonly string[]
  readonly samplingMaxOutputTokens?: number
  readonly budget: PreparedProviderTurn.Budget
  readonly userMessageID: string
  readonly activityID: string
  readonly providerTurnSeq: number
  readonly contextSelectionID?: string
  readonly contextProjectionHash?: string
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
  { defaultValue: ownerCampaignFromEnv },
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

export const CurrentBuildIdentity = Context.Reference<BuildIdentity | undefined>(
  "@deepagent-code/v2/V2ProviderTurn/CurrentBuildIdentity",
  {
    // 1.4.8.rN: dev campaign flow — identity comes from env (JSON with the five fields); production
    // r0 binds the durable build identity at startup instead.
    defaultValue: () => {
      const raw = process.env.DEEPAGENT_CODE_V2_BUILD_IDENTITY?.trim()
      if (!raw) return undefined
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
        return undefined
      }
      return undefined
    },
  },
)

// The owner qualification verifier checks authorization signatures against this key only. The
// default is the pinned production issuance key; tests may provide an ephemeral public key, and
// the dev campaign flow points the verifier at an ephemeral key via env (production never sets it).
export const CurrentOwnerAuthorizationPublicKey = Context.Reference<string>(
  "@deepagent-code/v2/V2ProviderTurn/CurrentOwnerAuthorizationPublicKey",
  {
    defaultValue: () =>
      process.env.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY?.trim() ||
      V2OwnerAuthorization.PRODUCTION_OWNER_AUTHORIZATION_PUBLIC_KEY,
  },
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
  readonly ownerToken: string
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
      const ownerToken = options.ownerToken ?? `v2:${crypto.randomUUID()}`
      const leaseMs = options.leaseMs ?? SessionProviderOwner.LeaseMs
      yield* owners.register({ ownerToken, leaseMs }).pipe(Effect.orDie)
      const healthy = yield* Ref.make(true)
      yield* owners.heartbeat({ ownerToken, leaseMs }).pipe(
        Effect.catch((error) =>
          error.reason === "provider_owner_lease_not_live"
            ? Ref.set(healthy, false)
            : Effect.logError("v2 provider owner heartbeat failed", { error }),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(Math.max(1, Math.floor(leaseMs / 3))))),
        Effect.forkScoped,
      )
      yield* Effect.addFinalizer(() => owners.release({ ownerToken }).pipe(Effect.ignore))

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

      const admit = Effect.fn("V2ProviderTurn.admit")(function* (input: Omit<AdmitInput, "ownerToken">) {
        yield* requireHealthy
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
                          prepared_turn_hash: input.preparedTurn.request_hash,
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
                      preparedTurnHash: input.preparedTurn.request_hash,
                      wireRequestHash: input.preparedTurn.wire_request_hash,
                    })
                    yield* sync({ attemptId, expectedOwnerToken: ownerToken, from: ["prepared"], to: "dispatching", now: observedAt })
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
                return fromRow(row)
              }),
            { behavior: "immediate" },
          )
        }).pipe(preserveErrors)

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
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const observedAt = yield* SessionProviderOwner.observedAtInTransaction(tx)
                const rows = yield* tx
                  .select()
                  .from(V2ProviderTurnReceiptTable)
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
                  (joined) => {
                    const row = joined.session_v2_provider_turn_receipt
                    return tx
                      .update(V2ProviderTurnReceiptTable)
                      .set({
                        state: row.state === "preparing" ? "failed" : "indeterminate_after_crash",
                        error_code:
                          row.state === "preparing" ? "owner_lost_before_dispatch" : "owner_lost_after_dispatch",
                        terminal_at: observedAt,
                      })
                      .where(
                        and(
                          eq(V2ProviderTurnReceiptTable.receipt_id, row.receipt_id),
                          eq(V2ProviderTurnReceiptTable.owner_token, row.owner_token),
                          eq(V2ProviderTurnReceiptTable.state, row.state),
                        ),
                      )
                      .returning({ receiptId: V2ProviderTurnReceiptTable.receipt_id })
                      .get()
                  },
                  { concurrency: 1 },
                )
                return recovered.filter(Boolean).length
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      })

      yield* recover().pipe(Effect.orDie)

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
          legacyRequestHash: baseline.prepared_turn.request_hash,
          coreV2RequestHash: receipt.preparedTurnHash,
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
        ownerToken,
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
      })
    }),
  )

export const layer = layerWith()

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
    contextReadiness: input.contextSelectionID === undefined ? "unavailable" : "ready",
    contextSelectedRefs: [],
    toolRegistryIDs: input.toolIDs,
    toolPermissionFilteredIDs: input.toolIDs,
    toolFinalOfferedIDs: input.toolIDs,
    toolDefinitions: input.toolDefinitions,
    toolChoice: input.toolChoice,
    toolCapability: "supported",
    toolLoweringOutcome: "ok",
    toolResultReferences: input.toolResultReferences,
    samplingModelID: input.receipt.modelId,
    samplingProviderID: input.receipt.providerId,
    samplingMaxOutputTokens: input.samplingMaxOutputTokens,
    budget: input.budget,
    wireRequestHash,
    receiptID: input.receipt.receiptId,
    userMessageID: input.userMessageID,
  })
}

export function stream<A, E, R>(input: {
  readonly service: Interface
  readonly receipt: Receipt
  readonly prepare: (wireHash: string) => PreparedProviderTurn.PreparedProviderTurn
  readonly stream: Stream.Stream<A, E, R>
  readonly outcomeArtifact: () => readonly unknown[]
  readonly errorCode: (error: unknown) => string
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
              .pipe(Effect.orDie)
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
                .pipe(Effect.orDie)
            }
            return input.service
              .quarantine(current, {
                errorCode: input.errorCode(exit.cause),
                outcomeArtifact: input.outcomeArtifact(),
              })
              .pipe(Effect.orDie)
          }
          return input.service.quarantine(current).pipe(Effect.orDie)
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
      if (existing.state !== "preparing") return yield* new UnsafeRetryError({ state: existing.state })
      if (
        existing.provider_id !== input.providerId ||
        existing.model_id !== input.modelId ||
        existing.protocol !== input.protocol ||
        existing.owner_mode !== input.ownerMode ||
        existing.owner_token !== ownerToken ||
        (existing.history_source_end_message_id ?? undefined) !== input.historySourceEndMessageId
      )
        return yield* new ConflictError({ reason: "v2_receipt_retry_binding_mismatch" })
      return fromRow(existing)
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
    createdAt: row.created_at,
    ...(row.dispatching_at === null ? {} : { dispatchingAt: row.dispatching_at }),
    ...(row.first_event_at === null ? {} : { firstEventAt: row.first_event_at }),
    ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
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
      error instanceof ConflictError || error instanceof UnsafeRetryError || error instanceof NotFoundError
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
    if (!campaignId) return false
    const identity = yield* Effect.serviceOption(CurrentBuildIdentity)
    if (identity._tag === "None" || identity.value === undefined) return false
    const buildIdentity = identity.value
    const row = yield* db
      .select()
      .from(V2OwnerAuthorizationTable)
      .where(eq(V2OwnerAuthorizationTable.campaign_id, requireCampaignID(campaignId)))
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
