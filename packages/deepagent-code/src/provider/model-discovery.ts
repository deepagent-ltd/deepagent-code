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

export async function discoverProviderModels(input: {
  baseURL: string
  apiKey: string
  providerID: string
  kind?: ProviderDiscoveryKind
  headers?: Record<string, string>
}): Promise<DiscoveredModel[]> {
  const kind = input.kind ?? (input.providerID === "anthropic" ? "anthropic" : "openai-compatible")
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(input.headers ?? {}),
  }
  if (kind === "anthropic") {
    headers["x-api-key"] = input.apiKey
    headers["anthropic-version"] ??= "2023-06-01"
  } else {
    headers.authorization = `Bearer ${input.apiKey}`
  }

  const response = await fetch(listURL(input.baseURL), { headers })
  if (!response.ok) throw new Error(`${input.providerID} model discovery failed: HTTP ${response.status}`)
  const body = (await response.json()) as { data?: unknown[] }

  const seen = new Set<string>()
  return parseModelList(body).filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}
