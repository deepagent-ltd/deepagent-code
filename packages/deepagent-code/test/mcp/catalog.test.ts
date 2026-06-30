import { describe, expect, it } from "bun:test"
import { McpCatalog } from "@/mcp/catalog"

// M1 / M1-A / M7 (S1-v3.4): preset catalog invariants and instantiation.
describe("mcp.catalog", () => {
  it("M1: lists preset entries (metadata only), and every entry is defaultEnabled:false", () => {
    const entries = McpCatalog.list()
    expect(entries.length).toBeGreaterThanOrEqual(6)
    for (const entry of entries) {
      // The catalog never auto-connects: the invariant is a literal false on every entry.
      expect(entry.defaultEnabled).toBe(false)
      expect(entry.source).toBe("opensource") // all six current entries reuse open-source servers
      expect(entry.repo).toBeTruthy()
    }
  })

  it("M1: covers the four preset directions (M3-M6)", () => {
    const directions = new Set(McpCatalog.list().map((e) => e.direction))
    expect(directions.has("git_platform")).toBe(true)
    expect(directions.has("files_search")).toBe(true)
    expect(directions.has("db_readonly")).toBe(true)
    expect(directions.has("browser_fetch")).toBe(true)
  })

  it("M7: default-safe templates — GitHub remote points at the read-only path", () => {
    const github = McpCatalog.find("github")!
    expect(github.transport).toBe("remote")
    expect(github.urlTemplate).toContain("/readonly")
    expect(github.defaultReadOnly).toBe(true)
  })

  it("M7: default-safe templates — postgres is fixed to restricted (read-only) mode", () => {
    const pg = McpCatalog.find("postgres-readonly")!
    expect(pg.commandTemplate).toContain("--access-mode=restricted")
    // unrestricted must NOT be exposed as a one-click option
    expect(pg.commandTemplate?.some((t) => /unrestricted/.test(t))).toBe(false)
    expect(pg.riskTier).toBe("read_only")
  })

  it("M7: default-safe templates — playwright is isolated + headless", () => {
    const browser = McpCatalog.find("browser")!
    expect(browser.commandTemplate).toContain("--isolated")
    expect(browser.commandTemplate).toContain("--headless")
  })

  it("M7: credentials are declared by key-name only and marked secret", () => {
    for (const entry of McpCatalog.list()) {
      for (const cred of entry.credentials) {
        expect(typeof cred.key).toBe("string")
        expect(cred.key.length).toBeGreaterThan(0)
        // No catalog entry may carry a credential VALUE — only the key + description.
        expect(Object.keys(cred)).toEqual(expect.arrayContaining(["key", "description", "required", "secret"]))
        expect((cred as unknown as Record<string, unknown>).value).toBeUndefined()
        // Connection strings / tokens / login state are all secrets.
        expect(cred.secret).toBe(true)
      }
    }
  })

  it("M1: instantiate(filesystem) expands a multi-value param into repeated trailing args + enabled:true", () => {
    const fs = McpCatalog.find("filesystem")!
    const { name, config } = McpCatalog.instantiate(fs, {
      params: { ALLOWED_DIRS: ["/a", "/b"] },
      credentialRefs: {},
    })
    expect(name).toBe("filesystem")
    if (config.type !== "local") throw new Error("expected local config")
    expect(config.command).toEqual(["npx", "-y", "@modelcontextprotocol/server-filesystem", "/a", "/b"])
    expect(config.enabled).toBe(true)
  })

  it("M1/M7: instantiate(postgres) routes the connection string through env, never the command line", () => {
    const pg = McpCatalog.find("postgres-readonly")!
    const { config } = McpCatalog.instantiate(pg, {
      params: {},
      credentialRefs: { DATABASE_URI: "postgres://u:p@h/db" },
    })
    if (config.type !== "local") throw new Error("expected local config")
    // The secret must be in env, not argv (process-table leakage).
    expect(config.environment?.DATABASE_URI).toBe("postgres://u:p@h/db")
    expect(config.command.join(" ")).not.toContain("postgres://")
  })

  it("M1: instantiate(github) builds a remote config with the PAT in an Authorization header", () => {
    const github = McpCatalog.find("github")!
    const { config } = McpCatalog.instantiate(github, {
      params: {},
      credentialRefs: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
    })
    if (config.type !== "remote") throw new Error("expected remote config")
    expect(config.url).toContain("/readonly")
    expect(config.headers?.Authorization).toBe("Bearer ghp_x")
  })

  it("M1: instantiate fails-closed on a missing required param", () => {
    const fs = McpCatalog.find("filesystem")!
    expect(() => McpCatalog.instantiate(fs, { params: {}, credentialRefs: {} })).toThrow(/missing required param/i)
  })

  it("M1: instantiate fails-closed on a missing required credential", () => {
    const pg = McpCatalog.find("postgres-readonly")!
    expect(() => McpCatalog.instantiate(pg, { params: {}, credentialRefs: {} })).toThrow(/missing required credential/i)
  })

  it("M1: optional credentials may be omitted (git has no creds, fetch none)", () => {
    const git = McpCatalog.find("git")!
    const { config } = McpCatalog.instantiate(git, { params: { REPO_PATH: "/repo" }, credentialRefs: {} })
    if (config.type !== "local") throw new Error("expected local config")
    expect(config.command).toContain("/repo")
  })

  // #1 regression: GitHub PAT is OPTIONAL. Enabling github with no token must NOT throw — the
  // Authorization header is dropped entirely (so remote OAuth can take over), not left as "Bearer {{…}}".
  it("M1: github with no PAT instantiates without an Authorization header (no throw)", () => {
    const github = McpCatalog.find("github")!
    const { config } = McpCatalog.instantiate(github, { params: {}, credentialRefs: {} })
    if (config.type !== "remote") throw new Error("expected remote config")
    expect(config.url).toContain("/readonly")
    expect(config.headers?.Authorization).toBeUndefined()
    expect(JSON.stringify(config)).not.toContain("{{") // no literal placeholder leaked
  })

  // #6 regression: the playwright login-state path is an OPTIONAL command arg. Omitted => the
  // --storage-state token is dropped; supplied => it appears in argv.
  it("M1: browser drops --storage-state when no path is given", () => {
    const browser = McpCatalog.find("browser")!
    const { config } = McpCatalog.instantiate(browser, { params: {}, credentialRefs: {} })
    if (config.type !== "local") throw new Error("expected local config")
    expect(config.command.some((t) => t.includes("storage-state"))).toBe(false)
    expect(config.command.join(" ")).not.toContain("{{")
  })

  it("M1: browser includes --storage-state=<path> when supplied", () => {
    const browser = McpCatalog.find("browser")!
    const { config } = McpCatalog.instantiate(browser, {
      params: { PLAYWRIGHT_STORAGE_STATE: "/tmp/state.json" },
      credentialRefs: {},
    })
    if (config.type !== "local") throw new Error("expected local config")
    expect(config.command).toContain("--storage-state=/tmp/state.json")
  })

  // M7: instantiate persists the entry's risk tier as DISPLAY metadata. NOTE: the live permission
  // gate does NOT trust this field — it re-derives the tier via deriveTier (see the deriveTier suite).
  it("M7: instantiate persists the entry riskTier onto the config (display metadata)", () => {
    const pg = McpCatalog.find("postgres-readonly")!
    const { config: pgCfg } = McpCatalog.instantiate(pg, {
      params: { DATABASE_URI: "postgres://u:p@h/db" },
      credentialRefs: { DATABASE_URI: "postgres://u:p@h/db" },
    })
    expect(pgCfg.riskTier).toBe("read_only")

    const fs = McpCatalog.find("filesystem")!
    const { config: fsCfg } = McpCatalog.instantiate(fs, { params: { ALLOWED_DIRS: ["/a"] }, credentialRefs: {} })
    expect(fsCfg.riskTier).toBe("write_guarded")

    const github = McpCatalog.find("github")!
    const { config: ghCfg } = McpCatalog.instantiate(github, { params: {}, credentialRefs: {} })
    expect(ghCfg.riskTier).toBe(github.riskTier)
  })
})

// M7 (S1-v3.4) SECURITY: deriveTier matches a LIVE config against the catalog templates to recover
// the risk tier — the unforgeable trust source the permission gate uses (it ignores persisted
// `riskTier`). A non-matching config derives undefined → the gate fails closed to ask.
describe("mcp.catalog.deriveTier", () => {
  it("derives read_only for a config matching the postgres read-only template", () => {
    const pg = McpCatalog.find("postgres-readonly")!
    const { config } = McpCatalog.instantiate(pg, {
      params: { DATABASE_URI: "postgres://u:p@h/db" },
      credentialRefs: { DATABASE_URI: "postgres://u:p@h/db" },
    })
    expect(McpCatalog.deriveTier(config)).toBe("read_only")
  })

  it("derives write_guarded for git (local literal+placeholder) and filesystem (multi-tail)", () => {
    const git = McpCatalog.find("git")!
    const { config: gitCfg } = McpCatalog.instantiate(git, { params: { REPO_PATH: "/repo" }, credentialRefs: {} })
    expect(McpCatalog.deriveTier(gitCfg)).toBe("write_guarded")

    const fs = McpCatalog.find("filesystem")!
    const { config: fsCfg } = McpCatalog.instantiate(fs, {
      params: { ALLOWED_DIRS: ["/a", "/b", "/c"] },
      credentialRefs: {},
    })
    expect(McpCatalog.deriveTier(fsCfg)).toBe("write_guarded")
  })

  it("derives write_guarded for the github remote url template (placeholders wildcarded)", () => {
    const github = McpCatalog.find("github")!
    const { config } = McpCatalog.instantiate(github, { params: {}, credentialRefs: {} })
    expect(McpCatalog.deriveTier(config)).toBe("write_guarded")
  })

  it("derives external_fetch for the browser template with the optional storage-state token dropped", () => {
    const browser = McpCatalog.find("browser")!
    const { config } = McpCatalog.instantiate(browser, { params: {}, credentialRefs: {} })
    expect(McpCatalog.deriveTier(config)).toBe("external_fetch")
  })

  // The core attack: a forged config that LABELS itself read_only but whose command does NOT match
  // any catalog template must derive undefined (→ gate asks), defeating the auto-allow impersonation.
  it("returns undefined for a forged read_only label on a non-matching command", () => {
    const forged = { type: "local" as const, command: ["echo", "pwned"], enabled: true, riskTier: "read_only" as const }
    expect(McpCatalog.deriveTier(forged)).toBeUndefined()
  })

  it("returns undefined for a config that resembles postgres but with extra/wrong args", () => {
    // Right binary, wrong access mode → must NOT match the restricted read-only template.
    const unrestricted = {
      type: "local" as const,
      command: ["postgres-mcp", "--access-mode=unrestricted"],
      enabled: true,
    }
    expect(McpCatalog.deriveTier(unrestricted)).toBeUndefined()
    // Extra trailing arg beyond the literal template → no match.
    const extra = {
      type: "local" as const,
      command: ["postgres-mcp", "--access-mode=restricted", "--evil"],
      enabled: true,
    }
    expect(McpCatalog.deriveTier(extra)).toBeUndefined()
  })

  it("returns undefined for a hand-added server with no catalog resemblance", () => {
    expect(McpCatalog.deriveTier({ type: "local", command: ["my-server"], enabled: true })).toBeUndefined()
    expect(McpCatalog.deriveTier({ type: "remote", url: "https://example.com/mcp", enabled: true })).toBeUndefined()
  })
})
