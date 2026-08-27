export * as ModelProtocol from "./model-protocol"

import { contentDigest } from "./contract/digest"
import * as Contract from "./contract/model-protocol"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"

/**
 * Explicit provider protocol resolution (design §5.1-5.2, C2-01/C2-02).
 *
 * This module wires the frozen `contract/model-protocol.ts` union into the
 * existing Model/Provider config + Catalog surface. It is the single place the
 * runner model resolver (C2-02) asks "which protocol does this model speak?" —
 * the runtime never infers a protocol from a one-off HTTP error and never
 * silently falls back to a guessed protocol within the same attempt.
 *
 * The config/catalog schema carries an OPTIONAL explicit `protocol` (old config
 * migrates: it is derived from the source classification below). A model whose
 * source is unknown or whose explicit protocol contradicts its source is
 * resolved to an EXPLICIT `disabled` selection with a closed
 * `model_protocol_selection_required` / `protocol_conflict` reason — never to a
 * guessed Chat route.
 */

type ModelProtocol = Contract.ModelProtocol
type ModelProtocolCapabilities = Contract.ModelProtocolCapabilities
type ModelProtocolSelectionKind = Contract.ModelProtocolSelectionKind
type ModelProtocolSelectionState = Contract.ModelProtocolSelectionState
type ModelProtocolDisabledReason = Contract.ModelProtocolDisabledReason

/**
 * Resolved, effective protocol selection for a model after applying the
 * explicit config and the §5.2 source migration. `protocol` is `null` only in
 * the `disabled` state, which is the only legal state for an unknown/conflict
 * model (design §5.2).
 */
export interface ModelProtocolResolution {
  readonly protocol: ModelProtocol | null
  readonly selectionKind: ModelProtocolSelectionKind
  readonly selectionState: ModelProtocolSelectionState
  readonly disabledReason?: ModelProtocolDisabledReason
  readonly capabilities: ModelProtocolCapabilities
}

/**
 * Providers that expose an OpenAI Responses-compatible `/responses` endpoint and
 * are therefore allowlisted to resolve to `openai-compatible.responses` (design
 * §5.2). Closed, deterministic, dependency-free set. This is a configuration
 * constant, not evidence: a model is only routed to Responses when it explicitly
 * selects the protocol (the capability probe that produces evidence is C2-03).
 */
export const RESPONSES_ALLOWLIST: ReadonlySet<string> = new Set(["deepseek"])

type SourceClass = {
  readonly kind: ModelProtocolSelectionKind
  readonly protocol: ModelProtocol | null
}

const ANTHROPIC_PROVIDER = ProviderV2.ID.make("anthropic")
const OPENAI_PROVIDER = ProviderV2.ID.make("openai")

const pkgOf = (model: ModelV2.Info) => (model.api.type === "aisdk" ? model.api.package : undefined)

/**
 * Classify a model's source per design §5.2, independent of any explicit config.
 * `openai`/`anthropic` are the canonical first-party protocols; every other
 * OpenAI-compatible provider defaults to Chat; anything that cannot be
 * attributed to the frozen protocol union is `unknown` (-> disabled).
 */
export function classifySource(model: ModelV2.Info, provider?: ProviderV2.Info): SourceClass {
  const pkg = pkgOf(model)
  const providerID = provider ? provider.id : model.providerID

  if (pkg === "@ai-sdk/anthropic" || providerID === ANTHROPIC_PROVIDER) {
    return { kind: "anthropic", protocol: "anthropic.messages" }
  }
  if (pkg === "@ai-sdk/openai" || providerID === OPENAI_PROVIDER) {
    return { kind: "canonical_openai", protocol: "openai.responses" }
  }
  if (pkg === "@ai-sdk/openai-compatible" && model.api.url !== undefined) {
    return { kind: "openai_compatible", protocol: "openai-compatible.chat" }
  }
  return { kind: "unknown", protocol: null }
}

function familyOfKind(kind: ModelProtocolSelectionKind): "openai" | "anthropic" | "compatible" {
  switch (kind) {
    case "canonical_openai":
      return "openai"
    case "anthropic":
      return "anthropic"
    default:
      return "compatible"
  }
}

function familyOfProtocol(protocol: ModelProtocol): "openai" | "anthropic" | "compatible" {
  if (protocol === "anthropic.messages") return "anthropic"
  if (protocol === "openai.responses") return "openai"
  return "compatible"
}

function kindOfProtocol(protocol: ModelProtocol): ModelProtocolSelectionKind {
  if (protocol === "anthropic.messages") return "anthropic"
  if (protocol === "openai.responses") return "canonical_openai"
  return "openai_compatible"
}

/** Default capability set for a protocol, before any probe-derived override. */
export function defaultCapabilities(protocol: ModelProtocol): ModelProtocolCapabilities {
  const responses = protocol === "openai.responses" || protocol === "openai-compatible.responses"
  return {
    structuredOutput: true,
    reasoningItems: responses,
    providerToolExecution: true,
    previousResponseId: responses,
    remoteCompaction: responses,
    streamTransport: "http_sse",
    protocolRevision: Contract.ModelProtocolVersion.protocol,
  }
}

/** Capabilities declared on the model api, or the protocol defaults if unset. */
function declaredCapabilities(model: ModelV2.Info, protocol: ModelProtocol): ModelProtocolCapabilities {
  return model.api.protocolCapabilities ?? defaultCapabilities(protocol)
}

function isResponsesAllowlisted(model: ModelV2.Info, provider: ProviderV2.Info | undefined): boolean {
  return RESPONSES_ALLOWLIST.has(provider ? provider.id : model.providerID)
}

/**
 * Resolve the effective protocol selection for a model. Precedence:
 *   1. explicit `model.api.protocol` (model-level),
 *   2. explicit `provider.api.protocol` (provider-level default),
 *   3. the §5.2 source migration,
 *   4. `disabled` with `model_protocol_selection_required` for unknown source,
 *   5. `disabled` with `protocol_conflict` when an explicit protocol contradicts
 *      a clearly-known source family.
 *
 * There is no inferred Chat fallback: a disabled selection is a typed error, not
 * a silent route to `openai-compatible.chat`.
 */
export function resolveModelProtocol(model: ModelV2.Info, provider?: ProviderV2.Info): ModelProtocolResolution {
  const explicit = model.api.protocol ?? provider?.api.protocol
  const source = classifySource(model, provider)

  if (explicit) {
    const capabilities = declaredCapabilities(model, explicit)
    if (source.kind === "unknown") {
      // Unattributed source (e.g. a user-configured custom provider): an
      // explicit protocol is the user's own choice — accept it, never guess.
      return { protocol: explicit, selectionKind: kindOfProtocol(explicit), selectionState: "selected", capabilities }
    }
    if (familyOfKind(source.kind) !== familyOfProtocol(explicit)) {
      // Known source family contradicts the explicit protocol -> same-attempt
      // conflict; do not silently coerce.
      return {
        protocol: null,
        selectionKind: "conflict",
        selectionState: "disabled",
        disabledReason: "protocol_conflict",
        capabilities,
      }
    }
    const selectionKind =
      explicit === "openai-compatible.responses" && isResponsesAllowlisted(model, provider)
        ? "allowlisted_provider"
        : source.kind
    return { protocol: explicit, selectionKind, selectionState: "selected", capabilities }
  }

  if (source.protocol) {
    return {
      protocol: source.protocol,
      selectionKind: source.kind,
      selectionState: "selected",
      capabilities: declaredCapabilities(model, source.protocol),
    }
  }

  return {
    protocol: null,
    selectionKind: "unknown",
    selectionState: "disabled",
    disabledReason: "model_protocol_selection_required",
    capabilities: defaultCapabilities("openai-compatible.chat"),
  }
}

/** The llm route id driving a protocol (matches @deepagent-code/llm protocol route ids). */
export function protocolRouteId(protocol: ModelProtocol): string {
  switch (protocol) {
    case "openai.responses":
      return "openai-responses"
    case "openai-compatible.responses":
      return "openai-compatible-responses"
    case "openai-compatible.chat":
      return "openai-compatible-chat"
    case "anthropic.messages":
      return "anthropic-messages"
  }
}

const endpointUrl = (model: ModelV2.Info, provider?: ProviderV2.Info): string | undefined => {
  const value = model.api.url ?? provider?.api.url
  if (value) return value
  const bodyBase = model.request.body.baseURL
  return typeof bodyBase === "string" ? bodyBase : undefined
}

function availabilityOf(model: ModelV2.Info, provider?: ProviderV2.Info): Contract.ModelAvailability {
  if (!model.enabled) return "disabled"
  if (model.status === "alpha" || model.status === "beta") return "preview"
  if (model.providerID === ProviderV2.ID.make("openai")) return "stable"
  if (isResponsesAllowlisted(model, provider)) return "allowlisted"
  return "stable"
}

function routeOriginOf(model: ModelV2.Info, protocol: ModelProtocol, provider?: ProviderV2.Info): Contract.ProviderRouteOrigin {
  return {
    routeId: protocolRouteId(protocol),
    originId: provider ? provider.id : model.providerID,
    endpointRef: contentDigest(endpointUrl(model, provider) ?? model.providerID),
    protocolVersion: String(Contract.ModelProtocolVersion.protocol),
  }
}

function versionBindingsOf(model: ModelV2.Info, capabilities: ModelProtocolCapabilities, provider?: ProviderV2.Info): Contract.ModelVersionBindings {
  return {
    endpointVersion: contentDigest(endpointUrl(model, provider) ?? model.providerID),
    originVersion: contentDigest({ provider: provider ? provider.id : model.providerID, model: model.id }),
    capabilityVersion: contentDigest(capabilities),
    loweringVersion: 1,
  }
}

/** Build the frozen `ModelCatalogEntry` for a resolved model (design §5.1-5.2). */
export function catalogEntryFor(
  model: ModelV2.Info,
  provider: ProviderV2.Info | undefined,
  selection: ModelProtocolResolution,
): Contract.ModelCatalogEntry {
  if (!selection.protocol) {
    throw new Error(`catalogEntryFor requires a non-disabled selection for ${model.providerID}/${model.id}`)
  }
  return new Contract.ModelCatalogEntry({
    schemaVersion: Contract.ModelProtocolVersion.catalog,
    modelId: model.id,
    providerId: model.providerID,
    protocol: selection.protocol,
    availability: availabilityOf(model, provider),
    routeOrigin: routeOriginOf(model, selection.protocol, provider),
    versionBindings: versionBindingsOf(model, selection.capabilities, provider),
    capabilities: selection.capabilities,
    contextWindow: model.limit.context,
  })
}

/** Build the frozen `ModelProviderConfig` for a resolved provider (design §5.1-5.2). */
export function providerConfigFor(
  model: ModelV2.Info,
  provider: ProviderV2.Info | undefined,
  selection: ModelProtocolResolution,
): Contract.ModelProviderConfig {
  if (!selection.protocol) {
    throw new Error(`providerConfigFor requires a non-disabled selection for ${model.providerID}/${model.id}`)
  }
  return new Contract.ModelProviderConfig({
    schemaVersion: Contract.ModelProtocolVersion.config,
    providerId: model.providerID,
    protocol: selection.protocol,
    selectionKind: selection.selectionKind,
    selectionState: selection.selectionState,
    disabledReason: selection.disabledReason,
    routeOrigin: routeOriginOf(model, selection.protocol, provider),
    versionBindings: versionBindingsOf(model, selection.capabilities, provider),
    capabilities: selection.capabilities,
  })
}

/** Byte-stable schema digest of the resolved protocol config (design §5.1, C2-01). */
export function resolvedProtocolConfigDigest(model: ModelV2.Info, provider?: ProviderV2.Info): string {
  const selection = resolveModelProtocol(model, provider)
  return Contract.modelProviderConfigDigest(providerConfigFor(model, provider, selection))
}

/** Byte-stable schema digest of the resolved catalog entry for a model. */
export function resolvedCatalogEntryDigest(model: ModelV2.Info, provider?: ProviderV2.Info): string {
  const selection = resolveModelProtocol(model, provider)
  return Contract.modelCatalogEntryDigest(catalogEntryFor(model, provider, selection))
}
