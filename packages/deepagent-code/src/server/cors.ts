import { Context } from "effect"

// The product's own browser origins: the DeepAgent platform (API console +
// static hosting). The full product surface now lives on `ai.deepagent.ltd`
// (static hosting / docs / assets) and `api.deepagent.ltd` (API platform
// console); any subdomain of either is treated as first-party.
const deepagentCodeOrigin = /^https:\/\/([a-z0-9-]+\.)*(ai|api)\.deepagent\.ltd$/

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@deepagent-code/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (deepagentCodeOrigin.test(input)) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
