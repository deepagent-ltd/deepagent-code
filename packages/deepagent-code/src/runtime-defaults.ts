// W0.1 — single point of truth for the V2 production runtime defaults shared by every entry: the
// CLI entry (src/index.ts) and the desktop sidecar (src/node.ts). Each entry calls
// `applyRuntimeDefaults()` at the earliest process point, so both processes see the same canonical
// defaults and the default values are queryable in exactly one module.
//
// REPO-WIDE SEMANTICS (mirrors the `stableOn` convention in effect/runtime-flags.ts): every
// boolean below ships ON by default. An explicit `=false` or `=0` (case-insensitive, surrounding
// whitespace ignored) turns it OFF; any other explicit value is left to the consumer's own
// predicate. `applyRuntimeDefaults` is strictly set-if-unset: an explicit value — including
// `=false`/`=0` — is never overwritten, so a kill-switch set by the operator survives.

export const EVENT_V2_ADMISSION_ENV = "DEEPAGENT_CODE_EVENT_V2_ADMISSION"
export const IM_SINGLE_WRITE_ENV = "DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE"
export const CORE_V2_EXECUTION_OWNER_ENV = "DEEPAGENT_CODE_CORE_V2_EXECUTION_OWNER"
export const V2_OWNER_CAMPAIGN_ENV = "DEEPAGENT_CODE_V2_OWNER_CAMPAIGN"
export const V2_BUILD_IDENTITY_ENV = "DEEPAGENT_CODE_V2_BUILD_IDENTITY"
export const CONTEXT_FEDERATION_PRODUCTION_ENV = "DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION"
/** Test-only affordance used by the two entries to print their canonical defaults vector and exit
 * without starting the CLI/server (W0.1 automated-verification case 4). */
export const RUNTIME_DEFAULTS_SNAPSHOT_ENV = "DEEPAGENT_CODE_RUNTIME_DEFAULTS_SNAPSHOT"

/** The V2 runtime defaults every production entry applies. The optional strings carry no default
 * of their own: undefined while unset, consumers own the fallback (owner campaign / build identity
 * resolution in core session runner). */
export interface RuntimeDefaults {
  eventV2Admission: boolean
  imSingleWrite: boolean
  coreV2ExecutionOwner: boolean
  ownerCampaign?: string
  buildIdentity?: string
  federationActivate?: boolean
}

const DEFAULT_ON_ENV_KEYS = [
  EVENT_V2_ADMISSION_ENV,
  IM_SINGLE_WRITE_ENV,
  CORE_V2_EXECUTION_OWNER_ENV,
  CONTEXT_FEDERATION_PRODUCTION_ENV,
] as const

const isOn = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase()
  return normalized !== "false" && normalized !== "0"
}

const optionalString = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function runtimeDefaultsFromEnv(env: NodeJS.ProcessEnv): RuntimeDefaults {
  return {
    eventV2Admission: isOn(env[EVENT_V2_ADMISSION_ENV]),
    imSingleWrite: isOn(env[IM_SINGLE_WRITE_ENV]),
    coreV2ExecutionOwner: isOn(env[CORE_V2_EXECUTION_OWNER_ENV]),
    ownerCampaign: optionalString(env[V2_OWNER_CAMPAIGN_ENV]),
    buildIdentity: optionalString(env[V2_BUILD_IDENTITY_ENV]),
    federationActivate: isOn(env[CONTEXT_FEDERATION_PRODUCTION_ENV]),
  }
}

export function applyRuntimeDefaults(env: NodeJS.ProcessEnv = process.env): void {
  // setIfUnset: only fill keys nobody set — an explicit `=false`/`=0` kill-switch must survive.
  for (const key of DEFAULT_ON_ENV_KEYS) {
    if (env[key] === undefined) env[key] = "true"
  }
}

/** The canonical env vector after `applyRuntimeDefaults` — what the entries print under
 * `RUNTIME_DEFAULTS_SNAPSHOT_ENV` and what test/runtime-defaults.test.ts compares. */
export function runtimeDefaultsEnvSnapshot(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return {
    [EVENT_V2_ADMISSION_ENV]: env[EVENT_V2_ADMISSION_ENV],
    [IM_SINGLE_WRITE_ENV]: env[IM_SINGLE_WRITE_ENV],
    [CORE_V2_EXECUTION_OWNER_ENV]: env[CORE_V2_EXECUTION_OWNER_ENV],
    [V2_OWNER_CAMPAIGN_ENV]: env[V2_OWNER_CAMPAIGN_ENV],
    [V2_BUILD_IDENTITY_ENV]: env[V2_BUILD_IDENTITY_ENV],
    [CONTEXT_FEDERATION_PRODUCTION_ENV]: env[CONTEXT_FEDERATION_PRODUCTION_ENV],
  }
}
