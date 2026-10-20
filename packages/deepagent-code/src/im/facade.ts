export * as IMFacade from "./facade"

import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { HttpClient } from "effect/unstable/http"
import { IMRepository } from "@deepagent-code/core/im/repository"
import type { IMGroup, IMRepositoryError } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { validateIMName } from "@deepagent-code/core/im/facade-contract"
import { SessionV2 } from "@deepagent-code/core/session"
import * as Log from "@deepagent-code/core/util/log"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ConfigIM } from "@deepagent-code/core/config/im"
import { createHash } from "node:crypto"
import { SERVER_USER_ID } from "@/server/routes/instance/httpapi/utils/workspace-context"
import { KernelConfig } from "./kernel/config"
import { IMKernelExchange } from "./kernel/exchange"
import { IMDeviceStore } from "./device-store"
import { IMDeviceProof } from "./device-proof"
import { IMDeviceTransport } from "./device-transport"
import { Database } from "@deepagent-code/core/database/database"
import type { IMKernelReader } from "./kernel/reader"
import { IMKernelSync, kernelConvKey, parseKernelConvKey } from "./kernel/sync"
import type { KernelClient } from "./kernel/client"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRegistry } from "@/effect/instance-registry"
import { InstanceStore } from "@/project/instance-store"
import { IMServiceConfig } from "./service-config"
import { IMEntitlement } from "./entitlement"
import type { IMEntitlementSchema } from "@deepagent-code/core/im/entitlement.schema"

// IM 门面运行时（B2）：new-api /api/im/* 的客户端门户 + 内核引擎生命周期的唯一所有者。
//
// 职责：
//   1. boot 时按凭据解析结果决定状态机落点（disabled / claim_required / blocked / active），
//      并在拿到内核坐标时建成同步引擎（B1 的 boot 路径，从 server.ts 收编至此）。
//   2. claim / rename / rebind / retryExchange —— 引导流与身份管理。claim/retry 成功后热启动
//      引擎；凭证替换前关闭旧 scope，保持 jugglechat-websdk 的进程单例约束。
//   3. resolve / createGroup / openDirect / invite —— 通讯录与群管理：门面调用 + 本地
//      sqlite 镜像（群行 + 成员 + k:<type>:<id> 绑定），发送/收消息仍走 B1 引擎。
//
// 凭据策略（项⑥，以 B1 落地方案为准）：kernel_token/navigator_url 只在内存（每次启动重新
// exchange，短期凭证到期前或断线后续期，不落盘）。sk- key 来源：rebind 成功写入 auth.json（用户配置
// 目录，0o600，不落仓库）优先；否则 DEEPAGENT_IM_FACADE_KEY env 注入（dev 路径）。URL 只认
// URL 来自全局 im.url（null 显式关闭），其次 DEEPAGENT_IM_FACADE_URL，均缺省才用正式默认入口。

const log = Log.create({ service: "im-facade" })

/** auth.json 里 rebind 持久化的 key 条目（provider 位借用——Record 键任意，值是 Api 形状）。 */
export const AUTH_KEY = "im-facade"

export interface IdentityInfo {
  readonly uuid: string
  readonly name: string
  readonly orgID: number
  readonly orgAllGroupID: string
}

export type State =
  /** No effective global service, or explicitly disabled. Legacy PoC mode may still have a separate dev engine. */
  | { readonly kind: "disabled" }
  /** boot exchange 收到 409 im_not_claimed——GUI 引导认领。 */
  | { readonly kind: "claim_required" }
  /** boot exchange 其它失败（im_key_invalid / im_identity_disabled / im_unavailable / transport…）。 */
  | { readonly kind: "blocked"; readonly code: string; readonly message: string }
  /** 身份就绪（boot exchange 或 claim/rename/rebind 成功）。 */
  | { readonly kind: "active"; readonly identity: IdentityInfo }

/** status 端点的快照形状。kernel 是引擎连接状态机现值（无引擎 ⇒ None）。 */
export interface StatusSnapshot {
  readonly facade: State["kind"]
  readonly identity: Option.Option<IdentityInfo>
  readonly blocked: Option.Option<{ readonly code: string; readonly message: string }>
  readonly kernel: Option.Option<KernelClient.ConnectionState>
  readonly recovery?: IMKernelSync.RecoveryState
  readonly reader?: IMKernelReader.State
  readonly keyOrigin: "stored" | "env" | "none"
  readonly service?: typeof ConfigIM.ServiceStatus.Type
}

/** 本地前提失败（群不存在/非内核绑定群）。门面失败一律走 IMKernelExchange.ExchangeError。 */
export class GroupLookupError extends Schema.TaggedErrorClass<GroupLookupError>()("IMFacadeGroupLookupError", {
  message: Schema.String,
}) {}
export type ReaderLease = IMKernelSync.ReaderLease
export interface ReaderContext {
  readonly workspaceID: string
  readonly userID: string
  readonly directory?: string
}

export interface Interface {
  readonly state: SubscriptionRef.SubscriptionRef<State>
  /** 当前内核引擎（boot 建成或 claim/retry 后热启动）；None = 纯本地模式。发送路径每次现读。 */
  readonly engine: Ref.Ref<Option.Option<IMKernelSync.Interface>>
  readonly status: Effect.Effect<StatusSnapshot, KernelReaderSchema.Error>
  readonly plans: Effect.Effect<IMEntitlementSchema.PlansObservation>
  readonly entitlement: Effect.Effect<IMEntitlementSchema.Observation>
  readonly acquireReader: (context: ReaderContext) => Effect.Effect<ReaderLease, KernelReaderSchema.Error, Scope.Scope>
  readonly withReader: <A, E, R>(
    context: ReaderContext,
    use: (lease: ReaderLease) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | KernelReaderSchema.Error, Exclude<R, Scope.Scope>>
  /** Explicit reconnect recovery waits only for its captured live generation. */
  readonly withCurrentConnectedReader: Interface["withReader"]
  // 门面调用不向外要 HttpClient：构造期从 server 图捕获（FetchHttpClient），调用期由
  // withClient 内部提供；构造期缺席 ⇒ 门面整体 disabled，requireSource/requireActive 先 fail-closed。
  readonly claim: (name: string) => Effect.Effect<IdentityInfo, IMKernelExchange.ExchangeError>
  readonly rename: (name: string) => Effect.Effect<IdentityInfo, IMKernelExchange.ExchangeError>
  readonly rebind: (newKey: string) => Effect.Effect<IdentityInfo, IMKernelExchange.ExchangeError>
  /** 重读持久凭据并重新 exchange；先关闭旧连接，成功后替换引擎并进入 active。 */
  readonly retryExchange: Effect.Effect<IdentityInfo, IMKernelExchange.ExchangeError>
  readonly withServiceConfiguration: <A, E, R>(
    url: string | null,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | IMKernelExchange.ExchangeError, R>
  /** 通讯录精确查找（名归一化后发送）。 */
  readonly resolve: (name: string) => Effect.Effect<IMKernelExchange.ResolvePayload, IMKernelExchange.ExchangeError>
  /** 建群：门面建内核群 → 本地镜像（成员 = 解析出的 uuid ∪ 本身份 uuid ∪ server 操作者）→ 绑定。 */
  readonly createGroup: (input: {
    readonly workspaceID: string
    readonly name: string
    readonly memberNames: ReadonlyArray<string>
  }) => Effect.Effect<IMGroup, IMKernelExchange.ExchangeError | IMRepositoryError>
  /** 发起私聊：resolve → 本地 direct 群（幂等复用）→ 确保 k:1:<uuid> 绑定。 */
  readonly openDirect: (input: {
    readonly workspaceID: string
    readonly name: string
  }) => Effect.Effect<IMGroup, IMKernelExchange.ExchangeError | IMRepositoryError>
  /** 邀请：本地群必须存在且绑定 k:2: 群 → 门面按名邀请 → 本地补成员行（已是成员则幂等）。 */
  readonly invite: (input: {
    readonly groupID: string
    readonly name: string
  }) => Effect.Effect<void, IMKernelExchange.ExchangeError | IMRepositoryError | GroupLookupError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/im/Facade") {}

/** 引擎层构造函数——生产焊死真 SDK（layerFromConfig）；测试注入假引擎（见 test/im/im-facade.test.ts）。 */
export type EngineBuilder = (
  config: KernelConfig.Info,
  options?: IMKernelSync.LayerOptions,
) => Layer.Layer<
  IMKernelSync.Service,
  unknown,
  IMRepository | IMBroadcasterService | AgentListProviderService | Database.Service | InstanceRegistry.Service
>

export interface Options {
  /** Credential renewal check interval in milliseconds; defaults to 30 seconds. */
  readonly credentialRefreshInterval?: number
  readonly buildEngine?: EngineBuilder
  /** 门面坐标/PoC 配置的读取源（默认 process.env）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const invalidName = (reason: string) =>
  new IMKernelExchange.ExchangeError({
    code: "im_invalid_name",
    message: `IM name rejected by the naming rules: ${reason}（规则：1-20 个汉字/字母/数字，归一化后判定）`,
    status: 400,
    retryable: false,
  })

const toIdentity = (payload: IMKernelExchange.ExchangePayload): IdentityInfo => ({
  uuid: payload.identity.uuid,
  name: payload.identity.name,
  orgID: payload.identity.org_id,
  orgAllGroupID: payload.identity.org_all_group_id,
})

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const lifetime = yield* Scope.Scope
      const env = options?.env ?? process.env
      const protectedMedia = KernelConfig.protectedMediaFromEnv(env)
      const buildEngine = options?.buildEngine ?? IMKernelSync.layerFromConfig
      const repo = yield* IMRepository
      const database = yield* Database.Service
      const broadcaster = yield* IMBroadcasterService
      const agentListProvider = yield* AgentListProviderService
      const auth = yield* Auth.Service
      const configuration = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
      const serviceConfig = IMServiceConfig.read(
        configuration,
        env,
        options?.env?.DEEPAGENT_IM_DEVICE_TEST_LOOPBACK === "true",
        options?.buildEngine !== undefined,
      )
      const instanceStore = yield* InstanceStore.Service
      const instanceRegistry = yield* InstanceRegistry.Service
      const http = Option.getOrUndefined(yield* Effect.serviceOption(HttpClient.HttpClient))
      const device = Option.getOrUndefined(yield* Effect.serviceOption(IMDeviceStore.Service))
      const transport = device
        ? IMDeviceTransport.make({
            store: device,
            http,
            allowLoopback: options?.env?.DEEPAGENT_IM_DEVICE_TEST_LOOPBACK === "true",
          })
        : undefined
      const v2Session = Option.getOrUndefined(yield* Effect.serviceOption(SessionV2.Service))
      const entitlementScope: { value: object | undefined } = { value: {} }
      const entitlementReads = IMEntitlement.make({
        resolveURL: serviceConfig.pipe(Effect.map((value) => value.url)),
        device,
        http,
        scope: () => entitlementScope.value,
        allowLoopback: options?.env?.DEEPAGENT_IM_DEVICE_TEST_LOOPBACK === "true",
      })

      const state = yield* SubscriptionRef.make<State>({ kind: "disabled" })
      const engine = yield* Ref.make<Option.Option<IMKernelSync.Interface>>(Option.none())
      const sourceRef = yield* Ref.make<Option.Option<KernelConfig.FacadeSource>>(Option.none())
      const keyOriginRef = yield* Ref.make<"stored" | "env" | "none">("none")
      const expiresAt = yield* Ref.make<number | undefined>(undefined)
      // Backoff belongs to this facade scope only. It neither extends the
      // credential expiry nor preserves execution/read authority after revoke.
      const rateLimitedUntil = yield* Ref.make(0)
      // 引擎构建串行化：并发 claim/retry 不能触发两次 SDK 实例化（进程单例防呆会 defect）。
      const engineLock = yield* Semaphore.make(1)
      const identityLock = yield* Semaphore.make(1)
      type OwnedEngine = { scope: Scope.Closeable; closed: Deferred.Deferred<void> }
      const engineScope = yield* Ref.make<Option.Option<OwnedEngine>>(Option.none())
      // Scope marks itself Closed before asynchronous finalizers finish. Join
      // the last finalizer as well when another fiber already began closing it.
      const closeEngine = (owned: OwnedEngine, exit: Exit.Exit<unknown, unknown>) =>
        Scope.close(owned.scope, exit).pipe(Effect.ensuring(Deferred.await(owned.closed)), Effect.uninterruptible)
      const owner: { current?: { active: boolean; invalidations: Set<() => void> } } = {}
      const revokeOwner = Effect.sync(() => {
        if (owner.current) {
          owner.current.active = false
          owner.current.invalidations.forEach((invalidate) => invalidate())
          owner.current.invalidations.clear()
        }
        owner.current = undefined
      })
      const stopEngine = engineLock.withPermits(1)(
        Effect.gen(function* () {
          // Scope.close can wait for real native promises. Permission ends now.
          yield* revokeOwner
          yield* Ref.set(engine, Option.none())
          const previous = yield* Ref.getAndSet(engineScope, Option.none())
          if (Option.isSome(previous)) yield* closeEngine(previous.value, Exit.void)
        }),
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          entitlementScope.value = undefined
        }).pipe(Effect.andThen(stopEngine)),
      )

      // 引擎装配：依赖从本服务构造期上下文现取（与 B1 server.ts 接线等价的 provide 集），
      // 每代引擎独占子 scope；换凭证和 facade 关闭时都先停止旧引擎。
      const startEngine = (config: KernelConfig.Info): Effect.Effect<IMKernelSync.Interface, unknown> =>
        engineLock.withPermits(1)(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* revokeOwner
              yield* Ref.set(engine, Option.none())
              const previous = yield* Ref.getAndSet(engineScope, Option.none())
              if (Option.isSome(previous)) yield* closeEngine(previous.value, Exit.void)
              const source = yield* Ref.get(sourceRef)
              const bound = Option.isSome(source) ? source.value : undefined
              const scope = yield* Scope.fork(lifetime)
              const closed = yield* Deferred.make<void>()
              yield* Scope.addFinalizer(scope, Deferred.succeed(closed, undefined))
              const owned = { scope, closed }
              const generation = { active: true, invalidations: new Set<() => void>() }
              return yield* Effect.gen(function* () {
                if (device && bound?.device) {
                  const lease = yield* device.acquireOwner(bound.facadeURL).pipe(
                    Effect.mapError(
                      () =>
                        new IMKernelExchange.ExchangeError({
                          code: "im_owner_busy",
                          message: "This installation already has an IM owner",
                          status: 409,
                          retryable: false,
                        }),
                    ),
                  )
                  yield* Scope.addFinalizer(scope, Effect.promise(() => lease.release()).pipe(Effect.uninterruptible))
                }
                owner.current = generation
                const current = () =>
                  generation.active &&
                  owner.current === generation &&
                  scope.state._tag !== "Closed" &&
                  lifetime.state._tag !== "Closed"
                const protectedDeviceAuth: KernelConfig.ProtectedDeviceAuth | undefined =
                  device && transport && bound?.device
                    ? {
                        profile: IMDeviceProof.profile,
                        publicJwk: bound.device.publicJwk,
                        jkt: bound.device.deviceJkt,
                        socketAudience: config.socketAudience ?? "",
                        allowInsecureLoopbackForTests: options?.env?.DEEPAGENT_IM_DEVICE_TEST_LOOPBACK === "true",
                        entitlementID: bound.device.entitlementID,
                        bindingVersion: bound.device.bindingVersion,
                        signConnect: async (challenge, source) => {
                          if (!current() || source.token !== config.token || source.audience !== config.socketAudience)
                            throw new Error("IM source retired")
                          const result = await Effect.runPromise(
                            device.socket(challenge, {
                              audience: source.audience,
                              appkey: config.appkey,
                              token: source.token,
                              entitlementID: bound.device!.entitlementID,
                              bindingVersion: bound.device!.bindingVersion,
                              allowLoopback: options?.env?.DEEPAGENT_IM_DEVICE_TEST_LOOPBACK === "true",
                            }),
                          )
                          if (!current() || source.token !== config.token || source.audience !== config.socketAudience)
                            throw new Error("IM source retired")
                          return result
                        },
                        signHttp: async (request) => {
                          const target = new URL(request.url)
                          const realm = IMDeviceProof.target(
                            config.navigator,
                            options?.env?.DEEPAGENT_IM_DEVICE_TEST_LOOPBACK === "true",
                          ).replace(/\/$/, "")
                          if (
                            !current() ||
                            request.credential !== config.token ||
                            target.origin !== new URL(realm).origin ||
                            !(
                              IMDeviceProof.target(
                                target.href,
                                options?.env?.DEEPAGENT_IM_DEVICE_TEST_LOOPBACK === "true",
                              ) === realm ||
                              IMDeviceProof.target(
                                target.href,
                                options?.env?.DEEPAGENT_IM_DEVICE_TEST_LOOPBACK === "true",
                              ).startsWith(`${realm}/`)
                            )
                          )
                            throw new Error("IM target is not owned")
                          const result = await Effect.runPromise(
                            transport.headers({
                              realm: bound.facadeURL,
                              kernelRealm: realm,
                              method: request.method,
                              url: request.url,
                              purpose: "kernel-http",
                              credential: request.credential,
                              requestHash: IMDeviceProof.digest([
                                "dac.im.kernel-http.v1",
                                realm,
                                IMDeviceProof.sha256(config.token),
                                bound.device!.deviceJkt,
                              ]),
                            }),
                          )
                          if (!current() || request.credential !== config.token) throw new Error("IM source retired")
                          return result
                        },
                      }
                    : undefined
                const inspections = new Map<
                  string,
                  Deferred.Deferred<IMKernelExchange.InspectConversationPayload, IMKernelExchange.ExchangeError>
                >()
                const depsBase = Context.make(IMRepository, repo).pipe(
                  Context.add(IMBroadcasterService, broadcaster),
                  Context.add(AgentListProviderService, agentListProvider),
                  Context.add(Database.Service, database),
                  Context.add(InstanceRegistry.Service, instanceRegistry),
                )
                const deps = v2Session ? depsBase.pipe(Context.add(SessionV2.Service, v2Session)) : depsBase
                const built = yield* restore(
                  Layer.buildWithScope(
                    Layer.provide(
                      buildEngine(
                        { ...config, protectedMedia, protectedDeviceAuth },
                        {
                          ownerCurrent: current,
                          onOwnerRevoked: (invalidate) => {
                            if (current()) generation.invalidations.add(invalidate)
                            if (!current()) invalidate()
                            return () => {
                              generation.invalidations.delete(invalidate)
                            }
                          },
                          inspectConversation: config.identity
                            ? (input) =>
                                Effect.gen(function* () {
                                  const source = yield* Ref.get(sourceRef)
                                  const unavailable = () =>
                                    new IMKernelExchange.ExchangeError({
                                      code: "im_unavailable",
                                      message: "Conversation verification is unavailable",
                                      retryable: true,
                                    })
                                  if (!http || Option.isNone(source) || !current() || source.value !== bound)
                                    return yield* unavailable()
                                  const captured = source.value
                                  const key = JSON.stringify([
                                    captured.facadeURL,
                                    config.userID,
                                    input.senderID ?? null,
                                    input.conversationType,
                                    input.conversationID,
                                    "inspect",
                                  ])
                                  // Admission and worker startup cannot be interrupted between
                                  // publishing the pending entry and owning its completion.
                                  const pending = yield* Effect.uninterruptible(
                                    Effect.suspend(() => {
                                      const previous = inspections.get(key)
                                      if (previous) return Effect.succeed(previous)
                                      const pending = Deferred.makeUnsafe<
                                        IMKernelExchange.InspectConversationPayload,
                                        IMKernelExchange.ExchangeError
                                      >()
                                      inspections.set(key, pending)
                                      return Deferred.complete(
                                        pending,
                                        IMKernelExchange.inspectConversation({
                                          ...captured,
                                          ...input,
                                        }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
                                      ).pipe(
                                        Effect.ensuring(
                                          Effect.sync(() => {
                                            if (inspections.get(key) === pending) inspections.delete(key)
                                          }),
                                        ),
                                        Effect.forkIn(scope),
                                        Effect.as(pending),
                                      )
                                    }),
                                  )
                                  const result = yield* Deferred.await(pending)
                                  const after = yield* Ref.get(sourceRef)
                                  if (!current() || Option.isNone(after) || after.value !== captured)
                                    return yield* unavailable()
                                  return result
                                })
                            : undefined,
                        },
                      ),
                      Layer.succeedContext(deps),
                    ),
                    scope,
                  ),
                )
                yield* Ref.set(engineScope, Option.some(owned))
                const instance = Context.get(built, IMKernelSync.Service)
                yield* Ref.set(engine, Option.some(instance))
                log.info("kernel sync engine started", { userID: config.userID, identity: config.identity?.name })
                return instance
              }).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? Effect.gen(function* () {
                        generation.active = false
                        generation.invalidations.forEach((invalidate) => invalidate())
                        generation.invalidations.clear()
                        if (owner.current === generation) owner.current = undefined
                        yield* Ref.set(engine, Option.none())
                        yield* Ref.set(engineScope, Option.none())
                        yield* closeEngine(owned, exit)
                      })
                    : Effect.void,
                ),
              )
            }),
          ),
        )

      // Resolve the global realm again on explicit reconnect; never adopt project coordinates.
      // 两边都没有 ⇒ fail-closed disabled（半截配置绝不连接，与 B1 一致；不打日志 value——key 是凭证）。
      const resolveSource = Effect.gen(function* () {
        const service = yield* serviceConfig
        const facadeURL = service.url
        if (!facadeURL) return Option.none<KernelConfig.FacadeSource>()
        if (!options?.buildEngine || device) {
          if (!device || !transport)
            return yield* new IMKernelExchange.ExchangeError({
              code: "im_device_store_unavailable",
              message: "IM native custody is unavailable",
              retryable: false,
            })
          const realm = yield* Effect.try({
            try: () =>
              IMDeviceProof.target(facadeURL, options?.env?.DEEPAGENT_IM_DEVICE_TEST_LOOPBACK === "true").replace(
                /\/$/,
                "",
              ),
            catch: () =>
              new IMKernelExchange.ExchangeError({
                code: "im_device_target_invalid",
                message: "IM platform realm is invalid",
                retryable: false,
              }),
          })
          const saved = yield* device.get(realm, "login").pipe(
            Effect.mapError(
              () =>
                new IMKernelExchange.ExchangeError({
                  code: "im_device_store_unavailable",
                  message: "IM native custody is unavailable",
                  retryable: false,
                }),
            ),
          )
          if (!saved)
            return yield* new IMKernelExchange.ExchangeError({
              code: "im_activation_required",
              message: "Activate IM or bind an existing paid entitlement on this installation",
              status: 409,
              retryable: false,
            })
          const decoded = Schema.decodeUnknownOption(
            Schema.fromJsonString(
              Schema.Struct({
                profile: Schema.Literal(IMDeviceProof.profile),
                imCredential: Schema.String.check(Schema.isPattern(/^iml2\.[a-f0-9]{64}$/)),
                entitlementID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
                deviceJkt: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
                bindingVersion: Schema.Int.check(Schema.isGreaterThan(0)),
                uuid: Schema.String,
              }),
            ),
          )(saved)
          const key = yield* device.identity.pipe(
            Effect.mapError(
              () =>
                new IMKernelExchange.ExchangeError({
                  code: "im_device_store_unavailable",
                  message: "IM device key is unavailable",
                  retryable: false,
                }),
            ),
          )
          if (Option.isNone(decoded) || decoded.value.deviceJkt !== key.jkt)
            return yield* new IMKernelExchange.ExchangeError({
              code: "im_device_proof_invalid",
              message: "IM login does not belong to this installation",
              retryable: false,
            })
          const login = decoded.value
          yield* Ref.set(keyOriginRef, "stored")
          return Option.some<KernelConfig.FacadeSource>({
            facadeURL: realm,
            key: login.imCredential,
            device: {
              profile: login.profile,
              publicJwk: key.publicJwk,
              entitlementID: login.entitlementID,
              deviceJkt: login.deviceJkt,
              bindingVersion: login.bindingVersion,
              uuid: login.uuid,
              headers: (request) =>
                transport.headers({
                  ...request,
                  realm,
                  purpose: "login",
                  credential: login.imCredential,
                  requestHash: IMDeviceProof.digest([
                    "dac.im.login.v2",
                    realm,
                    IMDeviceProof.sha256(login.imCredential),
                    login.deviceJkt,
                  ]),
                }),
            },
          })
        }
        const stored = yield* auth.get(AUTH_KEY).pipe(
          Effect.map((info) =>
            info?.type === "api" &&
            ((!info.metadata?.imSource && service.source === "environment") ||
              info.metadata?.imSource ===
                createHash("sha256")
                  .update(JSON.stringify(new URL(facadeURL).href.replace(/\/+$/, "")))
                  .digest("hex"))
              ? info.key
              : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
        )
        const envKey = service.source === "environment" ? env[KernelConfig.facadeEnvKeys.key] : undefined
        const key = stored ?? envKey
        if (!key) {
          log.warn(
            "DEEPAGENT_IM_FACADE_URL is set but no facade key is available (auth.json override or DEEPAGENT_IM_FACADE_KEY) — IM facade disabled",
          )
          return Option.none<KernelConfig.FacadeSource>()
        }
        yield* Ref.set(keyOriginRef, stored ? "stored" : "env")
        return Option.some<KernelConfig.FacadeSource>({ facadeURL, key })
      })

      const exchangeOnce = (source: KernelConfig.FacadeSource) =>
        IMKernelExchange.exchange(source).pipe(
          Effect.retry({
            while: (error) => error.retryable,
            schedule: Schedule.exponential("1 second").pipe(Schedule.both(Schedule.recurs(2))),
          }),
          Effect.tap(() => Ref.set(rateLimitedUntil, 0)),
          Effect.tapError((error) =>
            Ref.set(
              rateLimitedUntil,
              error.status === 429
                ? Math.min(Number.MAX_SAFE_INTEGER, performance.now() + (error.retryAfterMs ?? 30_000))
                : 0,
            ),
          ),
        )

      // 构造期捕获的 HttpClient 内供所有门面调用；缺席（无 URL 或图里无 HttpClient）⇒
      // requireSource 先行失败，这里只是类型收窄的兜底。
      const withClient = <A, E>(
        effect: Effect.Effect<A, E, HttpClient.HttpClient>,
      ): Effect.Effect<A, E | IMKernelExchange.ExchangeError> =>
        http
          ? Effect.provideService(effect, HttpClient.HttpClient, http)
          : Effect.fail(
              new IMKernelExchange.ExchangeError({
                code: "im_unavailable",
                message: "the server graph has no HttpClient — IM facade calls are impossible",
                status: 503,
                retryable: false,
              }),
            )

      // exchange 成功 ⇒ active + 引擎替换。引擎启动失败不拖垮激活——身份已认领是事实，
      // engine 缺席由 status.kernel=None 表达（GUI 给重试入口；retry/restart 会再建）。
      const activate = Effect.fn("IMFacade.activate")(function* (payload: IMKernelExchange.ExchangePayload) {
        const identity = toIdentity(payload)
        yield* Ref.set(expiresAt, payload.credential_expires_at)
        yield* SubscriptionRef.set(state, { kind: "active", identity })
        yield* startEngine({
          ...IMKernelExchange.toKernelConfig(payload),
          socketAudience: payload.device?.socketAudience,
        }).pipe(
          Effect.catch((error) => {
            if (error instanceof IMKernelExchange.ExchangeError && error.code === "im_owner_busy")
              return SubscriptionRef.set(state, { kind: "blocked", code: error.code, message: error.message }).pipe(
                Effect.andThen(Effect.fail(error)),
              )
            return Effect.sync(() =>
              log.error("kernel engine start failed", {
                message: error instanceof Error ? error.message : String(error),
              }),
            )
          }),
        )
        return identity
      })

      // boot：exchange 的失败不落错误通道（绝不阻塞 server 启动），落可重试的状态机。
      const boot = Effect.gen(function* () {
        const sourceOption = yield* resolveSource
        if (Option.isNone(sourceOption)) {
          // B1 PoC 直连 env 注入：无组织身份，门面功能关闭，引擎照跑。
          const poc =
            (yield* serviceConfig).source !== "config" &&
            env.DEEPAGENT_IM_ALLOW_UNPAID_DEV_KERNEL === "true" &&
            process.env.NODE_ENV !== "production"
              ? KernelConfig.fromEnv(env)
              : undefined
          if (poc)
            yield* startEngine(poc).pipe(
              Effect.catch((error) =>
                Effect.sync(() =>
                  log.error("PoC kernel engine start failed", {
                    message: error instanceof Error ? error.message : String(error),
                  }),
                ),
              ),
            )
          return
        }
        const source = sourceOption.value
        if (!http) {
          log.warn("facade configured but the server graph has no HttpClient — IM facade disabled")
          return
        }
        // sourceRef 只在 HttpClient 在场时落——source 在场即保证门面调用可以发出（withClient 兜底）。
        yield* Ref.set(sourceRef, Option.some(source))
        const outcome = yield* Effect.result(withClient(exchangeOnce(source)))
        if (Result.isSuccess(outcome)) {
          yield* activate(outcome.success)
          return
        }
        const error = outcome.failure
        if (error.code === "im_not_claimed") {
          yield* SubscriptionRef.set(state, { kind: "claim_required" })
          log.info("IM identity not claimed for this key — the GUI will offer the claim flow (POST /api/im/claim)")
          return
        }
        yield* SubscriptionRef.set(state, { kind: "blocked", code: error.code, message: error.message })
        log.warn(
          `facade exchange failed (${error.code}): ${error.message} — kernel integration disabled for this boot (refresh-on-restart)`,
        )
      })

      // 门面调用前提：需要有效 source（claim 只要求 key 有效，不要求已认领）。
      const requireSource = Effect.gen(function* () {
        const current = yield* Ref.get(sourceRef)
        if (Option.isSome(current)) return current.value
        return yield* new IMKernelExchange.ExchangeError({
          code: "im_unavailable",
          message: "IM service is disabled or has no credential for its selected address",
          status: 503,
          retryable: false,
        })
      })

      // 身份前提：rename/rebind/群操作要求已认领。未认领 ⇒ im_not_claimed；blocked ⇒ 原码透传
      // （UI 按码给文案，如 im_identity_disabled → 身份封禁）。
      const requireActive = Effect.gen(function* () {
        const source = yield* requireSource
        const current = yield* SubscriptionRef.get(state)
        if (current.kind === "active") return { source, identity: current.identity }
        if (current.kind === "claim_required")
          return yield* new IMKernelExchange.ExchangeError({
            code: "im_not_claimed",
            message: "IM identity not claimed for this key — claim first",
            status: 409,
            retryable: false,
          })
        if (current.kind === "blocked")
          return yield* new IMKernelExchange.ExchangeError({
            code: current.code,
            message: current.message,
            retryable: false,
          })
        return yield* new IMKernelExchange.ExchangeError({
          code: "im_unavailable",
          message: "IM facade is not configured",
          status: 503,
          retryable: false,
        })
      })

      const validatedName = (raw: string) => {
        const validated = validateIMName(raw)
        return validated.ok ? Effect.succeed(validated.name) : Effect.fail(invalidName(validated.reason))
      }

      const retryExchange = identityLock.withPermits(1)(
        Effect.gen(function* () {
          // A console inheritance may have replaced auth.json since boot. Retire the old connection
          // before consulting the newly resolved source, including when the replacement is rejected.
          yield* stopEngine
          const remaining = (yield* Ref.get(rateLimitedUntil)) - performance.now()
          if (remaining > 0) {
            const error = new IMKernelExchange.ExchangeError({
              code: "im_unavailable",
              status: 429,
              message: "The IM facade is temporarily rate limited. Retry after the server wait window.",
              retryable: false,
              retryAfterMs: Math.ceil(remaining),
            })
            yield* SubscriptionRef.set(state, { kind: "blocked", code: error.code, message: error.message })
            return yield* error
          }
          const source = yield* resolveSource.pipe(
            Effect.tapError((error) =>
              Ref.set(sourceRef, Option.none()).pipe(
                Effect.andThen(
                  SubscriptionRef.set(state, { kind: "blocked", code: error.code, message: error.message }),
                ),
              ),
            ),
          )
          yield* Ref.set(sourceRef, source)
          if (Option.isNone(source) && (yield* serviceConfig).url === null) {
            yield* SubscriptionRef.set(state, { kind: "disabled" })
            return yield* new IMKernelExchange.ExchangeError({
              code: "im_unavailable",
              message: "IM service is disabled",
              status: 503,
              retryable: false,
            })
          }
          const outcome = yield* Effect.result(
            Option.isSome(source)
              ? withClient(exchangeOnce(source.value))
              : Effect.fail(
                  new IMKernelExchange.ExchangeError({
                    code: "im_unavailable",
                    message: "No IM facade credential is configured",
                    status: 503,
                    retryable: false,
                  }),
                ),
          )
          if (Result.isFailure(outcome)) {
            const error = outcome.failure
            yield* SubscriptionRef.set(
              state,
              error.code === "im_not_claimed"
                ? { kind: "claim_required" }
                : { kind: "blocked", code: error.code, message: error.message },
            )
            return yield* error
          }
          return yield* activate(outcome.success)
        }),
      )

      const withServiceConfiguration = <A, E, R>(url: string | null, effect: Effect.Effect<A, E, R>) =>
        identityLock
          .withPermitsIfAvailable(1)(
            Effect.gen(function* () {
              const previous = yield* serviceConfig.pipe(Effect.orElseSucceed(() => ({ url: null })))
              if (previous.url === url) return yield* effect
              // Revoke before waiting for asynchronous Native/SDK finalizers or persisting the new realm.
              entitlementScope.value = undefined
              yield* revokeOwner
              yield* Ref.set(sourceRef, Option.none())
              yield* Ref.set(keyOriginRef, "none")
              yield* Ref.set(expiresAt, undefined)
              yield* Ref.set(rateLimitedUntil, 0)
              yield* SubscriptionRef.set(
                state,
                url === null
                  ? { kind: "disabled" }
                  : {
                      kind: "blocked",
                      code: "im_service_changed",
                      message: "IM service changed; reconnect explicitly to use this address",
                    },
              )
              yield* stopEngine
              return yield* effect.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    entitlementScope.value = {}
                  }),
                ),
              )
            }),
          )
          .pipe(
            Effect.flatMap((result) =>
              Option.isSome(result)
                ? Effect.succeed(result.value)
                : Effect.fail(
                    new IMKernelExchange.ExchangeError({
                      code: "im_service_busy",
                      message: "An IM identity operation is still in progress",
                      status: 409,
                      retryable: false,
                    }),
                  ),
            ),
          )

      yield* boot.pipe(
        Effect.catch((error) =>
          SubscriptionRef.set(state, { kind: "blocked", code: error.code, message: error.message }),
        ),
      )

      const acquireReader = (context: ReaderContext) =>
        Effect.gen(function* () {
          const actual = yield* InstanceRef
          if (!actual) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
          const workspaceID = (yield* InstanceState.workspaceID) ?? actual.directory
          if (
            context.workspaceID !== workspaceID ||
            context.userID !== SERVER_USER_ID ||
            (context.directory !== undefined && context.directory !== actual.directory) ||
            (yield* instanceStore.peek(actual.directory)) !== actual
          )
            return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
          const current = Option.getOrUndefined(yield* Ref.get(engine))
          if (!current?.acquireReader) return yield* KernelReaderSchema.failure("reader_unavailable", "workspace-lease")
          return yield* current.acquireReader({
            instance: actual,
            workspaceID,
            userID: SERVER_USER_ID,
            instanceCurrent: instanceStore.peek(actual.directory).pipe(Effect.map((value) => value === actual)),
          })
        })
      const withReader: Interface["withReader"] = (context, use) =>
        Effect.scoped(Effect.flatMap(acquireReader(context), use))
      const withCurrentConnectedReader: Interface["withReader"] = (context, use) =>
        Effect.scoped(
          Effect.gen(function* () {
            const generation = owner.current
            const captured = Option.getOrUndefined(yield* Ref.get(engine))
            if (!captured || !generation?.active)
              return yield* KernelReaderSchema.failure("reader_unavailable", "workspace-lease")
            const assertOwner = Effect.gen(function* () {
              if (
                !generation.active ||
                owner.current !== generation ||
                Option.getOrUndefined(yield* Ref.get(engine)) !== captured
              )
                return yield* KernelReaderSchema.failure("reader_unavailable", "workspace-lease")
            })
            yield* assertOwner
            // Engine creation starts the SDK handshake asynchronously. The original
            // connect bound applies here; retirement cancels the wait immediately.
            yield* Effect.raceFirst(
              SubscriptionRef.changes(captured.state).pipe(
                Stream.filter((connection) => connection !== "connecting"),
                Stream.runHead,
                Effect.flatMap((connection) =>
                  Option.isSome(connection) && connection.value === "connected"
                    ? Effect.void
                    : KernelReaderSchema.failure("reader_unavailable", "current"),
                ),
              ),
              Effect.callback<void, KernelReaderSchema.Error>((resume) => {
                const invalidate = () => resume(KernelReaderSchema.failure("reader_unavailable", "workspace-lease"))
                generation.invalidations.add(invalidate)
                if (!generation.active || owner.current !== generation) invalidate()
                return Effect.sync(() => {
                  generation.invalidations.delete(invalidate)
                })
              }),
            ).pipe(
              Effect.timeoutOrElse({
                duration: "20 seconds",
                orElse: () => KernelReaderSchema.failure("reader_unavailable", "current"),
              }),
            )
            yield* assertOwner
            return yield* withReader(context, (lease) =>
              assertOwner.pipe(
                Effect.andThen(use(lease)),
                Effect.tap(() => assertOwner),
              ),
            )
          }),
        )
      const currentReaderContext = Effect.gen(function* () {
        const actual = yield* InstanceRef
        if (!actual) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
        return {
          workspaceID: (yield* InstanceState.workspaceID) ?? actual.directory,
          userID: SERVER_USER_ID,
          directory: actual.directory,
        }
      })
      const exchangeReaderError = (error: KernelReaderSchema.Error) =>
        new IMKernelExchange.ExchangeError({
          code: "im_unavailable",
          message: "Protected delivery reader is unavailable",
          retryable: true,
        })

      yield* Effect.gen(function* () {
        const backoff = yield* Ref.get(rateLimitedUntil)
        if (backoff > performance.now()) return
        const expiration = yield* Ref.get(expiresAt)
        if (expiration === undefined && backoff === 0) return
        const running = yield* Ref.get(engine)
        const connection = Option.isSome(running) ? yield* SubscriptionRef.get(running.value.state) : undefined
        if (
          backoff === 0 &&
          expiration !== undefined &&
          Date.now() < expiration * 1_000 - 60_000 &&
          connection !== "failed" &&
          connection !== "disconnected"
        )
          return
        yield* retryExchange.pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              log.warn("IM credential refresh failed; connection remains closed until retry", { code: error.code }),
            ),
          ),
        )
      }).pipe(Effect.repeat(Schedule.spaced(options?.credentialRefreshInterval ?? 30_000)), Effect.forkScoped)

      return Service.of({
        state,
        engine,
        acquireReader,
        withReader,
        withCurrentConnectedReader,
        status: Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state)
          const service = yield* serviceConfig.pipe(
            Effect.orElseSucceed(() => ({ url: null, source: "none" as const })),
          )
          const running = yield* Ref.get(engine)
          const actual = yield* InstanceRef
          const observed =
            actual && Option.isSome(running)
              ? yield* withReader(yield* currentReaderContext, (lease) => SubscriptionRef.get(lease.reader.state))
              : undefined
          const kernel = Option.isSome(running)
            ? Option.some(yield* SubscriptionRef.get(running.value.state))
            : Option.none()
          return {
            facade: current.kind,
            identity: current.kind === "active" ? Option.some(current.identity) : Option.none(),
            blocked:
              current.kind === "blocked"
                ? Option.some({ code: current.code, message: current.message })
                : Option.none(),
            kernel,
            ...(observed
              ? {
                  reader: observed,
                  recovery:
                    observed.state === "ready"
                      ? { status: "ready" as const }
                      : observed.state === "unavailable"
                        ? { status: "failed" as const, message: "Remote conversation is currently unavailable" }
                        : { status: "pending" as const },
                }
              : {}),
            keyOrigin: yield* Ref.get(keyOriginRef),
            service: {
              ...service,
              reconnectRequired: current.kind === "blocked" && current.code === "im_service_changed",
            },
          } satisfies StatusSnapshot
        }),
        claim: (raw) =>
          identityLock.withPermits(1)(
            Effect.gen(function* () {
              const source = yield* requireSource
              const name = yield* validatedName(raw)
              if (source.device)
                return yield* new IMKernelExchange.ExchangeError({
                  code: "im_activation_required",
                  message: "Use explicit paid activation",
                  status: 409,
                  retryable: false,
                })
              return yield* activate(yield* withClient(IMKernelExchange.claim({ ...source, name })))
            }),
          ),
        rename: (raw) =>
          identityLock.withPermits(1)(
            Effect.gen(function* () {
              const { source } = yield* requireActive
              const name = yield* validatedName(raw)
              const payload = yield* withClient(IMKernelExchange.rename({ ...source, name }))
              return yield* activate(payload)
            }),
          ),
        rebind: (newKey) =>
          identityLock.withPermits(1)(
            Effect.gen(function* () {
              const { source } = yield* requireActive
              const key = newKey.trim()
              if (!key)
                return yield* new IMKernelExchange.ExchangeError({
                  code: "invalid_request",
                  message: "the new key must not be empty",
                  status: 400,
                  retryable: false,
                })
              if (key === source.key)
                return yield* new IMKernelExchange.ExchangeError({
                  code: "invalid_request",
                  message: "the new key is the key currently in use",
                  status: 400,
                  retryable: false,
                })
              if (source.device)
                return yield* new IMKernelExchange.ExchangeError({
                  code: "im_device_binding_immutable",
                  message: "This release does not transfer device bindings",
                  status: 409,
                  retryable: false,
                })
              const payload = yield* withClient(IMKernelExchange.rebind({ ...source, newKey: key }))
              // 身份已在门面侧迁移 ⇒ 后续门面调用立即改用新 key；持久化（auth.json，0o600）供下次
              // 启动优先于 env。server mode 禁写 auth.json（gateway 托管 key）——记日志后继续。
              yield* Ref.set(sourceRef, Option.some({ facadeURL: source.facadeURL, key }))
              yield* auth
                .set(
                  AUTH_KEY,
                  new Auth.Api({
                    type: "api",
                    key,
                    metadata: { imSource: createHash("sha256").update(JSON.stringify(source.facadeURL)).digest("hex") },
                  }),
                )
                .pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => log.warn("failed to persist the rebound IM key", { message: error.message })),
                  ),
                  Effect.ignore,
                  Effect.andThen(Ref.set(keyOriginRef, "stored")),
                )
              return yield* activate(payload)
            }),
          ),
        retryExchange,
        withServiceConfiguration,
        plans: entitlementReads.plans,
        entitlement: entitlementReads.entitlement,
        resolve: (raw) =>
          Effect.gen(function* () {
            const { source } = yield* requireActive
            const name = yield* validatedName(raw)
            return yield* withClient(IMKernelExchange.resolve({ ...source, name }))
          }),
        createGroup: (input) =>
          withReader({ workspaceID: input.workspaceID, userID: SERVER_USER_ID }, (lease) =>
            Effect.gen(function* () {
              const active = yield* requireActive
              const name = yield* validatedName(input.name)
              const memberNames = input.memberNames.flatMap((raw) => {
                const validated = validateIMName(raw)
                return validated.ok ? [validated.name] : []
              })
              yield* lease.assertCurrent
              yield* lease.reader.verifyScope
              const created = yield* withClient(IMKernelExchange.createGroup({ ...active.source, name, memberNames }))
              yield* lease.assertCurrent
              const groupID = yield* lease.reader.pending({
                conversationType: 2,
                conversationID: created.group_id,
                name: created.name,
              })
              return yield* lease.reader
                .withOutput(
                  { workspaceID: lease.workspaceID, userID: lease.userID, groupIDs: [groupID] },
                  repo.getGroup({ groupID, userID: lease.userID }),
                )
                .pipe(
                  Effect.flatMap((group) =>
                    group
                      ? Effect.succeed(group)
                      : Effect.fail(new GroupLookupError({ message: "Protected conversation is unavailable" })),
                  ),
                )
            }),
          ).pipe(
            Effect.catchIf(
              (error) => error instanceof KernelReaderSchema.Error,
              (error) => Effect.fail(exchangeReaderError(error)),
            ),
          ),
        openDirect: (input) =>
          withReader({ workspaceID: input.workspaceID, userID: SERVER_USER_ID }, (lease) =>
            Effect.gen(function* () {
              const active = yield* requireActive
              const name = yield* validatedName(input.name)
              yield* lease.assertCurrent
              yield* lease.reader.verifyScope
              const peer = yield* withClient(IMKernelExchange.resolve({ ...active.source, name }))
              yield* lease.assertCurrent
              if (peer.uuid === active.identity.uuid)
                return yield* new IMKernelExchange.ExchangeError({
                  code: "invalid_request",
                  message: "cannot open a direct chat with yourself",
                  status: 400,
                  retryable: false,
                })
              const groupID = yield* lease.reader.pending({
                conversationType: 1,
                conversationID: peer.uuid,
                name: peer.name,
              })
              return yield* lease.reader
                .withOutput(
                  { workspaceID: lease.workspaceID, userID: lease.userID, groupIDs: [groupID] },
                  repo.getGroup({ groupID, userID: lease.userID }),
                )
                .pipe(
                  Effect.flatMap((group) =>
                    group
                      ? Effect.succeed(group)
                      : Effect.fail(new GroupLookupError({ message: "Protected conversation is unavailable" })),
                  ),
                )
            }),
          ).pipe(
            Effect.catchIf(
              (error) => error instanceof KernelReaderSchema.Error,
              (error) => Effect.fail(exchangeReaderError(error)),
            ),
          ),
        invite: (input) =>
          Effect.gen(function* () {
            const context = yield* currentReaderContext
            return yield* withReader(context, (lease) =>
              Effect.gen(function* () {
                const active = yield* requireActive
                const name = yield* validatedName(input.name)
                const group = yield* repo.getGroupByID(input.groupID)
                if (!group || group.workspaceID !== lease.workspaceID)
                  return yield* new GroupLookupError({ message: "Protected conversation is unavailable" })
                const conversation = group.kernelConvID?.startsWith("kr1:")
                  ? yield* lease.reader.conversation(group.id)
                  : undefined
                if (!conversation || conversation.conversationType !== 2)
                  return yield* new GroupLookupError({ message: "Protected conversation is unavailable" })
                yield* lease.assertCurrent
                yield* lease.reader.verifyScope
                const peer = yield* withClient(IMKernelExchange.resolve({ ...active.source, name }))
                yield* lease.assertCurrent
                yield* withClient(
                  IMKernelExchange.inviteToGroup({
                    ...active.source,
                    groupID: conversation.conversationID,
                    name: peer.name,
                  }),
                )
                yield* lease.assertCurrent
                yield* repo
                  .addMember({ groupID: group.id, memberID: peer.uuid, memberType: "user", role: "member" })
                  .pipe(
                    Effect.catch((error) =>
                      Effect.sync(() => log.warn("local member row insert skipped", { message: error.message })),
                    ),
                  )
              }),
            )
          }).pipe(
            Effect.catchIf(
              (error) => error instanceof KernelReaderSchema.Error,
              (error) => Effect.fail(exchangeReaderError(error)),
            ),
          ),
      })
    }),
  )
