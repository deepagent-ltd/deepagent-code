// Production mint tool for the V2 owner authorization chain (v2.0 design W0.3). Writes ONE signed
// row into session_v2_owner_authorization so a default install can pass ownerQualified for a given
// build identity, or revokes an existing row. It reuses the core Ed25519 signing implementation
// (V2OwnerAuthorization.signAuthorization / authorizationPayload) — the same code the runtime
// verifier checks — so the signed payload, encoding, and field names can never drift.
//
// Usage (from packages/deepagent-code):
//   DEEPAGENT_CODE_OWNER_SIGNING_KEY=<private-key-pem-or-file> \
//     bun script/mint-owner-campaign.ts [--build-identity <version-or-git-describe>] \
//     [--campaign <id>] [--db <path>] [--export <path>] [--renew]
//   bun script/mint-owner-campaign.ts --dev [--build-identity <version>] [--campaign <id>] [--db <path>] \
//     [--export <path>] [--renew]
//   bun script/mint-owner-campaign.ts --revoke [--campaign <id>] [--db <path>] [--dev]
//
// Owner authorization lifecycle (90-day cycle):
//   - Authorization rows are VALID for DEFAULT_VALIDITY_DAYS (90) days from mint time. The runtime
//     fails closed after expires_at, so operations must RENEW the campaign BEFORE the window
//     expires: `--renew` re-signs the SAME campaign/identity with a fresh 90-day window in place
//     (append-only row is not replaced; the signed payload is re-issued by the issuer key).
//   - Renewal is built on the update_guard relaxation below: only a signed re-issue (same
//     authorization_id/campaign/identity, expires_at extended, signature+digest renewed) or the
//     active→revoked transition is allowed. Production user DBs migrated by the core migration
//     still carry the strict guard until the matching migration lands (see the NOTE below).
//   - The release pipeline (publish.yml) mints with the SAME build identity the binaries were
//     built with and exports `owner-authorization.json` (--export) into the release; the runtime
//     seed (packages/core/src/session/runner/v2-owner-seed.ts) delivers the row to user DBs.
//
// Release delivery note (W0.8 review minor-2): the release flow publishes the exported
// owner-authorization.json as a RELEASE ASSET; fetching that asset on the install side (repo-root
// install script / desktop packaging resources) is a release deliverable (see v2.0-design W0.5
// note and the RELEASE-GO checklist), not code in this repo.
//
// The signing key comes from the DEEPAGENT_CODE_OWNER_SIGNING_KEY env: either the Ed25519 private
// key PEM inline, or a path to a PEM file (same file convention as script/v2-campaign-sign.ts).
// Without a key and without --dev the script fails closed (exit 1): an unsigned row could never
// verify against the pinned issuance public key anyway.
//
// Output contract: machine-readable JSON on stdout (included in the captured result below), human
// notices on stderr. The --export file carries the FULL row fields (including signature) and the
// private key NEVER leaves this process or enters any export.
import { Database } from "bun:sqlite"
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
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
// + 20260902100000_v2_owner_authorization_renew_guard (relaxed update guard)
// (if they diverge, the runtime verifier stops matching this tool). It is idempotent: an
// already-migrated database is untouched, and a fresh --dev database is usable immediately.
//
// The update guard below is the RELAXED guard: it permits a signed RENEWAL (same
// authorization_id/campaign/identity/valid_from, active→active, expires_at extended,
// signature_digest+authorization_digest renewed) or the active→revoked transition. The INSERT
// guard (the security-critical one, format of every stored field) is byte-identical to the
// migration. A database the mint script touches gets this guard re-created, and a user database
// migrated by the core migration chain receives the SAME guard from
// 20260902100000_v2_owner_authorization_renew_guard, so `--renew` works against migrated
// user databases without the script (older binaries still refuse on the trigger — safe).
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
      OR NEW.created_at != OLD.created_at
      OR NOT (
        -- signed renewal: active→active, window strictly extended, signature re-issued
        (OLD.status = 'active' AND NEW.status = 'active'
          AND NEW.expires_at > OLD.expires_at
          AND NEW.revoked_at IS NULL AND OLD.revoked_at IS NULL
          AND NEW.signature_digest != OLD.signature_digest
          AND NEW.authorization_digest != OLD.authorization_digest)
        OR
        -- revocation: active→revoked only, everything else identical
        (OLD.status = 'active' AND NEW.status = 'revoked'
          AND NEW.expires_at = OLD.expires_at
          AND NEW.signature_digest = OLD.signature_digest
          AND NEW.authorization_digest = OLD.authorization_digest
          AND NEW.revoked_at IS NOT NULL)
      )
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
  // Robust inline/path discrimination (audit 8a, W0.8 review new-5): a REAL file wins even when its
  // PATH happens to contain the PEM BEGIN marker; only a non-existent value that carries the
  // marker is treated as an inline PEM, and anything else is a missing path (clear ENOENT error).
  const pem = existsSync(raw)
    ? readFileSync(raw, "utf8")
    : raw.includes("-----BEGIN")
      ? raw
      : (() => {
          throw new Error(
            `DEEPAGENT_CODE_OWNER_SIGNING_KEY points to a missing PEM file: ${raw} (ENOENT)`,
          )
        })()
  if (!pem.includes("-----BEGIN")) {
    throw new Error(
      "DEEPAGENT_CODE_OWNER_SIGNING_KEY is neither an Ed25519 private key PEM nor a readable path to a PEM file",
    )
  }
  // Parsing validates the key; malformed keys fail closed here instead of at write time.
  createPrivateKey(pem)
  return pem
}

function derivePublicKeyPem(privateKeyPem: string) {
  return createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString()
}

function fieldsFromRow(row: Row): V2OwnerAuthorization.AuthorizationFields {
  return {
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
}

// The exported row shape (--export): EVERY stored field the runtime verifier checks, including the
// signature, plus the human-readable build identity. Never includes the private key or the DB path.
function exportRow(row: Row, buildIdentity: string) {
  return {
    authorization_id: row.authorization_id,
    campaign_id: row.campaign_id,
    subject_commit: row.subject_commit,
    subject_tree: row.subject_tree,
    schema_digest: row.schema_digest,
    build_id: row.build_id,
    package_digest: row.package_digest,
    valid_from: row.valid_from,
    expires_at: row.expires_at,
    status: row.status,
    signature_digest: row.signature_digest,
    authorization_digest: row.authorization_digest,
    created_at: row.created_at,
    build_identity: buildIdentity,
  }
}

async function writeExport(
  path: string | undefined,
  row: Row,
  buildIdentity: string,
): Promise<string | undefined> {
  if (!path) return undefined
  mkdirSync(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(exportRow(row, buildIdentity), null, 2))
  return path
}

const buildIdentity =
  valueAfter("--build-identity") ??
  (JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()) as { version: string }).version
const campaignId = valueAfter("--campaign") ?? `v2-owner-${buildIdentity}`
const dbPath = valueAfter("--db") ?? join(os.homedir(), ".deepagent", "code", "deepagent-code-local.db")
const exportPath = valueAfter("--export")
const isDev = hasFlag("--dev")
const isRevoke = hasFlag("--revoke")
const isRenew = hasFlag("--renew")
const identity = V2ProviderTurn.buildIdentityFromVersion(buildIdentity)

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
  const row = db.query("SELECT * FROM session_v2_owner_authorization WHERE campaign_id = ?").get(campaignId) as
    | Row
    | null
  if (!row) {
    console.error(`[mint-owner-campaign] no authorization row for campaign ${campaignId} in ${dbPath}`)
    process.exit(1)
  }
  if (row.status !== "active") {
    // Audit 8b: re-revoking an already-revoked row reports the truth (already_revoked, exit 0)
    // instead of claiming a revocation happened.
    console.error(`[mint-owner-campaign] campaign ${campaignId} is already ${row.status} — nothing to revoke`)
    console.log(JSON.stringify({ action: "already_revoked", campaign_id: campaignId, status: row.status, db: dbPath }))
    process.exit(0)
  }
  if (privateKeyPem) {
    const fields = fieldsFromRow(row)
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
  if (updated.changes === 0) {
    // Audit 8c: a concurrent revoke can land between the read and the UPDATE. Re-read to report
    // the truth instead of inventing state: already revoked => no-op exit 0; row gone => error.
    const nowRow = db.query("SELECT status FROM session_v2_owner_authorization WHERE campaign_id = ?").get(campaignId) as
      | { status: string }
      | null
    db.close()
    if (nowRow && nowRow.status === "revoked") {
      console.error(`[mint-owner-campaign] campaign ${campaignId} was revoked concurrently — no-op`)
      console.log(JSON.stringify({ action: "already_revoked", campaign_id: campaignId, status: "revoked", db: dbPath }))
      process.exit(0)
    }
    console.error(
      `[mint-owner-campaign] campaign ${campaignId} could not be revoked (no active row to update) — nothing changed`,
    )
    process.exit(1)
  }
  db.close()
  console.error(`[mint-owner-campaign] revoked ${campaignId} in ${dbPath}`)
  console.log(JSON.stringify({ action: "revoked", campaign_id: campaignId, status: "revoked", db: dbPath }))
  process.exit(0)
}

// ── Mint / renew (insert, no-op, identity-mismatch, or signed renewal) ─────────────────────────
let privateKeyPem: string | undefined
let ephemeralKey = false
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
  // An ephemeral key can never be the issuer of an EXISTING row, so renewal skips the key-match
  // check in that case (mirroring --dev revoke).
  privateKeyPem = V2OwnerAuthorization.generateAuthorizationKeyPair().privateKeyPem
  ephemeralKey = true
  console.error(
    "[mint-owner-campaign] WARN --dev: no DEEPAGENT_CODE_OWNER_SIGNING_KEY — minted with an EPHEMERAL key; this row will NOT verify against the pinned production key. Point the verifier at the printed public key (DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY) for local use.",
  )
}

const signWith = (fields: Omit<V2OwnerAuthorization.AuthorizationFields, "signatureDigest">) => {
  const signatureDigest = V2OwnerAuthorization.signAuthorization(privateKeyPem!, fields)
  const authorizationDigest = createHash("sha256")
    .update(V2OwnerAuthorization.authorizationPayload(fields))
    .digest("hex")
  return { signatureDigest, authorizationDigest }
}

mkdirSync(dirname(dbPath), { recursive: true })
const db = new Database(dbPath)
db.run("PRAGMA busy_timeout = 5000")
ensureOwnerAuthorizationSchema(db)
const existing = db
  .query(
    "SELECT * FROM session_v2_owner_authorization WHERE campaign_id = ?",
  )
  .get(campaignId) as Row | null

const sameIdentityStored = (row: Row) =>
  row.subject_commit === identity.subjectCommit &&
  row.subject_tree === identity.subjectTree &&
  row.schema_digest === identity.schemaDigest &&
  row.build_id === identity.buildID &&
  row.package_digest === identity.packageDigest

if (existing) {
  if (existing.status === "revoked") {
    db.close()
    console.error(
      `[mint-owner-campaign] campaign ${campaignId} exists as ${existing.status} — rows are immutable; mint with a new --campaign (or a new --build-identity)`,
    )
    process.exit(1)
  }
  if (!sameIdentityStored(existing)) {
    // Audit/ W0.5 major-5: the idempotent no-op must not lie. Same campaign, DIFFERENT build
    // identity => the stored row does not match the requested identity (machine-readable).
    const requested = {
      subjectCommit: identity.subjectCommit,
      subjectTree: identity.subjectTree,
      schemaDigest: identity.schemaDigest,
      buildID: identity.buildID,
      packageDigest: identity.packageDigest,
    }
    const stored = {
      subjectCommit: existing.subject_commit,
      subjectTree: existing.subject_tree,
      schemaDigest: existing.schema_digest,
      buildID: existing.build_id,
      packageDigest: existing.package_digest,
    }
    db.close()
    console.error(
      `[mint-owner-campaign] campaign ${campaignId} already holds a DIFFERENT build identity — refusing to pretend it matches`,
    )
    console.log(JSON.stringify({ action: "identity_mismatch", campaign_id: campaignId, requested, stored, db: dbPath }))
    process.exit(1)
  }
  const now = Date.now()
  if (isRenew) {
    // Signed renewal (W0.5 minor-10): the issuer re-signs the SAME campaign+identity with a fresh
    // 90-day window. The key must be the issuer of the stored row (unless --dev with an ephemeral
    // key, which mirrors the --dev revoke key-skip; the renewed row then only verifies locally).
    if (!ephemeralKey) {
      const ok = Effect.runSync(
        V2OwnerAuthorization.verifyAuthorization(derivePublicKeyPem(privateKeyPem), fieldsFromRow(existing)),
      )
      if (!ok) {
        db.close()
        console.error(
          `[mint-owner-campaign] fail-closed: DEEPAGENT_CODE_OWNER_SIGNING_KEY does not match the signature on campaign ${campaignId}; refusing to renew with the wrong key`,
        )
        process.exit(1)
      }
    } else {
      console.error(
        "[mint-owner-campaign] WARN --dev: renew without a signing key — the renewed row is signed with an EPHEMERAL key and will not verify against the pinned production key",
      )
    }
    const renewed = signWith({
      authorizationID: existing.authorization_id,
      campaignID: existing.campaign_id,
      ...identity,
      validFrom: existing.valid_from,
      expiresAt: now + DEFAULT_VALIDITY_DAYS * DAY_MS,
    })
    if (now + DEFAULT_VALIDITY_DAYS * DAY_MS <= existing.expires_at) {
      db.close()
      console.error(
        `[mint-owner-campaign] campaign ${campaignId} already valid beyond the ${DEFAULT_VALIDITY_DAYS}-day renewal window — nothing to renew`,
      )
      console.log(JSON.stringify({ action: "already_present", campaign_id: campaignId, build_identity: buildIdentity, status: "active", db: dbPath }))
      process.exit(0)
    }
    let updated: { changes: number }
    try {
      updated = db
        .query(
          "UPDATE session_v2_owner_authorization SET expires_at = ?, signature_digest = ?, authorization_digest = ? WHERE campaign_id = ? AND status = 'active'",
        )
        .run(now + DEFAULT_VALIDITY_DAYS * DAY_MS, renewed.signatureDigest, renewed.authorizationDigest, campaignId)
    } catch (error) {
      // A database still carrying the strict (migration) update guard refuses the renewal here.
      db.close()
      console.error(
        `[mint-owner-campaign] fail-closed: renewal of ${campaignId} was refused by the storage guard: ${(error as Error).message}. The guard must permit signed renewals before --renew can extend a migrated database.`,
      )
      process.exit(1)
    }
    if (updated.changes === 0) {
      db.close()
      console.error(
        `[mint-owner-campaign] campaign ${campaignId} could not be renewed (no active row to update) — nothing changed`,
      )
      process.exit(1)
    }
    const renewedRow = db
      .query("SELECT * FROM session_v2_owner_authorization WHERE campaign_id = ?")
      .get(campaignId) as Row
    const exported = await writeExport(exportPath, renewedRow, buildIdentity)
    db.close()
    console.error(
      `[mint-owner-campaign] renewed ${campaignId} (${renewedRow.authorization_id}) in ${dbPath}; valid ${DEFAULT_VALIDITY_DAYS} days from now`,
    )
    console.log(
      JSON.stringify({
        action: "renewed",
        campaign_id: campaignId,
        authorization_id: renewedRow.authorization_id,
        build_identity: buildIdentity,
        status: "active",
        valid_from: renewedRow.valid_from,
        expires_at: renewedRow.expires_at,
        signature_digest: renewedRow.signature_digest,
        authorization_digest: renewedRow.authorization_digest,
        db: dbPath,
        ...(exported ? { export_path: exported } : {}),
      }),
    )
    process.exit(0)
  }
  // W0.8 review new-3: the idempotent no-op must never re-export an EXPIRED row as if it were a
  // valid authorization — that would ship a dead owner-authorization.json to every install. An
  // expired row with a matching identity is a hard signal to re-issue: fail loudly (exit 1) and
  // suggest --renew so the release pipeline can expose the staleness instead of masking it.
  if (existing.expires_at <= now) {
    db.close()
    console.error(
      `[mint-owner-campaign] campaign ${campaignId} exists but its authorization EXPIRED at ${existing.expires_at} — re-issue with --renew before exporting again`,
    )
    console.log(
      JSON.stringify({
        action: "already_present",
        campaign_id: campaignId,
        build_identity: buildIdentity,
        status: "active",
        expired: true,
        expires_at: existing.expires_at,
        suggest: "--renew",
        db: dbPath,
      }),
    )
    process.exit(1)
  }
  // Idempotent no-op: the stored row already matches the requested identity. Also re-export it so
  // a repeated release pipeline still produces the owner-authorization.json artifact.
  if (exportPath) {
    const exported = await writeExport(exportPath, existing, buildIdentity)
    console.error(
      `[mint-owner-campaign] campaign ${campaignId} already present (active) — idempotent no-op; exported existing row to ${exported}`,
    )
  } else {
    console.error(`[mint-owner-campaign] campaign ${campaignId} already present (active) — idempotent no-op`)
  }
  console.log(
    JSON.stringify({
      action: "already_present",
      campaign_id: campaignId,
      build_identity: buildIdentity,
      status: "active",
      db: dbPath,
    }),
  )
  db.close()
  process.exit(0)
}

const now = Date.now()
const signable = {
  authorizationID: `auth_v2_owner_${randomUUID().slice(0, 8)}`,
  campaignID: campaignId,
  ...identity,
  validFrom: now - 1_000,
  expiresAt: now + DEFAULT_VALIDITY_DAYS * DAY_MS,
}
const signed = signWith(signable)
const publicKeyPem = derivePublicKeyPem(privateKeyPem)

if (!isDev && publicKeyPem.trim() !== V2OwnerAuthorization.PRODUCTION_OWNER_AUTHORIZATION_PUBLIC_KEY.trim()) {
  console.error(
    "[mint-owner-campaign] WARN: the signing key's public half does NOT match the pinned production issuance key (PRODUCTION_OWNER_AUTHORIZATION_PUBLIC_KEY) — a default install will fail owner verification until the runtime pins this key in a reviewed commit",
  )
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
  signed.signatureDigest,
  signed.authorizationDigest,
  now,
)
const inserted = db.query("SELECT * FROM session_v2_owner_authorization WHERE campaign_id = ?").get(campaignId) as Row
const exported = await writeExport(exportPath, inserted, buildIdentity)
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
    signature_digest: signed.signatureDigest,
    authorization_digest: signed.authorizationDigest,
    db: dbPath,
    ...(exported ? { export_path: exported } : {}),
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
  authorization_digest: string
  status: string
  created_at: number
  revoked_at: number | null
}
