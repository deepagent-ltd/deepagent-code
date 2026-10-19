import { CLIENT_ERROR_CODES, FACADE_ERROR_CODES } from "@deepagent-code/core/im/facade-contract"
import type { IMNameInvalidReason } from "@deepagent-code/core/im/facade-contract"
import type { dict } from "@/i18n/en"

// IM 门面（B2）错误码 → i18n key 的逐码映射。契约要求 UI 逐码给文案、不得笼统报错——映射表即
// 全量清单，facade-errors.test.ts 遍历 core 的 FACADE_ERROR_CODES/CLIENT_ERROR_CODES 保证任何
// 一个码都不会漏出兜底文案之外的呈现。i18n key 在 en/zh 都有条目；其它 locale 缺 key 自动回退英文。

export type FacadeI18nKey = keyof typeof dict

export const FACADE_ERROR_I18N = {
  // ── 业务码（new-api imError code 原样透传）──
  im_unavailable: "im.facade.error.im_unavailable",
  im_not_claimed: "im.facade.error.im_not_claimed",
  im_identity_disabled: "im.facade.error.im_identity_disabled",
  im_identity_changed: "im.facade.error.im_identity_changed",
  im_invalid_name: "im.facade.error.im_invalid_name",
  im_name_taken: "im.facade.error.im_name_taken",
  im_key_invalid: "im.facade.error.im_key_invalid",
  im_cross_org: "im.facade.error.im_cross_org",
  im_key_already_bound: "im.facade.error.im_key_already_bound",
  im_not_found: "im.facade.error.im_not_found",
  im_member_not_found: "im.facade.error.im_member_not_found",
  im_not_group_member: "im.facade.error.im_not_group_member",
  im_invalid_group: "im.facade.error.im_invalid_group",
  im_source_identity_missing: "im.facade.error.im_source_identity_missing",
  im_kernel_error: "im.facade.error.im_kernel_error",
  im_service_changed: "im.facade.error.im_service_changed",
  // ── 客户端侧分类码（deepagent-code 本地合成）──
  transport_error: "im.facade.error.transport_error",
  invalid_response: "im.facade.error.invalid_response",
  http_error: "im.facade.error.http_error",
  invalid_request: "im.facade.error.invalid_request",
} as const satisfies Record<string, FacadeI18nKey>

/** Use classified messages only; upstream error text may contain credentials. */
export const facadeErrorKey = (code: string): FacadeI18nKey =>
  (FACADE_ERROR_I18N as Record<string, FacadeI18nKey>)[code] ?? "im.facade.error.unknown"

// 本地命名规则失败（helpers 的 invalidReason 在场）用规则文案，不用服务端的 im_invalid_name 笼统文案。
const NAME_RULE_KEYS = {
  empty: "im.facade.name.error.empty",
  too_long: "im.facade.name.error.too_long",
  invalid_chars: "im.facade.name.error.invalid_chars",
} as const satisfies Record<IMNameInvalidReason, FacadeI18nKey>

export interface FacadeFailureLike {
  readonly errorCode: string
  readonly errorMessage: string
  readonly invalidReason?: IMNameInvalidReason
}

/** 一次门面操作失败的呈现文案（逐码）。 */
export const facadeFailureText = (t: (key: FacadeI18nKey) => string, failure: FacadeFailureLike): string =>
  failure.invalidReason ? t(NAME_RULE_KEYS[failure.invalidReason]) : t(facadeErrorKey(failure.errorCode))

// 编译期自证：映射表键集必须覆盖契约全量码（漏码 ⇒ 这里类型报错，不必等测试）；
// facade-errors.test.ts 再验证 en/zh 字典里确有对应文案。
const _coverage: Record<(typeof FACADE_ERROR_CODES)[number] | (typeof CLIENT_ERROR_CODES)[number], FacadeI18nKey> =
  FACADE_ERROR_I18N
void _coverage
