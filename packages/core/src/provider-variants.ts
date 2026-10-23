import { iife } from "./util/iife"

export type Model = {
  id: string
  providerID: string
  api: { id: string; npm: string }
  capabilities: { reasoning: boolean }
  limit: { output: number }
  release_date: string
}

export type Options = Record<string, unknown>

export const ENCRYPTED_REASONING = ["reasoning.encrypted_content"] as const

export function deepseek(modelID: string) {
  return /(?:^|\/)deepseek-(?:flash$|v4(?:[.-]|$))/.test(modelID.toLowerCase())
}

/** Normalize an explicit layer before it is merged with generated defaults. */
export function normalizeDeepSeekOptions(modelID: string, packageName: string | undefined, input: Options) {
  if (packageName !== "@ai-sdk/openai-compatible" || !deepseek(modelID)) return input
  const thinking =
    typeof input.thinking === "object" && input.thinking !== null && !Array.isArray(input.thinking)
      ? (input.thinking as Record<string, unknown>)
      : {}
  const effort = input.reasoningEffort ?? input.reasoning_effort
  // A deliberately disabled toggle wins contradictory controls in one layer.
  const disabled = thinking.type === "disabled" || effort === "none"
  if (!disabled && thinking.type !== "enabled" && !["low", "high", "max"].includes(String(effort))) return input
  return {
    ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "reasoning_effort")),
    reasoningEffort: disabled ? "none" : (effort ?? "high"),
    thinking: { ...thinking, type: disabled ? "disabled" : "enabled" },
  }
}

function glm52(model: Model) {
  const id = model.id.toLowerCase()
  const apiID = model.api.id.toLowerCase()
  return ["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => id.includes(name) || apiID.includes(name))
}

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_1_EFFORTS = ["none", ...WIDELY_SUPPORTED_EFFORTS]
const OPENAI_GPT5_2_PLUS_EFFORTS = [...OPENAI_GPT5_1_EFFORTS, "xhigh"]
const OPENAI_GPT5_PRO_EFFORTS = ["high"]
const OPENAI_GPT5_PRO_2_PLUS_EFFORTS = ["medium", "high", "xhigh"]
const OPENAI_GPT5_CHAT_EFFORTS = ["medium"]
const OPENAI_GPT5_CODEX_XHIGH_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_CODEX_3_PLUS_EFFORTS = ["none", ...OPENAI_GPT5_CODEX_XHIGH_EFFORTS]

// OpenAI rolled out the `none` reasoning_effort tier on this date (Responses API).
// Models released before it 400 on `reasoning_effort: "none"`, so we only expose
// it as a variant for models new enough to accept it.
const OPENAI_NONE_EFFORT_RELEASE_DATE = "2025-11-13"

// OpenAI rolled out the `xhigh` reasoning_effort tier on this date. Same reasoning.
const OPENAI_XHIGH_EFFORT_RELEASE_DATE = "2025-12-04"

// Matches members of the gpt-5 family across the id formats we encounter:
//   "gpt-5", "gpt-5-nano", "gpt-5.4", "openai/gpt-5.4-codex".
// Anchored to start-of-string or "/" so it doesn't false-match "gpt-50" or "gpt-5o".
const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/
const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

function gpt5Version(apiId: string) {
  return Number(GPT5_VERSION_RE.exec(apiId)?.[1]) || undefined
}

function versionedGpt5ReasoningEfforts(apiId: string) {
  if (GPT5_VERSIONED_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_2_PLUS_EFFORTS
  const version = gpt5Version(apiId)
  if (version === undefined) return undefined
  if (version === 1) return OPENAI_GPT5_1_EFFORTS
  return OPENAI_GPT5_2_PLUS_EFFORTS
}

function gpt5CodexReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("codex")) return undefined
  const version = gpt5Version(apiId)
  if (version !== undefined && version >= 3) return OPENAI_GPT5_CODEX_3_PLUS_EFFORTS
  if (apiId.includes("codex-max") || (version !== undefined && version >= 2)) return OPENAI_GPT5_CODEX_XHIGH_EFFORTS
  return WIDELY_SUPPORTED_EFFORTS
}

function gpt5ChatReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("-chat")) return undefined
  return gpt5Version(apiId) === undefined ? [] : OPENAI_GPT5_CHAT_EFFORTS
}

// Computes the reasoning_effort tiers an OpenAI (or OpenAI-compatible upstream
// routed through it, e.g. cf-ai-gateway) model exposes. Effort order: weakest
// to strongest.
function openaiReasoningEfforts(apiId: string, releaseDate: string) {
  const id = apiId.toLowerCase()
  if (id.includes("deep-research")) return ["medium"]
  const chatEfforts = gpt5ChatReasoningEfforts(id)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
  const codexEfforts = gpt5CodexReasoningEfforts(id)
  if (codexEfforts) return codexEfforts
  const versionedEfforts = versionedGpt5ReasoningEfforts(id)
  // GPT-5.1 replaced GPT-5's `minimal` effort with `none`; GPT-5.2+
  // additionally accepts `xhigh`. Model pages list the supported subset.
  if (versionedEfforts) return versionedEfforts
  const efforts = [...WIDELY_SUPPORTED_EFFORTS]
  if (GPT5_FAMILY_RE.test(id)) efforts.unshift("minimal")
  if (releaseDate >= OPENAI_NONE_EFFORT_RELEASE_DATE) efforts.unshift("none")
  if (releaseDate >= OPENAI_XHIGH_EFFORT_RELEASE_DATE) efforts.push("xhigh")
  return efforts
}

function openaiCompatibleReasoningEfforts(id: string) {
  const apiId = id.toLowerCase()
  const chatEfforts = gpt5ChatReasoningEfforts(apiId)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_EFFORTS
  return gpt5CodexReasoningEfforts(apiId) ?? versionedGpt5ReasoningEfforts(apiId) ?? OPENAI_EFFORTS
}

function anthropicOpus47OrLater(apiId: string) {
  // Matches "opus-4.7" / "opus-5" (Anthropic/Bedrock/Vertex) and
  // "claude-4.7-opus" / "claude-5-opus" (SAP AI Core inverted).
  // Greedy \d+ correctly extends to multi-digit majors (e.g. "claude-10.0-opus") for forward compatibility.
  const version = /opus-(\d+)(?:[.-](\d+))?(?:[.@-]|$)|claude-(\d+)(?:[.-](\d+))?-opus(?:[.@-]|$)/i.exec(apiId)
  if (!version) return false
  const major = Number(version[1] ?? version[3])
  const minor = Number(version[2] ?? version[4] ?? 0)
  return major > 4 || (major === 4 && minor >= 7)
}

// Matches "fable-5", "claude-fable-5", "claude-fable-5-20260720", etc.
// Fable 5 supports the full adaptive thinking effort set (same as Opus 4.7+).
function anthropicFable5OrLater(apiId: string) {
  const m = /fable[._-]?(\d+)/i.exec(apiId)
  return m !== null && Number(m[1]) >= 5
}

function anthropicFullAdaptive(apiId: string) {
  return (
    anthropicOpus47OrLater(apiId) ||
    anthropicFable5OrLater(apiId) ||
    /(?:^|[./_-])(?:sonnet[._-]5|haiku[._-]5[._-]5|mythos[._-](?:preview|5))(?:[.@_-]|$)/i.test(apiId)
  )
}

function anthropicAdaptiveEfforts(apiId: string): string[] | null {
  // Current Claude 5 families use adaptive thinking, not manual token budgets.
  if (anthropicFullAdaptive(apiId)) {
    return ["low", "medium", "high", "xhigh", "max"]
  }
  if (
    ["opus-4-6", "opus-4.6", "4-6-opus", "4.6-opus", "sonnet-4-6", "sonnet-4.6", "4-6-sonnet", "4.6-sonnet"].some((v) =>
      apiId.includes(v),
    )
  ) {
    return ["low", "medium", "high", "max"]
  }
  return null
}

function googleThinkingLevelEfforts(apiId: string) {
  const id = apiId.toLowerCase()
  if (!id.includes("gemini-3")) return ["low", "high"]
  if (id.includes("flash-image")) return ["minimal", "high"]
  if (id.includes("pro-image")) return ["high"]
  if (id.includes("flash")) return ["minimal", "low", "medium", "high"]
  return ["low", "medium", "high"]
}

function googleThinkingBudgetMax(apiId: string) {
  const id = apiId.toLowerCase()
  if (id.includes("2.5") && id.includes("pro") && !id.includes("flash")) return 32_768
  return 24_576
}

// SAP's Zod schema drops unknown top-level keys; reasoning controls survive
// only via `modelParams` (catchall), forwarded verbatim by the SAP SDKs.
function wrapInSapModelParams(variants: Record<string, Options>): Record<string, Options> {
  return Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, { modelParams: v }]))
}

function googleThinkingVariants(model: Model): Record<string, Options> {
  const id = model.api.id.toLowerCase()
  if (id.includes("2.5")) {
    return {
      high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
      max: {
        thinkingConfig: { includeThoughts: true, thinkingBudget: googleThinkingBudgetMax(id) },
      },
    }
  }
  return Object.fromEntries(
    googleThinkingLevelEfforts(id).map((effort) => [
      effort,
      { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } },
    ]),
  )
}

export function variants(model: Model): Record<string, Options> {
  if (!model.capabilities.reasoning) return {}

  const id = model.id.toLowerCase()
  // Modern Claude families omit thinking text by default; request summaries for the UI.
  const adaptiveOpus = anthropicFullAdaptive(model.api.id)
  const adaptiveEfforts = anthropicAdaptiveEfforts(model.api.id)
  if (glm52(model)) {
    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      return {
        high: { reasoning: { effort: "high" } },
        xhigh: { reasoning: { effort: "xhigh" } },
      }
    }
    if (model.api.npm === "@ai-sdk/openai-compatible") {
      // Aligned with upstream: GLM-5.2 on the openai-compatible protocol exposes high/max thinking
      // tiers on every Zhipu/Z.AI face (plain pay-as-you-go AND coding-plan), not just coding-plan.
      return {
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      }
    }
    if (model.api.npm === "@ai-sdk/anthropic") {
      return {
        high: { effort: "high" },
        max: { effort: "max" },
      }
    }
    return {}
  }
  if (
    id.includes("deepseek-chat") ||
    id.includes("deepseek-reasoner") ||
    id.includes("deepseek-r1") ||
    id.includes("deepseek-v3") ||
    id.includes("minimax") ||
    (id.includes("glm") && !glm52(model)) ||
    id.includes("kimi") ||
    id.includes("k2p") ||
    id.includes("qwen") ||
    id.includes("big-pickle")
  )
    return {}

  // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
  if (id.includes("grok") && id.includes("grok-3-mini")) {
    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      return {
        low: { reasoning: { effort: "low" } },
        high: { reasoning: { effort: "high" } },
      }
    }
    return {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    }
  }
  if (id.includes("grok")) return {}

  switch (model.api.npm) {
    case "@openrouter/ai-sdk-provider":
      if (!id.includes("gpt") && !id.includes("gemini-3") && !id.includes("claude")) return {}
      return Object.fromEntries(
        (id.includes("gpt") ? openaiCompatibleReasoningEfforts(id) : OPENAI_EFFORTS).map((effort) => [
          effort,
          { reasoning: { effort } },
        ]),
      )

    case "ai-gateway-provider": {
      // Cloudflare AI Gateway routes every upstream through its OpenAI-compatible
      // /v1/compat endpoint, so the body is always OAI-shaped. The gateway
      // translates `reasoning_effort` to the upstream provider's native control
      // (e.g. Anthropic thinking budgets) when needed. Variants therefore stay
      // OAI-style for all upstreams, with an extended effort set for OpenAI
      // models that support it.
      if (model.api.id.startsWith("openai/")) {
        const efforts = openaiReasoningEfforts(model.api.id, model.release_date)
        return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
    }

    case "@ai-sdk/gateway":
      if (model.id.includes("anthropic")) {
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                  // Opus 4.7+ flips the API default for `display` to "omitted", which
                  // returns empty thinking blocks. Force "summarized" so summaries
                  // survive (4.6/Sonnet 4.6 already default to "summarized").
                  ...(adaptiveOpus ? { display: "summarized" } : {}),
                },
                effort,
              },
            ]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }
      if (model.id.includes("google")) {
        if (id.includes("2.5")) {
          return {
            high: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 16000,
              },
            },
            max: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: googleThinkingBudgetMax(id),
              },
            },
          }
        }
        return Object.fromEntries(
          ["low", "high"].map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )
      }
      return Object.fromEntries(
        openaiCompatibleReasoningEfforts(model.api.id).map((effort) => [effort, { reasoningEffort: effort }]),
      )

    case "@ai-sdk/github-copilot":
      if (model.id.includes("gemini")) {
        // currently github copilot only returns thinking
        return {}
      }
      if (model.id.includes("claude")) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      const copilotEfforts = iife(() => {
        if (id.includes("5.1-codex-max") || id.includes("5.2") || id.includes("5.3"))
          return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
        const arr = [...WIDELY_SUPPORTED_EFFORTS]
        if (id.includes("gpt-5") && model.release_date >= "2025-12-04") arr.push("xhigh")
        return arr
      })
      return Object.fromEntries(
        copilotEfforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ENCRYPTED_REASONING,
          },
        ]),
      )

    case "@ai-sdk/cerebras":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
    case "@ai-sdk/togetherai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
    case "@ai-sdk/xai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
    case "@ai-sdk/deepinfra":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
    case "venice-ai-sdk-provider":
    // https://docs.venice.ai/overview/guides/reasoning-models#reasoning-effort
    case "@ai-sdk/openai-compatible": {
      const apiId = model.api.id.toLowerCase()

      // DeepSeek's current official alias omits the V4 family name. Keep the
      // thinking toggle consistent with the effort after caller options merge.
      // https://api-docs.deepseek.com/api/create-chat-completion/
      if (model.api.npm === "@ai-sdk/openai-compatible" && deepseek(apiId)) {
        return Object.fromEntries(
          ["none", "low", "high", "max"].map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              thinking: { type: effort === "none" ? "disabled" : "enabled" },
            },
          ]),
        )
      }

      // Anthropic models (Claude family) routed through an openai-compatible gateway — the gateway
      // translates OpenAI-shaped `reasoningEffort` to Anthropic's native thinking API. Use the same
      // adaptive effort set as the direct @ai-sdk/anthropic path (including xhigh for Opus 4.7+ and
      // Fable 5+), expressed as `reasoningEffort` so the gateway can forward it correctly.
      if (adaptiveEfforts && /\bclaude\b/i.test(apiId)) {
        return Object.fromEntries(adaptiveEfforts.map((effort) => [effort, { reasoningEffort: effort }]))
      }

      // GPT-5.x versioned models support extended effort tiers (xhigh from v5.2+). Strip `none` and
      // `minimal` — those are Responses-API-only tiers that openai-compatible endpoints do not
      // implement, so exposing them would produce 400 errors on most third-party gateways.
      if (GPT5_FAMILY_RE.test(apiId)) {
        const openaiCompatEfforts = openaiCompatibleReasoningEfforts(apiId).filter(
          (e) => e !== "none" && e !== "minimal",
        )
        return Object.fromEntries(openaiCompatEfforts.map((effort) => [effort, { reasoningEffort: effort }]))
      }

      const efforts = [...WIDELY_SUPPORTED_EFFORTS]
      if (apiId.includes("deepseek-v4")) {
        efforts.push("max")
      }
      return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
    }

    case "@ai-sdk/azure":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
      if (id === "o1-mini") return {}
      return Object.fromEntries(
        openaiReasoningEfforts(id, model.release_date).map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ENCRYPTED_REASONING,
          },
        ]),
      )
    case "@ai-sdk/amazon-bedrock/mantle":
    case "@ai-sdk/openai": {
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
      const efforts = openaiReasoningEfforts(model.api.id, model.release_date)
      return Object.fromEntries(
        efforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ENCRYPTED_REASONING,
          },
        ]),
      )
    }

    case "@ai-sdk/anthropic":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
    case "@ai-sdk/google-vertex/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider
      if (adaptiveEfforts) {
        let efforts = [...adaptiveEfforts]
        if (model.providerID === "github-copilot") {
          if (model.api.id.includes("opus-4.7")) {
            efforts = ["medium"]
          }
          // Efforts currently supported are: low, medium, high
          efforts = efforts.filter((v) => v !== "max" && v !== "xhigh")
        }
        return Object.fromEntries(
          efforts.map((effort) => [
            effort,
            {
              thinking: {
                type: "adaptive",
                ...(adaptiveOpus ? { display: "summarized" } : {}),
              },
              effort,
            },
          ]),
        )
      }

      if (["opus-4-5", "opus-4.5"].some((v) => model.api.id.includes(v))) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { effort }]))
      }

      return {
        high: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
          },
        },
        max: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(31_999, model.limit.output - 1),
          },
        },
      }

    case "@ai-sdk/amazon-bedrock":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
      if (adaptiveEfforts) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "adaptive",
                maxReasoningEffort: effort,
                ...(adaptiveOpus ? { display: "summarized" } : {}),
              },
            },
          ]),
        )
      }
      // For Anthropic models on Bedrock, use reasoningConfig with budgetTokens
      if (model.api.id.includes("anthropic")) {
        return {
          high: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }

      // For Amazon Nova models, use reasoningConfig with maxReasoningEffort
      return Object.fromEntries(
        WIDELY_SUPPORTED_EFFORTS.map((effort) => [
          effort,
          {
            reasoningConfig: {
              type: "enabled",
              maxReasoningEffort: effort,
            },
          },
        ]),
      )

    case "@ai-sdk/google-vertex":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
    case "@ai-sdk/google":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
      return googleThinkingVariants(model)

    case "@ai-sdk/mistral":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
      // https://docs.mistral.ai/capabilities/reasoning/adjustable
      if (!model.capabilities.reasoning) return {}
      // Only Mistral Small 4 and Medium 3.5 support reasoning
      const MISTRAL_REASONING_IDS = [
        "mistral-small-2603",
        "mistral-small-latest",
        "mistral-medium-3.5",
        "mistral-medium-2604",
      ]
      const mistralId = model.api.id.toLowerCase()
      if (!MISTRAL_REASONING_IDS.some((id) => mistralId.includes(id))) return {}
      return {
        high: { reasoningEffort: "high" },
      }

    case "@ai-sdk/cohere":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
      return {}

    case "@ai-sdk/groq":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
      const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
      return Object.fromEntries(
        groqEffort.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
          },
        ]),
      )

    case "@ai-sdk/perplexity":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
      return {}

    case "@jerome-benoit/sap-ai-provider-v2": {
      if (id.includes("anthropic")) {
        if (adaptiveEfforts) {
          // Bedrock adaptive splits `effort` out into `output_config` (vs Anthropic
          // native which inlines it). Opus 4.7+ flipped `display` default to "omitted".
          return wrapInSapModelParams(
            Object.fromEntries(
              adaptiveEfforts.map((effort) => [
                effort,
                {
                  thinking: { type: "adaptive", ...(adaptiveOpus ? { display: "summarized" } : {}) },
                  output_config: { effort },
                },
              ]),
            ),
          )
        }
        return wrapInSapModelParams({
          high: { thinking: { type: "enabled", budget_tokens: 16000 } },
          max: { thinking: { type: "enabled", budget_tokens: 31999 } },
        })
      }
      if (id.includes("gemini") && id.includes("2.5")) {
        return wrapInSapModelParams(googleThinkingVariants(model))
      }
      if (id.includes("gpt") || /\bo[1-9]/.test(id)) {
        const efforts = openaiReasoningEfforts(id, model.release_date)
        return wrapInSapModelParams(Object.fromEntries(efforts.map((effort) => [effort, { reasoning_effort: effort }])))
      }
      return wrapInSapModelParams(
        Object.fromEntries(["low", "medium", "high"].map((effort) => [effort, { reasoning_effort: effort }])),
      )
    }
  }
  return {}
}

export * as ProviderVariants from "./provider-variants"
