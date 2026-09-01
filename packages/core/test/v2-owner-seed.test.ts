// W0.5 (blocker-2) seed verification: seedOwnerAuthorization is the only channel that delivers a
// release-minted owner-authorization.json into a user DB. Three states are exercised (no file,
// verification failure, success) plus the two refusal edges that must never overwrite a row:
// an EXISTING (expired) row for the campaign and a falsified signature. The mint script is spawned
// as the JSON producer so the export shape and the seed parser are proven against each other.
import "./fixture/install-version"
import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { InstallationVersion } from "../src/installation/version"
import { V2OwnerAuthorization } from "../src/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "../src/session/runner/v2-owner-authorization.sql"
import { V2OwnerSeed } from "../src/session/runner/v2-owner-seed"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

delete process.env.DEEPAGENT_CODE_OWNER_SIGNING_KEY
delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
delete process.env.DEEPAGENT_CODE_V2_BUILD_IDENTITY
delete process.env.DEEPAGENT_CODE_OWNER_AUTHORIZATION

const script = new URL("../../deepagent-code/script/mint-owner-campaign.ts", import.meta.url)
const runSeed = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:"))))

const runMint = async (args: string[]) => {
  const env = { ...process.env }
  delete env.DEEPAGENT_CODE_OWNER_SIGNING_KEY
  const child = Bun.spawn([process.execPath, script.pathname, ...args], {
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

describe("V2 owner authorization seed (W0.5 deliverable channel)", () => {
  test("no owner-authorization.json and no env path => not_found no-op", async () => {
    await using tmp = await tmpdir()
    const outcome = await runSeed(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return yield* V2OwnerSeed.seedOwnerAuthorization(db, { env: {}, appRoot: tmp.path })
      }),
    )
    if (outcome.seeded) throw new Error(`expected not found, got seeded ${outcome.campaignID}`)
    expect(outcome.reason).toBe("not_found")
  })

  test("a minted export seeds into a clean DB and qualifies the default install; re-seeding is already_present", async () => {
    await using tmp = await tmpdir()
    const mintDb = join(tmp.path, "mint.sqlite")
    const exportFile = join(tmp.path, "owner-authorization.json")
    // Default mint arguments: identity = package.json version (= InstallationVersion via fixture).
    const minted = await runMint(["--dev", "--db", mintDb, "--export", exportFile])
    expect(minted.exitCode, minted.stderr).toBe(0)
    const { public_key_pem: publicKeyPem } = JSON.parse(minted.stdout) as { public_key_pem: string }

    const result = await runSeed(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const seeded = yield* V2OwnerSeed.seedOwnerAuthorization(db, {
          env: { DEEPAGENT_CODE_OWNER_AUTHORIZATION: exportFile },
          appRoot: tmp.path,
          publicKeyPem,
        })
        expect(seeded.seeded, JSON.stringify(seeded)).toBe(true)
        // The seeded row qualifies the DEFAULT install (no campaign env, no identity env).
        expect(
          yield* V2ProviderTurn.ownerQualified(db, undefined).pipe(
            Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, publicKeyPem),
          ),
        ).toBe(true)
        // Idempotent: a second seed is a no-op, never a rewrite.
        const again = yield* V2OwnerSeed.seedOwnerAuthorization(db, {
          env: { DEEPAGENT_CODE_OWNER_AUTHORIZATION: exportFile },
          appRoot: tmp.path,
          publicKeyPem,
        })
        expect(again.seeded).toBe(false)
        if (again.seeded) throw new Error(`expected already_present, got seeded ${again.campaignID}`)
        expect(again.reason).toBe("already_present")
        return { seeded, again }
      }),
    )
    expect(result.seeded.seeded).toBe(true)
    if (result.again.seeded) throw new Error(`expected already_present, got seeded ${result.again.campaignID}`)
    expect(result.again.reason).toBe("already_present")
  })

  test("an unverifiable export (tampered signature) is refused and never written", async () => {
    await using tmp = await tmpdir()
    const exportFile = join(tmp.path, "owner-authorization.json")
    await runMint(["--dev", "--db", join(tmp.path, "mint.sqlite"), "--export", exportFile])
    const row = JSON.parse(await Bun.file(exportFile).text()) as Record<string, string>
    // Flip one signature hex char — the row must be rejected without touching the DB.
    const tampered = {
      ...row,
      signature_digest: `${row.signature_digest!.slice(0, -1)}${row.signature_digest!.endsWith("0") ? "1" : "0"}`,
    }
    const tamperedFile = join(tmp.path, "tampered.json")
    await Bun.write(tamperedFile, JSON.stringify(tampered))

    const outcome = await runSeed(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return yield* V2OwnerSeed.seedOwnerAuthorization(db, {
          env: { DEEPAGENT_CODE_OWNER_AUTHORIZATION: tamperedFile },
          appRoot: tmp.path,
        })
      }),
    )
    if (outcome.seeded) throw new Error(`expected verify_failed, got seeded ${outcome.campaignID}`)
    expect(outcome.reason).toBe("verify_failed")
  })

  test("an export for a different build identity is refused (identity_mismatch) and never written", async () => {
    await using tmp = await tmpdir()
    const exportFile = join(tmp.path, "owner-authorization.json")
    const minted = await runMint(["--dev", "--db", join(tmp.path, "mint.sqlite"), "--build-identity", "9.9.9", "--export", exportFile])
    expect(minted.exitCode, minted.stderr).toBe(0)
    const { public_key_pem: publicKeyPem } = JSON.parse(minted.stdout) as { public_key_pem: string }
    const outcome = await runSeed(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return yield* V2OwnerSeed.seedOwnerAuthorization(db, {
          env: { DEEPAGENT_CODE_OWNER_AUTHORIZATION: exportFile },
          appRoot: tmp.path,
          publicKeyPem,
        })
      }),
    )
    if (outcome.seeded) throw new Error(`expected identity_mismatch, got seeded ${outcome.campaignID}`)
    expect(outcome.reason).toBe("identity_mismatch")
  })

  test("an existing EXPIRED row is never overwritten (exists_conflict) even by a valid fresh export", async () => {
    await using tmp = await tmpdir()
    const exportFile = join(tmp.path, "owner-authorization.json")
    const minted = await runMint(["--dev", "--db", join(tmp.path, "mint.sqlite"), "--export", exportFile])
    expect(minted.exitCode, minted.stderr).toBe(0)
    const { public_key_pem: publicKeyPem } = JSON.parse(minted.stdout) as { public_key_pem: string }

    const outcome = await runSeed(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const identity = V2ProviderTurn.buildIdentityFromVersion(InstallationVersion)
        const signable = {
          authorizationID: "auth_expired_row",
          campaignID: `v2-owner-${InstallationVersion}`,
          ...identity,
          validFrom: 1,
          expiresAt: 2,
        }
        yield* db
          .insert(V2OwnerAuthorizationTable)
          .values({
            authorization_id: signable.authorizationID,
            campaign_id: signable.campaignID,
            subject_commit: signable.subjectCommit,
            subject_tree: signable.subjectTree,
            schema_digest: signable.schemaDigest,
            build_id: signable.buildID,
            package_digest: signable.packageDigest,
            valid_from: signable.validFrom,
            expires_at: signable.expiresAt,
            status: "active",
            signature_digest: V2OwnerAuthorization.signAuthorization(
              // A separately generated key: the row is "expired", the fresh export is valid — the
              // point of this test is the ROW presence, not the row's signature.
              V2OwnerAuthorization.generateAuthorizationKeyPair().privateKeyPem,
              signable,
            ),
            authorization_digest: Hash.sha256(V2OwnerAuthorization.authorizationPayload(signable)),
            created_at: 1,
          })
          .run()
          .pipe(Effect.orDie)

        const seeded = yield* V2OwnerSeed.seedOwnerAuthorization(db, {
          env: { DEEPAGENT_CODE_OWNER_AUTHORIZATION: exportFile },
          appRoot: tmp.path,
          publicKeyPem,
        })
        expect(seeded.seeded, JSON.stringify(seeded)).toBe(false)
        if (seeded.seeded) throw new Error(`expected exists_conflict, got seeded ${seeded.campaignID}`)
        expect(seeded.reason).toBe("exists_conflict")
        // The expired row is untouched (still the SAME row, still expired).
        const rows = yield* db
          .select()
          .from(V2OwnerAuthorizationTable)
          .where(eq(V2OwnerAuthorizationTable.campaign_id, signable.campaignID))
          .all()
          .pipe(Effect.orDie)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.expires_at).toBe(2)
        expect(rows[0]!.authorization_id).toBe("auth_expired_row")
      }),
    )
  })
})
