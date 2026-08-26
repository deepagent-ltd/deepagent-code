import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { Database } from "../src/database/database"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { ProjectV2 } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { V2OwnerAuthorization } from "../src/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "../src/session/runner/v2-owner-authorization.sql"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { Hash } from "../src/util/hash"
import { testEffect } from "./lib/effect"

const issuance = V2OwnerAuthorization.generateAuthorizationKeyPair()
const stranger = V2OwnerAuthorization.generateAuthorizationKeyPair()

const unsigned = {
  authorizationID: "auth_crypto",
  campaignID: "crypto-campaign",
  subjectCommit: "a".repeat(40),
  subjectTree: "b".repeat(40),
  schemaDigest: "c".repeat(64),
  buildID: "d".repeat(64),
  packageDigest: "e".repeat(64),
  validFrom: 1_000,
  expiresAt: 2_000_000_000_000,
}
const signed = {
  ...unsigned,
  signatureDigest: V2OwnerAuthorization.signAuthorization(issuance.privateKeyPem, unsigned),
}
const verifyWith = (publicKeyPem: string, fields: typeof signed) =>
  Effect.runSync(V2OwnerAuthorization.verifyAuthorization(publicKeyPem, fields))

const prepareOracleTurn = (receipt: V2ProviderTurn.Receipt) =>
  V2ProviderTurn.prepare(
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
    },
    Hash.sha256("wire-oracle"),
  )

describe("V2 owner authorization cryptography", () => {
  test("verifies an Ed25519 signature from the matching issuance key", () => {
    expect(verifyWith(issuance.publicKeyPem, signed)).toBe(true)
  })

  test("rejects tampered identity bindings and validity windows", () => {
    expect(verifyWith(issuance.publicKeyPem, { ...signed, subjectCommit: "f".repeat(40) })).toBe(false)
    expect(verifyWith(issuance.publicKeyPem, { ...signed, subjectTree: "f".repeat(40) })).toBe(false)
    expect(verifyWith(issuance.publicKeyPem, { ...signed, buildID: "f".repeat(64) })).toBe(false)
    expect(verifyWith(issuance.publicKeyPem, { ...signed, packageDigest: "f".repeat(64) })).toBe(false)
    expect(verifyWith(issuance.publicKeyPem, { ...signed, expiresAt: unsigned.expiresAt + 1 })).toBe(false)
    expect(verifyWith(issuance.publicKeyPem, { ...signed, campaignID: "other-campaign" })).toBe(false)
  })

  test("rejects a signature verified against a different issuance key", () => {
    expect(verifyWith(stranger.publicKeyPem, signed)).toBe(false)
  })

  test("rejects legacy and malformed signatures without throwing", () => {
    expect(verifyWith(issuance.publicKeyPem, { ...signed, signatureDigest: "f".repeat(64) })).toBe(false)
    expect(verifyWith(issuance.publicKeyPem, { ...signed, signatureDigest: "z".repeat(128) })).toBe(false)
    expect(verifyWith(issuance.publicKeyPem, { ...signed, signatureDigest: signed.signatureDigest.toUpperCase() })).toBe(false)
    expect(verifyWith(issuance.publicKeyPem, { ...signed, signatureDigest: "" })).toBe(false)
    expect(verifyWith("not a pem", signed)).toBe(false)
    expect(verifyWith("", signed)).toBe(false)
  })

  test("rejects tampered authorization ids, schema digests, and validity starts", () => {
    expect(verifyWith(issuance.publicKeyPem, { ...signed, authorizationID: "auth_other" })).toBe(false)
    expect(verifyWith(issuance.publicKeyPem, { ...signed, schemaDigest: "f".repeat(64) })).toBe(false)
    expect(verifyWith(issuance.publicKeyPem, { ...signed, validFrom: unsigned.validFrom + 1 })).toBe(false)
  })

  test("smuggled extra fields can never change the signed payload", () => {
    const base = V2OwnerAuthorization.authorizationPayload(unsigned)
    const smuggled = V2OwnerAuthorization.authorizationPayload({
      ...unsigned,
      signatureDigest: signed.signatureDigest,
      attacker: "payload-extension",
    } as typeof unsigned)
    expect(smuggled).toBe(base)
  })
})

const database = Database.layerFromPath(":memory:")
const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
const turns = V2ProviderTurn.layer.pipe(Layer.provide(owners), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, owners, turns))
const projectId = ProjectV2.ID.make("project-v2-owner-auth")
const sessionId = SessionSchema.ID.make("ses_v2_owner_auth")
const buildIdentity: V2ProviderTurn.BuildIdentity = {
  subjectCommit: unsigned.subjectCommit,
  subjectTree: unsigned.subjectTree,
  schemaDigest: unsigned.schemaDigest,
  buildID: unsigned.buildID,
  packageDigest: unsigned.packageDigest,
}

describe("V2 owner qualification gate", () => {
  it.effect("stays fail-closed against the pinned production key until the real issuer signs", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* seedAuthorization(db, signed)
      const qualified = V2ProviderTurn.ownerQualified(db, unsigned.campaignID).pipe(
        Effect.provideService(V2ProviderTurn.CurrentBuildIdentity, buildIdentity),
      )
      // Default verifier key is the pinned production issuance key; an authorization signed by
      // any other key (including this test's ephemeral pair) must not qualify.
      expect(yield* qualified).toBe(false)
      // Qualification becomes possible only when the verifier is explicitly given the matching
      // issuance public key, which production wiring never does for non-pinned keys.
      expect(
        yield* qualified.pipe(
          Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, issuance.publicKeyPem),
        ),
      ).toBe(true)
    }),
  )

  it.live("runs a qualified V2 turn end to end with zero legacy authority writes", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* seedAuthorization(db, signed)
      const service = yield* V2ProviderTurn.Service
      const receipt = yield* service.admit({
        sessionId,
        userMessageId: "msg-oracle",
        historyPromptEpoch: 1,
        historySourceEndMessageId: "msg-oracle",
        requestInputHash: Hash.sha256("msg-oracle-request"),
        providerId: "provider-test",
        modelId: "model-test",
        protocol: "openai-chat",
        ownerMode: "v2",
      })
      const prepared = prepareOracleTurn(receipt)
      const stream = Stream.unwrap(
        V2ProviderTurn.CurrentRequestSeal.pipe(
          Effect.flatMap((seal) =>
            seal!.seal({
              wireHash: Hash.sha256("wire-oracle"),
              bodyHash: "a".repeat(64),
              bodyLength: 2,
              contentType: "application/json",
            }),
          ),
          Effect.as(Stream.fromIterable(["first", "second"])),
        ),
      )
      const events = yield* V2ProviderTurn.stream({
        service,
        receipt,
        prepare: () => prepared,
        stream,
        outcomeArtifact: () => ["first", "second"],
        errorCode: () => "provider_failed",
      }).pipe(Stream.runCollect)
      expect([...events]).toEqual(["first", "second"])
      // V2-only composition oracle: the qualified turn settles the V2 receipt and writes nothing
      // into the legacy provider receipt authority.
      expect(yield* service.get(receipt.receiptId)).toMatchObject({ state: "settled" })
      const legacyWrites = yield* db
        .all<{ count: number }>(sql`SELECT count(*) AS count FROM session_tool_request_receipt`)
        .pipe(Effect.orDie)
      expect(legacyWrites[0]?.count).toBe(0)
    }),
  )
})

function seedAuthorization(db: Database.Interface["db"], fields: typeof signed) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: projectId, worktree: AbsolutePath.make("/tmp/v2-owner-auth"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionId,
        project_id: projectId,
        slug: "v2-owner-auth",
        directory: "/tmp/v2-owner-auth",
        title: "V2 owner auth",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const { signatureDigest, ...signable } = fields
    yield* db
      .insert(V2OwnerAuthorizationTable)
      .values({
        authorization_id: fields.authorizationID,
        campaign_id: fields.campaignID,
        subject_commit: fields.subjectCommit,
        subject_tree: fields.subjectTree,
        schema_digest: fields.schemaDigest,
        build_id: fields.buildID,
        package_digest: fields.packageDigest,
        valid_from: fields.validFrom,
        expires_at: fields.expiresAt,
        status: "active",
        signature_digest: signatureDigest,
        authorization_digest: Hash.sha256(V2OwnerAuthorization.authorizationPayload(signable)),
        created_at: 500,
      })
      .run()
      .pipe(Effect.orDie)
  })
}
