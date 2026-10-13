import { createHmac, timingSafeEqual } from "node:crypto"
import { Context, Effect, Layer, Option, Schema, Scope } from "effect"
import type { LLMRequest } from "@deepagent-code/llm"
import type { RequestExecutor } from "@deepagent-code/llm/route"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { WorkRouteApproval } from "@deepagent-code/core/session/work-route-approval"
import { WorkRouteApprovalSchema } from "@deepagent-code/core/session/work-route-approval.schema"
import { LocalAuthority } from "@/installation/local-authority"
import { NativeRuntime } from "./native-runtime"
import { WorkCountAcquisition } from "@deepagent-code/core/session/work-count-acquisition"
import { WorkCountAcquisitionSchema } from "@deepagent-code/core/session/work-count-acquisition.schema"
import { Hash } from "@deepagent-code/core/util/hash"

/** Installed provider contracts are independent evidence. No default resolver; a CLI snapshot
 * string, model name, API response or caller hash cannot install one. */
export class Contract extends Context.Service<
  Contract,
  {
    readonly resolve: (
      actual: NativeRuntime.CredentialDescription,
      input: { snapshot: string; expiresAt: number },
    ) => Effect.Effect<
      {
        readonly modelRevision: string
        readonly counterEndpoint: string
        readonly contractID: string
        readonly contractHash: string
        readonly tokenizerIdentity: string
        readonly completionLimit: number
        readonly factoryHash: string
        readonly adapterHash: string
        readonly loweringHash: string
        readonly framingHash: string
        readonly counterSemantics?: "vendor_context_input_upper_bound"
        readonly inputUpperBoundTokens?: 1_048_576
      },
      WorkRouteApprovalSchema.Error
    >
  }
>()("@deepagent-code/ProviderCredentialBinding/Contract") {}
declare const captured: unique symbol
export interface Capture {
  readonly [captured]: true
}
export interface Interface {
  readonly captureNative: (input: {
    runtime: NativeRuntime.ApprovedRuntime
    request: LLMRequest
    observation: RequestExecutor.RequestSealInput
    scope: WorkRouteApprovalSchema.Scope
    snapshot: string
    expiresAt: number
  }) => Effect.Effect<Capture, WorkRouteApprovalSchema.Error, Scope.Scope>
  readonly authority: Context.Service.Shape<typeof WorkRouteApproval.Authority>
  readonly countAuthority: Context.Service.Shape<typeof WorkCountAcquisition.Authority>
  readonly bindCount: (capture: Capture, binding: WorkCountAcquisitionSchema.Binding) => Effect.Effect<void, WorkCountAcquisitionSchema.Error, Scope.Scope>
  readonly bindProjectCount: (capture: Capture, binding: WorkCountAcquisitionSchema.ProjectBinding) => Effect.Effect<void, WorkCountAcquisitionSchema.Error, Scope.Scope>
  readonly count: (capture: Capture, deadline: number) => Effect.Effect<{
    readonly inputTokens: number; readonly responseHash: string; readonly countBodyHash: string; readonly countedAt: number
  }, WorkCountAcquisitionSchema.Error>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ProviderCredentialBinding") {}

/** Constructor-only dependency for the fixed offline factory. Its load Effect closes over the
 * original host Context and Scope; invocation context cannot replace native construction. */
export class NativeFactory extends Context.Service<NativeFactory, {
  readonly load: Effect.Effect<{
    readonly runtime: NativeRuntime.Interface
    readonly contract: Context.Service.Shape<typeof Contract>
  }, WorkRouteApprovalSchema.Error>
}>()("@deepagent-code/ProviderCredentialBinding/NativeFactory") {}

/** Explicit offline caller only. This layer does not install WorkRoutePolicy, WorkExecutionProfile
 * or a network counter. Fixed record authentication is not a generic payload signing endpoint. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const installation = yield* LocalAuthority.readInstallation.pipe(
      Effect.mapError(() => WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")),
    )
    const runtime = yield* Effect.serviceOption(NativeRuntime.Service)
    const contract = yield* Effect.serviceOption(Contract)
    const factory = yield* Effect.serviceOption(NativeFactory)
    const captures = new WeakMap<
      object,
      { native: NativeRuntime.CredentialCapture; runtime: NativeRuntime.Interface; evidence: WorkRouteApprovalSchema.Evidence; observation: RequestExecutor.RequestSealInput }
    >()
    const live = new Set<object>()
    const countBindings = new Map<string, Capture>()
    const countHash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
    const requireCountCapture = Effect.fn("ProviderCredentialBinding.requireCountCapture")(function* (binding: WorkCountAcquisitionSchema.Binding | WorkCountAcquisitionSchema.ProjectBinding) {
      const capture = countBindings.get(countHash(binding))
      const entry = capture ? captures.get(capture) : undefined
      if (!entry) return yield* WorkCountAcquisition.failure("COUNT_UNAVAILABLE")
      const actual = yield* entry.runtime.credential(entry.native).pipe(Effect.mapError(() => WorkCountAcquisition.failure("COUNT_UNAVAILABLE")))
      if (actual.configurationStamp !== binding.configurationStamp || actual.credentialFingerprint !== binding.credentialFingerprint ||
        actual.nonsecretHeadersHash !== binding.nonsecretHeadersHash || entry.observation.bodyHash !== binding.generationBodyHash ||
        entry.observation.wireHash !== binding.wireHash || entry.evidence.configurationStamp !== binding.configurationStamp)
        return yield* WorkCountAcquisition.failure("COUNT_BINDING_CONFLICT")
    })
    const countMac = (record: WorkCountAcquisitionSchema.Record | WorkCountAcquisitionSchema.ProjectRecord) => createHmac("sha256", Buffer.from(installation.secret, "hex"))
      .update(record.version === 1 ? "dac.work-count-acquisition.record.v1\0" : "dac.work-count-acquisition.record.v2\0")
      .update(CanonicalJson.stringify([installation.instanceID, record])).digest("hex")
    const validateCount = (record: WorkCountAcquisitionSchema.Record) => Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(WorkCountAcquisitionSchema.Record, { onExcessProperty: "error" })(record)
      if (Option.isNone(decoded) || Buffer.byteLength(CanonicalJson.stringify(record)) > WorkCountAcquisitionSchema.MAX_RECORD_BYTES)
        return yield* WorkCountAcquisition.failure("COUNT_INVALID_RECORD")
    })
    const validateProjectCount = (record: WorkCountAcquisitionSchema.ProjectRecord) => Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(WorkCountAcquisitionSchema.ProjectRecord, { onExcessProperty: "error" })(record)
      if (Option.isNone(decoded) || Buffer.byteLength(CanonicalJson.stringify(record)) > WorkCountAcquisitionSchema.MAX_RECORD_BYTES)
        return yield* WorkCountAcquisition.failure("COUNT_INVALID_RECORD")
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        live.forEach((capture) => captures.delete(capture))
        live.clear()
        countBindings.clear()
      }),
    )
    const mac = (record: WorkRouteApprovalSchema.Record) =>
      createHmac("sha256", Buffer.from(installation.secret, "hex"))
        .update("dac.work-route-approval.record.v1\0")
        .update(
          CanonicalJson.stringify([
            installation.instanceID,
            record.evidence.securityNamespaceID,
            record.evidence.operatorID,
            record.evidence.targetID,
            record,
          ]),
        )
        .digest("hex")
    const validate = (record: WorkRouteApprovalSchema.Record) =>
      Effect.gen(function* () {
        yield* WorkRouteApproval.decode(WorkRouteApprovalSchema.Record, record)
        if (
          record.evidence.instanceID !== installation.instanceID ||
          Buffer.byteLength(CanonicalJson.stringify(record), "utf8") > WorkRouteApprovalSchema.MAX_RECORD_BYTES
        )
          return yield* WorkRouteApproval.failure("ROUTE_INVALID_RECORD")
      })
    return Service.of({
      captureNative: Effect.fn("ProviderCredentialBinding.captureNative")(function* (input) {
        // The offline factory is lazy so historical retries perform no model/config/build work.
        // Production roots capture these services at construction; a later caller cannot replace them.
        const installed = Option.isSome(runtime) && Option.isSome(contract)
          ? { runtime: runtime.value, contract: contract.value }
          : Option.isSome(factory) ? yield* factory.value.load : undefined
        if (!installed) return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
        if (live.size >= 32) return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
        yield* WorkRouteApproval.decode(WorkRouteApprovalSchema.Scope, input.scope)
        yield* WorkRouteApproval.decode(WorkRouteApprovalSchema.Text, input.snapshot)
        yield* WorkRouteApproval.decode(WorkRouteApprovalSchema.Revision, input.expiresAt)
        if (input.scope.instanceID !== installation.instanceID)
          return yield* WorkRouteApproval.failure("CREDENTIAL_DRIFT")
        const native = yield* installed.runtime
          .captureNative(input.runtime, input.request, input.observation, input.scope)
          .pipe(Effect.tapError((error) => Effect.try({
            try: () => {
              const known = Schema.decodeUnknownOption(NativeRuntime.Error)(error)
              process.stderr.write(`Local operator diagnostic: ${JSON.stringify({ version: 1, stage: "native-credential-map",
                kind: "failure", tag: "NativeRuntimeError", code: Option.isSome(known) ? known.value.code : "UNCLASSIFIED" })}\n`)
            },
            catch: () => undefined,
          }).pipe(Effect.ignore)), Effect.mapError(() => WorkRouteApproval.failure("NATIVE_OBSERVATION_REQUIRED")))
        const actual = yield* installed.runtime
          .credential(native)
          .pipe(Effect.mapError(() => WorkRouteApproval.failure("RUNTIME_MISMATCH")))
        const verified = yield* installed.contract.resolve(actual, { snapshot: input.snapshot, expiresAt: input.expiresAt })
        if (actual.protocol !== "openai-responses" || actual.modelID !== input.snapshot)
          return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
        const evidence = yield* WorkRouteApproval.decode(WorkRouteApprovalSchema.Evidence, {
          ...input.scope,
          providerID: actual.providerID,
          routeID: `native_${actual.configurationStamp}`,
          modelID: actual.modelID,
          modelRevision: verified.modelRevision,
          protocol: actual.protocol,
          endpoint: actual.endpoint,
          counterEndpoint: verified.counterEndpoint,
          providerContractID: verified.contractID,
          providerContractHash: verified.contractHash,
          releaseID: actual.installation.releaseID,
          binaryHash: actual.installation.executableHash,
          componentsHash: actual.installation.componentsHash,
          factoryHash: verified.factoryHash,
          adapterHash: verified.adapterHash,
          loweringHash: verified.loweringHash,
          framingHash: verified.framingHash,
          tokenizerIdentity: verified.tokenizerIdentity,
          configuredTargetStamp: actual.configuredTargetStamp,
          configurationStamp: actual.configurationStamp,
          credentialLocatorStamp: actual.credentialLocatorStamp,
          credentialFingerprint: actual.credentialFingerprint,
          nonsecretHeadersHash: actual.nonsecretHeadersHash,
          completionLimit: verified.completionLimit,
          ...(verified.counterSemantics ? { counterSemantics: verified.counterSemantics,
            inputUpperBoundTokens: verified.inputUpperBoundTokens } : {}),
          expiresAt: input.expiresAt,
        })
        const capture = Object.freeze(Object.create(null)) as Capture
        captures.set(capture, { native, runtime: installed.runtime, evidence, observation: input.observation })
        live.add(capture)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            captures.delete(capture)
            live.delete(capture)
          }),
        )
        return capture
      }),
      bindCount: Effect.fn("ProviderCredentialBinding.bindCount")(function* (capture, binding) {
        const entry = captures.get(capture)
        if (!entry || countBindings.size >= 32 || !Schema.is(WorkCountAcquisitionSchema.Binding)(binding))
          return yield* WorkCountAcquisition.failure("COUNT_UNAVAILABLE")
        const key = countHash(binding)
        if (countBindings.has(key)) return yield* WorkCountAcquisition.failure("COUNT_BINDING_CONFLICT")
        countBindings.set(key, capture)
        yield* Effect.addFinalizer(() => Effect.sync(() => { if (countBindings.get(key) === capture) countBindings.delete(key) }))
        yield* requireCountCapture(binding)
      }),
      bindProjectCount: Effect.fn("ProviderCredentialBinding.bindProjectCount")(function* (capture, binding) {
        const decoded = Schema.decodeUnknownOption(WorkCountAcquisitionSchema.ProjectBinding, { onExcessProperty: "error" })(binding)
        if (!captures.has(capture) || countBindings.size >= 32 || Option.isNone(decoded))
          return yield* WorkCountAcquisition.failure("COUNT_UNAVAILABLE")
        const key = countHash(binding)
        if (countBindings.has(key)) return yield* WorkCountAcquisition.failure("COUNT_BINDING_CONFLICT")
        countBindings.set(key, capture)
        yield* Effect.addFinalizer(() => Effect.sync(() => { if (countBindings.get(key) === capture) countBindings.delete(key) }))
        yield* requireCountCapture(binding)
      }),
      count: (capture, deadline) => Effect.gen(function* () {
        const entry = captures.get(capture)
        if (!entry) return yield* WorkCountAcquisition.failure("COUNT_UNAVAILABLE")
        return yield* entry.runtime.countInput(entry.native, deadline).pipe(Effect.mapError(() => WorkCountAcquisition.failure("COUNT_UNKNOWN")))
      }),
      countAuthority: {
        requireCapture: requireCountCapture,
        requireProjectCapture: requireCountCapture,
        authenticate: (record) => validateCount(record).pipe(Effect.map(() => countMac(record))),
        verify: (record, stored) => Effect.gen(function* () {
          yield* validateCount(record)
          if (!/^[0-9a-f]{64}$/.test(stored) || !timingSafeEqual(Buffer.from(countMac(record), "hex"), Buffer.from(stored, "hex")))
            return yield* WorkCountAcquisition.failure("COUNT_INVALID_RECORD")
        }),
        authenticateProject: (record) => validateProjectCount(record).pipe(Effect.map(() => countMac(record))),
        verifyProject: (record, stored) => Effect.gen(function* () {
          yield* validateProjectCount(record)
          if (!/^[0-9a-f]{64}$/.test(stored) || !timingSafeEqual(Buffer.from(countMac(record), "hex"), Buffer.from(stored, "hex")))
            return yield* WorkCountAcquisition.failure("COUNT_INVALID_RECORD")
        }),
      },
      authority: {
        captured: (capture) =>
          Effect.gen(function* () {
            const entry = captures.get(capture)
            if (!entry) return yield* WorkRouteApproval.failure("NATIVE_OBSERVATION_REQUIRED")
            // Fast native-object check only. No filesystem, counter, model or contract resolution in SQL.
            const actual = yield* entry.runtime
              .credential(entry.native)
              .pipe(Effect.mapError(() => WorkRouteApproval.failure("CREDENTIAL_DRIFT")))
            if (
              actual.configurationStamp !== entry.evidence.configurationStamp ||
              actual.credentialFingerprint !== entry.evidence.credentialFingerprint
            )
              return yield* WorkRouteApproval.failure("CREDENTIAL_DRIFT")
            return entry.evidence
          }),
        authenticate: (record) => validate(record).pipe(Effect.map(() => mac(record))),
        verify: (record, stored) =>
          Effect.gen(function* () {
            yield* validate(record)
            const decoded = Schema.decodeUnknownOption(WorkRouteApprovalSchema.Digest)(stored)
            if (Option.isNone(decoded) || !timingSafeEqual(Buffer.from(mac(record), "hex"), Buffer.from(stored, "hex")))
              return yield* WorkRouteApproval.failure("ROUTE_INVALID_RECORD")
          }),
      },
    })
  }),
)

export * as ProviderCredentialBinding from "./provider-credential-binding"
