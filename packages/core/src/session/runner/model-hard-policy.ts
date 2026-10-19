export * as ModelHardPolicy from "./model-hard-policy"

import { ConfigCompaction } from "../../config/compaction"

export type Pricing =
  | { readonly state: "unknown" }
  | { readonly state: "flat"; readonly source: string }
  | { readonly state: "tiered"; readonly inputLimit: number; readonly inclusive: boolean; readonly source: string }

/** Exact API identities and documented endpoint scopes; aliases on an unknown gateway do not prove its prices. */
export function pricingLookup(input: {
  readonly providerID: string
  readonly apiModelID: string
  readonly endpointOrigin?: string
  readonly deploymentScope?: string
}): Pricing {
  const id = input.apiModelID
  const host = input.endpointOrigin ? URL.parse(input.endpointOrigin)?.hostname : undefined
  const official = (providers: readonly string[], hosts: readonly string[]) =>
    providers.includes(input.providerID) &&
    (input.endpointOrigin === undefined || (host !== undefined && hosts.includes(host)))
  const tier = (inputLimit: number, inclusive: boolean, source: string): Pricing => ({
    state: "tiered",
    inputLimit,
    inclusive,
    source,
  })
  if (
    official(["openai"], ["api.openai.com"]) &&
    /^(?:gpt-6\.1-sol|gpt-6-(?:sol|astra|luna)|gpt-5\.6-(?:sol|terra|luna)|gpt-5\.4(?:-pro)?|gpt-5\.5)(?:-\d{4}-\d{2}-\d{2})?$/.test(
      id,
    )
  )
    return tier(272_000, true, "https://developers.openai.com/api/docs/pricing")
  if (
    official(["xai"], ["api.x.ai"]) &&
    [
      "grok-4.7",
      "grok-build-0.1",
      "grok-4.6",
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-multi-agent-0309",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
    ].includes(id)
  )
    return tier(200_000, false, "https://docs.x.ai/developers/pricing")
  if (official(["anthropic"], ["api.anthropic.com"])) {
    if (/^claude-haiku-5-5(?:-|$)/.test(id))
      return tier(100_000, true, "https://platform.claude.com/docs/en/about-claude/pricing")
    if (/^claude-(?:opus-(?:5-5|5|4-[678])|sonnet-(?:5-5|5|4-6)|fable-5-1)(?:-\d{8})?$/.test(id))
      return { state: "flat", source: "https://platform.claude.com/docs/en/about-claude/pricing" }
  }
  if (official(["google"], ["generativelanguage.googleapis.com"])) {
    if (["gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools", "gemini-2.5-pro"].includes(id))
      return tier(200_000, true, "https://ai.google.dev/gemini-api/docs/pricing")
    if (["gemini-4-argon", "gemini-3.8-flash"].includes(id))
      return { state: "flat", source: "https://ai.google.dev/gemini-api/docs/pricing" }
  }
  if (
    official(
      ["alibaba", "qwen"],
      ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"],
    )
  ) {
    const source = "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    if (["qwen3.8-max", "qwen3.8-max-0902", "qwen3.8-flash"].includes(id)) return { state: "flat", source }
    if (
      ["qwen3.7-plus", "qwen3.7-plus-2026-05-26"].includes(id) &&
      ["international", "us", "eu", "hongkong"].includes(input.deploymentScope ?? "")
    )
      return tier(256_000, true, source)
    if (["qwen3.7-flash", "qwen3.7-flash-2026-07-15", "qwen3-coder-flash", "qwen3-coder-flash-2025-07-28"].includes(id))
      return tier(32_000, true, source)
    if (["qwen-plus", "qwen-plus-latest", "qwen-plus-2025-12-01"].includes(id)) {
      if (input.deploymentScope === "global") return tier(128_000, true, source)
      if (["international", "us", "eu", "hongkong"].includes(input.deploymentScope ?? ""))
        return tier(256_000, true, source)
    }
  }
  return { state: "unknown" }
}

export type PolicyKey = "default" | "gpt" | "deepseek" | "deepseek-v4-pro" | "deepseek-v4-flash" | "kimi-k3" | "glm-5.2"

export type Decision =
  | { readonly state: "unmanaged"; readonly reason: "model_not_registered" }
  | { readonly state: "unavailable"; readonly reason: "context_limit_unknown" | "context_limit_invalid" }
  | {
      readonly state: "managed"
      readonly key: PolicyKey
      readonly version: 1 | 2
      readonly match: "api_model_id" | "runtime_model_id"
      readonly mode: ConfigCompaction.Mode
      readonly summaryOutputLimit: number
      readonly observationLine: number
      readonly hardGate: number
      readonly effectiveObservationLine: number
      readonly effectiveHardGate: number
      readonly policyInputLimit: number
      readonly physicalInputBudget: number
      readonly pricing: Pricing
      readonly limitProvenance: "model_limit" | "host_guard"
      readonly safetyMargin: number
      readonly limitMismatch: boolean
      readonly action: "normal" | "observed" | "hard_gate_compact" | "hard_gate_blocked"
    }

/** Policy lines are engineering defaults, never a claim of provider capacity or guaranteed recall. */
export function decide(input: {
  readonly providerID: string
  readonly runtimeModelID: string
  readonly apiModelID?: string
  readonly endpointOrigin?: string
  readonly mode?: ConfigCompaction.Mode
  readonly bufferTokens?: number
  readonly pricing?: Pricing
  readonly summaryInputBudget?: number
  readonly physicalInputBudget: number
  readonly limitProvenance?: "model_limit" | "host_guard"
  readonly safetyMargin?: number
  readonly estimatedFullRequestTokens: number
  readonly autoCompact: boolean
}): Decision {
  if (!Number.isFinite(input.physicalInputBudget) || input.physicalInputBudget < 0)
    return { state: "unavailable", reason: "context_limit_invalid" }
  if (input.physicalInputBudget === 0) return { state: "unavailable", reason: "context_limit_unknown" }
  const id = input.apiModelID ?? input.runtimeModelID
  const mode = input.mode ?? "adaptive"
  const key: PolicyKey = id.startsWith("gpt-")
    ? "gpt"
    : id === "deepseek-v4-pro"
      ? "deepseek-v4-pro"
      : id === "deepseek-flash"
        ? "deepseek-v4-flash"
        : id.startsWith("deepseek-")
          ? "deepseek"
          : id === "kimi-k3"
            ? "kimi-k3"
            : id === "glm-5.2"
              ? "glm-5.2"
              : "default"
  const hardGate =
    mode === "extreme"
      ? input.physicalInputBudget
      : key === "gpt"
        ? 272_000
        : id.startsWith("deepseek-")
          ? mode === "long"
            ? 768_000
            : 384_000
          : mode === "long"
            ? 512_000
            : 256_000
  const pricing = input.pricing ?? pricingLookup({ ...input, apiModelID: id })
  const policyInputLimit = Math.min(
    hardGate,
    input.physicalInputBudget,
    input.summaryInputBudget ?? input.physicalInputBudget,
    mode !== "extreme" && pricing.state === "tiered" ? pricing.inputLimit - (pricing.inclusive ? 0 : 1) : Infinity,
  )
  const headroom = Math.max(0, Math.floor(input.bufferTokens ?? 2_048))
  const effectiveHardGate = Math.max(0, policyInputLimit - headroom)
  const effectiveObservationLine = Math.max(0, effectiveHardGate - headroom)
  return {
    state: "managed",
    key,
    version: 2,
    match: input.apiModelID ? "api_model_id" : "runtime_model_id",
    mode,
    summaryOutputLimit: ConfigCompaction.SummaryTokens[mode],
    observationLine: effectiveObservationLine,
    hardGate,
    effectiveObservationLine,
    effectiveHardGate,
    policyInputLimit,
    physicalInputBudget: input.physicalInputBudget,
    pricing,
    limitProvenance: input.limitProvenance ?? "model_limit",
    safetyMargin: input.safetyMargin ?? 0,
    limitMismatch: policyInputLimit < hardGate,
    action:
      input.estimatedFullRequestTokens >= effectiveHardGate
        ? input.autoCompact
          ? "hard_gate_compact"
          : "hard_gate_blocked"
        : input.estimatedFullRequestTokens >= effectiveObservationLine
          ? "observed"
          : "normal",
  }
}
