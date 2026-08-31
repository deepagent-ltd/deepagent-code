import { beforeEach, describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { ModelV2 } from "@deepagent-code/core/model"
import { ModelProtocol } from "@deepagent-code/core/model-protocol"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { PreparedProviderTurn } from "@deepagent-code/core/session/runner/prepared-provider-turn"

/**
 * C2-04 — route / protocol / origin / capability / lowering hash entering the
 * prepared attempt identity (design §2.3, §4.1 step 8, §5.2).
 *
 * Oracle contract:
 *  - identical config + payload => identical attempt identity hash AND route
 *    (exact retry never re-resolves to a different route);
 *  - config drift before dispatch => the attempt is rebuilt, never dispatched
 *    with a mismatched identity (a counting transport records exactly the
 *    rebuilt attempt's request);
 *  - the runtime attempt record carries the new identity fields (the frozen
 *    contract is untouched).
 */

const mkModel = (api: ModelV2.Api, overrides: Partial<ModelV2.Info> = {}) =>
  new ModelV2.Info({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make(api.type === "aisdk" && api.package === "@ai-sdk/openai" ? "openai" : "test-provider"),
    name: "Test model",
    api: { ...api },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {}, generation: {}, options: {} },
    variants: [],
    time: { released: DateTime.makeUnsafe(0) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, input: 80, output: 20 },
    ...overrides,
  })

const mkProvider = (api: ProviderV2.Api, providerID = "test-provider") =>
  new ProviderV2.Info({
    id: ProviderV2.ID.make(providerID),
    name: "Test provider",
    enabled: { via: "env", name: "TEST_PROVIDER_API_KEY" },
    env: ["TEST_PROVIDER_API_KEY"],
    api,
    request: { headers: {}, body: {} },
  })

const compatible: ModelV2.Api = {
  type: "aisdk",
  package: "@ai-sdk/openai-compatible",
  url: "https://compat.example/v1",
  id: ModelV2.ID.make("api-compat"),
}
const deepseekProvider = mkProvider(
  { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://api.deepseek.com/v1" },
  "deepseek",
)

const budget: PreparedProviderTurn.Budget = {
  decision: "ok",
  estimatedFullRequestTokens: 0,
  physicalInputBudget: 100,
  reservedOutputTokens: 20,
  safetyMargin: 0,
  provenance: "model_limit",
}

const turnInput = (
  identity: ReturnType<typeof ModelProtocol.protocolAttemptIdentityFor>,
): PreparedProviderTurn.Input => ({
  sessionID: "ses_0000000000000000000000000000000000000000000000000000000000000001",
  requestOrdinal: 1,
  activityID: "act_1",
  providerTurnSeq: 1,
  owner: "v2",
  stableSystemParts: [],
  volatileSystemParts: [],
  historyMessages: [],
  historyPromptEpoch: 0,
  historySourceEndMessageID: null,
  contextSelectionID: "sel_1",
  contextProjectionHash: "proj_1",
  contextReadiness: "ready",
  contextSelectedRefs: [],
  toolRegistryIDs: [],
  toolPermissionFilteredIDs: [],
  toolFinalOfferedIDs: [],
  toolDefinitions: [],
  toolChoice: null,
  toolCapability: "supported",
  toolLoweringOutcome: "ok",
  toolResultReferences: [],
  samplingModelID: "test-model",
  samplingProviderID: "test-provider",
  budget,
  wireRequestHash: "ab".repeat(32),
  receiptID: "receipt_1",
  userMessageID: "msg_1",
  protocolAttemptIdentity: identity,
  protocolAttemptIdentityHash: ModelProtocol.protocolAttemptIdentityHash(identity),
})

describe("C2-04 protocol attempt identity (route/origin/capability/lowering)", () => {
  test("identical config + payload => identical identity hash and identical route (exact retry)", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const model = mkModel(compatible)

    const a = ModelProtocol.protocolAttemptIdentityFor(model, provider)
    const b = ModelProtocol.protocolAttemptIdentityFor(model, provider)

    expect(a).toEqual(b)
    expect(a.routeId).toBe("openai-compatible-chat")
    expect(ModelProtocol.protocolAttemptIdentityHash(a)).toBe(ModelProtocol.protocolAttemptIdentityHash(b))
    expect(a.loweringVersion).toBe(1)
    expect(a.protocolRevision).toBeGreaterThanOrEqual(1)
  })

  test("a different protocol route resolves to a different identity hash (no reuse across routes)", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const chatIdentity = ModelProtocol.protocolAttemptIdentityFor(mkModel(compatible), provider)
    const responsesIdentity = ModelProtocol.protocolAttemptIdentityFor(
      mkModel({ ...compatible, protocol: "openai-compatible.responses" }),
      deepseekProvider,
    )
    expect(responsesIdentity.routeId).toBe("openai-compatible-responses")
    expect(ModelProtocol.protocolAttemptIdentityHash(responsesIdentity)).not.toBe(
      ModelProtocol.protocolAttemptIdentityHash(chatIdentity),
    )
  })

  test("config drift (protocol change) yields a different identity hash and triggers a dispatch-time rebuild", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const model = mkModel(compatible)
    const storedIdentity = ModelProtocol.protocolAttemptIdentityFor(model, provider)
    const storedHash = ModelProtocol.protocolAttemptIdentityHash(storedIdentity)

    const driftedIdentity = ModelProtocol.protocolAttemptIdentityFor(
      mkModel({ ...compatible, protocol: "openai-compatible.responses" }),
      deepseekProvider,
    )

    const sent: string[] = []
    // The stored attempt must never be dispatched with a mismatched identity; the rebuilt
    // attempt from the CURRENT config is the only thing the counting transport records.
    const outcome = ModelProtocol.dispatchGuarded({
      current: driftedIdentity,
      storedIdentityHash: storedHash,
      storedAttempt: "stale-attempt",
      rebuildAttempt: (identity) => `rebuilt:${identity.routeId}`,
      dispatch: (request) => {
        sent.push(request)
        return 1
      },
    })

    expect(outcome.action).toBe("rebuild")
    expect(sent).toEqual(["rebuilt:openai-compatible-responses"])
    expect(sent).not.toContain("stale-attempt")
  })

  test("no drift => the stored attempt is dispatched as-is (exact retry keeps the same route)", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const identity = ModelProtocol.protocolAttemptIdentityFor(mkModel(compatible), provider)
    const storedHash = ModelProtocol.protocolAttemptIdentityHash(identity)

    const sent: string[] = []
    const outcome = ModelProtocol.dispatchGuarded({
      current: identity,
      storedIdentityHash: storedHash,
      storedAttempt: "stored-attempt",
      rebuildAttempt: (i) => `rebuilt:${i.routeId}`,
      dispatch: (request) => {
        sent.push(request)
        return 1
      },
    })

    expect(outcome.action).toBe("dispatch")
    expect(sent).toEqual(["stored-attempt"])
  })

  test("the frozen contract attempt identity stays intact (no contract change)", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const identity = ModelProtocol.protocolAttemptIdentityFor(mkModel(compatible), provider)
    expect(Object.keys(identity).sort()).toEqual([
      "capabilityFingerprint",
      "endpointOriginHash",
      "loweringVersion",
      "originId",
      "protocol",
      "protocolRevision",
      "routeId",
    ])
  })
})

describe("C2-04 runtime prepared-attempt record carries the identity (contract untouched)", () => {
  test("identical prepare => identical attempt identity hash (exact retry is stable)", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const identity = ModelProtocol.protocolAttemptIdentityFor(mkModel(compatible), provider)

    const turn1 = PreparedProviderTurn.prepare(turnInput(identity))
    const turn2 = PreparedProviderTurn.prepare(turnInput(identity))

    expect(turn1.protocol_attempt_identity_hash).toBe(ModelProtocol.protocolAttemptIdentityHash(identity))
    expect(PreparedProviderTurn.attemptIdentityHash(turn1)).toBe(PreparedProviderTurn.attemptIdentityHash(turn2))
  })

  test("config drift changes the attempt identity hash on the runtime record", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const compatibleIdentity = ModelProtocol.protocolAttemptIdentityFor(mkModel(compatible), provider)
    const responsesIdentity = ModelProtocol.protocolAttemptIdentityFor(
      mkModel({ ...compatible, protocol: "openai-compatible.responses" }),
      deepseekProvider,
    )

    const turn = PreparedProviderTurn.prepare(turnInput(compatibleIdentity))
    const driftedTurn = PreparedProviderTurn.prepare(turnInput(responsesIdentity))

    expect(PreparedProviderTurn.attemptIdentityHash(driftedTurn)).not.toBe(
      PreparedProviderTurn.attemptIdentityHash(turn),
    )
  })
})

describe("C4-08 capability catalog/load snapshot on the runtime attempt record (K3 assembly)", () => {
  const snapshot = {
    catalogSnapshotId: "capability_catalog:test-snap",
    catalogBodyHash: `sha256:${"ab".repeat(32)}`,
    catalogRuntimeHash: `sha256:${"cd".repeat(32)}`,
    catalogPermissionHash: `sha256:${"ef".repeat(32)}`,
    loadedCapabilities: [
      { capabilityId: "deepagent.code-read", bodyHash: `sha256:${"12".repeat(32)}` },
      { capabilityId: "deepagent.code-edit", bodyHash: `sha256:${"34".repeat(32)}` },
    ],
  }

  test("identical snapshot => identical snapshot hash and attempt identity hash (exact retry is stable)", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const identity = ModelProtocol.protocolAttemptIdentityFor(mkModel(compatible), provider)

    const turn1 = PreparedProviderTurn.prepare({ ...turnInput(identity), capabilitySnapshot: snapshot })
    const turn2 = PreparedProviderTurn.prepare({ ...turnInput(identity), capabilitySnapshot: snapshot })

    expect(turn1.capability_snapshot).toEqual(snapshot)
    expect(turn1.capability_snapshot_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(turn1.capability_snapshot_hash).toBe(turn2.capability_snapshot_hash)
    expect(PreparedProviderTurn.attemptIdentityHash(turn1)).toBe(PreparedProviderTurn.attemptIdentityHash(turn2))
  })

  test("a loaded-body drift changes the snapshot hash and the attempt identity hash (new epoch trigger)", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const identity = ModelProtocol.protocolAttemptIdentityFor(mkModel(compatible), provider)
    const drifted = {
      ...snapshot,
      loadedCapabilities: [
        { capabilityId: "deepagent.code-read", bodyHash: `sha256:${"99".repeat(32)}` },
        { capabilityId: "deepagent.code-edit", bodyHash: `sha256:${"34".repeat(32)}` },
      ],
    }

    const base = PreparedProviderTurn.prepare({ ...turnInput(identity), capabilitySnapshot: snapshot })
    const driftedTurn = PreparedProviderTurn.prepare({ ...turnInput(identity), capabilitySnapshot: drifted })

    expect(driftedTurn.capability_snapshot_hash).not.toBe(base.capability_snapshot_hash)
    expect(PreparedProviderTurn.attemptIdentityHash(driftedTurn)).not.toBe(
      PreparedProviderTurn.attemptIdentityHash(base),
    )
  })

  test("a catalog-hash drift changes the attempt identity hash without touching the request hash", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const identity = ModelProtocol.protocolAttemptIdentityFor(mkModel(compatible), provider)
    const driftedCatalog = { ...snapshot, catalogBodyHash: `sha256:${"77".repeat(32)}` }

    const base = PreparedProviderTurn.prepare({ ...turnInput(identity), capabilitySnapshot: snapshot })
    const driftedTurn = PreparedProviderTurn.prepare({ ...turnInput(identity), capabilitySnapshot: driftedCatalog })

    expect(driftedTurn.request_hash).toBe(base.request_hash)
    expect(PreparedProviderTurn.attemptIdentityHash(driftedTurn)).not.toBe(
      PreparedProviderTurn.attemptIdentityHash(base),
    )
  })

  test("an omitted snapshot leaves the pre-K3 composition intact (existing receipts stay byte-stable)", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const identity = ModelProtocol.protocolAttemptIdentityFor(mkModel(compatible), provider)

    const plain = PreparedProviderTurn.prepare(turnInput(identity))

    expect(plain.capability_snapshot).toBeUndefined()
    expect(plain.capability_snapshot_hash).toBeUndefined()
    expect(PreparedProviderTurn.attemptIdentityHash(plain)).toBe(
      PreparedProviderTurn.attemptIdentityHash(
        PreparedProviderTurn.prepare(turnInput(identity)),
      ),
    )
  })
})
