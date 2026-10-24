export * as IMDeviceRuntimeFixture from "./im-device-runtime.fixture"

import assert from "node:assert/strict"
import { createPublicKey, randomBytes, verify } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { Global } from "@deepagent-code/core/global"
import { IMDeviceProof } from "@/im/device-proof"
import { IMDeviceStore } from "@/im/device-store"
import { SecretStore } from "@/mcp/secret-store"

const claims = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      htm: Schema.String,
      htu: Schema.String,
      iat: Schema.Number,
      jti: Schema.String,
      nonce: Schema.optional(Schema.String),
      ath: Schema.optional(Schema.String),
      dac_purpose: Schema.optional(Schema.String),
      dac_request_hash: Schema.optional(Schema.String),
    }),
  ),
)

export const profile = (url: string | null) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      assert(
        process.env.DEEPAGENT_CODE_TEST_HOME &&
          Global.Path.config.startsWith(process.env.DEEPAGENT_CODE_TEST_HOME + path.sep),
      )
      const filename = path.join(Global.Path.config, "config.jsonc")
      const original = await Bun.file(filename)
        .text()
        .catch(() => undefined)
      await Bun.write(filename, JSON.stringify({ $schema: "https://ai.deepagent.ltd/config.schema.json", im: { url } }))
      return { filename, original }
    }),
    (original) =>
      Effect.promise(async () => {
        if (original.original === undefined) {
          await fs.rm(original.filename, { force: true })
          return
        }
        await Bun.write(original.filename, original.original)
      }),
  )

/** Real HTTPS and P-256 proofs, with custody confined to an explicitly owned file backend. */
export const make = (input: {
  directory: string
  uuid: string
  bound?: boolean
  protectedPath?: (pathname: string) => boolean
  listen?: (transport: {
    tls: { key: Bun.BunFile; cert: Bun.BunFile }
    identity: { jkt: string; publicJwk: IMDeviceProof.PublicJwk }
    fetch: (request: Request) => Promise<Response>
  }) => { url: URL; stop: (closeActiveConnections?: boolean) => void }
  fetch: (
    request: Request,
    identity: { jkt: string; publicJwk: IMDeviceProof.PublicJwk },
  ) => Response | Promise<Response>
}) =>
  Effect.gen(function* () {
    const { certificate } = yield* Effect.promise(
      () => import("../installation/fixture/event-investigation-installation"),
    )
    const tls = yield* Effect.promise(() => certificate(path.join(input.directory, "tls")))
    const directory = path.join(input.directory, "device")
    const backendFile = path.join(input.directory, "custody.json")
    yield* Effect.promise(() => fs.mkdir(directory, { recursive: true, mode: 0o700 }))
    const store = IMDeviceStore.make({ directory, backend: SecretStore.fileBackend(backendFile) })
    const identity = yield* store.identity
    const publicIdentity = { jkt: identity.jkt, publicJwk: identity.publicJwk }
    const seen = new Set<string>()
    const challenges = new Map<string, { nonce: string; purpose: string }>()
    const observations = { proofs: 0, challenges: 0 }
    const fetch = async (request: Request) => {
      const url = new URL(request.url)
      if (!url.pathname.startsWith("/api/im/") && !input.protectedPath?.(url.pathname))
        return input.fetch(request, publicIdentity)
      if (["/api/im/plans", "/api/im/activation/quote"].includes(url.pathname))
        return input.fetch(request, publicIdentity)
      const proof = request.headers.get("DPoP")?.split(".")
      assert(proof?.length === 3, "Owned IM transport requires its actual device proof")
      const header = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            alg: Schema.Literal("ES256"),
            typ: Schema.Literal("dpop+jwt"),
            jwk: Schema.Unknown,
          }),
        ),
      )(Buffer.from(proof[0]!, "base64url").toString())
      const jwk = IMDeviceProof.publicJwk(header.jwk)
      assert.deepEqual(jwk, identity.publicJwk)
      assert(
        verify(
          "sha256",
          Buffer.from(`${proof[0]}.${proof[1]}`),
          {
            key: createPublicKey({ format: "jwk", key: jwk }),
            dsaEncoding: "ieee-p1363",
          },
          Buffer.from(proof[2]!, "base64url"),
        ),
        "Owned IM proof signature must verify",
      )
      const body = claims(Buffer.from(proof[1]!, "base64url").toString())
      assert.equal(body.htm, request.method)
      assert.equal(body.htu, url.origin + url.pathname)
      assert(Math.abs(Math.floor(Date.now() / 1000) - body.iat) <= 30)
      assert(!seen.has(body.jti), "A device proof must never be replayed")
      seen.add(body.jti)
      observations.proofs++
      if (url.pathname === "/api/im/device/challenges") {
        const bootstrap = Schema.decodeUnknownSync(
          Schema.Struct({
            profile: Schema.Literal(IMDeviceProof.profile),
            purpose: Schema.String,
            requestHash: Schema.String,
            transactionID: Schema.optional(Schema.String),
            publicJwk: Schema.Unknown,
          }),
        )(await request.json())
        assert.deepEqual(IMDeviceProof.publicJwk(bootstrap.publicJwk), identity.publicJwk)
        assert.equal(body.dac_purpose, bootstrap.purpose)
        assert.equal(
          body.dac_request_hash,
          IMDeviceProof.digest([
            "dac.im.bootstrap.v1",
            url.origin,
            bootstrap.purpose,
            bootstrap.transactionID ?? "",
            "",
            bootstrap.requestHash,
            identity.jkt,
          ]),
        )
        const challengeID = randomBytes(16).toString("hex")
        const nonce = randomBytes(32).toString("base64url")
        challenges.set(challengeID, { nonce, purpose: bootstrap.purpose })
        observations.challenges++
        return Response.json({
          success: true,
          data: {
            profile: IMDeviceProof.profile,
            challengeID,
            nonce,
            expiresAt: Date.now() + 59000,
            deviceJkt: identity.jkt,
            purpose: bootstrap.purpose,
          },
        })
      }
      const challengeID = request.headers.get("X-IM-Challenge-ID") ?? ""
      const challenge = challenges.get(challengeID)
      assert(challenge && body.nonce === challenge.nonce, "Owned IM request must use its original challenge")
      const credential = request.headers.get("authorization")?.split(" ").slice(1).join(" ")
      if (credential) assert.equal(body.ath, IMDeviceProof.credentialHash(credential))
      return input.fetch(request, publicIdentity)
    }
    const transport = {
      tls: { key: Bun.file(tls.keyPath), cert: Bun.file(tls.certificatePath) },
      fetch,
      identity: publicIdentity,
    }
    const server = input.listen
      ? input.listen(transport)
      : Bun.serve({ hostname: "127.0.0.1", port: 0, tls: transport.tls, fetch })
    yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
    if (input.bound !== false)
      yield* store.put(
        server.url.origin,
        "login",
        JSON.stringify({
          profile: IMDeviceProof.profile,
          imCredential: `iml2.${"a".repeat(64)}`,
          entitlementID: "e".repeat(32),
          deviceJkt: identity.jkt,
          bindingVersion: 1,
          uuid: input.uuid,
        }),
      )
    return {
      server,
      url: server.url.origin,
      store,
      publicIdentity,
      observations,
      directory,
      backendFile,
      ca: tls.ca,
      certificatePath: tls.certificatePath,
      deviceLayer: Layer.succeed(IMDeviceStore.Service, store),
      httpLayer: NodeHttpClient.layerNodeHttpNoAgent.pipe(
        Layer.provide(NodeHttpClient.layerAgentOptions({ ca: tls.ca, rejectUnauthorized: true })),
      ),
    }
  })
