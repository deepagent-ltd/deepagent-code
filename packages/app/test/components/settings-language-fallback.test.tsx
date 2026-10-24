import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { LanguageProvider, loadLocaleDict, useLanguage } from "@/context/language"
import { dict } from "@/i18n/en"
import { settingsFallbackKeys } from "@/i18n/settings-fallback-keys"

vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it.each([
  ["ar", "حول"],
  ["br", "Sobre"],
  ["bs", "O aplikaciji"],
  ["da", "Om"],
  ["de", "Info"],
  ["es", "Acerca de"],
  ["fr", "À propos"],
  ["ja", "情報"],
  ["ko", "정보"],
  ["no", "Om"],
  ["pl", "O programie"],
  ["ru", "О программе"],
  ["uk", "Про застосунок"],
  ["th", "เกี่ยวกับ"],
  ["tr", "Hakkında"],
] as const)("uses the actual English fallback and interpolation without overwriting %s", async (locale, about) => {
  vi.stubGlobal("localStorage", new Storage())
  await loadLocaleDict(locale)
  const Probe = () => {
    const language = useLanguage()
    return (
      <>
        <p>{language.t("settings.tab.about")}</p>
        {settingsFallbackKeys.map((key) => (
          <p data-fallback-key={key}>{language.t(key)}</p>
        ))}
        <p>{language.t("settings.im.entitlement.planYearQuote", { price: 2.5, years: 3 })}</p>
        <p>{language.t("settings.im.entitlement.planLifetimeQuote", { price: 9.9 })}</p>
      </>
    )
  }
  render(() => (
    <LanguageProvider locale={locale}>
      <Probe />
    </LanguageProvider>
  ))
  await screen.findByText(about)
  for (const key of settingsFallbackKeys) {
    const value = document.querySelector(`[data-fallback-key="${key}"]`)?.textContent
    expect(value).toBe(dict[key])
    expect(value).not.toBe(key)
  }
  expect(screen.getByText("2.5 credits · 3 year(s) · 1 device")).toBeTruthy()
  expect(screen.getByText("9.9 credits · Lifetime · 1 device")).toBeTruthy()
})
