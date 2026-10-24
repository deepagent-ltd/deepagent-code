import { expect } from "bun:test"
import { createPublicKey, verify } from "node:crypto"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { IMDeviceStore } from "@/im/device-store"
import { IMDeviceProof } from "@/im/device-proof"
import { IMEntitlement } from "@/im/entitlement"
import { SecretStore } from "@/mcp/secret-store"
import { testEffect } from "../lib/effect"

const it = testEffect(FetchHttpClient.layer)
const fixture = Effect.gen(function* () {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dac-entitlement-read-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
  const backend = SecretStore.inMemoryBackend()
  const device = IMDeviceStore.make({ backend, directory })
  const facts = {
    requests: [] as string[],
    challenges: 0,
    proofIDs: new Set<string>(),
    state: "expired",
    reply: "valid",
    hold: false,
    release: undefined as (() => void) | undefined,
    entered: false,
  }
  const scope: { current: object | undefined; url: string | null } = { current: {}, url: null }
  const credential = `iml2.${"c".repeat(64)}`
  const key = yield* device.identity
  const binding = {
    profile: "dac-im-device-v1",
    imCredential: credential,
    entitlementID: "e".repeat(32),
    deviceJkt: key.jkt,
    bindingVersion: 1,
    uuid: "u".repeat(32),
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      facts.requests.push(url.pathname)
      if (url.pathname === "/im/api/im/plans")
        return Response.json({
          success: true,
          data: {
            version: "dac-im-plans-v1",
            planVersion: "im-plans-2026-10-19",
            salesAvailable: false,
            serverObservedAt: Date.now(),
            purchaseURL: null,
            plans: [
              {
                planID: "im-year",
                priceCredits: "1",
                term: { kind: "calendarYears", years: 1 },
                maxBoundDevices: 1,
                autoRenew: false,
              },
              {
                planID: "im-three-years",
                priceCredits: "2",
                term: { kind: "calendarYears", years: 3 },
                maxBoundDevices: 1,
                autoRenew: false,
              },
              {
                planID: "im-lifetime",
                priceCredits: "9.9",
                term: { kind: "lifetime" },
                maxBoundDevices: 1,
                autoRenew: false,
              },
            ],
          },
        })
      const parts = request.headers.get("DPoP")!.split(".")
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString())
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString())
      expect(
        verify(
          "sha256",
          Buffer.from(`${parts[0]}.${parts[1]}`),
          {
            key: createPublicKey({ key: header.jwk, format: "jwk" }),
            dsaEncoding: "ieee-p1363",
          },
          Buffer.from(parts[2], "base64url"),
        ),
      ).toBe(true)
      expect(claims.htm).toBe(request.method)
      expect(claims.htu).toBe(request.url)
      expect(facts.proofIDs.has(claims.jti)).toBe(false)
      facts.proofIDs.add(claims.jti)
      if (url.pathname === "/im/api/im/device/challenges") {
        const body = await request.json()
        expect(body.purpose).toBe("entitlement-read")
        expect(body.transactionID).toBe(binding.entitlementID)
        expect(body.requestHash).toBe(
          IMDeviceProof.digest([
            "dac.im.entitlement-read.v1",
            scope.url!,
            binding.entitlementID,
            IMDeviceProof.sha256(credential),
            key.jkt,
          ]),
        )
        facts.challenges++
        return Response.json({
          success: true,
          data: {
            profile: binding.profile,
            challengeID: "a".repeat(32),
            nonce: "n".repeat(43),
            expiresAt: Date.now() + 59000,
            deviceJkt: key.jkt,
            purpose: body.purpose,
          },
        })
      }
      if (url.pathname !== "/im/api/im/entitlement") return new Response(null, { status: 404 })
      expect(request.headers.get("authorization")).toBe(`DPoP ${credential}`)
      expect(request.headers.get("X-IM-Entitlement-ID")).toBe(binding.entitlementID)
      expect(request.headers.get("X-IM-Challenge-ID")).toBe("a".repeat(32))
      expect(claims.nonce).toBe("n".repeat(43))
      expect(claims.ath).toBe(IMDeviceProof.credentialHash(credential))
      facts.entered = true
      if (facts.hold)
        await new Promise<void>((resolve) => {
          facts.release = resolve
        })
      if (facts.reply === "unsupported") return new Response(null, { status: 404 })
      if (facts.reply === "oversize") return new Response("x".repeat(65537))
      const now = Date.now()
      return Response.json({
        success: true,
        data: {
          version: "dac-im-entitlement-v1",
          ...binding,
          imCredential: undefined,
          realm: facts.reply === "wrong-realm" ? "https://wrong.example/im" : server.url.origin + "/im",
          planID: "im-year",
          planVersion: "im-plans-2026-10-19",
          state: facts.state,
          validityKnown: true,
          lifetime: false,
          validFrom: now - 20000,
          expiresAt: facts.state === "expired" ? now - 10000 : now + 10000,
          serverObservedAt: now,
        },
      })
    },
  })
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      facts.release?.()
      server.stop(true)
    }),
  )
  scope.url = server.url.origin + "/im"
  yield* device.put(scope.url, "login", JSON.stringify(binding))
  const reads = IMEntitlement.make({
    device,
    http: yield* HttpClient.HttpClient,
    resolveURL: Effect.sync(() => scope.url),
    scope: () => scope.current,
    allowLoopback: true,
  })
  return { device, reads, facts, scope, directory, binding }
})

it.effect(
  "reads a real catalog and device-bound active, expired and revoked rights without login or transaction requests",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      expect(yield* f.reads.plans).toMatchObject({
        state: "known",
        catalog: { purchaseURL: null, salesAvailable: false },
      })
      for (const state of ["expired", "revoked", "active"]) {
        f.facts.state = state
        expect(yield* f.reads.entitlement).toMatchObject({ state: "known", entitlement: { state, lifetime: false } })
      }
      expect(
        f.facts.requests.every((url) =>
          ["/im/api/im/plans", "/im/api/im/device/challenges", "/im/api/im/entitlement"].includes(url),
        ),
      ).toBe(true)
      expect(f.facts.challenges).toBe(3)
    }),
)
it.effect("unknown contracts, foreign realms and oversized bodies never become a known entitlement", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    for (const reply of ["unsupported", "wrong-realm", "oversize"]) {
      f.facts.reply = reply
      expect(yield* f.reads.entitlement).toEqual({
        state: "unknown",
        reason: reply === "unsupported" ? "unsupported" : "invalid_response",
      })
    }
  }),
)
it.effect("a fresh unbound read creates no installation key, marker or HTTP request", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const directory = path.join(f.directory, "never-provisioned")
    const empty = IMDeviceStore.make({ directory, backend: SecretStore.inMemoryBackend() })
    const reads = IMEntitlement.make({
      device: empty,
      http: yield* HttpClient.HttpClient,
      resolveURL: Effect.succeed(f.scope.url),
      scope: () => f.scope.current,
      allowLoopback: true,
    })
    expect(yield* reads.entitlement).toEqual({ state: "unknown", reason: "not_bound" })
    expect(existsSync(path.join(directory, "identity.json"))).toBe(false)
    expect(f.facts.requests).toEqual([])
  }),
)
it.effect("retires a successful response after the realm scope or stored binding changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    for (const mode of ["scope", "binding"]) {
      f.facts.hold = true
      f.facts.entered = false
      const result = Effect.runPromise(f.reads.entitlement)
      const deadline = Date.now() + 2000
      while (!f.facts.entered) {
        if (Date.now() > deadline) throw new Error("The isolated entitlement request did not arrive")
        yield* Effect.promise(() => Bun.sleep(1))
      }
      if (mode === "scope") f.scope.current = {}
      if (mode === "binding")
        yield* f.device.put(f.scope.url!, "login", JSON.stringify({ ...f.binding, bindingVersion: 2 }))
      f.facts.release!()
      expect(yield* Effect.promise(() => result)).toEqual({ state: "unknown", reason: "scope_changed" })
      if (mode === "binding") yield* f.device.put(f.scope.url!, "login", JSON.stringify(f.binding))
    }
  }),
)
