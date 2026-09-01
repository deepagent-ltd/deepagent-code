// W0.3 production mint verification: script/mint-owner-campaign.ts (packages/deepagent-code)
// writes a signed session_v2_owner_authorization row that the V2 runtime verifier
// (V2ProviderTurn.ownerQualified) accepts, and --revoke rejects afterwards. The mint script is
// spawned as a CLI process; the verifier runs in this process against the same SQLite file.
import { describe, expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Option } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { InstallationVersion } from "../src/installation/version"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { tmpdir } from "./fixture/tmpdir"

// The mint script must never see a signing key unless a test passes one explicitly, and this
// process must exercise the CurrentBuildIdentity version-derived fallback (no env identity).
delete process.env.DEEPAGENT_CODE_OWNER_SIGNING_KEY
delete process.env.DEEPAGENT_CODE_V2_BUILD_IDENTITY

const script = new URL("../../deepagent-code/script/mint-owner-campaign.ts", import.meta.url)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

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
})
