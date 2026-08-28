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

/**
 * The fixed set of first-party ("official") providers. Single source of truth.
 *
 * The Zhipu/Z.AI family is four distinct API faces (2 brands × 2 billing planes),
 * all resolved from the models.dev catalog with the `@ai-sdk/openai-compatible`
 * protocol against a fixed endpoint:
 *   - `zhipuai`               open.bigmodel.cn /api/paas/v4       (pay-as-you-go, CN)
 *   - `zhipuai-coding-plan`   open.bigmodel.cn /api/coding/paas/v4 (subscription, CN)
 *   - `zai`                   api.z.ai         /api/paas/v4        (pay-as-you-go, intl)
 *   - `zai-coding-plan`       api.z.ai         /api/coding/paas/v4 (subscription, intl)
 * Each takes its own API key from the auth key store (users connect only the ones
 * they hold); coding-plan thinking/billing keys off the catalog `api.url`, not config.
 *
 * The Kimi/Moonshot family is two faces (brand × billing plane) — note they use
 * DIFFERENT protocols, both resolved from the models.dev catalog:
 *   - `kimi-for-coding`  api.kimi.com     /coding/v1  (subscription, `@ai-sdk/anthropic`
 *                        — SDK appends `/messages`; the `/v1` suffix is mandatory)
 *   - `moonshotai-cn`    api.moonshot.cn  /v1         (pay-as-you-go, `@ai-sdk/openai-compatible`)
 */
export const OFFICIAL_PROVIDER_IDS = [
  "openai",
  "deepseek",
  "anthropic",
  "zhipuai",
  "zhipuai-coding-plan",
  "zai",
  "zai-coding-plan",
  "kimi-for-coding",
  "moonshotai-cn",
  "xai",
  "google",
] as const

export type OfficialProviderID = (typeof OFFICIAL_PROVIDER_IDS)[number]

export const OFFICIAL_PROVIDER_ID_SET: ReadonlySet<string> = new Set(OFFICIAL_PROVIDER_IDS)

/** True when `providerID` is one of the fixed official providers. */
export function isOfficialProvider(providerID: string): boolean {
  return OFFICIAL_PROVIDER_ID_SET.has(providerID)
}
