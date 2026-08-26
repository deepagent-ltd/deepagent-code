import type { useServerSync } from "@/context/server-sync"

export type DeepAgentMode = "general" | "high" | "xhigh" | "max" | "ultra"
export type DeepAgentPromptMode = "direct" | "intelligence"
export type DeepAgentIntelligenceModel = string
export type DeepAgentSelfLearning = "manual" | "auto"
export type DeepAgentSubagentIntensity = "inherit" | "downgrade"

type ServerSync = ReturnType<typeof useServerSync>

const isDeepAgentMode = (value: unknown): value is DeepAgentMode =>
  value === "general" || value === "high" || value === "xhigh" || value === "max" || value === "ultra"

const isDeepAgentPromptMode = (value: unknown): value is DeepAgentPromptMode =>
  value === "direct" || value === "intelligence"

const isDeepAgentSelfLearning = (value: unknown): value is DeepAgentSelfLearning =>
  value === "manual" || value === "auto"

const isDeepAgentSubagentIntensity = (value: unknown): value is DeepAgentSubagentIntensity =>
  value === "inherit" || value === "downgrade"

export const deepAgentModeFromConfig = (config: ServerSync["data"]["config"] | undefined): DeepAgentMode => {
  const value = config?.provider?.deepagent?.options?.agentMode
  return isDeepAgentMode(value) ? value : "high"
}

export const deepAgentPromptModeFromConfig = (
  config: ServerSync["data"]["config"] | undefined,
): DeepAgentPromptMode => {
  const raw = config?.provider?.deepagent?.options?.promptMode
  // Legacy-compat: "wish" is the pre-rename value for "intelligence". Normalize it so an existing
  // user whose synced config still says "wish" resolves to the intelligence mode. The default is
  // now "intelligence" (was "wish").
  const value = raw === "wish" ? "intelligence" : raw
  return isDeepAgentPromptMode(value) ? value : "intelligence"
}

export const deepAgentIntelligenceModelFromConfig = (
  config: ServerSync["data"]["config"] | undefined,
): DeepAgentIntelligenceModel | undefined => {
  const options = config?.provider?.deepagent?.options
  // Legacy-compat: prefer the new `intelligenceModel` key, fall back to the pre-rename `wishModel`
  // so an existing user's configured model still shows in the selector.
  const value = options?.intelligenceModel ?? options?.wishModel
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

export const deepAgentSelfLearningFromConfig = (
  config: ServerSync["data"]["config"] | undefined,
): DeepAgentSelfLearning => {
  const value = config?.provider?.deepagent?.options?.selfLearning
  return isDeepAgentSelfLearning(value) ? value : "manual"
}

export const deepAgentSubagentIntensityFromConfig = (
  config: ServerSync["data"]["config"] | undefined,
): DeepAgentSubagentIntensity => {
  const value = config?.provider?.deepagent?.options?.subagentIntensity
  return isDeepAgentSubagentIntensity(value) ? value : "inherit"
}

export const updateDeepAgentOptions = (
  serverSync: ServerSync,
  patch: Partial<{
    agentMode: DeepAgentMode
    promptMode: DeepAgentPromptMode
    intelligenceModel: DeepAgentIntelligenceModel
    selfLearning: DeepAgentSelfLearning
    subagentIntensity: DeepAgentSubagentIntensity
  }>,
) => {
  const current = serverSync.data.config.provider?.deepagent ?? {}
  const { enabled: _legacyEnabled, ...options } = current.options ?? {}
  return serverSync.updateConfig({
    provider: {
      deepagent: {
        name: "DeepAgent",
        ...current,
        options: {
          ...options,
          ...patch,
        },
        models: current.models ?? {},
      },
    },
  })
}
