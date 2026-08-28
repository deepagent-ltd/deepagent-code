import { describe, expect, test } from "bun:test"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { ContextActivationReceipt } from "../../src/context-federation/activation-receipt"

describe("ContextActivationReceipt", () => {
  test("binds one eligible decision to the projection and tool capabilities actually offered", () => {
    const now = Date.now()
    const readiness = {
      ...ContextFederationRollout.READINESS_READY_STUB,
      revision: "readiness-active",
      observedAt: now - 150,
      expiresAt: now + 850,
    }
    const decision = ContextFederationRollout.activate(eligible(), readiness)
    const activation = ContextActivationReceipt.make({
      readiness,
      decision,
      recordedAt: now,
      projectionEnabled: true,
      toolsEnabled: true,
      selection: { selectionId: "selection-active", projectionHash: "projection-active" },
    })

    expect(activation).toMatchObject({
      readinessAgeMs: 150,
      readinessExpiresInMs: 850,
      outcome: "active",
      enabledCapabilities: ["context_projection_v2", "context_query_tools_v2"],
      fallbackReasons: [],
      selection: { selectionId: "selection-active", projectionHash: "projection-active" },
    })
    expect(activation.decision).toBe(decision)
  })

  test("produces the same fingerprint for an exact retry and changes it with authority revision", () => {
    const now = Date.now()
    const readiness = {
      ...ContextFederationRollout.READINESS_READY_STUB,
      revision: "readiness-exact-retry",
      observedAt: now - 150,
      expiresAt: now + 850,
    }
    const decision = ContextFederationRollout.activate(eligible(), readiness)
    const activation = ContextActivationReceipt.make({
      readiness,
      decision,
      recordedAt: now,
      projectionEnabled: true,
      toolsEnabled: true,
      selection: { selectionId: "selection-retry", projectionHash: "projection-retry" },
    })
    const receipt = { eligibility: eligible(), readiness, activation }

    expect(ContextActivationReceipt.fingerprint(receipt)).toBe(ContextActivationReceipt.fingerprint(receipt))
    expect(
      ContextActivationReceipt.fingerprint({
        ...receipt,
        readiness: { ...readiness, revision: "readiness-after-authority-change" },
      }),
    ).not.toBe(ContextActivationReceipt.fingerprint(receipt))
  })

  test("rejects forged fingerprints, decisions, capabilities, and selection bindings", () => {
    const recordedAt = 10_000
    const readiness = {
      ...ContextFederationRollout.READINESS_READY_STUB,
      revision: "readiness-integrity",
      observedAt: recordedAt - 100,
      expiresAt: recordedAt + 900,
    }
    const eligibility = eligible()
    const selection = { selectionId: "selection-integrity", projectionHash: "projection-integrity" }
    const activation = ContextActivationReceipt.make({
      readiness,
      decision: ContextFederationRollout.activate(eligibility, readiness, recordedAt),
      recordedAt,
      projectionEnabled: true,
      toolsEnabled: true,
      selection,
    })
    const activationFingerprint = ContextActivationReceipt.fingerprint({ eligibility, readiness, activation })

    expect(
      ContextActivationReceipt.integrityError({
        eligibility,
        readiness,
        activation,
        activationFingerprint,
        selection,
      }),
    ).toBeUndefined()
    expect(
      ContextActivationReceipt.integrityError({
        eligibility,
        readiness,
        activation,
        activationFingerprint: "f".repeat(64),
        selection,
      }),
    ).toBe("context activation fingerprint mismatch")

    for (const [forgedActivation, expectedError] of [
      [
        { ...activation, readinessExpiresInMs: 901 },
        "context activation does not match its eligibility, readiness, capabilities, or selection",
      ],
      [
        { ...activation, enabledCapabilities: ["context_projection_v2"] as const },
        "enabled context query tools were omitted without a durable fallback reason",
      ],
      [
        { ...activation, selection: { ...selection, selectionId: "selection-forged" } },
        "context activation does not match its eligibility, readiness, capabilities, or selection",
      ],
      [
        {
          ...activation,
          decision: {
            ...activation.decision,
            enabled: { ...activation.decision.enabled, contextProjectionV2: false },
          },
        },
        "context activation does not match its eligibility, readiness, capabilities, or selection",
      ],
    ] as const) {
      expect(
        ContextActivationReceipt.integrityError({
          eligibility,
          readiness,
          activation: forgedActivation,
          activationFingerprint: ContextActivationReceipt.fingerprint({
            eligibility,
            readiness,
            activation: forgedActivation,
          }),
          selection,
        }),
      ).toBe(expectedError)
    }
  })

  test.each([
    ["building", "index_building"],
    ["degraded", "index_degraded"],
  ] as const)("records %s readiness while failing model-facing activation closed", (state, reason) => {
    const now = Date.now()
    const readiness = {
      ...ContextFederationRollout.READINESS_READY_STUB,
      revision: `readiness-${state}`,
      state,
      indexAvailable: state === "degraded",
      reasons: [reason],
      observedAt: now - 150,
      expiresAt: now + 850,
    }
    const decision = ContextFederationRollout.activate(eligible(), readiness)
    const activation = ContextActivationReceipt.make({
      readiness,
      decision,
      recordedAt: now,
      projectionEnabled: false,
      toolsEnabled: false,
    })

    expect(decision.enabled.contextProjectionV2).toBe(false)
    expect(decision.enabled.contextQueryToolsV2).toBe(false)
    expect(activation.outcome).toBe("fallback")
    expect(activation.enabledCapabilities).toEqual([])
    expect(activation.fallbackReasons).toContain("data_readiness_blocked")
  })

  test("records an expired readiness age and the exact block reason", () => {
    const now = Date.now()
    const readiness = {
      ...ContextFederationRollout.READINESS_READY_STUB,
      revision: "readiness-expired",
      observedAt: now - 150,
      expiresAt: now - 50,
    }
    const decision = ContextFederationRollout.activate(eligible(), readiness)
    const activation = ContextActivationReceipt.make({
      readiness,
      decision,
      recordedAt: now,
      projectionEnabled: false,
      toolsEnabled: false,
    })

    expect(activation).toMatchObject({
      readinessAgeMs: 150,
      readinessExpiresInMs: -50,
      outcome: "fallback",
      enabledCapabilities: [],
    })
    expect(activation.fallbackReasons).toContain("data_readiness_expired")
  })

  test.each([true, false] as const)(
    "closes model-facing dispatch at the exact expiry boundary (projection=%s)",
    (projectionEnabled) => {
      const readiness = {
        ...ContextFederationRollout.READINESS_READY_STUB,
        revision: "readiness-dispatch-expiry",
        expiresAt: Number.MAX_SAFE_INTEGER,
      }
      const decision = ContextFederationRollout.activate(eligible(), readiness)
      const gate = ContextActivationReceipt.providerDispatchGate({
        readiness,
        decision,
        projectionEnabled,
        toolsEnabled: !projectionEnabled,
        now: Number.MAX_SAFE_INTEGER,
      })

      expect(decision.enabled.contextProjectionV2).toBe(true)
      expect(decision.enabled.contextQueryToolsV2).toBe(true)
      expect(gate).toEqual({ allowed: false, reason: "readiness_expired" })
      expect(ContextActivationReceipt.closeModelFacingOwners(decision).enabled).toMatchObject({
        contextProjectionV2: false,
        contextQueryToolsV2: false,
        coreV2ExecutionOwner: false,
      })
      expect(
        ContextActivationReceipt.make({
          readiness,
          decision,
          recordedAt: Number.MAX_SAFE_INTEGER,
          projectionEnabled,
          toolsEnabled: !projectionEnabled,
          selection: { selectionId: "selection-expired", projectionHash: "projection-expired" },
        }),
      ).toMatchObject({
        outcome: "fallback",
        enabledCapabilities: [],
        fallbackReasons: ["data_readiness_expired"],
        decision: {
          enabled: {
            contextProjectionV2: false,
            contextQueryToolsV2: false,
            coreV2ExecutionOwner: false,
          },
        },
      })
    },
  )

  test("closes the core v2 execution owner at expiry without projection or query tools", () => {
    const readiness = {
      ...ContextFederationRollout.READINESS_READY_STUB,
      revision: "readiness-dispatch-expiry-core-owner",
      expiresAt: Number.MAX_SAFE_INTEGER,
    }
    const decision = ContextFederationRollout.activate(
      ContextFederationRollout.resolveProject(
        ContextFederationRollout.resolve(
          {
            contextFederationShadow: true,
            locationIndexesV2Shadow: true,
            contextProjectionV2: true,
            contextQueryToolsV2: false,
            coreV2ExecutionOwner: true,
          },
          { coreV2ParityVerified: true },
        ),
        "project_scope_activation_receipt_core_owner",
        { stage: "all", percentage: 100, internalProjectScopeKeys: [], killSwitch: false },
      ),
      readiness,
    )

    expect(
      ContextActivationReceipt.providerDispatchGate({
        readiness,
        decision,
        projectionEnabled: false,
        toolsEnabled: false,
        now: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ allowed: false, reason: "readiness_expired" })
  })
})

function eligible() {
  return ContextFederationRollout.resolveProject(
    ContextFederationRollout.resolve(
      {
        contextFederationShadow: true,
        locationIndexesV2Shadow: true,
        contextProjectionV2: true,
        contextQueryToolsV2: true,
        coreV2ExecutionOwner: false,
      },
      { coreV2ParityVerified: false },
    ),
    "project_scope_activation_receipt",
    { stage: "all", percentage: 100, internalProjectScopeKeys: [], killSwitch: false },
  )
}
