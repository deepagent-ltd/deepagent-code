// run 模式适配（2026-09-03）：dev 构建自举 owner 授权的行为合同 — 仅 dev 戳/显式 env 触发、
// 幂等（同 campaign 二次调用不重复种行）、显式 campaign 优先跳过、env 指向本机持久化的
// 公钥、种出的行能被 V2OwnerAuthorization 验签。
import "./fixture/install-version"
import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { V2OwnerAuthorization } from "../src/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "../src/session/runner/v2-owner-authorization.sql"
import { V2OwnerDevMint } from "../src/session/runner/v2-owner-dev-mint"
import { tmpdir } from "node:os"

const freshEnv = () => {
  delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
  delete process.env.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY
}
// the deterministic dev key-file resolution caches per process — point it at each test's state


describe("V2OwnerDevMint.ensureDevOwnerAuthorization", () => {
  test("forced dev mint seeds one verifiable row, sets envs, and is idempotent", async () => {
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
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )
    expect(first.minted).toBe(true)
    expect((first as { campaignID: string }).campaignID).toMatch(/^v2-owner-dev-[0-9a-f]{12}$/)
    expect(readFileSync(join(stateDir, "v2-owner-dev", "public.pem"), "utf8")).toContain("BEGIN PUBLIC KEY")
    expect(rows).toBeDefined()

    // the seeded row verifies against the env-publicized key
    const verified = await Effect.runPromise(
      V2OwnerAuthorization.verifyAuthorization(readFileSync(join(stateDir, "v2-owner-dev", "public.pem"), "utf8"), {
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
        .pipe(Effect.map((all) => all.length), Effect.orDie)
      return { second, count }
    })
    // seed the file db once (first mint), then reopen and re-run (idempotency)
    await Effect.runPromise(runOnFile.pipe(Effect.provide(Database.layerFromPath(dbFile))))
    const { second, count } = await Effect.runPromise(
      runOnFile.pipe(Effect.provide(Database.layerFromPath(dbFile))),
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
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )
    expect(outcome).toEqual({ minted: false, reason: "explicit_campaign" })
    delete process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT
    delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
  })
})
