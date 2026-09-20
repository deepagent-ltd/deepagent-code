import { dict as en, type TuiI18nKey } from "./en"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"

// Non-component translation for contexts without the Solid hook: builtin feature-plugins
// register commands from a plain `async (api) => {...}` body where useTuiI18n() has no
// component scope. Reads the same kv `tui_locale` the TuiI18nProvider persists, with the
// same LANG detection fallback and en fallback for missing keys.
const dictionaries = { en, zh, zht } as const

export type PluginTranslator = (key: TuiI18nKey, params?: Record<string, string | number | boolean>) => string

const resolveTemplate = (text: string, params?: Record<string, string | number | boolean>) => {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey: string) => {
    const value = params[rawKey]
    return value === undefined ? "" : String(value)
  })
}

const detectLocale = (): "en" | "zh" | "zht" => {
  const lang = process.env.LANG ?? process.env.LC_ALL ?? ""
  if (/^zh(_TW|_HK|_Hant)/i.test(lang) || /^zh-Hant/i.test(lang)) return "zht"
  if (/^zh/i.test(lang)) return "zh"
  return "en"
}

export function pluginTranslator(kv: { get: (key: string, fallback?: unknown) => unknown }): PluginTranslator {
  const raw = kv.get("tui_locale")
  const locale = raw === "zh" || raw === "zht" ? raw : detectLocale()
  return (key, params) => {
    const text = dictionaries[locale][key] ?? en[key] ?? String(key)
    return resolveTemplate(text, params)
  }
}
