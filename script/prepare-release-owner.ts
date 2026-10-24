#!/usr/bin/env bun

import { createPublicKey, verify } from "node:crypto"
import path from "node:path"

export async function prepareReleaseOwner(input: {
  version: string
  authorizationJSON?: string
  publicKeyPEM?: string
  outputDirectory: string
  reuseRequired: boolean
}) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(input.version))
    throw new Error("Release owner version is invalid")
  const authorizationJSON = input.authorizationJSON ?? ""
  const publicKeyPEM = input.publicKeyPEM ?? ""
  if (!authorizationJSON.trim() && !publicKeyPEM.trim()) {
    if (input.reuseRequired) throw new Error("Existing release requires its original owner pair")
    return { reuse: false } as const
  }
  if (!authorizationJSON.trim() || !publicKeyPEM.trim()) throw new Error("Release owner pair is incomplete")
  if (authorizationJSON.includes("PRIVATE KEY") || publicKeyPEM.includes("PRIVATE KEY"))
    throw new Error("Release owner inputs must not contain private keys")
  if (!path.isAbsolute(input.outputDirectory)) throw new Error("Release owner output directory must be absolute")
  const parsed: unknown = JSON.parse(authorizationJSON)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Release owner export shape is invalid")
  const row = parsed as Record<string, unknown>
  if (
    Object.keys(row).length !== 14 ||
    typeof row.authorization_id !== "string" ||
    !row.authorization_id.trim() ||
    typeof row.campaign_id !== "string" ||
    typeof row.subject_commit !== "string" ||
    typeof row.subject_tree !== "string" ||
    typeof row.schema_digest !== "string" ||
    typeof row.build_id !== "string" ||
    typeof row.package_digest !== "string" ||
    typeof row.signature_digest !== "string" ||
    !/^[0-9a-f]{128}$/.test(row.signature_digest) ||
    typeof row.authorization_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.authorization_digest) ||
    typeof row.valid_from !== "number" ||
    typeof row.expires_at !== "number" ||
    typeof row.created_at !== "number" ||
    typeof row.build_identity !== "string" ||
    row.status !== "active" ||
    ![row.valid_from, row.expires_at, row.created_at].every((value) => Number.isSafeInteger(value) && value >= 0)
  )
    throw new Error("Release owner export shape is invalid")
  const now = Date.now()
  if (row.valid_from > now || row.expires_at <= now || row.valid_from >= row.expires_at || row.created_at > now)
    throw new Error("Release owner authorization is outside its validity window")
  const { V2OwnerAuthorization } = await import("../packages/core/src/session/runner/v2-owner-authorization")
  const { V2ProviderTurn } = await import("../packages/core/src/session/runner/v2-provider-turn")
  const fields = {
    authorizationID: row.authorization_id,
    campaignID: row.campaign_id,
    subjectCommit: row.subject_commit,
    subjectTree: row.subject_tree,
    schemaDigest: row.schema_digest,
    buildID: row.build_id,
    packageDigest: row.package_digest,
    validFrom: row.valid_from,
    expiresAt: row.expires_at,
  }
  const identity = V2ProviderTurn.buildIdentityFromVersion(input.version)
  if (
    row.build_identity !== input.version ||
    row.campaign_id !== `v2-owner-${input.version}` ||
    Object.entries(identity).some(([name, value]) => fields[name as keyof typeof identity] !== value)
  )
    throw new Error("Release owner authorization belongs to another version")
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/.test(publicKeyPEM.trim()))
    throw new Error("Release owner public key is invalid")
  const key = createPublicKey(publicKeyPEM)
  const payload = V2OwnerAuthorization.authorizationPayload(fields)
  if (
    key.asymmetricKeyType !== "ed25519" ||
    Bun.CryptoHasher.hash("sha256", payload, "hex") !== row.authorization_digest ||
    !verify(null, Buffer.from(payload), key, Buffer.from(row.signature_digest, "hex"))
  )
    throw new Error("Release owner authorization does not verify")
  // Preserve the issuer's bytes: reserializing this public pair would change artifact hashes.
  await Bun.write(path.join(input.outputDirectory, "owner-authorization.json"), authorizationJSON)
  await Bun.write(path.join(input.outputDirectory, "release-owner-public-key.pem"), publicKeyPEM)
  return { reuse: true } as const
}

if (import.meta.main) {
  const result = await prepareReleaseOwner({
    version: process.env.DAC_OWNER_VERSION ?? "",
    authorizationJSON: process.env.DAC_OWNER_AUTHORIZATION_JSON,
    publicKeyPEM: process.env.DAC_OWNER_PUBLIC_KEY_PEM,
    outputDirectory: process.env.RUNNER_TEMP ?? "",
    reuseRequired: process.env.DAC_OWNER_REUSE_REQUIRED === "true",
  }).catch(() => {
    console.error("Release owner input verification failed; no replacement owner was issued")
    process.exit(1)
  })
  if (process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT, `reuse=${result.reuse}\n`)
  console.log(JSON.stringify(result))
}
