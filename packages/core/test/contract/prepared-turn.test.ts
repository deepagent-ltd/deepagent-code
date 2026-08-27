import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  PreparedProviderTurn,
  PreparedTurnDecodeError,
  PreparedTurnMismatchError,
  PreparedTurnState,
  PreparedTurnStateLiterals,
  PreparedTurnProviderTerminalEvidence,
  PreparedTurnPrepared,
  PreparedTurnDispatching,
  PreparedTurnStreaming,
  PreparedTurnSettled,
  PreparedTurnFailedTerminal,
  PreparedTurnIndeterminate,
  PreparedTurnAbandonedBeforeDispatch,
  PreparedTurnResolvedAbandoned,
  PreparedTurnResolvedSettled,
  PreparedTurnFrozenForked,
  decodePreparedProviderTurn,
  encodePreparedProviderTurn,
  validatePreparedProviderTurn,
  assertPreparedTurnExactRetry,
  preparedTurnDigest,
} from "../../src/contract/prepared-turn"
import { ModelProtocol } from "../../src/contract/model-protocol"
import { RecoveryAttemptState, RecoveryProviderEvidenceState } from "../../src/contract/recovery-command"
import { SelectionModelCapability, decodeSelectionEnvelope } from "../../src/contract/selection"

function makeSelection() {
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
        status: "ready",
        revision: "r",
        adapterVersion: "a1",
        observedMutationEpoch: 0,
        latencyMs: 1,
        candidateCount: 1,
        reasonCode: "none",
      },
      memory: {
        graph: "memory",
        status: "ready",
        revision: "r",
        adapterVersion: "a1",
        observedMutationEpoch: 0,
        latencyMs: 1,
        candidateCount: 1,
        reasonCode: "none",
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

function makeTurn(state: string, detail: unknown): Record<string, unknown> {
  return {
    schemaVersion: "prepared-turn.v1",
    turnId: "turn-1",
    attemptVersion: 1,
    requestHash: "req-1",
    providerModelRoute: {
      providerId: "prov-1",
      modelId: "model-1",
      protocolIdentity: {
        protocol: "openai.responses",
        routeId: "route-1",
        originId: "origin-1",
        endpointOriginHash: "eo-1",
        capabilityFingerprint: "cap-1",
        loweringVersion: 1,
        protocolRevision: 1,
      },
    },
    selectionIdentity: {
      selectionId: "sel-1",
      revision: 0,
      queryFingerprint: "qf",
      authorizationFingerprint: "af",
      executionFingerprint: "ef",
      observedLocationMutationEpoch: 0,
      selectedSourceFingerprint: "sf",
    },
    selection: makeSelection(),
    selectionHash: "selhash-1",
    permissionFingerprint: "perm-1",
    capabilitySnapshot: {
      catalogSnapshotId: "cat-1",
      catalogBodyHash: "cb-1",
      catalogRuntimeHash: "cr-1",
      catalogPermissionHash: "cp-1",
      loadedCapabilities: [{ capabilityId: "cap-1", bodyHash: "cb-1" }],
    },
    routeOriginHash: "ro-1",
    protocolLoweringHash: "pl-1",
    modelCapabilityEvidence: {
      modelId: "model-1",
      providerId: "prov-1",
      protocol: "openai.responses",
      capabilityFingerprint: "cap-1",
      contextWindow: 128000,
      structuredOutput: true,
      probeRef: "probe-1",
      probeResponseFingerprint: "pfp-1",
    },
    validation: {
      validationId: "val-1",
      outcome: "valid",
      authorizationFingerprint: "af",
      egressFingerprint: "egf",
      locationMutationEpoch: 0,
      releasedKnowledgeBinding: "bound",
    },
    state,
    ...(structuredClone(detail) as Record<string, unknown>),
  }
}

const details: Record<string, unknown> = {
  prepared: { prepared: { wireHash: "wire-1", sealedAt: "sealed-at" } },
  dispatching: { dispatching: { wireHash: "wire-1", transportKey: "http_sse", dispatchEpoch: 1, dispatchedAt: "dispatched-at" } },
  streaming: { streaming: { wireHash: "wire-1", streamId: "stream-1", firstSeq: 0, transportKey: "http_sse" } },
  settled: {
    settled: {
      responseHash: "resp-1",
      responseFingerprint: "fp-1",
      finishReason: "complete",
      providerTerminalEvidence: "settled",
      terminal: "settled",
    },
  },
  failed_terminal: { failedTerminal: { predicate: "wire_never_sent", noLateResultProof: true } },
  indeterminate_after_crash: {
    indeterminate: { uncertaintyReason: "network_unknown", networkUnknown: true, originalHistoryRef: "hist://orig" },
  },
  abandoned_before_dispatch: {
    abandonedBeforeDispatch: { uncertaintyReason: "client_cancel", safeBoundaryRef: "hist://safe" },
  },
  resolved_abandoned: {
    resolvedAbandoned: { resolutionRef: "res-1", bridgeRef: "bridge-1", terminal: "abandoned", uncertaintyReason: "timeout" },
  },
  resolved_settled: {
    resolvedSettled: { resolutionRef: "res-1", bridgeRef: "bridge-1", terminal: "settled", evidenceHash: "ev-1" },
  },
  frozen_forked: {
    frozenForked: { forkRef: "fork-1", safeBoundaryRef: "hist://safe", originalSessionReadOnly: true, forkManifestRef: "fm-1" },
  },
}

function makeValidTurn(state: string): PreparedProviderTurn {
  return decodePreparedProviderTurn(makeTurn(state, details[state]))
}

function decodeError(input: unknown): PreparedTurnDecodeError {
  try {
    decodePreparedProviderTurn(input)
  } catch (error) {
    if (error instanceof PreparedTurnDecodeError) return error
    throw error
  }
  throw new Error("expected decodePreparedProviderTurn to fail")
}

describe("prepared provider turn contract round-trip and digest", () => {
  test("all ten legal states decode", () => {
    for (const state of Object.keys(details)) {
      expect(() => makeValidTurn(state)).not.toThrow()
    }
  })

  test("encode -> decode round-trip is deterministic (settled)", () => {
    const turn = makeValidTurn("settled")
    const decoded = decodePreparedProviderTurn(encodePreparedProviderTurn(turn))
    expect(decoded).toEqual(turn)
  })

  test("digest is byte-stable", () => {
    const turn = makeValidTurn("prepared")
    expect(preparedTurnDigest(turn)).toEqual(preparedTurnDigest(turn))
    expect(preparedTurnDigest(turn)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("prepared provider turn: per-member negatives for every union member", () => {
  const memberPaths: Record<string, string[]> = {
    prepared: ["prepared", "wireHash"],
    dispatching: ["dispatching", "dispatchEpoch"],
    streaming: ["streaming", "firstSeq"],
    settled: ["settled", "responseHash"],
    failed_terminal: ["failedTerminal", "predicate"],
    indeterminate_after_crash: ["indeterminate", "originalHistoryRef"],
    abandoned_before_dispatch: ["abandonedBeforeDispatch", "safeBoundaryRef"],
    resolved_abandoned: ["resolvedAbandoned", "bridgeRef"],
    resolved_settled: ["resolvedSettled", "evidenceHash"],
    frozen_forked: ["frozenForked", "forkRef"],
  }
  for (const [state, path] of Object.entries(memberPaths)) {
    test(`missing ${path[0]}.${path[1]} for state=${state} -> typed error`, () => {
      const input = makeTurn(state, details[state]) as Record<string, unknown>
      const detailObj = input[path[0]!] as Record<string, unknown>
      delete detailObj[path[1]!]
      const error = decodeError(input)
      expect(error.path).toEqual(path)
    })
  }
})

describe("prepared provider turn negative shapes", () => {
  test("missing common field -> typed error with exact path", () => {
    const input = makeTurn("prepared", details.prepared) as Record<string, unknown>
    delete input.requestHash
    expect(decodeError(input).path).toEqual(["requestHash"])
  })

  test("extra field -> typed error with exact path", () => {
    const input = { ...(makeTurn("prepared", details.prepared) as Record<string, unknown>), unexpected: true }
    expect(decodeError(input).path).toEqual(["unexpected"])
  })

  test("wrong type -> typed error with exact path", () => {
    const input = makeTurn("prepared", details.prepared) as Record<string, unknown>
    input.attemptVersion = "oops"
    expect(decodeError(input).path).toEqual(["attemptVersion"])
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...(makeTurn("prepared", details.prepared) as Record<string, unknown>), schemaVersion: "prepared-turn.v2" }
    expect(decodeError(input).path).toEqual(["schemaVersion"])
  })

  test("wrong discriminant (unknown state) -> typed error with exact path", () => {
    const input = makeTurn("bogus_state", {})
    expect(decodeError(input).path).toEqual(["state"])
  })
})

describe("prepared provider turn: exact-retry binding (design §2.3, §4.1)", () => {
  test("an exact candidate does not throw", () => {
    const turn = makeValidTurn("prepared")
    expect(() =>
      assertPreparedTurnExactRetry(turn, {
        requestHash: turn.requestHash,
        routeOriginHash: turn.routeOriginHash,
        protocolLoweringHash: turn.protocolLoweringHash,
        permissionFingerprint: turn.permissionFingerprint,
        selectionHash: turn.selectionHash,
      }),
    ).not.toThrow()
  })

  test("a drifting request hash is a typed conflict", () => {
    const turn = makeValidTurn("prepared")
    expect(() =>
      assertPreparedTurnExactRetry(turn, {
        requestHash: "different",
        routeOriginHash: turn.routeOriginHash,
        protocolLoweringHash: turn.protocolLoweringHash,
        permissionFingerprint: turn.permissionFingerprint,
        selectionHash: turn.selectionHash,
      }),
    ).toThrow(PreparedTurnMismatchError)
  })

  test("a drifting selection hash is a typed conflict", () => {
    const turn = makeValidTurn("prepared")
    expect(() =>
      assertPreparedTurnExactRetry(turn, {
        requestHash: turn.requestHash,
        routeOriginHash: turn.routeOriginHash,
        protocolLoweringHash: turn.protocolLoweringHash,
        permissionFingerprint: turn.permissionFingerprint,
        selectionHash: "different",
      }),
    ).toThrow(PreparedTurnMismatchError)
  })
})

describe("cross-lane consistency of the state vocabulary", () => {
  test("every PreparedTurnState is a legal RecoveryAttemptState", () => {
    for (const state of PreparedTurnStateLiterals) {
      expect(() => Schema.decodeUnknownSync(RecoveryAttemptState)(state)).not.toThrow()
    }
  })

  test("validate (non-throwing) returns the value for a valid turn", () => {
    const result = validatePreparedProviderTurn(makeTurn("settled", details.settled))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.state).toEqual("settled")
  })

  test("validate (non-throwing) returns the typed error for an invalid turn", () => {
    const result = validatePreparedProviderTurn({ ...(makeTurn("settled", details.settled) as Record<string, unknown>), schemaVersion: "nope" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.path).toEqual(["schemaVersion"])
  })
})

describe("F1: digest strips state-detail timestamps", () => {
  test("prepared turn digest ignores sealedAt", () => {
    const a = decodePreparedProviderTurn(makeTurn("prepared", { prepared: { wireHash: "w", sealedAt: "t1" } }))
    const b = decodePreparedProviderTurn(makeTurn("prepared", { prepared: { wireHash: "w", sealedAt: "t2" } }))
    expect(preparedTurnDigest(a)).toEqual(preparedTurnDigest(b))
  })

  test("dispatching turn digest ignores dispatchedAt", () => {
    const a = decodePreparedProviderTurn(
      makeTurn("dispatching", { dispatching: { wireHash: "w", transportKey: "http_sse", dispatchEpoch: 1, dispatchedAt: "t1" } }),
    )
    const b = decodePreparedProviderTurn(
      makeTurn("dispatching", { dispatching: { wireHash: "w", transportKey: "http_sse", dispatchEpoch: 1, dispatchedAt: "t2" } }),
    )
    expect(preparedTurnDigest(a)).toEqual(preparedTurnDigest(b))
  })
})

describe("F2: cross-lane set equality", () => {
  function sameSet(a: readonly string[], b: readonly string[]): boolean {
    const sa = new Set(a)
    const sb = new Set(b)
    return sa.size === sb.size && [...sa].every((x) => sb.has(x)) && [...sb].every((x) => sa.has(x))
  }

  test("reverse: every RecoveryAttemptState literal decodes as a prepared-turn state", () => {
    for (const s of (RecoveryAttemptState as unknown as { literals: string[] }).literals) {
      expect(() => Schema.decodeUnknownSync(PreparedTurnState)(s)).not.toThrow()
    }
  })

  test("PreparedTurnState == RecoveryAttemptState (exact set, both directions)", () => {
    expect(
      sameSet(
        (PreparedTurnState as unknown as { literals: string[] }).literals,
        (RecoveryAttemptState as unknown as { literals: string[] }).literals,
      ),
    ).toBe(true)
  })

  test("ModelProtocol == SelectionModelCapability.protocol (exact protocol set)", () => {
    expect(
      sameSet(
        (ModelProtocol as unknown as { literals: string[] }).literals,
        (SelectionModelCapability as unknown as { fields: { protocol: { literals: string[] } } }).fields.protocol.literals,
      ),
    ).toBe(true)
  })

  test("PreparedTurnProviderTerminalEvidence == RecoveryProviderEvidenceState (exact set)", () => {
    expect(
      sameSet(
        (PreparedTurnProviderTerminalEvidence as unknown as { literals: string[] }).literals,
        (RecoveryProviderEvidenceState as unknown as { literals: string[] }).literals,
      ),
    ).toBe(true)
  })
})

describe("F4: triple state-representation guard", () => {
  test("schema, array and member-class state literals are exactly equal (order-insensitive)", () => {
    const schemaLs = (PreparedTurnState as unknown as { literals: string[] }).literals
    const members = [
      PreparedTurnPrepared,
      PreparedTurnDispatching,
      PreparedTurnStreaming,
      PreparedTurnSettled,
      PreparedTurnFailedTerminal,
      PreparedTurnIndeterminate,
      PreparedTurnAbandonedBeforeDispatch,
      PreparedTurnResolvedAbandoned,
      PreparedTurnResolvedSettled,
      PreparedTurnFrozenForked,
    ]
    const memberLs = members.map(
      (c) => (c as unknown as { fields: { state: { ast: { literal: string } } } }).fields.state.ast.literal,
    )
    const sortSet = (arr: readonly string[]) => [...new Set(arr)].sort()
    expect(sortSet(memberLs)).toEqual(sortSet(PreparedTurnStateLiterals))
    expect(sortSet(memberLs)).toEqual(sortSet(schemaLs))
  })
})
