import { OFFICIAL_PROVIDER_ID_SET } from "@deepagent-code/core/provider"
import type { ModelsDev } from "@deepagent-code/core/models-dev"

// Cross-provider spec-fill for third-party gateways.
//
// A custom/third-party provider's /models endpoint (and hand-listed config models) only give us an id
// and a display name — never context window, reasoning capability, cost, or modalities. But gateways
// almost always forward WELL-KNOWN model ids (gpt-4o, claude-3-5-sonnet, deepseek-chat, glm-4.6, …)
// that already exist in the models.dev catalog — just under a DIFFERENT provider id. This module
// matches a bare model id against the whole catalog so the build loop can fill the missing *capability
// and limit* specs from the canonical catalog entry.
//
// Hard boundary: we only ever fill capability/limit/cost/modality/metadata fields. We never pull
// api.url or api.npm from a cross-provider match — the endpoint and protocol belong to the user's
// gateway, not to the catalog vendor.

// Normalize a model id so gateway-prefixed / separator-variant spellings collapse to one key:
//   "openai/gpt-4o" -> "gpt-4o", "anthropic.claude-3-5-sonnet" -> "claude-3-5-sonnet",
//   "GPT-4O" -> "gpt-4o", "deepseek_chat" -> "deepseek-chat".
export function normalizeModelID(id: string): string {
  let out = id.trim().toLowerCase()
  // Drop a leading vendor prefix separated by "/" (e.g. "openai/gpt-4o", "some-router/claude-3").
  out = out.replace(/^[a-z0-9][a-z0-9-]*\//, "")
  // Drop a leading known-vendor prefix separated by "." (e.g. bedrock-style "anthropic.claude-…").
  out = out.replace(/^(openai|anthropic|google|meta|deepseek|mistral|qwen|zhipuai|zai|xai|cohere|moonshotai|kimi)[.]/, "")
  // Collapse "." and "_" separators to "-" so "glm-4.6" and "glm-4-6" match.
  out = out.replace(/[._]/g, "-")
  return out
}

// Strip a trailing date/version stamp so "claude-3-5-sonnet-20241022" can fall back to
// "claude-3-5-sonnet". Only used as a secondary (loose) match after exact-normalized misses.
export function stripDateSuffix(normalized: string): string {
  return normalized.replace(/-(?:\d{6,8}|v\d+(?:-\d+)*|latest|preview)$/g, "")
}

export interface CatalogMatch {
  providerID: string
  model: ModelsDev.Model
}

export interface CatalogIndex {
  exact: Map<string, CatalogMatch>
  loose: Map<string, CatalogMatch>
}

// When the same normalized id exists under multiple catalog providers with different specs, prefer:
//   (a) an official provider (the canonical source),
//   (b) the largest context window (most permissive — least likely to truncate),
//   (c) alphabetical providerID (stable tie-break).
function preferMatch(existing: CatalogMatch, candidate: CatalogMatch): CatalogMatch {
  const existingOfficial = OFFICIAL_PROVIDER_ID_SET.has(existing.providerID)
  const candidateOfficial = OFFICIAL_PROVIDER_ID_SET.has(candidate.providerID)
  if (existingOfficial !== candidateOfficial) return existingOfficial ? existing : candidate
  const existingCtx = existing.model.limit?.context ?? 0
  const candidateCtx = candidate.model.limit?.context ?? 0
  if (existingCtx !== candidateCtx) return existingCtx >= candidateCtx ? existing : candidate
  return existing.providerID <= candidate.providerID ? existing : candidate
}

function insert(map: Map<string, CatalogMatch>, key: string, match: CatalogMatch) {
  if (!key) return
  const existing = map.get(key)
  map.set(key, existing ? preferMatch(existing, match) : match)
}

// Build the normalized cross-provider index ONCE per provider-state build (avoids O(providers·models)
// re-scans in the per-model loop). Tolerates an empty catalog (offline / fetch disabled) by returning
// empty maps.
export function buildCatalogIndex(catalog: Record<string, ModelsDev.Provider>): CatalogIndex {
  const exact = new Map<string, CatalogMatch>()
  const loose = new Map<string, CatalogMatch>()
  for (const [providerID, provider] of Object.entries(catalog ?? {})) {
    for (const model of Object.values(provider.models ?? {})) {
      if (!model || typeof model.id !== "string") continue
      const normalized = normalizeModelID(model.id)
      const match: CatalogMatch = { providerID, model }
      insert(exact, normalized, match)
      insert(loose, stripDateSuffix(normalized), match)
    }
  }
  return { exact, loose }
}

// Look up catalog specs for a discovered/custom model. Tries the api id then the config id against the
// exact map, then the date-stripped loose map. Returns the matched catalog model or undefined.
export function catalogSpecFor(apiID: string, modelID: string, index: CatalogIndex): ModelsDev.Model | undefined {
  const apiKey = normalizeModelID(apiID)
  const idKey = normalizeModelID(modelID)
  return (
    index.exact.get(apiKey)?.model ??
    index.exact.get(idKey)?.model ??
    index.loose.get(stripDateSuffix(apiKey))?.model ??
    index.loose.get(stripDateSuffix(idKey))?.model
  )
}

// Small projection of the fields the discover dialog surfaces so the user can preview (and then
// override) the auto-filled specs. Undefined when there's no catalog match.
export interface ProjectedSpec {
  context: number
  output: number
  reasoning: boolean
  temperature: boolean
  toolcall: boolean
  matchedFrom: string
}

export function projectSpec(match: CatalogMatch): ProjectedSpec {
  return {
    context: match.model.limit?.context ?? 0,
    output: match.model.limit?.output ?? 0,
    reasoning: match.model.reasoning ?? false,
    temperature: match.model.temperature ?? false,
    toolcall: match.model.tool_call ?? true,
    matchedFrom: match.providerID,
  }
}

export function specMatchFor(apiID: string, modelID: string, index: CatalogIndex): CatalogMatch | undefined {
  const apiKey = normalizeModelID(apiID)
  const idKey = normalizeModelID(modelID)
  return (
    index.exact.get(apiKey) ??
    index.exact.get(idKey) ??
    index.loose.get(stripDateSuffix(apiKey)) ??
    index.loose.get(stripDateSuffix(idKey))
  )
}
