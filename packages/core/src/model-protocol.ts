export * as ModelProtocol from "./model-protocol"

import { Schema } from "effect"
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

// ===========================================================================
// C2-03 — side-effect-free capability probe + persistent config evidence
// ===========================================================================
//
// design §5.2: the capability probe is an independent, side-effect-free,
// auditable configuration action. Its result binds endpoint origin, model id,
// version and a response fingerprint; it is NEVER run inside a business turn
// ("业务 turn 不探测"). An unknown/conflicting selection resolves to an explicit
// `not_applicable` (`model_protocol_selection_required`) state and is never
// silently coerced to a guessed compatible.
//
// Probe realization decision (divergence note for the main agent): the design
// text leaves open whether the probe reaches the wire (a zero-token request). A
// live wire/SENTINEL probe belongs to the wave's live-sentinel items (C2-09 /
// C7-03) and requires user authority; this lane therefore realizes the probe as
// a pure, deterministically DERIVED/DECLARED probe over the frozen protocol +
// the declared/vendored feature matrix. There is deliberately no fetch/fs/db in
// any probe body, so a business turn can never depend on network reachability.
// The C2-09/C7-03 live-sentinel probe, when landed, must plug into
// `refreshConfigEvidence`'s hook (setProbeHook) and keep the deterministic
// identity/evidence contract below unchanged.

/** Whether the probe is applicable for a resolved protocol or explicitly not. */
export type CapabilityProbeState = "applicable" | "not_applicable"

/** The bounded, derived/declared result of a capability probe for a model config. */
export interface CapabilityProbeResult {
  readonly state: CapabilityProbeState
  readonly protocol: ModelProtocol | null
  readonly capabilities: ModelProtocolCapabilities | null
  readonly disabledReason?: ModelProtocolDisabledReason
  /** Deterministic, content-addressed identity of the probe input (never a wall-clock). */
  readonly probeRef: string
  /** Deterministic fingerprint of the derived capability outcome. */
  readonly probeResponseFingerprint: string
}

/** Typed violation: a capability probe is not applicable (disabled/unknown/conflict selection). */
export class CapabilityProbeNotApplicableError extends Schema.TaggedErrorClass<CapabilityProbeNotApplicableError>()(
  "ModelProtocol.CapabilityProbeNotApplicableError",
  { providerId: Schema.String, modelId: Schema.String, disabledReason: Contract.ModelProtocolDisabledReason },
) {}

/**
 * Bounded capability set a resolved model/endpoint supports (design §5.2). The
 * probe is pure: it derives the set from the frozen protocol plus any declared
 * `protocolCapabilities`, applying the protocol defaults for the closed union.
 */
export function probeCapabilities(model: ModelV2.Info, provider?: ProviderV2.Info): CapabilityProbeResult {
  const selection = resolveModelProtocol(model, provider)
  if (!selection.protocol || selection.selectionState === "disabled") {
    const disabledReason = selection.disabledReason ?? "model_protocol_selection_required"
    return {
      state: "not_applicable",
      protocol: null,
      capabilities: null,
      disabledReason,
      probeRef: contentDigest({
        providerId: model.providerID,
        modelId: model.id,
        endpoint: endpointUrl(model, provider) ?? model.providerID,
      }),
      probeResponseFingerprint: contentDigest({ state: "not_applicable", disabledReason }),
    }
  }
  const capabilities = declaredCapabilities(model, selection.protocol)
  return {
    state: "applicable",
    protocol: selection.protocol,
    capabilities,
    probeRef: contentDigest({
      providerId: model.providerID,
      modelId: model.id,
      endpoint: endpointUrl(model, provider) ?? model.providerID,
      protocol: selection.protocol,
    }),
    probeResponseFingerprint: contentDigest({ hashed: contentDigest(capabilities), protocol: selection.protocol }),
  }
}

/**
 * PERSISTENT config evidence binding endpoint/model/origin/version + protocol +
 * capability set + the derived identity hash (design §5.2 C2-03). Every field
 * that contributes to the attempt identity is included so a drift in ANY bound
 * field changes `configIdentityHash` and therefore evicts the cached evidence.
 */
export interface CapabilityConfigEvidence {
  readonly configIdentityHash: string
  readonly providerId: string
  readonly modelId: string
  readonly protocol: ModelProtocol
  readonly routeId: string
  readonly originId: string
  readonly endpointRef: string
  readonly originVersion: string
  readonly capabilityVersion: string
  readonly loweringVersion: number
  readonly capabilities: ModelProtocolCapabilities
  readonly capabilityFingerprint: string
  readonly probeRef: string
  readonly probeResponseFingerprint: string
  readonly selectionState: ModelProtocolSelectionState
}

/**
 * Deterministic identity of the bound config (endpoint/model/origin/version +
 * protocol). Any bound-field change -> a different hash -> the old evidence is
 * evicted on lookup.
 */
export function configIdentityHash(model: ModelV2.Info, provider?: ProviderV2.Info): string {
  const selection = resolveModelProtocol(model, provider)
  return contentDigest({
    providerId: model.providerID,
    modelId: model.id,
    endpoint: endpointUrl(model, provider) ?? model.providerID,
    originId: provider ? provider.id : model.providerID,
    protocol: selection.protocol ?? "disabled",
    originVersion: contentDigest({ providerId: model.providerID, modelId: model.id, endpoint: endpointUrl(model, provider) ?? model.providerID }),
  })
}

function evidenceFromProbe(model: ModelV2.Info, provider: ProviderV2.Info | undefined, probe: CapabilityProbeResult): CapabilityConfigEvidence {
  if (probe.state === "not_applicable" || !probe.protocol || !probe.capabilities) {
    const reason = probe.disabledReason ?? "model_protocol_selection_required"
    throw new CapabilityProbeNotApplicableError({ providerId: model.providerID, modelId: model.id, disabledReason: reason })
  }
  const protocol = probe.protocol
  const capabilities = probe.capabilities
  const originId = provider ? provider.id : model.providerID
  const endpoint = endpointUrl(model, provider) ?? model.providerID
  return {
    configIdentityHash: configIdentityHash(model, provider),
    providerId: model.providerID,
    modelId: model.id,
    protocol,
    routeId: protocolRouteId(protocol),
    originId,
    endpointRef: contentDigest(endpoint),
    originVersion: contentDigest({ providerId: model.providerID, modelId: model.id, endpoint }),
    capabilityVersion: contentDigest(capabilities),
    loweringVersion: 1,
    capabilities,
    capabilityFingerprint: contentDigest({ hashed: contentDigest(capabilities), protocol }),
    probeRef: probe.probeRef,
    probeResponseFingerprint: probe.probeResponseFingerprint,
    selectionState: resolveModelProtocol(model, provider).selectionState,
  }
}

/** Pure evidence builder: derives the persistent evidence object without touching the cache. */
export function buildCapabilityEvidence(model: ModelV2.Info, provider?: ProviderV2.Info): CapabilityConfigEvidence {
  return evidenceFromProbe(model, provider, probeCapabilities(model, provider))
}

// Module-scoped evidence cache keyed by config identity hash. This is the
// in-process persistence home for the evidence; durable DB persistence in a
// `session_*` table is a C1A/other-lane integration decision (see boundary note).
const evidenceCache = new Map<string, CapabilityConfigEvidence>()

export function getConfigEvidence(configIdentity: string): CapabilityConfigEvidence | undefined {
  return evidenceCache.get(configIdentity)
}

/** Number of cached evidence entries (test/inspection seam). */
export function configEvidenceCount(): number {
  return evidenceCache.size
}

/**
 * BUSINESS-TURN consumption path: look up existing evidence by config identity
 * and NEVER run the probe (design §5.2 "业务 turn 不探测"). A missing entry
 * yields `no_evidence` (an explicit state, never a silent compatible guess) and
 * is a signal that an explicit configuration action must refresh it first.
 */
export function configEvidenceForTurn(
  model: ModelV2.Info,
  provider?: ProviderV2.Info,
): CapabilityConfigEvidence | "no_evidence" {
  return evidenceCache.get(configIdentityHash(model, provider)) ?? "no_evidence"
}

/** Explicit invalidation on config drift: drop the entry for a config identity. */
export function invalidateConfigEvidence(model: ModelV2.Info, provider?: ProviderV2.Info): boolean {
  return evidenceCache.delete(configIdentityHash(model, provider))
}

/** Clear the whole in-process evidence cache (tests / config reload). */
export function clearConfigEvidenceCache(): void {
  evidenceCache.clear()
  configEvidenceCacheResetProbeCallCount()
}

/**
 * EXPLICIT configuration action (the only place the probe hook runs): derive +
 * cache the evidence. This is what a real C2-09/C7-03 live-sentinel probe would
 * invoke; the default hook is the pure declared/derived probe, so refreshing is
 * still side-effect-free in this wave.
 */
export function refreshConfigEvidence(model: ModelV2.Info, provider?: ProviderV2.Info): CapabilityConfigEvidence {
  configProbeCallCount += 1
  const evidence = evidenceFromProbe(model, provider, probeHook(model, provider))
  evidenceCache.set(evidence.configIdentityHash, evidence)
  return evidence
}

/** Injectable probe hook (default = pure derived probe). Test seam injects a counting spy. */
export type ProbeHook = (model: ModelV2.Info, provider?: ProviderV2.Info) => CapabilityProbeResult

let probeHook: ProbeHook = (model, provider) => probeCapabilities(model, provider)
let configProbeCallCount = 0

function configEvidenceCacheResetProbeCallCount() {
  configProbeCallCount = 0
}

export function setProbeHook(hook: ProbeHook): void {
  probeHook = hook
}

export function resetProbeHook(): void {
  probeHook = (model, provider) => probeCapabilities(model, provider)
  configProbeCallCount = 0
}

/** Count of probe-hook invocations through `refreshConfigEvidence`. */
export function probeHookCalls(): number {
  return configProbeCallCount
}

// ===========================================================================
// C2-04 — route/protocol/origin/capability/lowering hash in the attempt identity
// ===========================================================================
//
// design §2.3 + §4.1 step 8: an exact retry keeps the same route; config drift is
// detected BEFORE dispatch. The runtime attempt record (prepared-provider-turn,
// untouched here) is the home for the new identity fields; the frozen contract
// identity field set stays as-is.

/**
 * Build the frozen `ProtocolAttemptIdentity` (route/protocol/origin/capability/
 * lowering) for a resolved model. `endpointOriginHash` is a stable hash of the
 * route-origin binding; `capabilityFingerprint` a stable hash of the resolved
 * capability set (from C2-03 evidence when supplied). Deterministic: identical
 * config -> identical identity.
 */
export function protocolAttemptIdentityFor(
  model: ModelV2.Info,
  provider?: ProviderV2.Info,
  evidence?: CapabilityConfigEvidence,
): Contract.ProtocolAttemptIdentity {
  const selection = resolveModelProtocol(model, provider)
  if (!selection.protocol || selection.selectionState === "disabled") {
    const reason = selection.disabledReason ?? "model_protocol_selection_required"
    throw new CapabilityProbeNotApplicableError({ providerId: model.providerID, modelId: model.id, disabledReason: reason })
  }
  const protocol = selection.protocol
  const routeId = protocolRouteId(protocol)
  const originId = provider ? provider.id : model.providerID
  const endpoint = endpointUrl(model, provider) ?? model.providerID
  const capabilityFingerprint = evidence?.capabilityFingerprint ?? contentDigest({ hashed: contentDigest(selection.capabilities), protocol })
  return {
    protocol,
    routeId,
    originId,
    endpointOriginHash: contentDigest({ endpoint, originId, routeId, protocol, protocolVersion: String(Contract.ModelProtocolVersion.protocol) }),
    capabilityFingerprint,
    loweringVersion: evidence?.loweringVersion ?? 1,
    protocolRevision: Contract.ModelProtocolVersion.protocol,
  }
}

/** Byte-stable hash of a protocol attempt identity. */
export function protocolAttemptIdentityHash(identity: Contract.ProtocolAttemptIdentity): string {
  return Contract.protocolAttemptIdentityDigest(identity)
}

/** Typed failure: config drifted after the attempt identity was bound (design §2.3). */
export class ConfigDriftError extends Schema.TaggedErrorClass<ConfigDriftError>()(
  "ModelProtocol.ConfigDriftError",
  { reason: Schema.Literal("config_drift_rebuild_required") },
) {}

/** Whether the current identity drifts from a previously bound identity hash. */
export function configDrift(current: Contract.ProtocolAttemptIdentity, boundIdentityHash: string): boolean {
  return protocolAttemptIdentityHash(current) !== boundIdentityHash
}

/**
 * Dispatch gate: never dispatch with a mismatched identity. On drift the caller
 * rebuilds the attempt from the CURRENT config and dispatches THAT (the stale
 * attempt produces 0 requests); on no drift the stored attempt dispatches as-is
 * (an exact retry keeps the same route). `dispatch` returns the request count so
 * a counting transport can assert exactly which attempt went to the wire.
 */
export function dispatchGuarded<Request>(input: {
  readonly current: Contract.ProtocolAttemptIdentity
  readonly storedIdentityHash: string
  readonly storedAttempt: Request
  readonly rebuildAttempt: (identity: Contract.ProtocolAttemptIdentity) => Request
  readonly dispatch: (request: Request) => number
}): { readonly action: "dispatch" | "rebuild"; readonly requests: number } {
  if (!configDrift(input.current, input.storedIdentityHash)) {
    return { action: "dispatch", requests: input.dispatch(input.storedAttempt) }
  }
  const rebuilt = input.rebuildAttempt(input.current)
  return { action: "rebuild", requests: input.dispatch(rebuilt) }
}

