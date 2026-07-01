import { describe, expect, test } from "bun:test"
import { McpCatalog } from "@/mcp/catalog"
import { SecretStore } from "@/mcp/secret-store"

// M-CRED (S1-v3.5) acceptance (a): after enabling a `secret:true` credential, the
// instantiated config carries NO plaintext value — only a `${KEY}` env reference (or a
// caller-supplied `${VAR}` ref / `secret://` handle). The real value is resolved at
// connect time and never lands in cfg.mcp.

describe("M-CRED secret not in config", () => {
  test("postgres connection string never appears in config; env holds a ${KEY} ref", () => {
    const pg = McpCatalog.find("postgres-readonly")!
    const secret = "postgres://admin:hunter2@db.internal:5432/prod"
    const { config } = McpCatalog.instantiate(pg, { params: {}, credentialRefs: { DATABASE_URI: secret } })
    if (config.type !== "local") throw new Error("expected local config")
    const serialized = JSON.stringify(config)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("hunter2")
    expect(config.environment?.DATABASE_URI).toBe("${DATABASE_URI}")
    expect(SecretStore.isReference(config.environment!.DATABASE_URI)).toBe(true)
  })

  test("github PAT never appears in config; header holds a ${KEY} ref", () => {
    const github = McpCatalog.find("github")!
    const pat = "ghp_supersecretvalue123"
    const { config } = McpCatalog.instantiate(github, {
      params: {},
      credentialRefs: { GITHUB_PERSONAL_ACCESS_TOKEN: pat },
    })
    if (config.type !== "remote") throw new Error("expected remote config")
    expect(JSON.stringify(config)).not.toContain(pat)
    expect(config.headers?.Authorization).toBe("Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}")
  })

  test("a caller-supplied ${VAR} reference is preserved verbatim (not re-wrapped)", () => {
    const pg = McpCatalog.find("postgres-readonly")!
    const { config } = McpCatalog.instantiate(pg, {
      params: {},
      credentialRefs: { DATABASE_URI: "${MY_DB_URI}" },
    })
    if (config.type !== "local") throw new Error("expected local config")
    expect(config.environment?.DATABASE_URI).toBe("${MY_DB_URI}")
  })

  test("a caller-supplied secret:// handle is preserved verbatim", () => {
    const pg = McpCatalog.find("postgres-readonly")!
    const handle = SecretStore.makeHandle("mcp:postgres-readonly:environment:DATABASE_URI")
    const { config } = McpCatalog.instantiate(pg, {
      params: {},
      credentialRefs: { DATABASE_URI: handle },
    })
    if (config.type !== "local") throw new Error("expected local config")
    expect(config.environment?.DATABASE_URI).toBe(handle)
    expect(SecretStore.isHandle(config.environment!.DATABASE_URI)).toBe(true)
  })
})
