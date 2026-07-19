import { isOfficialProvider } from "@deepagent-code/core/provider-official"
import type { Provider as ResolvedProvider, ProviderConfig } from "@deepagent-code/sdk/v2"

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"
const ANTHROPIC = "@ai-sdk/anthropic"

export type ProviderProtocol = "openai-compatible" | "anthropic"

// Per-model spec override written under `provider.<id>.models.<id>`. Only the fields the user actually
// set are emitted, so a blank field never clobbers the backend catalog-fill with a zero/false.
export type CustomModelConfig = {
  name: string
  reasoning?: boolean
  temperature?: boolean
  limit?: { context: number; output?: number }
}

// The config payload written under `provider.<id>`. `discovery` and `models` are mutually exclusive
// in practice (discovery mode emits an empty models map), but both are typed optional so the emitted
// object has one consistent shape instead of a union callers must narrow.
export type CustomProviderConfig = {
  npm: string
  name: string
  env?: string[]
  options: {
    baseURL: string
    apiKey?: string
    headers?: Record<string, string>
  }
  discovery?: boolean
  models: Record<string, CustomModelConfig>
}

const npmForProtocol = (kind: ProviderProtocol | undefined) => (kind === "anthropic" ? ANTHROPIC : OPENAI_COMPATIBLE)

// Leading host labels that are generic service prefixes and make a poor provider id, so we skip past
// them to reach the brand label (api.deepseek.com -> "deepseek", not "api"). Kept deliberately small:
// only unambiguous service prefixes, never anything that could be a brand.
const GENERIC_HOST_LABELS = new Set(["api", "www", "app", "gateway", "proxy", "open"])

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type ModelErr = {
  id?: string
  name?: string
  context?: string
}

export type HeaderErr = {
  key?: string
  value?: string
}

export type ModelRow = {
  row: string
  id: string
  name: string
  // Editable spec overrides. `context` is a text field (parsed to a positive int on save; blank means
  // "let the backend/catalog fill it"). reasoning/temperature are booleans.
  context: string
  reasoning: boolean
  temperature: boolean
  err: ModelErr
}

export type HeaderRow = {
  row: string
  key: string
  value: string
  err: HeaderErr
}

export type FormState = {
  providerID: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelRow[]
  headers: HeaderRow[]
  err: {
    providerID?: string
    name?: string
    baseURL?: string
  }
}

type ValidateArgs = {
  form: FormState
  t: Translator
  disabledProviders: string[]
  existingProviderIDs: Set<string>
  // Protocol detected during model discovery; decides the SDK npm written to config. Defaults to
  // openai-compatible when omitted (backward compatible with the manual form).
  protocol?: ProviderProtocol
  // Runtime discovery mode: when true AND the user listed no manual models, persist `discovery: true`
  // with an empty model list so the backend refreshes models from the provider's /models endpoint on
  // every load instead of freezing them into config. Manual models always take precedence and turn
  // this off for that provider.
  discovery?: boolean
  // Edit mode: the provider being edited was persisted with `discovery: true`. We keep discovery on
  // (so the backend still refreshes the model list) AND emit the user's per-model spec overrides,
  // which the build loop merges over the discovered models (manual wins per-id). Without this, saving
  // spec edits would freeze the model snapshot and disable runtime refresh.
  editDiscovery?: boolean
  // Providers whose ids are already taken but belong to the provider being edited (so an edit doesn't
  // trip the "already exists" check on its own id).
  editingProviderID?: string
}

// Turn a base URL into a stable, unique provider id + a human display name so the user only has to
// enter URL + key. Rules:
//   - id is derived from the registrable host label (api.deepseek.com -> "deepseek",
//     open.bigmodel.cn -> "bigmodel"), slugified to satisfy PROVIDER_ID.
//   - reserved official ids (openai/deepseek/anthropic/zhipuai/xai/google/...) and any id already in
//     use are avoided by appending a numeric suffix, since a third-party id that collides with an
//     official one is rejected by the backend (THIRD_PARTY_PROVIDER_CONFLICT).
//   - `disabledProviders` do NOT count as taken: re-adding a previously disabled provider should be
//     able to reuse its id.
export function deriveProviderIdentity(input: {
  baseURL: string
  existingProviderIDs: Set<string>
  disabledProviders?: string[]
}): { providerID: string; name: string } {
  const disabled = new Set(input.disabledProviders ?? [])
  const taken = (id: string) =>
    (input.existingProviderIDs.has(id) && !disabled.has(id)) || (isOfficialProvider(id) && !disabled.has(id))

  const base = baseSlug(input.baseURL)
  let providerID = base
  let n = 2
  while (taken(providerID)) {
    providerID = `${base}-${n}`
    n++
  }
  return { providerID, name: displayName(base) }
}

function baseSlug(baseURL: string): string {
  let host = ""
  try {
    host = new URL(baseURL.trim()).hostname
  } catch {
    host = ""
  }
  const labels = host.split(".").filter(Boolean)
  // Drop leading generic service labels (api., www., ...) so we land on the brand label.
  while (labels.length > 1 && GENERIC_HOST_LABELS.has(labels[0].toLowerCase())) labels.shift()
  // Prefer the registrable label: for a.b.com pick "b"; for single-label/localhost keep as-is.
  const label = labels.length >= 2 ? labels[labels.length - 2] : (labels[0] ?? "")
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
  // Must satisfy PROVIDER_ID (starts alphanumeric). Fall back to a safe default.
  return slug && PROVIDER_ID.test(slug) ? slug : "custom-provider"
}

function displayName(slug: string): string {
  const cleaned = slug.replace(/[-_]+/g, " ").trim()
  if (!cleaned) return "Custom Provider"
  return cleaned
    .split(" ")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ")
}

export function validateCustomProvider(input: ValidateArgs) {
  const typedID = input.form.providerID.trim()
  const typedName = input.form.name.trim()
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim()

  const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
  const key = apiKey && !env ? apiKey : undefined

  const urlError = !baseURL
    ? input.t("provider.custom.error.baseURL.required")
    : !/^https?:\/\//.test(baseURL)
      ? input.t("provider.custom.error.baseURL.format")
      : undefined

  // Zero-config path: when the user leaves id/name blank we derive them from the URL, so those
  // fields are no longer required. Derivation needs a usable URL — if the URL itself is invalid we
  // skip it and let urlError drive the failure instead of emitting a spurious id/name error.
  const derived = !urlError && (!typedID || !typedName) ? deriveProviderIdentity({
    baseURL,
    existingProviderIDs: input.existingProviderIDs,
    disabledProviders: input.disabledProviders,
  }) : undefined
  const providerID = typedID || derived?.providerID || ""
  const name = typedName || derived?.name || ""

  // Only the user's explicitly-typed id is format-checked; a derived id is always valid by
  // construction. A blank id with no derivable URL still surfaces as "required".
  const idError = !providerID
    ? input.t("provider.custom.error.providerID.required")
    : typedID && !PROVIDER_ID.test(typedID)
      ? input.t("provider.custom.error.providerID.format")
      : undefined

  const nameError = !name ? input.t("provider.custom.error.name.required") : undefined

  const disabled = input.disabledProviders.includes(providerID)
  // Editing a provider keeps its own id — don't flag that as a collision.
  const isSelf = input.editingProviderID === providerID
  const existsError = idError
    ? undefined
    : input.existingProviderIDs.has(providerID) && !disabled && !isSelf
      ? input.t("provider.custom.error.providerID.exists")
      : undefined

  // Discovery mode is only active when the user listed no manual models: the model list then comes
  // from the backend at runtime, so the empty model rows must not fail validation.
  const hasManualModels = input.form.models.some((m) => m.id.trim().length > 0)
  const discoveryMode = !!input.discovery && !hasManualModels

  const seenModels = new Set<string>()
  const models = input.form.models.map((m) => {
    const id = m.id.trim()
    const idError = !id
      ? input.t("provider.custom.error.required")
      : seenModels.has(id)
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenModels.add(id)
            return undefined
          })()
    const nameError = !m.name.trim() ? input.t("provider.custom.error.required") : undefined
    const ctx = m.context.trim()
    // Blank context is allowed (backend/catalog fills it); a non-empty value must be a positive int.
    const contextError = ctx && !/^\d+$/.test(ctx) ? input.t("provider.custom.error.context") : undefined
    return { id: idError, name: nameError, context: contextError }
  })
  const modelsValid =
    (discoveryMode || models.every((m) => !m.id && !m.name)) && models.every((m) => !m.context)
  const modelConfig = Object.fromEntries(
    input.form.models.map((m) => {
      const ctx = m.context.trim()
      const spec: CustomModelConfig = {
        name: m.name.trim(),
        ...(m.reasoning ? { reasoning: true } : {}),
        ...(m.temperature ? { temperature: true } : {}),
        ...(ctx ? { limit: { context: Number(ctx) } } : {}),
      }
      return [m.id.trim(), spec]
    }),
  )

  const seenHeaders = new Set<string>()
  const headers = input.form.headers.map((h) => {
    const key = h.key.trim()
    const value = h.value.trim()

    if (!key && !value) return {}
    const keyError = !key
      ? input.t("provider.custom.error.required")
      : seenHeaders.has(key.toLowerCase())
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenHeaders.add(key.toLowerCase())
            return undefined
          })()
    const valueError = !value ? input.t("provider.custom.error.required") : undefined
    return { key: keyError, value: valueError }
  })
  const headersValid = headers.every((h) => !h.key && !h.value)
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
      .map((h) => [h.key, h.value]),
  )

  const err = {
    providerID: idError ?? existsError,
    name: nameError,
    baseURL: urlError,
  }

  const ok = !idError && !existsError && !nameError && !urlError && modelsValid && headersValid
  if (!ok) return { err, models, headers }

  const config: CustomProviderConfig = {
    npm: npmForProtocol(input.protocol),
    name,
    ...(env ? { env: [env] } : {}),
    options: {
      baseURL,
      ...(key ? { apiKey: key } : {}),
      ...(Object.keys(headerConfig).length ? { headers: headerConfig } : {}),
    },
    // Edit-of-discovery: keep discovery on (runtime refresh) AND persist the spec overrides — the
    // build loop merges these over the discovered models (manual wins per-id).
    // New discovery mode: persist the opt-in flag and an empty model list (backend refreshes).
    // Manual mode: freeze the listed models and leave discovery off.
    ...(input.editDiscovery
      ? { discovery: true, models: modelConfig }
      : discoveryMode
        ? { discovery: true, models: {} }
        : { models: modelConfig }),
  }

  return {
    err,
    models,
    headers,
    result: { providerID, name, key, config },
  }
}

// Build the dialog form state for editing an existing custom provider. Fields (URL/key/headers/name)
// come from the raw config entry; model rows are seeded from the RESOLVED provider so the user sees the
// actual context/reasoning/temperature values (a discovery provider has no models in config — its
// specs only exist post-resolve). Each row is pre-filled so edits override just those fields.
export function formStateFromProvider(input: {
  config: ProviderConfig
  resolved: ResolvedProvider | undefined
}): FormState {
  const { config, resolved } = input
  const headers = config.options?.headers
  const headerRows =
    headers && typeof headers === "object" && Object.keys(headers).length
      ? Object.entries(headers as Record<string, string>).map(([key, value]) =>
          headerRow2(String(key), String(value)),
        )
      : [headerRow()]

  const resolvedModels = resolved?.models ?? {}
  const modelRows = Object.entries(resolvedModels).map(([id, m]) =>
    modelRow({
      id,
      name: m.name || id,
      context: m.limit?.context ? String(m.limit.context) : "",
      reasoning: !!m.capabilities?.reasoning,
      temperature: !!m.capabilities?.temperature,
    }),
  )

  return {
    providerID: resolved?.id ?? config.id ?? "",
    name: config.name ?? resolved?.name ?? "",
    baseURL: (config.options?.baseURL as string | undefined) ?? "",
    apiKey: (config.options?.apiKey as string | undefined) ?? "",
    models: modelRows.length ? modelRows : [modelRow()],
    headers: headerRows,
    err: {},
  }
}

let row = 0

const nextRow = () => `row-${row++}`

export const modelRow = (init?: Partial<ModelRow>): ModelRow => ({
  row: nextRow(),
  id: "",
  name: "",
  context: "",
  reasoning: false,
  temperature: false,
  err: {},
  ...init,
})
export const headerRow = (): HeaderRow => ({ row: nextRow(), key: "", value: "", err: {} })
const headerRow2 = (key: string, value: string): HeaderRow => ({ row: nextRow(), key, value, err: {} })
