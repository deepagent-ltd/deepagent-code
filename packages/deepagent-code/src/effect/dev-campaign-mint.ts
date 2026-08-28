// 1.4.8.rN dev campaign mint (live-test seam, env-gated, NEVER active without the env var): when
// DEEPAGENT_CODE_V2_DEV_CAMPAIGN is a JSON {campaignID, privateKeyPem, identity:{subjectCommit,
// subjectTree, schemaDigest, buildID, packageDigest}}, the runtime inserts ONE signed owner
// authorization row (ephemeral issuance pair, onConflictDoNothing) — the SAME signing path the
// verifier checks. Production r0 mints campaigns through the operator flow; this seam exists so the
// packaged live test can boot the V2-only profile with a verifiable campaign against a real provider.
import { Context, Effect, Layer } from "effect"
import { Hash } from "@deepagent-code/core/util/hash"
import { Database } from "@deepagent-code/core/database/database"
import { V2OwnerAuthorization } from "@deepagent-code/core/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "@deepagent-code/core/session/runner/v2-owner-authorization.sql"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"

export const DevCampaignMint = Context.Service<{ readonly minted: boolean }, { readonly minted: boolean }>()(
  "@deepagent-code/DevCampaignMint",
)

export const devCampaignMint = Layer.effect(
  DevCampaignMint,
  Effect.gen(function* () {
    const raw = process.env.DEEPAGENT_CODE_V2_DEV_CAMPAIGN?.trim()
    if (!raw) return { minted: false }
    const input = JSON.parse(raw) as {
      readonly campaignID: string
      readonly privateKeyPem: string
      readonly identity: V2ProviderTurn.BuildIdentity
    }
    const { db } = yield* Database.Service
    const signable = {
      authorizationID: `auth_dev_${input.campaignID}`,
      campaignID: input.campaignID,
      ...input.identity,
      validFrom: Date.now() - 1_000,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
    }
    // Best-effort seam: any mint failure must never break the composition (the layer type must
    // stay ConfigError-compatible for the route graph) — log and report unminted.
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
        signature_digest: V2OwnerAuthorization.signAuthorization(input.privateKeyPem, signable),
        authorization_digest: Hash.sha256(V2OwnerAuthorization.authorizationPayload(signable)),
        created_at: Date.now(),
      })
      .onConflictDoNothing()
      .run()
    return { minted: true }
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error("[dev-campaign-mint] insert failed", error)
        return { minted: false }
      }),
    ),
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        console.error("[dev-campaign-mint] mint defect", defect)
        return { minted: false }
      }),
    ),
  ),
).pipe(Layer.provide(Database.defaultLayer))