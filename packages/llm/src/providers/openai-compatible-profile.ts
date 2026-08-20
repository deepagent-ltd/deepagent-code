export interface OpenAICompatibleProfile {
  readonly provider: string
  readonly baseURL: string
  /**
   * The family also serves the OpenAI Responses API (`/responses`). Route
   * selection branches to the Responses route only when this is true;
   * everyone else defaults to the Chat route.
   */
  readonly supportsResponses?: boolean
  /**
   * UPD-005: the family also serves the OpenAI-specific UNARY
   * `/responses/compact` endpoint. Defaults to false — never assumed for
   * compatible families without verified support. Canonical OpenAI and DeepSeek
   * serve it (user-verified 2026-08-18); every other family stays on local
   * summarization.
   */
  readonly supportsResponsesCompact?: boolean
  /**
   * UPD-002: the family honors the Responses API `text.format` json_schema
   * (wire-level structured output). This is the CANONICAL capability
   * declaration for wire structured output — independent of `supportsResponses`
   * (a Responses-capable family may still lack constrained text output, so it
   * is NEVER assumed from Responses support). Defaults to false; opt in per
   * family only with verified support. No compatible family advertises it
   * today: deepseek serves Responses but NOT constrained `text.format`.
   */
  readonly supportsStructuredTextFormat?: boolean
}

export const profiles = {
  baseten: { provider: "baseten", baseURL: "https://inference.baseten.co/v1" },
  cerebras: { provider: "cerebras", baseURL: "https://api.cerebras.ai/v1" },
  deepinfra: { provider: "deepinfra", baseURL: "https://api.deepinfra.com/v1/openai" },
  deepseek: {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    supportsResponses: true,
    // UPD-005: DeepSeek 官方 API 支持 Responses 的 /responses/compact(用户 2026-08-18 确认)。
    supportsResponsesCompact: true,
  },
  fireworks: { provider: "fireworks", baseURL: "https://api.fireworks.ai/inference/v1" },
  groq: { provider: "groq", baseURL: "https://api.groq.com/openai/v1" },
  openrouter: { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1" },
  togetherai: { provider: "togetherai", baseURL: "https://api.together.xyz/v1" },
  xai: { provider: "xai", baseURL: "https://api.x.ai/v1" },
} as const satisfies Record<string, OpenAICompatibleProfile>

export const byProvider: Record<string, OpenAICompatibleProfile> = Object.fromEntries(
  Object.values(profiles).map((profile) => [profile.provider, profile]),
)
