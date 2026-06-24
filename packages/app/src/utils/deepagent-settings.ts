import type { useServerSync } from "@/context/server-sync"

export type DeepAgentMode = "general" | "high" | "xhigh" | "max" | "ultra"
export type DeepAgentPromptMode = "direct" | "wish"
export type DeepAgentWishModel = string
export type DeepAgentSelfLearning = "manual" | "auto"

type ServerSync = ReturnType<typeof useServerSync>

const isDeepAgentMode = (value: unknown): value is DeepAgentMode =>
  value === "general" || value === "high" || value === "xhigh" || value === "max" || value === "ultra"

const isDeepAgentPromptMode = (value: unknown): value is DeepAgentPromptMode =>
  value === "direct" || value === "wish"

const isDeepAgentSelfLearning = (value: unknown): value is DeepAgentSelfLearning =>
  value === "manual" || value === "auto"

export const deepAgentModeFromConfig = (config: ServerSync["data"]["config"] | undefined): DeepAgentMode => {
  const value = config?.provider?.deepagent?.options?.agentMode
  return isDeepAgentMode(value) ? value : "high"
}

export const deepAgentPromptModeFromConfig = (config: ServerSync["data"]["config"] | undefined): DeepAgentPromptMode => {
  const value = config?.provider?.deepagent?.options?.promptMode
  return isDeepAgentPromptMode(value) ? value : "wish"
}

export const deepAgentWishModelFromConfig = (
  config: ServerSync["data"]["config"] | undefined,
): DeepAgentWishModel | undefined => {
  const value = config?.provider?.deepagent?.options?.wishModel
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

export const deepAgentSelfLearningFromConfig = (
  config: ServerSync["data"]["config"] | undefined,
): DeepAgentSelfLearning => {
  const value = config?.provider?.deepagent?.options?.selfLearning
  return isDeepAgentSelfLearning(value) ? value : "manual"
}

export const updateDeepAgentOptions = (
  serverSync: ServerSync,
  patch: Partial<{
    agentMode: DeepAgentMode
    promptMode: DeepAgentPromptMode
    wishModel: DeepAgentWishModel
    selfLearning: DeepAgentSelfLearning
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
