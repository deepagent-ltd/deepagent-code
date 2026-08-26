export * as ServerCapabilities from "./server-capabilities"

import { Schema } from "effect"
import { Policy } from "./policy"
import { Wildcard } from "./util/wildcard"

/**
 * ServerCapabilities — an admin-controlled feature policy that the runtime
 * enforces. This is a GENERIC mechanism: the policy statements it produces are
 * plain {@link Policy.Info} rules, so the same enforcement path serves both
 *
 *   - server mode: the platform injects a resolved capability set via the
 *     `DEEPAGENT_SERVER_CAPABILITIES` env (see {@link fromEnv}); and
 *   - local/desktop mode: a future config source can supply the same shape.
 *
 * Keeping the translation here (core, source-agnostic) means enforcement adds
 * no server-only semantics to the runtime kernels — they only ever see policy
 * statements. See docs/code-server-runtime-v1.md §3.1.
 */
export class Info extends Schema.Class<Info>("ServerCapabilities.Info")({
  /** Whether provider configuration may be edited. */
  providerConfigEditable: Schema.Boolean.pipe(Schema.optional),
  /** Allowed provider ids; when set, providers outside the list are denied. */
  allowedProviders: Schema.Array(Schema.String).pipe(Schema.optional),
  /** Whether the user may supply their own provider keys (BYOK). */
  allowUserByok: Schema.Boolean.pipe(Schema.optional),
  /** Whether shell / PTY is permitted. */
  allowShell: Schema.Boolean.pipe(Schema.optional),
  /** Whether `git push` is permitted. */
  allowGitPush: Schema.Boolean.pipe(Schema.optional),
  /** Whether cloning public repos over the network is permitted. */
  allowPublicRepoClone: Schema.Boolean.pipe(Schema.optional),
  /** Whether MCP servers may be installed. */
  allowMcpInstall: Schema.Boolean.pipe(Schema.optional),
  /** Whether editor extensions may be installed. */
  allowExtensionInstall: Schema.Boolean.pipe(Schema.optional),
  maxProjectCount: Schema.Number.pipe(Schema.optional),
  maxUploadSize: Schema.Number.pipe(Schema.optional),
  /**
   * Model the IM agent runs with, as `"providerID/modelID"` (e.g.
   * `"deepseek/deepseek-chat"`). When set, an IM agent turn uses this model
   * instead of the agent's own default — letting the platform centrally pick a
   * fast/cheap model for chat without touching per-agent config. Unset leaves
   * the kernel's normal precedence (agent model → session model → provider
   * default) intact. See {@link parseModelRef}.
   */
  imModel: Schema.String.pipe(Schema.optional),
}) {}

/**
 * Parse an `imModel`-style `"providerID/modelID"` reference into the parts the
 * session prompt expects. The modelID itself may contain slashes (e.g.
 * `"openrouter/anthropic/claude-3.5"`), so only the FIRST slash separates the
 * provider from the model. Returns null when the string is missing a slash or
 * either side is empty — the caller then falls back to normal model precedence.
 */
export function parseModelRef(ref: string | undefined): { providerID: string; modelID: string } | null {
  if (!ref) return null
  const slash = ref.indexOf("/")
  if (slash <= 0) return null
  const providerID = ref.slice(0, slash)
  const modelID = ref.slice(slash + 1)
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

const decode = Schema.decodeUnknownOption(Info, {
  errors: "all",
  onExcessProperty: "ignore",
})

/**
 * Action namespace the capability gates evaluate against. Kernels call
 * `Policy.evaluate(<action>, <resource>, "allow")` at their choke points; a
 * capability set below turns the relevant boolean off into a `deny` statement.
 */
export const Actions = {
  shell: "shell.exec",
  gitPush: "git.push",
  repoCloneRemote: "repo.clone.remote",
  mcpInstall: "mcp.install",
  extensionInstall: "extension.install",
  providerConfigWrite: "provider.config.write",
  providerByok: "provider.byok",
  providerUse: "provider.use",
} as const

/**
 * Translate a capability set into deny-only policy statements. We only ever emit
 * `deny` rules: absence of a capability restriction leaves the kernel's own
 * default (`allow`) intact, so an empty/partial capability set is safe and does
 * not accidentally forbid anything it didn't mean to.
 */
export function toStatements(info: Info): Policy.Info[] {
  const out: Policy.Info[] = []
  const deny = (action: string, resource = "*") =>
    out.push(new Policy.Info({ action, effect: "deny", resource }))

  if (info.allowShell === false) deny(Actions.shell)
  if (info.allowGitPush === false) deny(Actions.gitPush)
  if (info.allowPublicRepoClone === false) deny(Actions.repoCloneRemote)
  if (info.allowMcpInstall === false) deny(Actions.mcpInstall)
  if (info.allowExtensionInstall === false) deny(Actions.extensionInstall)
  if (info.providerConfigEditable === false) deny(Actions.providerConfigWrite)
  if (info.allowUserByok === false) deny(Actions.providerByok)

  // allowedProviders is an allowlist: deny everything, then re-allow the listed
  // ones (last-match-wins in Policy.evaluate).
  if (info.allowedProviders && info.allowedProviders.length > 0) {
    deny(Actions.providerUse)
    for (const id of info.allowedProviders) {
      out.push(new Policy.Info({ action: Actions.providerUse, effect: "allow", resource: id }))
    }
  }

  return out
}

/**
 * Parse a ServerCapabilities set from the `DEEPAGENT_SERVER_CAPABILITIES` env
 * (JSON). Returns null when unset or invalid — the caller then applies no
 * capability-derived statements (local/desktop default).
 */
export function fromEnv(): Info | null {
  const raw = process.env.DEEPAGENT_SERVER_CAPABILITIES
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const decoded = decode(parsed)
  return decoded._tag === "Some" ? decoded.value : null
}

/** Convenience: statements derived from the env source (empty when unset). */
export function envStatements(): Policy.Info[] {
  const info = fromEnv()
  return info ? toStatements(info) : []
}

/**
 * Service-free capability check for runtimes that don't mount the core Policy
 * service (e.g. the deepagent-code instance runtime, a flat layer stack with no
 * `Location.Service` and no `policy.load` call). Reads the same env source as
 * {@link envStatements} and applies the same last-match-wins evaluation that
 * `Policy.evaluate` uses. Returns `true` (allowed) when no capability set is
 * injected — deny-only, fail-open-when-unset, identical to the Policy path.
 *
 * Prefer `Policy.evaluate` inside core, location-scoped services (bash, catalog)
 * where the loaded Policy is in scope; use this only where it is not. See
 * docs/code-server-runtime-v1.md §3.1.
 */
export function isAllowed(action: string, resource = "*"): boolean {
  const statements = envStatements()
  if (statements.length === 0) return true
  const match = statements.findLast(
    (statement) => Wildcard.match(action, statement.action) && Wildcard.match(resource, statement.resource),
  )
  return match ? match.effect === "allow" : true
}
