export * as WorkRouteFixture from "./work-route"

import { LLM } from "@deepagent-code/llm"
import { OpenAIResponses } from "@deepagent-code/llm/protocols/openai-responses"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { HttpClientRequest } from "effect/unstable/http"
import { Effect, Layer, Option, Schema } from "effect"
import { Hash } from "../../src/util/hash"
import { WorkAuthorityPolicy } from "../../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../../src/session/work-authority.schema"
import { WorkRoutePolicy } from "../../src/session/work-route-policy"
import { WorkAuthorityFixture } from "./work-authority"
import type { Database } from "../../src/database/database"
import { WorkExecutionTable } from "../../src/session/work-authority.sql"
import { V2ProviderTurnReceiptTable } from "../../src/session/runner/v2-provider-turn.sql"
import { SessionProviderAttemptTable } from "../../src/context-federation/session-sql"
import { eq } from "drizzle-orm"

export const TEXT = "审核此固定文本：不要读取项目。"

export function candidate(endpoint = "https://api.openai.com/v1/responses") {
  // All identities/counts here are CONTROLLED fixture facts, not approval of any real model.
  const runtime: WorkRoutePolicy.Runtime = {
    providerID: "openai",
    routeID: "openai-responses",
    modelID: "fixture-immutable-model",
    modelRevision: "fixture-deployment-revision-1",
    protocol: "openai-responses",
    transport: "http-json",
    configurationHash: Hash.sha256(endpoint),
    adapterHash: Hash.sha256("fixture-installed-adapter"),
    loweringHash: Hash.sha256("fixture-installed-lowering"),
    framingHash: Hash.sha256("fixture-installed-framing"),
  }
  const original: Omit<WorkRoutePolicy.RouteEvidence, "projectionHash"> = {
    version: "native-route-evidence.v2",
    approvedRouteID: "approved-fixture-route-identity",
    approvalEvidenceHash: Hash.sha256("authenticated-fixture-approval"),
    credentialGeneration: 1,
    credentialFingerprint: Hash.sha256("fixture-credential"),
    nonsecretHeadersHash: Hash.sha256("fixture-headers"),
    configuredTargetStamp: Hash.sha256("fixture-configured-target"),
    id: "approved-fixture-route",
    revision: 1,
    state: "active",
    expiresAt: Date.now() + 120_000,
    endpoint,
    runtime,
    completion: {
      contractID: "fixture-completion-contract",
      contractHash: Hash.sha256("fixture-completion-contract-content"),
      parameter: "max_output_tokens",
      accounting: "all_generated_including_reasoning_and_framing",
      maxTokens: 64,
    },
    counter: {
      id: "fixture-exact-counter",
      revision: 1,
      endpoint: `${endpoint}/input_tokens`,
      tokenizerIdentity: "fixture-provider-tokenizer-revision-1",
      framingIdentity: "fixture-provider-framing-revision-1",
      contractHash: Hash.sha256("fixture-count-contract-content"),
      semantics: "exact_model_input_including_framing",
    },
  }
  const evidence: WorkRoutePolicy.RouteEvidence = { ...original, projectionHash: WorkRoutePolicy.fingerprint(original) }
  const base = WorkAuthorityFixture.binding("wire-policy")
  const binding: WorkAuthoritySchema.Binding = {
    ...base,
    provider: {
      ...base.provider,
      providerID: runtime.providerID,
      modelID: runtime.modelID,
      routeID: evidence.approvedRouteID,
      protocol: runtime.protocol,
      endpoint,
      configurationHash: runtime.configurationHash,
      evidenceID: evidence.id,
      evidenceHash: evidence.approvalEvidenceHash,
      completion: { parameter: "max_output_tokens", hardLimit: true, includesReasoning: true, maxTokens: 64 },
    },
    budget: { ...base.budget, maxCompletionTokens: 64 },
    deadline: Date.now() + 120_000,
    auditedText: { hash: Hash.sha256(TEXT), utf8Bytes: Buffer.byteLength(TEXT), snapshotRef: "audited://fixture" },
  }
  const request = LLM.request({
    model: OpenAIResponses.route
      .with({ endpoint: { baseURL: endpoint.slice(0, -"/responses".length) } })
      .model({ id: runtime.modelID }),
    system: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.instructions,
    prompt: TEXT,
    generation: { maxTokens: 32 },
    providerOptions: { openai: { store: false } },
  })
  return { binding, runtime, evidence, request }
}

/** Real protocol lowering and real HTTP overlay preparation; no hand-copied encoder. */
export const encoded = (request: ReturnType<typeof LLM.request>) =>
  Effect.gen(function* () {
    const body = yield* OpenAIResponses.route.body
      .from(request)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(OpenAIResponses.route.body.schema)))
    const prepared = yield* OpenAIResponses.httpTransport.prepare({
      body,
      request,
      endpoint: request.model.route.endpoint,
      auth: request.model.route.auth,
      encodeBody: JSON.stringify,
    })
    if (prepared.request.body._tag !== "Uint8Array") return yield* Effect.die("Expected actual encoded JSON bytes")
    const url = Option.getOrThrow(HttpClientRequest.toUrl(prepared.request)).href
    return wire(new TextDecoder().decode(prepared.request.body.body), url)
  })

export function wire(bodyText: string, url = "https://api.openai.com/v1/responses") {
  return {
    method: "POST",
    url,
    bodyText,
    contentType: "application/json",
    bodyLength: Buffer.byteLength(bodyText),
    bodyHash: Hash.sha256(bodyText),
    wireHash: RequestExecutor.wireRequestHash({ method: "POST", url, contentType: "application/json", bodyText }),
  }
}

export function receipt(input: WorkRoutePolicy.Input, evidence: WorkRoutePolicy.RouteEvidence, tokens = 41) {
  const inspected = WorkRoutePolicy.inspect(input, { allowLoopbackHTTP: true })
  if (!inspected.ok) throw inspected.error
  if (!input.dispatch) throw new Error("Fixture count requires the actual dispatch identity")
  const proof: WorkRoutePolicy.CountReceipt = {
    version: "native-count-receipt.v2",
    binding: WorkRoutePolicy.countBinding(input.dispatch, evidence, inspected.value),
    acquisitionRevision: 3,
    recordHash: Hash.sha256("controlled-persisted-count-record"),
    id: "fixture-persisted-counter-receipt",
    routeEvidenceID: evidence.id,
    routeRevision: evidence.revision,
    routeHash: WorkRoutePolicy.fingerprint(evidence),
    configurationHash: evidence.runtime.configurationHash,
    modelID: evidence.runtime.modelID,
    modelRevision: evidence.runtime.modelRevision,
    counterID: evidence.counter.id,
    counterRevision: evidence.counter.revision,
    counterEndpoint: evidence.counter.endpoint,
    tokenizerIdentity: evidence.counter.tokenizerIdentity,
    framingIdentity: evidence.counter.framingIdentity,
    counterContractHash: evidence.counter.contractHash,
    inputTupleHash: inspected.value.inputTupleHash,
    bodyHash: inspected.value.bodyHash,
    wireHash: inspected.value.wireHash,
    responseHash: Hash.sha256(JSON.stringify({ object: "response.input_tokens", input_tokens: tokens })),
    tokens,
    countedAt: Date.now(),
    expiresAt: Date.now() + 120_000,
  }
  return proof
}

/** Real current SQL evidence for a NEW controlled counter fixture response. Never repairs an
 * existing partial count record; production projections authenticate their original MAC row. */
export const dispatch = (db: Database.Interface["db"], workID: string, receiptID: string) => Effect.gen(function* () {
  const work = yield* db.select().from(WorkExecutionTable).where(eq(WorkExecutionTable.work_id, workID)).get()
  const receipt = yield* db.select().from(V2ProviderTurnReceiptTable).where(eq(V2ProviderTurnReceiptTable.receipt_id, receiptID)).get()
  const attempt = receipt?.provider_attempt_id
    ? yield* db.select().from(SessionProviderAttemptTable).where(eq(SessionProviderAttemptTable.attempt_id, receipt.provider_attempt_id)).get()
    : undefined
  if (!work || !receipt || !attempt) return yield* Effect.die("Fixture count identity was requested before actual canonical preparation")
  return {
    workID: work.work_id, inputID: work.input_id, sessionID: work.session_id, bindingHash: work.binding_hash,
    controlRevision: work.control_revision, sourceAuthorityID: work.authority_id,
    sourceRevision: work.source_revision, sourceRecordHash: work.source_record_hash,
    providerReceiptID: receipt.receipt_id, providerAttemptID: attempt.attempt_id,
    sessionClaimToken: attempt.execution_claim_token, providerOwnerToken: receipt.owner_token,
  }
})

export function authority(state: {
  evidence: WorkRoutePolicy.RouteEvidence
  receipt?: WorkRoutePolicy.CountReceipt
  afterRead?: () => void
}) {
  return Layer.succeed(WorkRoutePolicy.Evidence, {
    resolve: (id) =>
      id === state.evidence.id
        ? Effect.succeed(state.evidence)
        : Effect.fail(new WorkAuthoritySchema.Error({ code: "PROFILE_UNAVAILABLE", message: "No approved route" })),
    readCount: () =>
      Effect.gen(function* () {
        state.afterRead?.()
        if (!state.receipt)
          return yield* new WorkAuthoritySchema.Error({ code: "PROFILE_UNAVAILABLE", message: "No count receipt" })
        return state.receipt
      }),
  })
}
