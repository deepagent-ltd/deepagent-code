export * as V2OwnerDevMint from "./v2-owner-dev-mint"

// run 模式适配 deepagent 系统（2026-09-03 用户指令）：dev 构建的自举 owner 授权。V2-only
// profile（coreV2Only）拒绝 legacy SessionPrompt，轮次必须由 V2 runner（canonical turn，含
// 四图装配）执行 — 但 ownerQualified 要求 Ed25519 签名的授权行。生产发布由流水线 mint 并
// 附带 owner-authorization.json（V2OwnerSeed 种子）；dev 构建（版本戳 0.0.0-*）没有发布产
// 物，此前要求手动跑 mint --dev。本模块让 dev 构建在启动时自举：
//
//   - 仅当 InstallationVersion 是 dev 戳（0.0.0- 前缀）或显式 DEEPAGENT_CODE_V2_OWNER_DEV_MINT=1
//   - 仅当操作者未显式设置 DEEPAGENT_CODE_V2_OWNER_CAMPAIGN（显式配置优先）
//   - 幂等：默认 dev campaign 已有与持久密钥匹配的 active 行则跳过
//   - 密钥以 0600 原子文件持久化，并由跨进程锁串行生成；不可写即明确 mint_failed
//   - 身份字段 = buildIdentityFromVersion(InstallationVersion) — 与验证器从安装版本重推导
//     的口径一致，因此只需种行 + 设置验证公钥 env，campaign/build-identity 走默认派生
//
// 安全姿态：生产版本（非 0.0.0- 戳）永远不会走这条路径 — fail-closed 合同不变；dev 授权
// 只对本机 DB 生效，且 WARN 日志留痕。

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { createPublicKey } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "../../database/database"
import { writeFileAtomic } from "../../deepagent/atomic-write"
import { Global } from "../../global"
import { InstallationVersion } from "../../installation/version"
import { Hash } from "../../util/hash"
import { EffectFlock } from "../../util/effect-flock"
import { V2OwnerAuthorization } from "./v2-owner-authorization"
import { buildIdentityFromVersion, devOwnerCampaignFor, isDevBuildVersion } from "./v2-provider-turn"
import { V2OwnerAuthorizationTable } from "./v2-owner-authorization.sql"

// Per-build campaign (derivation shared with v2-provider-turn's defaultOwnerCampaign so the
// verifier resolves the SAME campaign with zero env wiring): the authorization table is
// append-only with a UNIQUE campaign index and a dev build's identity changes every rebuild, so
// each build gets its own insert-only row; stale rows stay inert (their campaigns are never
// resolved again). The mint's remaining job is exactly: ensure THIS build's row exists.

export const isDevBuild = isDevBuildVersion
export const isDevOwnerMintEnabled = () => isDevBuild() || process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT === "1"

export type DevMintOutcome =
  | { readonly minted: true; readonly campaignID: string }
  | {
      readonly minted: false
      readonly reason: "not_dev_build" | "explicit_campaign" | "already_present" | "mint_failed"
      readonly detail?: string
    }

export class Service extends Context.Service<Service, { readonly outcome: DevMintOutcome }>()(
  "@deepagent-code/v2/session/V2OwnerDevMint",
) {}

type DevKeyPair = ReturnType<typeof V2OwnerAuthorization.generateAuthorizationKeyPair>

const validDevKeyPair = (value: unknown): value is DevKeyPair => {
  if (typeof value !== "object" || value === null) return false
  if (!("privateKeyPem" in value) || typeof value.privateKeyPem !== "string") return false
  if (!("publicKeyPem" in value) || typeof value.publicKeyPem !== "string") return false
  try {
    return (
      createPublicKey(value.privateKeyPem).export({ type: "spki", format: "pem" }).toString().trim() ===
      value.publicKeyPem.trim()
    )
  } catch {
    return false
  }
}

const devKeyPair = (stateDir: string): DevKeyPair => {
  const keyDir = join(stateDir, "v2-owner-dev")
  const pairPath = join(keyDir, "keypair.json")
  const keyPath = join(keyDir, "key.pem")
  const pubPath = join(keyDir, "public.pem")
  if (existsSync(pairPath)) {
    try {
      const pair: unknown = JSON.parse(readFileSync(pairPath, "utf8"))
      if (validDevKeyPair(pair)) return pair
    } catch {
      // Regenerate a corrupt pair while holding the cross-process mint lock below.
    }
  }
  if (existsSync(keyPath) && existsSync(pubPath)) {
    const pair = { privateKeyPem: readFileSync(keyPath, "utf8"), publicKeyPem: readFileSync(pubPath, "utf8") }
    if (validDevKeyPair(pair)) {
      writeFileAtomic(pairPath, JSON.stringify(pair), 0o600)
      return pair
    }
  }
  const pair = V2OwnerAuthorization.generateAuthorizationKeyPair()
  writeFileAtomic(pairPath, JSON.stringify(pair), 0o600)
  return pair
}

/**
 * Ensure a dev-build owner authorization exists so the V2-only profile can actually run. Set envs
 * BEFORE the runner layers build (the verifier reads the public-key env at layer resolution).
 */
export const ensureDevOwnerAuthorization = (
  database: Database.Interface["db"],
  stateDir: string,
): Effect.Effect<DevMintOutcome, never, EffectFlock.Service> =>
  Effect.gen(function* () {
    if (!isDevOwnerMintEnabled()) {
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
    const identity = identityEarly
    const flock = yield* EffectFlock.Service
    return yield* flock
      .withLock(
        Effect.gen(function* () {
          const pair = yield* Effect.sync(() => devKeyPair(stateDir))
          const existing = yield* database
            .select()
            .from(V2OwnerAuthorizationTable)
            .where(eq(V2OwnerAuthorizationTable.campaign_id, campaign))
            .get()
            .pipe(Effect.orDie)
          if (existing) {
            const existingFields: V2OwnerAuthorization.AuthorizationFields = {
              authorizationID: existing.authorization_id,
              campaignID: existing.campaign_id,
              subjectCommit: existing.subject_commit,
              subjectTree: existing.subject_tree,
              schemaDigest: existing.schema_digest,
              buildID: existing.build_id,
              packageDigest: existing.package_digest,
              validFrom: existing.valid_from,
              expiresAt: existing.expires_at,
              signatureDigest: existing.signature_digest,
            }
            const matchesIdentity =
              existing.status === "active" &&
              existing.subject_commit === identity.subjectCommit &&
              existing.subject_tree === identity.subjectTree &&
              existing.schema_digest === identity.schemaDigest &&
              existing.build_id === identity.buildID &&
              existing.package_digest === identity.packageDigest &&
              existing.authorization_digest === Hash.sha256(V2OwnerAuthorization.authorizationPayload(existingFields))
            if (matchesIdentity && (yield* V2OwnerAuthorization.verifyAuthorization(pair.publicKeyPem, existingFields)))
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
          const values = {
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
            revoked_at: null,
          }
          yield* database
            .insert(V2OwnerAuthorizationTable)
            .values(values)
            .onConflictDoUpdate({
              target: V2OwnerAuthorizationTable.campaign_id,
              set: values,
            })
            .run()
            .pipe(Effect.orDie)
          return { minted: true, campaignID: campaign } as const
        }),
        `v2-owner-dev:${campaign}`,
        join(stateDir, "v2-owner-dev-locks"),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            minted: false,
            reason: "mint_failed",
            detail: String(error).slice(0, 200),
          } as const),
        ),
        Effect.catchDefect((defect) =>
          Effect.succeed({
            minted: false,
            reason: "mint_failed",
            detail: String(defect).slice(0, 200),
          } as const),
        ),
      )
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
      const global = yield* Global.Service
      const outcome = yield* ensureDevOwnerAuthorization(database.db, global.state)
      if (outcome.minted) console.error(`[v2-owner-dev-mint] armed ${outcome.campaignID}`)
      else if (outcome.reason === "mint_failed") console.error(`[v2-owner-dev-mint] MINT FAILED: ${outcome.detail}`)
    }).pipe(
      Effect.provide(Database.defaultLayer),
      Effect.provide(EffectFlock.defaultLayer),
      Effect.provide(Global.defaultLayer),
    ),
  ).catch(() => {})
}

/** Boot seam: run before the runner layers resolve (same Database as the route graph). */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const global = yield* Global.Service
    const outcome = yield* ensureDevOwnerAuthorization(database.db, global.state)
    if (outcome.minted) {
      console.error(`[v2-owner-dev-mint] armed ${outcome.campaignID}`)
    } else if (outcome.reason === "mint_failed") {
      console.error(`[v2-owner-dev-mint] MINT FAILED: ${outcome.detail}`)
    } else {
      console.error(`[v2-owner-dev-mint] skipped: ${outcome.reason}`)
    }
    return { outcome }
  }),
)

/** Default process-root bootstrap. Shared layer constants preserve the same DB/Global identities. */
export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(Global.defaultLayer),
)
