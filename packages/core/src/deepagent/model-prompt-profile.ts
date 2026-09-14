export * as ModelPromptProfile from "./model-prompt-profile"

// G3 (gamma plan §3.2 阶段五) — model prompt profiles.
//
// A profile does NOT carry vendor prompt text. It parameterizes the three channels the plan
// distinguishes, so different models get behavior-appropriate SHORT constraints instead of one
// bloated orchestration script for everyone:
//
//   1. stableConstraint  — one short line merged into the cacheable system prefix (byte-stable
//      per provider+model ⇒ cache-safe; it rides buildSystemPrompt's tail).
//   2. eventPrompts     — injected ONLY at the matching runtime event (validation failed,
//      gate release, low-confidence), never into the stable prefix.
//   3. runtime params   — never sent to the model; they steer the state machine (reasoning
//      effort cap, plan-reminder suppression, tool batch size).
//
// Selection is provider+model keyed with a `default` fallback. Everything is overridable via
// DEEPAGENT_CODE_MODEL_PROFILES (JSON: {"deepseek/deepseek-chat": {...}}) and the resolved
// profile is emitted through turn-observability (`profile` field) — configurable and
// observable, never a hidden behavior change (plan 阶段五 acceptance).

export type ModelPromptProfile = {
  /** Stable one-line constraint merged into the cached system prefix. Empty ⇒ none. */
  readonly stableConstraint: string
  /** Event-triggered short prompts keyed by runtime event name. */
  readonly eventPrompts: Readonly<Record<string, string>>
  /** Runtime-only parameters (never sent to the model). */
  readonly params: {
    /** Cap on activation's suggestedReasoningEffort; models that over-think simple turns clamp here. */
    readonly maxReasoningEffort?: "low" | "medium" | "high" | "max"
    /** Suppress repeated plan reminders when the model demonstrably plans unprompted. */
    readonly suppressPlanReminders?: boolean
    /** Advisory max tool calls per assistant turn (runtime observation only in this milestone). */
    readonly maxToolBatch?: number
  }
}

const VALIDATION_FAILED_DEFAULT =
  "Validation failed. Read the failure output, fix the specific cause, re-run validation. Do not rewrite unrelated code."

const DEFAULT_PROFILE: ModelPromptProfile = {
  stableConstraint: "",
  eventPrompts: { validation_failed: VALIDATION_FAILED_DEFAULT },
  params: {},
}

// Seed profiles: behavioral parameters observed in the ablation campaigns only — no vendor
// prompt text. deepseek: completes edits but skips immediate validation (5070 evidence:
// test-file generation failures repeated until reminded); high-reliability tool models
// (claude/gpt families): plan reminders are noise — they plan unprompted.
const PROFILES: Readonly<Record<string, ModelPromptProfile>> = {
  "deepseek/deepseek-chat": {
    stableConstraint: "完成代码修改后立即运行验证命令，再继续其它工作。",
    eventPrompts: { validation_failed: VALIDATION_FAILED_DEFAULT },
    params: { maxReasoningEffort: "medium" },
  },
  "deepseek/deepseek-flash": {
    stableConstraint: "完成代码修改后立即运行验证命令，再继续其它工作。",
    eventPrompts: { validation_failed: VALIDATION_FAILED_DEFAULT },
    params: { maxReasoningEffort: "medium" },
  },
}

const EFFORT_ORDER = ["low", "medium", "high", "max"] as const

export const clampReasoningEffort = (
  effort: "low" | "medium" | "high" | "max",
  cap: "low" | "medium" | "high" | "max" | undefined,
): "low" | "medium" | "high" | "max" => {
  const clamped =
    cap === undefined ? effort : EFFORT_ORDER[Math.min(EFFORT_ORDER.indexOf(effort), EFFORT_ORDER.indexOf(cap))]
  // The OpenAI wire effort set has no "max" (openai-options.ts OpenAIReasoningEfforts filters it
  // out and the chat lowering REJECTS it) — clamp one step down rather than failing the request.
  return clamped === "max" ? "high" : clamped
}

const overridesFromEnv = (): Record<string, ModelPromptProfile> => {
  const raw = process.env["DEEPAGENT_CODE_MODEL_PROFILES"]
  if (raw === undefined || raw.trim() === "") return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, ModelPromptProfile> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== "object") continue
      const v = value as {
        stableConstraint?: unknown
        eventPrompts?: unknown
        params?: { maxReasoningEffort?: unknown; suppressPlanReminders?: unknown; maxToolBatch?: unknown }
      }
      out[key] = {
        stableConstraint: typeof v.stableConstraint === "string" ? v.stableConstraint : "",
        eventPrompts:
          v.eventPrompts !== null && typeof v.eventPrompts === "object"
            ? Object.fromEntries(
                Object.entries(v.eventPrompts as Record<string, unknown>).filter(
                  ([, text]) => typeof text === "string",
                ) as [string, string][],
              )
            : {},
        params: {
          ...(typeof v.params?.maxReasoningEffort === "string" &&
          (EFFORT_ORDER as readonly string[]).includes(v.params.maxReasoningEffort)
            ? { maxReasoningEffort: v.params.maxReasoningEffort as ModelPromptProfile["params"]["maxReasoningEffort"] }
            : {}),
          ...(typeof v.params?.suppressPlanReminders === "boolean"
            ? { suppressPlanReminders: v.params.suppressPlanReminders }
            : {}),
          ...(typeof v.params?.maxToolBatch === "number" ? { maxToolBatch: v.params.maxToolBatch } : {}),
        },
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Resolve the profile for a provider+model pair. Pure; env overrides merge over the seeds. */
export const profileFor = (providerID: string, modelID: string): ModelPromptProfile => {
  const overrides = overridesFromEnv()
  return overrides[`${providerID}/${modelID}`] ?? PROFILES[`${providerID}/${modelID}`] ?? DEFAULT_PROFILE
}

/** The profile key (for observability): seeded, overridden, or "default". */
export const profileKeyFor = (providerID: string, modelID: string): string => {
  const key = `${providerID}/${modelID}`
  if (process.env["DEEPAGENT_CODE_MODEL_PROFILES"]?.includes(key)) return `${key} (override)`
  return PROFILES[key] ? key : "default"
}

/** Event channel: the short prompt for a runtime event, or undefined. */
export const eventPrompt = (profile: ModelPromptProfile, event: string): string | undefined =>
  profile.eventPrompts[event]
