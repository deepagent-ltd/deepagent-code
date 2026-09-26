import { describe, expect, test } from "bun:test"
import {
  OFFICIAL_PROVIDER_CATALOG_ALIASES,
  OFFICIAL_PROVIDER_IDS,
  officialProviderCatalogID,
} from "../src/provider-official"

describe("provider-official catalog aliases (D2)", () => {
  test("every alias maps an official id to a non-official catalog id", () => {
    for (const [officialID, catalogID] of Object.entries(OFFICIAL_PROVIDER_CATALOG_ALIASES)) {
      expect((OFFICIAL_PROVIDER_IDS as readonly string[]).includes(officialID)).toBe(true)
      // The catalog successor must NOT itself be an official id — otherwise the bridge would
      // duplicate an official entry instead of re-homing a renamed third-party catalog entry.
      expect((OFFICIAL_PROVIDER_IDS as readonly string[]).includes(catalogID!)).toBe(false)
    }
  })

  test("officialProviderCatalogID resolves drift and passes through everything else", () => {
    expect(officialProviderCatalogID("kimi-for-coding")).toBe("kimi-code-plan-cn")
    expect(officialProviderCatalogID("deepseek")).toBe("deepseek")
    expect(officialProviderCatalogID("not-official")).toBe("not-official")
  })
})
