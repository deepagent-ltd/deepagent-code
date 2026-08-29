import { isOfficialProvider } from "@deepagent-code/core/provider-official"
import type { ProviderConfig } from "@deepagent-code/sdk/v2"

export function canRefreshProviderModels(providerID: string, config: ProviderConfig | undefined) {
  if (isOfficialProvider(providerID)) return true
  if (config?.discovery === true) return true
  if (Object.values(config?.groups ?? {}).some((group) => group.discovery === true)) return true
  return (
    config?.npm === undefined &&
    typeof config?.options?.baseURL === "string" &&
    !!config.options.baseURL &&
    Object.keys(config.models ?? {}).length > 0
  )
}
