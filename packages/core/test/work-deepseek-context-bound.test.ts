import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { LLM } from "@deepagent-code/llm"
import { deepseek } from "@deepagent-code/llm/providers/openai-compatible"
import { Auth, RequestExecutor, VendorContextBound } from "@deepagent-code/llm/route"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { WorkRoutePolicy } from "../src/session/work-route-policy"
import { WorkCountAcquisitionSchema } from "../src/session/work-count-acquisition.schema"
import { WorkRouteApprovalSchema } from "../src/session/work-route-approval.schema"
import { EventInvestigationFixture } from "./fixture/event-investigation"
import { WorkRouteFixture } from "./fixture/work-route"
import { Hash } from "../src/util/hash"

async function candidate() {
  const old = WorkRouteFixture.candidate(VendorContextBound.DEEPSEEK_FLASH.endpoint)
  const runtime = { ...old.runtime, providerID: "deepseek", modelID: "deepseek-flash",
    modelRevision: VendorContextBound.DEEPSEEK_FLASH.modelRevision }
  const approval = { ...old.evidence, runtime, completion: { ...old.evidence.completion, maxTokens: 32_768 },
    counter: { ...old.evidence.counter, id: VendorContextBound.DEEPSEEK_FLASH.id,
      endpoint: VendorContextBound.DEEPSEEK_FLASH.counterEndpoint, semantics: VendorContextBound.DEEPSEEK_FLASH.semantics,
      inputUpperBoundTokens: 1_048_576 as const } }
  const evidence = { ...approval, projectionHash: WorkRoutePolicy.fingerprint(approval) }
  const original = EventInvestigationFixture.binding("deepseek-context")
  const binding: WorkAuthoritySchema.ProjectBinding = { ...original,
    source: { ...original.source, kind: "server_operator" },
    profile: { id: "project_deepseek_context_bound_v1", version: 1, hash: WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE_HASH },
    provider: { ...old.binding.provider, providerID: runtime.providerID, modelID: runtime.modelID,
      completion: { ...old.binding.provider.completion, maxTokens: 32_768 } },
    auditedText: old.binding.auditedText,
    deadline: old.binding.deadline,
    budget: { ...WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.budget, maxProviderDispatches: 2,
      maxTotalTokens: 2_105_344, hourTokensMax: 2_105_344 },
  }
  const request = LLM.request({ model: deepseek.configure({ baseURL: "https://api.deepseek.com",
    auth: Auth.value("unused-private-preparation-key").bearer() }).responses("deepseek-flash"),
    system: WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.instructions,
    prompt: WorkRouteFixture.TEXT, generation: { maxTokens: 4_096 }, providerOptions: { openai: { store: false } } })
  const wire = await Effect.runPromise(WorkRouteFixture.encoded(request))
  const input = { binding, runtime, wire, auditedText: WorkRouteFixture.TEXT }
  const inspected = WorkRoutePolicy.inspect(input)
  if (!inspected.ok) throw inspected.error
  const dispatch = { workID: binding.workID, inputID: binding.inputID, sessionID: binding.sessionID,
    bindingHash: Hash.sha256("controlled-binding"), controlRevision: 1, sourceAuthorityID: binding.source.authorityID,
    sourceRevision: binding.source.authorityRevision, sourceRecordHash: Hash.sha256("controlled-original-source"),
    providerReceiptID: "canonical-receipt", providerAttemptID: "canonical-attempt", sessionClaimToken: 1,
    providerOwnerToken: "canonical-owner", project: { rootWorkID: binding.rootWorkID,
      turn: { key: Hash.sha256("canonical-turn"), activityID: "activity", providerTurnSeq: 1,
        contextSelectionID: "selection", contextProjectionHash: Hash.sha256("projection"), historyPromptEpoch: 0,
        historySourceEndMessageID: null }, predecessor: null, toolAdvertisementHash: inspected.value.toolAdvertisementHash } }
  const proof = WorkRoutePolicy.projectCountBinding(dispatch, evidence, inspected.value)
  if (!proof) throw new Error("Expected explicit project count binding")
  // Controlled authority response for the route-policy module only. The actual native local
  // observation is independently tested; no grant, provider response or execution is invented.
  const receipt: WorkRoutePolicy.ProjectCountReceipt = { ...WorkRouteFixture.receipt({ ...input, dispatch }, evidence, 1_048_576),
    version: "native-project-count-receipt.v1", binding: proof }
  const verify = (count = receipt, actual = input, route: WorkRoutePolicy.RouteEvidence = evidence) => Effect.runPromise(WorkRoutePolicy.verify({ ...actual, dispatch }).pipe(
    Effect.provide(Layer.succeed(WorkRoutePolicy.Evidence, {
      resolve: () => Effect.succeed(route), readCount: () => Effect.succeed(count),
    })), Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
    Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"), Effect.exit,
  ))
  return { old, evidence, binding, input, receipt, verify }
}

const errorCode = (result: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(result)) return "success"
  const error = Cause.squash(result.cause)
  return error instanceof WorkAuthoritySchema.Error ? error.code : "unexpected"
}

test("formal DeepSeek bound reserves conservative capacity and settles actual usage separately", async () => {
  const value = await candidate()
  const result = await value.verify()
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
  expect(Exit.isSuccess(result)).toBe(true)
  expect(result.value.inputBound.kind).toBe("conservative")
  expect(result.value.inputBound.tokens).toBe(1_048_576)
  expect(result.value.totalTokens).toBe(1_052_672)
  expect(WorkAuthorityPolicy.usageTotal({ inputTokens: 18_797, completionTokens: 68, reasoningTokens: 28 }))
    .toMatchObject({ ok: true, value: 18_865 })
  expect(WorkAuthorityPolicy.usageTotal({ inputTokens: 1, completionTokens: 20, reasoningTokens: 21 }).ok).toBe(false)
})

test("a small old budget, changed wire or false upper bound cannot use the formal local proof", async () => {
  const value = await candidate()
  expect(errorCode(await value.verify(value.receipt, { ...value.input, binding: {
    ...value.binding, budget: { ...value.binding.budget, maxInputTokens: 65_536, maxTotalTokens: 131_072, hourTokensMax: 131_072 },
  } }))).toBe("WORK_BUDGET_EXHAUSTED")
  expect(errorCode(await value.verify({ ...value.receipt, tokens: 41 }))).toBe("PROFILE_UNAVAILABLE")
  expect(errorCode(await value.verify({ ...value.receipt, wireHash: Hash.sha256("changed wire") }))).toBe("PROFILE_UNAVAILABLE")
  expect(errorCode(await value.verify(value.receipt, { ...value.input, binding: {
    ...value.binding, profile: { id: "project_work_v1", version: 1, hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH },
  } }))).toBe("WORK_CEILING_VIOLATION")
  const falseRoute = { ...value.evidence, counter: { ...value.evidence.counter, inputUpperBoundTokens: undefined } }
  expect(errorCode(await value.verify(value.receipt, value.input,
    { ...falseRoute, projectionHash: WorkRoutePolicy.fingerprint(falseRoute) }))).toBe("PROFILE_UNAVAILABLE")
})

test("strict new count discriminator cannot reinterpret old exact project bytes or missing local fields", async () => {
  const value = await candidate()
  const decode = Schema.decodeUnknownOption(WorkCountAcquisitionSchema.ProjectBinding, { onExcessProperty: "error" })
  expect(Option.isSome(decode(value.receipt.binding))).toBe(true)
  const exact = { ...value.receipt.binding, inputProjectionVersion: "openai-responses-project-input.v1" }
  expect(Option.isNone(decode(exact))).toBe(true)
  for (const field of ["counterSemantics", "inputUpperBoundTokens"] as const) {
    const missing = { ...value.receipt.binding }
    Reflect.deleteProperty(missing, field)
    expect(Option.isNone(decode(missing))).toBe(true)
  }
  expect(WorkAuthorityPolicy.PROJECT_PROFILE.budget.maxInputTokens).toBe(65_536)
  expect(WorkAuthorityPolicy.PROJECT_PROFILE.id).toBe("project_work_v1")
  expect(Schema.decodeUnknownOption(WorkRouteApprovalSchema.ContextBoundEvidence)(
    { providerID: "deepseek", modelID: "deepseek-flash", counterSemantics: "vendor_context_input_upper_bound" })._tag).toBe("None")
})
