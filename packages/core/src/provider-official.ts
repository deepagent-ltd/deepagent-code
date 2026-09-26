/**
 * Official provider identity — dependency-free leaf module.
 *
 * These are dependency-light constants (a string tuple + an immutable Set view
 * + a predicate). They live in their own module — NOT in `provider.ts` — because the
 * browser/renderer (app) needs them, and `provider.ts` transitively pulls in
 * `./schema` -> `./util/hash` -> node `crypto` (`createHash`), which Vite
 * externalizes for the browser and would crash the renderer at load time.
 *
 * `provider.ts` re-exports these so existing backend imports of
 * `@deepagent-code/core/provider` keep working unchanged.
 */

import { readonlySet } from "./util/readonly-collections"

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
 *
 * The DeepAgent first-party API platform (newAPI gateway) is recommended-first:
 *   - `deepagent`   https://api.deepagent.ltd/v1  (OpenAI Chat Completions + Responses),
 *                   https://api.deepagent.ltd     (Anthropic `/v1/messages` compat)
 *   - credential env: `DEEPAGENT_API_KEY` (sk-… from the platform console)
 *   - catalog identity + model list are VENDORED in `packages/core/src/models-dev.ts`
 *     (the third-party models.dev catalog has no entry), so the provider flows
 *     through the same catalog-driven loader/UI as every other official provider.
 */
export const OFFICIAL_PROVIDER_IDS = [
  "deepagent",
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

/**
 * Catalog-id bridge for official ids whose upstream models.dev entry was renamed out from under
 * us. An official id that the fetched catalog no longer carries would silently no-op every
 * key-store credential merge (mergeProvider finds no catalog match) — the user connects a key and
 * nothing happens, with no error anywhere. Map each drifted official id to the catalog id that
 * now serves the same endpoint; loader-side bridging (provider.ts) re-homes the catalog entry
 * under the official id so credentials, picker identity, and auth writes all keep working.
 */
export const OFFICIAL_PROVIDER_CATALOG_ALIASES: Partial<Record<OfficialProviderID, string>> = {
  // models.dev renamed the Kimi subscription faces (2026): kimi-for-coding → kimi-code-plan-cn.
  // Both coding-plan entries serve api.kimi.com/coding/v1 with KIMI_API_KEY; the CN plane is the
  // direct successor of the old id. The vendored self-hosted mirror tracks models.dev, so both
  // sources carry the new ids.
  "kimi-for-coding": "kimi-code-plan-cn",
}

/** The catalog id an official id resolves to: itself, or its alias when one is registered. */
export function officialProviderCatalogID(providerID: string): string {
  return OFFICIAL_PROVIDER_CATALOG_ALIASES[providerID as OfficialProviderID] ?? providerID
}

export type OfficialProviderID = (typeof OFFICIAL_PROVIDER_IDS)[number]

export const OFFICIAL_PROVIDER_ID_SET = readonlySet(new Set<string>(OFFICIAL_PROVIDER_IDS))

/** True when `providerID` is one of the fixed official providers. */
export function isOfficialProvider(providerID: string): boolean {
  return OFFICIAL_PROVIDER_ID_SET.has(providerID)
}
