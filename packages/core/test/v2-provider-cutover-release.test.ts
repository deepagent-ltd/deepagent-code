import { describe, expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { ProjectV2 } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { V2OwnerAuthorization } from "../src/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "../src/session/runner/v2-owner-authorization.sql"
import { V2ProviderTurnReceiptTable } from "../src/session/runner/v2-provider-turn.sql"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const issuanceKey = V2OwnerAuthorization.generateAuthorizationKeyPair()
const run = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

describe("V2 provider owner containment", () => {
  test("upgrades pre-V2 and pre-campaign disk databases without losing durable sessions", async () => {
    await using tmp = await tmpdir()
    const cuts = ["20260813041200_v2_provider_shadow_authority", "20260813120346_v2_provider_parity_campaign"] as const
    const qualifications: boolean[] = []

    for (const cut of cuts) {
      const filename = `${tmp.path}/${cut}.sqlite`
      await run(
        filename,
        Effect.gen(function* () {
          const db = yield* makeDb
          const cutIndex = migrations.findIndex((migration) => migration.id === cut)
          expect(cutIndex).toBeGreaterThan(0)
          yield* DatabaseMigration.applyOnly(db, migrations.slice(0, cutIndex))

          const projectID = ProjectV2.ID.make(`project-${cut}`)
          const sessionID = SessionSchema.ID.make(`ses_${cut}`)
          yield* db
            .insert(ProjectTable)
            .values({ id: projectID, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
            .run()
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: projectID,
              slug: cut,
              directory: AbsolutePath.make(tmp.path),
              title: "V2 cutover upgrade",
              version: "pre-v2",
            })
            .run()

          yield* DatabaseMigration.applyOnly(db, migrations)
          expect(
            yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
          ).toEqual({ id: sessionID })
          expect(
            yield* db.get<{ count: number }>(
              sql`SELECT count(*) AS count FROM session_v2_provider_turn_receipt WHERE session_id = ${sessionID}`,
            ),
          ).toEqual({ count: 0 })
          qualifications.push(yield* V2ProviderTurn.ownerQualified(db))
          qualifications.push(yield* V2ProviderTurn.ownerQualified(db, "historical-parity-campaign"))
          expect(qualifications.slice(-2)).toEqual([false, false])

          yield* DatabaseMigration.applyOnly(db, migrations)
          expect(
            yield* db.get<{ count: number }>(
              sql`SELECT count(*) AS count FROM migration WHERE id = ${migrations.at(-1)!.id}`,
            ),
          ).toEqual({ count: 1 })
        }),
      )
    }
  })

  test("requires an exact, active, build-bound owner authorization", async () => {
    await using tmp = await tmpdir()
    await run(
      `${tmp.path}/owner-authorization.sqlite`,
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.applyOnly(db, migrations)
        const now = Date.now()
        const identity = {
          subjectCommit: "a".repeat(40),
          subjectTree: "b".repeat(40),
          schemaDigest: "c".repeat(64),
          buildID: "d".repeat(64),
          packageDigest: "e".repeat(64),
        }
        const unsigned = {
          authorizationID: "auth_internal_v2",
          campaignID: "internal-v2-owner",
          subjectCommit: identity.subjectCommit,
          subjectTree: identity.subjectTree,
          schemaDigest: identity.schemaDigest,
          buildID: identity.buildID,
          packageDigest: identity.packageDigest,
          validFrom: now - 1_000,
          expiresAt: now + 60_000,
          signatureDigest: "0".repeat(128),
        }
        // The authorization proof is a real Ed25519 signature from an ephemeral issuance pair;
        // the matching public key is provided to the verifier below.
        const { signatureDigest: _placeholder, ...signable } = unsigned
        const fields = {
          ...unsigned,
          signatureDigest: V2OwnerAuthorization.signAuthorization(issuanceKey.privateKeyPem, signable),
        }
        yield* db
          .insert(V2OwnerAuthorizationTable)
          .values({
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
            signature_digest: fields.signatureDigest,
            authorization_digest: Hash.sha256(V2OwnerAuthorization.authorizationPayload(signable)),
            created_at: now,
          })
          .run()
        expect(yield* V2ProviderTurn.ownerQualified(db, fields.campaignID)).toBe(false)
        const authorized = yield* V2ProviderTurn.ownerQualified(db, fields.campaignID).pipe(
          Effect.provideService(V2ProviderTurn.CurrentBuildIdentity, identity),
          Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, issuanceKey.publicKeyPem),
        )
        expect(authorized).toBe(true)
        expect(
          yield* V2ProviderTurn.ownerQualified(db, fields.campaignID).pipe(
            Effect.provideService(V2ProviderTurn.CurrentBuildIdentity, { ...identity, subjectTree: "0".repeat(40) }),
            Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, issuanceKey.publicKeyPem),
          ),
        ).toBe(false)
        yield* db
          .insert(V2OwnerAuthorizationTable)
          .values({
            authorization_id: "auth_bad_digest",
            campaign_id: "internal-v2-bad-digest",
            subject_commit: fields.subjectCommit,
            subject_tree: fields.subjectTree,
            schema_digest: fields.schemaDigest,
            build_id: fields.buildID,
            package_digest: fields.packageDigest,
            valid_from: fields.validFrom,
            expires_at: fields.expiresAt,
            status: "active",
            signature_digest: fields.signatureDigest,
            authorization_digest: "0".repeat(64),
            created_at: now,
          })
          .run()
        expect(
          yield* V2ProviderTurn.ownerQualified(db, "internal-v2-bad-digest").pipe(
            Effect.provideService(V2ProviderTurn.CurrentBuildIdentity, identity),
            Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, issuanceKey.publicKeyPem),
          ),
        ).toBe(false)
        yield* db
          .update(V2OwnerAuthorizationTable)
          .set({ status: "revoked", revoked_at: now })
          .where(eq(V2OwnerAuthorizationTable.campaign_id, fields.campaignID))
          .run()
        expect(
          yield* V2ProviderTurn.ownerQualified(db, fields.campaignID).pipe(
            Effect.provideService(V2ProviderTurn.CurrentBuildIdentity, identity),
            Effect.provideService(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, issuanceKey.publicKeyPem),
          ),
        ).toBe(false)
      }),
    )
  })

  test("takes over an expired process owner without replay and leaves a rollback-safe database", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/takeover.sqlite`
    const marker = `${tmp.path}/physical-dispatch.json`
    const fixture = new URL("./fixture/v2-provider-owner-process.ts", import.meta.url)
    const first = Bun.spawn([process.execPath, fixture.pathname, "dispatch", filename, marker], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const firstOutput = await new Response(first.stdout).text()
    const firstError = await new Response(first.stderr).text()
    expect(await first.exited, firstError).toBe(0)
    const dispatched = JSON.parse(firstOutput) as { receiptId: string }

    await Bun.sleep(650)
    const second = Bun.spawn([process.execPath, fixture.pathname, "recover", filename, marker, dispatched.receiptId], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const secondOutput = await new Response(second.stdout).text()
    const secondError = await new Response(second.stderr).text()
    expect(await second.exited, secondError).toBe(0)
    expect(JSON.parse(secondOutput)).toEqual({
      state: "indeterminate_after_crash",
      errorCode: "owner_lost_after_dispatch",
      recovered: 0,
      activeV2: 0,
      oldOwnerHeartbeat: "provider_owner_lease_not_live",
      physicalDispatches: 1,
    })
  }, 15_000)
})
