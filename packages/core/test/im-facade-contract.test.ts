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
  it("trims surrounding whitespace including the ideographic space", () => {
    expect(normalizeIMName("  alice  ")).toBe("alice")
    expect(normalizeIMName("　alice　")).toBe("alice")
  })

  it("folds full-width ASCII letters/digits to half-width", () => {
    expect(normalizeIMName("Ａｌｉｃｅ１２３")).toBe("alice123")
  })

  it("case-folds latin and keeps han/numeric untouched", () => {
    expect(normalizeIMName("Alice")).toBe("alice")
    expect(normalizeIMName("张伟007")).toBe("张伟007")
  })

  it("folds an interior ideographic space to a plain space (rejected later by validation)", () => {
    expect(normalizeIMName("张　伟")).toBe("张 伟")
  })
})

describe("validateIMName", () => {
  it("accepts han, letters and numbers, returning the normalized name", () => {
    expect(validateIMName(" Ａｌｉｃｅ ")).toEqual({ ok: true, name: "alice" })
    expect(validateIMName("张伟")).toEqual({ ok: true, name: "张伟" })
    expect(validateIMName("user007")).toEqual({ ok: true, name: "user007" })
  })

  it("rejects empty input", () => {
    expect(validateIMName("")).toEqual({ ok: false, reason: "empty" })
    expect(validateIMName("  　 ")).toEqual({ ok: false, reason: "empty" })
  })

  it("rejects names longer than 20 code points (counted as code points, not UTF-16 units)", () => {
    expect(validateIMName("a".repeat(IM_NAME_MAX_LENGTH))).toEqual({ ok: true, name: "a".repeat(20) })
    expect(validateIMName("a".repeat(IM_NAME_MAX_LENGTH + 1))).toEqual({ ok: false, reason: "too_long" })
    // 20 个汉字正好通过（汉字是 BMP 单码点）
    expect(validateIMName("汉".repeat(20)).ok).toBe(true)
    expect(validateIMName("汉".repeat(21))).toEqual({ ok: false, reason: "too_long" })
  })

  it("rejects characters outside Han/L/N (punctuation, emoji, underscore, interior space)", () => {
    expect(validateIMName("alice_wonderland")).toEqual({ ok: false, reason: "invalid_chars" })
    expect(validateIMName("alice wonderland")).toEqual({ ok: false, reason: "invalid_chars" })
    expect(validateIMName("alice!")).toEqual({ ok: false, reason: "invalid_chars" })
    expect(validateIMName("😀")).toEqual({ ok: false, reason: "invalid_chars" })
    expect(validateIMName("张伟！")).toEqual({ ok: false, reason: "invalid_chars" })
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
