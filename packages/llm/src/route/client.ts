import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import * as Option from "effect/Option"
import { Auth, type Auth as AuthDef } from "./auth"
import { Endpoint, type EndpointPatch } from "./endpoint"
import { RequestExecutor } from "./executor"
import type { Framing } from "./framing"
import { HttpTransport } from "./transport"
import type { Transport, TransportRuntime } from "./transport"
import { WebSocketExecutor } from "./transport"
import type { Protocol } from "./protocol"
import { applyCachePolicy } from "../cache-policy"
import * as ProviderShared from "../protocols/shared"
import type { LLMError, LLMEvent, PreparedRequestOf, ProtocolID, ProviderOptions } from "../schema"
import {
  GenerationOptions,
  HttpOptions,
  LLMRequest,
  LLMResponse,
  Model,
  ModelLimits,
  LLMError as LLMErrorClass,
  InvalidRequestReason,
  PreparedRequest,
  ProviderID,
  mergeGenerationOptions,
  mergeHttpOptions,
  mergeProviderOptions,
} from "../schema"

export interface RouteBody<Body> {
  /** Schema for the validated provider-native body sent as the JSON request. */
  readonly schema: Schema.Codec<Body, unknown>
  /** Build the provider-native body from a common `LLMRequest`. */
  readonly from: (request: LLMRequest) => Effect.Effect<Body, LLMError>
}

export interface Route<Body, Prepared = unknown> {
  readonly id: string
  readonly provider?: ProviderID
  readonly protocol: ProtocolID
  readonly endpoint: Endpoint<Body>
  readonly auth: AuthDef
  readonly transport: Transport<Body, Prepared, unknown>
  readonly defaults: RouteDefaults
  readonly body: RouteBody<Body>
  readonly with: (patch: RoutePatch<Body, Prepared>) => Route<Body, Prepared>
  readonly model: (input: RouteMappedModelInput) => Model
  readonly prepareTransport: (body: Body, request: LLMRequest) => Effect.Effect<Prepared, LLMError>
  readonly streamPrepared: (
    prepared: Prepared,
    request: LLMRequest,
    runtime: TransportRuntime,
  ) => Stream.Stream<LLMEvent, LLMError>
}

// Route registries intentionally erase body generics after construction.
// Normal call sites use `OpenAIChat.route`; callers only need body types
// when preparing a request with a protocol-specific type assertion.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
export type AnyRoute = Route<any, any>

export type HttpOptionsInput = HttpOptions.Input

export type RouteModelInput = Omit<Model.Input, "provider" | "route">

export type RouteRoutedModelInput = Omit<Model.Input, "route">

export interface RouteDefaults {
  readonly headers?: Record<string, string>
  readonly limits?: ModelLimits
  readonly generation?: GenerationOptions
  readonly providerOptions?: ProviderOptions
  readonly http?: HttpOptions
}

export interface RouteDefaultsInput {
  readonly headers?: Record<string, string>
  readonly limits?: ModelLimits.Input
  readonly generation?: GenerationOptions.Input
  readonly providerOptions?: ProviderOptions
  readonly http?: HttpOptions.Input
}

export interface RoutePatch<Body, Prepared> extends RouteDefaultsInput {
  readonly id?: string
  readonly provider?: string | ProviderID
  readonly auth?: AuthDef
  readonly transport?: Transport<Body, Prepared, unknown>
  readonly endpoint?: EndpointPatch<Body>
}

type RouteMappedModelInput = RouteModelInput | RouteRoutedModelInput

const makeRouteModel = (route: AnyRoute, mapped: RouteMappedModelInput) => {
  const provider = route.provider ?? ("provider" in mapped ? mapped.provider : undefined)
  if (!provider) throw new Error(`Route.model(${route.id}) requires a provider`)
  if (!endpointBaseURL(route.endpoint))
    throw new Error(`Route.model(${route.id}) requires an endpoint baseURL — configure it on the route first`)
  return Model.make({
    ...mapped,
    provider,
    route,
  })
}

const mergeRouteDefaults = (base: RouteDefaults | undefined, patch: RouteDefaultsInput): RouteDefaults => {
  const headers = mergeHeaders(base?.headers, patch.headers)
  return {
    ...base,
    ...patch,
    headers,
    limits: patch.limits === undefined ? base?.limits : ModelLimits.make(patch.limits),
    generation: mergeGenerationOptions(generationOptions(base?.generation), generationOptions(patch.generation)),
    providerOptions: mergeProviderOptions(base?.providerOptions, patch.providerOptions),
    http: mergeHttpOptions(
      base?.http,
      httpOptions(patch.http),
      headers === undefined ? undefined : new HttpOptions({ headers }),
    ),
  }
}

const endpointBaseURL = <Body>(endpoint: Endpoint<Body>) =>
  typeof endpoint.baseURL === "string" ? endpoint.baseURL : undefined

const mergeHeaders = (...items: ReadonlyArray<Record<string, string> | undefined>) => {
  const entries = items.flatMap((item) =>
    item === undefined ? [] : Object.entries(item).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

export const generationOptions = (input: GenerationOptions.Input | undefined) =>
  input === undefined ? undefined : GenerationOptions.make(input)

export const httpOptions = (input: HttpOptionsInput | undefined) => {
  if (input === undefined) return input
  return HttpOptions.make(input)
}

export interface Interface {
  /**
   * Compile a request through protocol body construction, validation, and HTTP
   * preparation without sending it. Returns the prepared request including the
   * provider-native body.
   *
   * Pass a `Body` type argument to statically expose the route's body
   * shape (e.g. `prepare<OpenAIChatBody>(...)`) — the runtime body is
   * identical, so this is a type-level assertion the caller makes about which
   * route the request will resolve to.
   */
  readonly prepare: <Body = unknown>(request: LLMRequest) => Effect.Effect<PreparedRequestOf<Body>, LLMError>
  readonly stream: StreamMethod
  readonly generate: GenerateMethod
}

export interface StreamMethod {
  (request: LLMRequest): Stream.Stream<LLMEvent, LLMError>
}

export interface GenerateMethod {
  (request: LLMRequest): Effect.Effect<LLMResponse, LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/LLMClient") {}

const resolveRequestOptions = (request: LLMRequest) =>
  LLMRequest.update(request, {
    generation:
      mergeGenerationOptions(request.model.route.defaults.generation, request.generation) ?? new GenerationOptions({}),
    providerOptions: mergeProviderOptions(request.model.route.defaults.providerOptions, request.providerOptions),
    http: mergeHttpOptions(request.model.route.defaults.http, request.http),
  })

export interface MakeInput<Body, Frame, Event, State> {
  /** Route id used in diagnostics and prepared request metadata. */
  readonly id: string
  /** Provider identity for route-owned model construction. */
  readonly provider?: string | ProviderID
  /** Semantic API contract — owns body construction, body schema, and parsing. */
  readonly protocol: Protocol<Body, Frame, Event, State>
  /** Where the request is sent. */
  readonly endpoint: Endpoint<Body>
  /** Per-request transport auth. Provider facades override this via `route.with(...)`. */
  readonly auth?: AuthDef
  /** Stream framing — bytes -> frames before `protocol.stream.event` decoding. */
  readonly framing: Framing<Frame>
  /** Static / per-request headers added before `auth` runs. */
  readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
  /** Route/request defaults used when compiling requests for this route. */
  readonly defaults?: RouteDefaultsInput
}

export interface MakeTransportInput<Body, Prepared, Frame, Event, State> {
  /** Route id used in diagnostics and prepared request metadata. */
  readonly id: string
  /** Provider identity for route-owned model construction. */
  readonly provider?: string | ProviderID
  /** Semantic API contract — owns body construction, body schema, and parsing. */
  readonly protocol: Protocol<Body, Frame, Event, State>
  /** Where the request is sent. */
  readonly endpoint: Endpoint<Body>
  /** Per-request transport auth. Provider facades override this via `route.with(...)`. */
  readonly auth?: AuthDef
  /** Static / per-request headers added before `auth` runs. */
  readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
  /** Runnable transport route. */
  readonly transport: Transport<Body, Prepared, Frame>
  /** Route/request defaults used when compiling requests for this route. */
  readonly defaults?: RouteDefaultsInput
}

const streamError = (route: string, message: string, cause: Cause.Cause<unknown>) => {
  const failed = cause.reasons.find(Cause.isFailReason)?.error
  if (failed instanceof LLMErrorClass) return failed
  return ProviderShared.eventError(route, message, Cause.pretty(cause))
}

const routeIntegrity = new WeakMap<object, () => boolean>()
const hasRouteIntegrity = (route: AnyRoute) => routeIntegrity.get(route)?.() === true

function makeFromTransport<Body, Prepared, Frame, Event, State>(
  input: MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared> {
  const protocol = input.protocol
  const protocolFunctions = [
    protocol.body.from,
    protocol.body.schema,
    protocol.stream.event,
    protocol.stream.initial,
    protocol.stream.step,
    protocol.stream.terminal,
    protocol.stream.onHalt,
  ]
  const encodeBody = Schema.encodeSync(Schema.fromJsonString(protocol.body.schema))
  const decodeEventEffect = Schema.decodeUnknownEffect(protocol.stream.event)
  const decodeEvent = (route: string) => (frame: Frame) =>
    decodeEventEffect(frame).pipe(
      Effect.mapError(() =>
        ProviderShared.eventError(
          input.id,
          `Invalid ${route} stream event`,
          typeof frame === "string" ? frame : ProviderShared.encodeJson(frame),
        ),
      ),
    )

  type BuiltRouteInput = Omit<MakeTransportInput<Body, Prepared, Frame, Event, State>, "defaults"> & {
    readonly defaults?: RouteDefaults
  }

  const build = (routeInput: BuiltRouteInput): Route<Body, Prepared> => {
    const route: Route<Body, Prepared> = {
      id: routeInput.id,
      provider: routeInput.provider === undefined ? undefined : ProviderID.make(routeInput.provider),
      protocol: protocol.id,
      endpoint: routeInput.endpoint,
      auth: routeInput.auth ?? Auth.none,
      transport: routeInput.transport,
      defaults: routeInput.defaults ?? {},
      body: protocol.body,
      with: (patch: RoutePatch<Body, Prepared>) => {
        const { id, provider, auth, transport, endpoint, ...defaults } = patch
        return build({
          ...routeInput,
          id: id ?? routeInput.id,
          provider: provider ?? routeInput.provider,
          auth: auth ?? routeInput.auth,
          endpoint: endpoint ? Endpoint.merge(routeInput.endpoint, endpoint) : routeInput.endpoint,
          transport: (transport as Transport<Body, Prepared, Frame> | undefined) ?? routeInput.transport,
          defaults: mergeRouteDefaults(route.defaults, defaults),
        })
      },
      model: (input) => makeRouteModel(route, input),
      prepareTransport: (body, request) =>
        routeInput.transport.prepare({
          body,
          request,
          endpoint: routeInput.endpoint,
          auth: routeInput.auth ?? Auth.none,
          encodeBody,
          headers: routeInput.headers,
        }),
      streamPrepared: (prepared: Prepared, request: LLMRequest, runtime: TransportRuntime) => {
        const route = `${request.model.provider}/${request.model.route.id}`
        const events = routeInput.transport
          .frames(prepared, request, runtime)
          .pipe(
            Stream.mapEffect(decodeEvent(route)),
            protocol.stream.terminal ? Stream.takeUntil(protocol.stream.terminal) : (stream) => stream,
          )
        return events.pipe(
          Stream.mapAccumEffect(
            () => protocol.stream.initial(request),
            protocol.stream.step,
            protocol.stream.onHalt ? { onHalt: protocol.stream.onHalt } : undefined,
          ),
          Stream.catchCause((cause) => Stream.fail(streamError(route, `Failed to read ${route} stream`, cause))),
        )
      },
    } satisfies Route<Body, Prepared>
    const members = [
      route.body,
      route.auth,
      route.endpoint,
      route.transport,
      route.prepareTransport,
      route.streamPrepared,
      route.transport.prepare,
      route.transport.frames,
      route.auth.apply,
      route.endpoint.path,
    ]
    const value = JSON.stringify({
      id: route.id,
      provider: route.provider,
      protocol: route.protocol,
      endpoint: route.endpoint,
      defaults: route.defaults,
    })
    routeIntegrity.set(
      route,
      () =>
        members.every(
          (member, index) =>
            member ===
            [
              route.body,
              route.auth,
              route.endpoint,
              route.transport,
              route.prepareTransport,
              route.streamPrepared,
              route.transport.prepare,
              route.transport.frames,
              route.auth.apply,
              route.endpoint.path,
            ][index],
        ) &&
        protocolFunctions.every(
          (member, index) =>
            member ===
            [
              protocol.body.from,
              protocol.body.schema,
              protocol.stream.event,
              protocol.stream.initial,
              protocol.stream.step,
              protocol.stream.terminal,
              protocol.stream.onHalt,
            ][index],
        ) &&
        value ===
          JSON.stringify({
            id: route.id,
            provider: route.provider,
            protocol: route.protocol,
            endpoint: route.endpoint,
            defaults: route.defaults,
          }),
    )
    return route
  }

  return build({ ...input, defaults: mergeRouteDefaults(undefined, input.defaults ?? {}) })
}

export function make<Body, Prepared, Frame, Event, State>(
  input: MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared>
/**
 * Build a `Route` by composing the four orthogonal pieces of a deployment:
 *
 * - `Protocol` — what is the API I'm speaking?
 * - `Endpoint` — where do I send the request?
 * - `Auth` — how do I authenticate it?
 * - `Framing` — how do I cut the response stream into protocol frames?
 *
 * Plus optional `headers` for cross-cutting deployment concerns (provider
 * version pins, per-deployment quirks).
 *
 * This is the canonical route constructor. If a new route does not fit
 * this four-axis model, add a purpose-built constructor rather than widening
 * the public surface preemptively.
 */
export function make<Body, Frame, Event, State>(
  input: MakeInput<Body, Frame, Event, State>,
): Route<Body, HttpTransport.HttpPrepared<Frame>>
export function make<Body, Prepared, Frame, Event, State>(
  input: MakeInput<Body, Frame, Event, State> | MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared> | Route<Body, HttpTransport.HttpPrepared<Frame>> {
  if ("transport" in input) return makeFromTransport(input)
  const protocol = input.protocol
  return makeFromTransport({
    id: input.id,
    provider: input.provider,
    protocol,
    endpoint: input.endpoint,
    auth: input.auth,
    headers: input.headers,
    transport: HttpTransport.httpJson({ framing: input.framing }),
    defaults: input.defaults,
  })
}

// `compile` is the important boundary: it turns a common `LLMRequest` into a
// validated provider body plus transport-private prepared data, but does not
// execute transport.
const compile = Effect.fn("LLM.compile")(function* (request: LLMRequest, native?: NativeLease) {
  const resolved = applyCachePolicy(resolveRequestOptions(request))
  const route = resolved.model.route

  const body = yield* route.body
    .from(resolved)
    .pipe(Effect.flatMap(ProviderShared.validateWith(Schema.decodeUnknownEffect(route.body.schema))))
  // The single real protocol lowering owns this snapshot. HTTP overlays run later;
  // project Work can reject a changed body without constructing a second encoded request.
  if (native) native.body = canonicalBody(body)
  const prepared = yield* route.prepareTransport(body, resolved)

  return {
    request: resolved,
    route,
    body,
    prepared,
  }
})

const prepareWith = Effect.fn("LLMClient.prepare")(function* (request: LLMRequest) {
  const compiled = yield* compile(request)

  return new PreparedRequest({
    id: compiled.request.id ?? "request",
    route: compiled.route.id,
    protocol: compiled.route.protocol,
    model: compiled.request.model,
    body: compiled.body,
    metadata: { transport: compiled.route.transport.id },
  })
})

const streamRequestWith = (runtime: TransportRuntime, native?: NativeLease) => (request: LLMRequest) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const compiled = yield* compile(request, native)
      return compiled.route.streamPrepared(compiled.prepared, compiled.request, runtime)
    }),
  )

const generateWith = (stream: Interface["stream"]) =>
  Effect.fn("LLM.generate")(function* (request: LLMRequest) {
    return new LLMResponse(
      yield* stream(request).pipe(
        Stream.runFold(
          () => ({ events: [] as LLMEvent[], usage: undefined as LLMResponse["usage"] }),
          (acc, event) => {
            acc.events.push(event)
            if ("usage" in event && event.usage !== undefined) acc.usage = event.usage
            return acc
          },
        ),
      ),
    )
  })

// Runtime middleware seam. The middleware is an Effect service owned by the caller's runtime;
// there is deliberately no module singleton or import-time registration. A plain `layer` is the
// standalone/raw SDK client, while `managedLayer` requires one explicit middleware provider.
// `generate` is always rebuilt from the selected stream so a middleware cannot be applied twice.
export type ClientStreamMiddleware = {
  readonly prepare: (next: Interface["prepare"]) => Interface["prepare"]
  readonly stream: (next: Interface["stream"]) => Interface["stream"]
}
export type ClientMiddleware = (base: Pick<Interface, "prepare" | "stream">) => ClientStreamMiddleware

export class Middleware extends Context.Service<Middleware, ClientMiddleware>()(
  "@deepagent-code/LLMClientMiddleware",
) {}

const managed = (delegate: Interface, middleware: ClientMiddleware): Interface => {
  const mw = middleware({ prepare: delegate.prepare, stream: delegate.stream })
  const stream = mw.stream(delegate.stream)
  return {
    prepare: mw.prepare(delegate.prepare),
    stream,
    generate: generateWith(stream),
  }
}

export const prepare = <Body = unknown>(request: LLMRequest) =>
  prepareWith(request) as Effect.Effect<PreparedRequestOf<Body>, LLMError>

export function stream(request: LLMRequest): Stream.Stream<LLMEvent, LLMError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      return (yield* Service).stream(request)
    }),
  ) as Stream.Stream<LLMEvent, LLMError>
}

export function generate(request: LLMRequest): Effect.Effect<LLMResponse, LLMError> {
  return Effect.gen(function* () {
    return yield* (yield* Service).generate(request)
  }) as Effect.Effect<LLMResponse, LLMError>
}

export const streamRequest = (request: LLMRequest) =>
  Stream.unwrap(
    Effect.gen(function* () {
      return (yield* Service).stream(request)
    }),
  )

const service = Effect.gen(function* () {
  const stream = streamRequestWith({
    http: yield* RequestExecutor.Service,
    webSocket: Option.getOrUndefined(yield* Effect.serviceOption(WebSocketExecutor.Service)),
  })
  return Service.of({ prepare: prepareWith as Interface["prepare"], stream, generate: generateWith(stream) })
})

export const layer: Layer.Layer<Service, never, RequestExecutor.Service> = Layer.effect(Service, service)

export const managedLayer: Layer.Layer<Service, never, RequestExecutor.Service | Middleware> = Layer.effect(
  Service,
  Effect.gen(function* () {
    return managed(yield* service, yield* Middleware)
  }),
)

type NativeLease = { active: boolean; consumed: boolean; body?: string }
type NativeClient = {
  active: boolean
  live: number
  readonly executor: RequestExecutor.Interface
  readonly requests: WeakMap<LLMRequest, NativeLease>
}
const nativeClients = new WeakMap<Interface, NativeClient>()
const nativeLimit = 32
const nativeError = () =>
  new LLMErrorClass({
    module: "LLMClient",
    method: "stream",
    reason: new InvalidRequestReason({ message: "Native client binding is unavailable" }),
  })

/** Same client service, ordinary middleware by default, explicit scoped native requests only.
 * Native requests do not enter mutable middleware. There is still one compile/transport stream. */
export const nativeManagedLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const ordinary = managed(yield* service, yield* Middleware)
    const executor = Context.get(yield* Layer.build(process.versions.bun ?
      RequestExecutor.builtinBunLayer : RequestExecutor.builtinNodeLayer), RequestExecutor.Service)
    const state: NativeClient = { active: true, live: 0, executor, requests: new WeakMap() }
    const stream: Interface["stream"] = (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const lease = state.requests.get(request)
          if (!lease) return ordinary.stream(request)
          if (!state.active || !lease.active || lease.consumed || !hasRouteIntegrity(request.model.route))
            return yield* nativeError()
          const http = RequestExecutor.forBuiltinRequest(executor, request)
          if (!http) return yield* nativeError()
          lease.consumed = true
          return streamRequestWith({ http }, lease)(request)
        }),
      )
    const client = Object.freeze(Service.of({ prepare: ordinary.prepare, stream, generate: generateWith(stream) }))
    nativeClients.set(client, state)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.active = false
        state.live = 0
      }),
    )
    return client
  }),
)

/** Construction evidence only. A signed host must additionally bind this exact client to its
 * Location, catalog result and approved installation; a copy or injected service has no entry. */
export const nativeDescription = (client: Interface) => {
  const state = nativeClients.get(client)
  const description = state?.active ? RequestExecutor.builtinDescription(state.executor) : undefined
  return description ? Object.freeze({ ...description, liveRequests: state!.live, limit: nativeLimit }) : undefined
}

/** The lease is deliberately scoped, bounded and single-use. Replaying a consumed/closed request
 * fails rather than falling through to the ordinary executor. No request body or credential is stored. */
export const bindNativeRequest = Effect.fn("LLMClient.bindNativeRequest")(function* (
  client: Interface,
  request: LLMRequest,
) {
  const state = nativeClients.get(client)
  if (
    !state?.active ||
    !RequestExecutor.builtinDescription(state.executor) ||
    state.live >= nativeLimit ||
    state.requests.has(request)
  )
    return yield* nativeError()
  const lease: NativeLease = { active: true, consumed: false }
  state.requests.set(request, lease)
  state.live++
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (!lease.active) return
      lease.active = false
      lease.body = undefined
      if (state.active) state.live--
    }),
  )
})

export const observesNative = (
  client: Interface,
  request: LLMRequest,
  observation: RequestExecutor.RequestSealInput,
) => {
  const state = nativeClients.get(client)
  const lease = state?.requests.get(request)
  return (
    !!state?.active &&
    !!lease?.active &&
    lease.consumed &&
    RequestExecutor.observesBuiltin(state.executor, request, observation)
  )
}

/** Fixed native identity check, not a public body/hash attestation. JSON copies of the
 * request or observation cannot inherit the captured protocol lowering. */
export const observesCanonicalNativeBody = (client: Interface, request: LLMRequest,
  observation: RequestExecutor.RequestSealInput,
) => {
  if (!observesNative(client, request, observation) || observation.bodyText === undefined) return false
  const lease = nativeClients.get(client)?.requests.get(request)
  if (lease?.body === undefined || observation.bodyText.length > 524_288) return false
  const body = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(observation.bodyText)
  return Option.isSome(body) && canonicalBody(body.value) === lease.body
}

function canonicalBody(value: unknown) {
  return JSON.stringify(value, (_, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item)
}

/** Fixed-purpose counter shares the exact native generation request lease and executor. */
export const countNativeInput = Effect.fn("LLMClient.countNativeInput")(function* (
  client: Interface,
  request: LLMRequest,
  observation: RequestExecutor.RequestSealInput,
  deadline: number,
) {
  const state = nativeClients.get(client)
  if (!state || !observesNative(client, request, observation)) return yield* nativeError()
  return yield* RequestExecutor.countBuiltinResponses(state.executor, request, observation, deadline)
})

export const boundNativeDeepSeekInput = Effect.fn("LLMClient.boundNativeDeepSeekInput")(function* (
  client: Interface, request: LLMRequest, observation: RequestExecutor.RequestSealInput, deadline: number,
) {
  const state = nativeClients.get(client)
  if (!state || !observesNative(client, request, observation)) return yield* nativeError()
  return yield* RequestExecutor.boundBuiltinDeepSeekResponses(state.executor, request, observation, deadline)
})

export const Route = { make, hasIntegrity: hasRouteIntegrity } as const

export const LLMClient = {
  Service,
  Middleware,
  layer,
  managedLayer,
  nativeManagedLayer,
  nativeDescription,
  bindNativeRequest,
  observesNative,
  observesCanonicalNativeBody,
  countNativeInput,
  boundNativeDeepSeekInput,
  prepare,
  stream,
  generate,
} as const
