import { describe, expect, test } from "bun:test"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { Hash } from "../src/util/hash"

const candidate = (): WorkAuthoritySchema.Binding => ({
  schemaVersion: "work-execution.v1",
  workID: "work-one",
  rootWorkID: "work-one",
  attemptKey: "attempt-one",
  source: {
    kind: "server_operator",
    authorityID: "operator-one",
    authorityRevision: 1,
    sourceID: "event-one",
    requestID: "request-one",
    requestHash: "a".repeat(64),
  },
  envelopeHash: "b".repeat(64),
  scope: {
    actorID: "actor-one",
    workspaceID: "workspace-one",
    securityNamespaceID: "namespace-one",
    projectScopeKey: "project-one",
  },
  location: { directory: "/tmp/work-authority-project" },
  agentID: "build",
  sessionID: "ses_work_one",
  inputID: "msg_work_one",
  profile: {
    id: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.id,
    version: 1,
    hash: WorkAuthorityPolicy.TEXT_ONLY_PROFILE_HASH,
  },
  auditedText: { hash: Hash.sha256("review this text"), utf8Bytes: 16, snapshotRef: "audited://one" },
  contextPolicy: "static_instructions_and_audited_text",
  toolPolicy: "deny_all",
  childPolicy: "deny_all",
  provider: {
    providerID: "test-provider",
    modelID: "deterministic",
    protocol: "openai-chat",
    routeID: "route-one",
    configurationHash: "c".repeat(64),
    endpoint: "https://EXAMPLE.test:443/v1/chat/completions",
    evidenceID: "transport-proof-one",
    evidenceHash: "d".repeat(64),
    endpointPinned: true,
    redirectsDenied: true,
    transportRetriesDenied: true,
    completion: { parameter: "max_completion_tokens", hardLimit: true, includesReasoning: true, maxTokens: 4_096 },
  },
  budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, maxTotalTokens: 8_000 },
  deadline: 100_000,
})

const bound: WorkAuthoritySchema.InputBound = {
  tokens: 1_024,
  kind: "conservative",
  evidenceID: "bound-one",
  evidenceHash: "e".repeat(64),
}

describe("work authority data and policy (does not grant execution)", () => {
  test("strict candidate normalization preserves the smaller cap and explicitly has no authority", () => {
    const result = WorkAuthorityPolicy.validateBinding(candidate())
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.authorization).toBe("not_checked")
    expect(result.value.budget.maxTotalTokens).toBe(8_000)
    expect(result.value.provider.endpoint).toBe("https://example.test/v1/chat/completions")
    expect(result.value.toolPolicy).toBe("deny_all")
    expect(result.value.budget.maxProviderDispatches).toBe(1)
    expect(result.value.budget.maxChildren).toBe(0)
  })

  test.each([
    { ...candidate(), authorized: true },
    { ...candidate(), source: { ...candidate().source, kind: "chat_sender" } },
    { ...candidate(), provider: { ...candidate().provider, secret: "must-not-be-accepted" } },
    { ...candidate(), budget: { ...candidate().budget, maxTotalTokens: -1 } },
    { ...candidate(), budget: { ...candidate().budget, maxTotalTokens: Number.NaN } },
    { ...candidate(), budget: { ...candidate().budget, maxTotalTokens: 1.5 } },
    { ...candidate(), source: { ...candidate().source, authorityRevision: 0 } },
  ])("rejects malformed or excess authority-like fields %#", (input) => {
    const result = WorkAuthorityPolicy.validateBinding(input)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected rejection")
    expect(result.error.code).toBe("WORK_INVALID_REQUEST")
    expect(result.error.message).not.toContain("must-not-be-accepted")
  })

  test.each(["endpointPinned", "redirectsDenied", "transportRetriesDenied"] as const)(
    "route without %s evidence is unavailable",
    (key) => {
      const result = WorkAuthorityPolicy.validateBinding({
        ...candidate(),
        provider: { ...candidate().provider, [key]: false },
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected rejection")
      expect(result.error.code).toBe("PROFILE_UNAVAILABLE")
    },
  )

  test.each([{ hardLimit: false }, { includesReasoning: false }, { maxTokens: 128 }])(
    "a route cannot claim an unproven completion limit %#",
    (patch) => {
      const result = WorkAuthorityPolicy.validateBinding({
        ...candidate(),
        provider: { ...candidate().provider, completion: { ...candidate().provider.completion, ...patch } },
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected rejection")
      expect(result.error.code).toBe("PROFILE_UNAVAILABLE")
    },
  )

  test.each([
    "http://example.test/v1",
    "https://user:secret@example.test/v1",
    "https://example.test/v1?api_key=secret",
    "https://example.test/v1#secret",
    "file:///tmp/model",
    "http://localhost:1234/v1",
  ])("unsafe endpoint %s is rejected without reflecting credentials", (endpoint) => {
    const result = WorkAuthorityPolicy.normalizeEndpoint(endpoint, { allowLoopbackHTTP: true })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected rejection")
    expect(result.error.code).toBe("WORK_ENDPOINT_DENIED")
    expect(result.error.message).not.toContain("secret")
  })

  test("literal loopback HTTP requires explicit trusted runtime configuration", () => {
    expect(WorkAuthorityPolicy.normalizeEndpoint("http://127.0.0.1:4567/v1").ok).toBe(false)
    expect(WorkAuthorityPolicy.normalizeEndpoint("http://127.0.0.1:4567/v1", { allowLoopbackHTTP: true })).toEqual({
      ok: true,
      value: "http://127.0.0.1:4567/v1",
      authorization: "not_checked",
    })
  })

  test("unsupported profile and changed static profile hash cannot silently use the default", () => {
    expect(
      WorkAuthorityPolicy.validateBinding({
        ...candidate(),
        profile: { ...candidate().profile, id: "project_work_v1" },
      }).ok,
    ).toBe(false)
    expect(
      WorkAuthorityPolicy.validateBinding({ ...candidate(), profile: { ...candidate().profile, hash: "f".repeat(64) } })
        .ok,
    ).toBe(false)
  })

  test("fingerprint is key-order stable and binds route, source revision, input and ceilings", () => {
    const original = candidate()
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as WorkAuthoritySchema.Binding
    expect(WorkAuthorityPolicy.fingerprint(original)).toBe(WorkAuthorityPolicy.fingerprint(reordered))
    expect(
      new Set(
        [
          original,
          { ...original, inputID: "msg_other" },
          { ...original, source: { ...original.source, authorityRevision: 2 } },
          { ...original, provider: { ...original.provider, endpoint: "https://other.test/v1" } },
          { ...original, budget: { ...original.budget, maxTotalTokens: 7_999 } },
        ].map(WorkAuthorityPolicy.fingerprint),
      ).size,
    ).toBe(5)
  })

  test("audited text requires exact bytes and hash", () => {
    expect(WorkAuthorityPolicy.checkAuditedText(candidate(), "review this text").ok).toBe(true)
    expect(WorkAuthorityPolicy.checkAuditedText(candidate(), "review that text").ok).toBe(false)
  })

  test("provider reservation sums input plus completion; reasoning usage is not counted twice", () => {
    expect(WorkAuthorityPolicy.providerReservation(candidate().budget, bound, 4_096)).toEqual({
      ok: true,
      value: { inputTokens: 1_024, completionTokens: 4_096, totalTokens: 5_120 },
      authorization: "not_checked",
    })
    expect(WorkAuthorityPolicy.usageTotal({ inputTokens: 100, completionTokens: 60, reasoningTokens: 40 })).toEqual({
      ok: true,
      value: 160,
      authorization: "not_checked",
    })
    expect(WorkAuthorityPolicy.usageTotal({ inputTokens: 100, completionTokens: 60, reasoningTokens: 61 }).ok).toBe(
      false,
    )
    expect(WorkAuthorityPolicy.providerReservation(candidate().budget, { ...bound, tokens: 5_000 }, 4_096).ok).toBe(
      false,
    )
    expect(
      WorkAuthorityPolicy.providerReservation({ ...candidate().budget, maxProviderDispatches: 0 }, bound, 1).ok,
    ).toBe(false)
  })

  test("child ceilings cannot grow or change scope; even a matching child is unavailable in text-only", () => {
    const parent = candidate()
    expect(WorkAuthorityPolicy.checkBudgetCeiling(parent.budget, { ...parent.budget, maxTotalTokens: 7_000 }).ok).toBe(
      true,
    )
    expect(WorkAuthorityPolicy.checkBudgetCeiling(parent.budget, { ...parent.budget, maxToolCalls: 1 }).ok).toBe(false)
    expect(WorkAuthorityPolicy.checkBudgetCeiling(parent.budget, { ...parent.budget, hourWindowMinutes: 1 }).ok).toBe(
      false,
    )
    const child = {
      ...parent,
      workID: "child",
      parentWorkID: parent.workID,
      sessionID: "ses_child",
      inputID: "msg_child",
    }
    const matching = WorkAuthorityPolicy.checkChild(parent, child)
    expect(matching.ok).toBe(false)
    if (matching.ok) throw new Error("expected rejection")
    expect(matching.error.code).toBe("PROFILE_UNAVAILABLE")
    const expanded = WorkAuthorityPolicy.checkChild(parent, { ...child, scope: { ...child.scope, actorID: "other" } })
    expect(expanded.ok).toBe(false)
    if (expanded.ok) throw new Error("expected rejection")
    expect(expanded.error.code).toBe("WORK_CEILING_VIOLATION")
  })

  test("unknown and terminal dispatches cannot be reset by retry or a new control revision", () => {
    expect(WorkAuthorityPolicy.checkDispatchTransition("reserved", "dispatching").ok).toBe(true)
    expect(WorkAuthorityPolicy.checkDispatchTransition("reserved", "released").ok).toBe(true)
    expect(WorkAuthorityPolicy.checkDispatchTransition("dispatching", "unknown").ok).toBe(true)
    expect(WorkAuthorityPolicy.checkDispatchTransition("dispatching", "released").ok).toBe(false)
    for (const next of ["reserved", "dispatching", "released", "settled"] as const) {
      const result = WorkAuthorityPolicy.checkDispatchTransition("unknown", next)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected rejection")
      expect(result.error.code).toBe("WORK_RECOVERY_REQUIRED")
    }
    expect(WorkAuthorityPolicy.checkDispatchTransition("settled", "reserved").ok).toBe(false)
  })
})
