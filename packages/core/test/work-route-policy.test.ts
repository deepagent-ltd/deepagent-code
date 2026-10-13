import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LLM } from "@deepagent-code/llm"
import { LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { AnthropicMessages } from "@deepagent-code/llm/protocols/anthropic-messages"
import { WorkRoutePolicy } from "../src/session/work-route-policy"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { WorkRouteFixture } from "./fixture/work-route"

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return error instanceof WorkAuthoritySchema.Error ? error.code : Cause.pretty(exit.cause)
}
function noRetry<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
    Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
  )
}
const input = (fixture: ReturnType<typeof WorkRouteFixture.candidate>, wire: RequestExecutor.RequestSealInput) => ({
  binding: fixture.binding,
  auditedText: WorkRouteFixture.TEXT,
  runtime: fixture.runtime,
  wire,
  // Pure policy fixture only; SQL/canonical identity is covered by provider-dispatch tests.
  dispatch: {
    workID: fixture.binding.workID, inputID: fixture.binding.inputID, sessionID: fixture.binding.sessionID,
    bindingHash: "b".repeat(64), controlRevision: 1, sourceAuthorityID: fixture.binding.source.authorityID,
    sourceRevision: 1, sourceRecordHash: "f".repeat(64), providerReceiptID: "fixture-receipt",
    providerAttemptID: "fixture-attempt", sessionClaimToken: 1, providerOwnerToken: "fixture-owner",
  },
})

test("actual Responses lowering has the narrow audited shape, but inspection is not authority", async () => {
  const fixture = WorkRouteFixture.candidate()
  const value = input(fixture, await Effect.runPromise(WorkRouteFixture.encoded(fixture.request)))
  const inspected = WorkRoutePolicy.inspect(value)
  expect(inspected.ok).toBe(true)
  if (!inspected.ok) throw inspected.error
  expect(inspected.authorization).toBe("not_checked")
  expect(inspected.value.countBody).toEqual({
    model: fixture.runtime.modelID,
    input: JSON.parse(value.wire.bodyText!).input,
  })
  expect(inspected.value.completionTokens).toBe(32)
  expect(code(await Effect.runPromise(noRetry(WorkRoutePolicy.verify(value)).pipe(Effect.exit)))).toBe(
    "PROFILE_UNAVAILABLE",
  )
})

test("valid trusted count proof binds exact final hashes and retains a smaller completion cap", async () => {
  const fixture = WorkRouteFixture.candidate()
  const value = input(fixture, await Effect.runPromise(WorkRouteFixture.encoded(fixture.request)))
  const proof = WorkRouteFixture.receipt(value, fixture.evidence)
  const result = await Effect.runPromise(
    noRetry(WorkRoutePolicy.verify(value)).pipe(
      Effect.provide(WorkRouteFixture.authority({ evidence: fixture.evidence, receipt: proof })),
    ),
  )
  expect(result).toMatchObject({
    bodyHash: value.wire.bodyHash,
    wireHash: value.wire.wireHash,
    completionTokens: 32,
    totalTokens: 73,
  })
  expect(result.inputBound).toMatchObject({ kind: "exact", tokens: 41, evidenceID: proof.id })
})

const deniedBodies = [
  { name: "larger completion overlay", body: { max_output_tokens: 65 }, code: "WORK_CEILING_VIOLATION" },
  { name: "sub-minimum completion is never rounded up", body: { max_output_tokens: 15 }, code: "PROFILE_UNAVAILABLE" },
  { name: "model overlay", body: { model: "another-model" }, code: "WORK_BINDING_CONFLICT" },
  { name: "hosted retrieval", body: { tools: [{ type: "web_search" }] }, code: "WORK_CEILING_VIOLATION" },
  { name: "empty tools are still outside the frozen shape", body: { tools: [] }, code: "WORK_CEILING_VIOLATION" },
  { name: "previous response", body: { previous_response_id: "resp_other" }, code: "WORK_CEILING_VIOLATION" },
  { name: "server conversation", body: { conversation: "conv_other" }, code: "WORK_CEILING_VIOLATION" },
  { name: "provider instructions", body: { instructions: "Read private files" }, code: "WORK_CEILING_VIOLATION" },
  { name: "prompt template", body: { prompt: { id: "template_other" } }, code: "WORK_CEILING_VIOLATION" },
  { name: "server compaction", body: { context_management: [{ type: "compaction" }] }, code: "WORK_CEILING_VIOLATION" },
  { name: "response format", body: { text: { format: { type: "json_object" } } }, code: "WORK_CEILING_VIOLATION" },
  { name: "stored response", body: { store: true }, code: "WORK_CEILING_VIOLATION" },
  { name: "background execution", body: { background: true }, code: "WORK_CEILING_VIOLATION" },
  { name: "unknown future option", body: { future_context: "opaque" }, code: "WORK_CEILING_VIOLATION" },
] as const
test.each([...deniedBodies])("final encoded JSON rejects $name", async (variant) => {
  const fixture = WorkRouteFixture.candidate()
  const wire = await Effect.runPromise(
    WorkRouteFixture.encoded(LLM.updateRequest(fixture.request, { http: { body: variant.body } })),
  )
  const inspected = WorkRoutePolicy.inspect(input(fixture, wire))
  expect(inspected.ok).toBe(false)
  if (!inspected.ok) expect(inspected.error.code).toBe(variant.code)
})

test("history, modified audited text, system and nested extra fields cannot enter the final input", async () => {
  const fixture = WorkRouteFixture.candidate()
  const original = await Effect.runPromise(WorkRouteFixture.encoded(fixture.request))
  const body = JSON.parse(original.bodyText)
  for (const replacement of [
    [...body.input, { role: "assistant", content: "older history" }],
    [body.input[0], { role: "user", content: [{ type: "input_text", text: "unaudited" }] }],
    [{ role: "system", content: "different instructions" }, body.input[1]],
    [body.input[0], { ...body.input[1], name: "extra" }],
    [body.input[0], { role: "user", content: [{ type: "input_image", image_url: "https://other.test/image" }] }],
  ])
    expect(
      WorkRoutePolicy.inspect(input(fixture, WorkRouteFixture.wire(JSON.stringify({ ...body, input: replacement }))))
        .ok,
    ).toBe(false)
  expect(
    WorkRoutePolicy.inspect(
      input(fixture, WorkRouteFixture.wire(original.bodyText.replace('"model":', '"model":"duplicate","model":'))),
    ).ok,
  ).toBe(false)
})

test("final byte, body, method, query and wire identities cannot drift", async () => {
  const fixture = WorkRouteFixture.candidate()
  const original = await Effect.runPromise(WorkRouteFixture.encoded(fixture.request))
  for (const patch of [
    { bodyHash: "0".repeat(64) },
    { wireHash: "0".repeat(64) },
    { bodyLength: original.bodyLength + 1 },
    { method: "PUT" },
    { method: undefined },
    { url: undefined },
    { contentType: "text/plain" },
    { bodyText: undefined },
    { url: `${original.url}?api-version=other` },
    { url: "https://compatible.test/v1/responses" },
  ])
    expect(WorkRoutePolicy.inspect(input(fixture, { ...original, ...patch })).ok).toBe(false)
})

test("an Anthropic encoded request and missing deployment identity cannot use the Responses candidate", async () => {
  const fixture = WorkRouteFixture.candidate()
  const request = LLM.request({
    model: AnthropicMessages.route.model({ id: "fixture-anthropic-model" }),
    system: "Fixed text",
    prompt: WorkRouteFixture.TEXT,
    generation: { maxTokens: 32 },
  })
  const body = await Effect.runPromise(AnthropicMessages.route.body.from(request))
  expect(WorkRoutePolicy.inspect(input(fixture, WorkRouteFixture.wire(JSON.stringify(body)))).ok).toBe(false)
  const value = input(fixture, await Effect.runPromise(WorkRouteFixture.encoded(fixture.request)))
  expect(WorkRoutePolicy.inspect({ ...value, runtime: { ...value.runtime, modelRevision: "" } }).ok).toBe(false)
})

test("real executor references must disable both retries and redirects", async () => {
  const fixture = WorkRouteFixture.candidate()
  const value = input(fixture, await Effect.runPromise(WorkRouteFixture.encoded(fixture.request)))
  const authority = WorkRouteFixture.authority({
    evidence: fixture.evidence,
    receipt: WorkRouteFixture.receipt(value, fixture.evidence),
  })
  for (const request of [
    WorkRoutePolicy.verify(value),
    WorkRoutePolicy.verify(value).pipe(Effect.provideService(RequestExecutor.CurrentRetryLimit, 0)),
    WorkRoutePolicy.verify(value).pipe(Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual")),
  ])
    expect(code(await Effect.runPromise(request.pipe(Effect.provide(authority), Effect.exit)))).toBe(
      "PROFILE_UNAVAILABLE",
    )
})

test("missing, stale, changed model/config/counter and non-exact receipts never become bounds", async () => {
  const fixture = WorkRouteFixture.candidate()
  const value = input(fixture, await Effect.runPromise(WorkRouteFixture.encoded(fixture.request)))
  const receipt = WorkRouteFixture.receipt(value, fixture.evidence)
  const patches: Partial<WorkRoutePolicy.CountReceipt>[] = [
    { routeRevision: 2 },
    { routeHash: "0".repeat(64) },
    { configurationHash: "0".repeat(64) },
    { modelID: "other" },
    { modelRevision: "drifted-alias" },
    { counterID: "other" },
    { counterRevision: 2 },
    { counterEndpoint: "https://compatible.test/count" },
    { tokenizerIdentity: "other" },
    { framingIdentity: "other" },
    { counterContractHash: "0".repeat(64) },
    { inputTupleHash: "0".repeat(64) },
    { bodyHash: "0".repeat(64) },
    { wireHash: "0".repeat(64) },
    { expiresAt: Date.now() - 1 },
    { countedAt: Date.now() + 60_000 },
    { tokens: Number.NaN },
    { tokens: Number.POSITIVE_INFINITY },
    { tokens: -1 },
    { tokens: 41.5 },
  ]
  for (const receipt of [
    undefined,
    ...patches.map((patch) => ({ ...WorkRouteFixture.receipt(value, fixture.evidence), ...patch })),
  ]) {
    expect(
      code(
        await Effect.runPromise(
          noRetry(WorkRoutePolicy.verify(value)).pipe(
            Effect.provide(WorkRouteFixture.authority({ evidence: fixture.evidence, receipt })),
            Effect.exit,
          ),
        ),
      ),
    ).toBe("PROFILE_UNAVAILABLE")
  }
  expect(
    code(
      await Effect.runPromise(
        noRetry(WorkRoutePolicy.verify(value)).pipe(
          Effect.provide(
            WorkRouteFixture.authority({ evidence: fixture.evidence, receipt: { ...receipt, tokens: 100_000 } }),
          ),
          Effect.exit,
        ),
      ),
    ),
  ).toBe("WORK_BUDGET_EXHAUSTED")
})

test("route revocation and deployment changes during count read invalidate the final seal", async () => {
  const fixture = WorkRouteFixture.candidate()
  const value = input(fixture, await Effect.runPromise(WorkRouteFixture.encoded(fixture.request)))
  for (const evidence of [
    { ...fixture.evidence, state: "revoked" as const },
    { ...fixture.evidence, expiresAt: Date.now() - 1 },
    { ...fixture.evidence, runtime: { ...fixture.runtime, modelRevision: "changed" } },
    { ...fixture.evidence, runtime: { ...fixture.runtime, loweringHash: "0".repeat(64) } },
  ]) {
    const state = {
      evidence: fixture.evidence,
      receipt: WorkRouteFixture.receipt(value, fixture.evidence),
      afterRead: () => {
        state.evidence = evidence
      },
    }
    expect(
      code(
        await Effect.runPromise(
          noRetry(WorkRoutePolicy.verify(value)).pipe(Effect.provide(WorkRouteFixture.authority(state)), Effect.exit),
        ),
      ),
    ).toBe("PROFILE_UNAVAILABLE")
  }
})

test("actual protocol + HTTP final seal sends only an approved body and rejects overlays before transport", async () => {
  const bodies: string[] = []
  const counts: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/v1/responses/input_tokens") {
        counts.push(await request.json())
        // Deterministic external boundary; this is NOT a real tokenizer or OpenAI approval.
        return Response.json({ object: "response.input_tokens", input_tokens: 41 })
      }
      bodies.push(await request.text())
      return new Response(
        'data: {"type":"response.output_text.delta","item_id":"msg_fixture","delta":"accepted"}\n\ndata: {"type":"response.completed","response":{"id":"resp_fixture"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    const fixture = WorkRouteFixture.candidate(`${server.url.origin}/v1/responses`)
    const value = input(fixture, await Effect.runPromise(WorkRouteFixture.encoded(fixture.request)))
    const inspected = WorkRoutePolicy.inspect(value, { allowLoopbackHTTP: true })
    if (!inspected.ok) throw inspected.error
    const counted = await fetch(fixture.evidence.counter.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inspected.value.countBody),
    })
    const countedBody = (await counted.json()) as { input_tokens: number }
    const proof = WorkRouteFixture.receipt(value, fixture.evidence, countedBody.input_tokens)
    const sealed: WorkRoutePolicy.Input["wire"][] = []
    const runtime = LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))
    const run = (request: ReturnType<typeof LLM.request>) =>
      Effect.runPromise(
        noRetry(LLMClient.generate(request)).pipe(
          Effect.provideService(RequestExecutor.CurrentRequestSeal, {
            seal: (wire) =>
              Effect.gen(function* () {
                sealed.push(wire)
                yield* WorkRoutePolicy.verify({ ...value, wire }, { allowLoopbackHTTP: true }).pipe(Effect.orDie)
              }),
          }),
          Effect.provide(WorkRouteFixture.authority({ evidence: fixture.evidence, receipt: proof })),
          Effect.provide(runtime),
          Effect.exit,
        ),
      )
    const initial = await run(fixture.request)
    if (Exit.isFailure(initial)) console.info("WORK_ROUTE_FAILURE", Cause.squash(initial.cause))
    expect(code(initial)).toBe("success")
    expect(bodies).toEqual([value.wire.bodyText!])
    expect(counts).toEqual([inspected.value.countBody])
    expect(sealed[0].bodyHash).toBe(proof.bodyHash)
    expect(sealed[0].wireHash).toBe(proof.wireHash)
    const changes = [
      ...deniedBodies.map((variant) => LLM.updateRequest(fixture.request, { http: { body: variant.body } })),
      LLM.updateRequest(fixture.request, {
        messages: [{ role: "assistant", content: [{ type: "text", text: "history" }] }],
      }),
      LLM.updateRequest(fixture.request, { http: { query: { extra: "changed" } } }),
      LLM.updateRequest(fixture.request, {
        model: fixture.request.model.route
          .with({ endpoint: { baseURL: `${server.url.origin}/other` } })
          .model({ id: fixture.runtime.modelID }),
      }),
      // Even a safe lower cap requires a receipt bound to the newly encoded body/wire.
      LLM.updateRequest(fixture.request, { http: { body: { max_output_tokens: 16 } } }),
    ]
    for (const changed of changes) {
      expect(code(await run(changed))).not.toBe("success")
      expect(bodies).toHaveLength(1)
      expect(counts).toHaveLength(1)
    }
    const early = await Effect.runPromise(
      LLMClient.prepare(LLM.updateRequest(fixture.request, { http: { body: { max_output_tokens: 65 } } })).pipe(
        Effect.provide(runtime),
      ),
    )
    expect(early.body).toMatchObject({ max_output_tokens: 32 })
    expect(JSON.parse(sealed[1].bodyText!).max_output_tokens).toBe(65)
  } finally {
    await server.stop(true)
  }
})
