import { Context, Effect, Layer, Option, Redacted, Schema, Scope } from "effect"
import { createHmac } from "node:crypto"
import { LLMClient, type LLMRequest } from "@deepagent-code/llm"
import { Auth, RequestExecutor, VendorContextBound } from "@deepagent-code/llm/route"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { NativeInstallation } from "./native-installation"
import { NativeBootstrap } from "@/runtime/native-bootstrap"
import { LocalAuthority } from "@/installation/local-authority"
import { WorkRouteApprovalSchema } from "@deepagent-code/core/session/work-route-approval.schema"
import { Config } from "@deepagent-code/core/config"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { EventWorkPlacement } from "@deepagent-code/core/deepagent/event-work-placement"

declare const approved: unique symbol
/** A live construction/installation fact, not a source grant, count receipt, route or Work permit. */
export interface ApprovedRuntime {
  readonly [approved]: true
}
declare const capturedCredential: unique symbol
export interface CredentialCapture {
  readonly [capturedCredential]: true
}
declare const readyPurpose: unique symbol
/** Read-only construction readiness. This never registers a model or permits a request. */
export interface PurposeReadiness {
  readonly [readyPurpose]: true
}
export type CredentialDescription = Readonly<{
  scope: WorkRouteApprovalSchema.Scope
  installation: NativeInstallation.Description
  providerID: string
  modelID: string
  protocol: string
  endpoint: string
  configuredTargetStamp: string
  configurationStamp: string
  credentialLocatorStamp: string
  credentialFingerprint: string
  nonsecretHeadersHash: string
}>

export class Error extends Schema.TaggedErrorClass<Error>()("NativeRuntimeError", {
  code: Schema.Literals(["NATIVE_RUNTIME_UNAVAILABLE", "NATIVE_RUNTIME_CHANGED", "NATIVE_RUNTIME_CAPACITY"]),
  message: Schema.String,
}) {}

export const requiredComponents = Object.freeze([
  "packages/llm/src/route/auth.ts",
  "packages/llm/src/route/client.ts",
  "packages/llm/src/route/executor.ts",
  "packages/llm/src/route/transport/http.ts",
  "packages/llm/src/route/framing.ts",
  "packages/llm/src/route/endpoint.ts",
  "packages/llm/src/protocols/openai-responses.ts",
  "packages/llm/src/route/vendor-context-bound.ts",
  "packages/llm/src/schema/options.ts",
  "packages/core/src/session/runner/model.ts",
  "packages/core/src/config.ts",
  "packages/deepagent-code/src/installation/local-authority.ts",
  "packages/core/src/location-layer.ts",
  "packages/deepagent-code/src/installation/native-installation.ts",
  "packages/deepagent-code/src/installation/native-runtime.ts",
  "packages/deepagent-code/src/runtime/native-bootstrap.ts",
  "packages/deepagent-code/src/util/proxy-env.ts",
  "packages/deepagent-code/src/index.ts",
  "packages/deepagent-code/src/cli/tui/worker.ts",
  "packages/deepagent-code/src/session/v2-runner-frame.ts",
  "packages/deepagent-code/src/effect/root.ts",
])

const runtimeComponents = process.versions.bun ? requiredComponents : Object.freeze([
  ...requiredComponents, "packages/llm/src/route/builtin-node.ts", "packages/deepagent-code/src/node.ts",
])

/** Investigation uses the same actual native client. Its signed installation must also
 * include every new source/profile/read boundary; a purpose label grants no Work authority. */
export const investigationComponents = Object.freeze([
  "packages/core/src/deepagent/event-investigation-authority.schema.ts",
  "packages/core/src/deepagent/event-investigation.schema.ts",
  "packages/core/src/deepagent/event-investigation-policy.ts",
  "packages/core/src/deepagent/event-investigation.ts",
  "packages/core/src/deepagent/event-validation.schema.ts",
  "packages/core/src/deepagent/event-validation.ts",
  "packages/core/src/im/local-operator.ts",
  "packages/core/src/session/work-admission.ts",
  "packages/core/src/session/work-authority.ts",
  "packages/core/src/session/work-authority.schema.ts",
  "packages/core/src/session/work-authority-policy.ts",
  "packages/core/src/session/work-count-acquisition.ts",
  "packages/core/src/session/work-tool-policy.ts",
  "packages/core/src/session/runner/canonical-turn.ts",
  "packages/core/src/tool/read.ts",
  "packages/deepagent-code/src/deepagent/event-investigation.ts",
  "packages/deepagent-code/src/installation/event-investigation-source.ts",
  "packages/deepagent-code/src/installation/event-investigation-evidence.ts",
  "packages/deepagent-code/src/installation/event-investigation-read.ts",
  "packages/deepagent-code/src/installation/work-execution-profile.ts",
  "packages/deepagent-code/src/installation/work-file-helper.ts",
])

export const eventWorkComponents = Object.freeze([
  "packages/core/src/deepagent/event-work-placement.ts",
  "packages/core/src/deepagent/event-work-node-authority.ts",
  "packages/core/src/deepagent/event-work-controller.ts",
  "packages/core/src/deepagent/event-work-dag.schema.ts",
  "packages/core/src/deepagent/event-work-dag.policy.ts",
  "packages/core/src/deepagent/event-work-management.ts",
  "packages/core/src/deepagent/event-work-result.ts",
  "packages/core/src/session/work-derived-authority.ts",
  "packages/core/src/session/task-workspace.ts",
  "packages/deepagent-code/src/installation/event-work-placement.ts",
  "packages/deepagent-code/src/installation/event-work-tree.ts",
  "packages/deepagent-code/src/installation/work-execution-profile.ts",
  "packages/deepagent-code/src/installation/provider-credential-binding.ts",
  "packages/deepagent-code/src/session/event-work-dag-runtime.ts",
  "packages/deepagent-code/src/session/event-work-git.ts",
  "packages/deepagent-code/src/session/event-work-artifacts.ts",
  "packages/work-file-helper/src/event_worktree.rs",
  "packages/work-file-helper/src/event_worktree_windows.rs",
  "packages/work-file-helper/src/event_cleanup.rs",
])
export type Configuration = Readonly<{
  providerID: string; modelID: string; adapterID: string; protocol: string
  configuredTargetStamp: string; configurationStamp: string; installation: NativeInstallation.Description
}>

export interface Interface {
  readonly requirePurpose: (purpose: "event_investigate_v1" | "event_dag_write_v1") => Effect.Effect<
    {
      readonly readiness: PurposeReadiness
      readonly installation: NativeInstallation.Description
    },
    Error
  >
  /** Fast same-root check for a captured grant; all installation I/O occurred before SQL. */
  readonly purposeCurrent: (readiness: PurposeReadiness) => boolean
  readonly approve: (
    resolved: SessionRunnerModel.ResolvedModel,
    purpose?: "event_investigate_v1",
  ) => Effect.Effect<ApprovedRuntime, Error, Scope.Scope>
  /** Only configurations returned by this original factory and an original Root's opaque
   * physical placement may bridge the parent approval to a separately resolved child. */
  readonly approveDerived: (input: {
    readonly parent: ApprovedRuntime
    readonly parentConfiguration: Configuration
    readonly resolved: SessionRunnerModel.ResolvedModel
    readonly placement: EventWorkPlacement.Witness
    readonly scope: WorkRouteApprovalSchema.Scope
  }) => Effect.Effect<ApprovedRuntime, Error, Scope.Scope>
  /** Must be installed as the request seal around the existing canonical client call. */
  readonly bind: (
    handle: ApprovedRuntime,
    request: LLMRequest,
  ) => Effect.Effect<RequestExecutor.RequestSeal, Error, Scope.Scope>
  readonly describe: (handle: ApprovedRuntime) => Effect.Effect<
    {
      readonly installation: NativeInstallation.Description
      readonly location: { readonly directory: string; readonly workspaceID?: string }
      readonly sourceHash: string
      readonly protocol: string
      readonly runtime: string
      readonly proxyPolicy: "startup-environment"
      readonly bootstrapConfigurationHash: string
      readonly executorConfigurationHash: string
    },
    Error
  >
  readonly live: () => number
  /** Only the same actual native final observation can produce this opaque host handle. */
  readonly captureNative: (
    handle: ApprovedRuntime,
    request: LLMRequest,
    observation: RequestExecutor.RequestSealInput,
    scope: WorkRouteApprovalSchema.Scope,
  ) => Effect.Effect<CredentialCapture, Error, Scope.Scope>
  readonly credential: (capture: CredentialCapture) => Effect.Effect<CredentialDescription, Error>
  /** Configuration-only observation of the real resolved object. Does not encode or send a request. */
  readonly configuration: (
    handle: ApprovedRuntime,
    scope: WorkRouteApprovalSchema.Scope,
  ) => Effect.Effect<
    {
      readonly providerID: string
      readonly modelID: string
      readonly adapterID: string
      readonly protocol: string
      readonly configuredTargetStamp: string
      readonly configurationStamp: string
      readonly installation: NativeInstallation.Description
    },
    Error
  >
  /** Fixed counter operation from the exact live native final-auth observation. */
  readonly countInput: (
    capture: CredentialCapture,
    deadline: number,
  ) => Effect.Effect<
    {
      readonly inputTokens: number
      readonly responseHash: string
      readonly countBodyHash: string
      readonly countedAt: number
    },
    Error
  >
  /** Project profile only: final HTTP bytes must preserve this request's actual protocol
   * lowering. Does not expose the body or accept a caller-computed expected digest. */
  readonly requireCanonicalBody: (
    handle: ApprovedRuntime,
    request: LLMRequest,
    observation: RequestExecutor.RequestSealInput,
  ) => Effect.Effect<void, Error>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/NativeRuntime") {}

// A single layer identity is passed both to Core's Location map and to this factory. Providing a
// look-alike LLM service around a later caller cannot replace the client captured by the runner.
// The factory preserves ordinary requests; only the early, current builtin transport can
// describe itself for the signed runtime's separate native authorization.
export const clientLayer = LLMClient.nativeManagedLayer.pipe(
  Layer.provide(RequestExecutor.defaultLayer),
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* LLMClient.Service
    const lifetime = { active: true, live: 0 }
    const purposes = new WeakMap<PurposeReadiness, { readonly bootstrapHash: string; readonly executorHash: string }>()
    const handles = new WeakMap<
      ApprovedRuntime,
      {
        active: boolean
        readonly installation: NativeInstallation.VerifiedInstalledComponents
        readonly resolved: SessionRunnerModel.ResolvedModel
        readonly sourceHash: string
        readonly bootstrapHash: string
        readonly executorHash: string
        derived?: { readonly parent: ApprovedRuntime; readonly placement: EventWorkPlacement.Witness;
          readonly service: Context.Service.Shape<typeof EventWorkPlacement.Service>;
          readonly scope: WorkRouteApprovalSchema.Scope; readonly parentConfiguration: Configuration }
      }
    >()
    const configurations = new WeakMap<Configuration, { readonly handle: ApprovedRuntime;
      readonly scope: WorkRouteApprovalSchema.Scope; readonly configured: SessionRunnerModel.ConfigurationWitness }>()
    const active = new Set<ApprovedRuntime>()
    const captures = new WeakMap<
      CredentialCapture,
      {
        handle: ApprovedRuntime
        request: LLMRequest
        observation: RequestExecutor.RequestSealInput
        description: CredentialDescription
        installationKeyHash: string
        configured: SessionRunnerModel.ConfigurationWitness
        active: boolean
      }
    >()
    const activeCaptures = new Set<CredentialCapture>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        lifetime.active = false
        lifetime.live = 0
        active.forEach((handle) => handles.delete(handle))
        active.clear()
        activeCaptures.forEach((handle) => captures.delete(handle))
        activeCaptures.clear()
      }),
    )
    const requireLive = Effect.fn("NativeRuntime.requireLive")(function* (handle: ApprovedRuntime) {
      const entry = typeof handle === "object" && handle !== null ? handles.get(handle) : undefined
      const bootstrap = NativeBootstrap.describe()
      const executor = LLMClient.nativeDescription(client)
      const resolved = entry ? SessionRunnerModel.construction(entry.resolved) : undefined
      if (
        !lifetime.active ||
        !entry?.active ||
        !bootstrap ||
        !executor ||
        !resolved ||
        resolved.client !== client ||
        resolved.sourceHash !== entry.sourceHash ||
        bootstrap.configurationHash !== entry.bootstrapHash ||
        executor.configurationHash !== entry.executorHash
      )
        return yield* refusal("NATIVE_RUNTIME_CHANGED")
      if (entry.derived) {
        yield* entry.derived.service.current(entry.derived.placement).pipe(Effect.mapError(() => refusal("NATIVE_RUNTIME_CHANGED")))
        const placement = entry.derived.service.describe(entry.derived.placement)
        const parent = handles.get(entry.derived.parent)
        const configuration = configurations.get(entry.derived.parentConfiguration)
        if (!placement || !parent?.active || parent.derived || !active.has(entry.derived.parent) ||
          SessionRunnerModel.construction(parent.resolved)?.client !== client || !configuration ||
          configuration.handle !== entry.derived.parent || !SessionRunnerModel.configurationCurrent(configuration.configured) ||
          resolved.location.directory !== placement.workspace.directory || resolved.location.workspaceID !== undefined ||
          placement.configurationStamp !== entry.derived.parentConfiguration.configurationStamp ||
          placement.configuredTargetStamp !== entry.derived.parentConfiguration.configuredTargetStamp)
          return yield* refusal("NATIVE_RUNTIME_CHANGED")
      }
      return { entry, resolved, bootstrap, executor }
    })
    const requireCurrent = Effect.fn("NativeRuntime.requireCurrent")(function* (handle: ApprovedRuntime) {
      const current = yield* requireLive(handle)
      const installation = yield* NativeInstallation.requireCurrent(current.entry.installation).pipe(
        Effect.mapError(() => refusal("NATIVE_RUNTIME_CHANGED")),
      )
      return { ...current, installation }
    })
    const credentialDescription = Effect.fn("NativeRuntime.credentialDescription")(function* (
      handle: ApprovedRuntime,
      request: LLMRequest,
      observation: RequestExecutor.RequestSealInput,
      scope: WorkRouteApprovalSchema.Scope,
    ) {
      const Branch = Schema.Literals([
        "current-before", "model-object", "native-observation", "headers-missing", "method", "url-missing", "body-missing",
        "workspace", "directory", "auth-kind", "auth-header", "auth-scheme", "auth-source", "auth-source-kind", "endpoint",
        "bearer-header", "extra-header", "content-type", "accept", "installation-read", "installation-scope",
        "bootstrap-stamp-error", "bootstrap-stamp-missing", "config-service", "config-witness", "provider-id", "model-id",
        "provider-config", "model-config", "api-config", "model-info", "model-disabled", "api-url", "api-id", "protocol",
        "config-credential-locator", "value-credential-locator", "current-after",
      ])
      const report = (branch: typeof Branch.Type) => (error: Error) => Effect.try({
        try: () => {
          const known = Schema.decodeUnknownOption(Error)(error)
          process.stderr.write(`Local operator diagnostic: ${JSON.stringify({ version: 1, stage: "native-credential-verify",
            branch, kind: "failure", tag: "NativeRuntimeError", code: Option.isSome(known) ? known.value.code : "UNCLASSIFIED" })}\n`)
        },
        catch: () => undefined,
      }).pipe(Effect.ignore)
      const deny = (code: Error["code"], branch: typeof Branch.Type) => Effect.fail(refusal(code)).pipe(Effect.tapError(report(branch)))
      const before = yield* requireCurrent(handle).pipe(Effect.tapError(report("current-before")))
      const auth = Auth.construction(before.entry.resolved.model.route.auth)
      const endpoint = observation.url
        ? WorkAuthorityPolicy.normalizeEndpoint(observation.url, { allowLoopbackHTTP: true })
        : undefined
      if (
        request.model !== before.entry.resolved.model ||
        !LLMClient.observesNative(client, request, observation) ||
        !observation.headers ||
        observation.method !== "POST" ||
        !observation.url ||
        !observation.bodyText ||
        before.resolved.location.workspaceID !== undefined ||
        before.resolved.location.directory !== (before.entry.derived
          ? before.entry.derived.service.describe(before.entry.derived.placement)?.workspace.directory : scope.canonicalRoot) ||
        auth?.kind !== "credential" ||
        auth.header !== "authorization" ||
        auth.scheme !== "bearer" ||
        !auth.source ||
        !["value", "config"].includes(auth.source.kind) ||
        !endpoint?.ok ||
        endpoint.value !== observation.url
      )
        return yield* deny("NATIVE_RUNTIME_UNAVAILABLE",
          request.model !== before.entry.resolved.model ? "model-object" :
          !LLMClient.observesNative(client, request, observation) ? "native-observation" :
          !observation.headers ? "headers-missing" : observation.method !== "POST" ? "method" :
          !observation.url ? "url-missing" : !observation.bodyText ? "body-missing" :
          before.resolved.location.workspaceID !== undefined ? "workspace" :
          before.resolved.location.directory !== scope.canonicalRoot ? "directory" :
          auth?.kind !== "credential" ? "auth-kind" : auth.header !== "authorization" ? "auth-header" :
          auth.scheme !== "bearer" ? "auth-scheme" : !auth.source ? "auth-source" :
          !["value", "config"].includes(auth.source.kind) ? "auth-source-kind" : "endpoint")
      if (before.entry.derived && CanonicalJson.stringify(scope) !== CanonicalJson.stringify(before.entry.derived.scope))
        return yield* deny("NATIVE_RUNTIME_CHANGED", "directory")
      const headers = Redacted.value(observation.headers)
      // The first approved profile has one builtin bearer and only structural HTTP headers.
      // Arbitrary extra headers may contain credentials and must not become public raw hashes.
      if (
        !headers.authorization?.startsWith("Bearer ") ||
        headers.authorization.length <= 7 ||
        Object.keys(headers).some((name) => !["authorization", "content-type", "accept"].includes(name)) ||
        headers["content-type"] !== "application/json" ||
        (headers.accept !== undefined && !["application/json", "text/event-stream", "*/*"].includes(headers.accept))
      )
        return yield* deny("NATIVE_RUNTIME_UNAVAILABLE",
          !headers.authorization?.startsWith("Bearer ") || headers.authorization.length <= 7 ? "bearer-header" :
          Object.keys(headers).some((name) => !["authorization", "content-type", "accept"].includes(name)) ? "extra-header" :
          headers["content-type"] !== "application/json" ? "content-type" : "accept")
      const installation = yield* LocalAuthority.readInstallation.pipe(
        Effect.mapError(() => refusal("NATIVE_RUNTIME_UNAVAILABLE")),
        Effect.tapError(report("installation-read")),
      )
      if (installation.instanceID !== scope.instanceID) return yield* deny("NATIVE_RUNTIME_CHANGED", "installation-scope")
      const bootstrapContext = process.platform === "win32" ? yield* Effect.context() : undefined
      const bootstrapStamp = yield* Effect.tryPromise({
        try: () => NativeBootstrap.installationConfigurationStamp(scope, Hash.sha256(installation.secret), bootstrapContext),
        catch: () => refusal("NATIVE_RUNTIME_CHANGED"),
      }).pipe(Effect.tapError(report("bootstrap-stamp-error")))
      if (!bootstrapStamp) return yield* deny("NATIVE_RUNTIME_CHANGED", "bootstrap-stamp-missing")
      const resolved = before.entry.resolved
      const service = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(service)) return yield* deny("NATIVE_RUNTIME_UNAVAILABLE", "config-service")
      const entries = yield* service.value.entries()
      const configured = SessionRunnerModel.configuration(resolved, service.value, entries)
      const providerID = resolved.info?.providerID
      const modelID = resolved.info?.id
      const provider = providerID ? Config.latest(entries, "providers")?.[providerID] : undefined
      const model = modelID ? provider?.models?.[modelID] : undefined
      const api = model?.api && "type" in model.api ? model.api : provider?.api
      const protocol = model?.api?.protocol ?? api?.protocol
      const key = model?.request?.body?.apiKey ?? provider?.request?.body?.apiKey ?? api?.settings?.apiKey
      if (
        !configured ||
        !providerID ||
        !modelID ||
        !provider ||
        !model ||
        !api ||
        !resolved.info ||
        model.disabled ||
        resolved.info.api.url !== api.url ||
        resolved.info.api.id !== (model.api?.id ?? modelID) ||
        !["openai.responses", "openai-compatible.responses"].includes(protocol ?? "") ||
        (auth.source.kind === "config" &&
          (typeof key === "string" ||
            typeof auth.source.name !== "string" ||
            !provider.env?.includes(auth.source.name))) ||
        (auth.source.kind === "value" && (typeof key !== "string" || headers.authorization !== `Bearer ${key}`))
      )
        return yield* deny("NATIVE_RUNTIME_CHANGED", !configured ? "config-witness" : !providerID ? "provider-id" :
          !modelID ? "model-id" : !provider ? "provider-config" : !model ? "model-config" : !api ? "api-config" :
          !resolved.info ? "model-info" : model.disabled ? "model-disabled" : resolved.info.api.url !== api.url ? "api-url" :
          resolved.info.api.id !== (model.api?.id ?? modelID) ? "api-id" :
          !["openai.responses", "openai-compatible.responses"].includes(protocol ?? "") ? "protocol" :
          auth.source.kind === "config" ? "config-credential-locator" : "value-credential-locator")
      const configuredTargetStamp = createHmac("sha256", Buffer.from(installation.secret, "hex"))
        .update("dac.local-operator.configured-target.v1\0")
        .update(
          CanonicalJson.stringify([
            installation.instanceID,
            scope.operatorID,
            scope.targetID,
            scope.securityNamespaceID,
            { providerID, modelID, provider, model },
          ]),
        )
        .digest("hex")
      const source = JSON.stringify({
        model: Object.fromEntries(Object.entries(resolved.model).filter(([key]) => key !== "route")),
        info: resolved.info,
        providerInfo: resolved.provider,
      })
      const scopeText = CanonicalJson.stringify(scope)
      const configurationStamp = createHmac("sha256", Buffer.from(installation.secret, "hex"))
        .update("dac.native-route.configuration.v1\0")
        .update(scopeText)
        .update(
          CanonicalJson.stringify([bootstrapStamp, source, before.installation.manifestHash, before.executor.runtime]),
        )
        .digest("hex")
      if (before.entry.derived && (configurationStamp !== before.entry.derived.parentConfiguration.configurationStamp ||
        configuredTargetStamp !== before.entry.derived.parentConfiguration.configuredTargetStamp))
        return yield* deny("NATIVE_RUNTIME_CHANGED", "current-after")
      const credentialLocatorStamp = createHmac("sha256", Buffer.from(installation.secret, "hex"))
        .update("dac.provider-credential.locator.v1\0")
        .update(scopeText)
        .update(CanonicalJson.stringify(auth))
        .digest("hex")
      const credentialFingerprint = createHmac("sha256", Buffer.from(installation.secret, "hex"))
        .update("dac.provider-credential.final-header.v1\0")
        .update(scopeText)
        .update(CanonicalJson.stringify([configurationStamp, credentialLocatorStamp, headers.authorization]))
        .digest("hex")
      const nonsecretHeadersHash = Hash.sha256(
        CanonicalJson.stringify(
          Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "authorization")),
        ),
      )
      yield* requireCurrent(handle).pipe(Effect.tapError(report("current-after")))
      return {
        description: Object.freeze({
          scope: Object.freeze({ ...scope }),
          installation: before.installation,
          providerID: resolved.model.provider,
          modelID: resolved.model.id,
          protocol: resolved.model.route.protocol,
          endpoint: observation.url,
          configuredTargetStamp,
          configurationStamp,
          credentialLocatorStamp,
          credentialFingerprint,
          nonsecretHeadersHash,
        }),
        installationKeyHash: Hash.sha256(installation.secret),
        configured,
      }
    })
    const output: Interface = Service.of({
      requirePurpose: Effect.fn("NativeRuntime.requirePurpose")(function* (purpose) {
        const bootstrap = NativeBootstrap.describe()
        const executor = LLMClient.nativeDescription(client)
        if (!lifetime.active || !["event_investigate_v1", "event_dag_write_v1"].includes(purpose) || !bootstrap || !executor)
          return yield* refusal("NATIVE_RUNTIME_UNAVAILABLE")
        const installation = yield* NativeInstallation.current().pipe(
          Effect.mapError(() => refusal("NATIVE_RUNTIME_UNAVAILABLE")),
        )
        const inventory = yield* NativeInstallation.inventory(installation).pipe(
          Effect.mapError(() => refusal("NATIVE_RUNTIME_UNAVAILABLE")),
        )
        if (
          ![...runtimeComponents, ...(purpose === "event_dag_write_v1" ? eventWorkComponents : investigationComponents)].every((path) =>
            inventory.some((component) => component.path === path),
          )
        )
          return yield* refusal("NATIVE_RUNTIME_UNAVAILABLE")
        const description = yield* NativeInstallation.requireCurrent(installation).pipe(
          Effect.mapError(() => refusal("NATIVE_RUNTIME_CHANGED")),
        )
        if (
          !lifetime.active ||
          NativeBootstrap.describe()?.configurationHash !== bootstrap.configurationHash ||
          LLMClient.nativeDescription(client)?.configurationHash !== executor.configurationHash
        )
          return yield* refusal("NATIVE_RUNTIME_CHANGED")
        const readiness = Object.freeze(Object.create(null)) as PurposeReadiness
        purposes.set(readiness, {
          bootstrapHash: bootstrap.configurationHash,
          executorHash: executor.configurationHash,
        })
        return { readiness, installation: description }
      }),
      purposeCurrent: (readiness) => {
        const value = typeof readiness === "object" && readiness !== null ? purposes.get(readiness) : undefined
        return (
          lifetime.active &&
          !!value &&
          NativeBootstrap.describe()?.configurationHash === value.bootstrapHash &&
          LLMClient.nativeDescription(client)?.configurationHash === value.executorHash
        )
      },
      approve: Effect.fn("NativeRuntime.approve")(function* (resolved, purpose) {
        const report = (branch: "purpose" | "lifetime" | "construction" | "client" | "bootstrap" | "executor" | "auth" |
          "capacity" | "installation" | "inventory" | "components" | "construction-current" | "bootstrap-current" | "executor-current") =>
          (error: Error) => Effect.logWarning(`native_runtime_refused ${JSON.stringify({
            stage: "native-runtime-approve", branch, code: error.code,
          })}`)
        const deny = (code: Error["code"], branch: Parameters<typeof report>[0]) =>
          Effect.fail(refusal(code)).pipe(Effect.tapError(report(branch)))
        if (purpose !== undefined && purpose !== "event_investigate_v1")
          return yield* deny("NATIVE_RUNTIME_UNAVAILABLE", "purpose")
        const construction = SessionRunnerModel.construction(resolved)
        const bootstrap = NativeBootstrap.describe()
        const executor = LLMClient.nativeDescription(client)
        if (
          !lifetime.active ||
          !construction ||
          construction.client !== client ||
          !bootstrap ||
          !executor ||
          !Auth.construction(resolved.model.route.auth)
        )
          return yield* deny("NATIVE_RUNTIME_UNAVAILABLE", !lifetime.active ? "lifetime" : !construction ? "construction" :
            construction.client !== client ? "client" : !bootstrap ? "bootstrap" : !executor ? "executor" : "auth")
        if (lifetime.live >= 32) return yield* deny("NATIVE_RUNTIME_CAPACITY", "capacity")
        const installation = yield* NativeInstallation.current().pipe(
          Effect.mapError(() => refusal("NATIVE_RUNTIME_UNAVAILABLE")),
          Effect.tapError(report("installation")),
        )
        const inventory = yield* NativeInstallation.inventory(installation).pipe(
          Effect.mapError(() => refusal("NATIVE_RUNTIME_UNAVAILABLE")),
          Effect.tapError(report("inventory")),
        )
        if (
          !runtimeComponents.every((path) => inventory.some((component) => component.path === path)) ||
          (purpose === "event_investigate_v1" &&
            !investigationComponents.every((path) => inventory.some((component) => component.path === path)))
        )
          return yield* deny("NATIVE_RUNTIME_UNAVAILABLE", "components")
        // Recheck after hashing the executable; no borrowed or changed model may enter the registry.
        if (
          SessionRunnerModel.construction(resolved) !== construction ||
          NativeBootstrap.describe()?.configurationHash !== bootstrap.configurationHash ||
          LLMClient.nativeDescription(client)?.configurationHash !== executor.configurationHash ||
          lifetime.live >= 32
        )
          return yield* deny("NATIVE_RUNTIME_CHANGED", SessionRunnerModel.construction(resolved) !== construction
            ? "construction-current" : NativeBootstrap.describe()?.configurationHash !== bootstrap.configurationHash
              ? "bootstrap-current" : LLMClient.nativeDescription(client)?.configurationHash !== executor.configurationHash
                ? "executor-current" : "capacity")
        const handle = Object.freeze(Object.create(null)) as ApprovedRuntime
        const entry = {
          active: true,
          installation,
          resolved,
          sourceHash: construction.sourceHash,
          bootstrapHash: bootstrap.configurationHash,
          executorHash: executor.configurationHash,
        }
        handles.set(handle, entry)
        active.add(handle)
        lifetime.live++
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!entry.active) return
            entry.active = false
            handles.delete(handle)
            active.delete(handle)
            if (lifetime.active) lifetime.live--
          }),
        )
        return handle
      }),
      approveDerived: Effect.fn("NativeRuntime.approveDerived")(function* (input) {
        const service = yield* Effect.serviceOption(EventWorkPlacement.Service)
        if (Option.isNone(service)) return yield* refusal("NATIVE_RUNTIME_UNAVAILABLE")
        yield* service.value.current(input.placement).pipe(Effect.mapError(() => refusal("NATIVE_RUNTIME_CHANGED")))
        const description = service.value.describe(input.placement)
        const parent = yield* requireCurrent(input.parent)
        const configuration = configurations.get(input.parentConfiguration)
        if (!description || parent.entry.derived || !configuration || configuration.handle !== input.parent ||
          !SessionRunnerModel.configurationCurrent(configuration.configured) ||
          CanonicalJson.stringify(configuration.scope) !== CanonicalJson.stringify(input.scope) ||
          parent.resolved.location.directory !== description.workspace.repositoryRoot || input.scope.canonicalRoot !== description.workspace.repositoryRoot ||
          description.configurationStamp !== input.parentConfiguration.configurationStamp ||
          description.configuredTargetStamp !== input.parentConfiguration.configuredTargetStamp)
          return yield* refusal("NATIVE_RUNTIME_CHANGED")
        yield* output.requirePurpose("event_dag_write_v1")
        const handle = yield* output.approve(input.resolved)
        const childScope = { ...input.scope, canonicalRoot: description.workspace.directory,
          locationKey: description.locationKey }
        const child = yield* output.configuration(handle, childScope)
        if (child.configurationStamp !== description.childConfigurationStamp ||
          child.configuredTargetStamp !== description.childConfiguredTargetStamp || child.configuredTargetStamp !== input.parentConfiguration.configuredTargetStamp ||
          child.providerID !== input.parentConfiguration.providerID || child.modelID !== input.parentConfiguration.modelID ||
          child.adapterID !== input.parentConfiguration.adapterID || child.protocol !== input.parentConfiguration.protocol ||
          child.installation.manifestHash !== input.parentConfiguration.installation.manifestHash)
          return yield* refusal("NATIVE_RUNTIME_CHANGED")
        const entry = handles.get(handle)
        if (!entry || SessionRunnerModel.construction(input.resolved)?.location.directory !== description.workspace.directory)
          return yield* refusal("NATIVE_RUNTIME_CHANGED")
        entry.derived = { parent: input.parent, parentConfiguration: input.parentConfiguration,
          placement: input.placement, scope: Object.freeze({ ...input.scope }), service: service.value }
        yield* requireCurrent(handle)
        return handle
      }),
      bind: Effect.fn("NativeRuntime.bind")(function* (handle, request) {
        const current = yield* requireCurrent(handle)
        if (request.model !== current.entry.resolved.model) return yield* refusal("NATIVE_RUNTIME_CHANGED")
        const original = yield* RequestExecutor.CurrentRequestSeal
        if (!original) return yield* refusal("NATIVE_RUNTIME_UNAVAILABLE")
        yield* LLMClient.bindNativeRequest(client, request).pipe(
          Effect.mapError(() => refusal("NATIVE_RUNTIME_UNAVAILABLE")),
        )
        return {
          seal: (observation) =>
            Effect.gen(function* () {
              const before = yield* requireCurrent(handle)
              if (
                request.model !== before.entry.resolved.model ||
                !LLMClient.observesNative(client, request, observation)
              )
                return yield* refusal("NATIVE_RUNTIME_CHANGED")
              yield* original.seal(observation)
              yield* requireCurrent(handle)
            }).pipe(Effect.orDie),
        }
      }),
      requireCanonicalBody: (handle, request, observation) =>
        Effect.gen(function* () {
          const current = yield* requireCurrent(handle)
          if (
            request.model !== current.entry.resolved.model ||
            !LLMClient.observesCanonicalNativeBody(client, request, observation)
          )
            return yield* refusal("NATIVE_RUNTIME_CHANGED")
        }),
      describe: Effect.fn("NativeRuntime.describe")(function* (handle) {
        const current = yield* requireCurrent(handle)
        return Object.freeze({
          installation: current.installation,
          location: current.resolved.location,
          sourceHash: current.resolved.sourceHash,
          protocol: current.entry.resolved.model.route.protocol,
          runtime: current.executor.runtime,
          proxyPolicy: current.executor.proxyPolicy,
          bootstrapConfigurationHash: current.bootstrap.configurationHash,
          executorConfigurationHash: current.executor.configurationHash,
        })
      }),
      configuration: Effect.fn("NativeRuntime.configuration")(function* (handle, scope) {
        const report = (branch: "current" | "installation" | "config-service" | "instance" | "workspace" | "directory" |
          "derived-scope" | "config-witness" | "provider" | "model" | "provider-id" | "model-id" | "disabled" |
          "bootstrap-stamp-error" | "bootstrap-stamp-missing" | "configuration-current" | "derived-configuration") =>
          (error: Error) => Effect.logWarning(`native_runtime_refused ${JSON.stringify({
            stage: "native-runtime-configuration", branch, code: error.code,
          })}`)
        const deny = (code: Error["code"], branch: Parameters<typeof report>[0]) =>
          Effect.fail(refusal(code)).pipe(Effect.tapError(report(branch)))
        const before = yield* requireCurrent(handle).pipe(Effect.tapError(report("current")))
        const resolved = before.entry.resolved
        const installation = yield* LocalAuthority.readInstallation.pipe(
          Effect.mapError(() => refusal("NATIVE_RUNTIME_UNAVAILABLE")),
          Effect.tapError(report("installation")),
        )
        const service = yield* Effect.serviceOption(Config.Service)
        if (
          Option.isNone(service) ||
          installation.instanceID !== scope.instanceID ||
          before.resolved.location.workspaceID !== undefined ||
          before.resolved.location.directory !== (before.entry.derived
            ? before.entry.derived.service.describe(before.entry.derived.placement)?.workspace.directory : scope.canonicalRoot) ||
          before.entry.derived !== undefined && CanonicalJson.stringify(scope) !== CanonicalJson.stringify(before.entry.derived.scope)
        )
          return yield* deny("NATIVE_RUNTIME_CHANGED", Option.isNone(service) ? "config-service" :
            installation.instanceID !== scope.instanceID ? "instance" : before.resolved.location.workspaceID !== undefined
              ? "workspace" : before.resolved.location.directory !== (before.entry.derived
                ? before.entry.derived.service.describe(before.entry.derived.placement)?.workspace.directory : scope.canonicalRoot)
                ? "directory" : "derived-scope")
        const entries = yield* service.value.entries()
        const configured = SessionRunnerModel.configuration(resolved, service.value, entries)
        const providerID = resolved.info?.providerID
        const modelID = resolved.info?.id
        const provider = providerID ? Config.latest(entries, "providers")?.[providerID] : undefined
        const model = modelID ? provider?.models?.[modelID] : undefined
        if (!configured || !provider || !model || !providerID || !modelID || model.disabled)
          return yield* deny("NATIVE_RUNTIME_CHANGED", !configured ? "config-witness" : !provider ? "provider" :
            !model ? "model" : !providerID ? "provider-id" : !modelID ? "model-id" : "disabled")
        const bootstrapContext = process.platform === "win32" ? yield* Effect.context() : undefined
        const bootstrapStamp = yield* Effect.tryPromise({
          try: () => NativeBootstrap.installationConfigurationStamp(scope, Hash.sha256(installation.secret), bootstrapContext),
          catch: () => refusal("NATIVE_RUNTIME_CHANGED"),
        }).pipe(Effect.tapError(report("bootstrap-stamp-error")))
        if (!bootstrapStamp) return yield* deny("NATIVE_RUNTIME_CHANGED", "bootstrap-stamp-missing")
        const configuredTargetStamp = createHmac("sha256", Buffer.from(installation.secret, "hex"))
          .update("dac.local-operator.configured-target.v1\0")
          .update(
            CanonicalJson.stringify([
              installation.instanceID,
              scope.operatorID,
              scope.targetID,
              scope.securityNamespaceID,
              { providerID, modelID, provider, model },
            ]),
          )
          .digest("hex")
        const source = JSON.stringify({
          model: Object.fromEntries(Object.entries(resolved.model).filter(([key]) => key !== "route")),
          info: resolved.info,
          providerInfo: resolved.provider,
        })
        const configurationStamp = createHmac("sha256", Buffer.from(installation.secret, "hex"))
          .update("dac.native-route.configuration.v1\0")
          .update(CanonicalJson.stringify(scope))
          .update(
            CanonicalJson.stringify([
              bootstrapStamp,
              source,
              before.installation.manifestHash,
              before.executor.runtime,
            ]),
          )
          .digest("hex")
        if (!SessionRunnerModel.configurationCurrent(configured)) return yield* deny("NATIVE_RUNTIME_CHANGED", "configuration-current")
        if (before.entry.derived && (configurationStamp !== before.entry.derived.parentConfiguration.configurationStamp ||
          configuredTargetStamp !== before.entry.derived.parentConfiguration.configuredTargetStamp)) return yield* deny("NATIVE_RUNTIME_CHANGED", "derived-configuration")
        const value = Object.freeze({
          providerID: resolved.model.provider,
          modelID: resolved.model.id,
          adapterID: resolved.model.route.id,
          protocol: resolved.model.route.protocol,
          configurationStamp,
          configuredTargetStamp,
          installation: before.installation,
        })
        configurations.set(value, { handle, scope: Object.freeze({ ...scope }), configured })
        return value
      }),
      countInput: Effect.fn("NativeRuntime.countInput")(function* (capture, deadline) {
        const entry = captures.get(capture)
        if (!entry?.active) return yield* refusal("NATIVE_RUNTIME_CHANGED")
        yield* requireCurrent(entry.handle)
        if (
          !SessionRunnerModel.configurationCurrent(entry.configured) ||
          !LLMClient.observesNative(client, entry.request, entry.observation)
        )
          return yield* refusal("NATIVE_RUNTIME_CHANGED")
        const bound = entry.description.providerID === VendorContextBound.DEEPSEEK_FLASH.providerID &&
          entry.description.modelID === VendorContextBound.DEEPSEEK_FLASH.modelID &&
          entry.description.endpoint === VendorContextBound.DEEPSEEK_FLASH.endpoint
        return yield* (bound
          ? LLMClient.boundNativeDeepSeekInput(client, entry.request, entry.observation, deadline)
          : LLMClient.countNativeInput(client, entry.request, entry.observation, deadline)).pipe(
          Effect.mapError(() => refusal("NATIVE_RUNTIME_UNAVAILABLE")),
        )
      }),
      live: () => lifetime.live,
      captureNative: Effect.fn("NativeRuntime.captureNative")(function* (handle, request, observation, scope) {
        if (activeCaptures.size >= 32) return yield* refusal("NATIVE_RUNTIME_CAPACITY")
        const result = yield* credentialDescription(handle, request, observation, scope)
        const capture = Object.freeze(Object.create(null)) as CredentialCapture
        const entry = { handle, request, observation, ...result, active: true }
        captures.set(capture, entry)
        activeCaptures.add(capture)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            entry.active = false
            captures.delete(capture)
            activeCaptures.delete(capture)
          }),
        )
        return capture
      }),
      credential: Effect.fn("NativeRuntime.credential")(function* (capture) {
        const entry = typeof capture === "object" && capture !== null ? captures.get(capture) : undefined
        if (!lifetime.active || !entry?.active) return yield* refusal("NATIVE_RUNTIME_CHANGED")
        // Transaction-safe second check: no executable/key rehash, model resolution or I/O.
        // The full installation/key/config snapshot was authenticated outside the transaction.
        const current = yield* requireLive(entry.handle)
        if (
          entry.request.model !== current.entry.resolved.model ||
          !LLMClient.observesNative(client, entry.request, entry.observation) ||
          !SessionRunnerModel.configurationCurrent(entry.configured)
        )
          return yield* refusal("NATIVE_RUNTIME_CHANGED")
        return entry.description
      }),
    })
    return output
  }),
)

function refusal(code: Error["code"]) {
  return new Error({ code, message: "Native runtime construction is unavailable" })
}

export * as NativeRuntime from "./native-runtime"
