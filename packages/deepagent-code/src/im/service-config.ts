export * as IMServiceConfig from "./service-config"

import { Effect } from "effect"
import { ConfigIM } from "@deepagent-code/core/config/im"
import type { Config } from "@/config/config"
import { IMKernelExchange } from "./kernel/exchange"
import { KernelConfig } from "./kernel/config"

/** Only the global profile selects a process-wide IM service. Project config is never consulted. */
export const read = Effect.fn("IMServiceConfig.read")(function* (
  config: Pick<Config.Interface, "getGlobal"> | undefined,
  env: Readonly<Record<string, string | undefined>>,
  allowLoopback = false,
  legacyFixtureHTTP = false,
) {
  const saved = config ? (yield* config.getGlobal()).im?.url : undefined
  const value = saved !== undefined ? saved : env[KernelConfig.facadeEnvKeys.url]
  const source: (typeof ConfigIM.ServiceStatus.Type)["source"] =
    saved !== undefined ? "config" : value ? "environment" : "none"
  if (value === null || value === undefined || value === "") return { url: null, source }
  // Existing injected-engine fixtures use a non-network HTTP facade. Saved product config stays HTTPS-only.
  const url =
    ConfigIM.normalizeServiceURL(value, allowLoopback && source === "environment") ??
    (legacyFixtureHTTP && source === "environment" && value.startsWith("http://")
      ? ConfigIM.normalizeServiceURL(`https://${value.slice(7)}`)?.replace(/^https:/, "http:")
      : undefined)
  if (!url)
    return yield* new IMKernelExchange.ExchangeError({
      code: "im_device_target_invalid",
      message: "IM service must be a credential-free HTTPS address without query or fragment",
      status: 400,
      retryable: false,
    })
  return { url, source }
})
