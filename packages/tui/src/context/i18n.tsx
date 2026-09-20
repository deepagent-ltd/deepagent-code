import { createSignal, type JSX } from "solid-js"
import { createContext, useContext } from "solid-js"
import { dict as en, type TuiI18nKey } from "../i18n/en"
import { dict as zh } from "../i18n/zh"
import { dict as zht } from "../i18n/zht"
import { useKV } from "./kv"

// W2-7 — TUI i18n: same shape as the ui/app i18n contexts. Locale persists in the TUI kv store
// ("tui_locale"); unresolved locales fall back to en and missing keys fall through to en text,
// so a partial dictionary never blanks a surface. LANG detection seeds the default (first
// LANG=zh* / zht-ish → zh|zht; anything else → en).
export type TuiI18nLocale = "en" | "zh" | "zht"

export type TuiI18n = {
  locale: () => TuiI18nLocale
  setLocale: (next: TuiI18nLocale) => void
  t: (key: TuiI18nKey, params?: Record<string, string | number | boolean>) => string
}

const dictionaries: Record<TuiI18nLocale, Partial<Record<TuiI18nKey, string>>> = {
  en,
  zh,
  zht,
}

const resolveTemplate = (text: string, params?: Record<string, string | number | boolean>) => {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey: string) => {
    const value = params[rawKey]
    return value === undefined ? "" : String(value)
  })
}

const detectLocale = (): TuiI18nLocale => {
  const lang = process.env.LANG ?? process.env.LC_ALL ?? ""
  if (/^zh(_TW|_HK|_Hant)/i.test(lang) || /^zh-Hant/i.test(lang)) return "zht"
  if (/^zh/i.test(lang)) return "zh"
  return "en"
}

const isLocale = (value: unknown): value is TuiI18nLocale =>
  value === "en" || value === "zh" || value === "zht"

const fallback: TuiI18n = {
  locale: () => "en",
  setLocale: () => {},
  t: (key, params) => resolveTemplate(en[key] ?? String(key), params),
}

const Context = createContext<TuiI18n>(fallback)

export function TuiI18nProvider(props: { children: JSX.Element }) {
  const kv = useKV()
  const [current, setCurrent] = createSignal<TuiI18nLocale>(
    isLocale(kv.get("tui_locale")) ? kv.get("tui_locale") : detectLocale(),
  )

  const value: TuiI18n = {
    locale: () => current(),
    setLocale: (next) => {
      setCurrent(next)
      kv.set("tui_locale", next)
    },
    t: (key, params) => {
      const text = dictionaries[current()][key] ?? en[key] ?? String(key)
      return resolveTemplate(text, params)
    },
  }

  return <Context.Provider value={value}>{props.children}</Context.Provider>
}

export function useTuiI18n() {
  return useContext(Context)
}
