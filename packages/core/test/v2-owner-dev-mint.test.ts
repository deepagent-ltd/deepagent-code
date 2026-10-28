// run 模式适配（2026-09-03）：dev 构建自举 owner 授权的行为合同 — 仅 dev 戳/显式 env 触发、
// 幂等（同 campaign 二次调用不重复种行）、显式 campaign 优先跳过、env 指向本机持久化的
// 公钥、种出的行能被 V2OwnerAuthorization 验签。
import "./fixture/install-version"
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { sql } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
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
import { hostname, tmpdir } from "node:os"

const freshEnv = () => {
  delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
  delete process.env.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY
}
const flockLayer = (state: string) =>
  EffectFlock.layer.pipe(Layer.provide(Global.layerWith({ state })), Layer.provide(FSUtil.defaultLayer))

describe("V2OwnerDevMint.ensureDevOwnerAuthorization", () => {
  test("forced dev mint seeds one verifiable row and is idempotent", async () => {
    const started = performance.now()
    const trace = (phase: string) => console.info(JSON.stringify({
      test: "owner-dev-mint-idempotent", phase, elapsedMs: Math.round(performance.now() - started),
    }))
    trace("start")
    freshEnv()
    process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT = "1"
    const stateDir = mkdtempSync(join(tmpdir(), "dev-mint-"))
    const { first, rows } = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Database.Service
        trace("memory-database-ready")
        const first = yield* V2OwnerDevMint.ensureDevOwnerAuthorization(service.db, stateDir)
        trace("memory-mint-complete")
        const rows = yield* service.db
          .select()
          .from(V2OwnerAuthorizationTable)
          .where(sql`${V2OwnerAuthorizationTable.campaign_id} = ${(first as { campaignID: string }).campaignID}`)
          .get()
          .pipe(Effect.orDie)
        return { first, rows }
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.provide(flockLayer(stateDir))),
    )
    trace("memory-scope-closed")
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
    trace("signature-check-complete")
    expect(verified).toBeTrue()

    // second call on a FRESH connection to a FILE db (same store): already_present fast path —
    // still reports minted (env re-armed), no duplicate row
    const dbFile = join(stateDir, "dev-mint.sqlite")
    const runOnFile = Effect.gen(function* () {
      const service = yield* Database.Service
      trace("file-database-ready")
      const second = yield* V2OwnerDevMint.ensureDevOwnerAuthorization(service.db, stateDir)
      trace("file-mint-complete")
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
    trace("file-seed-start")
    await Effect.runPromise(
      runOnFile.pipe(Effect.provide(Database.layerFromPath(dbFile)), Effect.provide(flockLayer(stateDir))),
    )
    trace("file-seed-scope-closed")
    const { second, count } = await Effect.runPromise(
      runOnFile.pipe(Effect.provide(Database.layerFromPath(dbFile)), Effect.provide(flockLayer(stateDir))),
    )
    trace("file-reopen-scope-closed")
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
      new Promise<{ readonly pid: number | undefined; readonly code: number; readonly stdout: string; readonly stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [worker, JSON.stringify({ database, state: stateDir })], {
          cwd: join(import.meta.dir, ".."),
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on("data", (data) => stdout.push(Buffer.from(data)))
        child.stderr.on("data", (data) => stderr.push(Buffer.from(data)))
        child.on("close", (code) =>
          resolve({
            pid: child.pid,
            code: code ?? 1,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          }),
        )
      })
    const startedAt = Date.now()
    const results = await Promise.all([run(), run()])
    const closedAt = Date.now()
    expect(results.map((result) => result.code), JSON.stringify(results)).toEqual([0, 0])
    for (const result of results) {
      // Both original contention paths must belong to these actual workers.
      // A preflight record identifies its holder; every other stderr line fails.
      expect(result.stderr.split("\n").filter(Boolean).every((line) =>
        ownedContention(line, { database, pids: results.map((worker) => worker.pid), hostname: hostname(), startedAt, closedAt })),
        Buffer.from(result.stderr).subarray(0, 16_384).toString("utf8")).toBe(true)
    }
    console.info(JSON.stringify({ test: "owner-dev-mint-workers", phase: "contention-checked",
      workerPIDs: results.map((result) => result.pid), hostname: hostname(), startedAt, closedAt,
      preflight: results.flatMap((result) => result.stderr.split("\n")
        .filter((line) => line.startsWith("[preflight] database runtime lock held: "))
        .map((line) => JSON.parse(line.slice("[preflight] database runtime lock held: ".length)))),
      closedReadOnlyStages: results.flatMap((result) => result.stderr.split("\n")
        .filter((line) => line.startsWith("[owner-preflight-stage] "))
        .map((line) => JSON.parse(line.slice("[owner-preflight-stage] ".length)))),
      sqliteReadErrors: results.flatMap((result) => result.stderr.split("\n")
        .filter((line) => line.startsWith("[owner-preflight-sqlite] "))
        .map((line) => JSON.parse(line.slice("[owner-preflight-sqlite] ".length)))),
    }))
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

function ownedContention(line: string, owner: {
  database: string; pids: readonly (number | undefined)[]; hostname: string; startedAt: number; closedAt: number
}) {
  if (line.startsWith("[owner-preflight-sqlite] ")) {
    const text = line.slice("[owner-preflight-sqlite] ".length)
    const observation = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
      pid: Schema.Int, stage: Schema.Literals(["connection", "inspection"]), code: Schema.String,
      errno: Schema.NullOr(Schema.Int), immutable: Schema.Boolean, attempt: Schema.Int,
    })))(text)
    return Option.isSome(observation) && owner.pids.includes(observation.value.pid) &&
      observation.value.attempt >= 0 && observation.value.attempt <= 3 &&
      (observation.value.code === "unknown" || /^[A-Z][A-Z0-9_]{0,63}$/.test(observation.value.code)) &&
      JSON.stringify(observation.value) === text
  }
  if (line.startsWith("[owner-preflight-stage] ")) {
    const text = line.slice("[owner-preflight-stage] ".length)
    const observation = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
      pid: Schema.Int, stage: Schema.Literals(["observed", "ordinary-read", "ordinary-observations", "stamp-refused", "active-owner",
        "lease-refused", "guard-refused", "inspection-refused", "inspection-ready", "post-refused"]),
      exists: Schema.Boolean, header: Schema.Boolean, readable: Schema.Boolean, walMode: Schema.Boolean,
      wal: Schema.Boolean, shm: Schema.Boolean, active: Schema.Boolean, leaseTimeout: Schema.Boolean,
    })))(text)
    return Option.isSome(observation) && owner.pids.includes(observation.value.pid) && JSON.stringify(observation.value) === text
  }
  if (line === `[db-runtime-lock] waiting for ${owner.database}.runtime.lock (held by another process)`) return true
  const prefix = "[preflight] database runtime lock held: "
  if (!line.startsWith(prefix)) return false
  const text = line.slice(prefix.length)
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
    token: Schema.String, pid: Schema.Int, hostname: Schema.String, createdAt: Schema.String,
  })))(text)
  if (Option.isNone(decoded)) return false
  const value = decoded.value
  const createdAt = Date.parse(value.createdAt)
  return JSON.stringify(value) === text &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.token) &&
    value.pid > 0 && owner.pids.includes(value.pid) && value.hostname === owner.hostname &&
    Number.isFinite(createdAt) && createdAt >= owner.startedAt && createdAt <= owner.closedAt &&
    new Date(createdAt).toISOString() === value.createdAt
}
