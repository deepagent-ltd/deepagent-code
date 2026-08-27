import { describe, expect, test } from "bun:test"
import {
  RecoveryCommand,
  RecoveryDescriptor,
  RecoveryEvidence,
  RecoveryDecodeError,
  FreeTextEvidenceError,
  decodeRecoveryCommand,
  encodeRecoveryCommand,
  decodeRecoveryDescriptor,
  encodeRecoveryDescriptor,
  decodeRecoveryEvidence,
  encodeRecoveryEvidence,
  validateRecoveryCommand,
  recoveryCommandDigest,
  recoveryDescriptorDigest,
  recoveryEvidenceDigest,
  assertEvidenceTyped,
} from "../../src/contract/recovery-command"

const descriptorCommon = {
  schemaVersion: "recovery-descriptor.v1",
  requestHash: "req-hash",
  provenance: { origin: "recorded", sourceRefs: ["ctx://src/1"] },
  baseline: { baselineHash: "bh", sourceSnapshotRef: "ctx://snap/1", verified: true },
  terminalBridge: { bridgeId: "bridge-1", bridgeType: "terminal", terminalRef: "ctx://term/1" },
  casTokens: { expectedState: "running", expectedVersion: 1, ownerToken: "owner-1" },
}

function descriptorPayload(kind: "exact" | "repairable" | "fork" | "coordination" | "resolved") {
  switch (kind) {
    case "exact":
      return { exact: { attemptHash: "ah", selectionHash: "sh", historyHash: "hh", baselineHash: "bh", allVerified: true } }
    case "repairable":
      return { repairable: { baselineState: "corrupt", sourceSnapshotRef: "ctx://snap/1", canReconstruct: true } }
    case "fork":
      return { fork: { safeBoundaryRef: "ctx://bound/1", safeBoundaryHash: "sbh", reasonCode: "safe_boundary_none", originalSessionReadOnly: true } }
    case "coordination":
      return { coordination: { reason: "provider_lookup_incomplete", requiredActor: "admin", evidenceExportRef: "ctx://exp/1" } }
    case "resolved":
      return { resolved: { resolutionRef: "ctx://res/1", bridgeRef: "ctx://bridge/1", terminal: "settled" } }
  }
}

function descriptorInput(kind: "exact" | "repairable" | "fork" | "coordination" | "resolved") {
  return { ...descriptorCommon, descriptorKind: kind, ...descriptorPayload(kind) }
}

function makeDescriptor(kind: "exact" | "repairable" | "fork" | "coordination" | "resolved"): RecoveryDescriptor {
  return decodeRecoveryDescriptor(descriptorInput(kind))
}

function makeEvidence(): RecoveryEvidence {
  return decodeRecoveryEvidence({
    schemaVersion: "recovery-evidence.v1",
    providerId: "provider-1",
    externalRequestId: "ext-1",
    idempotencyKey: "idem-1",
    terminalState: "settled",
    payloadHash: "payload-hash",
    responseFingerprint: "fingerprint-1",
    retrievalRef: "ctx://retrieve/1",
    attestationRef: "ctx://attest/1",
    metadata: { region: "us-east-1" },
    verifiedAt: 0,
  })
}

const commandCommon = {
  schemaVersion: "recovery-command.v1",
  commandId: "cmd-1",
  sessionId: "ses-1",
  actorId: "act-1",
  permissionFingerprint: "perm-fp",
  expectedAttemptVersion: 1,
  requestedHash: "req-hash",
  decision: "proceed",
  commandCreatedAt: 0,
}

function commandInput(variant: "recover" | "abandon_exact" | "repair_baseline_and_abandon" | "fork_from_safe_boundary" | "confirm_settled" | "query_command"): Record<string, unknown> {
  const kindPayload: Record<string, unknown> =
    variant === "recover"
      ? { recover: { descriptor: makeDescriptor("exact"), intent: "resolve" } }
      : variant === "abandon_exact"
        ? { abandonExact: { descriptorRef: "desc-1", reasonCode: "network_unknown", acknowledgment: true } }
        : variant === "repair_baseline_and_abandon"
          ? { repairBaselineAndAbandon: { descriptorRef: "desc-1", baselineHash: "bh", verificationHash: "vh" } }
          : variant === "fork_from_safe_boundary"
            ? { forkFromSafeBoundary: { descriptorRef: "desc-1", safeBoundaryRef: "ctx://bound/1", forkManifestRef: "ctx://fork/1" } }
            : variant === "confirm_settled"
              ? { confirmSettled: { descriptorRef: "desc-1", evidence: makeEvidence() } }
              : { queryCommand: { commandRef: "cmd-1" } }
  return { ...commandCommon, commandKind: variant, ...kindPayload }
}

function makeCommand(variant: "recover" | "abandon_exact" | "repair_baseline_and_abandon" | "fork_from_safe_boundary" | "confirm_settled" | "query_command"): RecoveryCommand {
  return decodeRecoveryCommand(commandInput(variant))
}

function commandError(input: unknown): RecoveryDecodeError {
  try {
    decodeRecoveryCommand(input)
  } catch (error) {
    if (error instanceof RecoveryDecodeError) return error
    throw error
  }
  throw new Error("expected decodeRecoveryCommand to fail")
}

function descriptorError(input: unknown): RecoveryDecodeError {
  try {
    decodeRecoveryDescriptor(input)
  } catch (error) {
    if (error instanceof RecoveryDecodeError) return error
    throw error
  }
  throw new Error("expected decodeRecoveryDescriptor to fail")
}

function evidenceError(input: unknown): RecoveryDecodeError {
  try {
    decodeRecoveryEvidence(input)
  } catch (error) {
    if (error instanceof RecoveryDecodeError) return error
    throw error
  }
  throw new Error("expected decodeRecoveryEvidence to fail")
}

const allCommandVariants = ["recover", "abandon_exact", "repair_baseline_and_abandon", "fork_from_safe_boundary", "confirm_settled", "query_command"] as const
const allDescriptorKinds = ["exact", "repairable", "fork", "coordination", "resolved"] as const

describe("recovery contract round-trip and digest", () => {
  test("all five descriptor classes round-trip encode -> decode deterministically", () => {
    for (const kind of allDescriptorKinds) {
      expect(decodeRecoveryDescriptor(encodeRecoveryDescriptor(makeDescriptor(kind)))).toEqual(makeDescriptor(kind))
    }
  })

  test("all six recovery command variants decode and round-trip", () => {
    for (const variant of allCommandVariants) {
      expect(decodeRecoveryCommand(encodeRecoveryCommand(makeCommand(variant)))).toEqual(makeCommand(variant))
    }
  })

  test("command digest is byte-stable and independent of commandCreatedAt (timestamp)", () => {
    const a = makeCommand("recover")
    expect(recoveryCommandDigest(a)).toEqual(recoveryCommandDigest(a))
    expect(recoveryCommandDigest(a)).toMatch(/^[0-9a-f]{64}$/)
    const later = { ...(a as unknown as Record<string, unknown>), commandCreatedAt: 999999 } as unknown as RecoveryCommand
    expect(recoveryCommandDigest(later)).toEqual(recoveryCommandDigest(a))
  })

  test("command digest is canonical over JSON-equivalent key order", () => {
    const a = makeCommand("confirm_settled")
    const keys = Object.keys(a)
    const reordered: Record<string, unknown> = {}
    for (const key of keys.toReversed()) reordered[key] = (a as unknown as Record<string, unknown>)[key]
    expect(recoveryCommandDigest(a)).toEqual(recoveryCommandDigest(reordered as unknown as RecoveryCommand))
  })

  test("evidence digest is byte-stable and timestamp-independent", () => {
    const a = makeEvidence()
    expect(recoveryEvidenceDigest(a)).toEqual(recoveryEvidenceDigest(a))
    const later = { ...(a as unknown as Record<string, unknown>), verifiedAt: 888888 } as unknown as RecoveryEvidence
    expect(recoveryEvidenceDigest(later)).toEqual(recoveryEvidenceDigest(a))
  })

  test("descriptor digest is deterministic", () => {
    const a = makeDescriptor("fork")
    expect(recoveryDescriptorDigest(a)).toEqual(recoveryDescriptorDigest(a))
  })
})

describe("recovery descriptor negative shapes", () => {
  test("missing nested field -> typed error with exact path", () => {
    const input = makeDescriptor("exact") as unknown as { exact: { allVerified?: unknown } }
    delete input.exact!.allVerified
    expect(descriptorError(input).path).toEqual(["exact", "allVerified"])
  })

  test("extra field -> typed error with exact path", () => {
    const input = { ...(makeDescriptor("exact") as unknown as Record<string, unknown>), extra: true }
    expect(descriptorError(input).path).toEqual(["extra"])
  })

  test("wrong type nested -> typed error with exact path", () => {
    const input = { ...(makeDescriptor("exact") as unknown as Record<string, unknown>), exact: { attemptHash: "a", selectionHash: "s", historyHash: "h", baselineHash: "b", allVerified: "yes" } }
    expect(descriptorError(input).path).toEqual(["exact", "allVerified"])
  })

  test("unknown enum value (descriptor kind) -> typed error with exact path", () => {
    const input = { ...(makeDescriptor("exact") as unknown as Record<string, unknown>), descriptorKind: "bogus" }
    expect(descriptorError(input).path[0]).toEqual("descriptorKind")
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...(makeDescriptor("exact") as unknown as Record<string, unknown>), schemaVersion: "recovery-descriptor.v2" }
    expect(descriptorError(input).path).toEqual(["schemaVersion"])
  })
})

describe("recovery command negative shapes", () => {
  test("wrong discriminant (command kind) -> typed error", () => {
    const input = { ...(makeCommand("recover") as unknown as Record<string, unknown>), commandKind: "bogus" }
    const error = commandError(input)
    expect(error).toBeInstanceOf(RecoveryDecodeError)
  })

  test("malformed variant payload -> typed error", () => {
    const input = commandInput("query_command")
    ;(input.queryCommand as { commandRef: unknown }).commandRef = 42
    const error = commandError(input)
    expect(error).toBeInstanceOf(RecoveryDecodeError)
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...(makeCommand("recover") as unknown as Record<string, unknown>), schemaVersion: "recovery-command.v2" }
    expect(commandError(input).path).toEqual(["schemaVersion"])
  })
})

describe("recovery evidence negative shapes and free-text rule", () => {
  test("missing field -> typed error with exact path", () => {
    const input = makeEvidence() as unknown as { payloadHash?: unknown }
    delete input.payloadHash
    expect(evidenceError(input).path).toEqual(["payloadHash"])
  })

  test("unknown enum value (terminal state) -> typed error with exact path", () => {
    const input = { ...(makeEvidence() as unknown as Record<string, unknown>), terminalState: "skipped" }
    expect(evidenceError(input).path).toEqual(["terminalState"])
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...(makeEvidence() as unknown as Record<string, unknown>), schemaVersion: "recovery-evidence.v2" }
    expect(evidenceError(input).path).toEqual(["schemaVersion"])
  })

  test("free text as evidence is rejected structurally (excess key)", () => {
    const input = { ...(makeEvidence() as unknown as Record<string, unknown>), note: "the provider told us it settled" }
    expect(evidenceError(input).path).toEqual(["note"])
  })

  test("assertEvidenceTyped throws a typed violation for a free-text key", () => {
    const evidence = makeEvidence() as unknown as Record<string, unknown>
    ;(evidence as Record<string, unknown>)["description"] = "free text"
    expect(() => assertEvidenceTyped(evidence as unknown as RecoveryEvidence)).toThrow(FreeTextEvidenceError)
  })

  test("assertEvidenceTyped accepts typed, hash-addressed evidence", () => {
    expect(() => assertEvidenceTyped(makeEvidence())).not.toThrow()
  })
})

describe("recovery validate (non-throwing)", () => {
  test("valid command -> ok true; invalid -> ok false with typed error", () => {
    const ok = validateRecoveryCommand(makeCommand("recover"))
    expect(ok.ok).toBe(true)
    const bad = validateRecoveryCommand({ ...(makeCommand("recover") as unknown as Record<string, unknown>), commandKind: "bogus" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toBeInstanceOf(RecoveryDecodeError)
  })
})
