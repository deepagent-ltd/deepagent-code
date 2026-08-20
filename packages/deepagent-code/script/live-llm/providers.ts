/**
 * Provider matrix for the live LLM all-tests runner (script/run-live-llm-all.ts).
 *
 * Endpoint allowlisting stays fail-closed: only providers registered here, or endpoints
 * explicitly appended through DEEPAGENT_CODE_LIVE_LLM_ALLOWED_ENDPOINTS, are accepted.
 */

export type LiveLLMProviderEndpoint = {
  /** Canonical base URL for the provider, e.g. https://api.deepseek.com */
  baseURL: string
  /** Additional official aliases for the same provider (e.g. the China endpoint). */
  aliases?: ReadonlyArray<string>
}

export type LiveLLMProvider = {
  /** Stable provider identifier used for fingerprints and key file naming. */
  id: string
  /** Human-readable provider label for error messages and logs. */
  label: string
  endpoints: ReadonlyArray<LiveLLMProviderEndpoint>
}

/** Environment variable that appends custom allowed endpoints to the fail-closed allowlist. */
export const LIVE_LLM_ALLOWED_ENDPOINTS_ENV = "DEEPAGENT_CODE_LIVE_LLM_ALLOWED_ENDPOINTS"

/**
 * Official provider registry. IDs follow the models.dev-style identifiers used by the
 * repository models snapshot (deepseek / moonshotai / zai / openai); labels keep the
 * product names (Kimi, GLM) that the evidence chain reports.
 */
export const liveLLMProviders: ReadonlyArray<LiveLLMProvider> = [
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoints: [{ baseURL: "https://api.deepseek.com" }],
  },
  {
    id: "moonshotai",
    label: "Kimi (Moonshot)",
    endpoints: [
      { baseURL: "https://api.moonshot.ai/v1" },
      { baseURL: "https://api.moonshot.cn/v1" },
    ],
  },
  {
    id: "zai",
    label: "GLM (Zhipu / Z.AI)",
    endpoints: [
      { baseURL: "https://api.z.ai/api/paas/v4" },
      { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    endpoints: [{ baseURL: "https://api.openai.com/v1" }],
  },
]

/** A resolved provider: either a registered provider or an explicitly allowed custom endpoint. */
export type ResolvedLiveLLMProvider = {
  id: string
  label: string
  /** Normalized base URL (no trailing slash) that was matched. */
  baseURL: string
  registered: boolean
}

/** Recommended chmod 600 key file location for a provider, derived from its identifier. */
export function recommendedLiveLLMKeyFile(providerID: string) {
  return `~/.deepagent/code/tmp/live-llm-${providerID}.key`
}

/** Normalizes a base URL: requires https, lowercased hostname, no trailing slash. */
export function normalizeLiveLLMEndpoint(baseURL: string) {
  if (!URL.canParse(baseURL)) throw new Error("baseURL must be a valid URL")
  const url = new URL(baseURL)
  if (url.protocol !== "https:") {
    throw new Error(`Live LLM endpoints must use https, received ${baseURL}`)
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`
}

/** Matches a base URL against the built-in official provider registry only. */
export function matchRegisteredLiveLLMProvider(baseURL: string): ResolvedLiveLLMProvider | undefined {
  const normalized = normalizeLiveLLMEndpoint(baseURL)
  for (const provider of liveLLMProviders) {
    for (const endpoint of provider.endpoints) {
      for (const candidate of [endpoint.baseURL, ...(endpoint.aliases ?? [])]) {
        if (normalizeLiveLLMEndpoint(candidate) === normalized) {
          return { id: provider.id, label: provider.label, baseURL: normalized, registered: true }
        }
      }
    }
  }
}

/**
 * Parses DEEPAGENT_CODE_LIVE_LLM_ALLOWED_ENDPOINTS entries.
 *
 * Entries are comma- or whitespace-separated; each entry is either `https://host[/path]`
 * or `provider-id@https://host[/path]` when the fingerprint identifier should not be
 * derived from the hostname.
 */
export function parseCustomAllowedEndpoints(raw: string | undefined): Array<{ id?: string; baseURL: string }> {
  if (!raw?.trim()) return []
  return raw.split(/[\s,]+/).flatMap((entry) => {
    const trimmed = entry.trim()
    if (!trimmed) return []
    const separator = trimmed.indexOf("@")
    const idPart = separator === -1 ? undefined : trimmed.slice(0, separator)
    const urlPart = separator === -1 ? trimmed : trimmed.slice(separator + 1)
    const id = idPart?.trim()
    if (id && !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      throw new Error(
        `${LIVE_LLM_ALLOWED_ENDPOINTS_ENV} provider id "${id}" must match /^[a-z0-9][a-z0-9_-]*$/`,
      )
    }
    if (!URL.canParse(urlPart)) {
      throw new Error(`${LIVE_LLM_ALLOWED_ENDPOINTS_ENV} contains an invalid URL: ${urlPart}`)
    }
    return [{ ...(id ? { id } : {}), baseURL: urlPart }]
  })
}

function customProviderID(baseURL: string) {
  const hostname = new URL(baseURL).hostname.toLowerCase()
  const derived = hostname.split(".")[0]?.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!derived || !/^[a-z0-9]/.test(derived)) return "custom"
  return derived
}

/**
 * Resolves the provider for a base URL. Registered providers always win; otherwise the
 * endpoint is only accepted when explicitly listed in the allowed-endpoints environment
 * variable (fail-closed). Throws when the endpoint is not allowed.
 */
export function resolveLiveLLMProvider(
  baseURL: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedLiveLLMProvider {
  const normalized = normalizeLiveLLMEndpoint(baseURL)
  const registered = matchRegisteredLiveLLMProvider(normalized)
  if (registered) return registered
  const custom = parseCustomAllowedEndpoints(environment[LIVE_LLM_ALLOWED_ENDPOINTS_ENV]).find(
    (entry) => normalizeLiveLLMEndpoint(entry.baseURL) === normalized,
  )
  if (custom) {
    const id = custom.id ?? customProviderID(normalized)
    return { id, label: id, baseURL: normalized, registered: false }
  }
  throw new Error(
    `Real LLM suites currently require an official provider endpoint; official https://api.deepseek.com ` +
      `(deepseek) is the historical default, also allowed: ` +
      `${officialEndpointList()}; extend via ${LIVE_LLM_ALLOWED_ENDPOINTS_ENV}=provider@https://host/path, ` +
      `received ${baseURL}`,
  )
}

/** Comma-separated list of every officially registered endpoint (for error messages). */
export function officialEndpointList() {
  return liveLLMProviders
    .flatMap((provider) => provider.endpoints.map((endpoint) => endpoint.baseURL))
    .join(", ")
}
