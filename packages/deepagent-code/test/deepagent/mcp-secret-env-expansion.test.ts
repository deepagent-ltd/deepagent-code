import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SecretStore } from "@/mcp/secret-store"

// M-CRED (S1-v3.5): `${VAR}` / `${VAR:-default}` env expansion (Step 1, the low-cost
// transition that mirrors claude-code). Resolution happens at connect time from the
// process environment; a missing var WARNS (by name) but does not block — it expands to
// "" so the connection path keeps going.

describe("M-CRED env expansion", () => {
  test("expands a plain ${VAR} from the environment", () => {
    const { value, missing } = SecretStore.expandEnvRefs("Bearer ${TOKEN}", { TOKEN: "ghp_real" })
    expect(value).toBe("Bearer ghp_real")
    expect(missing).toEqual([])
  })

  test("uses the :-default when the var is unset or empty", () => {
    expect(SecretStore.expandEnvRefs("${HOST:-localhost}", {}).value).toBe("localhost")
    expect(SecretStore.expandEnvRefs("${HOST:-localhost}", { HOST: "" }).value).toBe("localhost")
    // Set, non-empty → the env value wins over the default.
    expect(SecretStore.expandEnvRefs("${HOST:-localhost}", { HOST: "db.internal" }).value).toBe("db.internal")
  })

  test("missing var with no default warns (reported in `missing`) but does not block — expands to ''", () => {
    const { value, missing } = SecretStore.expandEnvRefs("postgres://${DB_USER}@h/db", {})
    // Does not throw; the missing var simply becomes empty and is surfaced for a warning.
    expect(value).toBe("postgres://@h/db")
    expect(missing).toEqual(["DB_USER"])
  })

  test("expands multiple references in one value", () => {
    const { value, missing } = SecretStore.expandEnvRefs("${A}/${B:-z}/${C}", { A: "1", C: "3" })
    expect(value).toBe("1/z/3")
    expect(missing).toEqual([]) // B had a default, A and C were present
  })

  test("classifies references vs plaintext", () => {
    expect(SecretStore.containsEnvRef("${X}")).toBe(true)
    expect(SecretStore.containsEnvRef("plain")).toBe(false)
    expect(SecretStore.isHandle("secret://acct")).toBe(true)
    expect(SecretStore.isReference("${X}")).toBe(true)
    expect(SecretStore.isReference("secret://acct")).toBe(true)
    expect(SecretStore.isReference("postgres://u:p@h/db")).toBe(false)
  })

  test("resolveValue passes a literal through unchanged and expands a ${VAR}", async () => {
    const store = SecretStore.make(SecretStore.inMemoryBackend())
    const literal = await Effect.runPromise(SecretStore.resolveValue("just-a-literal", store, {}))
    expect(literal).toBe("just-a-literal")
    const expanded = await Effect.runPromise(SecretStore.resolveValue("Bearer ${T}", store, { T: "tok" }))
    expect(expanded).toBe("Bearer tok")
  })

  test("resolveRecord drops nothing for env refs but warns on missing; keeps the partial value", async () => {
    const store = SecretStore.make(SecretStore.inMemoryBackend())
    const out = await Effect.runPromise(
      SecretStore.resolveRecord({ A: "${A}", B: "lit" }, store, { A: "av" }),
    )
    expect(out).toEqual({ A: "av", B: "lit" })
  })
})
