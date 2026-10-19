export type ProviderDiscoveryKind = "openai-compatible" | "anthropic" | "google"

export const discoveryKind = (npm?: string): ProviderDiscoveryKind =>
  npm === "@ai-sdk/google" ? "google" : npm === "@ai-sdk/anthropic" ? "anthropic" : "openai-compatible"

export type DiscoveredModel = {
  id: string
  name: string
  protocols?: ProviderDiscoveryKind[]
}

export class ProviderDiscoveryError extends Error {
  override readonly name = "ProviderDiscoveryError"

  constructor(
    readonly providerID: string,
    readonly status: number,
  ) {
    super(
      `${providerID} model discovery failed: HTTP ${status}${[404, 405, 501].includes(status) ? "; remote model listing is unavailable at this endpoint; use manual configuration" : ""}`,
    )
  }
}

export const isProviderDiscoveryAuthError = (error: unknown) =>
  error instanceof ProviderDiscoveryError && (error.status === 401 || error.status === 403)

export function normalizeBaseURL(input: string) {
  const parsed = new URL(input)
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Provider base URL must use HTTP(S) without embedded credentials")
  parsed.hash = ""
  parsed.search = ""
  return parsed.toString().replace(/\/+$/, "")
}

export const listURL = (baseURL: string) => `${normalizeBaseURL(baseURL)}/models`

export const isChatModel = (modelID: string) => !/embedding|moderation|audio|image|tts|whisper/i.test(modelID)

const modelName = (input: unknown, fallback: string) => {
  if (input && typeof input === "object" && "display_name" in input && typeof input.display_name === "string")
    return input.display_name
  if (input && typeof input === "object" && "name" in input && typeof input.name === "string") return input.name
  return fallback
}

function parseModelList(body: { data?: unknown[] }): DiscoveredModel[] {
  return (body.data ?? [])
    .map((item) => {
      if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") return
      const protocols =
        "supported_endpoint_types" in item && Array.isArray(item.supported_endpoint_types)
          ? [
              ...new Set(
                item.supported_endpoint_types.flatMap((value): ProviderDiscoveryKind[] => {
                  if (typeof value !== "string") return []
                  if (value === "anthropic" || value === "anthropic-messages") return ["anthropic"]
                  if (value === "openai" || value === "openai-compatible") return ["openai-compatible"]
                  return []
                }),
              ),
            ]
          : []
      return { id: item.id, name: modelName(item, item.id), ...(protocols.length > 0 ? { protocols } : {}) }
    })
    .filter((item): item is DiscoveredModel => Boolean(item))
}

export type ProtocolDiscoveryResult = {
  kind: ProviderDiscoveryKind
  models: DiscoveredModel[]
}

// A successful GET /models only proves that the credential can list models. Gateways commonly accept
// more than one authentication header on that route, so protocol detection must use endpoint metadata
// or an unambiguous single successful probe instead of silently preferring OpenAI compatibility.
export async function discoverWithProtocol(
  input: {
    baseURL: string
    apiKey: string
    providerID: string
    kind?: ProviderDiscoveryKind
    headers?: Record<string, string>
  },
  probe: (kind: ProviderDiscoveryKind) => Promise<DiscoveredModel[]> = (kind) =>
    discoverProviderModels({ ...input, kind }),
): Promise<ProtocolDiscoveryResult> {
  const candidates: ProviderDiscoveryKind[] = input.kind ? [input.kind] : ["openai-compatible", "anthropic"]
  const results = await Promise.all(
    candidates.map((kind) =>
      probe(kind).then(
        (models) => ({ kind, models, error: undefined }),
        (error: unknown) => ({ kind, models: [] as DiscoveredModel[], error }),
      ),
    ),
  )
  const successful = results.filter((result) => result.models.length > 0)
  const declared = [...new Set(successful.flatMap((result) => result.models.flatMap((model) => model.protocols ?? [])))]
  if (declared.length === 1) {
    const kind = declared[0]
    const result = successful.find((item) => item.models.some((model) => model.protocols?.includes(kind)))
    if (result) return { kind, models: result.models }
  }
  if (successful.length === 1) return { kind: successful[0].kind, models: successful[0].models }
  if (successful.length > 1) {
    throw new Error("Provider protocol is ambiguous; select OpenAI-compatible or Anthropic explicitly")
  }
  const error = results.findLast((result) => result.error)?.error
  throw error instanceof Error ? error : new Error("No provider models were returned")
}

// Discovery must never hang forever. An unreachable or silent /models endpoint (wrong URL, a host
// that accepts the TCP connection but never responds) would otherwise leave the fetch pending
// indefinitely — the interactive "connect provider" submit awaits this call, so a hang shows up as a
// dead button. Cap the request so it always resolves (with an error the caller can fall back on).
const DISCOVERY_TIMEOUT_MS = 15_000
const MAX_DISCOVERY_BYTES = 1024 * 1024
const MAX_DISCOVERY_PAGES = 20

export async function discoverProviderModels(input: {
  baseURL: string
  // Optional: some gateways authenticate discovery entirely via custom headers (no bearer/x-api-key).
  apiKey?: string
  providerID: string
  kind?: ProviderDiscoveryKind
  headers?: Record<string, string>
}): Promise<DiscoveredModel[]> {
  const kind = input.kind ?? (input.providerID === "anthropic" ? "anthropic" : "openai-compatible")
  if (input.apiKey && /[\r\n]/.test(input.apiKey)) throw new Error("Invalid provider credential format")
  if (Object.entries(input.headers ?? {}).some(([key, value]) => /[\r\n]/.test(key + value)))
    throw new Error("Invalid provider discovery headers")
  const headers = new Headers({ accept: "application/json", ...(input.headers ?? {}) })
  // Only attach a credential header when a key is present; header-only auth comes from input.headers.
  if (input.apiKey) {
    if (kind === "anthropic") {
      headers.set("x-api-key", input.apiKey)
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
    } else if (kind === "google") {
      headers.set("x-goog-api-key", input.apiKey)
    } else {
      headers.set("authorization", `Bearer ${input.apiKey}`)
    }
  } else if (kind === "anthropic") {
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
  }

  const url = new URL(listURL(input.baseURL))
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const models: DiscoveredModel[] = []
  const cursors = new Set<string>()
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const response = await fetch(url, {
      headers,
      signal,
      // Never forward a supplied or stored provider credential to a redirect destination.
      redirect: "error",
    }).catch((error) => {
      // A timeout surfaces as an AbortError/TimeoutError; give a discovery-specific message so the
      // interactive flow reports "endpoint didn't respond" instead of a raw abort.
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`${input.providerID} model discovery timed out after ${DISCOVERY_TIMEOUT_MS}ms`)
      }
      throw error
    })
    if (!response.ok) throw new ProviderDiscoveryError(input.providerID, response.status)
    if (!response.body) throw new Error("Provider model list has no response body")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > MAX_DISCOVERY_BYTES) throw new Error("Provider model list exceeds the response size limit")
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const body = (await new Response(Buffer.concat(chunks)).json().catch(() => {
      // Upstream error pages can echo credentials; never expose their text in a parse error.
      throw new Error("Provider returned an invalid JSON model list")
    })) as {
      data?: unknown[]
      models?: unknown[]
      has_more?: boolean
      last_id?: string
      nextPageToken?: string
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Provider returned an unsupported model list")
    if (kind === "google") {
      if (!Array.isArray(body.models)) throw new Error("Provider returned an unsupported Google model list")
      models.push(
        ...body.models.flatMap((item): DiscoveredModel[] => {
          if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") return []
          if (
            !("supportedGenerationMethods" in item) ||
            !Array.isArray(item.supportedGenerationMethods) ||
            !item.supportedGenerationMethods.includes("generateContent")
          )
            return []
          const id = item.name.replace(/^models\//, "")
          return [{ id, name: "displayName" in item && typeof item.displayName === "string" ? item.displayName : id }]
        }),
      )
    } else {
      if (!Array.isArray(body.data)) throw new Error("Provider returned an unsupported model list")
      models.push(...parseModelList(body))
    }
    const cursor =
      kind === "google" ? body.nextPageToken : kind === "anthropic" && body.has_more ? body.last_id : undefined
    if (!cursor) {
      if (kind === "anthropic" && body.has_more) throw new Error("Provider model list is missing its next page cursor")
      const seen = new Set<string>()
      return models
        .filter((model) => {
          if (!model.id.trim() || model.id.length > 256 || seen.has(model.id)) return false
          seen.add(model.id)
          return true
        })
        .slice(0, 1000)
        .map((model) => ({ ...model, name: model.name.slice(0, 256) }))
    }
    if (typeof cursor !== "string" || cursors.has(cursor))
      throw new Error("Provider model list repeated its page cursor")
    cursors.add(cursor)
    url.searchParams.set(kind === "google" ? "pageToken" : "after_id", cursor)
  }
  throw new Error("Provider model list exceeds the page limit")
}
