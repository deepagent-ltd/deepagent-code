import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Global } from "@deepagent-code/core/global"

type AgentGatewayConfig = NonNullable<Parameters<typeof AgentGateway.configure>[0]>
type AgentMode = NonNullable<NonNullable<AgentGatewayConfig>["agentMode"]>

type ConfigInfo = {
  readonly provider?: Record<string, { readonly options?: Record<string, unknown> }>
}

const bool = (value: unknown) => (typeof value === "boolean" ? value : undefined)

const string = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)

const agentMode = (value: unknown): AgentMode | undefined =>
  value === "general" || value === "high" || value === "xhigh" || value === "max" || value === "ultra" ? value : undefined

type SelfLearningPolicy = NonNullable<NonNullable<AgentGatewayConfig>["selfLearning"]>

const selfLearning = (value: unknown): SelfLearningPolicy | undefined =>
  value === "manual" || value === "auto" ? value : undefined

const stringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : undefined

const envBool = (name: string) => process.env[name] === "true" || process.env[name] === "1"

const envAllowlist = () =>
  process.env.DEEPAGENT_PROVIDER_EXECUTED_TOOL_ALLOWLIST?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

const envAgentMode = (): AgentMode | undefined => agentMode(process.env.DEEPAGENT_MODE)

const envSelfLearning = (): SelfLearningPolicy | undefined => selfLearning(process.env.DEEPAGENT_SELF_LEARNING)

export function gatewayConfig(config?: ConfigInfo): AgentGatewayConfig {
  const options = config?.provider?.deepagent?.options ?? {}
  const allowlist = stringArray(options.allowProviderExecutedToolNames) ?? envAllowlist()

  return {
    enabled: true,
    agentMode: agentMode(options.agentMode) ?? envAgentMode() ?? "high",
    selfLearning: selfLearning(options.selfLearning) ?? envSelfLearning() ?? "manual",
    // P0-0 single storage root: inject from Global.Path.agent (the one resolver that honors
    // DEEPAGENT_CODE_HOME / TEST_HOME / legacy migration). baseDir roots durable memory/state;
    // runsDir can be overridden independently. The gateway no longer self-resolves the home.
    baseDir: Global.Path.agent.data,
    runsDir: string(options.runsDir) ?? process.env.DEEPAGENT_RUNS_DIR ?? Global.Path.agent.runs,
    allowProviderExecutedTools:
      bool(options.allowProviderExecutedTools) ?? envBool("DEEPAGENT_ALLOW_PROVIDER_EXECUTED_TOOLS"),
    ...(allowlist ? { allowProviderExecutedToolNames: allowlist } : {}),
  }
}

export function reviewRunsDir(config?: ConfigInfo): string {
  return gatewayConfig(config).runsDir!
}

export function configureGateway(config?: ConfigInfo) {
  return AgentGateway.configure(gatewayConfig(config))
}

export function snapshotGateway(config?: ConfigInfo) {
  configureGateway(config)
  return AgentGateway.snapshot()
}
