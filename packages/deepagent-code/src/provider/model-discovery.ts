export type ProviderDiscoveryKind = "openai-compatible" | "anthropic"

export type DiscoveredModel = {
  id: string
  name: string
}

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
      return { id: item.id, name: modelName(item, item.id) }
    })
    .filter((item): item is DiscoveredModel => Boolean(item))
}

export type ProtocolDiscoveryResult = {
  kind: ProviderDiscoveryKind
  models: DiscoveredModel[]
}

// Resolve the provider protocol and its model list in one pass. When `kind` is given we probe only
// that protocol; otherwise we try openai-compatible first (the common case), then anthropic, and
// return whichever yields models. The last error message is surfaced when nothing succeeds so the
// caller can report a useful failure. `probe` is injectable for testing.
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
  let lastError: unknown
  for (const kind of candidates) {
    try {
      const models = await probe(kind)
      if (models.length > 0) return { kind, models }
      lastError = new Error("No provider models were returned")
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No provider models were returned")
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
  if (!response.ok) throw new Error(`${input.providerID} model discovery failed: HTTP ${response.status}`)
  const body = (await response.json()) as { data?: unknown[] }

  const seen = new Set<string>()
  return parseModelList(body).filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}
