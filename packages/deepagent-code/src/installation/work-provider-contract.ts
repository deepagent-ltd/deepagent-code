import { Effect, Layer } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorkRouteApproval } from "@deepagent-code/core/session/work-route-approval"
import { NativeInstallation } from "./native-installation"
import { ProviderCredentialBinding } from "./provider-credential-binding"
import { VendorContextBound } from "@deepagent-code/llm/route"
import type { NativeRuntime } from "./native-runtime"
import type { WorkRouteApprovalSchema } from "@deepagent-code/core/session/work-route-approval.schema"

// Reviewed external semantics, not inferred from a model-name suffix or an API response.
// Input counting: https://developers.openai.com/api/docs/guides/token-counting
// Completion includes visible and reasoning output: https://developers.openai.com/api/reference/python/resources/responses/methods/create
// This original OpenAI exact-count entry relies on its immutable vendor snapshot contract,
// not a provider binary hash. The separate DeepSeek entry explicitly supports a vendor alias
// with a reviewed hard context cap; it never inherits the exact-count or snapshot claim.
const reviewed = Object.freeze({
  id: "openai-responses-project-count-v2",
  inputProjection: "exact-system-user-history-function-tools-v2",
  providerID: "openai",
  modelID: "gpt-4.1-2025-04-14",
  modelRevision: "openai:gpt-4.1-2025-04-14",
  endpoint: "https://api.openai.com/v1/responses",
  counterEndpoint: "https://api.openai.com/v1/responses/input_tokens",
  tokenizerIdentity: "openai:gpt-4.1-2025-04-14:responses-input-tokens-v1",
  completionLimit: 32_768,
})
const adapters = Object.freeze([
  { providerID: reviewed.providerID, modelID: reviewed.modelID, adapterID: "openai-responses" },
  { providerID: VendorContextBound.DEEPSEEK_FLASH.providerID, modelID: VendorContextBound.DEEPSEEK_FLASH.modelID,
    adapterID: "openai-compatible-responses" },
])

/** Fixed provider/model families, not an adapter allowlist. The original approved
 * evidence and actual Native configuration must agree on every durable identity. */
export function runtimeMismatch(
  evidence: Pick<WorkRouteApprovalSchema.Evidence, "providerID" | "modelID" | "protocol" | "configurationStamp" | "configuredTargetStamp">,
  actual: Pick<Effect.Success<ReturnType<NativeRuntime.Interface["configuration"]>>,
    "providerID" | "modelID" | "adapterID" | "protocol" | "configurationStamp" | "configuredTargetStamp">,
) {
  const contract = adapters.find((entry) => entry.providerID === evidence.providerID && entry.modelID === evidence.modelID)
  return [
    ...(!contract ? ["contract" as const] : []),
    ...(actual.providerID !== evidence.providerID ? ["providerID" as const] : []),
    ...(actual.modelID !== evidence.modelID ? ["modelID" as const] : []),
    ...(actual.adapterID !== contract?.adapterID ? ["adapterID" as const] : []),
    ...(actual.protocol !== "openai-responses" || actual.protocol !== evidence.protocol ? ["protocol" as const] : []),
    ...(actual.configurationStamp !== evidence.configurationStamp ? ["configurationStamp" as const] : []),
    ...(actual.configuredTargetStamp !== evidence.configuredTargetStamp ? ["configuredTargetStamp" as const] : []),
  ]
}

/** Runtime route IDs name the reviewed lowering adapter, not the configured approval ID.
 * Native observation independently compares this same fixed family with the resolved route. */
export function projectRuntime(evidence: Pick<WorkRouteApprovalSchema.Evidence,
  "providerID" | "modelID" | "modelRevision" | "protocol" | "configurationStamp" | "adapterHash" | "loweringHash" | "framingHash">) {
  const contract = adapters.find((entry) => entry.providerID === evidence.providerID && entry.modelID === evidence.modelID)
  if (!contract || evidence.protocol !== "openai-responses") return undefined
  return { providerID: evidence.providerID, routeID: contract.adapterID, modelID: evidence.modelID,
    modelRevision: evidence.modelRevision, protocol: evidence.protocol, transport: "http-json" as const,
    configurationHash: evidence.configurationStamp, adapterHash: evidence.adapterHash,
    loweringHash: evidence.loweringHash, framingHash: evidence.framingHash }
}
const components = Object.freeze([
  "packages/deepagent-code/src/installation/work-provider-contract.ts",
  "packages/deepagent-code/src/installation/work-execution-profile.ts",
  "packages/deepagent-code/src/installation/native-route-capture.ts",
  "packages/deepagent-code/src/installation/native-runtime.ts",
  "packages/deepagent-code/src/installation/provider-credential-binding.ts",
  "packages/core/src/session/work-route-policy.ts",
  "packages/core/src/session/runner/restricted-work-turn.ts",
  "packages/core/src/session/work-tool-policy.ts",
  "packages/core/src/tool/read.ts",
  "packages/deepagent-code/src/installation/work-file-helper.ts",
  "packages/deepagent-code/src/installation/work-leaf-proof.ts",
  "packages/llm/src/route/client.ts",
  "packages/llm/src/route/index.ts",
  "packages/llm/src/route/vendor-context-bound.ts",
  "packages/llm/src/route/executor.ts",
  "packages/llm/src/route/auth.ts",
  "packages/llm/src/route/endpoint.ts",
  "packages/llm/src/route/transport/http.ts",
  "packages/llm/src/route/framing.ts",
  "packages/llm/src/protocols/openai-responses.ts",
])

/** Verified once when the production root is constructed, outside SQL. A native request also
 * checks the actual installation again before and after its final seal. */
export const contracts = Effect.gen(function* () {
  const installation = yield* NativeInstallation.current().pipe(Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")))
  const description = yield* NativeInstallation.describe(installation).pipe(Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")))
  const inventory = yield* NativeInstallation.inventory(installation).pipe(Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")))
  if (components.some((path) => !inventory.some((entry) => entry.path === path)))
    return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
  const selected = components.map((path) => inventory.find((entry) => entry.path === path)!)
  const component = (path: string) => selected.find((entry) => entry.path === path)!.sha256
  return [reviewed, { ...VendorContextBound.DEEPSEEK_FLASH,
    counterSemantics: VendorContextBound.DEEPSEEK_FLASH.semantics,
    inputUpperBoundTokens: VendorContextBound.DEEPSEEK_FLASH.inputUpperBound }].map((reviewed) => Object.freeze({
    ...reviewed,
    adapterID: adapters.find((entry) => entry.providerID === reviewed.providerID && entry.modelID === reviewed.modelID)!.adapterID,
    installation: description,
    contractID: reviewed.id,
    contractHash: Hash.sha256(CanonicalJson.stringify({ reviewed, components: selected })),
    factoryHash: component("packages/llm/src/route/client.ts"),
    adapterHash: component("packages/llm/src/route/transport/http.ts"),
    loweringHash: component("packages/llm/src/protocols/openai-responses.ts"),
    framingHash: component("packages/llm/src/route/framing.ts"),
  }))
})
// Retain the original descriptor port for legacy callers; current selection is explicit.
export const current = contracts.pipe(Effect.map((values) => values[0]!))
export const forModel = (modelID: string) => contracts.pipe(Effect.flatMap((values) => {
  const selected = values.filter((value) => value.modelID === modelID)
  return selected.length === 1 ? Effect.succeed(selected[0]!) : Effect.fail(WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE"))
}))

/** Source-mode/unverified releases have no contract. Does not grant source or network authority. */
export const layer = Layer.succeed(ProviderCredentialBinding.Contract, {
  resolve: (actual, input) => Effect.gen(function* () {
    const contract = yield* forModel(actual.modelID)
    if (actual.protocol !== "openai-responses" || actual.providerID !== contract.providerID ||
      actual.modelID !== contract.modelID || input.snapshot !== contract.modelID ||
      actual.endpoint !== contract.endpoint || input.expiresAt <= Date.now() ||
      CanonicalJson.stringify(contract.installation) !== CanonicalJson.stringify(actual.installation))
      return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
    return contract
  }),
})

export * as WorkProviderContract from "./work-provider-contract"
