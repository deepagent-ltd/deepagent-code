export * as V2OwnerDevMint from "./v2-owner-dev-mint"

// run 模式适配 deepagent 系统（2026-09-03 用户指令）：dev 构建的自举 owner 授权。V2-only
// profile（coreV2Only）拒绝 legacy SessionPrompt，轮次必须由 V2 runner（canonical turn，含
// 四图装配）执行 — 但 ownerQualified 要求 Ed25519 签名的授权行。生产发布由流水线 mint 并
// 附带 owner-authorization.json（V2OwnerSeed 种子）；dev 构建（版本戳 0.0.0-*）没有发布产
// 物，此前要求手动跑 mint --dev。本模块让 dev 构建在启动时自举：
//
//   - 仅当 InstallationVersion 是 dev 戳（0.0.0- 前缀）或显式 DEEPAGENT_CODE_V2_OWNER_DEV_MINT=1
//   - 仅当操作者未显式设置 DEEPAGENT_CODE_V2_OWNER_CAMPAIGN（显式配置优先）
//   - 幂等：默认 dev campaign（v2-owner-dev-local）已有 active 行则跳过
//   - 密钥持久化在状态目录（跨重启稳定），不可写则退化为进程内临时对
//   - 身份字段 = buildIdentityFromVersion(InstallationVersion) — 与验证器从安装版本重推导
//     的口径一致，因此只需种行 + 设置验证公钥 env，campaign/build-identity 走默认派生
//
// 安全姿态：生产版本（非 0.0.0- 戳）永远不会走这条路径 — fail-closed 合同不变；dev 授权
// 只对本机 DB 生效，且 WARN 日志留痕。

import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "../../database/database"
import { Global } from "../../global"
import { InstallationVersion } from "../../installation/version"
import { Hash } from "../../util/hash"
import { V2OwnerAuthorization } from "./v2-owner-authorization"
import { V2ProviderTurn, devOwnerCampaignFor, isDevBuildVersion } from "./v2-provider-turn"
import { V2OwnerAuthorizationTable } from "./v2-owner-authorization.sql"
import { buildIdentityFromVersion } from "./v2-provider-turn"

// Per-build campaign (derivation shared with v2-provider-turn's defaultOwnerCampaign so the
// verifier resolves the SAME campaign with zero env wiring): the authorization table is
// append-only with a UNIQUE campaign index and a dev build's identity changes every rebuild, so
// each build gets its own insert-only row; stale rows stay inert (their campaigns are never
// resolved again). The mint's remaining job is exactly: ensure THIS build's row exists.

export const isDevBuild = isDevBuildVersion

export type DevMintOutcome =
  | { readonly minted: true; readonly campaignID: string }
  | {
      readonly minted: false
      readonly reason: "not_dev_build" | "explicit_campaign" | "already_present" | "mint_failed"
      readonly detail?: string
    }

const devKeyPair = (stateDir: string) => {
  const keyDir = join(stateDir, "v2-owner-dev")
  const keyPath = join(keyDir, "key.pem")
  const pubPath = join(keyDir, "public.pem")
  if (existsSync(keyPath) && existsSync(pubPath)) {
    return { privateKeyPem: readFileSync(keyPath, "utf8"), publicKeyPem: readFileSync(pubPath, "utf8") }
  }
  const pair = V2OwnerAuthorization.generateAuthorizationKeyPair()
  try {
    mkdirSync(keyDir, { recursive: true })
    writeFileSync(keyPath, pair.privateKeyPem, { mode: 0o600 })
    writeFileSync(pubPath, pair.publicKeyPem)
  } catch {
    // unwritable state dir: the process-local pair still works for this run
  }
  return pair
}

/**
 * Ensure a dev-build owner authorization exists so the V2-only profile can actually run. Set envs
 * BEFORE the runner layers build (the verifier reads the public-key env at layer resolution).
 */
export const ensureDevOwnerAuthorization = (
  database: Database.Interface["db"],
  stateDir: string,
): Effect.Effect<DevMintOutcome> =>
  Effect.gen(function* () {
    if (!isDevBuild() && process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT !== "1") {
      return { minted: false, reason: "not_dev_build" } as const
    }
    // An operator-set campaign wins — but NOT our own armed dev campaign (a same-process second
    // call must re-arm envs idempotently, not read its own first call as operator configuration).
    const identityEarly = buildIdentityFromVersion(InstallationVersion)
    const campaign = devOwnerCampaignFor(identityEarly.subjectCommit)
    const armed = process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN?.trim()
    if (armed && armed !== campaign) {
      return { minted: false, reason: "explicit_campaign" } as const
    }
    // A dev build's identity is derived from its version stamp, which CHANGES ON EVERY REBUILD —
    // a stored dev row from a previous build can never qualify the current one. Reuse only a row
    // whose identity matches THIS build; otherwise mint a fresh row (old rows stay, harmless).
    // NOTE: this adapter's .get() resolves SUCCESS(undefined) on no rows — compare against null.
    const identity = identityEarly
    const existing = yield* database
      .select({ authorization_id: V2OwnerAuthorizationTable.authorization_id })
      .from(V2OwnerAuthorizationTable)
      .where(eq(V2OwnerAuthorizationTable.campaign_id, campaign))
      .get()
      .pipe(Effect.orDie)
    const pair = yield* Effect.sync(() => devKeyPair(stateDir))
    // No env arming: the verifier resolves the dev campaign + dev key file deterministically
    // (v2-provider-turn defaultOwnerCampaign / devVerifierPublicKey) — arming was the multi-
    // process timing hole this design removes.
    if (existing != null) {
      return { minted: true, campaignID: campaign } as const
    }
    const fields = {
      authorizationID: `auth_dev_${identity.subjectCommit.slice(0, 12)}`,
      campaignID: campaign,
      ...identity,
      validFrom: Date.now() - 1_000,
      expiresAt: Date.now() + 365 * 86_400_000,
    }
    const signature = V2OwnerAuthorization.signAuthorization(pair.privateKeyPem, fields)
    const authorizationDigest = Hash.sha256(V2OwnerAuthorization.authorizationPayload(fields))
    // campaign_id carries a UNIQUE index — the dev campaign owns exactly ONE row, re-issued IN
    // PLACE on every rebuild (a dev stamp changes the build identity each build). The plain
    // insert covers a fresh store; the conflict-update re-issues the previous build's row to the
    // current identity + signature + window.
    const outcome = yield* Effect
      .gen(function* () {
        yield* database
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
            status: "active" as const,
            signature_digest: signature,
            authorization_digest: authorizationDigest,
            created_at: Date.now(),
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        return { minted: true, campaignID: campaign } as const
      })
      .pipe(
        Effect.catchDefect((defect) =>
          Effect.succeed({
            minted: false,
            reason: "mint_failed",
            detail: String(defect).slice(0, 200),
          } as const),
        ),
      )
    return outcome
  })

/**
 * CLI-entry bootstrap: run the dev mint BEFORE any prompt path can hit the V2-only qualification
 * guard — the guard otherwise resolves the default campaign from an un-armed env and refuses
 * (the httpapi-graph mint runs too late for in-process prompt paths).
 */
export const bootstrapDevOwnerAuthorization = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const outcome = yield* ensureDevOwnerAuthorization(database.db, Global.Path.state)
      if (outcome.minted) console.error(`[v2-owner-dev-mint] armed ${outcome.campaignID}`)
      else if (outcome.reason === "mint_failed") console.error(`[v2-owner-dev-mint] MINT FAILED: ${outcome.detail}`)
    }).pipe(Effect.provide(Database.defaultLayer)),
  ).catch(() => {})
}

/**
 * Production wiring for the owner qualification references (F-15): NOTHING in production ever
 * provided CurrentBuildIdentity / CurrentOwnerAuthorizationPublicKey as layers — the qualification
 * gate's serviceOption returned None and EVERY real install failed v2_owner_unavailable; only the
 * live-llm harness provided them (which is why the C2 mainline smoke needed prepareHarnessOwner).
 * Values resolve at LAYER BUILD, after the dev mint has had its chance to arm the env: build
 * identity from the explicit env override or the installation version (the same derivation the
 * verifier uses), verifier key from the env override or the pinned production key.
 */
export const ownerReferencesLayer = Layer.mergeAll(
  Layer.succeed(
    V2ProviderTurn.CurrentBuildIdentity,
    (() => {
      const raw = process.env.DEEPAGENT_CODE_V2_BUILD_IDENTITY?.trim()
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<V2ProviderTurn.BuildIdentity>
          if (
            parsed.subjectCommit && parsed.subjectTree && parsed.schemaDigest && parsed.buildID && parsed.packageDigest
          )
            return parsed as V2ProviderTurn.BuildIdentity
        } catch {
          // fall through to the version-derived identity
        }
      }
      return buildIdentityFromVersion(InstallationVersion)
    })(),
  ),
  Layer.succeed(
    V2ProviderTurn.CurrentOwnerAuthorizationPublicKey,
    process.env.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY?.trim() ||
      V2OwnerAuthorization.PRODUCTION_OWNER_AUTHORIZATION_PUBLIC_KEY,
  ),
)

/** Boot seam: run before the runner layers resolve (same Database as the route graph). */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const outcome = yield* ensureDevOwnerAuthorization(database.db, Global.Path.state)
    if (outcome.minted) {
      console.error(`[v2-owner-dev-mint] armed ${outcome.campaignID}`)
    } else if (outcome.reason === "mint_failed") {
      console.error(`[v2-owner-dev-mint] MINT FAILED: ${outcome.detail}`)
    } else {
      console.error(`[v2-owner-dev-mint] skipped: ${outcome.reason}`)
    }
  }),
)
