import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { ContextAuthorization } from "../../src/context-federation/authorization"
import { ContextTokenCodec } from "../../src/context-federation/token-codec"
import {
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
  sameProjectionRevision,
  type ContextRef,
  type ProjectionSnapshotRevision,
} from "../../src/context-federation/reference"

const namespace = SecurityNamespaceID.make("sec_internal_a")
const otherNamespace = SecurityNamespaceID.make("sec_internal_b")
const location = LocationKey.make("loc_internal_a")
const otherLocation = LocationKey.make("loc_internal_b")
const project = ProjectScopeKey.make("prjctx_internal")
const revision = snapshot(1, 7)
const ref: ContextRef = {
  graph: "code",
  entityId: "entity-internal",
  binding: { scope: "location", securityNamespaceId: namespace, locationKey: location, projectScopeKey: project },
  locator: { path: "src/private.ts", symbolPath: "SessionExecution.wake", startLine: 1, endLine: 8 },
  revision: JSON.stringify(revision),
}

describe("opaque context tokens", () => {
  test("round-trips all purposes without exposing scope, path, or physical identity", async () => {
    const codec = ContextTokenCodec.make({ activeKeyId: "key-a", keys: [{ id: "key-a", secret: randomBytes(32) }] })
    const lifetime = { issuedAt: 100, expiresAt: 1_000 }
    const refToken = codec.sealContextRef(ref, lifetime)
    const cursor = {
      securityNamespaceId: namespace,
      locationKey: location,
      snapshotRevision: revision,
      queryFingerprint: "query-hash",
      authorizationFingerprint: "auth-hash",
      page: { offset: 20, lastScore: 0.8, lastEntityId: "entity-internal" },
    }
    const cursorToken = codec.sealCursor(cursor, lifetime)
    const artifact = {
      securityNamespaceId: namespace,
      sessionId: "session-internal",
      selectionId: "selection-internal",
      artifactId: "artifact-internal",
    }
    const artifactToken = codec.sealArtifact(artifact, lifetime)

    for (const token of [refToken, cursorToken, artifactToken]) {
      expect(token).not.toContain(namespace)
      expect(token).not.toContain(location)
      expect(token).not.toContain("src/private.ts")
      expect(token).not.toContain("entity-internal")
    }
    expect(await Effect.runPromise(codec.openContextRef(refToken, 200))).toEqual(ref)
    expect(await Effect.runPromise(codec.openCursor(cursorToken, 200))).toEqual(cursor)
    expect(await Effect.runPromise(codec.openArtifact(artifactToken, 200))).toEqual(artifact)

    const wrongPurpose = await Effect.runPromise(codec.openCursor(refToken, 200).pipe(Effect.flip))
    expect(wrongPurpose._tag).toBe("ContextToken.BrokenError")
  })

  test("fails closed for tamper, token expiry, and expired rotation keys", async () => {
    const oldSecret = randomBytes(32)
    const newSecret = randomBytes(32)
    const oldCodec = ContextTokenCodec.make({ activeKeyId: "old", keys: [{ id: "old", secret: oldSecret }] })
    const oldToken = oldCodec.sealContextRef(ref, { issuedAt: 100, expiresAt: 1_000 })
    const rotated = ContextTokenCodec.make({
      activeKeyId: "new",
      keys: [
        { id: "old", secret: oldSecret, decryptUntil: 500 },
        { id: "new", secret: newSecret },
      ],
    })
    expect(await Effect.runPromise(rotated.openContextRef(oldToken, 499))).toEqual(ref)
    const keyExpired = await Effect.runPromise(rotated.openContextRef(oldToken, 500).pipe(Effect.flip))
    expect(keyExpired._tag).toBe("ContextToken.KeyExpiredError")

    const expired = oldCodec.sealContextRef(ref, { issuedAt: 100, expiresAt: 200 })
    expect((await Effect.runPromise(oldCodec.openContextRef(expired, 200).pipe(Effect.flip)))._tag).toBe(
      "ContextToken.ExpiredError",
    )

    const last = oldToken.at(-1)
    const tampered = oldToken.slice(0, -1) + (last === "A" ? "B" : "A")
    expect((await Effect.runPromise(oldCodec.openContextRef(tampered, 150).pipe(Effect.flip)))._tag).toBe(
      "ContextToken.BrokenError",
    )
  })

  test("rejects unsafe key IDs and invalid issuance lifetimes", () => {
    expect(() =>
      ContextTokenCodec.make({ activeKeyId: "unsafe.key", keys: [{ id: "unsafe.key", secret: randomBytes(32) }] }),
    ).toThrow()
    const codec = ContextTokenCodec.make({ activeKeyId: "safe", keys: [{ id: "safe", secret: randomBytes(32) }] })
    expect(() => codec.sealContextRef(ref, { issuedAt: 100, expiresAt: 100 })).toThrow()
  })

  test("binds cursors and refs to the full snapshot incarnation rather than generation alone", async () => {
    const codec = ContextTokenCodec.make({ activeKeyId: "key", keys: [{ id: "key", secret: randomBytes(32) }] })
    const oldRevision = snapshot(1, 9)
    const replacementRevision = snapshot(2, 9)
    const token = codec.sealCursor(
      {
        securityNamespaceId: namespace,
        locationKey: location,
        snapshotRevision: oldRevision,
        queryFingerprint: "query",
        authorizationFingerprint: "auth",
        page: { offset: 0 },
      },
      { issuedAt: 0, expiresAt: 1_000 },
    )
    const decoded = await Effect.runPromise(codec.openCursor(token, 1))
    expect("projectionKind" in decoded.snapshotRevision).toBe(true)
    if (!("projectionKind" in decoded.snapshotRevision)) throw new Error("expected projection cursor")
    expect(decoded.snapshotRevision.generation).toBe(replacementRevision.generation)
    expect(sameProjectionRevision(decoded.snapshotRevision, replacementRevision)).toBe(false)
  })
})

describe("authorization and Provider egress", () => {
  const egress = {
    policyId: "provider-source-code",
    epoch: 1,
    graphs: ["code", "knowledge", "memory", "documents"] as const,
    sensitivities: ["public", "source_code"] as const,
  }

  test("requires namespace, Location, and Project grants conjunctively", () => {
    const principal = {
      securityNamespaceId: namespace,
      principalId: "principal",
      authorizationEpoch: 1,
      locationKeys: [location],
      projectScopeKeys: [project],
      sessionIds: [],
      subjectIds: [],
      allowBuiltin: false,
    }
    expect(ContextAuthorization.authorize({ ref, principal, egress, sensitivity: "source_code" }).allowed).toBe(true)
    expect(
      ContextAuthorization.authorize({
        ref,
        principal: { ...principal, securityNamespaceId: otherNamespace },
        egress,
        sensitivity: "source_code",
      }),
    ).toEqual({ allowed: false, reason: "security_namespace_mismatch" })
    expect(
      ContextAuthorization.authorize({
        ref,
        principal: { ...principal, locationKeys: [otherLocation] },
        egress,
        sensitivity: "source_code",
      }),
    ).toEqual({ allowed: false, reason: "location_scope_denied" })

    // Matching the historical Project.global concept is not a Location grant.
    expect(
      ContextAuthorization.authorize({
        ref,
        principal: { ...principal, locationKeys: [] },
        egress,
        sensitivity: "source_code",
      }),
    ).toEqual({ allowed: false, reason: "location_scope_denied" })
  })

  test("rechecks revocation and egress after token decode", async () => {
    const codec = ContextTokenCodec.make({ activeKeyId: "key", keys: [{ id: "key", secret: randomBytes(32) }] })
    const token = codec.sealContextRef(ref, { issuedAt: 0, expiresAt: 1_000 })
    const decoded = await Effect.runPromise(codec.openContextRef(token, 1))
    const allowed = {
      securityNamespaceId: namespace,
      principalId: "principal",
      authorizationEpoch: 1,
      locationKeys: [location],
      projectScopeKeys: [project],
      sessionIds: [],
      subjectIds: [],
      allowBuiltin: false,
    }
    expect(
      ContextAuthorization.authorize({ ref: decoded, principal: allowed, egress, sensitivity: "source_code" }).allowed,
    ).toBe(true)
    expect(
      ContextAuthorization.authorize({
        ref: decoded,
        principal: { ...allowed, authorizationEpoch: 2, locationKeys: [] },
        egress,
        sensitivity: "source_code",
      }),
    ).toEqual({ allowed: false, reason: "location_scope_denied" })
    expect(ContextAuthorization.authorize({ ref: decoded, principal: allowed, egress, sensitivity: "secret" })).toEqual(
      {
        allowed: false,
        reason: "provider_egress_denied",
      },
    )
  })
})

function snapshot(indexIncarnation: number, generation: number): ProjectionSnapshotRevision {
  return {
    projectionKind: "code",
    indexIncarnation,
    generation,
    manifestHash: `manifest-${indexIncarnation}-${generation}`,
    schemaVersion: 1,
    adapterSetVersion: "ts-js-v1",
  }
}
