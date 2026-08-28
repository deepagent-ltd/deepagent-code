export type ProviderDiscoveryKind = "openai-compatible" | "anthropic"

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
    super(`${providerID} model discovery failed: HTTP ${status}`)
  }
}

export const isProviderDiscoveryAuthError = (error: unknown) =>
  error instanceof ProviderDiscoveryError && (error.status === 401 || error.status === 403)

export function normalizeBaseURL(input: string) {
  const parsed = new URL(input)
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

export async function discoverProviderModels(input: {
  baseURL: string
  // Optional: some gateways authenticate discovery entirely via custom headers (no bearer/x-api-key).
  apiKey?: string
  providerID: string
  kind?: ProviderDiscoveryKind
  headers?: Record<string, string>
}): Promise<DiscoveredModel[]> {
  const kind = input.kind ?? (input.providerID === "anthropic" ? "anthropic" : "openai-compatible")
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(input.headers ?? {}),
  }
  // Only attach a credential header when a key is present; header-only auth comes from input.headers.
  if (input.apiKey) {
    if (kind === "anthropic") {
      headers["x-api-key"] = input.apiKey
      headers["anthropic-version"] ??= "2023-06-01"
    } else {
      headers.authorization = `Bearer ${input.apiKey}`
    }
  } else if (kind === "anthropic") {
    headers["anthropic-version"] ??= "2023-06-01"
  }

  const response = await fetch(listURL(input.baseURL), {
    headers,
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  }).catch((error) => {
    // A timeout surfaces as an AbortError/TimeoutError; give a discovery-specific message so the
    // interactive flow reports "endpoint didn't respond" instead of a raw abort.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`${input.providerID} model discovery timed out after ${DISCOVERY_TIMEOUT_MS}ms`)
    }
    throw error
  })
  if (!response.ok) throw new ProviderDiscoveryError(input.providerID, response.status)
  const body = (await response.json()) as { data?: unknown[] }

  const seen = new Set<string>()
  return parseModelList(body).filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}
