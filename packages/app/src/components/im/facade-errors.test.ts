import { describe, expect, test } from "bun:test"
import { CLIENT_ERROR_CODES, FACADE_ERROR_CODES } from "@deepagent-code/core/im/facade-contract"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { FACADE_ERROR_I18N, facadeErrorKey } from "./facade-errors"

// 门面契约的硬性要求：UI 对 15 业务码 + 4 客户端码逐码给文案。这里遍历 core 目录保证
// 映射表 + en/zh 字典对每一个码都有条目——加新码不补文案会在本测试立刻失败。
describe("facade-errors", () => {
  test("every contract code maps to an i18n key that exists in en and zh", () => {
    for (const code of [...FACADE_ERROR_CODES, ...CLIENT_ERROR_CODES]) {
      const key = FACADE_ERROR_I18N[code as keyof typeof FACADE_ERROR_I18N]
      expect(key, `missing mapping for ${code}`).toBe(`im.facade.error.${code}`)
      expect(en[key], `en dict missing ${key}`).toBeDefined()
      expect(zh[key as keyof typeof zh], `zh dict missing ${key}`).toBeDefined()
    }
  })

  test("unknown codes fall back to the generic key", () => {
    expect(facadeErrorKey("some_future_code")).toBe("im.facade.error.unknown")
    expect(en["im.facade.error.unknown"]).toBeDefined()
  })
})
