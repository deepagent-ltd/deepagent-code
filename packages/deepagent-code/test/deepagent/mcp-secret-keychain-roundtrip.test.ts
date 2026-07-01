import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SecretStore } from "@/mcp/secret-store"

// M-CRED (S1-v3.5) acceptance (b): put → resolve roundtrip with an INJECTED backend, so the
// test never touches the real OS keychain. The store wraps any Backend (macOS Keychain /
// libsecret / DPAPI / file fallback) behind the same put/resolve contract; here we inject an
// in-memory backend to prove the contract.

describe("M-CRED keychain roundtrip (mock backend)", () => {
  test("put returns a secret:// handle; resolve returns the stored value", async () => {
    const store = SecretStore.make(SecretStore.inMemoryBackend("mock-keychain"))
    const handle = await Effect.runPromise(store.put("mcp:pg:env:DATABASE_URI", "postgres://u:p@h/db"))
    expect(handle).toBe("secret://mcp:pg:env:DATABASE_URI")
    const value = await Effect.runPromise(store.resolve(handle))
    expect(value).toBe("postgres://u:p@h/db")
  })

  test("resolve of an unknown handle returns undefined (caller drops the value)", async () => {
    const store = SecretStore.make(SecretStore.inMemoryBackend())
    const value = await Effect.runPromise(store.resolve("secret://does-not-exist"))
    expect(value).toBeUndefined()
  })

  test("remove deletes the secret", async () => {
    const store = SecretStore.make(SecretStore.inMemoryBackend())
    const handle = await Effect.runPromise(store.put("acct", "v"))
    await Effect.runPromise(store.remove(handle))
    expect(await Effect.runPromise(store.resolve(handle))).toBeUndefined()
  })

  test("an injected failing backend surfaces as undefined on resolve (never throws into connect path)", async () => {
    const flaky: SecretStore.Backend = {
      id: "flaky",
      available: async () => true,
      put: async () => {},
      get: async () => {
        throw new Error("keychain unlock prompt cancelled")
      },
      remove: async () => {},
    }
    const store = SecretStore.make(flaky)
    const value = await Effect.runPromise(store.resolve("secret://x"))
    expect(value).toBeUndefined()
  })

  test("resolveValue resolves a handle through the injected store", async () => {
    const backend = SecretStore.inMemoryBackend()
    await backend.put("acct", "real-secret")
    const store = SecretStore.make(backend)
    const resolved = await Effect.runPromise(
      SecretStore.resolveValue(SecretStore.makeHandle("acct"), store, {}),
    )
    expect(resolved).toBe("real-secret")
  })

  test("testLayer provides an injectable in-memory backend", async () => {
    const program = Effect.gen(function* () {
      const store = yield* SecretStore.Service
      const handle = yield* store.put("k", "s")
      return yield* store.resolve(handle)
    })
    const backend = SecretStore.inMemoryBackend()
    const result = await Effect.runPromise(program.pipe(Effect.provide(SecretStore.testLayer(backend))))
    expect(result).toBe("s")
  })
})
