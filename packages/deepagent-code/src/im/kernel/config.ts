export * as KernelConfig from "./config"

import { createHash } from "node:crypto"
import type { IMDeviceProof } from "../device-proof"
import { Effect } from "effect"
import type { KernelDeliverySchema } from "@deepagent-code/core/im/kernel-delivery.schema"

/** An irreversible snapshot of the actual credential, not a claimed platform identity revision. */
export function deliverySource(config: Info): KernelDeliverySchema.Source {
  const url = new URL(config.navigator)
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol))
    throw new Error("Kernel navigator must be a credential-free HTTP endpoint")
  const realm = url.href
  return {
    realm,
    appkey: config.appkey,
    orgID: config.identity?.orgID ?? null,
    senderID: config.userID,
    credentialFingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          "deepagent.im.kernel-credential.v1",
          realm,
          config.appkey,
          config.identity?.orgID ?? null,
          config.userID,
          config.token,
        ]),
      )
      .digest("hex"),
  }
}

// 内核连接配置。两个来源（server.ts 装配处抉择）：B2 门面 /api/im/exchange（sk- key → 内核
// token + 组织身份，facadeFromEnv 声明门面坐标）；B1 PoC 直连 env 注入（fromEnv，无组织身份，
// 全员群 provision 与 @Agent @me 门随之关闭）。Info 的字段即 exchange 的返回契约。
export interface Info {
  readonly appkey: string
  readonly navigator: string
  readonly token: string
  /** 本机的内核用户身份（kernel user_id）——回声消息（自己发的消息的 WS 回推）按它识别。 */
  readonly userID: string
  /** Independent deployment capability; never a current media permission. */
  readonly protectedMedia?: boolean
  /** Server-only callbacks; native custody never exports a private key to the SDK. */
  readonly protectedDeviceAuth?: ProtectedDeviceAuth
  readonly socketAudience?: string
  /** 门面组织身份（exchange 返回）；PoC 直连路径缺席。 */
  readonly identity?: Identity
}

export interface ProtectedDeviceAuth {
  readonly profile: "dac-im-device-v1"
  readonly publicJwk: IMDeviceProof.PublicJwk
  readonly jkt: string
  readonly socketAudience: string
  readonly allowInsecureLoopbackForTests?: boolean
  readonly entitlementID: string
  readonly bindingVersion: number
  readonly signConnect: (challenge: IMDeviceProof.SocketChallenge, source: { audience: string; token: string; connectionEpoch: number }) => Promise<string>
  readonly signHttp: (request: { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; credential: string; currentSourceEpoch: number }) => Promise<Record<string, string>>
}

export interface Identity {
  readonly orgID: number
  readonly uuid: string
  readonly name: string
  /** 组织全员群的内核 groupId（门面纯函数 org<orgId>）——本地 provision 的绑定目标。 */
  readonly orgAllGroupID: string
}

export const protectedMediaFromEnv = (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const profile = env.DEEPAGENT_IM_KERNEL_MEDIA_PROFILE
  if (profile === undefined || profile === "") return false
  if (profile !== "mysql-protected-media-v1")
    throw new Error("DEEPAGENT_IM_KERNEL_MEDIA_PROFILE must be mysql-protected-media-v1 or unset")
  return true
}

const FACADE_ENV_KEYS = {
  url: "DEEPAGENT_IM_FACADE_URL",
  key: "DEEPAGENT_IM_FACADE_KEY",
} as const

/** 门面 URL/key 的 env 键名（B2 facade.ts 的凭据解析复用，避免字面量两处漂移）。 */
export const facadeEnvKeys = FACADE_ENV_KEYS

export interface FacadeSource {
  readonly facadeURL: string
  readonly key: string
  readonly device?: {
    readonly profile: "dac-im-device-v1"
    readonly publicJwk: IMDeviceProof.PublicJwk
    readonly entitlementID: string
    readonly deviceJkt: string
    readonly bindingVersion: number
    readonly uuid: string
    readonly headers: (request: { method: "GET" | "POST" | "PUT" | "DELETE"; url: string }) => Effect.Effect<Record<string, string>, unknown>
  }
}

// 门面坐标：URL 缺席 ⇒ undefined（走 PoC env 路径）；URL 在而 key 缺席 ⇒ undefined + 警告
// （fail-closed：半截配置绝不连接）。不打日志 value——key 是凭证。
// auth.json 的 sk- key 自动发现列 follow-up，dev 路径一律显式注入 DEEPAGENT_IM_FACADE_KEY。
export const facadeFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): FacadeSource | undefined => {
  const facadeURL = env[FACADE_ENV_KEYS.url]
  if (!facadeURL) return undefined
  const key = env[FACADE_ENV_KEYS.key]
  if (!key) {
    console.warn(
      `[im-kernel] ${FACADE_ENV_KEYS.url} is set but ${FACADE_ENV_KEYS.key} is missing — kernel integration disabled`,
    )
    return undefined
  }
  return { facadeURL, key }
}

const ENV_KEYS = {
  appkey: "DEEPAGENT_IM_KERNEL_APPKEY",
  navigator: "DEEPAGENT_IM_KERNEL_NAVIGATOR",
  token: "DEEPAGENT_IM_KERNEL_TOKEN",
  userID: "DEEPAGENT_IM_KERNEL_USER_ID",
} as const

// 全部缺省 ⇒ undefined（内核集成整体关闭，单用户路径零影响）；部分设置 ⇒ undefined + 警告
// （fail-closed：半截配置绝不连接）。不打日志 value——token 是凭证。
export const fromEnv = (env: Readonly<Record<string, string | undefined>> = process.env): Info | undefined => {
  const values = {
    appkey: env[ENV_KEYS.appkey],
    navigator: env[ENV_KEYS.navigator],
    token: env[ENV_KEYS.token],
    userID: env[ENV_KEYS.userID],
  }
  const missing = (Object.keys(ENV_KEYS) as ReadonlyArray<keyof typeof ENV_KEYS>).filter((key) => !values[key])
  if (missing.length === Object.keys(ENV_KEYS).length) return undefined
  if (missing.length > 0) {
    console.warn(
      `[im-kernel] incomplete kernel config; missing ${missing.map((key) => ENV_KEYS[key]).join(", ")} — kernel integration disabled`,
    )
    return undefined
  }
  return values as Info
}
