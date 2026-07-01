/**
 * Official provider identity — dependency-free leaf module.
 *
 * These are plain constants (a string tuple + a Set + a predicate) with ZERO
 * imports. They live in their own module — NOT in `provider.ts` — because the
 * browser/renderer (app) needs them, and `provider.ts` transitively pulls in
 * `./schema` -> `./util/hash` -> node `crypto` (`createHash`), which Vite
 * externalizes for the browser and would crash the renderer at load time.
 *
 * `provider.ts` re-exports these so existing backend imports of
 * `@deepagent-code/core/provider` keep working unchanged.
 */

/** The fixed set of first-party ("official") providers. Single source of truth. */
export const OFFICIAL_PROVIDER_IDS = ["openai", "deepseek", "anthropic", "zhipuai", "xai", "google"] as const

export type OfficialProviderID = (typeof OFFICIAL_PROVIDER_IDS)[number]

export const OFFICIAL_PROVIDER_ID_SET: ReadonlySet<string> = new Set(OFFICIAL_PROVIDER_IDS)

/** True when `providerID` is one of the fixed official providers. */
export function isOfficialProvider(providerID: string): boolean {
  return OFFICIAL_PROVIDER_ID_SET.has(providerID)
}
