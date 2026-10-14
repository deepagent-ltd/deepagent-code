import { describe, expect } from "bun:test"
import { createPublicKey, verify } from "node:crypto"
import { mkdtempSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { IMActivationTable } from "@deepagent-code/core/im/activation.sql"
import { Auth } from "@/auth"
import { IMActivation } from "@/im/activation"
import { IMDeviceStore } from "@/im/device-store"
import { IMDeviceProof } from "@/im/device-proof"
import { IMDeviceTransport } from "@/im/device-transport"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { SecretStore } from "@/mcp/secret-store"
import { testEffect } from "../lib/effect"

const root = mkdtempSync(path.join(os.tmpdir(), "dac-im-bound-http-"))
const it = testEffect(
  Layer.mergeAll(
    Layer.suspend(() => Database.layerFromPath(path.join(root, `${crypto.randomUUID()}.sqlite`))),
    Auth.defaultLayer,
    FetchHttpClient.layer,
  ),
)
const fixture = Effect.gen(function* () {
  const backend = SecretStore.inMemoryBackend()
  const facts = {
    purchase: 0,
    migration: 0,
    login: 0,
    failLoginStore: false,
    paidPending: false,
    challengeUnavailable: false,
    proofRejected: false,
    paidRejected: false,
    feeLost: false,
    dropBeforeAdmission: false,
    recoverSubmit: false,
  }
  const device = IMDeviceStore.make({
    directory: path.join(root, crypto.randomUUID()),
    backend: {
      ...backend,
      put: async (key, value) => {
        if (facts.failLoginStore && key.endsWith(":login")) throw new Error("owned login-store fault")
        await backend.put(key, value)
      },
    },
  })
  const key = yield* device.identity
  const receipts = new Map<string, { secret: string; method: "api_key" | "activation_code" }>()
  const migration = { id: "", receipt: "" }
  const proofs = new Set<string>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const parts = request.headers.get("DPoP")!.split(".")
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString())
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString())
      expect(header.jwk).toEqual(key.publicJwk)
      expect(
        verify(
          "sha256",
          Buffer.from(`${parts[0]}.${parts[1]}`),
          {
            key: createPublicKey({ format: "jwk", key: header.jwk }),
            dsaEncoding: "ieee-p1363",
          },
          Buffer.from(parts[2], "base64url"),
        ),
      ).toBeTrue()
      expect(claims.htm).toBe(request.method)
      expect(claims.htu).toBe(url.origin + url.pathname)
      expect(proofs.has(claims.jti)).toBeFalse()
      proofs.add(claims.jti)
      if (url.pathname === "/api/im/device/challenges") {
        if (facts.challengeUnavailable) return Response.json({ success: false }, { status: 503 })
        const body = await request.json()
        expect(claims.dac_request_hash).toBe(
          IMDeviceProof.digest([
            "dac.im.bootstrap.v1",
            url.origin,
            body.purpose,
            body.transactionID ?? "",
            "",
            body.requestHash,
            key.jkt,
          ]),
        )
        return Response.json({
          success: true,
          data: {
            profile: IMDeviceProof.profile,
            challengeID: "c".repeat(32),
            nonce: "n".repeat(43),
            expiresAt: Date.now() + 59000,
            deviceJkt: key.jkt,
            purpose: body.purpose,
          },
        })
      }
      expect(claims.nonce).toBe("n".repeat(43))
      expect(request.headers.get("X-IM-Challenge-ID")).toBe("c".repeat(32))
      if (url.pathname === "/api/im/activation") {
        facts.purchase++
        if (facts.proofRejected)
          return Response.json({ success: false, code: "im_device_proof_invalid" }, { status: 401 })
        const body = await request.json()
        expect(body.profile).toBe(IMDeviceProof.profile)
        if (facts.dropBeforeAdmission) return new Response("owned failure before admission", { status: 503 })
        receipts.set(body.transactionID, { secret: body.receiptSecret, method: body.method })
        if (facts.recoverSubmit)
          return Response.json({
            success: true,
            data: {
              profile: IMDeviceProof.profile,
              transactionID: body.transactionID,
              method: body.method,
              state: "succeeded",
              chargedCredits: 1,
              entitlementExpiresAt: null,
              entitlementID: "e".repeat(32),
              deviceJkt: key.jkt,
              bindingVersion: 1,
              imCredential: `iml2.${"a".repeat(64)}`,
              identity: { uuid: "f".repeat(32), name: "alice", org_id: 1, org_all_group_id: "org1" },
            },
          })
        return new Response("owned committed response loss", { status: 503 })
      }
      if (url.pathname.startsWith("/api/im/activation/")) {
        const id = url.pathname.split("/").at(-1)!
        const receipt = receipts.get(id)!
        if (!receipt) return Response.json({ success: false, code: "im_activation_receipt_denied" }, { status: 403 })
        expect(request.headers.get("authorization")).toBe(`IM-Receipt ${receipt.secret}`)
        expect(claims.ath).toBe(IMDeviceProof.credentialHash(receipt.secret))
        return Response.json({
          success: true,
          data: {
            profile: IMDeviceProof.profile,
            transactionID: id,
            method: receipt.method,
            state: facts.paidRejected ? "rejected" : facts.paidPending ? "pending" : "succeeded",
            chargedCredits: facts.feeLost ? 0 : 1,
            entitlementExpiresAt: null,
            ...(facts.paidRejected
              ? { rejectionCode: "im_registration_pending" }
              : facts.paidPending
                ? {}
                : {
                    entitlementID: "e".repeat(32),
                    deviceJkt: key.jkt,
                    bindingVersion: 1,
                    imCredential: `iml2.${"a".repeat(64)}`,
                    identity: { uuid: "f".repeat(32), name: "alice", org_id: 1, org_all_group_id: "org1" },
                  }),
          },
        })
      }
      if (url.pathname === "/api/im/device/migrate") {
        facts.migration++
        const body = await request.json()
        expect(claims.ath).toBe(IMDeviceProof.credentialHash(body.voucher))
        if (facts.proofRejected)
          return Response.json({ success: false, code: "im_device_proof_invalid" }, { status: 401 })
        if (facts.dropBeforeAdmission) return new Response("owned failure before migration admission", { status: 503 })
        migration.id = body.migrationID
        migration.receipt = body.receiptSecret
        if (facts.recoverSubmit)
          return Response.json({
            success: true,
            data: {
              profile: IMDeviceProof.profile,
              migrationID: body.migrationID,
              state: "succeeded",
              chargedCredits: 0,
              entitlementID: "e".repeat(32),
              deviceJkt: key.jkt,
              bindingVersion: 1,
              imCredential: `iml2.${"a".repeat(64)}`,
              uuid: "f".repeat(32),
            },
          })
        return new Response("owned migration response loss", { status: 503 })
      }
      if (url.pathname.startsWith("/api/im/device/migrations/")) {
        if (!migration.id)
          return Response.json({ success: false, code: "im_activation_receipt_denied" }, { status: 403 })
        expect(url.pathname.endsWith(migration.id)).toBeTrue()
        expect(request.headers.get("authorization")).toBe(`IM-Receipt ${migration.receipt}`)
        expect(claims.ath).toBe(IMDeviceProof.credentialHash(migration.receipt))
        return Response.json({
          success: true,
          data: {
            profile: IMDeviceProof.profile,
            migrationID: migration.id,
            state: "succeeded",
            chargedCredits: 0,
            entitlementID: "e".repeat(32),
            deviceJkt: key.jkt,
            bindingVersion: 1,
            imCredential: `iml2.${"a".repeat(64)}`,
            uuid: "f".repeat(32),
          },
        })
      }
      if (url.pathname === "/api/im/login") {
        facts.login++
        const body = await request.json()
        expect(body).toEqual({ profile: IMDeviceProof.profile, challengeID: "c".repeat(32) })
        expect(request.headers.get("authorization")).toBe(`DPoP iml2.${"a".repeat(64)}`)
        expect(claims.ath).toBe(IMDeviceProof.credentialHash(`iml2.${"a".repeat(64)}`))
        return Response.json({
          success: true,
          data: {
            profile: IMDeviceProof.profile,
            entitlementID: "e".repeat(32),
            deviceJkt: key.jkt,
            bindingVersion: 1,
            identity: { uuid: "f".repeat(32), name: "alice", org_id: 1, org_all_group_id: "org1" },
            kernel: {
              appkey: "dac",
              navigator: url.origin,
              socket_audience: "wss://owned-kernel.example/im",
              token: `daim2.${"a".repeat(43)}`,
              user_id: "f".repeat(32),
              credential_expires_at: Math.floor(Date.now() / 1000) + 60,
              credential_generation: 1,
              device_profile: IMDeviceProof.profile,
            },
          },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
  const input = {
    db: (yield* Database.Service).db,
    auth: yield* Auth.Service,
    http: yield* HttpClient.HttpClient,
    facadeURL: server.url.origin,
    device,
    allowLoopback: true,
  }
  return { facts, input, key, device, receipts, controller: yield* IMActivation.make(input) }
})
const submit = () => ({
  transactionID: crypto.randomUUID(),
  name: "alice",
  method: "api_key" as const,
  credential: `owned-payer-${crypto.randomUUID()}`,
  quoteID: "owned-terms",
})

describe("Host bound IM actual signed HTTP and file-backed database", () => {
  it.effect("explicitly recovers only the original unknown purchase after a request was never admitted", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const request = submit()
      f.facts.dropBeforeAdmission = true
      expect(yield* f.controller.activate(request)).toMatchObject({ state: "unknown", chargedCredits: null })
      const receipt = yield* f.device.get(f.input.facadeURL, `activation-${request.transactionID}`)
      const cold = yield* IMActivation.make(f.input)
      expect(yield* cold.status(request.transactionID)).toMatchObject({ state: "unknown", chargedCredits: null })
      expect(yield* cold.activate(request)).toMatchObject({ state: "unknown" })
      expect(f.facts.purchase).toBe(1)
      expect((yield* Effect.flip(cold.activate({ ...request, retryOriginal: true, credential: "wrong" }))).code).toBe(
        "im_activation_conflict",
      )
      expect(
        (yield* Effect.flip(cold.activate({ ...request, retryOriginal: true, transactionID: crypto.randomUUID() })))
          .code,
      ).toBe("im_activation_conflict")
      f.facts.dropBeforeAdmission = false
      f.facts.proofRejected = true
      expect(yield* cold.activate({ ...request, retryOriginal: true })).toMatchObject({
        state: "unknown",
        chargedCredits: null,
      })
      f.facts.proofRejected = false
      f.facts.recoverSubmit = true
      expect(yield* cold.activate({ ...request, retryOriginal: true })).toMatchObject({
        state: "succeeded",
        chargedCredits: 1,
        credentialStored: true,
      })
      expect(f.receipts.get(request.transactionID)?.secret).toBe(receipt)
      expect(yield* f.device.get(f.input.facadeURL, `activation-${request.transactionID}`)).toBeUndefined()
      expect(yield* f.input.db.select().from(IMActivationTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(f.facts.purchase).toBe(3)
    }),
  )
  it.effect("explicitly recovers only the original unknown migration without replacing its receipt", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const request = { migrationID: crypto.randomUUID(), voucher: `immv1.${"v".repeat(43)}` }
      f.facts.dropBeforeAdmission = true
      expect(yield* f.controller.migrate(request)).toMatchObject({ state: "unknown" })
      const original = yield* f.device.get(f.input.facadeURL, "migration")
      const cold = yield* IMActivation.make(f.input)
      expect(yield* cold.migrationStatus(request.migrationID)).toMatchObject({ state: "unknown" })
      expect((yield* Effect.flip(cold.migrate({ ...request, retryOriginal: true, voucher: "wrong" }))).code).toBe(
        "im_migration_conflict",
      )
      expect(
        (yield* Effect.flip(cold.migrate({ ...request, retryOriginal: true, migrationID: crypto.randomUUID() }))).code,
      ).toBe("im_migration_conflict")
      f.facts.dropBeforeAdmission = false
      f.facts.proofRejected = true
      expect(yield* cold.migrate({ ...request, retryOriginal: true })).toMatchObject({ state: "unknown" })
      expect(yield* f.device.get(f.input.facadeURL, "migration")).toBe(original)
      f.facts.proofRejected = false
      f.facts.recoverSubmit = true
      expect(yield* cold.migrate({ ...request, retryOriginal: true })).toMatchObject({
        state: "succeeded",
        chargedCredits: 0,
        credentialStored: true,
      })
      expect(f.facts.migration).toBe(3)
      expect(f.facts.purchase).toBe(0)
    }),
  )
  it.effect("a definitive pre-effect proof rejection preserves a zero-charge terminal receipt", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      f.facts.proofRejected = true
      expect(yield* f.controller.activate(submit())).toMatchObject({
        state: "rejected",
        chargedCredits: 0,
        code: "im_device_proof_invalid",
      })
      expect((yield* f.controller.pending).transaction).toBeNull()
      expect(f.facts.purchase).toBe(1)
    }),
  )
  it.effect("retains a paid pending fact, recovers only its original receipt and stores a bound login", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const request = submit()
      expect(yield* f.controller.activate(request)).toMatchObject({ state: "unknown", chargedCredits: null })
      f.facts.paidPending = true
      expect(yield* f.controller.status(request.transactionID)).toMatchObject({ state: "pending", chargedCredits: 1 })
      const cold = yield* IMActivation.make(f.input)
      expect((yield* cold.pending).transaction?.chargedCredits).toBe(1)
      expect((yield* Effect.flip(cold.activate(submit()))).code).toBe("im_activation_pending")
      f.facts.paidPending = false
      f.facts.failLoginStore = true
      expect(yield* cold.status(request.transactionID)).toMatchObject({
        state: "succeeded",
        chargedCredits: 1,
        credentialStored: false,
      })
      f.facts.failLoginStore = false
      expect(yield* cold.status(request.transactionID)).toMatchObject({
        state: "succeeded",
        chargedCredits: 1,
        credentialStored: true,
      })
      expect(f.facts.purchase).toBe(1)
      expect(yield* f.device.get(f.input.facadeURL, "login")).toContain("iml2.")
      const rows = yield* f.input.db.select().from(IMActivationTable).all().pipe(Effect.orDie)
      expect(JSON.stringify(rows)).not.toContain(request.credential)
      expect(JSON.stringify(rows)).not.toContain("iml2.")
      expect((yield* Effect.flip(cold.activate(submit()))).code).toBe("im_device_binding_exists")
    }),
  )
  it.effect("a paid rejected receipt recovers through its original ID and never loses a recorded charge", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const request = submit()
      yield* f.controller.activate(request)
      f.facts.paidRejected = true
      expect(yield* f.controller.status(request.transactionID)).toMatchObject({
        state: "rejected",
        chargedCredits: 1,
        credentialStored: false,
      })
      const cold = yield* IMActivation.make(f.input)
      expect((yield* cold.pending).transaction?.transactionID).toBe(request.transactionID)
      f.facts.feeLost = true
      expect((yield* Effect.flip(cold.status(request.transactionID))).code).toBe("im_activation_unknown")
      expect((yield* cold.pending).transaction?.chargedCredits).toBe(1)
      f.facts.paidRejected = false
      f.facts.feeLost = false
      expect(yield* cold.status(request.transactionID)).toMatchObject({
        state: "succeeded",
        chargedCredits: 1,
        credentialStored: true,
      })
      expect(f.facts.purchase).toBe(1)
    }),
  )
  it.effect("migrates a paid identity at zero charge and rejects conflicting original-ID retries", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const request = { migrationID: crypto.randomUUID(), voucher: `immv1.${"v".repeat(43)}` }
      expect(yield* f.controller.migrate(request)).toMatchObject({ state: "unknown", chargedCredits: 0 })
      const cold = yield* IMActivation.make(f.input)
      expect(yield* cold.migrate(request)).toMatchObject({ state: "unknown" })
      expect((yield* Effect.flip(cold.migrate({ ...request, voucher: "immv1.different" }))).code).toBe(
        "im_migration_conflict",
      )
      expect((yield* Effect.flip(cold.migrate({ ...request, migrationID: crypto.randomUUID() }))).code).toBe(
        "im_device_migration_pending",
      )
      expect(yield* cold.migrationStatus(request.migrationID)).toMatchObject({
        state: "succeeded",
        chargedCredits: 0,
        uuid: "f".repeat(32),
        credentialStored: true,
      })
      expect(f.facts.migration).toBe(1)
      expect(f.facts.purchase).toBe(0)
    }),
  )
  it.effect(
    "pre-effect challenge failure admits no transaction, and a bound login carries the configured audience",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        f.facts.challengeUnavailable = true
        expect((yield* Effect.flip(f.controller.activate(submit()))).code).toBe("im_device_challenge_unavailable")
        expect((yield* f.controller.pending).transaction).toBeNull()
        expect(f.facts.purchase).toBe(0)
        f.facts.challengeUnavailable = false
        const credential = `iml2.${"a".repeat(64)}`
        const transport = IMDeviceTransport.make({ store: f.device, http: f.input.http, allowLoopback: true })
        const result = yield* IMKernelExchange.exchange({
          facadeURL: f.input.facadeURL,
          key: credential,
          device: {
            profile: IMDeviceProof.profile,
            publicJwk: f.key.publicJwk,
            entitlementID: "e".repeat(32),
            deviceJkt: f.key.jkt,
            bindingVersion: 1,
            uuid: "f".repeat(32),
            headers: (request) =>
              transport.headers({
                ...request,
                realm: f.input.facadeURL,
                purpose: "login",
                credential,
                requestHash: IMDeviceProof.digest([
                  "dac.im.login.v2",
                  f.input.facadeURL,
                  IMDeviceProof.sha256(credential),
                  f.key.jkt,
                ]),
              }),
          },
        })
        expect(result.device?.socketAudience).toBe("wss://owned-kernel.example/im")
        expect(result.kernel_token).toMatch(/^daim2\./)
        expect(f.facts.login).toBe(1)
      }),
  )
})
