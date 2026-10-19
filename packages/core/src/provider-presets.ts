/**
 * Public connection identities, not a model snapshot or an authentication allowlist.
 * Endpoints/protocols preserve the shipped provider contracts and the models.dev catalog
 * fixture at 013776633913681e24ebb8ccfaa807d9d0edeaba. Refresh supplies actual model specs.
 */
export const PROVIDER_BRANDS = [
  { id: "deepagent", name: "DeepAgent" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "zhipu", name: "Zhipu / Z.AI" },
  { id: "kimi", name: "Kimi / Moonshot" },
  { id: "alibaba", name: "Alibaba Cloud Bailian" },
  { id: "google", name: "Google Gemini" },
  { id: "xai", name: "xAI Grok" },
  { id: "openrouter", name: "OpenRouter" },
] as const

// A supplier owns account/region boundaries; its API and subscription products
// retain separate provider IDs and credentials within one settings entry.
export const PROVIDER_SUPPLIERS = [
  { id: "deepagent", name: "DeepAgent", providers: ["deepagent"] },
  { id: "deepseek", name: "DeepSeek", providers: ["deepseek"] },
  { id: "openai", name: "OpenAI", providers: ["openai"] },
  { id: "anthropic", name: "Anthropic", providers: ["anthropic"] },
  { id: "zhipuai", name: "Zhipu AI", providers: ["zhipuai", "zhipuai-coding-plan"] },
  { id: "zai", name: "Z.AI", providers: ["zai", "zai-coding-plan"] },
  { id: "kimi", name: "Kimi", providers: ["moonshotai-cn", "kimi-for-coding"] },
  { id: "moonshotai", name: "Moonshot AI", providers: ["moonshotai"] },
  { id: "alibaba-cn", name: "Alibaba Cloud Bailian (China)", providers: ["alibaba-cn", "alibaba-coding-plan-cn"] },
  { id: "alibaba", name: "Alibaba Cloud Model Studio", providers: ["alibaba", "alibaba-coding-plan"] },
  { id: "google", name: "Google Gemini", providers: ["google"] },
  { id: "xai", name: "xAI Grok", providers: ["xai"] },
  { id: "openrouter", name: "OpenRouter", providers: ["openrouter"] },
] as const

export function providerSupplier(providerID: string) {
  return PROVIDER_SUPPLIERS.find((item) => item.providers.some((id) => id === providerID))
}

type Preset = {
  id: string
  brand: (typeof PROVIDER_BRANDS)[number]["id"]
  name: string
  billing: "api" | "plan"
  region: "global" | "cn" | "intl"
  api: string
  npm: string
  env: string[]
}

export const PROVIDER_PRESETS: readonly Preset[] = [
  {
    id: "deepagent",
    brand: "deepagent",
    name: "DeepAgent API",
    billing: "api",
    region: "global",
    api: "https://api.deepagent.ltd/v1",
    npm: "@ai-sdk/openai-compatible",
    env: ["DEEPAGENT_API_KEY"],
  },
  {
    id: "deepseek",
    brand: "deepseek",
    name: "DeepSeek",
    billing: "api",
    region: "global",
    api: "https://api.deepseek.com",
    npm: "@ai-sdk/openai-compatible",
    env: ["DEEPSEEK_API_KEY"],
  },
  {
    id: "openai",
    brand: "openai",
    name: "OpenAI",
    billing: "api",
    region: "global",
    api: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
  },
  {
    id: "anthropic",
    brand: "anthropic",
    name: "Anthropic",
    billing: "api",
    region: "global",
    api: "https://api.anthropic.com/v1",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
  },
  {
    id: "zhipuai",
    brand: "zhipu",
    name: "Zhipu AI",
    billing: "api",
    region: "cn",
    api: "https://open.bigmodel.cn/api/paas/v4",
    npm: "@ai-sdk/openai-compatible",
    env: ["ZHIPU_API_KEY"],
  },
  {
    id: "zhipuai-coding-plan",
    brand: "zhipu",
    name: "Zhipu AI Coding Plan",
    billing: "plan",
    region: "cn",
    api: "https://open.bigmodel.cn/api/coding/paas/v4",
    npm: "@ai-sdk/openai-compatible",
    env: ["ZHIPU_API_KEY"],
  },
  {
    id: "zai",
    brand: "zhipu",
    name: "Z.AI",
    billing: "api",
    region: "intl",
    api: "https://api.z.ai/api/paas/v4",
    npm: "@ai-sdk/openai-compatible",
    env: ["ZHIPU_API_KEY"],
  },
  {
    id: "zai-coding-plan",
    brand: "zhipu",
    name: "Z.AI Coding Plan",
    billing: "plan",
    region: "intl",
    api: "https://api.z.ai/api/coding/paas/v4",
    npm: "@ai-sdk/openai-compatible",
    env: ["ZHIPU_API_KEY"],
  },
  {
    id: "kimi-for-coding",
    brand: "kimi",
    name: "Kimi Code",
    billing: "plan",
    region: "cn",
    api: "https://api.kimi.com/coding/v1",
    npm: "@ai-sdk/anthropic",
    env: ["KIMI_API_KEY"],
  },
  {
    id: "moonshotai-cn",
    brand: "kimi",
    name: "Moonshot AI (China)",
    billing: "api",
    region: "cn",
    api: "https://api.moonshot.cn/v1",
    npm: "@ai-sdk/openai-compatible",
    env: ["MOONSHOT_API_KEY"],
  },
  {
    id: "moonshotai",
    brand: "kimi",
    name: "Moonshot AI",
    billing: "api",
    region: "intl",
    api: "https://api.moonshot.ai/v1",
    npm: "@ai-sdk/openai-compatible",
    env: ["MOONSHOT_API_KEY"],
  },
  {
    id: "alibaba-cn",
    brand: "alibaba",
    name: "Alibaba (China)",
    billing: "api",
    region: "cn",
    api: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    npm: "@ai-sdk/openai-compatible",
    env: ["DASHSCOPE_API_KEY"],
  },
  {
    id: "alibaba",
    brand: "alibaba",
    name: "Alibaba",
    billing: "api",
    region: "intl",
    api: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    npm: "@ai-sdk/openai-compatible",
    env: ["DASHSCOPE_API_KEY"],
  },
  {
    id: "alibaba-coding-plan-cn",
    brand: "alibaba",
    name: "Alibaba Coding Plan (China)",
    billing: "plan",
    region: "cn",
    api: "https://coding.dashscope.aliyuncs.com/v1",
    npm: "@ai-sdk/openai-compatible",
    env: ["ALIBABA_CODING_PLAN_API_KEY"],
  },
  {
    id: "alibaba-coding-plan",
    brand: "alibaba",
    name: "Alibaba Coding Plan",
    billing: "plan",
    region: "intl",
    api: "https://coding-intl.dashscope.aliyuncs.com/v1",
    npm: "@ai-sdk/openai-compatible",
    env: ["ALIBABA_CODING_PLAN_API_KEY"],
  },
  {
    id: "google",
    brand: "google",
    name: "Google Gemini",
    billing: "api",
    region: "global",
    api: "https://generativelanguage.googleapis.com/v1beta",
    npm: "@ai-sdk/google",
    env: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  },
  {
    id: "xai",
    brand: "xai",
    name: "xAI Grok",
    billing: "api",
    region: "global",
    api: "https://api.x.ai/v1",
    npm: "@ai-sdk/xai",
    env: ["XAI_API_KEY"],
  },
  {
    id: "openrouter",
    brand: "openrouter",
    name: "OpenRouter",
    billing: "api",
    region: "global",
    api: "https://openrouter.ai/api/v1",
    npm: "@openrouter/ai-sdk-provider",
    env: ["OPENROUTER_API_KEY"],
  },
]

export const RECOMMENDED_PROVIDER_IDS = PROVIDER_PRESETS.map((item) => item.id)

export function providerPreset(id: string) {
  return PROVIDER_PRESETS.find((item) => item.id === id)
}

/** Empty model maps are deliberate: an offline identity is not a verified model catalog. */
export const PROVIDER_BOOTSTRAP_CATALOG = Object.fromEntries(
  PROVIDER_PRESETS.map((item) => [
    item.id,
    { id: item.id, name: item.name, api: item.api, npm: item.npm, env: [...item.env], models: {} },
  ]),
)
