import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { IMActivationTable } from "@deepagent-code/core/im/activation.sql"
import { IMActivationSchema } from "@deepagent-code/core/im/activation.schema"
import { Auth } from "@/auth"
import { IMActivation } from "@/im/activation"
import { testEffect } from "../lib/effect"

const root = mkdtempSync(path.join(os.tmpdir(), "dac-im-activation-http-"))
const database = Layer.suspend(() => Database.layerFromPath(path.join(root, `${crypto.randomUUID()}.sqlite`)))
const it = testEffect(Layer.mergeAll(database, Auth.defaultLayer, FetchHttpClient.layer))
const fixture = Effect.gen(function* () {
  // This transport fixture is deliberately not a billing oracle. The platform
  // module's real ledger/database tests establish the actual one-credit debit.
  const count = { post: 0, get: 0 }
  const receipt = { id: "", secret: "", method: "api_key", broken: false, reject: false, disabled: false }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/im/activation/quote") return Response.json({ success: true, data: {
      quoteID: "fixture-terms", priceCredits: 1, quotaCost: 500000, expiresAt: Date.now() + 300000, entitlementExpiresAt: null,
    } })
    if (request.method === "POST") {
      count.post++
      const input = await request.json()
      receipt.id = input.transactionID; receipt.secret = input.receiptSecret; receipt.method = input.method
      return new Response("committed response unavailable", { status: 503 })
    }
    count.get++
    if (url.pathname !== `/api/im/activation/${receipt.id}` || request.headers.get("authorization") !== `IM-Receipt ${receipt.secret}`)
      return Response.json({ success: false, code: "im_activation_receipt_denied" }, { status: 403 })
    return Response.json({ success: true, data: {
      transactionID: receipt.broken ? "wrong-transaction" : receipt.id, method: receipt.method,
      state: receipt.reject ? "rejected" : "succeeded", chargedCredits: receipt.reject || receipt.method === "activation_code" ? 0 : 1,
      entitlementExpiresAt: null, ...(receipt.reject ? { rejectionCode: "im_quota_insufficient" } : receipt.disabled
        ? { rejectionCode: "im_identity_disabled" } : { imCredential: `iml1.${"a".repeat(64)}` }),
    } })
  } })
  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
  const input = { db: (yield* Database.Service).db, auth: yield* Auth.Service, http: yield* HttpClient.HttpClient, facadeURL: server.url.href }
  return { input, count, receipt, controller: yield* IMActivation.make(input) }
})
const submit = () => IMActivationSchema.Submit.make({ transactionID: crypto.randomUUID(), name: "alice",
  method: "api_key", credential: `private-payer-fixture-${crypto.randomUUID()}`, quoteID: "fixture-terms" })

describe("Host IM activation: file database, real credential store and loopback HTTP", () => {
  it.effect("a login-store write failure retains the paid receipt and its original recovery authority", () => Effect.gen(function* () {
    const f = yield* fixture
    const request = submit()
    yield* f.controller.activate(request)
    const fault = yield* IMActivation.make({ ...f.input, auth: { ...f.input.auth,
      set: (key, value) => key === "im-facade" ? Effect.fail(new Auth.AuthError({ message: "owned storage fault" })) : f.input.auth.set(key, value),
    } })
    expect(yield* fault.status(request.transactionID)).toMatchObject({ state: "succeeded", chargedCredits: 1,
      credentialStored: false, code: "im_activation_credentials_unavailable" })
    expect((yield* fault.pending).transaction?.transactionID).toBe(request.transactionID)
    expect((yield* f.input.auth.get(`im-activation-${request.transactionID}`))?.type).toBe("api")
    expect(yield* f.controller.status(request.transactionID)).toMatchObject({ state: "succeeded", chargedCredits: 1, credentialStored: true })
    expect(f.count.post).toBe(1)
  }))
  it.effect("a paid receipt without current login access preserves the charge and blocks another purchase", () => Effect.gen(function* () {
    const f = yield* fixture
    const request = submit()
    yield* f.controller.activate(request)
    f.receipt.disabled = true
    const paid = yield* f.controller.status(request.transactionID)
    expect(paid).toMatchObject({ state: "succeeded", chargedCredits: 1, credentialStored: false, code: "im_identity_disabled" })
    const cold = yield* IMActivation.make(f.input)
    expect((yield* cold.pending).transaction).toEqual(paid)
    expect((yield* Effect.flip(cold.activate(submit()))).code).toBe("im_activation_pending")
    f.receipt.disabled = false
    expect(yield* cold.status(request.transactionID)).toMatchObject({ state: "succeeded", chargedCredits: 1, credentialStored: true })
    expect((yield* cold.pending).transaction).toBeNull()
    expect(f.count).toEqual({ post: 1, get: 2 })
  }))
  it.effect("cold status recovery never purchases again or retains the payer key", () => Effect.gen(function* () {
    const f = yield* fixture
    const request = submit()
    const first = yield* f.controller.activate(request)
    expect(first).toMatchObject({ state: "unknown", chargedCredits: null, credentialStored: false })
    expect(yield* f.controller.activate(request)).toEqual(first)
    const second = yield* Effect.flip(f.controller.activate(submit()))
    expect(second.code).toBe("im_activation_pending")
    const cold = yield* IMActivation.make(f.input)
    expect((yield* cold.pending).transaction).toEqual(first)
    expect((yield* cold.status(request.transactionID))).toMatchObject({ state: "succeeded", chargedCredits: 1, credentialStored: true })
    expect((yield* cold.pending).transaction).toBeNull()
    expect(f.count).toEqual({ post: 1, get: 1 })
    expect(f.receipt.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const stored = JSON.stringify(yield* f.input.auth.all())
    expect(stored.includes(request.credential)).toBe(false)
    expect(stored.includes(f.receipt.secret)).toBe(false)
    expect((yield* f.input.auth.get("im-facade"))?.type).toBe("api")
    const rows = yield* f.input.db.select().from(IMActivationTable).all().pipe(Effect.orDie)
    expect(JSON.stringify(rows).includes(request.credential)).toBe(false)
    expect(JSON.stringify(rows).includes(f.receipt.secret)).toBe(false)
    expect(JSON.stringify(first).includes("iml1.")).toBe(false)
  }))
  it.effect("a foreign receipt cannot unlock another purchase; a definitive rejection can", () => Effect.gen(function* () {
    const f = yield* fixture
    const request = submit()
    yield* f.controller.activate(request)
    f.receipt.broken = true
    expect((yield* Effect.flip(f.controller.status(request.transactionID))).code).toBe("im_activation_unknown")
    expect((yield* f.controller.pending).transaction?.state).toBe("unknown")
    expect(f.count.post).toBe(1)
    f.receipt.broken = false; f.receipt.reject = true
    expect(yield* f.controller.status(request.transactionID)).toMatchObject({ state: "rejected", chargedCredits: 0, credentialStored: false })
    expect((yield* f.controller.pending).transaction).toBeNull()
  }))
  it.effect("prepaid IM code uses its explicit purpose and recovers a zero-charge receipt", () => Effect.gen(function* () {
    const f = yield* fixture
    const request = { ...submit(), method: "activation_code" as const, credential: "imac1.private-test-code" }
    yield* f.controller.activate(request)
    expect(yield* f.controller.status(request.transactionID)).toMatchObject({ state: "succeeded", chargedCredits: 0, method: "activation_code" })
    expect(f.count.post).toBe(1)
  }))
  it.effect("an insecure remote activation endpoint fails before sending a payment credential", () => Effect.gen(function* () {
    const f = yield* fixture
    const insecure = yield* IMActivation.make({ ...f.input, facadeURL: "http://public.example.test" })
    expect((yield* Effect.flip(insecure.activate(submit()))).code).toBe("im_activation_unavailable")
    expect(f.count).toEqual({ post: 0, get: 0 })
  }))
})
