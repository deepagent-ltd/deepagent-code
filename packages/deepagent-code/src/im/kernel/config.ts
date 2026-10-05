export * as KernelConfig from "./config"

// B1 PoC 直连配置：门面 /api/im/exchange 就绪前，内核连接参数经环境变量注入。B2 用 exchange
// 客户端（sk- key → 内核 token，缓存 + 过期重换）替换 fromEnv；Info 的字段即 exchange 的返回契约。
export interface Info {
  readonly appkey: string
  readonly navigator: string
  readonly token: string
  /** 本机的内核用户身份（kernel user_id）——回声消息（自己发的消息的 WS 回推）按它识别。 */
  readonly userID: string
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
