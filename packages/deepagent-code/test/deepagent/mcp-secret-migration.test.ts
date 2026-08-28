import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ConfigMCPV1 } from "@deepagent-code/core/v1/config/mcp"
import { SecretStore } from "@/mcp/secret-store"

// M-CRED (S1-v3.5) acceptance (d): existing PLAINTEXT secrets in cfg.mcp are migrated into the
// secret store and replaced with `secret://` handles — transactionally (put+verify before erase),
// so a partial failure never loses a credential. Already-referenced values are left alone.

const secretKeys = new Set(["DATABASE_URI", "GITHUB_PERSONAL_ACCESS_TOKEN"])

describe("M-CRED migration", () => {
  test("migrates a plaintext env secret to a handle; the store holds the real value", async () => {
    const mcp: Record<string, ConfigMCPV1.Info> = {
      "postgres-readonly": {
        type: "local",
        command: ["postgres-mcp", "--access-mode=restricted"],
        environment: { DATABASE_URI: "postgres://u:secret@h/db" },
        enabled: true,
      },
    }
    const backend = SecretStore.inMemoryBackend()
    const store = SecretStore.make(backend)
    const outcome = await Effect.runPromise(SecretStore.migratePlaintextSecrets(mcp, store, { secretEnvKeys: secretKeys }))

    expect(outcome.changed).toBe(true)
    expect(outcome.moved.length).toBe(1)
    const newConfig = outcome.config["postgres-readonly"]
    if (newConfig.type !== "local") throw new Error("expected local")
    // Config now holds a handle, not the plaintext.
    expect(SecretStore.isHandle(newConfig.environment!.DATABASE_URI)).toBe(true)
    expect(JSON.stringify(outcome.config)).not.toContain("secret@h")
    // The real value is retrievable from the store via the handle.
    const resolved = await Effect.runPromise(store.resolve(newConfig.environment!.DATABASE_URI))
    expect(resolved).toBe("postgres://u:secret@h/db")
  })

  test("migrates a plaintext Authorization header to a handle", async () => {
    const mcp: Record<string, ConfigMCPV1.Info> = {
      github: { type: "remote", url: "https://api.example/mcp", headers: { Authorization: "Bearer ghp_plain" }, enabled: true },
    }
    const store = SecretStore.make(SecretStore.inMemoryBackend())
    const outcome = await Effect.runPromise(SecretStore.migratePlaintextSecrets(mcp, store))
    const cfg = outcome.config.github
    if (cfg.type !== "remote") throw new Error("expected remote")
    expect(SecretStore.isHandle(cfg.headers!.Authorization)).toBe(true)
    expect(JSON.stringify(outcome.config)).not.toContain("ghp_plain")
  })

  test("leaves existing ${VAR} references and handles untouched (idempotent)", async () => {
    const mcp: Record<string, ConfigMCPV1.Info> = {
      a: { type: "local", command: ["x"], environment: { DATABASE_URI: "${DB}" }, enabled: true },
      b: { type: "remote", url: "u", headers: { Authorization: "secret://acct" }, enabled: true },
    }
    const store = SecretStore.make(SecretStore.inMemoryBackend())
    const outcome = await Effect.runPromise(SecretStore.migratePlaintextSecrets(mcp, store, { secretEnvKeys: secretKeys }))
    expect(outcome.changed).toBe(false)
    expect(outcome.moved.length).toBe(0)
    expect(outcome.config).toEqual(mcp)
  })

  test("TRANSACTIONAL: a backend put failure preserves THAT plaintext and never drops the credential", async () => {
    // A backend that fails to store anything → migration must NOT erase the plaintext.
    const failing: SecretStore.Backend = {
      id: "failing",
      available: async () => true,
      put: async () => {
        throw new Error("keychain write denied")
      },
      get: async () => undefined,
      remove: async () => {},
    }
    const store = SecretStore.make(failing)
    const mcp: Record<string, ConfigMCPV1.Info> = {
      "postgres-readonly": {
        type: "local",
        command: ["postgres-mcp"],
        environment: { DATABASE_URI: "postgres://u:keepme@h/db" },
        enabled: true,
      },
    }
    const outcome = await Effect.runPromise(SecretStore.migratePlaintextSecrets(mcp, store, { secretEnvKeys: secretKeys }))
    expect(outcome.changed).toBe(false)
    expect(outcome.failures.length).toBe(1)
    const cfg = outcome.config["postgres-readonly"]
    if (cfg.type !== "local") throw new Error("expected local")
    // The credential is STILL in the config — not lost.
    expect(cfg.environment!.DATABASE_URI).toBe("postgres://u:keepme@h/db")
  })

  test("TRANSACTIONAL: a verify mismatch preserves the plaintext (no silent loss)", async () => {
    // Backend that "accepts" the put but returns a wrong value on read-back.
    const corrupting: SecretStore.Backend = {
      id: "corrupting",
      available: async () => true,
      put: async () => {},
      get: async () => "WRONG",
      remove: async () => {},
    }
    const store = SecretStore.make(corrupting)
    const mcp: Record<string, ConfigMCPV1.Info> = {
      pg: { type: "local", command: ["x"], environment: { DATABASE_URI: "postgres://u:keepme@h/db" }, enabled: true },
    }
    const outcome = await Effect.runPromise(SecretStore.migratePlaintextSecrets(mcp, store, { secretEnvKeys: secretKeys }))
    expect(outcome.failures.length).toBe(1)
    const cfg = outcome.config.pg
    if (cfg.type !== "local") throw new Error("expected local")
    expect(cfg.environment!.DATABASE_URI).toBe("postgres://u:keepme@h/db")
  })

  test("PARTIAL: one server migrates while another fails — migrated stays migrated, failed stays plaintext", async () => {
    // Backend that succeeds for the first account and fails for the second.
    const calls: string[] = []
    const map = new Map<string, string>()
    const selective: SecretStore.Backend = {
      id: "selective",
      available: async () => true,
      put: async (account, secret) => {
        calls.push(account)
        if (account.includes(":b:") || account.includes("server-b")) throw new Error("denied for b")
        map.set(account, secret)
      },
      get: async (account) => map.get(account),
      remove: async () => {},
    }
    const store = SecretStore.make(selective)
    const mcp: Record<string, ConfigMCPV1.Info> = {
      "server-a": { type: "local", command: ["x"], environment: { DATABASE_URI: "postgres://a:secret@h/db" }, enabled: true },
      "server-b": { type: "local", command: ["y"], environment: { DATABASE_URI: "postgres://b:secret@h/db" }, enabled: true },
    }
    const outcome = await Effect.runPromise(SecretStore.migratePlaintextSecrets(mcp, store, { secretEnvKeys: secretKeys }))
    expect(outcome.moved.length).toBe(1)
    expect(outcome.failures.length).toBe(1)
    const a = outcome.config["server-a"]
    const b = outcome.config["server-b"]
    if (a.type !== "local" || b.type !== "local") throw new Error("expected local")
    expect(SecretStore.isHandle(a.environment!.DATABASE_URI)).toBe(true)
    expect(b.environment!.DATABASE_URI).toBe("postgres://b:secret@h/db") // preserved
  })
})
