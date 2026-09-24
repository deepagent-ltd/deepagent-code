import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import renewGuardMigration from "../src/database/migration/20260902100000_v2_owner_authorization_renew_guard"
import { V2OwnerAuthorization } from "../src/session/runner/v2-owner-authorization"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { tmpdir } from "./fixture/tmpdir"

// W0.7: --renew on a migrated user database. The W0.5 production migration chain shipped the STRICT
// update guard (20260823090000_v2_owner_authorization: only active→revoked); the release mint tool
// re-creates its own relaxed guard on databases it touches, so user databases migrated by the core
// chain kept refusing signed renewals until the matching relaxation migration lands. These tests
// apply the PRODUCTION chain (real runner + registry) and prove (a) the chain now installs the
// relaxed guard, (b) the relaxation is delivered BY the migration (boundary test against the W0.5
// strict state), (c) the relaxed guard permits exactly the rebuild: renew (same identity, window
// strictly extended, signature re-issued) and revoke (active→revoked, everything else equal), and
// (d) the end-to-end mint --renew subprocess round-trips on a production-migrated database.

const DAY_MS = 24 * 60 * 60 * 1_000
const CAMPAIGN = "v2-owner-w07-renew"
const AUTH_ID = "auth_w07_renew_guard"
const VERSION = "1.2.3"
const day = DAY_MS

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

const issuance = V2OwnerAuthorization.generateAuthorizationKeyPair()
const identity = V2ProviderTurn.buildIdentityFromVersion(VERSION)

const sign = (fields: Omit<V2OwnerAuthorization.AuthorizationFields, "signatureDigest">) => ({
  signature_digest: V2OwnerAuthorization.signAuthorization(issuance.privateKeyPem, fields),
  authorization_digest: createHash("sha256")
    .update(V2OwnerAuthorization.authorizationPayload(fields))
    .digest("hex"),
})

type Row = {
  authorization_id: string
  campaign_id: string
  subject_commit: string
  subject_tree: string
  schema_digest: string
  build_id: string
  package_digest: string
  valid_from: number
  expires_at: number
  status: string
  signature_digest: string
  authorization_digest: string
  created_at: number
  revoked_at: number | null
}

const seedRow = (db: EffectDrizzleSqlite.EffectSQLiteDatabase, now = Date.now()) => {
  const signed = sign({
    authorizationID: AUTH_ID,
    campaignID: CAMPAIGN,
    ...identity,
    validFrom: now - 1_000,
    expiresAt: now + day,
  })
  return db
    .run(
      sql`INSERT INTO session_v2_owner_authorization (
        authorization_id, campaign_id, subject_commit, subject_tree, schema_digest, build_id,
        package_digest, valid_from, expires_at, status, signature_digest, authorization_digest,
        created_at
      ) VALUES (${AUTH_ID}, ${CAMPAIGN}, ${identity.subjectCommit}, ${identity.subjectTree}, ${identity.schemaDigest}, ${identity.buildID}, ${identity.packageDigest}, ${now - 1_000}, ${now + day}, 'active', ${signed.signature_digest}, ${signed.authorization_digest}, ${now})`,
    )
    .pipe(Effect.as({ ...signed, valid_from: now - 1_000, expires_at: now + day, created_at: now }))
}

const rowFor = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  db.get<Row>(sql`SELECT * FROM session_v2_owner_authorization WHERE campaign_id = ${CAMPAIGN}`)

// The exact UPDATE shape the release mint tool issues for --renew (packages/deepagent-code/script/
// mint-owner-campaign.ts): expires_at strictly extended + signature and authorization digest re-issued.
const renewSql = (db: EffectDrizzleSqlite.EffectSQLiteDatabase, renew: { expires_at: number; signature_digest: string; authorization_digest: string }) =>
  db
    .run(
      sql`UPDATE session_v2_owner_authorization
        SET expires_at = ${renew.expires_at}, signature_digest = ${renew.signature_digest}, authorization_digest = ${renew.authorization_digest}
        WHERE campaign_id = ${CAMPAIGN} AND status = 'active'`,
    )
    .pipe(Effect.exit)

describe("V2 owner authorization renew guard (W0.7)", () => {
  test("the production migration chain installs the RELAXED update guard, not the strict one", async () => {
    await run(
      ":memory:",
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual({
          count: migrations.length,
        })
        const trigger = yield* db.get<{ sql: string }>(
          sql`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'session_v2_owner_authorization_update_guard'`,
        )
        expect(trigger?.sql).toContain("NEW.expires_at > OLD.expires_at")
        expect(trigger?.sql).toContain("OLD.status = 'active' AND NEW.status = 'revoked'")
        // The strict guard's blanket expires_at equality check is gone (it is replaced by the
        // renew/revoke branch pair: > OLD in renew, = OLD in revoke).
        expect(trigger?.sql).not.toContain("NEW.expires_at != OLD.expires_at")
      }),
    )
  })

  test("boundary: the W0.5 strict chain refuses a signed renewal until the renew-guard migration lands", async () => {
    await run(
      ":memory:",
      Effect.gen(function* () {
        const db = yield* makeDb
        const guardIndex = migrations.findIndex((migration) => migration.id === renewGuardMigration.id)
        expect(guardIndex).toBeGreaterThan(0)
        // Exactly the W0.5 production state: every shipped migration, no renewal relaxation.
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, guardIndex))
        yield* seedRow(db)

        const strict = yield* rowFor(db)
        expect(strict).not.toBeNull()
        const strictSigs = sign({
          authorizationID: AUTH_ID,
          campaignID: CAMPAIGN,
          ...identity,
          validFrom: strict!.valid_from,
          expiresAt: strict!.expires_at + DAY_MS,
        })
        const refused = yield* renewSql(db, {
          expires_at: strict!.expires_at + DAY_MS,
          ...strictSigs,
        })
        expect(String(refused)).toContain("v2 owner authorization is immutable")
        expect((yield* rowFor(db))!.expires_at).toBe(strict!.expires_at)
        expect((yield* rowFor(db))!.signature_digest).toBe(strict!.signature_digest)

        // A user database upgrade applies the new migration alone.
        yield* DatabaseMigration.applyOnly(db, [renewGuardMigration])

        const accepted = yield* renewSql(db, {
          expires_at: strict!.expires_at + DAY_MS,
          ...strictSigs,
        })
        expect(accepted).toMatchObject({ _tag: "Success" })
        expect((yield* rowFor(db))!.expires_at).toBe(strict!.expires_at + DAY_MS)
        expect((yield* rowFor(db))!.signature_digest).toBe(strictSigs.signature_digest)
      }),
    )
  })

  test("relaxed guard permits exactly renew (strictly extended + re-issued) and revoke; every other update shape is rejected", async () => {
    await run(
      ":memory:",
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const original = yield* seedRow(db)

        // Renew-without-extension: only the signature changes → rejected (a re-issue MUST extend).
        const sigOnly = sign({
          authorizationID: AUTH_ID,
          campaignID: CAMPAIGN,
          ...identity,
          validFrom: original.valid_from,
          expiresAt: original.expires_at,
        })
        expect(String(yield* renewSql(db, { expires_at: original.expires_at, ...sigOnly }))).toContain(
          "v2 owner authorization is immutable",
        )
        // Extension without a re-issued signature → rejected (nobody may hand-extend a window).
        const newExpires = original.expires_at + DAY_MS
        expect(
          String(yield* renewSql(db, { expires_at: newExpires, signature_digest: original.signature_digest, authorization_digest: original.authorization_digest })),
        ).toContain("v2 owner authorization is immutable")
        // Shrinking the window with a re-issued signature → rejected (renew must strictly extend).
        const shrink = sign({
          authorizationID: AUTH_ID,
          campaignID: CAMPAIGN,
          ...identity,
          validFrom: original.valid_from,
          expiresAt: original.expires_at - 1,
        })
        expect(String(yield* renewSql(db, { expires_at: original.expires_at - 1, ...shrink }))).toContain(
          "v2 owner authorization is immutable",
        )

        // Identity fields never change.
        const identityTweak = yield* db
          .run(sql`UPDATE session_v2_owner_authorization SET subject_commit = ${"f".repeat(40)} WHERE campaign_id = ${CAMPAIGN}`)
          .pipe(Effect.exit)
        expect(String(identityTweak)).toContain("v2 owner authorization is immutable")
        const campaignTweak = yield* db
          .run(sql`UPDATE session_v2_owner_authorization SET campaign_id = 'v2-owner-elsewhere' WHERE campaign_id = ${CAMPAIGN}`)
          .pipe(Effect.exit)
        expect(String(campaignTweak)).toContain("v2 owner authorization is immutable")

        // A real renewal succeeds; identity/immutable fields stay byte-identical.
        const signed = sign({
          authorizationID: AUTH_ID,
          campaignID: CAMPAIGN,
          ...identity,
          validFrom: original.valid_from,
          expiresAt: newExpires,
        })
        const renewed = yield* renewSql(db, { expires_at: newExpires, ...signed })
        expect(renewed).toMatchObject({ _tag: "Success" })
        const afterRenew = yield* rowFor(db)
        expect(afterRenew).not.toBeNull()
        expect(afterRenew!.authorization_id).toBe(AUTH_ID)
        expect(afterRenew!.campaign_id).toBe(CAMPAIGN)
        expect(afterRenew!.subject_commit).toBe(identity.subjectCommit)
        expect(afterRenew!.subject_tree).toBe(identity.subjectTree)
        expect(afterRenew!.schema_digest).toBe(identity.schemaDigest)
        expect(afterRenew!.build_id).toBe(identity.buildID)
        expect(afterRenew!.package_digest).toBe(identity.packageDigest)
        expect(afterRenew!.valid_from).toBe(original.valid_from)
        expect(afterRenew!.created_at).toBe(original.created_at)
        expect(afterRenew!.expires_at).toBe(newExpires)
        expect(afterRenew!.signature_digest).toBe(signed.signature_digest)
        expect(afterRenew!.authorization_digest).toBe(signed.authorization_digest)

        // Idempotent second renewal in a LATER window: strictly further extension, still accepted.
        const laterExpires = afterRenew!.expires_at + DAY_MS
        const again = sign({
          authorizationID: AUTH_ID,
          campaignID: CAMPAIGN,
          ...identity,
          validFrom: original.valid_from,
          expiresAt: laterExpires,
        })
        expect(yield* renewSql(db, { expires_at: laterExpires, ...again })).toMatchObject({ _tag: "Success" })
        const twice = yield* rowFor(db)
        expect(twice!.expires_at).toBe(laterExpires)
        expect(twice!.signature_digest).toBe(again.signature_digest)

        // Revocation after renewal: the active→revoked path stays intact.
        const revoked = yield* db
          .run(sql`UPDATE session_v2_owner_authorization SET status = 'revoked', revoked_at = ${Date.now()} WHERE campaign_id = ${CAMPAIGN} AND status = 'active'`)
          .pipe(Effect.exit)
        expect(revoked).toMatchObject({ _tag: "Success" })
        expect((yield* rowFor(db))!.status).toBe("revoked")
        expect((yield* rowFor(db))!.revoked_at).not.toBeNull()
        // A revoked row may never be touched again (neither shape permits revoked→*).
        const touchRevoked = yield* db
          .run(
            sql`UPDATE session_v2_owner_authorization
              SET expires_at = ${laterExpires + DAY_MS}, signature_digest = ${again.signature_digest}, authorization_digest = ${again.authorization_digest}
              WHERE campaign_id = ${CAMPAIGN}`,
          )
          .pipe(Effect.exit)
        expect(String(touchRevoked)).toContain("v2 owner authorization is immutable")

        // DELETE stays append-only.
        const deleted = yield* db
          .run(sql`DELETE FROM session_v2_owner_authorization WHERE campaign_id = ${CAMPAIGN}`)
          .pipe(Effect.exit)
        expect(String(deleted)).toContain("v2 owner authorization is append only")
      }),
    )
  })

  test("end to end: mint --renew subprocess works on a PRODUCTION-migrated database (real chain + release tool)", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner-renew.sqlite")
    // The production chain (real runner, full registry) migrates the file first.
    await run(
      dbFile,
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
      }),
    )

    const script = new URL("../../deepagent-code/script/mint-owner-campaign.ts", import.meta.url)
    const runMint = async (args: string[]) => {
      const env = { ...process.env }
      delete env.DEEPAGENT_CODE_OWNER_SIGNING_KEY
      env.DEEPAGENT_CODE_OWNER_SIGNING_KEY = issuance.privateKeyPem
      const child = Bun.spawn([process.execPath, fileURLToPath(script), ...args], {
        cwd: import.meta.dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, exitCode }
    }

    const minted = await runMint(["--db", dbFile, "--build-identity", VERSION, "--campaign", CAMPAIGN])
    expect(minted.exitCode, minted.stderr).toBe(0)
    const before = await run(
      dbFile,
      Effect.gen(function* () {
        const db = yield* makeDb
        return yield* rowFor(db)
      }),
    )
    expect(before).not.toBeNull()

    const renew = await runMint(["--db", dbFile, "--build-identity", VERSION, "--campaign", CAMPAIGN, "--renew"])
    expect(renew.exitCode, renew.stderr).toBe(0)
    const renewed = JSON.parse(renew.stdout) as {
      action: string
      campaign_id: string
      authorization_id: string
      expires_at: number
      signature_digest: string
      valid_from: number
    }
    expect(renewed.action).toBe("renewed")
    expect(renewed.campaign_id).toBe(CAMPAIGN)
    expect(renewed.authorization_id).toBe(before!.authorization_id)
    expect(renewed.valid_from).toBe(before!.valid_from)
    expect(renewed.expires_at).toBeGreaterThan(before!.expires_at)
    expect(renewed.signature_digest).not.toBe(before!.signature_digest)

    const after = await run(
      dbFile,
      Effect.gen(function* () {
        const db = yield* makeDb
        const row = yield* rowFor(db)
        // The rebuilt row still qualifies against the same issuance key.
        const qualified = yield* V2ProviderTurn.ownerQualified(db, CAMPAIGN).pipe(
          Effect.provideService(V2ProviderTurn.CurrentBuildIdentity, identity),
          Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, issuance.publicKeyPem),
        )
        return { row, qualified }
      }),
    )
    expect(after.row).not.toBeNull()
    expect(after.row!.signature_digest).toBe(renewed.signature_digest)
    // The whole identity half (authorization_id/campaign_id + 5 identity fields) is untouched.
    expect(after.row!.authorization_id).toBe(before!.authorization_id)
    expect(after.row!.campaign_id).toBe(before!.campaign_id)
    expect(after.row!.subject_commit).toBe(before!.subject_commit)
    expect(after.row!.subject_tree).toBe(before!.subject_tree)
    expect(after.row!.schema_digest).toBe(before!.schema_digest)
    expect(after.row!.build_id).toBe(before!.build_id)
    expect(after.row!.package_digest).toBe(before!.package_digest)
    expect(after.row!.valid_from).toBe(before!.valid_from)
    expect(after.row!.created_at).toBe(before!.created_at)
    expect(after.qualified).toBe(true)

    // Idempotent second renew in a later window (immediately after: the restarting-window design).
    const again = await runMint(["--db", dbFile, "--build-identity", VERSION, "--campaign", CAMPAIGN, "--renew"])
    expect(again.exitCode, again.stderr).toBe(0)
    const againParsed = JSON.parse(again.stdout) as { action: string; expires_at: number; signature_digest: string }
    expect(againParsed.action).toBe("renewed")
    expect(againParsed.expires_at).toBeGreaterThan(renewed.expires_at)
    expect(againParsed.signature_digest).not.toBe(renewed.signature_digest)

    // A renewed row revokes normally afterwards.
    const revoked = await runMint(["--db", dbFile, "--campaign", CAMPAIGN, "--revoke"])
    expect(revoked.exitCode, revoked.stderr).toBe(0)
    expect((JSON.parse(revoked.stdout) as { status: string }).status).toBe("revoked")
  })
})
