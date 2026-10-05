// IM 多用户（B2）门面契约的共享纯函数半：命名归一化/校验 + 错误码目录。deepagent-code 服务端
// （src/im/facade.ts，预校验 + 错误透传）与 GUI（packages/app，输入即时反馈 + 逐码文案）共用，
// 保证两侧对同一条规则/同一个码的解释永不漂移。门面仍是权威——这里的校验只是提前反馈。

// 归一化（契约：trim + 全半角折叠 + 大小写折叠）。大小写折叠用 Unicode-aware toLowerCase；
// 全半角折叠覆盖全角 ASCII 可见区（U+FF01–U+FF5E → U+0021–U+007E）与全角空格（U+3000 → U+0020，
// 随后被 trim/字符类规则处理——名字本体不允许出现空格）。
export function normalizeIMName(raw: string): string {
  let out = ""
  for (const ch of raw.trim()) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x3000) {
      out += " "
      continue
    }
    if (cp >= 0xff01 && cp <= 0xff5e) {
      out += String.fromCodePoint(cp - 0xfee0)
      continue
    }
    out += ch
  }
  return out.toLowerCase()
}

// 契约规则：归一化后 ^[\p{Han}\p{L}\p{N}]{1,20}$。{1,20} 作用于码点（u 标志），故长度也用码点数。
// 注意：JSC/V8 不认裸 \p{Han} 别名（Go 认），用等价的 \p{Script=Han} 指代同一 script。
export const IM_NAME_MAX_LENGTH = 20
const NAME_PATTERN = /^[\p{Script=Han}\p{L}\p{N}]{1,20}$/u

export type IMNameInvalidReason = "empty" | "too_long" | "invalid_chars"
export type IMNameValidation = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: IMNameInvalidReason }

export function validateIMName(raw: string): IMNameValidation {
  const name = normalizeIMName(raw)
  const length = [...name].length
  if (length === 0) return { ok: false, reason: "empty" }
  if (length > IM_NAME_MAX_LENGTH) return { ok: false, reason: "too_long" }
  if (!NAME_PATTERN.test(name)) return { ok: false, reason: "invalid_chars" }
  return { ok: true, name }
}

// 门面业务错误码（new-api /api/im/* 的 imError 包络 code 字段）。UI 必须逐码给文案，不得笼统报错；
// 目录即全量清单——app 侧的映射测试按它保证覆盖。client:* 是客户端侧分类（exchange.ts 本地合成）。
export const FACADE_ERROR_CODES = [
  "im_unavailable", // 503 — IM 功能未上线/内核未配置
  "im_not_claimed", // 409 — key 未认领 IM 身份（→ 引导认领）
  "im_identity_disabled", // 403 — key 已删/禁，身份封禁
  "im_invalid_name", // 400 — 命名规则不满足
  "im_name_taken", // 409 — 重名，换名重试
  "im_key_invalid", // 403 — key 无效
  "im_cross_org", // 403 — 跨组织操作
  "im_key_already_bound", // 409 — rebind 的新 key 已绑定别人
  "im_not_found", // 404 — resolve 无此名
  "im_member_not_found", // 404 — 建群 member_names 里有无名
  "im_not_group_member", // 403 — 非群成员（邀请等）
  "im_invalid_group", // 400 — 群参数/群 id 非法
  "im_source_identity_missing", // 409 — rebind 源 key 无身份
  "im_kernel_error", // 502 — 内核异常，稍后重试
] as const

export type FacadeErrorCode = (typeof FACADE_ERROR_CODES)[number]

/** 客户端侧合成的分类码（exchange.ts 本地合成）：门面不可达/响应不可读/无业务码的 HTTP 失败/
 *  本地请求校验失败（空 new_key、自聊等——不发门面）。 */
export const CLIENT_ERROR_CODES = ["transport_error", "invalid_response", "http_error", "invalid_request"] as const
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number]

export type IMFacadeErrorCode = FacadeErrorCode | ClientErrorCode

// 每个门面码的 HTTP 状态（契约给定）；客户端侧分类按语义归桶：transport/invalid_response 是上游
// 故障（502 对 GUI 呈现），http_error 是未分类的服务端拒绝（500）。
const STATUS: Record<FacadeErrorCode, number> = {
  im_unavailable: 503,
  im_not_claimed: 409,
  im_identity_disabled: 403,
  im_invalid_name: 400,
  im_name_taken: 409,
  im_key_invalid: 403,
  im_cross_org: 403,
  im_key_already_bound: 409,
  im_not_found: 404,
  im_member_not_found: 404,
  im_not_group_member: 403,
  im_invalid_group: 400,
  im_source_identity_missing: 409,
  im_kernel_error: 502,
}

export function facadeErrorStatus(code: string): number {
  if (code in STATUS) return STATUS[code as FacadeErrorCode]
  if (code === "transport_error" || code === "invalid_response") return 502
  if (code === "invalid_request") return 400
  return 500
}
