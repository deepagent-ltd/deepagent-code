export * as WorkRoutePolicy from "./work-route-policy"

import { RequestExecutor } from "@deepagent-code/llm/route"
import { Clock, Context, Effect, Option, Schema } from "effect"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { WorkAuthorityPolicy } from "./work-authority-policy"
import { WorkAuthoritySchema } from "./work-authority.schema"
import { WorkCountAcquisitionSchema } from "./work-count-acquisition.schema"
import { WorkCountAcquisition } from "./work-count-acquisition"

// Candidate only: no production resolver or counter is installed by this module.
// OpenAI documents exact input counts INCLUDING framing, and an output cap including reasoning:
// https://developers.openai.com/api/docs/guides/token-counting
// https://developers.openai.com/api/reference/python/resources/responses/methods/create
// Anthropic's count API explicitly returns an estimate; it is not accepted as a hard bound here.
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Revision = Count.check(Schema.isGreaterThanOrEqualTo(1))
const Digest = WorkAuthoritySchema.Digest
export const Runtime = Schema.Struct({
  providerID: Text,
  routeID: Text,
  modelID: Text,
  // Supplied from the actual approved deployment, never inferred from a model name/date suffix.
  modelRevision: Text,
  protocol: Schema.Literal("openai-responses"),
  transport: Schema.Literal("http-json"),
  configurationHash: Digest,
  adapterHash: Digest,
  loweringHash: Digest,
  framingHash: Digest,
})
export type Runtime = typeof Runtime.Type

export const RouteEvidence = Schema.Struct({
  version: Schema.Literal("native-route-evidence.v2"),
  approvedRouteID: Text,
  approvalEvidenceHash: Digest,
  projectionHash: Digest,
  credentialGeneration: Revision,
  credentialFingerprint: Digest,
  nonsecretHeadersHash: Digest,
  configuredTargetStamp: Digest,
  id: Text,
  revision: Revision,
  state: Schema.Literals(["active", "revoked"]),
  expiresAt: Revision,
  endpoint: Text,
  runtime: Runtime,
  completion: Schema.Struct({
    contractID: Text,
    contractHash: Digest,
    parameter: Schema.Literal("max_output_tokens"),
    accounting: Schema.Literal("all_generated_including_reasoning_and_framing"),
    maxTokens: Revision,
  }),
  counter: Schema.Struct({
    id: Text,
    revision: Revision,
    endpoint: Text,
    // Provider-owned tokenizer and prompt framing are opaque. Pin their approved deployment
    // identity; an alias that can drift between count and generation cannot supply this proof.
    tokenizerIdentity: Text,
    framingIdentity: Text,
    contractHash: Digest,
    semantics: Schema.Literals(["exact_model_input_including_framing", "vendor_context_input_upper_bound"]),
    inputUpperBoundTokens: Schema.optional(Schema.Literal(1_048_576)),
  }),
})
export type RouteEvidence = typeof RouteEvidence.Type

export const CountReceipt = Schema.Struct({
  version: Schema.Literal("native-count-receipt.v2"),
  binding: WorkCountAcquisitionSchema.Binding,
  acquisitionRevision: Revision,
  recordHash: Digest,
  id: Text,
  routeEvidenceID: Text,
  routeRevision: Revision,
  routeHash: Digest,
  configurationHash: Digest,
  modelID: Text,
  modelRevision: Text,
  counterID: Text,
  counterRevision: Revision,
  counterEndpoint: Text,
  tokenizerIdentity: Text,
  framingIdentity: Text,
  counterContractHash: Digest,
  inputTupleHash: Digest,
  bodyHash: Digest,
  wireHash: Digest,
  responseHash: Digest,
  tokens: Count,
  countedAt: Count,
  expiresAt: Revision,
})
export type CountReceipt = typeof CountReceipt.Type
export const ProjectCountReceipt = Schema.Struct({ ...CountReceipt.fields,
  version: Schema.Literal("native-project-count-receipt.v1"), binding: WorkCountAcquisitionSchema.ProjectBinding })
export type ProjectCountReceipt = typeof ProjectCountReceipt.Type

export interface Interface {
  /** Read current independently approved evidence. Binding fields/hash/booleans are not evidence.
   * Must establish an immutable modelID -> deployment revision mapping for the receipt lifetime,
   * and actual installed component identities. An unproven alias must remain unavailable. */
  readonly resolve: (id: string) => Effect.Effect<RouteEvidence, WorkAuthoritySchema.Error>
  /** Read an authenticated, persisted count receipt. No network inside the dispatch transaction.
   * Acquisition must separately authorize text disclosure, pin endpoint/model, and bound its
   * deadline/retries. This seam must not manufacture a receipt from the requested hashes. */
  readonly readCount: (input: {
    readonly routeEvidenceID: string
    readonly routeRevision: number
    readonly inputTupleHash: string
    readonly bodyHash: string
    readonly wireHash: string
    readonly dispatch: DispatchIdentity
  }) => Effect.Effect<CountReceipt | ProjectCountReceipt, WorkAuthoritySchema.Error>
}
export class Evidence extends Context.Service<Evidence, Interface>()("@deepagent-code/WorkRouteEvidence") {}

const Body = Schema.Struct({
  model: Text,
  input: Schema.Tuple([
    Schema.Struct({
      role: Schema.Literal("system"),
      content: Schema.Literal(WorkAuthorityPolicy.TEXT_ONLY_PROFILE.instructions),
    }),
    Schema.Struct({
      role: Schema.Literal("user"),
      content: Schema.Tuple([Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })]),
    }),
  ]),
  stream: Schema.Literal(true),
  store: Schema.Literal(false),
  max_output_tokens: Count,
})
const ProjectBody = Schema.Struct({
  model: Text, input: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1024)),
  tools: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.Literal("function"), name: Text,
    description: Schema.optional(Schema.String), parameters: Schema.Record(Schema.String, Schema.Unknown),
    strict: Schema.optional(Schema.Boolean) })).check(Schema.isMaxLength(128))),
  tool_choice: Schema.optional(Schema.Literals(["auto", "none"])),
  reasoning: Schema.optional(Schema.Struct({ effort: Schema.optional(Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"])),
    summary: Schema.optional(Schema.Literal("auto")) })),
  temperature: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2))),
  top_p: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))),
  stream: Schema.Literal(true), store: Schema.Literal(false), max_output_tokens: Count,
})

export type DispatchIdentity = Pick<WorkCountAcquisitionSchema.Binding,
  "workID" | "inputID" | "sessionID" | "bindingHash" | "controlRevision" |
  "sourceAuthorityID" | "sourceRevision" | "sourceRecordHash" | "providerReceiptID" |
  "providerAttemptID" | "sessionClaimToken" | "providerOwnerToken"> & {
    readonly project?: Pick<WorkCountAcquisitionSchema.ProjectBinding, "rootWorkID" | "turn" | "predecessor" | "toolAdvertisementHash">
  }

export interface Input {
  readonly binding: WorkAuthoritySchema.Binding
  readonly auditedText: string
  readonly runtime: Runtime
  readonly wire: RequestExecutor.RequestSealInput
  /** Required at dispatch; pure inspection/count disclosure can precede the owned attempt lookup. */
  readonly dispatch?: DispatchIdentity
}

/** Pure shape/hash inspection. Success is explicitly NOT authority or a dispatch permit.
 * Strict JSON round-trip also rejects duplicate keys and ambiguous encodings. The one accepted
 * shape is produced by the actual Responses encoder with store:false and no extra options. */
export function inspect(input: Input, options: { allowLoopbackHTTP?: boolean } = {}) {
  const binding = WorkAuthorityPolicy.validateBinding(input.binding, options)
  if (!binding.ok) return binding
  const profile = WorkAuthorityPolicy.profileFor(binding.value.profile)
  if (!profile) return refused("PROFILE_UNAVAILABLE", "Final instructions require the verified execution profile")
  const audited = WorkAuthorityPolicy.checkAuditedText(binding.value, input.auditedText)
  if (!audited.ok) return audited
  const wire = input.wire
  if (
    wire.method !== "POST" ||
    wire.contentType !== "application/json" ||
    wire.bodyText === undefined ||
    Buffer.byteLength(wire.bodyText, "utf8") > 524_288 ||
    wire.bodyLength !== Buffer.byteLength(wire.bodyText, "utf8") ||
    wire.bodyHash !== Hash.sha256(wire.bodyText)
  )
    return refused("WORK_INVALID_REQUEST", "Final HTTP method, content type or body digest is invalid")
  if (wire.url !== binding.value.provider.endpoint || !candidateEndpoint(wire.url, options))
    return refused("WORK_ENDPOINT_DENIED", "The final endpoint is outside the approved Responses candidate")
  if (
    wire.wireHash !==
    RequestExecutor.wireRequestHash({
      method: wire.method,
      url: wire.url,
      contentType: wire.contentType,
      bodyText: wire.bodyText,
    })
  )
    return refused("WORK_BINDING_CONFLICT", "Final HTTP wire digest does not match its encoded bytes")
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(wire.bodyText)
  if (Option.isNone(parsed) || JSON.stringify(parsed.value) !== wire.bodyText)
    return refused("WORK_INVALID_REQUEST", "Final body must use unambiguous encoded JSON")
  const body: Option.Option<typeof Body.Type | typeof ProjectBody.Type> = binding.value.schemaVersion === "work-execution.v2"
    ? Schema.decodeUnknownOption(ProjectBody, { onExcessProperty: "error" })(parsed.value)
    : Schema.decodeUnknownOption(Body, { onExcessProperty: "error" })(parsed.value)
  if (Option.isNone(body))
    return refused("WORK_CEILING_VIOLATION", "Final body contains unsupported context, tools or provider options")
  const prefix = [
    { role: "system", content: profile.instructions },
    { role: "user", content: [{ type: "input_text", text: input.auditedText }] },
  ]
  if (body.value.model !== binding.value.provider.modelID ||
    CanonicalJson.stringify(body.value.input.slice(0, 2)) !== CanonicalJson.stringify(prefix))
    return refused("WORK_BINDING_CONFLICT", "Final model or input differs from the audited binding")
  if (binding.value.schemaVersion === "work-execution.v2") {
    const project = Schema.decodeUnknownOption(ProjectBody, { onExcessProperty: "error" })(parsed.value)
    if (Option.isNone(project)) return refused("WORK_CEILING_VIOLATION", "Project options are unavailable")
    const names = (project.value.tools ?? []).map((tool) => tool.name)
    const capabilities = binding.value.toolPolicy.capabilities
    if (new Set(names).size !== names.length || names.some((name) => !capabilities.some((tool) => tool.toolID === name)))
      return refused("WORK_CEILING_VIOLATION", "Project tool advertisement exceeds the explicit capability set")
    // No provider-side retrieval, item references, hosted execution or additional user/system
    // context. The native client separately proves exact equality with the one real lowering.
    const historyItem = Schema.Union([
      Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.Array(Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String })) }),
      Schema.Struct({ type: Schema.Literal("function_call"), call_id: Text, name: Text, arguments: Schema.String }),
      Schema.Struct({ type: Schema.Literal("function_call_output"), call_id: Text, output: Schema.String }),
    ])
    if (project.value.input.slice(2).some((item) => Option.isNone(Schema.decodeUnknownOption(historyItem, { onExcessProperty: "error" })(item))))
      return refused("WORK_CEILING_VIOLATION", "Project history contains unsupported provider context")
  }
  if (body.value.max_output_tokens < 16)
    return refused("PROFILE_UNAVAILABLE", "Responses requires at least 16 output tokens; the grant is never enlarged")
  if (body.value.max_output_tokens > binding.value.budget.maxCompletionTokens)
    return refused("WORK_CEILING_VIOLATION", "Final completion cap exceeds the granted budget")
  if (
    !Schema.is(Runtime)(input.runtime) ||
    input.runtime.providerID !== binding.value.provider.providerID ||
    input.runtime.modelID !== body.value.model ||
    input.runtime.protocol !== binding.value.provider.protocol ||
    input.runtime.configurationHash !== binding.value.provider.configurationHash
  )
    return refused("PROFILE_UNAVAILABLE", "Observed runtime differs from the pinned route")
  const projected = RequestExecutor.responsesCountInput(wire.bodyText)
  if (Option.isNone(projected)) return refused("WORK_CEILING_VIOLATION", "The complete input projection is unavailable")
  const countBody = binding.value.schemaVersion === "work-execution.v2" ? projected.value
    : { model: body.value.model, input: body.value.input }
  return {
    ok: true as const,
    authorization: "not_checked" as const,
    value: {
      endpoint: wire.url,
      countBody,
      inputTupleHash: Hash.sha256(CanonicalJson.stringify(countBody)),
      bodyHash: wire.bodyHash,
      wireHash: wire.wireHash,
      completionTokens: body.value.max_output_tokens,
      toolAdvertisementHash: Hash.sha256(CanonicalJson.stringify("tools" in body.value ? body.value.tools ?? [] : [])),
    },
  }
}

/** Candidate hook for the MAIN runner's final seal. A successful check still requires the
 * existing Work source/revision/budget CAS and durable wire seal in the same dispatch boundary.
 * It does not wake, reserve, send a count request, execute a provider or settle any receipt. */
export const verify = Effect.fn("WorkRoutePolicy.verify")(function* (
  input: Input,
  options: { allowLoopbackHTTP?: boolean } = {},
) {
  const service = yield* Effect.serviceOption(Evidence)
  if (Option.isNone(service))
    return yield* failure("PROFILE_UNAVAILABLE", "Trusted route and counter evidence are not installed")
  if ((yield* RequestExecutor.CurrentRetryLimit) !== 0 || (yield* RequestExecutor.CurrentRedirectPolicy) !== "manual")
    return yield* failure("PROFILE_UNAVAILABLE", "Final executor must disable retries and redirects")
  const inspected = inspect(input, options)
  if (!inspected.ok) return yield* inspected.error
  const route = yield* service.value.resolve(input.binding.provider.evidenceID)
  const now = yield* Clock.currentTimeMillis
  const checked = checkEvidence(input, route, now)
  if (!checked.ok) return yield* checked.error
  if (!input.dispatch) return yield* failure("PROFILE_UNAVAILABLE", "Owned count dispatch identity is missing")
  const receipt = yield* service.value.readCount({
    routeEvidenceID: route.id,
    routeRevision: route.revision,
    dispatch: input.dispatch,
    inputTupleHash: inspected.value.inputTupleHash,
    bodyHash: inspected.value.bodyHash,
    wireHash: inspected.value.wireHash,
  })
  const current = yield* service.value.resolve(route.id)
  const finalNow = yield* Clock.currentTimeMillis
  const rechecked = checkEvidence(input, current, finalNow)
  if (!rechecked.ok) return yield* rechecked.error
  if (
    fingerprint(current) !== fingerprint(route) ||
    !(input.binding.schemaVersion === "work-execution.v2" ? Schema.is(ProjectCountReceipt)(receipt) : Schema.is(CountReceipt)(receipt)) ||
    CanonicalJson.stringify(receipt.binding) !== CanonicalJson.stringify(input.binding.schemaVersion === "work-execution.v2"
      ? projectCountBinding(input.dispatch, route, inspected.value) : countBinding(input.dispatch, route, inspected.value)) ||
    receipt.routeEvidenceID !== route.id ||
    receipt.routeRevision !== route.revision ||
    receipt.routeHash !== fingerprint(route) ||
    receipt.configurationHash !== route.runtime.configurationHash ||
    receipt.modelID !== route.runtime.modelID ||
    receipt.modelRevision !== route.runtime.modelRevision ||
    receipt.counterID !== route.counter.id ||
    receipt.counterRevision !== route.counter.revision ||
    receipt.counterEndpoint !== route.counter.endpoint ||
    receipt.tokenizerIdentity !== route.counter.tokenizerIdentity ||
    receipt.framingIdentity !== route.counter.framingIdentity ||
    receipt.counterContractHash !== route.counter.contractHash ||
    (route.counter.semantics === "vendor_context_input_upper_bound" && receipt.tokens !== route.counter.inputUpperBoundTokens) ||
    receipt.inputTupleHash !== inspected.value.inputTupleHash ||
    receipt.bodyHash !== inspected.value.bodyHash ||
    receipt.wireHash !== inspected.value.wireHash ||
    receipt.countedAt > finalNow ||
    receipt.expiresAt <= finalNow ||
    receipt.expiresAt <= receipt.countedAt
  )
    return yield* failure(
      "PROFILE_UNAVAILABLE",
      "Exact input-count evidence is missing, stale or belongs to another request",
    )
  const inputBound: WorkAuthoritySchema.InputBound = {
    kind: route.counter.semantics === "vendor_context_input_upper_bound" ? "conservative" : "exact",
    tokens: receipt.tokens,
    evidenceID: receipt.id,
    evidenceHash: Hash.sha256(CanonicalJson.stringify(receipt)),
  }
  const reservation = WorkAuthorityPolicy.providerReservation(
    input.binding.budget,
    inputBound,
    inspected.value.completionTokens,
  )
  if (!reservation.ok) return yield* reservation.error
  return {
    bodyHash: inspected.value.bodyHash,
    wireHash: inspected.value.wireHash,
    inputTupleHash: inspected.value.inputTupleHash,
    routeEvidenceID: route.id,
    routeRevision: route.revision,
    routeHash: fingerprint(route),
    inputBound,
    completionTokens: inspected.value.completionTokens,
    totalTokens: reservation.value.totalTokens,
  }
})

/** Authorize disclosure to the exact approved counter before acquisition. This is NOT a provider
 * permit or token bound; final seal must re-read the persisted count and current route itself. */
export const authorizeCount = Effect.fn("WorkRoutePolicy.authorizeCount")(function* (
  input: Input,
  options: { allowLoopbackHTTP?: boolean } = {},
) {
  const installed = yield* Effect.serviceOption(Evidence)
  if (Option.isNone(installed))
    return yield* failure("PROFILE_UNAVAILABLE", "Trusted count disclosure authority is not installed")
  if ((yield* RequestExecutor.CurrentRetryLimit) !== 0 || (yield* RequestExecutor.CurrentRedirectPolicy) !== "manual")
    return yield* failure("PROFILE_UNAVAILABLE", "Count acquisition requires the restricted executor policy")
  const inspected = inspect(input, options)
  if (!inspected.ok) return yield* inspected.error
  const route = yield* installed.value.resolve(input.binding.provider.evidenceID)
  const checked = checkEvidence(input, route, yield* Clock.currentTimeMillis)
  if (!checked.ok) return yield* checked.error
  return { route, inspected: inspected.value }
})

/** Reproducible identity only. Hashing an object does not approve or authenticate its contents. */
export const fingerprint = (evidence: Omit<RouteEvidence, "projectionHash"> | RouteEvidence) =>
  Hash.sha256(CanonicalJson.stringify(Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "projectionHash"))))

/** Deterministic expectation, not authority. The host reader must authenticate the physical
 * record and derive its projection before this exact owned-tuple comparison is meaningful. */
export function countBinding(dispatch: DispatchIdentity, route: RouteEvidence, wire: {
  inputTupleHash: string; countBody: unknown; bodyHash: string; wireHash: string
}): WorkCountAcquisitionSchema.Binding {
  const { project, ...identity } = dispatch
  const value = {
    ...identity,
    approvalID: route.id, approvalRevision: route.revision, approvalEvidenceHash: route.approvalEvidenceHash,
    configurationStamp: route.runtime.configurationHash, credentialFingerprint: route.credentialFingerprint,
    credentialGeneration: route.credentialGeneration, inputTupleHash: wire.inputTupleHash,
    countBodyHash: Hash.sha256(JSON.stringify(wire.countBody)), generationBodyHash: wire.bodyHash,
    wireHash: wire.wireHash, nonsecretHeadersHash: route.nonsecretHeadersHash,
  }
  return { ...value, sealedRequestHash: WorkCountAcquisition.sealedRequestHash(value) }
}

export function projectCountBinding(dispatch: DispatchIdentity, route: RouteEvidence, wire: {
  inputTupleHash: string; countBody: unknown; bodyHash: string; wireHash: string; toolAdvertisementHash: string
}): WorkCountAcquisitionSchema.ProjectBinding | undefined {
  if (!dispatch.project || dispatch.project.toolAdvertisementHash !== wire.toolAdvertisementHash) return undefined
  const common = { ...countBinding(dispatch, route, wire), ...dispatch.project, inputProjectionHash: wire.inputTupleHash }
  if (route.counter.semantics === "vendor_context_input_upper_bound")
    return { ...common, inputProjectionVersion: "deepseek-responses-project-context-bound.v1",
      counterSemantics: "vendor_context_input_upper_bound", inputUpperBoundTokens: 1_048_576 }
  return { ...common, inputProjectionVersion: "openai-responses-project-input.v1" }
}

function candidateEndpoint(endpoint: string, options: { allowLoopbackHTTP?: boolean }) {
  if (endpoint === "https://api.openai.com/v1/responses") return true
  if (endpoint === "https://api.deepseek.com/responses") return true
  if (!options.allowLoopbackHTTP || !URL.canParse(endpoint)) return false
  const url = new URL(endpoint)
  return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/v1/responses"
}

function checkEvidence(input: Input, evidence: RouteEvidence, now: number) {
  if (input.binding.deadline <= now)
    return refused("WORK_EXPIRED", "Work deadline expired before final wire validation")
  if (
    !Schema.is(RouteEvidence)(evidence) ||
    evidence.state !== "active" ||
    evidence.expiresAt <= now ||
    evidence.id !== input.binding.provider.evidenceID ||
    evidence.projectionHash !== fingerprint(evidence) ||
    evidence.approvalEvidenceHash !== input.binding.provider.evidenceHash ||
    evidence.approvedRouteID !== input.binding.provider.routeID ||
    evidence.endpoint !== input.binding.provider.endpoint ||
    CanonicalJson.stringify(evidence.runtime) !== CanonicalJson.stringify(input.runtime) ||
    (evidence.counter.semantics === "vendor_context_input_upper_bound"
      ? evidence.runtime.providerID !== "deepseek" || evidence.runtime.modelID !== "deepseek-flash" ||
        evidence.endpoint !== "https://api.deepseek.com/responses" ||
        evidence.counter.endpoint !== "dac-local://deepseek/flash/context-upper-bound-v1" ||
        evidence.counter.inputUpperBoundTokens !== 1_048_576 ||
        !WorkAuthorityPolicy.hasContextBoundProfile(input.binding.profile)
      : evidence.counter.inputUpperBoundTokens !== undefined ||
        evidence.counter.endpoint !== `${evidence.endpoint}/input_tokens`) ||
    input.binding.provider.completion.parameter !== evidence.completion.parameter ||
    input.binding.budget.maxCompletionTokens > evidence.completion.maxTokens
  )
    return refused(
      "PROFILE_UNAVAILABLE",
      "Current route approval does not establish this deployment's completion and count contracts",
    )
  return { ok: true as const }
}

function failure(code: WorkAuthoritySchema.ErrorCode, message: string) {
  return new WorkAuthoritySchema.Error({ code, message })
}
function refused(code: WorkAuthoritySchema.ErrorCode, message: string) {
  return { ok: false as const, error: failure(code, message) }
}
