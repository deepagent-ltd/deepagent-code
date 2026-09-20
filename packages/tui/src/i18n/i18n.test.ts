import { describe, expect, test } from "bun:test"
import { dict as en, type TuiI18nKey } from "../i18n/en"
import { dict as zh } from "../i18n/zh"
import { dict as zht } from "../i18n/zht"

// W2-7 — the TUI i18n dictionaries. en is the key-union source of truth; the zh/zht mirrors
// must cover every key (satisfies Record<Keys, string> enforces this at typecheck, this test
// guards the runtime shape against future drift).

describe("tui i18n dictionaries", () => {
  test("zh and zht cover every en key", () => {
    const keys = Object.keys(en) as TuiI18nKey[]
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(typeof zh[key]).toBe("string")
      expect(typeof zht[key]).toBe("string")
    }
  })

  test("no dictionary carries empty-string values", () => {
    for (const dict of [en, zh, zht]) {
      for (const value of Object.values(dict)) expect(value.length).toBeGreaterThan(0)
    }
  })

  test("keys are namespaced under tui.", () => {
    for (const key of Object.keys(en)) expect(key.startsWith("tui.")).toBe(true)
  })
})
