import { describe, expect, test } from "bun:test"
import { ContextFederationContract } from "../../src/context-federation/contract"
import { ContextFederationRollout } from "../../src/context-federation/rollout"

describe("context federation frozen contract", () => {
  test("publishes the reviewed wire versions and two model tool IDs", () => {
    expect(ContextFederationContract.Version).toEqual({
      contextRefToken: 1,
      cursor: 1,
      artifactRefToken: 1,
      graphStatus: 1,
      projection: 1,
      ranking: 1,
      codeIntel: 2,
      contextQuery: 1,
    })
    expect(ContextFederationContract.Tool.codeIntel.id).toBe("code_intel")
    expect(ContextFederationContract.Tool.contextQuery.id).toBe("context_query")
  })

  test("code_intel v2 excludes legacy write intents and arbitrary workspace selectors", () => {
    const decode = ContextFederationContract.decodeCodeIntelInput
    expect(
      decode({
        intent: "search",
        query: "durable prompt admission",
        consistency: "fresh",
        depth: 2,
        limit: 20,
      }),
    ).toEqual({
      intent: "search",
      query: "durable prompt admission",
      consistency: "fresh",
      depth: 2,
      limit: 20,
    })
    expect(() => decode({ intent: "related_docs" })).toThrow()
    expect(() => decode({ intent: "rename_preview" })).toThrow()
    expect(() => decode({ intent: "search", workspacePath: "/tmp/other" })).toThrow()
    expect(() => decode({ intent: "search", depth: 4 })).toThrow()
  })

  test("context_query accepts cross-graph tracing without accepting caller-owned scope", () => {
    const decode = ContextFederationContract.decodeContextQueryInput
    expect(
      decode({
        intent: "trace_evidence",
        ref: "opaque-ref",
        sources: ["code", "documents"],
        consistency: "stale_ok",
      }),
    ).toEqual({
      intent: "trace_evidence",
      ref: "opaque-ref",
      sources: ["code", "documents"],
      consistency: "stale_ok",
    })
    expect(() => decode({ intent: "trace_evidence", sessionId: "other" })).toThrow()
    expect(() => decode({ intent: "trace_evidence", projectId: "other" })).toThrow()
    expect(() => decode({ intent: "trace_evidence", sources: ["world_state"] })).toThrow()
  })
})

describe("context federation rollout dependencies", () => {
  const allRequested = {
    contextFederationShadow: true,
    locationIndexesV2Shadow: true,
    contextProjectionV2: true,
    contextQueryToolsV2: true,
    coreV2ExecutionOwner: true,
  } as const

  test("fails closed when projection prerequisites and runner parity are missing", () => {
    const decision = ContextFederationRollout.resolve(
      {
        ...allRequested,
        contextFederationShadow: false,
        locationIndexesV2Shadow: false,
      },
      { coreV2ParityVerified: false },
    )

    expect(decision.enabled).toEqual({
      contextFederationShadow: false,
      locationIndexesV2Shadow: false,
      contextProjectionV2: false,
      contextQueryToolsV2: false,
      coreV2ExecutionOwner: false,
    })
    expect(decision.blocked.contextProjectionV2).toEqual([
      "context_federation_shadow_required",
      "location_indexes_v2_shadow_required",
    ])
    expect(decision.blocked.contextQueryToolsV2).toEqual(["context_projection_v2_required"])
    expect(decision.blocked.coreV2ExecutionOwner).toEqual(["context_projection_v2_required", "core_v2_parity_required"])
  })

  test("keeps execution ownership off until independent parity evidence exists", () => {
    const beforeParity = ContextFederationRollout.resolve(allRequested, { coreV2ParityVerified: false })
    expect(beforeParity.enabled.contextProjectionV2).toBe(true)
    expect(beforeParity.enabled.contextQueryToolsV2).toBe(true)
    expect(beforeParity.enabled.coreV2ExecutionOwner).toBe(false)

    const afterParity = ContextFederationRollout.resolve(allRequested, { coreV2ParityVerified: true })
    expect(afterParity.enabled).toEqual(allRequested)
    expect(afterParity.blocked).toEqual({})
  })

  test("uses a stable Project cohort and advances internal, percentage, then all", () => {
    const base = ContextFederationRollout.resolve(allRequested, { coreV2ParityVerified: true })
    const projectScopeKey = "project_scope_release_candidate"
    const bucket = ContextFederationRollout.projectBucket(projectScopeKey)
    expect(ContextFederationRollout.projectBucket(projectScopeKey)).toBe(bucket)

    const shadow = ContextFederationRollout.resolveProject(base, projectScopeKey, {
      stage: "shadow",
      percentage: 100,
      internalProjectScopeKeys: [projectScopeKey],
      killSwitch: false,
    })
    expect(shadow.project.selected).toBe(false)
    expect(shadow.enabled.contextFederationShadow).toBe(true)
    expect(shadow.enabled.contextProjectionV2).toBe(false)

    const internal = ContextFederationRollout.resolveProject(base, projectScopeKey, {
      stage: "internal",
      percentage: 0,
      internalProjectScopeKeys: [projectScopeKey],
      killSwitch: false,
    })
    expect(internal.project.selected).toBe(true)
    expect(internal.enabled).toEqual(allRequested)

    const excluded = ContextFederationRollout.resolveProject(base, projectScopeKey, {
      stage: "percentage",
      percentage: bucket,
      internalProjectScopeKeys: [],
      killSwitch: false,
    })
    expect(excluded.project.selected).toBe(false)
    expect(excluded.enabled.contextProjectionV2).toBe(false)
    expect(excluded.blocked.contextProjectionV2).toContain("project_rollout_not_selected")

    const included = ContextFederationRollout.resolveProject(base, projectScopeKey, {
      stage: "percentage",
      percentage: bucket + 1,
      internalProjectScopeKeys: [],
      killSwitch: false,
    })
    expect(included.project.selected).toBe(true)
    expect(included.enabled.contextQueryToolsV2).toBe(true)

    const all = ContextFederationRollout.resolveProject(base, projectScopeKey, {
      stage: "all",
      percentage: 0,
      internalProjectScopeKeys: [],
      killSwitch: false,
    })
    expect(all.project.selected).toBe(true)
  })

  test("kill switch removes model owners while retaining shadow and index evidence", () => {
    const decision = ContextFederationRollout.resolveProject(
      ContextFederationRollout.resolve(allRequested, { coreV2ParityVerified: true }),
      "project_scope_kill_switch",
      { stage: "all", percentage: 100, internalProjectScopeKeys: [], killSwitch: true },
    )

    expect(decision.enabled).toEqual({
      contextFederationShadow: true,
      locationIndexesV2Shadow: true,
      contextProjectionV2: false,
      contextQueryToolsV2: false,
      coreV2ExecutionOwner: false,
    })
    expect(decision.blocked.contextProjectionV2).toContain("context_federation_kill_switch")
  })

  test("requires derived readiness after Project eligibility", () => {
    const eligible = ContextFederationRollout.resolveProject(
      ContextFederationRollout.resolve(allRequested, { coreV2ParityVerified: true }),
      "project_scope_ready",
      { stage: "all", percentage: 100, internalProjectScopeKeys: [], killSwitch: false },
    )
    const now = Date.now()
    const missingIdentity = ContextFederationRollout.activate(eligible, {
      state: "uninitialized",
      identityBound: false,
      indexAvailable: false,
      storageHealthy: true,
      observedAt: now,
      expiresAt: now + 1_000,
    })
    expect(missingIdentity.enabled.contextProjectionV2).toBe(false)
    expect(missingIdentity.blocked.contextProjectionV2).toContain("data_readiness_identity_missing")

    const expired = ContextFederationRollout.activate(eligible, {
      ...ContextFederationRollout.READINESS_READY_STUB,
      observedAt: now - 2_000,
      expiresAt: now - 1_000,
    })
    expect(expired.enabled.contextQueryToolsV2).toBe(false)
    expect(expired.blocked.contextQueryToolsV2).toContain("data_readiness_expired")

    const degraded = ContextFederationRollout.activate(eligible, {
      state: "degraded",
      identityBound: true,
      indexAvailable: false,
      storageHealthy: true,
      observedAt: now,
      expiresAt: now + 1_000,
    })
    expect(degraded.enabled.contextProjectionV2).toBe(false)
    expect(degraded.enabled.contextQueryToolsV2).toBe(false)
    expect(degraded.enabled.contextFederationShadow).toBe(true)

    expect(
      ContextFederationRollout.activate(eligible, {
        ...ContextFederationRollout.READINESS_READY_STUB,
        observedAt: now,
      }).enabled,
    ).toEqual(allRequested)
  })

  test("rollback rehearsal fails on durable loss or indeterminate requeue", () => {
    const before = {
      admissionIds: ["input_1"],
      messageIds: ["message_1"],
      durableAssetIds: ["selection_1", "artifact_1", "resolution_1"],
      attempts: [{ attemptId: "attempt_1", state: "indeterminate_after_crash" }],
    }
    const rolledBack = {
      ...allRequested,
      contextProjectionV2: false,
      contextQueryToolsV2: false,
      coreV2ExecutionOwner: false,
    }

    expect(ContextFederationRollout.rehearseRollback({ enabled: rolledBack, before, after: before })).toEqual({
      passed: true,
      violations: [],
    })

    const unsafe = ContextFederationRollout.rehearseRollback({
      enabled: rolledBack,
      before,
      after: {
        admissionIds: [],
        messageIds: ["message_1"],
        durableAssetIds: ["selection_1"],
        attempts: [{ attemptId: "attempt_1", state: "prepared" }],
      },
    })
    expect(unsafe.passed).toBe(false)
    expect(unsafe.violations).toContain("admission_lost:input_1")
    expect(unsafe.violations).toContain("durable_asset_lost:artifact_1")
    expect(unsafe.violations).toContain("indeterminate_attempt_changed:attempt_1")
  })
})
