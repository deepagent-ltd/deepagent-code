import { ConfigMCPV1 } from "@deepagent-code/core/v1/config/mcp"

/**
 * M1 / M1-A (S1-v3.4): preset MCP catalog.
 *
 * A declarative, vetted list of MCP servers deepagent-code can enable in one click.
 * The catalog is METADATA + TEMPLATES only — it never connects anything on its own
 * (`defaultEnabled` is a `false` literal at the type level). Enabling an entry
 * instantiates it into a normal `cfg.mcp` entry via `instantiate()`, exactly as if
 * the user had hand-written it.
 *
 * Four invariants (M7) are load-bearing and must not be relaxed per entry:
 *  - provenance is explicit (M2): enabled servers' tools are attributed via the
 *    WeakMap provenance side-channel, never guessed from the tool name.
 *  - default not connected: `defaultEnabled: false` (readonly literal).
 *  - credentials by KEY NAME only in the catalog: an entry declares which credentials it needs
 *    (key + description), never values. M-CRED (S1-v3.4 M7 defer, delivered S1-v3.5): the runtime
 *    value path is now indirected too — `instantiate` writes `secret:true` credentials as a `${KEY}`
 *    env REFERENCE (or passes through a caller-supplied `${VAR}` ref / `secret://` keychain handle),
 *    NEVER the plaintext value. The real value is resolved from the process env / OS keychain at
 *    connect time (`mcp/index.ts` + `secret-store.ts`) and never lands in `cfg.mcp`, logs, or
 *    snapshots. Existing plaintext configs are migrated to handles at startup (see
 *    `SecretStore.migratePlaintextSecrets`). The KEY-NAME-only guarantee now holds for BOTH the
 *    catalog definition and the runtime value path.
 *  - dangerous writes fail-closed: anything not provably read-only defaults to
 *    `write_guarded` → `ctx.ask` approval. This is LIVE, and the tier is NOT trusted from persisted
 *    config: `mcp/index.ts` DERIVES it at `tools()` time by matching the live server config against
 *    these catalog templates (`deriveTier`). The persisted `riskTier` field (written by `instantiate`)
 *    is attacker-writable and therefore ignored by the gate — a server earns `read_only` auto-allow
 *    only if its command genuinely matches the vetted read-only template.
 */

/** Risk tier → default permission derivation (M7). read_only allows reads; write_guarded / external_fetch default to ask. */
export type RiskTier = "read_only" | "write_guarded" | "external_fetch"

/** Reuse provenance (M7 decision gate): opensource = reuse as-is; adapted = wrapped; self = built here. */
export type ReuseSource = "opensource" | "adapted" | "self"

export type CatalogDirection = "git_platform" | "files_search" | "db_readonly" | "browser_fetch"

/** Credential need: declares the KEY NAME + description only, never a value (value lives in secure storage, M7). */
export interface CredentialSpec {
  key: string // e.g. "GITHUB_PERSONAL_ACCESS_TOKEN" / "DATABASE_URI"
  description: string
  required: boolean
  secret: boolean // true → value must not enter context/logs (connection strings, tokens, passwords)
}

/** A parameter the user fills at enable time (e.g. allowed dirs, connection string), substituted into templates. */
export interface ParamSpec {
  key: string // placeholder name, e.g. "ALLOWED_DIRS" / "DATABASE_URI"
  description: string
  required: boolean
  multi?: boolean // multi-value (e.g. several allowed directories)
}

export interface McpCatalogEntry {
  id: string // unique within the catalog, e.g. "github" | "filesystem"
  title: string
  description: string // one-liner for the user
  direction: CatalogDirection

  // —— reuse provenance (M7 decision gate, §M8) ——
  source: ReuseSource
  repo?: string // opensource source repo
  upstreamPin?: string // suggested pinned version/tag (supply-chain discipline)

  // —— connection templates (instantiated into ConfigMCPV1.Info) ——
  transport: "local" | "remote"
  commandTemplate?: string[] // local: contains {{PARAM}} placeholders
  urlTemplate?: string // remote: contains {{PARAM}} placeholders
  envTemplate?: Record<string, string> // local: env name → {{CRED}}/{{PARAM}} placeholder

  // —— security (M7) ——
  credentials: CredentialSpec[]
  params: ParamSpec[]
  riskTier: RiskTier
  defaultReadOnly: boolean // whether instantiation applies the server's own read-only switch

  // —— invariant ——
  readonly defaultEnabled: false // always false: the catalog never auto-connects
}

/** Filled values supplied by the user at enable time. credentialRefs map a cred key → a secure-storage reference, never a raw value. */
export interface FilledEntry {
  params: Record<string, string | readonly string[]>
  credentialRefs: Record<string, string>
}

/** Raised when a required param/credential is missing, or a template references an unknown placeholder. */
export class CatalogInstantiateError extends Error {
  readonly _tag = "CatalogInstantiateError"
  constructor(message: string) {
    super(message)
    this.name = "CatalogInstantiateError"
  }
}

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g

/** True if a string contains any `{{PLACEHOLDER}}` token. */
const containsPlaceholder = (s: string): boolean => /\{\{[A-Z0-9_]+\}\}/.test(s)

/**
 * M-CRED (S1-v3.5): true if a supplied credential ref is ALREADY an indirection — a
 * `${VAR}` / `${VAR:-default}` env reference or a `secret://` keychain handle — and should
 * therefore be persisted verbatim rather than re-wrapped as a `${KEY}` reference. Mirrors
 * `SecretStore.isReference`; kept local to avoid a catalog ⇄ secret-store import cycle.
 */
function isCredentialReference(s: string): boolean {
  return s.startsWith("secret://") || /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/.test(s)
}

/** Substitute {{KEY}} placeholders from a flat lookup. Throws on an unresolved placeholder (fail-closed). */
function substitute(template: string, lookup: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = lookup[key]
    if (value === undefined) {
      throw new CatalogInstantiateError(`unresolved placeholder {{${key}}} (no param/credential supplied)`)
    }
    return value
  })
}

/**
 * Like `substitute`, but returns `undefined` when the template references a placeholder that has no
 * supplied value. Used for OPTIONAL env vars / headers (e.g. the GitHub `Authorization` header when
 * no PAT is given): the whole entry is dropped rather than left with a literal `{{TOKEN}}` or throwing
 * — which lets remote OAuth take over. Required placeholders are already validated before this runs.
 */
function trySubstitute(template: string, lookup: Record<string, string>): string | undefined {
  let unresolved = false
  const out = template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = lookup[key]
    if (value === undefined) {
      unresolved = true
      return ""
    }
    return value
  })
  return unresolved ? undefined : out
}

/**
 * Instantiate a catalog entry + the user's filled params/credential references into a
 * concrete `cfg.mcp` entry (to be written via `MCP.Service.add`). This is the ONLY bridge
 * from catalog metadata to a live config — and it enforces the invariants:
 *  - required params/credentials must be present (else throws, fail-closed).
 *  - `multi` params expand into repeated trailing args (filesystem allowed-dirs pattern).
 *  - secret credentials flow through `envTemplate` only — never spliced into the command line
 *    (avoids process-table leakage); the config stores nothing but the reference value the
 *    caller already resolved from secure storage.
 */
export function instantiate(entry: McpCatalogEntry, filled: FilledEntry): { name: string; config: ConfigMCPV1.Info } {
  // 1. Validate required inputs (fail-closed).
  for (const p of entry.params) {
    if (p.required && filled.params[p.key] === undefined) {
      throw new CatalogInstantiateError(`missing required param "${p.key}" for catalog entry "${entry.id}"`)
    }
  }
  for (const c of entry.credentials) {
    if (c.required && filled.credentialRefs[c.key] === undefined) {
      throw new CatalogInstantiateError(`missing required credential "${c.key}" for catalog entry "${entry.id}"`)
    }
  }

  // 2. Build a scalar lookup for single-value placeholder substitution (params + cred refs).
  const scalarLookup: Record<string, string> = {}
  for (const [k, v] of Object.entries(filled.params)) {
    if (typeof v === "string") scalarLookup[k] = v
  }
  // M-CRED (S1-v3.5): for `secret:true` credentials, NEVER splice the raw value into config.
  // Instead persist a `${KEY}` env REFERENCE (resolved from the process env at connect time)
  // — unless the caller already supplied an indirection (`${VAR}` ref or `secret://` handle),
  // which is passed through verbatim. Non-secret credential refs (e.g. file paths) pass through.
  const secretKeys = new Set(entry.credentials.filter((c) => c.secret).map((c) => c.key))
  for (const [k, v] of Object.entries(filled.credentialRefs)) {
    if (secretKeys.has(k) && !isCredentialReference(v)) {
      scalarLookup[k] = `\${${k}}`
    } else {
      scalarLookup[k] = v
    }
  }

  // 3. Multi-value params (e.g. ALLOWED_DIRS) expand a single template token into several args.
  const multiKeys = new Set(entry.params.filter((p) => p.multi).map((p) => p.key))
  // Optional params/credentials whose unsupplied references should DROP their command token / env var
  // rather than throw. Required ones were validated above.
  const optionalKeys = new Set([
    ...entry.params.filter((p) => !p.required).map((p) => p.key),
    ...entry.credentials.filter((c) => !c.required).map((c) => c.key),
  ])

  if (entry.transport === "local") {
    if (!entry.commandTemplate) {
      throw new CatalogInstantiateError(`local catalog entry "${entry.id}" has no commandTemplate`)
    }
    const command: string[] = []
    for (const token of entry.commandTemplate) {
      const multiMatch = token.match(/^\{\{([A-Z0-9_]+)\}\}$/)
      if (multiMatch && multiKeys.has(multiMatch[1])) {
        const values = filled.params[multiMatch[1]]
        const list = Array.isArray(values) ? values : values === undefined ? [] : [values]
        if (list.length === 0) {
          throw new CatalogInstantiateError(
            `multi-value param "${multiMatch[1]}" for "${entry.id}" resolved to nothing`,
          )
        }
        command.push(...list)
      } else if (containsPlaceholder(token) && optionalKeys.size > 0) {
        // A command token referencing an OPTIONAL param/credential that is unsupplied is dropped
        // entirely (e.g. `--storage-state={{PLAYWRIGHT_STORAGE_STATE}}` when no path given). Required
        // references were validated above, so a drop here is always an optional one.
        const resolved = trySubstitute(token, scalarLookup)
        if (resolved !== undefined) command.push(resolved)
      } else {
        command.push(substitute(token, scalarLookup))
      }
    }
    const environment: Record<string, string> = {}
    for (const [envName, tpl] of Object.entries(entry.envTemplate ?? {})) {
      // Optional credential/param references that are unsupplied drop the whole env var (not a literal
      // {{...}}). Required references were already validated above, so a drop here is always optional.
      const value = trySubstitute(tpl, scalarLookup)
      if (value !== undefined) environment[envName] = value
    }
    const config: ConfigMCPV1.Info = {
      type: "local",
      command,
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      enabled: true,
      // M7 (S1-v3.4): persist the vetted tier as DISPLAY metadata only. The permission gate does NOT
      // trust this field (it is attacker-writable via the add endpoint / project-local config); it
      // re-derives the tier at runtime by matching this config against the catalog (see `deriveTier`).
      riskTier: entry.riskTier,
    }
    return { name: entry.id, config }
  }

  // remote
  if (!entry.urlTemplate) {
    throw new CatalogInstantiateError(`remote catalog entry "${entry.id}" has no urlTemplate`)
  }
  const url = substitute(entry.urlTemplate, scalarLookup)
  const headers: Record<string, string> = {}
  for (const [headerName, tpl] of Object.entries(entry.envTemplate ?? {})) {
    // Optional credential references (e.g. GitHub PAT) drop the whole header when unsupplied, letting
    // remote OAuth take over instead of sending "Bearer {{...}}" or throwing.
    const value = trySubstitute(tpl, scalarLookup)
    if (value !== undefined) headers[headerName] = value
  }
  const config: ConfigMCPV1.Info = {
    type: "remote",
    url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    enabled: true,
    // M7 (S1-v3.4): see local branch — persisted as DISPLAY metadata; the gate re-derives via deriveTier.
    riskTier: entry.riskTier,
  }
  return { name: entry.id, config }
}

// CATALOG_ENTRIES_PLACEHOLDER

/**
 * The six preset entries (M3-M6, per §M8 selection matrix). Field values are the
 * vetted defaults; `defaultEnabled` is the readonly `false` literal on every entry.
 */
export const CATALOG: readonly McpCatalogEntry[] = [
  // ── M3: GitHub platform (remote, read-only path by default) ───────────────
  {
    id: "github",
    title: "GitHub",
    description: "GitHub platform operations (PR/issue/review/actions/code scanning). Read-only by default.",
    direction: "git_platform",
    source: "opensource",
    repo: "github/github-mcp-server",
    transport: "remote",
    // Read-only path: the /readonly suffix only exposes read tools (write tools are not served).
    // To allow writes, switch to https://api.githubcopilot.com/mcp/ (still gated by M7 ctx.ask).
    urlTemplate: "https://api.githubcopilot.com/mcp/readonly",
    // remote prefers OAuth (token in memory only); PAT is the fallback, passed via Authorization header.
    envTemplate: { Authorization: "Bearer {{GITHUB_PERSONAL_ACCESS_TOKEN}}" },
    credentials: [
      {
        key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        description: "GitHub PAT (fallback when OAuth unavailable)",
        required: false,
        secret: true,
      },
    ],
    params: [],
    riskTier: "write_guarded",
    defaultReadOnly: true,
    defaultEnabled: false,
  },

  // ── M3: local git reference server (local stdio) ──────────────────────────
  {
    id: "git",
    title: "Git (local)",
    description:
      "Read/search a local git repository. Working-tree changes prefer the worktree service; this is read-only inspection.",
    direction: "git_platform",
    source: "opensource",
    repo: "modelcontextprotocol/servers · src/git",
    transport: "local",
    commandTemplate: ["uvx", "mcp-server-git", "--repository", "{{REPO_PATH}}"],
    credentials: [],
    params: [
      {
        key: "REPO_PATH",
        description: "absolute path to the git repo (defaults to the working directory)",
        required: false,
      },
    ],
    riskTier: "write_guarded",
    defaultReadOnly: true,
    defaultEnabled: false,
  },

  // ── M4: files/search (local stdio, allowed-dirs sandbox) ──────────────────
  {
    id: "filesystem",
    title: "Filesystem (external roots)",
    description:
      "Controlled access to explicitly authorized external directories. For in-project files use built-in read/grep/code_intel.",
    direction: "files_search",
    source: "opensource",
    repo: "modelcontextprotocol/servers · src/filesystem",
    transport: "local",
    upstreamPin: "@modelcontextprotocol/server-filesystem",
    // The server only exposes the directories listed on the command line; multiple dirs expand to repeated trailing args.
    commandTemplate: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "{{ALLOWED_DIRS}}"],
    credentials: [],
    params: [
      {
        key: "ALLOWED_DIRS",
        description: "directories to allow (one or more; out-of-bounds rejected by server sandbox + adapter)",
        required: true,
        multi: true,
      },
    ],
    riskTier: "write_guarded",
    defaultReadOnly: false, // server ships write/delete tools → writes gated by M7 ctx.ask
    defaultEnabled: false,
  },

  // ── M5: read-only database (local stdio, restricted read-only transactions) ─
  {
    id: "postgres-readonly",
    title: "PostgreSQL (read-only)",
    description:
      "Read-only Postgres queries. restricted mode = read-only transactions + resource limits. Writes/DDL rejected.",
    direction: "db_readonly",
    source: "opensource",
    repo: "crystaldba/postgres-mcp",
    transport: "local",
    // Fixed restricted; unrestricted is NOT exposed as a one-click option. Connection string via env, not argv
    // (avoids process-table leakage).
    commandTemplate: ["postgres-mcp", "--access-mode=restricted"],
    envTemplate: { DATABASE_URI: "{{DATABASE_URI}}" },
    credentials: [
      {
        key: "DATABASE_URI",
        description: "Postgres connection string (contains password — treated as secret)",
        required: true,
        secret: true,
      },
    ],
    params: [],
    riskTier: "read_only",
    defaultReadOnly: true,
    defaultEnabled: false,
  },

  // ── M6: lightweight fetch (local stdio) ────────────────────────────────────
  {
    id: "fetch",
    title: "Web Fetch",
    description:
      "Fetch a single page and convert it to LLM-friendly content. Returned only on explicit agent request, summarized.",
    direction: "browser_fetch",
    source: "opensource",
    repo: "modelcontextprotocol/servers · src/fetch",
    transport: "local",
    commandTemplate: ["uvx", "mcp-server-fetch"],
    credentials: [],
    params: [],
    riskTier: "external_fetch",
    defaultReadOnly: true,
    defaultEnabled: false,
  },

  // ── M6: browser automation (local stdio, isolated + headless) ──────────────
  {
    id: "browser",
    title: "Browser (Playwright)",
    description:
      "Browser automation (a11y snapshot, not screenshots). Isolated profile + headless. Write-class actions need approval.",
    direction: "browser_fetch",
    source: "opensource",
    repo: "microsoft/playwright-mcp",
    transport: "local",
    upstreamPin: "@playwright/mcp@latest",
    // --isolated: profile in memory only (no disk); --headless: no UI. origins blocklist is NOT a security boundary.
    // The trailing --storage-state token is dropped entirely when no login-state path is supplied (optional).
    commandTemplate: [
      "npx",
      "@playwright/mcp@latest",
      "--isolated",
      "--headless",
      "--storage-state={{PLAYWRIGHT_STORAGE_STATE}}",
    ],
    credentials: [],
    // login-state is a FILE PATH (not a secret value); optional. Dropped from argv when unset.
    params: [{ key: "PLAYWRIGHT_STORAGE_STATE", description: "login-state file path (optional)", required: false }],
    riskTier: "external_fetch",
    defaultReadOnly: false, // includes navigate/click/fill write-class automation → default ask
    defaultEnabled: false,
  },
] as const

/**
 * M7 (S1-v3.4) SECURITY: derive a server's risk tier by STRUCTURALLY MATCHING its live config
 * against the catalog templates — NOT by reading a persisted `riskTier` flag.
 *
 * Why: `config.mcp[name].riskTier` is attacker-writable (the `add` HTTP endpoint forwards client
 * config verbatim; project-local `.deepagent-code/deepagent-code.json` is auto-merged and not
 * gitignored). Trusting it lets a hand-crafted server claim `read_only` to win auto-allow. The
 * catalog, by contrast, is CODE: a server whose `command` matches the postgres read-only template
 * genuinely IS `postgres-mcp --access-mode=restricted` — safety comes from the command itself plus
 * the SQL guard, not from a forgeable label. An attacker can forge the label but not the behavior.
 *
 * Matching rules (conservative — a non-match falls through to fail-closed `ask`, never auto-allow):
 *  - local: walk the entry's `commandTemplate` and the config's `command` in lockstep. A literal
 *    token must equal the corresponding arg. A bare `{{MULTI}}` token consumes one-or-more args
 *    (multi param). A bare single `{{KEY}}` token consumes exactly one arg, OR is skipped if it is
 *    an OPTIONAL key (the template token is dropped at instantiate when unsupplied). A token mixing
 *    literal + placeholder (e.g. `--storage-state={{X}}`) matches an arg with the same literal prefix.
 *  - remote: the entry's `urlTemplate` (with placeholders turned into wildcards) must match the url.
 *  Returns the FIRST matching entry's `riskTier`, else `undefined` (→ caller fails closed).
 *
 * The only tier that grants auto-allow is `read_only`, whose sole source (postgres-readonly) has a
 * FULLY LITERAL command, so its match is exact equality with zero ambiguity.
 */
export function deriveTier(config: ConfigMCPV1.Info): RiskTier | undefined {
  for (const entry of CATALOG) {
    if (entry.transport !== config.type) continue
    if (config.type === "local") {
      if (entry.transport !== "local" || !entry.commandTemplate) continue
      if (matchLocalCommand(entry, config.command)) return entry.riskTier
    } else {
      if (entry.transport !== "remote" || !entry.urlTemplate) continue
      if (matchRemoteUrl(entry.urlTemplate, config.url)) return entry.riskTier
    }
  }
  return undefined
}

const BARE_PLACEHOLDER = /^\{\{([A-Z0-9_]+)\}\}$/

/** Structurally match a catalog `commandTemplate` against a live `command` array (see deriveTier). */
function matchLocalCommand(entry: McpCatalogEntry, command: readonly string[]): boolean {
  const template = entry.commandTemplate!
  const multiKeys = new Set(entry.params.filter((p) => p.multi).map((p) => p.key))
  const optionalKeys = new Set([
    ...entry.params.filter((p) => !p.required).map((p) => p.key),
    ...entry.credentials.filter((c) => !c.required).map((c) => c.key),
  ])
  let ti = 0
  let ci = 0
  while (ti < template.length) {
    const token = template[ti]
    const bare = token.match(BARE_PLACEHOLDER)
    if (bare) {
      const key = bare[1]
      if (multiKeys.has(key)) {
        // Multi placeholder: must consume at least one arg; greedily take the rest only if it is the
        // last template token, otherwise take exactly one (our templates put multi tokens last).
        if (ti === template.length - 1) {
          if (ci >= command.length) return false
          return true // remaining args all belong to the multi param
        }
        if (ci >= command.length) return false
        ci++
        ti++
        continue
      }
      // Single placeholder: consume one arg, OR skip the token entirely if it is optional and the
      // template token was dropped at instantiate (so the arg simply isn't there).
      if (ci < command.length) {
        ci++
        ti++
        continue
      }
      if (optionalKeys.has(key)) {
        ti++
        continue
      }
      return false
    }
    if (containsPlaceholder(token)) {
      // Mixed literal + placeholder (e.g. `--storage-state={{X}}`). For OPTIONAL keys the whole token
      // is dropped at instantiate when unsupplied, so its absence is allowed. When present, match by
      // the literal prefix before the first `{{`.
      const prefix = token.slice(0, token.indexOf("{{"))
      const referenced = (token.match(/\{\{([A-Z0-9_]+)\}\}/g) ?? []).map((m) => m.slice(2, -2))
      const allOptional = referenced.every((k) => optionalKeys.has(k))
      if (ci < command.length && command[ci].startsWith(prefix)) {
        ci++
        ti++
        continue
      }
      if (allOptional) {
        ti++
        continue
      }
      return false
    }
    // Literal token: must equal the corresponding arg exactly.
    if (ci >= command.length || command[ci] !== token) return false
    ci++
    ti++
  }
  // All template tokens consumed; the command must be fully consumed too (no extra args).
  return ci === command.length
}

/** Match a catalog `urlTemplate` (placeholders → wildcards) against a live url. */
function matchRemoteUrl(urlTemplate: string, url: string): boolean {
  if (!containsPlaceholder(urlTemplate)) return urlTemplate === url
  // Build a regex: escape literals, turn each {{KEY}} into a non-greedy non-empty wildcard.
  const escaped = urlTemplate
    .split(/\{\{[A-Z0-9_]+\}\}/)
    .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+?")
  return new RegExp(`^${escaped}$`).test(url)
}

/** Look up a single catalog entry by id. */
export function find(id: string): McpCatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id)
}

/** List the full catalog (metadata only; nothing is connected). */
export function list(): readonly McpCatalogEntry[] {
  return CATALOG
}

export * as McpCatalog from "./catalog"
