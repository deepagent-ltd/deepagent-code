import { describe, expect, test } from "bun:test"
import type { CoordinationDescriptor, ExactDescriptor, ForkDescriptor, RecoveryDescriptor, RepairableDescriptor, ResolvedDescriptor } from "@deepagent-code/core/contract/recovery-command"
import {
  blockedReason,
  descriptorDeadEnd,
  descriptorId,
  exitFor,
  hasExecutableExit,
  initialDockState,
  pendingItems,
  queuedPosition,
  queueActive,
  reduceDock,
  requiresVerification,
  type DockState,
} from "./recovery-dock-state"

const base = {
  schemaVersion: "recovery-descriptor.v1" as const,
  requestHash: "req-1",
  provenance: { origin: "recorded" as const, sourceRefs: [] as string[] },
  baseline: { baselineHash: "b1", sourceSnapshotRef: "snap-1", verified: true },
  terminalBridge: { bridgeId: "b", bridgeType: "type", terminalRef: "t" },
  casTokens: { expectedState: "s", expectedVersion: 0, ownerToken: "ot" },
}

const exact = (overrides: Partial<ExactDescriptor> = {}): RecoveryDescriptor =>
  ({
    ...base,
    descriptorKind: "resolvable_exact",
    exact: { attemptHash: "a", selectionHash: "s", historyHash: "h", baselineHash: "b", allVerified: true },
    ...overrides,
  }) as RecoveryDescriptor

const repairable = (overrides: Partial<RepairableDescriptor> = {}): RecoveryDescriptor =>
  ({
    ...base,
    descriptorKind: "repairable_exact",
    repairable: { baselineState: "corrupt" as const, sourceSnapshotRef: "snap-1", canReconstruct: true },
    ...overrides,
  }) as RecoveryDescriptor

const fork = (overrides: Partial<ForkDescriptor> = {}): RecoveryDescriptor =>
  ({
    ...base,
    descriptorKind: "fork_only",
    fork: { safeBoundaryRef: "sb", safeBoundaryHash: "sbh", reasonCode: "network_unknown" as const, originalSessionReadOnly: false },
    ...overrides,
  }) as RecoveryDescriptor

const coordination = (overrides: Partial<CoordinationDescriptor> = {}): RecoveryDescriptor =>
  ({
    ...base,
    descriptorKind: "coordination_required",
    coordination: { reason: "network_unknown" as const, requiredActor: "admin" as const, evidenceExportRef: "export-1" },
    ...overrides,
  }) as RecoveryDescriptor

const resolved = (overrides: Partial<ResolvedDescriptor> = {}): RecoveryDescriptor =>
  ({
    ...base,
    descriptorKind: "resolved",
    resolved: { resolutionRef: "r", bridgeRef: "b", terminal: "settled" as const },
    ...overrides,
  }) as RecoveryDescriptor

describe("no-dead-end matrix (every descriptor class has an exit or a typed reason)", () => {
  test("resolvable_exact -> abandon + recover", () => {
    const outcome = descriptorDeadEnd(exact())
    expect(outcome.kind).toBe("exits")
    if (outcome.kind === "exits") {
      expect(outcome.exits.map((exit) => exit.kind)).toEqual(["abandon", "recover"])
    }
  })

  test("repairable_exact -> repair + abandon", () => {
    const outcome = descriptorDeadEnd(repairable())
    expect(outcome.kind).toBe("exits")
    if (outcome.kind === "exits") {
      expect(outcome.exits.map((exit) => exit.kind)).toEqual(["repair", "abandon"])
    }
  })

  test("fork_only -> fork (never a dead button)", () => {
    const outcome = descriptorDeadEnd(fork())
    expect(outcome.kind).toBe("exits")
    if (outcome.kind === "exits") {
      expect(outcome.exits.map((exit) => exit.kind)).toEqual(["fork"])
      expect(outcome.exits[0]!.permission).toBe("user")
    }
  })

  test("coordination_required -> typed blocker with the coordination path (no dead button)", () => {
    const outcome = descriptorDeadEnd(coordination())
    expect(outcome.kind).toBe("blocked")
    if (outcome.kind === "blocked") {
      expect(outcome.reason).toBe("network_unknown")
      expect(outcome.coordination.actor).toBe("admin")
      expect(outcome.coordination.evidenceExportRef).toBe("export-1")
    }
  })

  test("resolved -> refresh (terminal is still never a silent dead button)", () => {
    const outcome = descriptorDeadEnd(resolved())
    expect(outcome.kind).toBe("exits")
    if (outcome.kind === "exits") {
      expect(outcome.exits.map((exit) => exit.kind)).toEqual(["refresh"])
    }
  })

  test("every descriptor class yields a non-empty no-dead-end", () => {
    for (const descriptor of [exact(), repairable(), fork(), coordination(), resolved()]) {
      const outcome = descriptorDeadEnd(descriptor)
      if (outcome.kind === "exits") expect(outcome.exits.length).toBeGreaterThan(0)
      else expect(outcome.coordination.actor).toBeTruthy()
    }
  })
})

describe("network-unknown -> query first (核对中)", () => {
  test("fork with a network_unknown reason requires verification", () => {
    expect(requiresVerification(fork())).toBe(true)
    expect(requiresVerification(fork({ fork: { safeBoundaryRef: "sb", safeBoundaryHash: "sbh", reasonCode: "safe_boundary_none", originalSessionReadOnly: false } }))).toBe(false)
  })

  test("coordination with provider_lookup requires verification; admin does not", () => {
    expect(requiresVerification(coordination({ coordination: { reason: "placement_unresolved", requiredActor: "provider_lookup" } }))).toBe(true)
    expect(requiresVerification(coordination({ coordination: { reason: "placement_unresolved", requiredActor: "admin" } }))).toBe(false)
  })

  test("a loaded descriptor enters 核对中 (verifying) and only then reaches a decision", () => {
    let state = reduceDock(initialDockState, { type: "descriptorsLoaded", descriptors: [fork()] })
    expect(state.items[0]!.phase.status).toBe("verifying")
    state = reduceDock(state, { type: "checkStarted", id: state.items[0]!.id })
    expect(state.items[0]!.phase.status).toBe("verifying")
    // Query returns a decision: the descriptor's exits become executable.
    state = reduceDock(state, { type: "checkResolved", id: state.items[0]!.id, exits: [exitFor("fork")] })
    expect(state.items[0]!.phase.status).toBe("decided")
    expect(hasExecutableExit(state.items[0]!)).toBe(true)
  })

  test("a query that confirms a blocker surfaces a typed reason, never a dead button", () => {
    let state = reduceDock(initialDockState, { type: "descriptorsLoaded", descriptors: [coordination()] })
    state = reduceDock(state, { type: "checkBlocked", id: state.items[0]!.id, reason: "permission_incomplete", coordination: { actor: "admin", evidenceExportRef: "export-9" } })
    expect(state.items[0]!.phase.status).toBe("blocked")
    const reason = blockedReason(state.items[0]!)
    expect(reason?.reason).toBe("permission_incomplete")
    expect(reason?.coordination.actor).toBe("admin")
    expect(hasExecutableExit(state.items[0]!)).toBe(false)
  })
})

describe("loads ALL pending descriptors (not just the first)", () => {
  test("a loaded list materializes every descriptor as its own item", () => {
    const state = reduceDock(initialDockState, {
      type: "descriptorsLoaded",
      descriptors: [exact(), repairable(), resolveForList(), coordination()],
    })
    expect(state.items).toHaveLength(4)
    expect(state.loadStatus).toBe("loaded")
    // All items carry distinct ids.
    expect(new Set(state.items.map((item) => item.id)).size).toBe(4)
    // The pending set covers every not-yet-settled item.
    expect(pendingItems(state)).toHaveLength(4)
  })

  test("a descriptor is identified stably by request hash + class", () => {
    expect(descriptorId(exact())).toBe(descriptorId(exact({ requestHash: "req-1" })))
    expect(descriptorId(exact())).not.toBe(descriptorId(repairable()))
  })
})

describe("per-session serial queue (one in-flight at a time)", () => {
  const loaded = (): DockState =>
    reduceDock(initialDockState, { type: "descriptorsLoaded", descriptors: [exact(), repairable()] })

  test("requesting two exits starts the first and queues the second", () => {
    let state = loaded()
    state = reduceDock(state, { type: "requestExit", id: state.items[0]!.id, exit: exitFor("abandon") })
    expect(state.inFlight?.id).toBe(state.items[0]!.id)
    expect(queueActive(state)).toBe(true)

    state = reduceDock(state, { type: "requestExit", id: state.items[1]!.id, exit: exitFor("repair") })
    expect(state.inFlight?.id).toBe(state.items[0]!.id) // still the first
    expect(state.queue).toHaveLength(1)
    expect(queuedPosition(state, state.items[1]!.id)).toBe(0)
  })

  test("resolving the in-flight exit advances the queue (serial, exactly one at a time)", () => {
    let state = loaded()
    state = reduceDock(state, { type: "requestExit", id: state.items[0]!.id, exit: exitFor("abandon") })
    state = reduceDock(state, { type: "requestExit", id: state.items[1]!.id, exit: exitFor("repair") })

    state = reduceDock(state, { type: "exitResolved", id: state.items[0]!.id, ok: true })
    expect(state.inFlight?.id).toBe(state.items[1]!.id)
    expect(state.queue).toHaveLength(0)
    expect(state.items[0]!.phase.status).toBe("result")
    expect((state.items[0]!.phase as { ok: boolean }).ok).toBe(true)

    state = reduceDock(state, { type: "exitResolved", id: state.items[1]!.id, ok: false })
    expect(state.inFlight).toBeNull()
    expect(queueActive(state)).toBe(false)
    expect(state.items[1]!.phase.status).toBe("result")
    expect((state.items[1]!.phase as { ok: boolean }).ok).toBe(false)
  })

  test("a duplicate request for a queued item is not enqueued twice", () => {
    let state = loaded()
    state = reduceDock(state, { type: "requestExit", id: state.items[0]!.id, exit: exitFor("abandon") })
    state = reduceDock(state, { type: "requestExit", id: state.items[1]!.id, exit: exitFor("repair") })
    state = reduceDock(state, { type: "requestExit", id: state.items[1]!.id, exit: exitFor("repair") })
    expect(state.queue).toHaveLength(1)
  })
})

// A resolved descriptor for the "loads all" test (keeps the fixture list varied).
function resolveForList(): RecoveryDescriptor {
  return resolved()
}
