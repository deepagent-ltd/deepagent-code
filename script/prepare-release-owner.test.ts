import { expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { V2OwnerAuthorization } from "../packages/core/src/session/runner/v2-owner-authorization"
import { V2ProviderTurn } from "../packages/core/src/session/runner/v2-provider-turn"
import { prepareReleaseOwner } from "./prepare-release-owner"

function owner(overrides: Partial<{ validFrom: number; expiresAt: number }> = {}) {
  const pair = generateKeyPairSync("ed25519")
  const fields = {
    authorizationID: "auth_v2_owner_fixture",
    campaignID: "v2-owner-2.0.5",
    ...V2ProviderTurn.buildIdentityFromVersion("2.0.5"),
    validFrom: Date.now() - 60_000,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }
  const payload = V2OwnerAuthorization.authorizationPayload(fields)
  const row = {
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
    signature_digest: sign(null, Buffer.from(payload), pair.privateKey).toString("hex"),
    authorization_digest: Bun.CryptoHasher.hash("sha256", payload, "hex"),
    created_at: Date.now() - 60_000,
    build_identity: "2.0.5",
  }
  return {
    row,
    authorizationJSON: `\n${JSON.stringify(row, null, 2)}\n`,
    publicKeyPEM: pair.publicKey.export({ type: "spki", format: "pem" }).toString() + "\n",
    privateKeyPEM: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
}

test("reuses the actual signed owner pair without changing either input's bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-release-owner-"))
  try {
    const fixture = owner()
    const outputDirectory = path.join(root, "verified")
    expect(await prepareReleaseOwner({ version: "2.0.5", ...fixture, outputDirectory, reuseRequired: true })).toEqual({
      reuse: true,
    })
    expect(await Bun.file(path.join(outputDirectory, "owner-authorization.json")).text()).toBe(
      fixture.authorizationJSON,
    )
    expect(await Bun.file(path.join(outputDirectory, "release-owner-public-key.pem")).text()).toBe(fixture.publicKeyPEM)
    expect((await readdir(outputDirectory)).toSorted()).toEqual([
      "owner-authorization.json",
      "release-owner-public-key.pem",
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("only an empty pair for a new release permits the caller's initial mint route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-release-owner-empty-"))
  try {
    const input = { version: "2.0.5", outputDirectory: path.join(root, "not-created") }
    expect(await prepareReleaseOwner({ ...input, reuseRequired: false })).toEqual({ reuse: false })
    await expect(prepareReleaseOwner({ ...input, reuseRequired: true })).rejects.toThrow("original owner pair")
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("invalid owner inputs never write a partial or replacement pair", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-release-owner-refused-"))
  try {
    const fixture = owner()
    const other = owner()
    const expired = owner({ expiresAt: Date.now() - 1 })
    const future = owner({ validFrom: Date.now() + 30_000 })
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString()
    const { created_at, ...missingCreatedAt } = fixture.row
    for (const invalid of [
      { version: "2.0.6" },
      { version: "2.0.5\nreuse=false" },
      { authorizationJSON: "" },
      { publicKeyPEM: "" },
      { publicKeyPEM: fixture.privateKeyPEM },
      { publicKeyPEM: fixture.publicKeyPEM + fixture.privateKeyPEM },
      { publicKeyPEM: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n" },
      { publicKeyPEM: rsa },
      { publicKeyPEM: other.publicKeyPEM },
      { authorizationJSON: expired.authorizationJSON },
      { authorizationJSON: future.authorizationJSON },
      { authorizationJSON: "not JSON: PRIVATE_OWNER_INPUT" },
      { authorizationJSON: "[]" },
      { authorizationJSON: JSON.stringify(missingCreatedAt) },
      { authorizationJSON: JSON.stringify({ ...fixture.row, unexpected: true }) },
      { authorizationJSON: JSON.stringify({ ...fixture.row, status: "revoked" }) },
      { authorizationJSON: JSON.stringify({ ...fixture.row, created_at: "1" }) },
      { authorizationJSON: JSON.stringify({ ...fixture.row, created_at: Number.MAX_SAFE_INTEGER + 1 }) },
      { authorizationJSON: JSON.stringify({ ...fixture.row, authorization_id: " " }) },
      { authorizationJSON: JSON.stringify({ ...fixture.row, signature_digest: "0".repeat(128) }) },
      { authorizationJSON: JSON.stringify({ ...fixture.row, authorization_digest: "0".repeat(64) }) },
      { authorizationJSON: JSON.stringify({ ...fixture.row, subject_commit: "0".repeat(40) }) },
      { authorizationJSON: JSON.stringify({ ...fixture.row, build_identity: "2.0.6" }) },
    ]) {
      await expect(
        prepareReleaseOwner({
          version: "2.0.5",
          ...fixture,
          outputDirectory: path.join(root, "not-created"),
          reuseRequired: false,
          ...invalid,
        }),
      ).rejects.toThrow()
      expect(await readdir(root)).toEqual([])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("CLI emits only the reuse decision and refuses an existing release without a pair", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-release-owner-cli-"))
  try {
    const fixture = owner()
    for (const mode of ["reuse", "new", "missing", "partial"]) {
      const outputDirectory = path.join(root, mode)
      const output = path.join(root, `${mode}.output`)
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "prepare-release-owner.ts")], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          DAC_OWNER_VERSION: "2.0.5",
          RUNNER_TEMP: outputDirectory,
          DAC_OWNER_REUSE_REQUIRED: mode === "new" ? "false" : "true",
          GITHUB_OUTPUT: output,
          ...(mode === "reuse" || mode === "partial"
            ? { DAC_OWNER_AUTHORIZATION_JSON: fixture.authorizationJSON }
            : {}),
          ...(mode === "reuse" ? { DAC_OWNER_PUBLIC_KEY_PEM: fixture.publicKeyPEM } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stdout + stderr).not.toContain(fixture.authorizationJSON.trim())
      expect(stdout + stderr).not.toContain(fixture.publicKeyPEM.trim())
      if (mode === "reuse" || mode === "new") {
        expect(code).toBe(0)
        expect(stdout.trim()).toBe(JSON.stringify({ reuse: mode === "reuse" }))
        expect(await Bun.file(output).text()).toBe(`reuse=${mode === "reuse"}\n`)
        continue
      }
      expect(code).toBe(1)
      expect(await Bun.file(output).exists()).toBe(false)
      expect((await readdir(root)).some((name) => name === mode)).toBe(false)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
