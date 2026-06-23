import type { LanguageModelV3 } from "@ai-sdk/provider"

export type BundledSDK = {
  languageModel(modelId: string): LanguageModelV3
  chat?: (modelId: string) => LanguageModelV3
  responses?: (modelId: string) => LanguageModelV3
}

type CompatibilityModel = {
  providerID: string
  id?: string
  api: {
    id?: string
    npm: string
  }
  options?: Record<string, any>
}

export const SUPPORTED_DEEPAGENT_PROVIDER_IDS = new Set(["openai", "deepseek", "anthropic"])

export const SUPPORTED_DEEPAGENT_PROVIDER_PACKAGES = new Set([
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/anthropic",
])

export function deepagentUpstreamProviderID(model: CompatibilityModel) {
  const configured = model.options?.upstreamProviderID
  if (typeof configured === "string" && configured) return configured
  if (model.api.npm === "@ai-sdk/openai") return "openai"
  if (model.api.npm === "@ai-sdk/anthropic") return "anthropic"
  const id = `${model.id ?? ""} ${model.api.id ?? ""}`.toLowerCase()
  if (id.includes("deepseek")) return "deepseek"
  if (id.includes("claude") || id.includes("anthropic")) return "anthropic"
  return "openai"
}

export function googleVertexAnthropicBaseURL(project: string | undefined, location: string | undefined) {
  if (!project) return
  if (location !== "eu" && location !== "us") return
  // Continental multi-regions require Regional Endpoint Platform domains.
  return `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`
}

export function googleVertexAnthropicOptions(project: string | undefined, location: string | undefined) {
  const baseURL = googleVertexAnthropicBaseURL(project, location)
  return {
    project,
    location,
    ...(baseURL && { baseURL }),
  }
}

export function applyCompatibilityProviderOptions(model: CompatibilityModel, options: Record<string, any>) {
  if (model.providerID === "google-vertex" && model.api.npm === "@ai-sdk/google-vertex/anthropic" && !options.baseURL) {
    const baseURL = googleVertexAnthropicBaseURL(
      typeof options.project === "string" ? options.project : undefined,
      typeof options.location === "string" ? options.location : undefined,
    )
    if (baseURL) options.baseURL = baseURL
  }

  if (model.providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
    delete options.fetch
  }
}

export function stripsOpenAIItemMetadata(model: CompatibilityModel) {
  return (
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/azure" ||
    model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  )
}

export const COMPATIBILITY_PROVIDER_LOADERS: Record<string, () => Promise<(opts: any) => BundledSDK>> = {
  "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock),
  "@ai-sdk/amazon-bedrock/mantle": () => import("@ai-sdk/amazon-bedrock/mantle").then((m) => m.createBedrockMantle),
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
  "@ai-sdk/azure": () => import("@ai-sdk/azure").then((m) => m.createAzure),
  "@ai-sdk/google": () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex").then((m) => m.createVertex),
  "@ai-sdk/google-vertex/anthropic": () =>
    import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic),
  "@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI),
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible),
  "@openrouter/ai-sdk-provider": () => import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter),
  "@ai-sdk/xai": () => import("@ai-sdk/xai").then((m) => m.createXai),
  "@ai-sdk/mistral": () => import("@ai-sdk/mistral").then((m) => m.createMistral),
  "@ai-sdk/groq": () => import("@ai-sdk/groq").then((m) => m.createGroq),
  "@ai-sdk/deepinfra": () => import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra),
  "@ai-sdk/cerebras": () => import("@ai-sdk/cerebras").then((m) => m.createCerebras),
  "@ai-sdk/cohere": () => import("@ai-sdk/cohere").then((m) => m.createCohere),
  "@ai-sdk/gateway": () => import("@ai-sdk/gateway").then((m) => m.createGateway),
  "@ai-sdk/togetherai": () => import("@ai-sdk/togetherai").then((m) => m.createTogetherAI),
  "@ai-sdk/perplexity": () => import("@ai-sdk/perplexity").then((m) => m.createPerplexity),
  "@ai-sdk/vercel": () => import("@ai-sdk/vercel").then((m) => m.createVercel),
  "@ai-sdk/alibaba": () => import("@ai-sdk/alibaba").then((m) => m.createAlibaba),
  "gitlab-ai-provider": () => import("gitlab-ai-provider").then((m) => m.createGitLab),
  "@ai-sdk/github-copilot": () =>
    import("@deepagent-code/core/github-copilot/copilot-provider").then((m) => m.createOpenaiCompatible),
  "venice-ai-sdk-provider": () => import("venice-ai-sdk-provider").then((m) => m.createVenice),
}
