export * as V2OwnerAuthorization from "./v2-owner-authorization"

import { generateKeyPairSync, sign, verify } from "node:crypto"
import { Effect } from "effect"
import { CanonicalJson } from "../../util/canonical-json"

// Durable internal authorization for the V2 execution owner. An authorization binds the exact
// build identity (subject commit/tree, schema digest, build id, package digest) plus a validity
// window, and is only trustworthy when it carries an Ed25519 signature from the offline
// authorization process. The shipped runtime only ever VERIFIES against the pinned public key
// below; signing capability must stay outside this repository.

export type AuthorizationFields = {
  readonly authorizationID: string
  readonly campaignID: string
  readonly subjectCommit: string
  readonly subjectTree: string
  readonly schemaDigest: string
  readonly buildID: string
  readonly packageDigest: string
  readonly validFrom: number
  readonly expiresAt: number
  readonly signatureDigest: string
}

// Issuance pin: this public key was generated as a one-off pair whose private half was discarded
// immediately; nothing shipped can sign for it. The r0 authorization process must issue its own
// pair and pin the replacement public key through a reviewed commit before any production
// authorization can qualify. Until then owner qualification stays fail-closed false.
// Release issuance public key, injected per-release at build time (define). The 2026-09-11
// ruling retired the held production keypair: each release generates a ONE-TIME Ed25519 pair
// (mint --ephemeral), signs its authorization row, pins the public half HERE via
// DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY, and the private half dies with the mint process. No
// secret is held across releases. Non-injected builds resolve the empty string: production-style
// qualification then fail-closes (no key can verify), while dev builds self-bootstrap through
// V2OwnerDevMint's own keypair.
declare global {
  // eslint-disable-next-line no-var
  const DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY: string | undefined
}

export const RELEASE_OWNER_AUTHORIZATION_PUBLIC_KEY: string =
  typeof DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY === "string" && DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY.trim()
    ? DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY
    : ""

/** @deprecated legacy alias (held-key era); resolves the per-release injected key. */
export const PRODUCTION_OWNER_AUTHORIZATION_PUBLIC_KEY = RELEASE_OWNER_AUTHORIZATION_PUBLIC_KEY

// The signed payload deliberately excludes the signature itself: everything an authorization
// claims (identity binding, validity window, campaign) is covered, and the signature cannot
// appear inside the bytes it signs. Fields are picked explicitly so an object carrying extra
// properties (such as a smuggled signatureDigest) can never alter the signed bytes.
export function authorizationPayload(fields: Omit<AuthorizationFields, "signatureDigest">): string {
  return CanonicalJson.stringify({
    authorizationID: fields.authorizationID,
    campaignID: fields.campaignID,
    subjectCommit: fields.subjectCommit,
    subjectTree: fields.subjectTree,
    schemaDigest: fields.schemaDigest,
    buildID: fields.buildID,
    packageDigest: fields.packageDigest,
    validFrom: fields.validFrom,
    expiresAt: fields.expiresAt,
  })
}

export function signAuthorization(
  privateKeyPem: string,
  fields: Omit<AuthorizationFields, "signatureDigest">,
): string {
  return sign(null, Buffer.from(authorizationPayload(fields)), privateKeyPem).toString("hex")
}

export function verifyAuthorization(publicKeyPem: string, fields: AuthorizationFields): Effect.Effect<boolean> {
  return Effect.sync(() => {
    if (!/^[0-9a-f]{128}$/.test(fields.signatureDigest)) return false
    const { signatureDigest, ...unsigned } = fields
    try {
      return verify(null, Buffer.from(authorizationPayload(unsigned)), publicKeyPem, Buffer.from(signatureDigest, "hex"))
    } catch {
      return false
    }
  })
}

export function generateAuthorizationKeyPair() {
  const pair = generateKeyPairSync("ed25519")
  return {
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
}
