import { expect, test } from "bun:test"
import { createPublicKey, verify } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { IMDeviceProof } from "../../src/im/device-proof"
import { IMDeviceStore } from "../../src/im/device-store"
import { SecretStore } from "../../src/mcp/secret-store"

test("IM LPF cross-language vectors preserve UTF-8 and reject ambiguous or oversized input", () => {
  for (const [fields, hash] of [
    [[""], "ba6ab0e2a07c8f975cdd495615becd537f1cb76390ab74ddf64d6a32b6c3f2bd"],
    [["a", "bc"], "eb67c66be0ca0719474378cbfa132b5c8f058cfa3b68ed0c0244158071e4c176"],
    [["ab", "c"], "b40e60ae65130806c907c092a413f201e6b815968412e7ebefbd9137e07ac38e"],
    [["中文", "<>&", "line\u2028break", "\u2029", "ß", "𝟘"], "6eb13fd7c29fb53e18e699a4391032bb1f0f21299e4ec6057db1a15a8ab5ff19"],
  ] as const) expect(IMDeviceProof.digest(fields)).toBe(hash)
  for (const fields of [["\ud800"], ["\udc00"], ["x".repeat(4097)], Array.from({ length: 33 }, () => ""), ["x".repeat(4096), "x".repeat(4096)]])
    expect(() => IMDeviceProof.digest(fields)).toThrow()
})

test("IM device signers use ES256 public headers, fresh proofs and the exact transport target", () => {
  const key = IMDeviceProof.identity()
  expect(IMDeviceProof.identity(key.privateKey).jkt).toBe(key.jkt)
  const nonce = "a".repeat(43)
  const signed = IMDeviceProof.http(key, { method: "POST", url: "https://im.example/api/im/login?unused=1", nonce, credential: "login" })
  const [header, body, signature] = signed.split(".")
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk })
  expect(JSON.parse(Buffer.from(body, "base64url").toString())).toMatchObject({ htm: "POST", htu: "https://im.example/api/im/login", nonce, ath: IMDeviceProof.credentialHash("login") })
  expect(Buffer.from(signature, "base64url")).toHaveLength(64)
  expect(verify("sha256", Buffer.from(`${header}.${body}`), { key: createPublicKey(key.privateKey), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBeTrue()
  expect(IMDeviceProof.http(key, { method: "POST", url: "https://im.example/api/im/login", nonce })).not.toBe(signed)
  expect(() => IMDeviceProof.publicJwk({ ...key.publicJwk, d: "private" })).toThrow()
  expect(() => IMDeviceProof.target("http://127.0.0.1")).toThrow()
  expect(() => IMDeviceProof.target("https://user:pass@im.example")).toThrow()
  const source = { audience: "wss://im.example/im", appkey: "dac", token: "daim2.test", entitlementID: "b".repeat(32), bindingVersion: 1 }
  const challenge = { profile: IMDeviceProof.socketProfile, nonce, socketSession: "socket-actual-identity", audience: source.audience, appkey: source.appkey, credentialDigest: IMDeviceProof.sha256(source.token), expiresAt: Date.now() + 9000 } satisfies IMDeviceProof.SocketChallenge
  const proof = IMDeviceProof.socket(key, challenge, source)
  expect(JSON.parse(Buffer.from(proof.split(".")[1], "base64url").toString())).toMatchObject({ sid: challenge.socketSession, aud: source.audience, bindingVersion: 1 })
  expect(() => IMDeviceProof.socket(key, { ...challenge, audience: "wss://other.example/im" }, source)).toThrow()
  expect(() => IMDeviceProof.socket(key, { ...challenge, expiresAt: Date.now() - 1 }, source)).toThrow()
})

test("IM custody survives restart, refuses missing native custody and never replaces a marked identity", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dac-im-device-store-"))
  const backend = SecretStore.inMemoryBackend()
  try {
    const store = IMDeviceStore.make({ backend, directory })
    const first = await Effect.runPromise(store.preflight)
    const marker = path.join(directory, "identity.json")
    const recorded = readFileSync(marker, "utf8")
    expect(JSON.parse(recorded)).toEqual({ profile: first.profile, jkt: first.deviceJkt, publicJwk: first.publicJwk })
    const restarted = IMDeviceStore.make({ backend, directory })
    expect(await Effect.runPromise(restarted.preflight)).toEqual(first)
    writeFileSync(marker, "invalid JSON")
    await expect(Effect.runPromise(restarted.identity)).rejects.toThrow()
    expect(readFileSync(marker, "utf8")).toBe("invalid JSON")
    writeFileSync(marker, JSON.stringify({ jkt: "different" }))
    await expect(Effect.runPromise(restarted.identity)).rejects.toThrow()
    expect(readFileSync(marker, "utf8")).toBe(JSON.stringify({ jkt: "different" }))
    writeFileSync(marker, recorded)
    await Effect.runPromise(store.put("https://platform.example", "receipt-original", "receipt-secret"))
    expect(await Effect.runPromise(restarted.get("https://platform.example", "receipt-original"))).toBe("receipt-secret")
    await expect(Effect.runPromise(IMDeviceStore.make({ backend: { ...backend, available: async () => false }, directory }).preflight)).rejects.toThrow()
    await backend.remove("installation-p256-v1")
    await expect(Effect.runPromise(restarted.preflight)).rejects.toThrow()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
