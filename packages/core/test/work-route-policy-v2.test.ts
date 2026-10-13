import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { LLM } from "@deepagent-code/llm"
import { WorkRoutePolicy } from "../src/session/work-route-policy"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { EventInvestigationFixture } from "./fixture/event-investigation"
import { WorkRouteFixture } from "./fixture/work-route"

test("actual Responses preparation retains the exact event, project and text profile prefixes", async () => {
  const fixture = WorkRouteFixture.candidate()
  const investigation = { ...EventInvestigationFixture.binding(), provider: fixture.binding.provider,
    auditedText: fixture.binding.auditedText,
    budget: { ...WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget, maxCompletionTokens: 64 } }
  const project: WorkAuthoritySchema.ProjectBinding = { ...investigation,
    profile: { id: "project_work_v1", version: 1, hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH },
    source: { ...investigation.source, kind: "server_operator" } }
  for (const binding of [investigation, project, fixture.binding]) {
    const profile = WorkAuthorityPolicy.profileFor(binding.profile)
    if (!profile) throw new Error("Expected an exact known fixture profile")
    const request = LLM.updateRequest(fixture.request, { system: profile.instructions })
    const wire = await Effect.runPromise(WorkRouteFixture.encoded(request))
    const inspected = WorkRoutePolicy.inspect({ binding, auditedText: WorkRouteFixture.TEXT,
      runtime: fixture.runtime, wire })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) throw inspected.error
    expect(inspected.authorization).toBe("not_checked")
    expect(inspected.value.countBody.input).toEqual([
      { role: "system", content: profile.instructions },
      { role: "user", content: [{ type: "input_text", text: WorkRouteFixture.TEXT }] },
    ])
    expect(inspected.value.completionTokens).toBe(32)
  }
})

test("an event wire cannot borrow project or text instructions or an unverified profile tuple", async () => {
  const fixture = WorkRouteFixture.candidate()
  const binding = { ...EventInvestigationFixture.binding(), provider: fixture.binding.provider,
    auditedText: fixture.binding.auditedText,
    budget: { ...WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget, maxCompletionTokens: 64 } }
  for (const system of [WorkAuthorityPolicy.PROJECT_PROFILE.instructions, WorkAuthorityPolicy.TEXT_ONLY_PROFILE.instructions]) {
    const wire = await Effect.runPromise(WorkRouteFixture.encoded(LLM.updateRequest(fixture.request, { system })))
    const inspected = WorkRoutePolicy.inspect({ binding, auditedText: WorkRouteFixture.TEXT,
      runtime: fixture.runtime, wire })
    expect(inspected.ok).toBe(false)
    if (!inspected.ok) expect(inspected.error.code).toBe("WORK_BINDING_CONFLICT")
  }
  const wire = await Effect.runPromise(WorkRouteFixture.encoded(LLM.updateRequest(fixture.request,
    { system: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.instructions })))
  for (const hash of [WorkAuthorityPolicy.PROJECT_PROFILE_HASH, "0".repeat(64)]) {
    const inspected = WorkRoutePolicy.inspect({ binding: { ...binding, profile: { ...binding.profile, hash } },
      auditedText: WorkRouteFixture.TEXT, runtime: fixture.runtime, wire })
    expect(inspected.ok).toBe(false)
    if (!inspected.ok) expect(inspected.error.code).toBe("PROFILE_UNAVAILABLE")
  }
  if (fixture.binding.schemaVersion !== "work-execution.v1") throw new Error("Expected the original text fixture")
  for (const profile of [
    { id: "unknown_profile", version: 1, hash: WorkAuthorityPolicy.TEXT_ONLY_PROFILE_HASH },
    { id: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.id, version: 2, hash: WorkAuthorityPolicy.TEXT_ONLY_PROFILE_HASH },
  ]) {
    const unknown = WorkRoutePolicy.inspect({ binding: { ...fixture.binding, profile },
      auditedText: WorkRouteFixture.TEXT, runtime: fixture.runtime,
      wire: await Effect.runPromise(WorkRouteFixture.encoded(fixture.request)) })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe("PROFILE_UNAVAILABLE")
  }
})

test("authenticated approval hash and projection hash are distinct, and a v1/partial count never inherits current identity", async () => {
  const fixture = WorkRouteFixture.candidate()
  const input = { binding: fixture.binding, auditedText: WorkRouteFixture.TEXT, runtime: fixture.runtime,
    wire: await Effect.runPromise(WorkRouteFixture.encoded(fixture.request)),
    dispatch: { workID: fixture.binding.workID, inputID: fixture.binding.inputID, sessionID: fixture.binding.sessionID,
      bindingHash: "b".repeat(64), controlRevision: 1, sourceAuthorityID: fixture.binding.source.authorityID,
      sourceRevision: 1, sourceRecordHash: "f".repeat(64), providerReceiptID: "provider-receipt",
      providerAttemptID: "provider-attempt", sessionClaimToken: 1, providerOwnerToken: "provider-owner" },
  }
  const receipt = WorkRouteFixture.receipt(input, fixture.evidence)
  const run = (value: WorkRoutePolicy.Input, count: WorkRoutePolicy.CountReceipt) => Effect.runPromise(
    WorkRoutePolicy.verify(value).pipe(
      Effect.provide(WorkRouteFixture.authority({ evidence: fixture.evidence, receipt: count })),
      Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
      Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"), Effect.exit,
    ),
  )
  expect(fixture.binding.provider.evidenceHash).toBe(fixture.evidence.approvalEvidenceHash)
  expect(fixture.binding.provider.evidenceHash).not.toBe(fixture.evidence.projectionHash)
  expect(fixture.binding.provider.routeID).not.toBe(fixture.runtime.routeID)
  expect(Exit.isSuccess(await run(input, receipt))).toBe(true)
  for (const key of ["workID", "inputID", "sessionID", "bindingHash", "sourceRecordHash", "providerReceiptID", "providerAttemptID", "providerOwnerToken"] as const) {
    const result = await run(input, { ...receipt, binding: { ...receipt.binding, [key]: `${receipt.binding[key]}-changed` } })
    expect(Exit.isFailure(result)).toBe(true)
  }
  const partial = { ...receipt }
  Reflect.deleteProperty(partial, "binding")
  expect(Exit.isFailure(await run(input, partial))).toBe(true)
  const missing = await run({ ...input, dispatch: undefined }, receipt)
  expect(Exit.isFailure(missing)).toBe(true)
  if (Exit.isFailure(missing)) expect(Cause.squash(missing.cause)).toBeInstanceOf(WorkAuthoritySchema.Error)
})
