export * as ModelHardPolicy from "./model-hard-policy"

/** FEATURE-001-405: these are policy thresholds, never provider capability claims. */
const policies = {
  "deepseek-v4-pro": { observation: 768_000, hardGate: 896_000 },
  "deepseek-v4-flash": { observation: 256_000, hardGate: 384_000 },
  "kimi-k3": { observation: 384_000, hardGate: 512_000 },
  "glm-5.2": { observation: 300_000, hardGate: 384_000 },
} as const

export type PolicyKey = keyof typeof policies

const candidates: Record<string, Partial<Record<string, PolicyKey>>> = {
  deepseek: {
    "deepseek-v4-pro": "deepseek-v4-pro",
    "deepseek-flash": "deepseek-v4-flash",
  },
  moonshotai: { "kimi-k3": "kimi-k3" },
  zhipuai: { "glm-5.2": "glm-5.2" },
  zai: { "glm-5.2": "glm-5.2" },
  deepagent: {
    "deepseek-v4-pro": "deepseek-v4-pro",
    "deepseek-flash": "deepseek-v4-flash",
    "kimi-k3": "kimi-k3",
    "glm-5.2": "glm-5.2",
  },
}

export type Decision =
  | { readonly state: "unmanaged"; readonly reason: "model_not_registered" }
  | { readonly state: "unavailable"; readonly reason: "context_limit_unknown" | "context_limit_invalid" }
  | {
      readonly state: "managed"
      readonly key: PolicyKey
      readonly version: 1
      readonly match: "api_model_id" | "runtime_model_id"
      readonly observationLine: number
      readonly hardGate: number
      readonly effectiveObservationLine: number
      readonly effectiveHardGate: number
      readonly physicalInputBudget: number
      readonly limitMismatch: boolean
      readonly action: "normal" | "observed" | "hard_gate_compact" | "hard_gate_blocked"
    }

/**
 * Match exact API identities within an audited provider. Gateway variants may have smaller windows;
 * the caller supplies the resolver's effective input budget, never the public model maximum.
 */
export function decide(input: {
  readonly providerID: string
  readonly runtimeModelID: string
  readonly apiModelID?: string
  readonly physicalInputBudget: number
  readonly estimatedFullRequestTokens: number
  readonly autoCompact: boolean
}): Decision {
  const registered = candidates[input.providerID]
  const key = input.apiModelID ? registered?.[input.apiModelID] : registered?.[input.runtimeModelID]
  if (!key) return { state: "unmanaged", reason: "model_not_registered" }
  if (!Number.isFinite(input.physicalInputBudget) || input.physicalInputBudget < 0)
    return { state: "unavailable", reason: "context_limit_invalid" }
  if (input.physicalInputBudget === 0) return { state: "unavailable", reason: "context_limit_unknown" }

  const policy = policies[key]
  const effectiveHardGate = Math.min(policy.hardGate, input.physicalInputBudget)
  const effectiveObservationLine = Math.min(policy.observation, effectiveHardGate)
  return {
    state: "managed",
    key,
    version: 1,
    match: input.apiModelID ? "api_model_id" : "runtime_model_id",
    observationLine: policy.observation,
    hardGate: policy.hardGate,
    effectiveObservationLine,
    effectiveHardGate,
    physicalInputBudget: input.physicalInputBudget,
    limitMismatch: input.physicalInputBudget < policy.hardGate,
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
