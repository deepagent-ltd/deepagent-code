import { describe, expect, test } from "bun:test"
import type { ResolvableProviderRecovery } from "./session-provider-recovery-dock"
import {
  providerRecoveryCommandID,
  providerRecoveryFingerprint,
  providerRecoveryPending,
  providerRecoveryResolveInput,
  isResolvableProviderRecovery,
  resolveProviderRecovery,
} from "./session-provider-recovery-dock"

const recovery = (overrides: Partial<ResolvableProviderRecovery> = {}): ResolvableProviderRecovery => ({
  receiptID: "receipt-1",
  sessionID: "session-1",
  assistantMessageID: "message-1",
  providerID: "provider",
  modelID: "model",
  providerState: "indeterminate_after_crash",
  promptEpoch: 3,
  promptWindowID: "window-1",
  historyHash: "history-1",
  requestHash: "request-1",
  sessionMutationEpoch: 7,
  continuationRecoverySupported: true,
  workspaceRecoverySupported: true,
  sourceWorldStateBaselineStatus: "available",
  worldStateBaselineHash: "wsb1-baseline",
  resolutionSupported: true,
  unsupportedReasons: [],
  ...overrides,
})

describe("provider recovery command", () => {
  test("keeps the command id stable for an exact retry", async () => {
    const item = recovery()
    expect(await providerRecoveryCommandID(item)).toBe(await providerRecoveryCommandID({ ...item }))
    expect((await providerRecoveryCommandID(item)).length).toBe(82)
  })

  test("changes the command id when any recovery authority field changes", async () => {
    const item = recovery()
    expect(providerRecoveryFingerprint(item)).not.toBe(
      providerRecoveryFingerprint(recovery({ sessionMutationEpoch: item.sessionMutationEpoch + 1 })),
    )
    expect(await providerRecoveryCommandID(item)).not.toBe(
      await providerRecoveryCommandID(recovery({ sessionMutationEpoch: item.sessionMutationEpoch + 1 })),
    )
    expect(await providerRecoveryCommandID(item)).not.toBe(
      await providerRecoveryCommandID(recovery({ historyHash: "history-2" })),
    )
  })

  test("bounds the command id for a maximum-length receipt", async () => {
    expect((await providerRecoveryCommandID(recovery({ receiptID: "r".repeat(200) }))).length).toBe(82)
  })

  test("builds an abandon-only request with the complete expected authority", async () => {
    expect(await providerRecoveryResolveInput(recovery())).toEqual({
      commandID: await providerRecoveryCommandID(recovery()),
      receiptID: "receipt-1",
      decision: "abandoned",
      expected: {
        providerState: "indeterminate_after_crash",
        promptEpoch: 3,
        sessionMutationEpoch: 7,
        requestHash: "request-1",
        historyHash: "history-1",
        worldStateBaselineHash: "wsb1-baseline",
      },
    })
  })
})

describe("provider recovery admission", () => {
  test("allows command construction only for a complete resolvable descriptor", () => {
    expect(isResolvableProviderRecovery(recovery())).toBe(true)
    expect(
      isResolvableProviderRecovery({
        receiptID: "orphan",
        sessionID: "session-1",
        providerID: "provider",
        modelID: "model",
        providerState: "indeterminate_after_crash",
        sessionMutationEpoch: 7,
        resolutionSupported: false,
        unsupportedReasons: ["legacy_receipt_authority_incomplete"],
        continuationRecoverySupported: true,
        workspaceRecoverySupported: true,
        sourceWorldStateBaselineStatus: "missing",
      }),
    ).toBe(false)
  })

  test("fails closed while loading or after a list failure", () => {
    expect(providerRecoveryPending({ loading: true, error: undefined, recoveries: undefined })).toBe(true)
    expect(providerRecoveryPending({ loading: false, error: new Error("offline"), recoveries: undefined })).toBe(true)
    expect(
      providerRecoveryPending({ loading: false, error: undefined, recoveries: [], settlementFailed: true }),
    ).toBe(true)
  })

  test("blocks for a descriptor and unblocks only for a confirmed empty list", () => {
    expect(providerRecoveryPending({ loading: false, error: undefined, recoveries: [recovery()] })).toBe(true)
    expect(providerRecoveryPending({ loading: false, error: undefined, recoveries: [] })).toBe(false)
  })
})

describe("provider recovery settlement", () => {
  test("never dispatches a maintenance-only recovery descriptor", async () => {
    let dispatched = false
    const result = await resolveProviderRecovery({
      sessionID: "session-1",
      recovery: {
        receiptID: "orphan",
        sessionID: "session-1",
        providerID: "provider",
        modelID: "model",
        providerState: "indeterminate_after_crash",
        sessionMutationEpoch: 7,
        resolutionSupported: false,
        unsupportedReasons: ["legacy_receipt_authority_incomplete"],
        continuationRecoverySupported: true,
        workspaceRecoverySupported: true,
        sourceWorldStateBaselineStatus: "missing",
      },
      resolve: async () => {
        dispatched = true
        return {}
      },
      refresh: async () => "retained",
    })

    expect(result).toEqual({ status: "unsupported" })
    expect(dispatched).toBe(false)
  })

  test("uses the exact idempotent request and refreshes after success", async () => {
    const requests: unknown[] = []
    let refreshes = 0
    const result = await resolveProviderRecovery({
      sessionID: "session-1",
      recovery: recovery(),
      resolve: async (request) => {
        requests.push(request)
        return {}
      },
      refresh: async () => {
        refreshes += 1
        return "cleared"
      },
    })

    expect(result).toEqual({ status: "resolved" })
    expect(requests).toEqual([{ sessionID: "session-1", ...(await providerRecoveryResolveInput(recovery())) }])
    expect(refreshes).toBe(1)
  })

  test("classifies a conflict and refreshes authority before returning", async () => {
    let refreshes = 0
    const error = { name: "ConflictError", data: { message: "stale recovery state" } }
    const result = await resolveProviderRecovery({
      sessionID: "session-1",
      recovery: recovery(),
      resolve: async () => ({ error, response: { status: 409 } }),
      refresh: async () => {
        refreshes += 1
        return "retained"
      },
    })

    expect(result).toEqual({ status: "conflict", error, refreshed: "retained" })
    expect(refreshes).toBe(1)
  })

  test("refreshes authority after a network-unknown result", async () => {
    let refreshes = 0
    const error = new Error("connection closed")
    const result = await resolveProviderRecovery({
      sessionID: "session-1",
      recovery: recovery(),
      resolve: async () => {
        throw error
      },
      refresh: async () => {
        refreshes += 1
        return "failed"
      },
    })

    expect(result).toEqual({ status: "failed", error, refreshed: "failed" })
    expect(refreshes).toBe(1)
  })

  test("reports a completed command whose canonical refresh failed", async () => {
    expect(
      await resolveProviderRecovery({
        sessionID: "session-1",
        recovery: recovery(),
        resolve: async () => ({}),
        refresh: async () => "failed",
      }),
    ).toEqual({ status: "refresh_failed" })
  })

  test("settles a network-unknown command when canonical state no longer contains the receipt", async () => {
    expect(
      await resolveProviderRecovery({
        sessionID: "session-1",
        recovery: recovery(),
        resolve: async () => {
          throw new Error("connection closed after dispatch")
        },
        refresh: async () => "cleared",
      }),
    ).toEqual({ status: "resolved" })
  })
})
