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
import { fileURLToPath } from "node:url"
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

const runMint = async (args: string[], extraEnv: Record<string, string> = {}) => {
  const env = { ...process.env }
  delete env.DEEPAGENT_CODE_OWNER_SIGNING_KEY
  Object.assign(env, extraEnv)
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

const DAY_MS = 24 * 60 * 60 * 1_000

type SeedFileRow = {
  authorization_id: string
  campaign_id: string
  subject_commit: string
  subject_tree: string
  schema_digest: string
  build_id: string
  package_digest: string
  valid_from: number
  expires_at: number
  signature_digest: string
  authorization_digest: string
  created_at: number
}

// W0.8 review new-1: build a same-authorization re-issue file (the exact script --renew shape:
// authorization_id/valid_from unchanged, window strictly extended, signature re-issued).
const renewalFileFor = async (dir: string, row: SeedFileRow, privateKeyPem: string, expiresAt: number) => {
  const fields = {
    authorizationID: row.authorization_id,
    campaignID: row.campaign_id,
    subjectCommit: row.subject_commit,
    subjectTree: row.subject_tree,
    schemaDigest: row.schema_digest,
    buildID: row.build_id,
    packageDigest: row.package_digest,
    validFrom: row.valid_from,
    expiresAt,
  }
  const file = join(dir, `owner-renewal-${expiresAt}.json`)
  await Bun.write(
    file,
    JSON.stringify({
      authorization_id: row.authorization_id,
      campaign_id: row.campaign_id,
      subject_commit: row.subject_commit,
      subject_tree: row.subject_tree,
      schema_digest: row.schema_digest,
      build_id: row.build_id,
      package_digest: row.package_digest,
      valid_from: row.valid_from,
      expires_at: expiresAt,
      signature_digest: V2OwnerAuthorization.signAuthorization(privateKeyPem, fields),
      authorization_digest: Hash.sha256(V2OwnerAuthorization.authorizationPayload(fields)),
      created_at: row.created_at,
    }),
  )
  return file
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

  test("an existing EXPIRED row is not overwritten by a fresh export (exists_conflict): the fresh export is not a re-issue of the same authorization", async () => {
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

  test("W0.8 review new-1: a same-identity re-issue with a LATER window RENEWS the seeded row in place; ownerQualified still passes", async () => {
    await using tmp = await tmpdir()
    const mintDb = join(tmp.path, "mint.sqlite")
    const exportFile = join(tmp.path, "owner-authorization.json")
    // ONE explicit issuance key so both the first file and the renewal re-issue verify against it.
    const issuance = V2OwnerAuthorization.generateAuthorizationKeyPair()
    const minted = await runMint(["--db", mintDb, "--export", exportFile], {
      DEEPAGENT_CODE_OWNER_SIGNING_KEY: issuance.privateKeyPem,
    })
    expect(minted.exitCode, minted.stderr).toBe(0)
    const row = JSON.parse(await Bun.file(exportFile).text()) as SeedFileRow
    // Renewal file: SAME authorization re-issued with a strictly later window (script --renew
    // shape: authorization_id and valid_from unchanged, signature re-issued).
    const renewalFile = await renewalFileFor(tmp.path, row, issuance.privateKeyPem, (row.expires_at as number) + DAY_MS)
    const renewedFileRow = JSON.parse(await Bun.file(renewalFile).text()) as { expires_at: number; signature_digest: string }

    await runSeed(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const options = (path: string) => ({
          env: { DEEPAGENT_CODE_OWNER_AUTHORIZATION: path },
          appRoot: tmp.path,
          publicKeyPem: issuance.publicKeyPem,
        })
        const first = yield* V2OwnerSeed.seedOwnerAuthorization(db, options(exportFile))
        expect(first.seeded, JSON.stringify(first)).toBe(true)
        if (!first.seeded) throw new Error(`expected insert, got ${first.reason}`)
        expect(first.renewed).toBe(false)
        const identity = V2ProviderTurn.buildIdentityFromVersion(InstallationVersion)

        const renewed = yield* V2OwnerSeed.seedOwnerAuthorization(db, options(renewalFile))
        expect(renewed.seeded, JSON.stringify(renewed)).toBe(true)
        if (!renewed.seeded) throw new Error(`expected renewal, got ${renewed.reason}`)
        expect(renewed.renewed).toBe(true)

        const stored = yield* db
          .select()
          .from(V2OwnerAuthorizationTable)
          .where(eq(V2OwnerAuthorizationTable.campaign_id, row.campaign_id as string))
          .get()
          .pipe(Effect.orDie)
        expect(stored).not.toBeNull()
        // The window is extended and the signature/digest are the re-issued ones…
        expect(stored!.expires_at).toBeGreaterThan(row.expires_at as number)
        expect(stored!.signature_digest).not.toBe(row.signature_digest)
        expect(stored!.expires_at).toBe(renewedFileRow.expires_at)
        expect(stored!.signature_digest).toBe(renewedFileRow.signature_digest)
        // …while the identity half (authorization_id/campaign_id + 5 identity fields) is BYTE-identical.
        expect(stored!.authorization_id).toBe(row.authorization_id)
        expect(stored!.campaign_id).toBe(row.campaign_id)
        expect(stored!.subject_commit).toBe(identity.subjectCommit)
        expect(stored!.subject_tree).toBe(identity.subjectTree)
        expect(stored!.schema_digest).toBe(identity.schemaDigest)
        expect(stored!.build_id).toBe(identity.buildID)
        expect(stored!.package_digest).toBe(identity.packageDigest)
        expect(stored!.valid_from).toBe(row.valid_from)
        expect(stored!.status).toBe("active")
        expect(stored!.revoked_at).toBeNull()
        // The default install still qualifies on the rebuilt row (the 90-day window self-healed).
        expect(
          yield* V2ProviderTurn.ownerQualified(db, undefined).pipe(
            Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, issuance.publicKeyPem),
          ),
        ).toBe(true)

        // Re-delivering the renewal file is an idempotent already_present no-op.
        const third = yield* V2OwnerSeed.seedOwnerAuthorization(db, options(renewalFile))
        expect(third.seeded, JSON.stringify(third)).toBe(false)
        if (third.seeded) throw new Error(`expected already_present, got seeded ${third.campaignID}`)
        expect(third.reason).toBe("already_present")
      }),
    )
  })

  test("W0.8 review new-1b: a same-identity file with a SHORTER window is exists_conflict (refused), never shrinks the row", async () => {
    await using tmp = await tmpdir()
    const mintDb = join(tmp.path, "mint.sqlite")
    const exportFile = join(tmp.path, "owner-authorization.json")
    const issuance = V2OwnerAuthorization.generateAuthorizationKeyPair()
    const minted = await runMint(["--db", mintDb, "--export", exportFile], {
      DEEPAGENT_CODE_OWNER_SIGNING_KEY: issuance.privateKeyPem,
    })
    expect(minted.exitCode, minted.stderr).toBe(0)
    const row = JSON.parse(await Bun.file(exportFile).text()) as SeedFileRow
    // Same authorization re-issued with a SHORTER — but still currently legal — window.
    const shorter = await renewalFileFor(tmp.path, row, issuance.privateKeyPem, Date.now() + 60_000)

    await runSeed(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const options = (path: string) => ({
          env: { DEEPAGENT_CODE_OWNER_AUTHORIZATION: path },
          appRoot: tmp.path,
          publicKeyPem: issuance.publicKeyPem,
        })
        const first = yield* V2OwnerSeed.seedOwnerAuthorization(db, options(exportFile))
        expect(first.seeded, JSON.stringify(first)).toBe(true)

        const refused = yield* V2OwnerSeed.seedOwnerAuthorization(db, options(shorter))
        expect(refused.seeded, JSON.stringify(refused)).toBe(false)
        if (refused.seeded) throw new Error(`expected exists_conflict, got seeded ${refused.campaignID}`)
        expect(refused.reason).toBe("exists_conflict")
        // The diagnosis reports both windows (stored vs file) for the operator.
        expect(refused.detail).toContain(String(row.expires_at))
        const stored = yield* db
          .select()
          .from(V2OwnerAuthorizationTable)
          .where(eq(V2OwnerAuthorizationTable.campaign_id, row.campaign_id as string))
          .get()
          .pipe(Effect.orDie)
        expect(stored!.expires_at).toBe(row.expires_at)
        expect(stored!.signature_digest).toBe(row.signature_digest)
      }),
    )
  })

  test("W0.8 review new-1c: a revoked row is never renewed — a later-window re-issue is exists_conflict", async () => {
    await using tmp = await tmpdir()
    const mintDb = join(tmp.path, "mint.sqlite")
    const exportFile = join(tmp.path, "owner-authorization.json")
    const issuance = V2OwnerAuthorization.generateAuthorizationKeyPair()
    const minted = await runMint(["--db", mintDb, "--export", exportFile], {
      DEEPAGENT_CODE_OWNER_SIGNING_KEY: issuance.privateKeyPem,
    })
    expect(minted.exitCode, minted.stderr).toBe(0)
    const row = JSON.parse(await Bun.file(exportFile).text()) as SeedFileRow
    const renewalFile = await renewalFileFor(tmp.path, row, issuance.privateKeyPem, Date.now() + 200 * DAY_MS)

    await runSeed(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const options = (path: string) => ({
          env: { DEEPAGENT_CODE_OWNER_AUTHORIZATION: path },
          appRoot: tmp.path,
          publicKeyPem: issuance.publicKeyPem,
        })
        const first = yield* V2OwnerSeed.seedOwnerAuthorization(db, options(exportFile))
        expect(first.seeded, JSON.stringify(first)).toBe(true)
        yield* db
          .update(V2OwnerAuthorizationTable)
          .set({ status: "revoked", revoked_at: Date.now() })
          .where(eq(V2OwnerAuthorizationTable.campaign_id, row.campaign_id as string))
          .run()
          .pipe(Effect.orDie)

        // Even a perfect later-window re-issue cannot revive a revoked authorization.
        const refused = yield* V2OwnerSeed.seedOwnerAuthorization(db, options(renewalFile))
        expect(refused.seeded, JSON.stringify(refused)).toBe(false)
        if (refused.seeded) throw new Error(`expected exists_conflict, got seeded ${refused.campaignID}`)
        expect(refused.reason).toBe("exists_conflict")
        expect(refused.detail).toContain("revoked")
        const stored = yield* db
          .select()
          .from(V2OwnerAuthorizationTable)
          .where(eq(V2OwnerAuthorizationTable.campaign_id, row.campaign_id as string))
          .get()
          .pipe(Effect.orDie)
        expect(stored!.status).toBe("revoked")
        expect(stored!.expires_at).toBe(row.expires_at)
      }),
    )
  })

  test("W0.8 review new-1d: a same-campaign file for a DIFFERENT build identity is exists_conflict (never overwrites another build)", async () => {
    await using tmp = await tmpdir()
    const mintDb = join(tmp.path, "mint.sqlite")
    const exportFile = join(tmp.path, "owner-authorization.json")
    const issuance = V2OwnerAuthorization.generateAuthorizationKeyPair()
    const minted = await runMint(["--db", mintDb, "--export", exportFile], {
      DEEPAGENT_CODE_OWNER_SIGNING_KEY: issuance.privateKeyPem,
    })
    expect(minted.exitCode, minted.stderr).toBe(0)
    const file = JSON.parse(await Bun.file(exportFile).text()) as SeedFileRow

    await runSeed(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const options = (path: string) => ({
          env: { DEEPAGENT_CODE_OWNER_AUTHORIZATION: path },
          appRoot: tmp.path,
          publicKeyPem: issuance.publicKeyPem,
        })
        // A pre-existing row for the SAME campaign but a DIFFERENT build identity: the file (the
        // install identity) must never overwrite it.
        const other = V2ProviderTurn.buildIdentityFromVersion("8.8.8")
        const signable = {
          authorizationID: "auth_other_build",
          campaignID: file.campaign_id as string,
          ...other,
          validFrom: Date.now() - 1_000,
          expiresAt: Date.now() + 90 * DAY_MS,
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
            signature_digest: V2OwnerAuthorization.signAuthorization(issuance.privateKeyPem, signable),
            authorization_digest: Hash.sha256(V2OwnerAuthorization.authorizationPayload(signable)),
            created_at: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        const refused = yield* V2OwnerSeed.seedOwnerAuthorization(db, options(exportFile))
        expect(refused.seeded, JSON.stringify(refused)).toBe(false)
        if (refused.seeded) throw new Error(`expected exists_conflict, got seeded ${refused.campaignID}`)
        expect(refused.reason).toBe("exists_conflict")
        const stored = yield* db
          .select()
          .from(V2OwnerAuthorizationTable)
          .where(eq(V2OwnerAuthorizationTable.campaign_id, file.campaign_id as string))
          .get()
          .pipe(Effect.orDie)
        expect(stored!.authorization_id).toBe("auth_other_build")
        expect(stored!.build_id).toBe(other.buildID)
        expect(stored!.package_digest).toBe(other.packageDigest)
      }),
    )
  })
})
