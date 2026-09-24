// W0.3/W0.5 production mint verification: script/mint-owner-campaign.ts (packages/deepagent-code)
// writes a signed session_v2_owner_authorization row that the V2 runtime verifier
// (V2ProviderTurn.ownerQualified) accepts, and --revoke rejects afterwards. The mint script is
// spawned as a CLI process; the verifier runs in this process against the same SQLite file.
//
// The install-version fixture makes this process behave like a RELEASE install: the mint script's
// DEFAULT build identity (packages/deepagent-code/package.json version, also the value the release
// build defines as DEEPAGENT_CODE_VERSION) equals InstallationVersion here, so the W0.5 default
// campaign end-to-end case (mint with pure default arguments, verifier without any campaign env)
// closes exactly like a default install of the released product.
import "./fixture/install-version"
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Option } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { InstallationVersion } from "../src/installation/version"
import { V2OwnerAuthorization } from "../src/session/runner/v2-owner-authorization"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { tmpdir } from "./fixture/tmpdir"

// The mint script must never see a signing key unless a test passes one explicitly, and this
// process must exercise the CurrentBuildIdentity version-derived fallback (no env identity) and
// the default owner campaign (no env campaign).
delete process.env.DEEPAGENT_CODE_OWNER_SIGNING_KEY
delete process.env.DEEPAGENT_CODE_V2_BUILD_IDENTITY
delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN

const script = new URL("../../deepagent-code/script/mint-owner-campaign.ts", import.meta.url)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

const pkgVersion = JSON.parse(
  (await Bun.file(new URL("../../deepagent-code/package.json", import.meta.url)).text()) as string,
).version as string

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

describe("V2 owner campaign production mint (W0.3)", () => {
  test("mints a row that ownerQualified accepts for the default install identity; --revoke rejects it afterwards", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    const minted = await runMint(["--dev", "--db", dbFile, "--build-identity", InstallationVersion])
    expect(minted.exitCode, minted.stderr).toBe(0)
    const result = JSON.parse(minted.stdout) as {
      campaign_id: string
      public_key_pem: string
      authorization_id: string
    }
    expect(result.campaign_id).toBe(`v2-owner-${InstallationVersion}`)
    expect(result.public_key_pem).toContain("-----BEGIN PUBLIC KEY-----")

    await run(
      dbFile,
      Effect.gen(function* () {
        const db = yield* makeDb
        // The default install resolves CurrentBuildIdentity from InstallationVersion; the minted
        // row was derived from the same `--build-identity`, so no env / no service override is
        // needed for the identity half — only the ephemeral issuance public key (dev flow).
        const qualified = yield* V2ProviderTurn.ownerQualified(db, result.campaign_id).pipe(
          Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, result.public_key_pem),
        )
        expect(qualified).toBe(true)
        // Without the matching public key, a --dev row stays fail-closed (pinned production key).
        expect(yield* V2ProviderTurn.ownerQualified(db, result.campaign_id)).toBe(false)

        const revoked = yield* Effect.promise(() =>
          runMint(["--dev", "--revoke", "--db", dbFile, "--campaign", result.campaign_id]),
        )
        expect(revoked.exitCode, revoked.stderr).toBe(0)
        const revokedResult = JSON.parse(revoked.stdout) as { status: string }
        expect(revokedResult.status).toBe("revoked")
        expect(
          yield* V2ProviderTurn.ownerQualified(db, result.campaign_id).pipe(
            Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, result.public_key_pem),
          ),
        ).toBe(false)
      }),
    )
  })

  test("W0.5 blocker-1: default campaign end-to-end — mint with DEFAULT arguments, no campaign env, ownerQualified(db, undefined) passes", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    const minted = await runMint(["--dev", "--db", dbFile])
    expect(minted.exitCode, minted.stderr).toBe(0)
    const result = JSON.parse(minted.stdout) as {
      campaign_id: string
      build_identity: string
      public_key_pem: string
    }
    // Default campaign derivation: v2-owner-<package.json version> — the SAME version the release
    // build defines as DEEPAGENT_CODE_VERSION (this process's InstallationVersion via the fixture).
    expect(result.campaign_id).toBe(`v2-owner-${pkgVersion}`)
    expect(result.build_identity).toBe(pkgVersion)
    expect(InstallationVersion).toBe(pkgVersion)

    await run(
      dbFile,
      Effect.gen(function* () {
        const db = yield* makeDb
        // No DEEPAGENT_CODE_V2_OWNER_CAMPAIGN env (deleted at module load): the runtime must
        // resolve the default campaign itself; identity too (no DEEPAGENT_CODE_V2_BUILD_IDENTITY).
        expect(V2ProviderTurn.ownerCampaignFromEnv()).toBeUndefined()
        expect(V2ProviderTurn.defaultOwnerCampaign()).toBe(`v2-owner-${pkgVersion}`)
        const qualified = yield* V2ProviderTurn.ownerQualified(db, undefined).pipe(
          Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, result.public_key_pem),
        )
        expect(qualified).toBe(true)
        // And the CurrentOwnerCampaign reference (used by the turn gate) resolves the same value.
        const campaign = yield* V2ProviderTurn.CurrentOwnerCampaign
        expect(campaign).toBe(`v2-owner-${pkgVersion}`)
      }),
    )
  })

  test("CurrentBuildIdentity falls back to the installation-version identity when env is unset", async () => {
    delete process.env.DEEPAGENT_CODE_V2_BUILD_IDENTITY
    await run(
      ":memory:",
      Effect.gen(function* () {
        const identity = yield* Effect.serviceOption(V2ProviderTurn.CurrentBuildIdentity)
        expect(Option.getOrThrow(identity)).toEqual(V2ProviderTurn.buildIdentityFromVersion(InstallationVersion))
      }),
    )
  })

  test("a minted row for a different build identity does not qualify the default install", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    const minted = await runMint(["--dev", "--db", dbFile, "--build-identity", "9.9.9"])
    expect(minted.exitCode, minted.stderr).toBe(0)
    const result = JSON.parse(minted.stdout) as { campaign_id: string; public_key_pem: string }
    expect(result.campaign_id).toBe("v2-owner-9.9.9")

    await run(
      dbFile,
      Effect.gen(function* () {
        const db = yield* makeDb
        const qualified = yield* V2ProviderTurn.ownerQualified(db, result.campaign_id).pipe(
          Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, result.public_key_pem),
        )
        expect(qualified).toBe(false)
        expect(
          yield* V2ProviderTurn.ownerQualified(db, result.campaign_id).pipe(
            Effect.provideService(V2ProviderTurn.CurrentBuildIdentity, V2ProviderTurn.buildIdentityFromVersion("9.9.9")),
            Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, result.public_key_pem),
          ),
        ).toBe(true)
      }),
    )
  })

  test("re-minting the same campaign is an idempotent no-op", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    const first = await runMint(["--dev", "--db", dbFile, "--build-identity", "1.2.3"])
    expect(first.exitCode, first.stderr).toBe(0)
    const second = await runMint(["--dev", "--db", dbFile, "--build-identity", "1.2.3"])
    expect(second.exitCode, second.stderr).toBe(0)
    expect((JSON.parse(second.stdout) as { action: string }).action).toBe("already_present")
  })

  test("W0.5 major-5: re-minting the same campaign with a DIFFERENT identity is identity_mismatch (exit 1) and never overwrites", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    const first = await runMint(["--dev", "--db", dbFile, "--build-identity", "1.2.3"])
    expect(first.exitCode, first.stderr).toBe(0)
    const result = JSON.parse(first.stdout) as { campaign_id: string }
    const mismatch = await runMint(["--dev", "--db", dbFile, "--build-identity", "9.9.9", "--campaign", result.campaign_id])
    expect(mismatch.exitCode).toBe(1)
    const parsed = JSON.parse(mismatch.stdout) as {
      action: string
      requested: Record<string, string>
      stored: Record<string, string>
    }
    expect(parsed.action).toBe("identity_mismatch")
    expect(parsed.requested).toEqual(V2ProviderTurn.buildIdentityFromVersion("9.9.9"))
    expect(parsed.stored).toEqual(
      expect.objectContaining({
        subjectCommit: V2ProviderTurn.buildIdentityFromVersion("1.2.3").subjectCommit,
        packageDigest: V2ProviderTurn.buildIdentityFromVersion("1.2.3").packageDigest,
      }),
    )
    // The stored row is untouched: minting 1.2.3 again is still an idempotent no-op.
    const again = await runMint(["--dev", "--db", dbFile, "--build-identity", "1.2.3"])
    expect(again.exitCode, again.stderr).toBe(0)
    expect((JSON.parse(again.stdout) as { action: string }).action).toBe("already_present")
  })

  test("W0.5 minor-8b/8c: revoking an already-revoked campaign reports already_revoked (exit 0)", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    const minted = await runMint(["--dev", "--db", dbFile, "--build-identity", "1.2.3"])
    expect(minted.exitCode, minted.stderr).toBe(0)
    const campaign = (JSON.parse(minted.stdout) as { campaign_id: string }).campaign_id
    const revoked = await runMint(["--dev", "--revoke", "--db", dbFile, "--campaign", campaign])
    expect(revoked.exitCode, revoked.stderr).toBe(0)
    expect((JSON.parse(revoked.stdout) as { action: string }).action).toBe("revoked")
    const again = await runMint(["--dev", "--revoke", "--db", dbFile, "--campaign", campaign])
    expect(again.exitCode, again.stderr).toBe(0)
    expect((JSON.parse(again.stdout) as { action: string }).action).toBe("already_revoked")
  })

  test("W0.5 minor-10: --renew re-signs the same campaign with a fresh 90-day window", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    // Use ONE explicit issuance key so the renewed row verifies in-process afterwards (the default
    // --dev flow generates a new ephemeral pair per run, which would break the round trip).
    const issuance = V2OwnerAuthorization.generateAuthorizationKeyPair()
    const minted = await runMint(
      ["--db", dbFile, "--build-identity", "1.2.3"],
      { DEEPAGENT_CODE_OWNER_SIGNING_KEY: issuance.privateKeyPem },
    )
    expect(minted.exitCode, minted.stderr).toBe(0)
    const first = JSON.parse(minted.stdout) as { campaign_id: string; expires_at: number }
    const renew = await runMint(
      ["--db", dbFile, "--build-identity", "1.2.3", "--campaign", first.campaign_id, "--renew"],
      { DEEPAGENT_CODE_OWNER_SIGNING_KEY: issuance.privateKeyPem },
    )
    expect(renew.exitCode, renew.stderr).toBe(0)
    const renewed = JSON.parse(renew.stdout) as { action: string; expires_at: number }
    expect(renewed.action).toBe("renewed")
    const day = 24 * 60 * 60 * 1_000
    expect(renewed.action).toBe("renewed")
    // The renewed window is a FRESH 90 days from renewal time (it starts over, not stacks).
    const renewNow = Date.now()
    expect(renewed.expires_at - renewNow).toBeGreaterThan(89 * day - 60_000)
    expect(renewed.expires_at - renewNow).toBeLessThan(91 * day)

    await run(
      dbFile,
      Effect.gen(function* () {
        const db = yield* makeDb
        // Renewal is a REAL re-issue: same identity, extended window, signature verifies.
        const qualified = yield* V2ProviderTurn.ownerQualified(db, first.campaign_id).pipe(
          Effect.provideService(V2ProviderTurn.CurrentBuildIdentity, V2ProviderTurn.buildIdentityFromVersion("1.2.3")),
          Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, issuance.publicKeyPem),
        )
        expect(qualified).toBe(true)
      }),
    )
    // A second renewal simply re-issues a fresh window from now (the window restarts; there is no
    // benefit to claiming a no-op — renewal is the operator's explicit re-issue action).
    const again = await runMint(
      ["--db", dbFile, "--build-identity", "1.2.3", "--campaign", first.campaign_id, "--renew"],
      { DEEPAGENT_CODE_OWNER_SIGNING_KEY: issuance.privateKeyPem },
    )
    expect(again.exitCode, again.stderr).toBe(0)
    const againParsed = JSON.parse(again.stdout) as { action: string; expires_at: number }
    expect(againParsed.action).toBe("renewed")
    expect(againParsed.expires_at - Date.now()).toBeGreaterThan(89 * day - 60_000)
    expect(againParsed.expires_at - Date.now()).toBeLessThan(91 * day)
  })

  test("W0.5 mint --export writes the full row (with signature, never the private key)", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    const exportFile = join(tmp.path, "owner-authorization.json")
    const minted = await runMint(["--dev", "--db", dbFile, "--export", exportFile])
    expect(minted.exitCode, minted.stderr).toBe(0)
    expect(existsSync(exportFile)).toBe(true)
    const exported = JSON.parse(await Bun.file(exportFile).text()) as Record<string, unknown>
    expect(exported).toMatchObject({
      campaign_id: `v2-owner-${pkgVersion}`,
      build_identity: pkgVersion,
      status: "active",
    })
    // Full row fields the runtime verifier checks, including the signature.
    for (const key of [
      "authorization_id",
      "subject_commit",
      "subject_tree",
      "schema_digest",
      "build_id",
      "package_digest",
      "valid_from",
      "expires_at",
      "signature_digest",
      "authorization_digest",
      "created_at",
    ]) {
      expect(exported[key], key).toBeDefined()
    }
    // The private key never enters the export.
    expect(JSON.stringify(exported)).not.toContain("-----BEGIN")
    expect(JSON.stringify(exported)).not.toContain("private")
  })

  test("fails closed without a signing key when not in --dev mode", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    const minted = await runMint(["--db", dbFile, "--build-identity", "2.0.0-beta.0"])
    expect(minted.exitCode).not.toBe(0)
    expect(minted.stderr).toContain("fail-closed")
    expect(minted.stderr).toContain("DEEPAGENT_CODE_OWNER_SIGNING_KEY")
    expect(existsSync(dbFile)).toBe(false)
    const revoked = await runMint(["--revoke", "--db", dbFile, "--campaign", "v2-owner-2.0.0-beta.0"])
    expect(revoked.exitCode).not.toBe(0)
    expect(revoked.stderr).toContain("fail-closed")
  })

  test("W0.8 review new-3: the idempotent no-op of an EXPIRED row fails closed (exit 1) and suggests --renew", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    // First run creates the schema (and an unexpired row for a scratch campaign) in the db file.
    await runMint(["--dev", "--db", dbFile, "--build-identity", "1.2.3"])
    // Reuse the minted schema to insert an EXPIRED row for a second campaign, same identity.
    const identity = V2ProviderTurn.buildIdentityFromVersion("1.2.3")
    const sqlite = new Database(dbFile)
    sqlite
      .query(
        `INSERT INTO session_v2_owner_authorization (
           authorization_id, campaign_id, subject_commit, subject_tree, schema_digest, build_id,
           package_digest, valid_from, expires_at, status, signature_digest, authorization_digest,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        "auth_expired_noop",
        "v2-owner-expired-case",
        identity.subjectCommit,
        identity.subjectTree,
        identity.schemaDigest,
        identity.buildID,
        identity.packageDigest,
        1_000,
        2_000,
        "a".repeat(128),
        "b".repeat(64),
        1_000,
      )
    sqlite.close()
    const rerun = await runMint([
      "--dev",
      "--db",
      dbFile,
      "--build-identity",
      "1.2.3",
      "--campaign",
      "v2-owner-expired-case",
      "--export",
      join(tmp.path, "must-not-be-written.json"),
    ])
    expect(rerun.exitCode).toBe(1)
    const parsed = JSON.parse(rerun.stdout) as {
      action: string
      expired: boolean
      suggest: string
    }
    expect(parsed.action).toBe("already_present")
    expect(parsed.expired).toBe(true)
    expect(parsed.suggest).toBe("--renew")
    expect(rerun.stderr).toContain("--renew")
    // An expired authorization must never be re-exported as if it were valid.
    expect(existsSync(join(tmp.path, "must-not-be-written.json"))).toBe(false)
  })

  test("W0.8 review new-3: the idempotent no-op of an UNEXPIRED row stays exit 0 and re-exports a VALID row", async () => {
    await using tmp = await tmpdir()
    const dbFile = join(tmp.path, "owner.sqlite")
    const exportFile = join(tmp.path, "owner-authorization.json")
    const first = await runMint(["--dev", "--db", dbFile, "--build-identity", "3.4.5"])
    expect(first.exitCode, first.stderr).toBe(0)
    const again = await runMint(["--dev", "--db", dbFile, "--build-identity", "3.4.5", "--export", exportFile])
    expect(again.exitCode, again.stderr).toBe(0)
    const parsed = JSON.parse(again.stdout) as { action: string; expired?: boolean }
    expect(parsed.action).toBe("already_present")
    expect(parsed.expired).toBeUndefined()
    const exported = JSON.parse(await Bun.file(exportFile).text()) as {
      status: string
      expires_at: number
      signature_digest: string
    }
    expect(exported.status).toBe("active")
    expect(exported.expires_at).toBeGreaterThan(Date.now())
    expect(exported.signature_digest).toMatch(/^[0-9a-f]{128}$/)
  })

  test("W0.8 review new-5: a REAL PEM file whose PATH contains the BEGIN marker is read as a file, not as inline PEM", async () => {
    await using tmp = await tmpdir()
    const issuance = V2OwnerAuthorization.generateAuthorizationKeyPair()
    const keyFile = join(tmp.path, "key-----BEGIN-private.pem")
    await Bun.write(keyFile, issuance.privateKeyPem)
    const dbFile = join(tmp.path, "owner.sqlite")
    const minted = await runMint(["--db", dbFile, "--build-identity", "1.2.3"], {
      DEEPAGENT_CODE_OWNER_SIGNING_KEY: keyFile,
    })
    // Old discrimination would treat the path as inline PEM (because it contains the marker) and
    // fail createPrivateKey; the fix reads the file because it exists.
    expect(minted.exitCode, minted.stderr).toBe(0)
    expect((JSON.parse(minted.stdout) as { action: string }).action).toBe("minted")
  })

  test("W0.8 review minor-4: an installation version that cannot form a legal campaign id fails closed (false), never throws", async () => {
    // The compile-time InstallationVersion cannot be changed in-process, so run the same module
    // in a fresh bun child with a hostile DEEPAGENT_CODE_VERSION global (same pattern as the mint
    // subprocess): `+` build metadata makes `v2-owner-2.0.0-beta.0+...` an illegal campaign id.
    const probe = `
      globalThis.DEEPAGENT_CODE_VERSION = "2.0.0-beta.0+exp.sha.17b0d"
      const { V2ProviderTurn } = await import(${JSON.stringify(new URL("../src/session/runner/v2-provider-turn.ts", import.meta.url).href)})
      const { Database } = await import(${JSON.stringify(new URL("../src/database/database.ts", import.meta.url).href)})
      const { Effect } = await import("effect")
      try {
        const db = (await Effect.runPromise(
          Effect.service(Database.Service).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
        )).db
        const qualified = await Effect.runPromise(V2ProviderTurn.ownerQualified(db, undefined))
        console.log(JSON.stringify({ campaign: V2ProviderTurn.defaultOwnerCampaign(), qualified }))
      } catch (error) {
        console.log(JSON.stringify({ threw: String(error) }))
        process.exit(2)
      }
    `
    const child = Bun.spawn([process.execPath, "-e", probe], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DEEPAGENT_CODE_OWNER_SIGNING_KEY: "" },
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    const parsed = JSON.parse(stdout.trim()) as { campaign?: string; qualified?: boolean; threw?: string }
    expect(parsed.threw).toBeUndefined()
    expect(parsed.campaign).toBeUndefined()
    expect(parsed.qualified).toBe(false)
  })
})
