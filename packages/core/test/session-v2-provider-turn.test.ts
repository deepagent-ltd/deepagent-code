import { describe, expect } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { Layer, Effect, Stream, Cause } from "effect"
import { Database } from "../src/database/database"
import { SessionProviderAttempt } from "../src/context-federation/provider-attempt"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { LocationKey, ProjectScopeKey, SecurityNamespaceID } from "../src/context-federation/reference"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionContextValidationTable,
} from "../src/context-federation/session-sql"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "../src/context-federation/sql"
import { ProjectV2 } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { SessionSchema } from "../src/session/schema"
import { SessionInputTable, SessionTable } from "../src/session/sql"
import { PreparedProviderTurn } from "../src/session/runner/prepared-provider-turn"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import {
  RuntimeIntegrityEvidenceArtifactTable,
  V2ProviderParityReceiptTable,
  V2ProviderTurnReceiptTable,
} from "../src/session/runner/v2-provider-turn.sql"
import { ModelProtocolContract } from "../src/contract/model-protocol"
import { RuntimeIntegrityEvidenceContract } from "../src/contract/runtime-integrity-evidence"
import { ContextFederationExecutionParity } from "../src/context-federation/execution-parity"
import { Hash } from "../src/util/hash"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
const attempts = SessionProviderAttempt.layer.pipe(Layer.provide(database))
const turns = V2ProviderTurn.layer.pipe(Layer.provide(owners), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, owners, attempts, turns))
const projectId = ProjectV2.ID.make("project-v2-provider-turn")
const sessionId = SessionSchema.ID.make("ses_v2_provider_turn")
const activityId = "act_v2_provider_turn"
const triggerId = SessionMessage.ID.make("msg_v2_provider_turn_trigger")
const selectionId = "selection_v2_provider_turn"
const projectionHash = "projection-v2-provider-turn"
const namespace = SecurityNamespaceID.make("sec_v2_provider_turn")
const projectScope = ProjectScopeKey.make("prj_v2_provider_turn")
const locationKey = LocationKey.make("loc_v2_provider_turn")

describe("V2 provider turn authority", () => {
  it.live("seals and settles a naturally completed stream exactly once", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* admit(service, "msg-natural")
      const settled = yield* V2ProviderTurn.stream({
        service,
        receipt,
        prepare: (wireHash) => prepared(receipt, wireHash),
        stream: sealedStream("wire-natural", ["first", "second"]),
        outcomeArtifact: () => ["first", "second"],
        errorCode: () => "provider_failed",
      }).pipe(Stream.runCollect)

      expect([...settled]).toEqual(["first", "second"])
      expect(yield* service.get(receipt.receiptId)).toMatchObject({
        state: "settled",
        wireRequestHash: Hash.sha256("wire-natural"),
        outcomeHash: Hash.sha256(JSON.stringify(["first", "second"])),
      })
      // W8 — seal generated the prepared turn immediately and persisted the canonical
      // identity-folded hash: the receipt carries a non-null prepared turn and the column equals
      // the record's canonical value (this identity-less prepared turn folds request_hash alone).
      const recorded = yield* service.get(receipt.receiptId)
      expect(recorded?.preparedTurn).toBeDefined()
      expect(recorded?.preparedTurnHash).toBe(recorded?.preparedTurn?.prepared_turn_hash)
      expect(recorded?.preparedTurnHash).toBe(
        PreparedProviderTurn.preparedTurnHash(recorded?.preparedTurn as PreparedProviderTurn.PreparedProviderTurn),
      )
    }),
  )

  it.live("automatically persists integrity evidence when the production identity is supplied", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* admit(service, "msg-integrity-auto")
      const identity: RuntimeIntegrityEvidenceContract.RuntimeIdentity = {
        candidateID: "candidate-auto",
        commit: "commit-auto",
        tree: "tree-auto",
        packageDigest: Hash.sha256("package-auto"),
        schemaDigest: Hash.sha256("schema-auto"),
        rootCompositionDigest: Hash.sha256("root-auto"),
        databaseSchemaDigest: Hash.sha256("database-auto"),
        eventSchemaDigest: Hash.sha256("event-auto"),
        capabilityManifestDigest: Hash.sha256("capability-auto"),
      }
      yield* V2ProviderTurn.stream({
        service,
        receipt,
        prepare: (wireHash) => prepared(receipt, wireHash, true),
        stream: sealedStream("wire-integrity-auto", ["done"]),
        outcomeArtifact: () => ["done"],
        errorCode: () => "provider_failed",
        integrityIdentity: identity,
      }).pipe(Stream.runCollect)
      const stored = yield* service.get(receipt.receiptId)
      expect(stored?.integrityEvidence?.identity).toEqual(identity)
      expect(stored?.integrityEvidenceHash).toMatch(/^[0-9a-f]{64}$/)
      expect(
        yield* service.getIntegrityEvidenceArtifact(`rie_${stored?.integrityEvidenceHash}`),
      ).toMatchObject({ receiptID: receipt.receiptId })
      expect(yield* service.listIntegrityEvidenceArtifacts()).toHaveLength(1)
      expect(
        yield* service.listIntegrityEvidenceArtifacts({ limit: 0 }).pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.live("exports and persists one immutable runtime-integrity evidence bundle", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* admit(service, "msg-integrity-evidence")
      const protocolAttemptIdentity: ModelProtocolContract.ProtocolAttemptIdentity = {
        protocol: "openai-compatible.chat",
        routeId: "route-test",
        originId: "origin-test",
        endpointOriginHash: Hash.sha256("endpoint-test"),
        capabilityFingerprint: Hash.sha256("capability-test"),
        loweringVersion: 1,
        protocolRevision: 1,
      }
      const turn = V2ProviderTurn.prepare(
        {
          receipt,
          stableSystemParts: ["stable"],
          volatileSystemParts: ["volatile"],
          historyMessages: [{ role: "user", content: receipt.userMessageId }],
          activityID: receipt.activityId,
          providerTurnSeq: receipt.providerTurnSeq,
          toolDefinitions: [],
          toolIDs: [],
          toolChoice: null,
          toolResultReferences: [],
          budget: {
            decision: "ok",
            estimatedFullRequestTokens: 16,
            physicalInputBudget: 1_000,
            reservedOutputTokens: 100,
            safetyMargin: 50,
            provenance: "model_limit",
          },
          userMessageID: receipt.userMessageId,
          protocolAttemptIdentity,
          protocolAttemptIdentityHash: ModelProtocolContract.protocolAttemptIdentityDigest(protocolAttemptIdentity),
        },
        Hash.sha256("wire-integrity-evidence"),
      )
      const sealed = yield* service.seal(receipt, turn, {
        wireHash: turn.wire_request_hash,
        bodyHash: Hash.sha256("body-integrity-evidence"),
        bodyLength: 1,
        contentType: "application/json",
      })
      const settled = yield* service.settle({
        receipt: sealed,
        outcome: "settled",
        outcomeArtifact: ["done"],
      })
      const identity: ModelProtocolContract.ProtocolAttemptIdentity = protocolAttemptIdentity
      const runtimeIdentity: RuntimeIntegrityEvidenceContract.RuntimeIdentity = {
        candidateID: "candidate-test",
        commit: "commit-test",
        tree: "tree-test",
        packageDigest: Hash.sha256("package-test"),
        schemaDigest: Hash.sha256("schema-test"),
        rootCompositionDigest: Hash.sha256("root-test"),
        databaseSchemaDigest: Hash.sha256("database-test"),
        eventSchemaDigest: Hash.sha256("event-test"),
        capabilityManifestDigest: Hash.sha256("manifest-test"),
      }
      const exported = yield* service.persistIntegrityEvidence({
        receiptId: settled.receiptId,
        identity: runtimeIdentity,
      })
      expect(exported.terminal.status).toBe("settled")
      expect(exported.route.protocol).toBe(identity.protocol)
      expect(exported.physicalCallCount).toBe(1)
      const stored = yield* service.get(settled.receiptId)
      expect(stored?.integrityEvidenceHash).toBe(RuntimeIntegrityEvidenceContract.runtimeIntegrityEvidenceDigest(exported))
      expect(stored?.integrityEvidence).toEqual(exported)
      expect(yield* service.persistIntegrityEvidence({ receiptId: settled.receiptId, identity: runtimeIdentity })).toEqual(exported)
      const keyPair = generateKeyPairSync("ed25519")
      const signed = RuntimeIntegrityEvidenceContract.signRuntimeIntegrityEvidence({
        evidence: exported,
        keyID: "provider-turn-test-key",
        privateKeyPem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      })
      expect(
        yield* service.persistSignedIntegrityEvidence({
          receiptId: settled.receiptId,
          signed,
          publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        }),
      ).toEqual(signed)
      expect((yield* service.get(settled.receiptId))?.integrityEvidenceSignature).toEqual(signed)
      const db = (yield* Database.Service).db
      const artifactID = `rie_${RuntimeIntegrityEvidenceContract.runtimeIntegrityEvidenceDigest(exported)}`
      expect(yield* service.getIntegrityEvidenceArtifact(artifactID)).toMatchObject({
        artifactID,
        receiptID: settled.receiptId,
        evidenceHash: RuntimeIntegrityEvidenceContract.runtimeIntegrityEvidenceDigest(exported),
        signature: signed,
      })
      expect(yield* service.getIntegrityEvidenceArtifact(artifactID)).toMatchObject({ artifactID })
      expect(
        yield* service
          .persistSignedIntegrityEvidence({
            receiptId: settled.receiptId,
            signed: { ...signed, evidenceDigest: Hash.sha256("tampered") },
            publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
          })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      expect(
        yield* db
          .update(RuntimeIntegrityEvidenceArtifactTable)
          .set({ evidence_hash: Hash.sha256("tampered") })
          .where(eq(RuntimeIntegrityEvidenceArtifactTable.artifact_id, artifactID))
          .run()
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.live("quarantines consumer cancellation after dispatch instead of inventing settlement", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* admit(service, "msg-cancel")
      expect(
        yield* V2ProviderTurn.stream({
          service,
          receipt,
          prepare: (wireHash) => prepared(receipt, wireHash),
          stream: sealedStream("wire-cancel", ["first", "second"]),
          outcomeArtifact: () => ["first"],
          errorCode: () => "provider_failed",
        }).pipe(Stream.take(1), Stream.runCollect),
      ).toEqual(["first"])
      const recovered = yield* service.get(receipt.receiptId)
      expect(recovered).toMatchObject({
        state: "indeterminate_after_crash",
        errorCode: "consumer_cancelled_after_dispatch",
      })
      expect(recovered?.outcomeHash).toBeUndefined()
    }),
  )

  it.live("quarantines a typed post-dispatch stream failure as indeterminate instead of retryable failed", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* admit(service, "msg-typed-failure")
      const exit = yield* V2ProviderTurn.stream({
        service,
        receipt,
        prepare: (wireHash) => prepared(receipt, wireHash),
        stream: sealedFailingStream("wire-typed-failure", ["first"], new Error("transport lost")),
        outcomeArtifact: () => ["first"],
        errorCode: () => "provider_stream_failed:transport",
      }).pipe(Stream.runCollect, Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(yield* service.get(receipt.receiptId)).toMatchObject({
        state: "indeterminate_after_crash",
        errorCode: "provider_stream_failed:transport",
        outcomeHash: Hash.sha256(JSON.stringify(["first"])),
      })
      // The quarantined row itself is never replayed. A fresh receipt may only be opened by an
      // explicit recovery/continuation decision outside this provider-turn boundary.
      const retried = yield* admit(service, "msg-typed-failure")
      expect(retried.receiptId).not.toBe(receipt.receiptId)
      expect(retried.state).toBe("preparing")
      expect(yield* service.get(receipt.receiptId)).toMatchObject({ state: "indeterminate_after_crash" })
    }),
  )

  it.live("re-opens a fresh attempt after a pre-dispatch owner loss", () =>
    // A lease gap fences the owner generation. When the fenced attempt provably never reached the
    // provider (recover() terminalizes it as `owner_lost_before_dispatch` under a live successor
    // lease) the successor generation may open a fresh attempt; an unknown post-dispatch outcome
    // keeps the typed refusal (RI-11).
    Effect.gen(function* () {
      yield* seed()
      const generation = (ownerToken: string) =>
        V2ProviderTurn.layerWith({ ownerToken, leaseMs: 600_000 }).pipe(
          Layer.provide(owners),
          Layer.provide(database),
        )
      // Generation A admits an attempt; its layer scope then releases the lease.
      const fenced = yield* Effect.gen(function* () {
        const a = yield* V2ProviderTurn.Service
        return yield* admit(a, "msg-owner-lost-before-dispatch")
      }).pipe(Effect.provide(generation("v2:owner-generation-a")))

      // A successor generation builds: the layer's startup recovery terminalizes the fenced
      // generation's in-flight receipt, and admission then opens a fresh attempt for the same input.
      const retried = yield* Effect.gen(function* () {
        const b = yield* V2ProviderTurn.Service
        expect(yield* b.get(fenced.receiptId)).toMatchObject({
          state: "failed",
          errorCode: "owner_lost_before_dispatch",
        })
        return yield* admit(b, "msg-owner-lost-before-dispatch")
      }).pipe(Effect.provide(generation("v2:owner-generation-b")))

      expect(retried.receiptId).not.toBe(fenced.receiptId)
      expect(retried.state).toBe("preparing")
    }),
  )

  it.live("keeps the typed refusal for a non-recoverable terminal receipt", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* admit(service, "msg-non-retryable-terminal")
      yield* service.abandon(receipt, "provider_unavailable")

      // Only the pre-dispatch owner-loss code is re-openable; every other terminal state is refused.
      const refused = yield* admit(service, "msg-non-retryable-terminal").pipe(Effect.exit)
      expect(refused._tag).toBe("Failure")
      if (refused._tag === "Failure")
        expect(Cause.squash(refused.cause)).toMatchObject({ _tag: "V2ProviderTurn.UnsafeRetryError" })
    }),
  )

  it.live("settles a typed failure as failed only when the terminal predicate proves it", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* admit(service, "msg-proven-terminal")
      const exit = yield* V2ProviderTurn.stream({
        service,
        receipt,
        prepare: (wireHash) => prepared(receipt, wireHash),
        stream: sealedFailingStream("wire-proven-terminal", [], new Error("context overflow")),
        outcomeArtifact: () => [],
        errorCode: () => "provider_stream_failed:overflow",
        terminalProviderFailure: (error) => error instanceof Error && error.message === "context overflow",
      }).pipe(Stream.runCollect, Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(yield* service.get(receipt.receiptId)).toMatchObject({
        state: "failed",
        errorCode: "provider_stream_failed:overflow",
      })
    }),
  )

  it.live("rejects a post-dispatch failed settlement that carries no error code", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* admit(service, "msg-no-error-code")
      const turn = prepared(receipt, Hash.sha256("wire-no-error-code"))
      const sealed = yield* service.seal(receipt, turn, {
        wireHash: turn.wire_request_hash,
        bodyHash: "a".repeat(64),
        bodyLength: 1,
        contentType: "application/json",
      })
      expect(
        yield* service.settle({ receipt: sealed, outcome: "failed", outcomeArtifact: [] }).pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      expect(yield* service.get(receipt.receiptId)).toMatchObject({ state: "dispatching" })
    }),
  )

  it.live("fails before provider events when the exact wire seal does not match", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* admit(service, "msg-bad-seal")
      const sideEffects: string[] = []
      const exit = yield* V2ProviderTurn.stream({
        service,
        receipt,
        prepare: () => prepared(receipt, Hash.sha256("different")),
        stream: sealedStream("wire-seal", ["event"], sideEffects),
        outcomeArtifact: () => [],
        errorCode: () => "provider_failed",
      }).pipe(Stream.runCollect, Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(sideEffects).toEqual([])
      expect(yield* service.get(receipt.receiptId)).toMatchObject({
        state: "failed",
        errorCode: "wire_seal_failed_before_dispatch",
      })
    }),
  )

  it.live("rejects caller-invented parity differences and keeps incomplete campaigns disabled", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* admit(service, "msg-parity")
      const turn = prepared(receipt, Hash.sha256("wire-parity"))
      const v2 = { ...turn, owner: "v2" as const, receipt_id: receipt.receiptId }
      const legacy = { ...turn, owner: "legacy_native" as const, receipt_id: "legacy-receipt" }

      expect(
        yield* service
          .recordParity({
            campaignId: "campaign-incomplete",
            case: "admission_activity",
            legacyReceiptId: "legacy-receipt",
            coreV2ReceiptId: receipt.receiptId,
            legacyRequestHash: legacy.request_hash,
            coreV2RequestHash: v2.request_hash,
            legacyOutcomeHash: "e".repeat(64),
            coreV2OutcomeHash: "e".repeat(64),
            legacyPreparedTurn: legacy,
            coreV2PreparedTurn: v2,
            allowlistedDifferences: [],
            disallowedDifferences: [],
            evidence: ["shadow_snapshot"],
          })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      expect(yield* service.parityVerified("campaign-incomplete")).toBe(false)
    }),
  )

  it.live("keeps complete parity evidence separate from owner authorization", () =>
    Effect.gen(function* () {
      yield* seed()
      const db = (yield* Database.Service).db
      const service = yield* V2ProviderTurn.Service
      const campaignId = "campaign-owner-cutover"
      const receipts = yield* Effect.forEach(ContextFederationExecutionParity.Case.literals, (caseName, index) =>
        Effect.gen(function* () {
          const receipt = yield* admit(service, `msg-owner-cutover-${index}`)
          const turn = prepared(receipt, Hash.sha256(`owner-cutover-wire-${index}`))
          const sealed = yield* service.seal(receipt, turn, {
            wireHash: turn.wire_request_hash,
            bodyHash: Hash.sha256(`owner-cutover-body-${index}`),
            bodyLength: index + 1,
            contentType: "application/json",
          })
          const settled = yield* service.settle({
            receipt: sealed,
            outcome: "settled",
            outcomeArtifact: [{ type: "text-delta", id: caseName, text: "same" }],
          })
          return { caseName, settled, turn }
        }),
      )
      yield* db.run(sql.raw("DROP TRIGGER session_v2_provider_parity_receipt_authority_guard")).pipe(Effect.orDie)
      yield* db
        .insert(V2ProviderParityReceiptTable)
        .values(
          receipts.flatMap(({ caseName, settled, turn }, index) => [
            {
              campaign_id: campaignId,
              case_name: caseName,
              legacy_receipt_id: `legacy-owner-complete-${index}`,
              core_v2_receipt_id: settled.receiptId,
              legacy_request_hash: turn.request_hash,
              core_v2_request_hash: turn.request_hash,
              legacy_outcome_hash: settled.outcomeHash!,
              core_v2_outcome_hash: settled.outcomeHash!,
              legacy_prepared_turn: { ...turn, owner: "legacy_native" as const },
              core_v2_prepared_turn: turn,
              diff_artifact: ["owner"],
              allowlist_version: V2ProviderTurn.AllowlistVersion,
              allowlisted_differences: ["owner"],
              disallowed_differences: [],
              evidence: ["real_session_replay", "recorded_provider", "shadow_snapshot"],
              verified: true,
              receipt_hash: Hash.sha256(`owner-cutover-complete:${caseName}`),
              created_at: index + 1,
            },
            {
              campaign_id: `${campaignId}-incomplete`,
              case_name: caseName,
              legacy_receipt_id: `legacy-owner-incomplete-${index}`,
              core_v2_receipt_id: settled.receiptId,
              legacy_request_hash: turn.request_hash,
              core_v2_request_hash: turn.request_hash,
              legacy_outcome_hash: settled.outcomeHash!,
              core_v2_outcome_hash: settled.outcomeHash!,
              legacy_prepared_turn: { ...turn, owner: "legacy_native" as const },
              core_v2_prepared_turn: turn,
              diff_artifact: ["owner"],
              allowlist_version: V2ProviderTurn.AllowlistVersion,
              allowlisted_differences: ["owner"],
              disallowed_differences: [],
              evidence: ["real_session_replay", "recorded_provider", "shadow_snapshot"],
              verified: index !== 0,
              receipt_hash: Hash.sha256(`owner-cutover-incomplete:${caseName}`),
              created_at: index + 1,
            },
          ]),
        )
        .run()
        .pipe(Effect.orDie)

      expect(yield* V2ProviderTurn.campaignVerified(db, campaignId)).toBe(true)
      expect(yield* V2ProviderTurn.campaignVerified(db, `${campaignId}-incomplete`)).toBe(false)
      expect(yield* V2ProviderTurn.ownerQualified(db, campaignId)).toBe(false)
      expect(yield* V2ProviderTurn.ownerQualified(db, `${campaignId}-incomplete`)).toBe(false)
    }),
  )
})

function seed() {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: projectId, worktree: AbsolutePath.make("/tmp/v2-provider-turn"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionId,
        project_id: projectId,
        slug: "v2-provider-turn",
        directory: "/tmp/v2-provider-turn",
        title: "V2 provider turn",
        version: "test",
        time_suspended: 104,
      })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SecurityNamespaceTable)
      .values({ id: namespace, kind: "implicit_local", binding_hash: "namespace-binding", created_at: 1 })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(ProjectScopeIdentityTable)
      .values({
        security_namespace_id: namespace,
        project_scope_key: projectScope,
        project_kind: "registered_root",
        project_identity_hash: "project-identity",
        observed_project_id: projectId,
        created_at: 1,
      })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: namespace,
        location_key: locationKey,
        project_scope_key: projectScope,
        canonical_root: "/tmp/v2-provider-turn",
        observed_project_id: projectId,
        created_at: 1,
      })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionInputTable)
      .values({
        id: triggerId,
        session_id: sessionId,
        prompt: new Prompt({ text: "trigger" }),
        delivery: "steer",
        admitted_seq: 0,
        promoted_seq: 0,
      })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionActivityTable)
      .values({
        activity_id: activityId,
        session_id: sessionId,
        ordinal: 0,
        trigger_input_id: triggerId,
        delivery: "steer",
        state: "active",
        created_at: 1,
      })
      .onConflictDoNothing()
      .run()
  })
}

// A terminal receipt must be bound to one exact canonical provider attempt (the production path
// binds inside the canonical-turn admission transaction). admit therefore seeds the attempt's
// selection + validation evidence and binds before returning, mirroring that contract: attempt
// session/activity/turn-seq/provider/owner/request-hash must equal the receipt's exactly.
function admit(service: V2ProviderTurn.Interface, messageId: string) {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const attempts = yield* SessionProviderAttempt.Service
    const receipt = yield* service.admit({
      sessionId,
      userMessageId: messageId,
      activityId,
      historyPromptEpoch: 1,
      historySourceEndMessageId: messageId,
      requestInputHash: Hash.sha256(`${messageId}-request`),
      providerId: "provider-test",
      modelId: "model-test",
      protocol: "openai-chat",
      ownerMode: "v2",
    })
    yield* db
      .insert(SessionContextSelectionTable)
      .values({
        selection_id: selectionId,
        session_id: sessionId,
        activity_id: activityId,
        revision: 0,
        trigger_input_id: triggerId,
        location_key: locationKey,
        security_namespace_id: namespace,
        project_scope_key: projectScope,
        query_fingerprint: "query-v1",
        authorization_fingerprint: "auth-v1",
        authorization_epoch: 2,
        execution_fingerprint: "execution-v1",
        selected_source_fingerprint: "sources-v2-provider-turn",
        observed_location_mutation_epoch: 9,
        next_revalidation_at: 1_000,
        released_knowledge_binding_state: "unavailable",
        released_knowledge_exact_refs: [],
        released_knowledge_exact_refs_fingerprint: Hash.sha256("[]"),
        graph_revisions: "{}",
        graph_statuses: "{}",
        selected_refs: "[]",
        projection: "projection",
        projection_hash: projectionHash,
        token_count: 1,
        artifact_write_status: "degraded_unavailable",
        inline_audit: "{}",
        created_at: 100,
      })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionContextValidationTable)
      .values({
        validation_id: `validation_v2_provider_turn_${receipt.providerTurnSeq}`,
        selection_id: selectionId,
        provider_turn_seq: receipt.providerTurnSeq,
        authorization_epoch: 2,
        egress_epoch: 3,
        observed_location_mutation_epoch: 9,
        selected_source_fingerprint: "sources-v2-provider-turn",
        validated_at: 100,
        valid_until: 500,
        outcome: "valid",
        reason_code: "current",
      })
      .onConflictDoNothing()
      .run()
    const attempt = yield* attempts.prepare({
      sessionId,
      activityId,
      providerTurnSeq: receipt.providerTurnSeq,
      selectionId,
      projectionHash,
      requestHash: receipt.requestInputHash,
      providerId: receipt.providerId,
      ownerToken: receipt.ownerToken,
      authorizationEpoch: 2,
      egressEpoch: 3,
      selectedSourceFingerprint: "sources-v2-provider-turn",
      observedLocationMutationEpoch: 9,
      now: 150,
    })
    return yield* service.bindAttempt(receipt, attempt.attemptId)
  })
}

function prepared(receipt: V2ProviderTurn.Receipt, wireHash: string, includeProtocolIdentity = false) {
  const protocolAttemptIdentity: ModelProtocolContract.ProtocolAttemptIdentity = {
    protocol: "openai-compatible.chat",
    routeId: "route-auto",
    originId: "origin-auto",
    endpointOriginHash: Hash.sha256("endpoint-auto"),
    capabilityFingerprint: Hash.sha256("capability-auto"),
    loweringVersion: 1,
    protocolRevision: 1,
  }
  return V2ProviderTurn.prepare(
    {
      receipt,
      stableSystemParts: ["stable"],
      volatileSystemParts: ["volatile"],
      historyMessages: [{ role: "user", content: receipt.userMessageId }],
      activityID: receipt.activityId,
      providerTurnSeq: receipt.providerTurnSeq,
      toolDefinitions: [],
      toolIDs: [],
      toolChoice: null,
      toolResultReferences: [],
      budget: {
        decision: "ok",
        estimatedFullRequestTokens: 16,
        physicalInputBudget: 1_000,
        reservedOutputTokens: 100,
        safetyMargin: 50,
        provenance: "model_limit",
      },
      userMessageID: receipt.userMessageId,
      ...(includeProtocolIdentity
        ? {
            protocolAttemptIdentity,
            protocolAttemptIdentityHash: ModelProtocolContract.protocolAttemptIdentityDigest(protocolAttemptIdentity),
          }
        : {}),
    },
    wireHash,
  )
}

function sealedFailingStream<E>(wire: string, values: readonly string[], error: E) {
  return Stream.unwrap(
    V2ProviderTurn.CurrentRequestSeal.pipe(
      Effect.flatMap((seal) =>
        seal!.seal({
          wireHash: Hash.sha256(wire),
          bodyHash: "a".repeat(64),
          bodyLength: values.length,
          contentType: "application/json",
        }),
      ),
      Effect.as(Stream.concat(Stream.fromIterable(values), Stream.fail(error))),
    ),
  )
}

function sealedStream(wire: string, values: readonly string[], sideEffects?: string[]) {
  return Stream.unwrap(
    V2ProviderTurn.CurrentRequestSeal.pipe(
      Effect.flatMap((seal) =>
        seal!.seal({
          wireHash: Hash.sha256(wire),
          bodyHash: "a".repeat(64),
          bodyLength: 2,
          contentType: "application/json",
        }),
      ),
      Effect.tap(() => Effect.sync(() => sideEffects?.push("provider"))),
      Effect.as(Stream.fromIterable(values)),
    ),
  )
}
