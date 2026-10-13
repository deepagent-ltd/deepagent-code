import { describe, it, expect } from "bun:test"
import {
  FACADE_ERROR_CODES,
  CLIENT_ERROR_CODES,
  facadeErrorStatus,
  normalizeIMName,
  validateIMName,
  IM_NAME_MAX_LENGTH,
} from "../src/im/facade-contract"

// B2 门面契约共享半：命名归一化（trim + 全半角折叠 + 大小写折叠）、归一化后规则校验
// （^[\p{Han}\p{L}\p{N}]{1,20}$，码点计长）、错误码目录的完整性与状态归桶。

describe("normalizeIMName", () => {
  it.each([
    ["ASCII whitespace", "  alice  ", "alice"],
    ["ideographic whitespace", "　alice　", "alice"],
    ["full-width letters/digits", "Ａｌｉｃｅ１２３", "alice123"],
    ["latin case", "Alice", "alice"],
    ["Han/numeric preservation", "张伟007", "张伟007"],
    ["interior ideographic space", "张　伟", "张 伟"],
  ])("normalizes %s", (_label, input, output) => {
    expect(normalizeIMName(input)).toBe(output)
  })
})

describe("validateIMName", () => {
  it.each([
    ["normalized latin", " Ａｌｉｃｅ ", "alice"],
    ["Han", "张伟", "张伟"],
    ["letters/numbers", "user007", "user007"],
    ["Latin length boundary", "a".repeat(IM_NAME_MAX_LENGTH), "a".repeat(IM_NAME_MAX_LENGTH)],
    ["Han length boundary", "汉".repeat(IM_NAME_MAX_LENGTH), "汉".repeat(IM_NAME_MAX_LENGTH)],
  ])("accepts %s", (_label, input, name) => {
    expect(validateIMName(input)).toEqual({ ok: true, name })
  })

  it.each([
    ["empty", "", "empty"],
    ["whitespace", "  　 ", "empty"],
    ["overlong Latin", "a".repeat(IM_NAME_MAX_LENGTH + 1), "too_long"],
    ["overlong Han", "汉".repeat(IM_NAME_MAX_LENGTH + 1), "too_long"],
    ["underscore", "alice_wonderland", "invalid_chars"],
    ["interior whitespace", "alice wonderland", "invalid_chars"],
    ["punctuation", "alice!", "invalid_chars"],
    ["emoji", "😀", "invalid_chars"],
    ["full-width punctuation", "张伟！", "invalid_chars"],
  ] as const)("rejects %s", (_label, input, reason) => {
    expect(validateIMName(input)).toEqual({ ok: false, reason })
  })
})

describe("facade error code catalog", () => {
  it("lists every contract code exactly once", () => {
    expect(new Set(FACADE_ERROR_CODES).size).toBe(FACADE_ERROR_CODES.length)
    // 契约给定的 15 个业务码——漏了哪个，这里的快照先红。
    expect([...FACADE_ERROR_CODES].sort() as string[]).toEqual(
      [
        "im_unavailable",
        "im_not_claimed",
        "im_identity_changed",
        "im_identity_disabled",
        "im_invalid_name",
        "im_name_taken",
        "im_key_invalid",
        "im_cross_org",
        "im_key_already_bound",
        "im_not_found",
        "im_member_not_found",
        "im_not_group_member",
        "im_invalid_group",
        "im_source_identity_missing",
        "im_kernel_error",
      ].sort(),
    )
  })

  it("maps every contract code to its contract HTTP status", () => {
    const expected: Record<string, number> = {
      im_unavailable: 503,
      im_not_claimed: 409,
      im_identity_changed: 409,
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
    for (const code of FACADE_ERROR_CODES) expect(facadeErrorStatus(code)).toBe(expected[code])
  })

  it("buckets client-side codes and unknown codes", () => {
    expect(facadeErrorStatus("transport_error")).toBe(502)
    expect(facadeErrorStatus("invalid_response")).toBe(502)
    expect(facadeErrorStatus("invalid_request")).toBe(400)
    expect(facadeErrorStatus("http_error")).toBe(500)
    expect(facadeErrorStatus("something_new")).toBe(500)
    for (const code of CLIENT_ERROR_CODES) expect(facadeErrorStatus(code)).toBeGreaterThanOrEqual(400)
  })
})
