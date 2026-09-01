export * as V2OwnerSeed from "./v2-owner-seed"

// W0.5 (blocker-2 / major-3): the production-path delivery of a signed V2 owner authorization. The
// release pipeline mints one `owner-authorization.json` (script/mint-owner-campaign.ts --export)
// and ships it with the install product; at first bootstrap the runtime seeds that row into the
// local session_v2_owner_authorization table so a DEFAULT install passes ownerQualified.
//
// Security posture:
//   - fail-open   on "no file"        (local dev has no file -> no-op, mint --dev covers it);
//   - fail-closed on "file exists"    (any validation/verification failure is refused and logged;
//                                     a row that cannot be verified is never written);
//   - existing-row semantics (W0.8 review major-1): an existing row is never REPLACED, but a LEGAL
//     renewal of the same authorization is APPLIED. "Same identity" = campaign_id AND the 5
//     identity fields (subject_commit/subject_tree/schema_digest/build_id/package_digest) equal:
//       - same identity, stored row ACTIVE, and the file re-issues the SAME authorization — same
//         authorization_id and valid_from (exactly the script/mint-owner-campaign.ts --renew
//         shape), signature re-issued — with a strictly later expiry → signed RENEWAL in place:
//         expires_at + signature_digest + authorization_digest updated, status stays active,
//         revoked_at stays NULL, everything else unchanged (the relaxed update guard
//         20260902100000 permits this active→active extension, so the 90-day window self-heals
//         when a release ships a renewed file; the rebuilt row still verifies because the
//         re-issue keeps the signed authorization_id/valid_from);
//       - same identity, stored row still valid AND the file does not extend the window →
//         already_present no-op (idempotent re-delivery);
//       - same identity but the file is not such a re-issue, extends nothing, shrinks the window,
//         or the stored row is expired → exists_conflict with both windows reported;
//       - stored row revoked → exists_conflict (a revoked authorization is never revived);
//       - different identity (same campaign) → exists_conflict (never overwrite another build's
//         authorization).
//
// Release delivery note (W0.8 review minor-2): the release flow carries `owner-authorization.json`
// as a RELEASE ASSET; fetching that asset on the install side (repo-root install script / desktop
// packaging resources) is a release deliverable (see v2.0-design W0.5 note and the RELEASE-GO
// checklist), not runtime code — this module only seeds the file a release places at appRoot.
//
// Verification mirrors V2ProviderTurn.ownerQualified exactly: pin the production issuance public
// key (or the explicit test/dev override), verify the Ed25519 signature over the canonical
// payload, check the tamper digest, check the validity window, and compare the 5 identity fields
// recomputed from the installation version.

import { and, eq } from "drizzle-orm"
import { Context, Effect, Exit, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "../../database/database"
import { InstallationVersion } from "../../installation/version"
import { Hash } from "../../util/hash"
import { V2OwnerAuthorization } from "./v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "./v2-owner-authorization.sql"
import { buildIdentityFromVersion } from "./v2-provider-turn"

export type OwnerSeedOutcome =
  | { readonly seeded: true; readonly campaignID: string; readonly renewed: boolean }
  | {
      readonly seeded: false
      readonly reason:
        | "not_found"
        | "unreadable"
        | "invalid_shape"
        | "verify_failed"
        | "identity_mismatch"
        | "invalid_window"
        | "exists_conflict"
        | "already_present"
      readonly campaignID?: string
      readonly detail?: string
    }

export type OwnerSeedOptions = {
  /** File location resolution: DEEPAGENT_CODE_OWNER_AUTHORIZATION first, then <appRoot>/owner-authorization.json. */
  readonly env?: NodeJS.ProcessEnv
  /** The install root that hosts the shipped owner-authorization.json (desktop app resources / CLI install dir). */
  readonly appRoot: string
  /** Verifier key override for dev/test flows (ephemeral issuance pairs); production never sets it. */
  readonly publicKeyPem?: string
}

/**
 * Seed ONE signed owner authorization row from the shipped JSON. Returns a structured outcome
 * instead of failing: the caller logs and continues (a seed failure must never block startup).
 */
export function seedOwnerAuthorization(
  db: Database.Interface["db"],
  options: OwnerSeedOptions,
): Effect.Effect<OwnerSeedOutcome> {
  return Effect.gen(function* () {
    const env = options.env ?? process.env
    const explicit = env.DEEPAGENT_CODE_OWNER_AUTHORIZATION?.trim()
    const filePath = explicit ? explicit : join(options.appRoot, "owner-authorization.json")
    if (!existsSync(filePath)) {
      return { seeded: false, reason: "not_found" } as const
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"))
    } catch (error) {
      return { seeded: false, reason: "unreadable", detail: (error as Error).message } as const
    }
    const row = parseSeedRow(parsed)
    if (!row) {
      return {
        seeded: false,
        reason: "invalid_shape",
        detail: "owner-authorization.json is not a valid authorization row (check the exported field set)",
      } as const
    }
    const payload = V2OwnerAuthorization.authorizationPayload(row.fields)
    if (row.authorizationDigest !== Hash.sha256(payload)) {
      return {
        seeded: false,
        reason: "verify_failed",
        campaignID: row.fields.campaignID,
        detail: "authorization_digest does not match the signed payload",
      } as const
    }
    // The shipped runtime verifies against the pinned production key; the explicit override exists
    // so a dev-minted JSON (ephemeral issuance pair) can be seeded locally.
    const publicKeyPem =
      options.publicKeyPem ?? env.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY?.trim() ?? V2OwnerAuthorization.PRODUCTION_OWNER_AUTHORIZATION_PUBLIC_KEY
    if (!(yield* V2OwnerAuthorization.verifyAuthorization(publicKeyPem, row.fields))) {
      return {
        seeded: false,
        reason: "verify_failed",
        campaignID: row.fields.campaignID,
        detail: "Ed25519 signature does not verify against the issued public key",
      } as const
    }
    const now = Date.now()
    if (row.fields.validFrom > now || row.fields.expiresAt <= now) {
      return {
        seeded: false,
        reason: "invalid_window",
        campaignID: row.fields.campaignID,
        detail: "validity window is expired or not yet valid",
      } as const
    }
    const identity = buildIdentityFromVersion(InstallationVersion)
    if (
      row.fields.subjectCommit !== identity.subjectCommit ||
      row.fields.subjectTree !== identity.subjectTree ||
      row.fields.schemaDigest !== identity.schemaDigest ||
      row.fields.buildID !== identity.buildID ||
      row.fields.packageDigest !== identity.packageDigest
    ) {
      return {
        seeded: false,
        reason: "identity_mismatch",
        campaignID: row.fields.campaignID,
        detail: `authorization identity does not match the installation version ${InstallationVersion}`,
      } as const
    }
    const existing = yield* db
      .select()
      .from(V2OwnerAuthorizationTable)
      .where(eq(V2OwnerAuthorizationTable.campaign_id, row.fields.campaignID))
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      // W0.8 (review major-1): the previous blanket "never overwrite, even expired" left a release
      // whose authorization window lapsed 90 days out with NO self-healing — the shipped renewal
      // file was ignored. A LEGAL renewal is now applied in place (the ONLY in-place mutation; the
      // table stays append-only and no other existing row is ever replaced), and it matches the
      // relaxed update guard (20260902100000) shape: same authorization_id/valid_from/identity,
      // active→active, strictly extended window, signature + digest re-issued.
      const sameIdentity =
        existing.subject_commit === row.fields.subjectCommit &&
        existing.subject_tree === row.fields.subjectTree &&
        existing.schema_digest === row.fields.schemaDigest &&
        existing.build_id === row.fields.buildID &&
        existing.package_digest === row.fields.packageDigest
      if (existing.status === "active") {
        // Signed renewal: the file must re-issue the SAME authorization (same authorization_id and
        // valid_from — exactly what script/mint-owner-campaign.ts --renew produces) with a
        // strictly later expiry. Coherence is required, not just identity: the stored
        // signature_digest/authorization_digest are replaced by the file's values while
        // authorization_id/valid_from stay byte-identical (guard-forced), so any other file would
        // leave a row that no longer verifies — the seed's fail-closed posture never writes that.
        if (
          sameIdentity &&
          row.fields.authorizationID === existing.authorization_id &&
          row.fields.validFrom === existing.valid_from &&
          row.fields.expiresAt > existing.expires_at
        ) {
          const updated = yield* db
            .update(V2OwnerAuthorizationTable)
            .set({
              expires_at: row.fields.expiresAt,
              signature_digest: row.fields.signatureDigest,
              authorization_digest: row.authorizationDigest,
            })
            .where(
              and(
                eq(V2OwnerAuthorizationTable.campaign_id, row.fields.campaignID),
                eq(V2OwnerAuthorizationTable.status, "active"),
              ),
            )
            .returning({ authorization_id: V2OwnerAuthorizationTable.authorization_id })
            .get()
            .pipe(Effect.exit)
          if (Exit.isFailure(updated)) {
            // Fail-open on outcome: a storage-guard refusal (e.g. a database still carrying a
            // stricter guard) reports the conflict instead of failing startup.
            return {
              seeded: false,
              reason: "exists_conflict",
              campaignID: row.fields.campaignID,
              detail: `renewal was refused by the storage guard: ${String(updated.cause)}`,
            } as const
          }
          if (!updated.value) {
            return {
              seeded: false,
              reason: "exists_conflict",
              campaignID: row.fields.campaignID,
              detail: "renewal did not apply (row is no longer active)",
            } as const
          }
          return { seeded: true, campaignID: row.fields.campaignID, renewed: true } as const
        }
        // Idempotent re-delivery: the stored row is still valid and the file does not extend it
        // (same window) — the row stays authoritative, nothing is written.
        if (
          sameIdentity &&
          existing.expires_at > now &&
          row.fields.expiresAt >= existing.expires_at
        ) {
          return { seeded: false, reason: "already_present", campaignID: row.fields.campaignID } as const
        }
      }
      return {
        seeded: false,
        reason: "exists_conflict",
        campaignID: row.fields.campaignID,
        detail:
          existing.status === "revoked"
            ? `existing row status=revoked (revoked_at=${existing.revoked_at}) — a revoked authorization cannot be revived; rotate with a new --campaign or re-issue --renew BEFORE expiry`
            : `existing row status=${existing.status} expires_at=${existing.expires_at} vs file expires_at=${row.fields.expiresAt} — not overwritten${
                sameIdentity && existing.status === "active"
                  ? " (the file is not a legal renewal: same authorization_id+valid_from and a strictly later expiry are required)"
                  : ""
              }`,
      } as const
    }
    yield* db
      .insert(V2OwnerAuthorizationTable)
      .values({
        authorization_id: row.fields.authorizationID,
        campaign_id: row.fields.campaignID,
        subject_commit: row.fields.subjectCommit,
        subject_tree: row.fields.subjectTree,
        schema_digest: row.fields.schemaDigest,
        build_id: row.fields.buildID,
        package_digest: row.fields.packageDigest,
        valid_from: row.fields.validFrom,
        expires_at: row.fields.expiresAt,
        status: "active",
        signature_digest: row.fields.signatureDigest,
        authorization_digest: row.authorizationDigest,
        created_at: row.createdAt,
      })
      .run()
      .pipe(Effect.orDie)
    return { seeded: true, campaignID: row.fields.campaignID, renewed: false } as const
  })
}

// Bootstrap wiring: a Layer that runs the seed ONCE when the runtime graph is built — i.e. after
// the database layer initialized and before the HTTP server accepts requests (Server.listen). The
// layer is fail-open on outcome (a seed failure never blocks startup: the operator must fix the
// deliverable) but fail-closed on writing (any verification failure means NOTHING is written).
export class Service extends Context.Service<
  { readonly outcome: OwnerSeedOutcome | undefined },
  { readonly outcome: OwnerSeedOutcome | undefined }
>()("@deepagent-code/v2/session/V2OwnerSeed") {}

export const layer = (options: OwnerSeedOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const outcome = yield* seedOwnerAuthorization(db, options)
      reportOutcome(outcome)
      return { outcome }
    }),
  ).pipe(Layer.provide(Database.defaultLayer))

function reportOutcome(outcome: OwnerSeedOutcome) {
  if (outcome.seeded) {
    console.error(`[owner-authorization-seed] ${outcome.renewed ? "renewed" : "seeded"} ${outcome.campaignID}`)
    return
  }
  if (outcome.reason === "not_found") return
  if (outcome.reason === "already_present") return
  console.error(
    `[owner-authorization-seed] REFUSED to seed ${outcome.reason}${outcome.campaignID ? ` campaign=${outcome.campaignID}` : ""}${outcome.detail ? `: ${outcome.detail}` : ""}`,
  )
}

/**
 * The app root that hosts the shipped owner-authorization.json, derived from where THIS module
 * runs: the desktop sidecar bundle lives at `<app>/out/main/chunks/node.js` in dev and at
 * `<resources>/app.asar.unpacked/out/main/chunks/node.js` once packaged (the app root is the
 * directory that owns the bundle tree); the CLI (compiled binary, module URL not a real path)
 * uses the executable's install directory. Callers may override by passing appRoot explicitly.
 */
export function defaultOwnerAuthorizationAppRoot(): string {
  const modulePath = import.meta.url.startsWith("file:") ? fileURLToPath(import.meta.url) : undefined
  if (modulePath && /[\\/]out[\\/]main[\\/]chunks[\\/]/.test(modulePath)) {
    let dir = dirname(modulePath)
    for (const segment of ["chunks", "main", "out"]) {
      if (basename(dir) === segment) dir = dirname(dir)
    }
    if (basename(dir) === "app.asar.unpacked") dir = dirname(dir)
    return dir
  }
  return dirname(process.execPath)
}

type SeedRow = {
  readonly fields: V2OwnerAuthorization.AuthorizationFields
  readonly authorizationDigest: string
  readonly createdAt: number
}

const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function parseSeedRow(value: unknown): SeedRow | undefined {
  if (!value || typeof value !== "object") return
  const row = value as Record<string, unknown>
  const str = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : undefined)
  const num = (key: string) => (typeof row[key] === "number" ? (row[key] as number) : undefined)
  const authorizationID = str("authorization_id")
  const campaignID = str("campaign_id")
  const subjectCommit = str("subject_commit")
  const subjectTree = str("subject_tree")
  const schemaDigest = str("schema_digest")
  const buildID = str("build_id")
  const packageDigest = str("package_digest")
  const signatureDigest = str("signature_digest")
  const authorizationDigest = str("authorization_digest")
  const validFrom = num("valid_from")
  const expiresAt = num("expires_at")
  const createdAt = num("created_at")
  if (
    !authorizationID ||
    !campaignID ||
    !subjectCommit ||
    !subjectTree ||
    !schemaDigest ||
    !buildID ||
    !packageDigest ||
    !signatureDigest ||
    !authorizationDigest ||
    validFrom === undefined ||
    expiresAt === undefined ||
    createdAt === undefined
  )
    return
  if (
    !CAMPAIGN_ID.test(campaignID) ||
    !HEX40.test(subjectCommit) ||
    !HEX40.test(subjectTree) ||
    !HEX64.test(schemaDigest) ||
    !HEX64.test(buildID) ||
    !HEX64.test(packageDigest) ||
    !HEX128.test(signatureDigest) ||
    !HEX64.test(authorizationDigest)
  )
    return
  return {
    fields: {
      authorizationID,
      campaignID,
      subjectCommit,
      subjectTree,
      schemaDigest,
      buildID,
      packageDigest,
      validFrom,
      expiresAt,
      signatureDigest,
    },
    authorizationDigest,
    createdAt,
  }
}
