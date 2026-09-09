// run 模式适配（2026-09-03）：dev 构建自举 owner 授权的行为合同 — 仅 dev 戳/显式 env 触发、
// 幂等（同 campaign 二次调用不重复种行）、显式 campaign 优先跳过、env 指向本机持久化的
// 公钥、种出的行能被 V2OwnerAuthorization 验签。
import "./fixture/install-version"
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { FSUtil } from "../src/fs-util"
import { Global } from "../src/global"
import { V2OwnerAuthorization } from "../src/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "../src/session/runner/v2-owner-authorization.sql"
import { V2OwnerDevMint } from "../src/session/runner/v2-owner-dev-mint"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { EffectFlock } from "../src/util/effect-flock"
import { tmpdir } from "node:os"

const freshEnv = () => {
  delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
  delete process.env.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY
}
const flockLayer = (state: string) =>
  EffectFlock.layer.pipe(Layer.provide(Global.layerWith({ state })), Layer.provide(FSUtil.defaultLayer))

describe("V2OwnerDevMint.ensureDevOwnerAuthorization", () => {
  test("forced dev mint seeds one verifiable row and is idempotent", async () => {
    freshEnv()
    process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT = "1"
    const stateDir = mkdtempSync(join(tmpdir(), "dev-mint-"))
    const { first, rows } = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Database.Service
        const first = yield* V2OwnerDevMint.ensureDevOwnerAuthorization(service.db, stateDir)
        const rows = yield* service.db
          .select()
          .from(V2OwnerAuthorizationTable)
          .where(sql`${V2OwnerAuthorizationTable.campaign_id} = ${(first as { campaignID: string }).campaignID}`)
          .get()
          .pipe(Effect.orDie)
        return { first, rows }
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.provide(flockLayer(stateDir))),
    )
    expect(first.minted).toBe(true)
    expect((first as { campaignID: string }).campaignID).toMatch(/^v2-owner-dev-[0-9a-f]{12}$/)
    const pair = JSON.parse(readFileSync(join(stateDir, "v2-owner-dev", "keypair.json"), "utf8")) as {
      readonly publicKeyPem: string
    }
    expect(pair.publicKeyPem).toContain("BEGIN PUBLIC KEY")
    expect(rows).toBeDefined()

    // the seeded row verifies against the env-publicized key
    const verified = await Effect.runPromise(
      V2OwnerAuthorization.verifyAuthorization(pair.publicKeyPem, {
        authorizationID: rows!.authorization_id,
        campaignID: rows!.campaign_id,
        subjectCommit: rows!.subject_commit,
        subjectTree: rows!.subject_tree,
        schemaDigest: rows!.schema_digest,
        buildID: rows!.build_id,
        packageDigest: rows!.package_digest,
        validFrom: rows!.valid_from,
        expiresAt: rows!.expires_at,
        signatureDigest: rows!.signature_digest,
      }),
    )
    expect(verified).toBeTrue()

    // second call on a FRESH connection to a FILE db (same store): already_present fast path —
    // still reports minted (env re-armed), no duplicate row
    const dbFile = join(stateDir, "dev-mint.sqlite")
    const runOnFile = Effect.gen(function* () {
      const service = yield* Database.Service
      const second = yield* V2OwnerDevMint.ensureDevOwnerAuthorization(service.db, stateDir)
      const count = yield* service.db
        .select({ authorization_id: V2OwnerAuthorizationTable.authorization_id })
        .from(V2OwnerAuthorizationTable)
        .where(sql`${V2OwnerAuthorizationTable.campaign_id} = ${(first as { campaignID: string }).campaignID}`)
        .pipe(
          Effect.map((all) => all.length),
          Effect.orDie,
        )
      return { second, count }
    })
    // seed the file db once (first mint), then reopen and re-run (idempotency)
    await Effect.runPromise(
      runOnFile.pipe(Effect.provide(Database.layerFromPath(dbFile)), Effect.provide(flockLayer(stateDir))),
    )
    const { second, count } = await Effect.runPromise(
      runOnFile.pipe(Effect.provide(Database.layerFromPath(dbFile)), Effect.provide(flockLayer(stateDir))),
    )
    expect(second.minted).toBeTrue()
    expect(count).toBe(1)
    delete process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT
  })

  test("an explicit operator campaign wins — the mint skips", async () => {
    freshEnv()
    process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT = "1"
    process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN = "v2-owner-shadow-staging"
    const stateDir = mkdtempSync(join(tmpdir(), "dev-mint-skip-"))
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Database.Service
        return yield* V2OwnerDevMint.ensureDevOwnerAuthorization(service.db, stateDir)
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.provide(flockLayer(stateDir))),
    )
    expect(outcome).toEqual({ minted: false, reason: "explicit_campaign" })
    delete process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT
    delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
  })

  test("owner reference discovery is isolated by the injected Global root", async () => {
    freshEnv()
    process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT = "1"
    const rootA = mkdtempSync(join(tmpdir(), "dev-owner-root-a-"))
    const rootB = mkdtempSync(join(tmpdir(), "dev-owner-root-b-"))
    const pairA = V2OwnerAuthorization.generateAuthorizationKeyPair()
    const pairB = V2OwnerAuthorization.generateAuthorizationKeyPair()
    mkdirSync(join(rootA, "v2-owner-dev"))
    mkdirSync(join(rootB, "v2-owner-dev"))
    writeFileSync(join(rootA, "v2-owner-dev", "keypair.json"), JSON.stringify(pairA))
    writeFileSync(join(rootB, "v2-owner-dev", "keypair.json"), JSON.stringify(pairB))

    const resolve = (state: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* V2ProviderTurn.CurrentOwnerAuthorizationPublicKey
        }).pipe(Effect.provide(V2ProviderTurn.ownerReferencesLayer), Effect.provide(Global.layerWith({ state }))),
      )
    const [resolvedA, resolvedB] = await Promise.all([resolve(rootA), resolve(rootB)])
    expect(resolvedA).toBe(pairA.publicKeyPem)
    expect(resolvedB).toBe(pairB.publicKeyPem)
    expect(resolvedA).not.toBe(resolvedB)
    delete process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT
  })

  test("two independent processes converge on one matching keypair and authorization row", async () => {
    freshEnv()
    const stateDir = mkdtempSync(join(tmpdir(), "dev-owner-processes-"))
    const database = join(stateDir, "owner.sqlite")
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Database.Service
      }).pipe(Effect.provide(Database.layerFromPath(database))),
    )
    const worker = join(import.meta.dir, "fixture", "v2-owner-dev-mint-worker.ts")
    const run = () =>
      new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [worker, JSON.stringify({ database, state: stateDir })], {
          cwd: join(import.meta.dir, ".."),
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on("data", (data) => stdout.push(Buffer.from(data)))
        child.stderr.on("data", (data) => stderr.push(Buffer.from(data)))
        child.on("close", (code) =>
          resolve({
            code: code ?? 1,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          }),
        )
      })
    const results = await Promise.all([run(), run()])
    expect(results.map((result) => ({ code: result.code, stderr: result.stderr }))).toEqual([
      { code: 0, stderr: "" },
      { code: 0, stderr: "" },
    ])
    expect(results.map((result) => JSON.parse(result.stdout).minted)).toEqual([true, true])

    const pair = JSON.parse(readFileSync(join(stateDir, "v2-owner-dev", "keypair.json"), "utf8")) as {
      readonly publicKeyPem: string
    }
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Database.Service).db.select().from(V2OwnerAuthorizationTable).all().pipe(Effect.orDie)
      }).pipe(Effect.provide(Database.layerFromPath(database))),
    )
    expect(rows).toHaveLength(1)
    expect(
      await Effect.runPromise(
        V2OwnerAuthorization.verifyAuthorization(pair.publicKeyPem, {
          authorizationID: rows[0]!.authorization_id,
          campaignID: rows[0]!.campaign_id,
          subjectCommit: rows[0]!.subject_commit,
          subjectTree: rows[0]!.subject_tree,
          schemaDigest: rows[0]!.schema_digest,
          buildID: rows[0]!.build_id,
          packageDigest: rows[0]!.package_digest,
          validFrom: rows[0]!.valid_from,
          expiresAt: rows[0]!.expires_at,
          signatureDigest: rows[0]!.signature_digest,
        }),
      ),
    ).toBeTrue()
  })
})
