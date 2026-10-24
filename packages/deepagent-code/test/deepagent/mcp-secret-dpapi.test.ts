import { describe, expect, test } from "bun:test"
import fs from "fs"
import { spawn } from "node:child_process"
import { DpapiHelper } from "@/mcp/dpapi-helper"
import path from "path"
import { Deferred, Effect, Fiber } from "effect"
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

// These are real bounded subprocess/pipe tests of the exchange only. They do not
// qualify the Windows Native factory, held image or DPAPI itself.
describe("managed DPAPI helper exchange", () => {
  test("one binary operation closes stdin and accepts exactly one bounded response", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const chunks=[]; process.stdin.on("data",b=>chunks.push(b));
      process.stdin.on("end",()=>{
        const all=Buffer.concat(chunks),n=all.readUInt32BE(0),request=JSON.parse(all.subarray(4,4+n));
        if(request.op!=="mcp_dpapi_unprotect"||request.length!==all.length-4-n)process.exit(9);
        const body=all.subarray(4+n),meta=Buffer.from(JSON.stringify({version:1,id:request.id,status:"dpapi",code:null,payload_bytes:body.length}));
        const frame=Buffer.alloc(4);frame.writeUInt32BE(meta.length);process.stdout.end(Buffer.concat([frame,meta,body]));
      });`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
    const input = Buffer.alloc(65_536, 42)
    const value = await DpapiHelper.exchange(child, input, false, AbortSignal.timeout(2000))
    expect(value).toEqual(input)
    expect(input.every((byte) => byte === 42)).toBe(true)
    expect(child.exitCode).toBe(0)
    value.fill(0)
  })

  test("abort terminates the real child and waits for close before rejecting", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const observed = { closed: false }
    child.once("close", () => {
      observed.closed = true
    })
    await expect(DpapiHelper.exchange(child, Buffer.from([1]), false, AbortSignal.timeout(30))).rejects.toThrow()
    expect(observed.closed).toBe(true)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  test("oversized output and malformed frames stop the child without returning bytes", async () => {
    for (const output of ["Buffer.alloc(70000)", "Buffer.from([0,0,0,1,123])"]) {
      const child = spawn(
        process.execPath,
        ["-e", `process.stdin.resume();process.stdin.on("end",()=>process.stdout.end(${output}))`],
        { stdio: ["pipe", "pipe", "pipe"] },
      )
      const observed = { closed: false }
      child.once("close", () => {
        observed.closed = true
      })
      await expect(DpapiHelper.exchange(child, Buffer.from([1]), false, AbortSignal.timeout(2000))).rejects.toThrow()
      expect(observed.closed).toBe(true)
    }
  })

  test("input and stderr limits refuse the exchange only after real child close", async () => {
    const oversized = spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const closed = { input: false, stderr: false }
    oversized.once("close", () => {
      closed.input = true
    })
    await expect(
      DpapiHelper.exchange(oversized, Buffer.alloc(65_537), true, AbortSignal.timeout(2000)),
    ).rejects.toThrow()
    expect(closed.input).toBe(true)
    const errors = spawn(
      process.execPath,
      [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write(Buffer.alloc(4097));setInterval(()=>{},1000)})",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
    errors.once("close", () => {
      closed.stderr = true
    })
    await expect(DpapiHelper.exchange(errors, Buffer.from([1]), false, AbortSignal.timeout(2000))).rejects.toThrow()
    expect(closed.stderr).toBe(true)
  })
})

test("managed DPAPI scoped exchange fences late acquisition and clears interrupted ownership", async () => {
  const script = `process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>{
    const meta=Buffer.from(JSON.stringify({version:1,id:"mcp-dpapi",status:"dpapi",code:null,payload_bytes:3}));
    const frame=Buffer.alloc(4);frame.writeUInt32BE(meta.length);process.stdout.end(Buffer.concat([frame,meta,Buffer.from([1,2,3])]));
  },80))`
  const late = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] })
  const observed = { closed: false, delivered: false, bytes: undefined as Uint8Array | undefined }
  late.once("close", () => {
    observed.closed = true
  })
  const pending = Effect.runFork(
    DpapiHelper.scopedExchange(late, Buffer.from([1]), false, AbortSignal.timeout(2000)).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          observed.delivered = true
        }),
      ),
      Effect.scoped,
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  await Effect.runPromise(Fiber.interrupt(pending))
  expect(observed.closed).toBe(true)
  expect(observed.delivered).toBe(false)

  const acquired = await Effect.runPromise(Deferred.make<void>())
  const blocked = await Effect.runPromise(Deferred.make<void>())
  const held = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] })
  const owner = Effect.runFork(
    Effect.gen(function* () {
      observed.bytes = yield* DpapiHelper.scopedExchange(held, Buffer.from([1]), false, AbortSignal.timeout(2000))
      yield* Deferred.succeed(acquired, undefined)
      yield* Deferred.await(blocked)
    }).pipe(Effect.scoped),
  )
  await Effect.runPromise(Deferred.await(acquired))
  expect(observed.bytes).toEqual(Buffer.from([1, 2, 3]))
  await Effect.runPromise(Fiber.interrupt(owner))
  expect(observed.bytes?.every((byte) => byte === 0)).toBe(true)
})
