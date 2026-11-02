import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
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
const cuts = ["20260813041200_v2_provider_shadow_authority", "20260813120346_v2_provider_parity_campaign"] as const
const roots = new Map<string, Awaited<ReturnType<typeof tmpdir>>>()
const run = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>, signal?: AbortSignal) =>
  Effect.runPromise(
    Effect.gen(function* () {
      // Migrations run on the same FK-on client contract as production bootstrap.
      yield* (yield* SqliteClient.SqliteClient).unsafe("PRAGMA foreign_keys = ON")
      return yield* effect
    }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
    { signal },
  )

describe("V2 provider owner containment", () => {
  // Empty-schema construction is fixture setup. Legacy rows and both real forward upgrades
  // remain inside the upgrade oracle; dispatch and recovery still reopen the current schema.
  beforeAll(async () => {
    const started = performance.now()
    const signal = AbortSignal.timeout(110_000)
    for (const cut of [...cuts, "takeover"]) {
      const root = await tmpdir()
      roots.set(cut, root)
      const cutIndex = cut === "takeover" ? migrations.length : migrations.findIndex((migration) => migration.id === cut)
      if (cutIndex <= 0) throw new Error(`Missing provider cutover migration: ${cut}`)
      await run(
        `${root.path}/${cut}.sqlite`,
        Effect.gen(function* () {
          yield* DatabaseMigration.applyOnly(yield* makeDb, migrations.slice(0, cutIndex))
        }),
        signal,
      )
      console.info(JSON.stringify({ test: "provider-cutover-schema", phase: "closed", cut,
        elapsedMs: Math.round(performance.now() - started) }))
    }
  }, 120_000)

  afterAll(async () => {
    await Promise.all([...roots.values()].map((root) => root[Symbol.asyncDispose]()))
  })

  test("upgrades pre-V2 and pre-campaign disk databases without losing durable sessions", async () => {
    const started = performance.now()
    // One deadline covers both cuts and interrupts the Effect before Bun advances to another case.
    const signal = AbortSignal.timeout(29_000)
    const trace = (phase: string, cut?: number) => console.info(JSON.stringify({
      test: "provider-cutover-upgrade", phase, elapsedMs: Math.round(performance.now() - started), cut,
    }))
    trace("case-enter")
    const qualifications: boolean[] = []

    for (const cut of cuts) {
      trace("cut-start", cuts.indexOf(cut))
      const tmp = roots.get(cut)
      if (!tmp) throw new Error(`Provider cutover schema was not prepared: ${cut}`)
      const filename = `${tmp.path}/${cut}.sqlite`
      await run(
        filename,
        Effect.gen(function* () {
          const db = yield* makeDb
          trace("database-ready", cuts.indexOf(cut))
          const cutIndex = migrations.findIndex((migration) => migration.id === cut)
          expect(cutIndex).toBeGreaterThan(0)
          trace("legacy-schema-opened", cuts.indexOf(cut))

          const projectID = ProjectV2.ID.make(`project-${cut}`)
          const sessionID = SessionSchema.ID.make(`ses_${cut}`)
          yield* db
            .insert(ProjectTable)
            .values({ id: projectID, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
            .run()
          // Raw SQL on purpose: the fixture writes a LEGACY-shaped session row into a database
          // pinned at the pre-V2 migration cut. The current drizzle schema carries columns the
          // cut schema lacks (e.g. interrupt_seq), so an ORM insert fails there — exactly the
          // on-disk shape this upgrade test exists to cover.
          yield* db
            .run(
              sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                  VALUES (${sessionID}, ${projectID}, ${cut}, ${tmp.path}, ${'V2 cutover upgrade'}, ${'pre-v2'}, 0, 0)`,
            )

          yield* DatabaseMigration.applyOnly(db, migrations)
          trace("upgrade-complete", cuts.indexOf(cut))
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
          trace("exact-reapply-complete", cuts.indexOf(cut))
          expect(
            yield* db.get<{ count: number }>(
              sql`SELECT count(*) AS count FROM migration WHERE id = ${migrations.at(-1)!.id}`,
            ),
          ).toEqual({ count: 1 })
        }),
        signal,
      )
      trace("database-scope-closed", cuts.indexOf(cut))
    }
    trace("case-body-complete")
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
    const started = performance.now()
    const signal = AbortSignal.timeout(14_000)
    const trace = (phase: string) => console.info(JSON.stringify({
      test: "provider-cutover-expired-owner", phase, elapsedMs: Math.round(performance.now() - started),
    }))
    trace("case-enter")
    const tmp = roots.get("takeover")
    if (!tmp) throw new Error("Provider takeover schema was not prepared")
    trace("directory-ready")
    const filename = `${tmp.path}/takeover.sqlite`
    const marker = `${tmp.path}/physical-dispatch.json`
    const fixture = new URL("./fixture/v2-provider-owner-process.ts", import.meta.url)
    const processOutput = async (mode: "dispatch" | "recover", receiptID?: string) => {
      const child = Bun.spawn([process.execPath, fileURLToPath(fixture), mode, filename, marker, ...(receiptID ? [receiptID] : [])], {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
        signal,
        killSignal: "SIGKILL",
      })
      trace(`${mode}-started`)
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        signal.throwIfAborted()
        expect(status, stderr).toBe(0)
        trace(`${mode}-exited`)
        return stdout
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
    }
    const dispatched = JSON.parse(await processOutput("dispatch")) as { receiptId: string }

    await Bun.sleep(650)
    trace("expiry-wait-complete")
    expect(JSON.parse(await processOutput("recover", dispatched.receiptId))).toEqual({
      state: "indeterminate_after_crash",
      errorCode: "owner_lost_after_dispatch",
      recovered: 0,
      activeV2: 0,
      oldOwnerHeartbeat: "provider_owner_lease_not_live",
      physicalDispatches: 1,
    })
    trace("case-body-complete")
  }, 15_000)
})
