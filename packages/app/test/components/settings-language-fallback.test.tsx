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

it("uses the actual English fallback for corrected settings semantics without overwriting a non-English locale", async () => {
  vi.stubGlobal("localStorage", new Storage())
  await loadLocaleDict("fr")
  const Probe = () => {
    const language = useLanguage()
    return (
      <>
        <p>{language.t("settings.tab.about")}</p>
        {settingsFallbackKeys.map((key) => (
          <p data-fallback-key={key}>{language.t(key)}</p>
        ))}
      </>
    )
  }
  render(() => (
    <LanguageProvider locale="fr">
      <Probe />
    </LanguageProvider>
  ))
  await screen.findByText("À propos")
  for (const key of settingsFallbackKeys) {
    const value = document.querySelector(`[data-fallback-key="${key}"]`)?.textContent
    expect(value).toBe(dict[key])
    expect(value).not.toBe(key)
  }
})
