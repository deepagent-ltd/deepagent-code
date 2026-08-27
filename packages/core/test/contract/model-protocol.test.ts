import { describe, expect, test } from "bun:test"
import {
  ModelProviderConfig,
  ModelCatalogEntry,
  RemoteCompactReceipt,
  RemoteCompactSettled,
  RemoteCompactRecoveryRequired,
  ModelProtocolDecodeError,
  RemoteCompactGateError,
  decodeModelProviderConfig,
  encodeModelProviderConfig,
  validateModelProviderConfig,
  decodeModelCatalogEntry,
  encodeModelCatalogEntry,
  decodeRemoteCompactReceipt,
  encodeRemoteCompactReceipt,
  assertRemoteCompactEligible,
  modelProviderConfigDigest,
  modelCatalogEntryDigest,
  remoteCompactReceiptDigest,
  ModelProtocol,
  ModelProtocolDisabledReason,
  ModelProtocolCapabilities,
  ModelProtocolSelectionState,
} from "../../src/contract/model-protocol"

function makeConfig(): ModelProviderConfig {
  return decodeModelProviderConfig({
    schemaVersion: "model-protocol.v1",
    providerId: "prov-1",
    protocol: "openai.responses",
    selectionKind: "canonical_openai",
    selectionState: "selected",
    routeOrigin: { routeId: "route-1", originId: "origin-1", endpointRef: "ep://1", protocolVersion: "responses-v1", region: "us" },
    versionBindings: {
      endpointVersion: "ev-1",
      originVersion: "ov-1",
      capabilityVersion: "cv-1",
      loweringVersion: 1,
    },
    capabilities: {
      structuredOutput: true,
      reasoningItems: true,
      providerToolExecution: false,
      previousResponseId: true,
      remoteCompaction: true,
      streamTransport: "http_sse",
      protocolRevision: 1,
    },
  })
}

function makeCatalogEntry(): ModelCatalogEntry {
  return decodeModelCatalogEntry({
    schemaVersion: "model-catalog-entry.v1",
    modelId: "model-1",
    providerId: "prov-1",
    protocol: "openai.responses",
    availability: "allowlisted",
    routeOrigin: { routeId: "route-1", originId: "origin-1", endpointRef: "ep://1", protocolVersion: "responses-v1" },
    versionBindings: {
      endpointVersion: "ev-1",
      originVersion: "ov-1",
      capabilityVersion: "cv-1",
      loweringVersion: 1,
    },
    capabilities: {
      structuredOutput: true,
      reasoningItems: true,
      providerToolExecution: false,
      previousResponseId: true,
      remoteCompaction: true,
      streamTransport: "http_sse",
      protocolRevision: 1,
    },
    contextWindow: 128000,
  })
}

function makeReceipt(): RemoteCompactReceipt {
  return decodeRemoteCompactReceipt({
    schemaVersion: "model-compact-receipt.v1",
    compactReceiptId: "rc-1",
    compactAttemptId: "ca-1",
    protocol: "openai.responses",
    wireHash: "wire-1",
    outcome: { outcome: "compacted", responseHash: "resp-1", responseFingerprint: "fp-1", compactedHistoryRef: "hist://compacted", tokenCount: 120 },
    originalHistoryRef: "hist://original",
    resultHash: "res-1",
    completedAt: 100,
  })
}

function decodeError(input: unknown): ModelProtocolDecodeError {
  try {
    decodeModelProviderConfig(input)
  } catch (error) {
    if (error instanceof ModelProtocolDecodeError) return error
    throw error
  }
  throw new Error("expected decodeModelProviderConfig to fail")
}

describe("model protocol contract round-trip and digest", () => {
  test("config encode -> decode round-trip is deterministic", () => {
    const config = makeConfig()
    const decoded = decodeModelProviderConfig(encodeModelProviderConfig(config))
    expect(decoded).toEqual(config)
  })

  test("catalog entry encode -> decode round-trip is deterministic", () => {
    const entry = makeCatalogEntry()
    const decoded = decodeModelCatalogEntry(encodeModelCatalogEntry(entry))
    expect(decoded).toEqual(entry)
  })

  test("remote compact receipt encode -> decode round-trip is deterministic", () => {
    const receipt = makeReceipt()
    const decoded = decodeRemoteCompactReceipt(encodeRemoteCompactReceipt(receipt))
    expect(decoded).toEqual(receipt)
  })

  test("config digest is byte-stable", () => {
    const config = makeConfig()
    const first = modelProviderConfigDigest(config)
    const second = modelProviderConfigDigest(config)
    expect(first).toEqual(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  test("digest is canonical over JSON-equivalent key order", () => {
    const config = makeConfig()
    const reordered: Record<string, unknown> = {}
    for (const key of Object.keys(config).toReversed()) reordered[key] = (config as unknown as Record<string, unknown>)[key]
    expect(modelProviderConfigDigest(config)).toEqual(modelProviderConfigDigest(reordered as unknown as ModelProviderConfig))
  })
})

describe("model protocol: unknown value rejection", () => {
  test("unknown protocol value is rejected", () => {
    const input = { ...(makeConfig() as unknown as Record<string, unknown>), protocol: "bogus" }
    expect(decodeError(input).path).toEqual(["protocol"])
  })

  test("the four legal protocols decode", () => {
    for (const protocol of ["openai.responses", "openai-compatible.responses", "openai-compatible.chat", "anthropic.messages"] as const) {
      const config = makeConfig()
      ;(config as unknown as { protocol: string }).protocol = protocol
      expect(() => decodeModelProviderConfig(config)).not.toThrow()
    }
  })

  test("unknown stream transport is rejected", () => {
    const input = makeConfig() as unknown as { capabilities: { streamTransport?: unknown } }
    input.capabilities.streamTransport = "bogus_transport"
    expect(decodeError(input).path).toEqual(["capabilities", "streamTransport"])
  })

  test("unknown selection kind is rejected", () => {
    const input = { ...(makeConfig() as unknown as Record<string, unknown>), selectionKind: "bogus" }
    expect(decodeError(input).path).toEqual(["selectionKind"])
  })

  test("unknown availability is rejected", () => {
    const input = { ...(makeCatalogEntry() as unknown as Record<string, unknown>), availability: "bogus" }
    let path: readonly string[] = []
    try {
      decodeModelCatalogEntry(input)
    } catch (error) {
      if (error instanceof ModelProtocolDecodeError) path = error.path
    }
    expect(path).toEqual(["availability"])
  })
})

describe("model protocol contract negative shapes", () => {
  test("missing field -> typed error with exact path", () => {
    const input = makeConfig() as unknown as { versionBindings: { loweringVersion?: unknown } }
    delete input.versionBindings!.loweringVersion
    const error = decodeError(input)
    expect(error).toBeInstanceOf(ModelProtocolDecodeError)
    expect(error.path).toEqual(["versionBindings", "loweringVersion"])
  })

  test("extra field -> typed error with exact path", () => {
    const input = { ...(makeConfig() as unknown as Record<string, unknown>), unexpected: true }
    expect(decodeError(input).path).toEqual(["unexpected"])
  })

  test("wrong type -> typed error with exact path", () => {
    const input = makeCatalogEntry() as unknown as Record<string, unknown>
    input.contextWindow = "oops"
    let path: readonly string[] = []
    try {
      decodeModelCatalogEntry(input)
    } catch (error) {
      if (error instanceof ModelProtocolDecodeError) path = error.path
    }
    expect(path).toEqual(["contextWindow"])
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...(makeConfig() as unknown as Record<string, unknown>), schemaVersion: "model-protocol.v2" }
    expect(decodeError(input).path).toEqual(["schemaVersion"])
  })
})

describe("remote compact contract (design §5.3)", () => {
  test("remote compact gate rejects a non-Responses route", () => {
    const caps = makeConfig().capabilities
    expect(() => assertRemoteCompactEligible("openai-compatible.chat", caps, "selected")).toThrow(RemoteCompactGateError)
  })

  test("remote compact gate rejects when remote compaction capability is false", () => {
    const caps: ModelProtocolCapabilities = { ...makeConfig().capabilities, remoteCompaction: false }
    expect(() => assertRemoteCompactEligible("openai.responses", caps, "selected")).toThrow(RemoteCompactGateError)
  })

  test("remote compact gate rejects a disabled selection state", () => {
    expect(() => assertRemoteCompactEligible("openai.responses", makeConfig().capabilities, "disabled")).toThrow(
      RemoteCompactGateError,
    )
  })

  test("remote compact is eligible for a Responses route with capability enabled", () => {
    expect(() => assertRemoteCompactEligible("openai.responses", makeConfig().capabilities, "selected")).not.toThrow()
    expect(() =>
      assertRemoteCompactEligible("openai-compatible.responses", makeConfig().capabilities, "probed"),
    ).not.toThrow()
  })

  test("compacted result decodes", () => {
    const receipt = makeReceipt()
    expect(receipt.outcome.outcome).toEqual("compacted")
  })

  test("recovery result decodes and never masks as local success", () => {
    const receipt = decodeRemoteCompactReceipt({
      schemaVersion: "model-compact-receipt.v1",
      compactReceiptId: "rc-2",
      compactAttemptId: "ca-2",
      protocol: "openai.responses",
      wireHash: "wire-2",
      outcome: {
        outcome: "recovery_required",
        reasonCode: "network_unknown",
        retainedOriginalHistoryRef: "hist://original",
        historyStaysReadable: true,
        noLocalSummaryFallback: true,
      },
      originalHistoryRef: "hist://original",
      resultHash: "res-2",
      completedAt: 100,
    })
    expect(receipt.outcome.outcome).toEqual("recovery_required")
    const outcome = receipt.outcome as RemoteCompactRecoveryRequired
    expect(outcome.noLocalSummaryFallback).toBe(true)
    expect(outcome.historyStaysReadable).toBe(true)
  })

  test("wrong outcome discriminant -> typed error with exact path", () => {
    const input = { ...(makeReceipt() as unknown as Record<string, unknown>), outcome: { outcome: "bogus", ref: "x" } }
    let path: readonly string[] = []
    try {
      decodeRemoteCompactReceipt(input)
    } catch (error) {
      if (error instanceof ModelProtocolDecodeError) path = error.path
    }
    expect(path).toEqual(["outcome"])
  })

  test("missing field in compacted union member -> typed error with exact path", () => {
    const input = { ...(makeReceipt() as unknown as Record<string, unknown>), outcome: { outcome: "compacted", responseHash: "r" } }
    let path: readonly string[] = []
    try {
      decodeRemoteCompactReceipt(input)
    } catch (error) {
      if (error instanceof ModelProtocolDecodeError) path = error.path
    }
    expect(path).toEqual(["outcome", "responseFingerprint"])
  })

  test("missing field in recovery union member -> typed error with exact path", () => {
    const input = {
      ...(makeReceipt() as unknown as Record<string, unknown>),
      outcome: { outcome: "recovery_required", reasonCode: "timeout", retainedOriginalHistoryRef: "h" },
    }
    let path: readonly string[] = []
    try {
      decodeRemoteCompactReceipt(input)
    } catch (error) {
      if (error instanceof ModelProtocolDecodeError) path = error.path
    }
    expect(path).toEqual(["outcome", "historyStaysReadable"])
  })
})

describe("disabled / unknown protocol selection (design §5.2)", () => {
  test("unknown/conflict config is disabled with model_protocol_selection_required", () => {
    const config = decodeModelProviderConfig({
      ...(makeConfig() as unknown as Record<string, unknown>),
      selectionKind: "unknown",
      selectionState: "disabled",
      disabledReason: "model_protocol_selection_required",
    })
    expect(config.selectionState).toEqual("disabled")
    expect(config.disabledReason).toEqual("model_protocol_selection_required")
  })

  test("validate (non-throwing) returns the value for a valid config", () => {
    const result = validateModelProviderConfig(makeConfig())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.providerId).toEqual("prov-1")
  })

  test("validate (non-throwing) returns the typed error for an invalid config", () => {
    const result = validateModelProviderConfig({ ...(makeConfig() as unknown as Record<string, unknown>), protocol: "nope" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ModelProtocolDecodeError)
      expect(result.error.path).toEqual(["protocol"])
    }
  })
})
