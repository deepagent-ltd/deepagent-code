import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { ToolResultArtifact } from "../../src/context-federation/tool-result-artifact"
import { SecurityNamespaceID } from "../../src/context-federation/reference"
import type { Principal } from "../../src/context-federation/authorization"

const ns = SecurityNamespaceID.make("sec_tool_result_test")
const sessionId = "ses_tool_writer"
const otherSessionId = "ses_tool_other"
const key = new Uint8Array(32).fill(7)
const keyId = "k1"

function principal(sessionIds: readonly string[]): Principal {
  return {
    securityNamespaceId: ns,
    principalId: "principal-tool",
    authorizationEpoch: 1,
    locationKeys: [],
    projectScopeKeys: [],
    sessionIds,
    subjectIds: [],
    allowBuiltin: false,
  }
}

function harnessWith() {
  const database = Database.layerFromPath(":memory:")
  const tool = ToolResultArtifact.layer({ securityNamespaceId: ns, keyId, encryptionKey: key }).pipe(
    Layer.provide(database),
  )
  const layer = Layer.mergeAll(database, tool)
  return {
    run: <A, E>(effect: Effect.Effect<A, E, Database.Service | ToolResultArtifact.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped)),
  }
}

describe("ToolResultArtifact (C3-06a: session permission + expiry + deterministic identity)", () => {
  test("write then read in the same session returns the payload and a deterministic ref", async () => {
    const harness = harnessWith()
    const out = await harness.run(
      Effect.gen(function* () {
        const svc = yield* ToolResultArtifact.Service
        const written = yield* svc.write({
          sessionId,
          artifactId: "td-1",
          payload: { kind: "tool_result", data: [1, 2, 3] },
          now: 1_000,
        })
        expect(written.ref).toBe("ctx-tool:td-1")
        const read = yield* svc.read({ artifactId: "td-1", principal: principal([sessionId]), now: 2_000 })
        expect(read.ref).toBe(written.ref)
        expect(read.contentHash).toBe(written.contentHash)
        return read.payload
      }),
    )
    expect(out).toEqual({ kind: "tool_result", data: [1, 2, 3] })
  })

  test("cross-session read is a typed artifact_cross_session_denied", async () => {
    const harness = harnessWith()
    const out = await harness.run(
      Effect.gen(function* () {
        const svc = yield* ToolResultArtifact.Service
        yield* svc.write({ sessionId, artifactId: "td-2", payload: { secret: true }, now: 1_000 })
        return yield* svc
          .read({ artifactId: "td-2", principal: principal([otherSessionId]), now: 2_000 })
          .pipe(Effect.catch((error) => Effect.succeed({ error })))
      }),
    )
    expect(out).toMatchObject({ error: { _tag: "artifact_cross_session_denied" } })
  })

  test("expired read is a typed artifact_expired (injectable clock / short TTL)", async () => {
    const harness = harnessWith()
    const out = await harness.run(
      Effect.gen(function* () {
        const svc = yield* ToolResultArtifact.Service
        yield* svc.write({ sessionId, artifactId: "td-3", payload: { t: 1 }, ttlMs: 5_000, now: 1_000 })
        return yield* svc
          .read({ artifactId: "td-3", principal: principal([sessionId]), now: 10_000 })
          .pipe(Effect.catch((error) => Effect.succeed({ error })))
      }),
    )
    expect(out).toMatchObject({ error: { _tag: "artifact_expired" } })
  })

  test("default TTL is applied when no ttlMs is supplied (24h)", async () => {
    const harness = harnessWith()
    const out = await harness.run(
      Effect.gen(function* () {
        const svc = yield* ToolResultArtifact.Service
        return yield* svc.write({ sessionId, artifactId: "td-default", payload: { x: 1 }, now: 1_000 })
      }),
    )
    expect(out.expiresAt).toBe(1_000 + ToolResultArtifact.DefaultToolResultTtlMs)
  })

  test("ref identity is deterministic: same identity rewritten yields the same ref + contentHash", async () => {
    const harness = harnessWith()
    await harness.run(
      Effect.gen(function* () {
        const svc = yield* ToolResultArtifact.Service
        const first = yield* svc.write({ sessionId, artifactId: "td-4", payload: { seq: "abc" }, now: 1_000 })
        const second = yield* svc.write({ sessionId, artifactId: "td-4", payload: { seq: "abc" }, now: 1_000 })
        expect(second.ref).toBe(first.ref)
        expect(second.contentHash).toBe(first.contentHash)
      }),
    )
  })

  test("reading a missing artifact is a typed artifact_not_found", async () => {
    const harness = harnessWith()
    const out = await harness.run(
      Effect.gen(function* () {
        const svc = yield* ToolResultArtifact.Service
        return yield* svc
          .read({ artifactId: "td-missing", principal: principal([sessionId]), now: 1_000 })
          .pipe(Effect.catch((error) => Effect.succeed({ error })))
      }),
    )
    expect(out).toMatchObject({ error: { _tag: "artifact_not_found" } })
  })
})
