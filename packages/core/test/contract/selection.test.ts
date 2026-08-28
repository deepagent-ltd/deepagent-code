import { describe, expect, test } from "bun:test"
import {
  SelectionDecodeError,
  SelectionEnvelope,
  decodeSelectionEnvelope,
  encodeSelectionEnvelope,
  validateSelection,
  selectionDigest,
} from "../../src/contract/selection"

function makeEnvelope(): SelectionEnvelope {
  return decodeSelectionEnvelope({
    schemaVersion: "context-selection.v1",
    selectionMode: "v2",
    selectionId: "sel-1",
    revision: 0,
    triggerInputId: "in-1",
    membership: { sessionId: "ses-1", activityId: "act-1", inputIds: ["in-1"] },
    location: { locationKey: "loc-1" },
    principal: { principalId: "p-1", authorizationEpoch: 1 },
    workspace: { workspaceId: "ws-1", tenantId: "t-1" },
    securityNamespace: { securityNamespaceId: "ns-1" },
    projectScope: { projectScopeKey: "psc-1", projectId: "proj-1" },
    egress: {
      policyId: "eg-1",
      epoch: 1,
      graphs: ["code", "documents", "knowledge", "memory"],
      sensitivities: ["public", "source_code"],
    },
    agentPolicy: { agentId: "ag-1", autonomyCeiling: "medium", permitDegraded: false },
    modelCapability: {
      modelId: "m-1",
      providerId: "prov-1",
      protocol: "openai.responses",
      contextWindow: 128000,
      structuredOutput: true,
    },
    releasedKnowledge: { snapshotId: "snap-1", binding: "bound" },
    queryIntent: "search",
    identity: {
      selectionId: "sel-1",
      revision: 0,
      queryFingerprint: "qf",
      authorizationFingerprint: "af",
      executionFingerprint: "ef",
      observedLocationMutationEpoch: 0,
      selectedSourceFingerprint: "sf",
    },
    validation: { validationId: "val-1", outcome: "valid", validUntil: 0 },
    graphStatuses: {
      code: {
        graph: "code",
        status: "ready",
        revision: "r",
        adapterVersion: "a1",
        observedMutationEpoch: 0,
        latencyMs: 5,
        candidateCount: 3,
        reasonCode: "none",
      },
      documents: {
        graph: "documents",
        status: "empty",
        revision: "r",
        adapterVersion: "a1",
        observedMutationEpoch: 0,
        latencyMs: 2,
        candidateCount: 0,
        reasonCode: "none",
      },
      knowledge: {
        graph: "knowledge",
        status: "denied",
        revision: "r",
        adapterVersion: "a1",
        observedMutationEpoch: 0,
        latencyMs: 1,
        candidateCount: 0,
        reasonCode: "security_namespace_denied",
      },
      memory: {
        graph: "memory",
        status: "timeout",
        revision: "r",
        adapterVersion: "a1",
        observedMutationEpoch: 0,
        latencyMs: 9,
        candidateCount: 0,
        reasonCode: "fresh_timeout",
      },
    },
    selectedRefs: [
      {
        graph: "code",
        ref: "ctx://code/x",
        token: "tok-1",
        score: 0.9,
        freshness: "current",
        sensitivity: "source_code",
        reason: "exact ref",
      },
    ],
    projectionHash: "proj-hash",
    tokenCount: 100,
    artifactBinding: { status: "available", ref: "ctx://artifact/1" },
  })
}

function decodeError(input: unknown): SelectionDecodeError {
  try {
    decodeSelectionEnvelope(input)
  } catch (error) {
    if (error instanceof SelectionDecodeError) return error
    throw error
  }
  throw new Error("expected decodeSelectionEnvelope to fail")
}

describe("selection contract round-trip and digest", () => {
  test("encode -> decode round-trip is deterministic", () => {
    const envelope = makeEnvelope()
    const encoded = encodeSelectionEnvelope(envelope)
    const decoded = decodeSelectionEnvelope(encoded)
    expect(decoded).toEqual(envelope)
  })

  test("digest is byte-stable: same input two calls -> identical", () => {
    const envelope = makeEnvelope()
    const first = selectionDigest(envelope)
    const second = selectionDigest(envelope)
    expect(first).toEqual(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  test("digest is canonical over JSON-equivalent key order", () => {
    const a = makeEnvelope()
    const aKeys = Object.keys(a)
    const reordered: Record<string, unknown> = {}
    for (const key of aKeys.toReversed()) reordered[key] = (a as unknown as Record<string, unknown>)[key]
    const digestA = selectionDigest(a)
    const digestB = selectionDigest(reordered as unknown as SelectionEnvelope)
    expect(digestA).toEqual(digestB)
  })

  test("digest excludes the volatile timestamp field", () => {
    const base = makeEnvelope() as unknown as Record<string, unknown>
    const withTime = { ...base, time: 1234567890 }
    const withoutTime = { ...base }
    expect(selectionDigest(withTime as unknown as SelectionEnvelope)).toEqual(
      selectionDigest(withoutTime as unknown as SelectionEnvelope),
    )
  })
})

describe("selection contract negative shapes", () => {
  test("missing field -> typed error with exact path", () => {
    const input = makeEnvelope() as unknown as { validation: { validUntil?: unknown } }
    delete input.validation!.validUntil
    const error = decodeError(input)
    expect(error).toBeInstanceOf(SelectionDecodeError)
    expect(error.path).toEqual(["validation", "validUntil"])
  })

  test("extra field -> typed error with exact path", () => {
    const input = { ...(makeEnvelope() as unknown as Record<string, unknown>), unexpected: true }
    const error = decodeError(input)
    expect(error.path).toEqual(["unexpected"])
  })

  test("wrong type -> typed error with exact path", () => {
    const input = { ...(makeEnvelope() as unknown as Record<string, unknown>), revision: "oops" }
    const error = decodeError(input)
    expect(error.path).toEqual(["revision"])
  })

  test("unknown enum value (graph status) -> typed error with exact path", () => {
    const input = makeEnvelope() as unknown as { graphStatuses: { code: { status: unknown } } }
    input.graphStatuses.code.status = "bogus"
    const error = decodeError(input)
    expect(error.path).toEqual(["graphStatuses", "code", "status"])
  })

  test("missing required graph is rejected with exact path", () => {
    const input = makeEnvelope() as unknown as Record<string, unknown>
    delete (input.graphStatuses as Record<string, unknown>).knowledge
    const error = decodeError(input)
    expect(error.path).toEqual(["graphStatuses", "knowledge"])
  })

  test("unexpected extra graph key is rejected", () => {
    const input = makeEnvelope() as unknown as Record<string, unknown>
    const graphs = input.graphStatuses as Record<string, unknown>
    graphs["extra_graph"] = {
      graph: "extra_graph",
      status: "ready",
      revision: "r",
      adapterVersion: "a",
      observedMutationEpoch: 0,
      latencyMs: 1,
      candidateCount: 0,
    }
    const error = decodeError(input)
    expect(error.path).toEqual(["graphStatuses", "extra_graph"])
  })

  test("wrong discriminant (artifact binding) -> typed error with exact path", () => {
    const input = { ...(makeEnvelope() as unknown as Record<string, unknown>), artifactBinding: { status: "unknown", ref: "x" } }
    const error = decodeError(input)
    expect(error.path).toEqual(["artifactBinding"])
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...(makeEnvelope() as unknown as Record<string, unknown>), schemaVersion: "context-selection.v2" }
    const error = decodeError(input)
    expect(error.path).toEqual(["schemaVersion"])
  })

  test("missing reasonCode -> typed error with exact path", () => {
    const input = makeEnvelope() as unknown as { graphStatuses: { code: { reasonCode?: unknown } } }
    delete input.graphStatuses.code.reasonCode
    expect(decodeError(input).path).toEqual(["graphStatuses", "code", "reasonCode"])
  })

  test("unknown reason code -> typed error", () => {
    const input = makeEnvelope() as unknown as Record<string, unknown>
    ;(input.graphStatuses as { code: { reasonCode?: unknown } }).code.reasonCode = "definitely_not_a_reason"
    const error = decodeError(input)
    expect(error.path).toEqual(["graphStatuses", "code", "reasonCode"])
  })
})

describe("selection contract: v2-none is not a legal value", () => {
  test("status value v2-none is rejected as an unknown enum", () => {
    const input = makeEnvelope() as unknown as { graphStatuses: { code: { status: unknown } } }
    input.graphStatuses.code.status = "v2-none"
    const error = decodeError(input)
    expect(error.path).toEqual(["graphStatuses", "code", "status"])
  })

  test("selectionMode v2-none is rejected (only v2 is legal)", () => {
    const input = { ...(makeEnvelope() as unknown as Record<string, unknown>), selectionMode: "v2-none" }
    const error = decodeError(input)
    expect(error.path).toEqual(["selectionMode"])
  })

  test("shorthand degraded is rejected (only degraded_unavailable is legal)", () => {
    const input = makeEnvelope() as unknown as { graphStatuses: { code: { status: unknown } } }
    input.graphStatuses.code.status = "degraded"
    const error = decodeError(input)
    expect(error.path).toEqual(["graphStatuses", "code", "status"])
  })

  test("each of the five legal graph statuses decodes", () => {
    for (const status of ["ready", "empty", "degraded_unavailable", "denied", "timeout"] as const) {
      const envelope = makeEnvelope()
      ;(envelope.graphStatuses.code as { status: string }).status = status
      expect(() => decodeSelectionEnvelope(envelope)).not.toThrow()
    }
  })
})

describe("versioned enums reject unknown values", () => {
  test("query intent rejects an unknown value", () => {
    const input = { ...(makeEnvelope() as unknown as Record<string, unknown>), queryIntent: "bogus_intent" }
    expect(decodeError(input).path).toEqual(["queryIntent"])
  })

  test("agent policy autonomy ceiling rejects an unknown value", () => {
    const input = makeEnvelope() as unknown as { agentPolicy: { autonomyCeiling?: unknown } }
    input.agentPolicy.autonomyCeiling = "bogus"
    expect(decodeError(input).path).toEqual(["agentPolicy", "autonomyCeiling"])
  })

  test("model capability protocol rejects an unknown value", () => {
    const input = makeEnvelope() as unknown as { modelCapability: { protocol?: unknown } }
    input.modelCapability.protocol = "bogus"
    expect(decodeError(input).path).toEqual(["modelCapability", "protocol"])
  })

  test("selected ref freshness rejects an unknown value", () => {
    const input = makeEnvelope() as unknown as { selectedRefs: { freshness?: unknown }[] }
    input.selectedRefs[0].freshness = "bogus"
    expect(decodeError(input).path[0]).toEqual("selectedRefs")
  })

  test("GraphStatusReasonCode already rejects unknown values (regression)", () => {
    const input = makeEnvelope() as unknown as Record<string, unknown>
    ;(input.graphStatuses as { code: { reasonCode?: unknown } }).code.reasonCode = "definitely_not_a_reason"
    expect(decodeError(input).path).toEqual(["graphStatuses", "code", "reasonCode"])
  })
})

describe("selection validate (non-throwing)", () => {
  test("valid envelope -> ok true with value", () => {
    const result = validateSelection(makeEnvelope())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.selectionId).toEqual("sel-1")
  })

  test("invalid envelope -> ok false with typed error and exact path", () => {
    const input = { ...(makeEnvelope() as unknown as Record<string, unknown>), schemaVersion: "nope" }
    const result = validateSelection(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SelectionDecodeError)
      expect(result.error.path).toEqual(["schemaVersion"])
    }
  })
})
