import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Layer, Effect, Stream } from "effect"
import { Database } from "../src/database/database"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { ProjectV2 } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { PreparedProviderTurn } from "../src/session/runner/prepared-provider-turn"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { V2ProviderParityReceiptTable } from "../src/session/runner/v2-provider-turn.sql"
import { ContextFederationExecutionParity } from "../src/context-federation/execution-parity"
import { Hash } from "../src/util/hash"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
const turns = V2ProviderTurn.layer.pipe(Layer.provide(owners), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, owners, turns))
const projectId = ProjectV2.ID.make("project-v2-provider-turn")
const sessionId = SessionSchema.ID.make("ses_v2_provider_turn")

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

  it.live("opens the owner gate only for a complete durable campaign", () =>
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
      })
      .onConflictDoNothing()
      .run()
  })
}

function admit(service: V2ProviderTurn.Interface, messageId: string) {
  return service.admit({
    sessionId,
    userMessageId: messageId,
    historyPromptEpoch: 1,
    historySourceEndMessageId: messageId,
    requestInputHash: Hash.sha256(`${messageId}-request`),
    providerId: "provider-test",
    modelId: "model-test",
    protocol: "openai-chat",
    ownerMode: "v2",
  })
}

function prepared(receipt: V2ProviderTurn.Receipt, wireHash: string) {
  return V2ProviderTurn.prepare(
    {
      receipt,
      stableSystemParts: ["stable"],
      volatileSystemParts: ["volatile"],
      historyMessages: [{ role: "user", content: receipt.userMessageId }],
      toolDefinitions: [],
      toolIDs: [],
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
    },
    wireHash,
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
