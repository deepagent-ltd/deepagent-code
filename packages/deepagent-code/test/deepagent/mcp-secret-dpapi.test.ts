import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { SecretStore } from "@/mcp/secret-store"
import type { Codec } from "@/mcp/dpapi"
import { dpapiCodec } from "#dpapi"
import { tmpRootShared } from "../fixture/fixture"

// W-b / W-01: the Windows DPAPI backend keeps the Backend contract (put → handle → resolve →
// remove) and stores ONLY DPAPI ciphertext in its envelope file. The codec is the OS crypto
// seam; tests inject a stand-in so the store logic (envelope, account map, base64, failure
// paths) runs for real without needing Windows.

const tmpFile = () => path.join(fs.mkdtempSync(tmpRootShared()), "mcp-secrets.dpapi.json")

// Deterministic stand-in for the crypt32/powershell engines; copy-then-reverse so the input
// buffer is never mutated.
const reversibleCodec: Codec = {
  id: "test-reversible",
  available: async () => true,
  protect: async (plain) => new Uint8Array(plain).reverse(),
  unprotect: async (cipher) => new Uint8Array(cipher).reverse(),
}

// Simulates CryptUnprotectData failing (tampered ciphertext / different user key): the get
// path must surface as undefined, never throw into the connect path.
const unprotectThrows: Codec = {
  id: "test-unprotect-throws",
  available: async () => true,
  protect: reversibleCodec.protect,
  unprotect: async () => {
    throw new Error("CryptUnprotectData failed")
  },
}

describe("M-CRED Windows DPAPI backend", () => {
  test("the real codec is platform-guarded: available exactly on win32", async () => {
    // Off win32 the backend must report unavailable so selection degrades to the file
    // fallback; on the Windows CI matrix the crypt32 FFI load is expected to succeed.
    expect(await SecretStore.dpapiBackend(tmpFile()).available()).toBe(process.platform === "win32")
    // bun test always selects the bun-side codec via the #dpapi import condition.
    expect(dpapiCodec.id).toBe("crypt32-ffi")
  })

  test("put → handle → resolve → remove roundtrip through an injected codec", async () => {
    const store = SecretStore.make(SecretStore.dpapiBackend(tmpFile(), reversibleCodec))
    expect(store.backendId).toBe("dpapi")
    expect(store.isFallback).toBe(false)

    const handle = await Effect.runPromise(store.put("mcp:pg:env:DATABASE_URI", "postgres://u:p@h/db"))
    expect(handle).toBe("secret://mcp:pg:env:DATABASE_URI")
    expect(await Effect.runPromise(store.resolve(handle))).toBe("postgres://u:p@h/db")

    await Effect.runPromise(store.remove(handle))
    expect(await Effect.runPromise(store.resolve(handle))).toBeUndefined()
  })

  test("the envelope file holds ciphertext, never the plaintext secret", async () => {
    const file = tmpFile()
    const store = SecretStore.make(SecretStore.dpapiBackend(file, reversibleCodec))
    await Effect.runPromise(store.put("acct", "topsecret"))

    const envelope = fs.readFileSync(file, "utf8")
    expect(envelope).not.toContain("topsecret")
    // The stored value is base64 of the codec's ciphertext — the envelope shape the
    // crypt32 FFI (CLI) and powershell ProtectedData (sidecar) codecs both produce.
    expect(envelope).toContain(Buffer.from(Buffer.from("topsecret", "utf8").reverse()).toString("base64"))
  })

  test("a secret stored before an engine failure resolves to undefined, not a throw", async () => {
    // Written with the reversible codec, then read back with a failing unprotect —
    // resolve must swallow the failure (caller drops the value, never crashes connect).
    const file = tmpFile()
    await SecretStore.dpapiBackend(file, reversibleCodec).put("acct", "topsecret")

    const store = SecretStore.make(SecretStore.dpapiBackend(file, unprotectThrows))
    expect(await Effect.runPromise(store.resolve("secret://acct"))).toBeUndefined()
  })

  test("a missing envelope resolves to undefined rather than throwing", async () => {
    const store = SecretStore.make(SecretStore.dpapiBackend(tmpFile(), reversibleCodec))
    expect(await Effect.runPromise(store.resolve("secret://nope"))).toBeUndefined()
  })
})
