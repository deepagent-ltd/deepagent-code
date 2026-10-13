import { createHash, createHmac, randomBytes } from "node:crypto"
import type { Context } from "effect"
import { ProxyEnv } from "@/util/proxy-env"
import { BuiltinNode } from "@deepagent-code/llm/route"

// This module is the first dependency of each executable entry. Capture before command modules
// run, then install only from those entries; importing a library root does not wrap global fetch.
const keys = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "BUN_CA_FILE",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
] as const
const snapshot = () =>
  JSON.stringify({
    environment: keys.map((key) => [key, process.env[key] || null]),
    execArgv: process.execArgv,
    runtime: process.versions.bun ?? `node:${process.versions.node}`,
  })
const initial = snapshot()
// This live-generation fingerprint is intentionally not reproducible across processes. Raw
// proxy credentials stay private; a public digest must not become a password-guessing oracle.
const configurationHash = createHmac("sha256", randomBytes(32))
  .update("dac.native-bootstrap.configuration.v1\0")
  .update(initial)
  .digest("hex")
const original = globalThis.fetch
const state: { installed: boolean; valid: boolean; wrapper?: typeof globalThis.fetch } = {
  installed: false,
  valid: true,
}

/** Ordinary requests retain the application's proxy behavior. Native requests use the Bun
 * builtin and bind the same startup proxy/TLS configuration, not a claim of direct networking. */
export function install() {
  if (state.installed) return current()
  if (globalThis.fetch !== original || snapshot() !== initial) state.valid = false
  if (!process.versions.bun) {
    state.wrapper = original
    state.installed = true
    state.valid = state.valid && BuiltinNode.install()
    return current()
  }
  for (const key of keys.slice(0, 6)) if (process.env[key] === "") delete process.env[key]
  const wrapper: typeof globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const proxy = ProxyEnv.getProxyForUrl(url)
      if (!proxy || (init as (RequestInit & { proxy?: unknown }) | undefined)?.proxy !== undefined)
        return original(input, init)
      return original(input, { ...init, proxy })
    },
    { preconnect: original.preconnect },
  )
  state.wrapper = wrapper
  state.installed = true
  globalThis.fetch = wrapper
  return current()
}

export function current() {
  return (
    state.installed &&
    state.valid &&
    globalThis.fetch === state.wrapper &&
    (process.versions.bun || BuiltinNode.current()) &&
    snapshot() === initial &&
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" &&
    !process.env.NODE_OPTIONS &&
    !process.env.BUN_OPTIONS &&
    !process.env.NODE_EXTRA_CA_CERTS &&
    !process.env.SSL_CERT_FILE &&
    !process.env.SSL_CERT_DIR &&
    !process.env.BUN_CA_FILE
  )
}

/** No environment values, proxy credentials, or CA paths leave this module. */
export const describe = () =>
  current()
    ? Object.freeze({
        runtime: process.versions.bun ? `bun:${process.versions.bun}` : `node:${process.versions.node}`,
        proxyPolicy: "startup-environment" as const,
        configurationHash,
      })
    : undefined

/** Fixed-purpose stable stamp of the ACTUAL private startup snapshot. The installation key and
 * raw proxy/TLS configuration never leave this function; the live public hash is not an input. */
export async function installationConfigurationStamp(
  scope: {
    instanceID: string
    securityNamespaceID: string
    operatorID: string
    targetID: string
  },
  expectedInstallationKeyHash: string,
  context?: Context.Context<never>,
) {
  if (!current() || (process.platform === "win32" && !context)) return undefined
  const { Effect } = await import("effect")
  const { LocalAuthority } = await import("@/installation/local-authority")
  const installation = await Effect.runPromise(context
    ? LocalAuthority.readInstallation.pipe(Effect.provide(context))
    : LocalAuthority.readInstallation)
  if (
    !current() ||
    installation.instanceID !== scope.instanceID ||
    createHash("sha256").update(installation.secret).digest("hex") !== expectedInstallationKeyHash
  )
    return undefined
  return createHmac("sha256", Buffer.from(installation.secret, "hex"))
    .update("dac.native-bootstrap.installation-configuration.v1\0")
    .update(JSON.stringify([scope.instanceID, scope.securityNamespaceID, scope.operatorID, scope.targetID, initial]))
    .digest("hex")
}

export * as NativeBootstrap from "./native-bootstrap"
