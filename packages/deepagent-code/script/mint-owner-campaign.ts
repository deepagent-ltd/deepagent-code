// Production mint tool for the V2 owner authorization chain (v2.0 design W0.3). Writes ONE signed
// row into session_v2_owner_authorization so a default install can pass ownerQualified for a given
// build identity, or revokes an existing row. It reuses the core Ed25519 signing implementation
// (V2OwnerAuthorization.signAuthorization / authorizationPayload) — the same code the runtime
// verifier checks — so the signed payload, encoding, and field names can never drift.
//
// Usage (from packages/deepagent-code):
//   DEEPAGENT_CODE_OWNER_SIGNING_KEY=<private-key-pem-or-file> \
//     bun script/mint-owner-campaign.ts [--build-identity <version-or-git-describe>] \
//     [--campaign <id>] [--db <path>]
//   bun script/mint-owner-campaign.ts --dev [--build-identity <version>] [--campaign <id>] [--db <path>]
//   bun script/mint-owner-campaign.ts --revoke [--campaign <id>] [--db <path>] [--dev]
//
// The signing key comes from the DEEPAGENT_CODE_OWNER_SIGNING_KEY env: either the Ed25519 private
// key PEM inline, or a path to a PEM file (same file convention as script/v2-campaign-sign.ts).
// Without a key and without --dev the script fails closed (exit 1): an unsigned row could never
// verify against the pinned issuance public key anyway.
//
// Output contract: machine-readable JSON on stdout (included in the captured result below), human
// notices on stderr.
import { Database } from "bun:sqlite"
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import os from "node:os"
import { Effect } from "effect"
import { V2OwnerAuthorization } from "@deepagent-code/core/session/runner/v2-owner-authorization"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"

const DAY_MS = 24 * 60 * 60 * 1_000
const DEFAULT_VALIDITY_DAYS = 90

const args = process.argv.slice(2)
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const hasFlag = (flag: string) => args.includes(flag)

// Keep this DDL in sync with migrations
// 20260823090000_v2_owner_authorization + 20260824100000_v2_owner_authorization_ed25519_signature
// (if they diverge, the runtime verifier stops matching this tool). It is idempotent: an
// already-migrated database is untouched, and a fresh --dev database is usable immediately.
function ensureOwnerAuthorizationSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS session_v2_owner_authorization (
      authorization_id TEXT PRIMARY KEY NOT NULL,
      campaign_id TEXT NOT NULL,
      subject_commit TEXT NOT NULL,
      subject_tree TEXT NOT NULL,
      schema_digest TEXT NOT NULL,
      build_id TEXT NOT NULL,
      package_digest TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      signature_digest TEXT NOT NULL,
      authorization_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )
  `)
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS session_v2_owner_authorization_campaign_idx
    ON session_v2_owner_authorization (campaign_id)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS session_v2_owner_authorization_active_idx
    ON session_v2_owner_authorization (status, expires_at, campaign_id)
  `)
  // Re-created at the CURRENT (Ed25519, 128-hex) state so a pre-migration database is upgraded
  // in place; identical triggers are replaced with themselves.
  db.run("DROP TRIGGER IF EXISTS session_v2_owner_authorization_insert_guard")
  db.run(`
    CREATE TRIGGER session_v2_owner_authorization_insert_guard
    BEFORE INSERT ON session_v2_owner_authorization
    WHEN length(trim(NEW.authorization_id)) = 0
      OR length(trim(NEW.campaign_id)) = 0
      OR length(NEW.subject_commit) != 40
      OR NEW.subject_commit GLOB '*[^0-9a-f]*'
      OR length(NEW.subject_tree) != 40
      OR NEW.subject_tree GLOB '*[^0-9a-f]*'
      OR length(NEW.schema_digest) != 64
      OR NEW.schema_digest GLOB '*[^0-9a-f]*'
      OR length(NEW.build_id) != 64
      OR NEW.build_id GLOB '*[^0-9a-f]*'
      OR length(NEW.package_digest) != 64
      OR NEW.package_digest GLOB '*[^0-9a-f]*'
      OR length(NEW.signature_digest) != 128
      OR NEW.signature_digest GLOB '*[^0-9a-f]*'
      OR length(NEW.authorization_digest) != 64
      OR NEW.authorization_digest GLOB '*[^0-9a-f]*'
      OR NEW.status != 'active'
      OR NEW.valid_from >= NEW.expires_at
      OR NEW.revoked_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'invalid v2 owner authorization');
    END
  `)
  db.run("DROP TRIGGER IF EXISTS session_v2_owner_authorization_update_guard")
  db.run(`
    CREATE TRIGGER session_v2_owner_authorization_update_guard
    BEFORE UPDATE ON session_v2_owner_authorization
    WHEN NEW.authorization_id != OLD.authorization_id
      OR NEW.campaign_id != OLD.campaign_id
      OR NEW.subject_commit != OLD.subject_commit
      OR NEW.subject_tree != OLD.subject_tree
      OR NEW.schema_digest != OLD.schema_digest
      OR NEW.build_id != OLD.build_id
      OR NEW.package_digest != OLD.package_digest
      OR NEW.valid_from != OLD.valid_from
      OR NEW.expires_at != OLD.expires_at
      OR NEW.signature_digest != OLD.signature_digest
      OR NEW.authorization_digest != OLD.authorization_digest
      OR NEW.created_at != OLD.created_at
      OR NOT (OLD.status = 'active' AND NEW.status = 'revoked')
      OR NEW.revoked_at IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'v2 owner authorization is immutable');
    END
  `)
  db.run("DROP TRIGGER IF EXISTS session_v2_owner_authorization_delete_guard")
  db.run(`
    CREATE TRIGGER session_v2_owner_authorization_delete_guard
    BEFORE DELETE ON session_v2_owner_authorization
    BEGIN
      SELECT RAISE(ABORT, 'v2 owner authorization is append only');
    END
  `)
}

function loadSigningKey(): string | undefined {
  const raw = process.env.DEEPAGENT_CODE_OWNER_SIGNING_KEY?.trim()
  if (!raw) return undefined
  const pem = raw.includes("-----BEGIN") ? raw : readFileSync(raw, "utf8")
  if (!pem.includes("-----BEGIN")) {
    throw new Error(
      "DEEPAGENT_CODE_OWNER_SIGNING_KEY is neither an Ed25519 private key PEM nor a path to a PEM file",
    )
  }
  // Parsing validates the key; malformed keys fail closed here instead of at write time.
  createPrivateKey(pem)
  return pem
}

function derivePublicKeyPem(privateKeyPem: string) {
  return createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString()
}

const buildIdentity = valueAfter("--build-identity")
  ?? (JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()) as { version: string }).version
const campaignId = valueAfter("--campaign") ?? `v2-owner-${buildIdentity}`
const dbPath = valueAfter("--db") ?? join(os.homedir(), ".deepagent", "code", "deepagent-code-local.db")
const isDev = hasFlag("--dev")
const isRevoke = hasFlag("--revoke")

if (isRevoke) {
  // Revocation needs the signing key too (operator-held credential, not just DB access);
  // --dev may skip the key and the signature check.
  let privateKeyPem: string | undefined
  try {
    privateKeyPem = loadSigningKey()
  } catch (error) {
    console.error(`[mint-owner-campaign] fail-closed: ${(error as Error).message}`)
    process.exit(1)
  }
  if (!privateKeyPem && !isDev) {
    console.error(
      "[mint-owner-campaign] fail-closed: production revoke requires DEEPAGENT_CODE_OWNER_SIGNING_KEY (the campaign issuer's private key). Use --dev for local revoke.",
    )
    process.exit(1)
  }
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.run("PRAGMA busy_timeout = 5000")
  ensureOwnerAuthorizationSchema(db)
  const row = db
    .query("SELECT * FROM session_v2_owner_authorization WHERE campaign_id = ?")
    .get(campaignId) as Row | null
  if (!row) {
    console.error(`[mint-owner-campaign] no authorization row for campaign ${campaignId} in ${dbPath}`)
    process.exit(1)
  }
  if (row.status !== "active") {
    console.error(`[mint-owner-campaign] campaign ${campaignId} is already ${row.status} — nothing to revoke`)
    console.log(JSON.stringify({ action: "revoked", campaign_id: campaignId, status: row.status, db: dbPath }))
    process.exit(0)
  }
  if (privateKeyPem) {
    const fields: V2OwnerAuthorization.AuthorizationFields = {
      authorizationID: row.authorization_id,
      campaignID: row.campaign_id,
      subjectCommit: row.subject_commit,
      subjectTree: row.subject_tree,
      schemaDigest: row.schema_digest,
      buildID: row.build_id,
      packageDigest: row.package_digest,
      validFrom: row.valid_from,
      expiresAt: row.expires_at,
      signatureDigest: row.signature_digest,
    }
    const ok = Effect.runSync(V2OwnerAuthorization.verifyAuthorization(derivePublicKeyPem(privateKeyPem), fields))
    if (!ok) {
      console.error(
        `[mint-owner-campaign] fail-closed: DEEPAGENT_CODE_OWNER_SIGNING_KEY does not match the signature on campaign ${campaignId}; refusing to revoke with the wrong key`,
      )
      process.exit(1)
    }
  } else {
    console.error("[mint-owner-campaign] WARN: --dev revoke without a signing key — skipping key-match check")
  }
  const updated = db
    .query("UPDATE session_v2_owner_authorization SET status = 'revoked', revoked_at = ? WHERE campaign_id = ? AND status = 'active'")
    .run(Date.now(), campaignId)
  db.close()
  if (updated.changes === 0) {
    console.error(`[mint-owner-campaign] campaign ${campaignId} was not active — nothing changed`)
    process.exit(1)
  }
  console.error(`[mint-owner-campaign] revoked ${campaignId} in ${dbPath}`)
  console.log(JSON.stringify({ action: "revoked", campaign_id: campaignId, status: "revoked", db: dbPath }))
  process.exit(0)
}

// ── Mint (insert or no-op if the row already exists) ────────────────────────────────────────────
let privateKeyPem: string | undefined
try {
  privateKeyPem = loadSigningKey()
} catch (error) {
  console.error(`[mint-owner-campaign] fail-closed: ${(error as Error).message}`)
  process.exit(1)
}
if (!privateKeyPem && !isDev) {
  console.error(
    "[mint-owner-campaign] fail-closed: release minting requires DEEPAGENT_CODE_OWNER_SIGNING_KEY (the campaign issuer's Ed25519 private key, PEM or path to a PEM file). Use --dev only for local verification runs.",
  )
  process.exit(1)
}
if (!privateKeyPem) {
  // Dev-only: the storage guards require a real 128-hex signature, so generate an ephemeral
  // issuance pair. The row verifies only when the verifier is pointed at the printed public key.
  privateKeyPem = V2OwnerAuthorization.generateAuthorizationKeyPair().privateKeyPem
  console.error(
    "[mint-owner-campaign] WARN --dev: no DEEPAGENT_CODE_OWNER_SIGNING_KEY — minted with an EPHEMERAL key; this row will NOT verify against the pinned production key. Point the verifier at the printed public key (DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY) for local use.",
  )
}

const identity = V2ProviderTurn.buildIdentityFromVersion(buildIdentity)
const now = Date.now()
const signable = {
  authorizationID: `auth_v2_owner_${randomUUID().slice(0, 8)}`,
  campaignID: campaignId,
  ...identity,
  validFrom: now - 1_000,
  expiresAt: now + DEFAULT_VALIDITY_DAYS * DAY_MS,
}
const signatureDigest = V2OwnerAuthorization.signAuthorization(privateKeyPem, signable)
const authorizationDigest = createHash("sha256")
  .update(V2OwnerAuthorization.authorizationPayload(signable))
  .digest("hex")
const publicKeyPem = derivePublicKeyPem(privateKeyPem)

if (!isDev && publicKeyPem.trim() !== V2OwnerAuthorization.PRODUCTION_OWNER_AUTHORIZATION_PUBLIC_KEY.trim()) {
  console.error(
    "[mint-owner-campaign] WARN: the signing key's public half does NOT match the pinned production issuance key (PRODUCTION_OWNER_AUTHORIZATION_PUBLIC_KEY) — a default install will fail owner verification until the runtime pins this key in a reviewed commit",
  )
}

mkdirSync(dirname(dbPath), { recursive: true })
const db = new Database(dbPath)
db.run("PRAGMA busy_timeout = 5000")
ensureOwnerAuthorizationSchema(db)
const existing = db
  .query("SELECT status FROM session_v2_owner_authorization WHERE campaign_id = ?")
  .get(campaignId) as { status: string } | null
if (existing) {
  db.close()
  if (existing.status === "revoked") {
    console.error(
      `[mint-owner-campaign] campaign ${campaignId} exists as ${existing.status} — rows are immutable; mint with a new --campaign (or a new --build-identity)`,
    )
    process.exit(1)
  }
  console.error(`[mint-owner-campaign] campaign ${campaignId} already present (active) — idempotent no-op`)
  console.log(
    JSON.stringify({
      action: "already_present",
      campaign_id: campaignId,
      build_identity: buildIdentity,
      status: "active",
      db: dbPath,
    }),
  )
  process.exit(0)
}
db.query(
  `INSERT INTO session_v2_owner_authorization (
     authorization_id, campaign_id, subject_commit, subject_tree, schema_digest, build_id,
     package_digest, valid_from, expires_at, status, signature_digest, authorization_digest,
     created_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
).run(
  signable.authorizationID,
  signable.campaignID,
  identity.subjectCommit,
  identity.subjectTree,
  identity.schemaDigest,
  identity.buildID,
  identity.packageDigest,
  signable.validFrom,
  signable.expiresAt,
  signatureDigest,
  authorizationDigest,
  now,
)
db.close()

console.error(
  `[mint-owner-campaign] minted ${campaignId} (${signable.authorizationID}) for build identity ${buildIdentity} in ${dbPath}; valid ${DEFAULT_VALIDITY_DAYS} days`,
)
console.log(
  JSON.stringify({
    action: "minted",
    campaign_id: campaignId,
    authorization_id: signable.authorizationID,
    build_identity: buildIdentity,
    status: "active",
    valid_from: signable.validFrom,
    expires_at: signable.expiresAt,
    signature_digest: signatureDigest,
    authorization_digest: authorizationDigest,
    db: dbPath,
    ...(isDev ? { public_key_pem: publicKeyPem } : {}),
  }),
)

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
  signature_digest: string
  status: string
}
