export * as IMFacade from "./facade"

import {
  Context,
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
import { createHash } from "node:crypto"
import { SERVER_USER_ID } from "@/server/routes/instance/httpapi/utils/workspace-context"
import { KernelConfig } from "./kernel/config"
import { IMKernelExchange } from "./kernel/exchange"
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
// DEEPAGENT_IM_FACADE_URL env。

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
  /** 门面未配置（无 DEEPAGENT_IM_FACADE_URL；含 B1 PoC 直连模式——引擎可能在跑但门面功能关闭）。 */
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
}

/** 本地前提失败（群不存在/非内核绑定群）。门面失败一律走 IMKernelExchange.ExchangeError。 */
export class GroupLookupError extends Schema.TaggedErrorClass<GroupLookupError>()("IMFacadeGroupLookupError", {
  message: Schema.String,
}) {}
export type ReaderLease = IMKernelSync.ReaderLease
export interface ReaderContext { readonly workspaceID: string; readonly userID: string; readonly directory?: string }

export interface Interface {
  readonly state: SubscriptionRef.SubscriptionRef<State>
  /** 当前内核引擎（boot 建成或 claim/retry 后热启动）；None = 纯本地模式。发送路径每次现读。 */
  readonly engine: Ref.Ref<Option.Option<IMKernelSync.Interface>>
  readonly status: Effect.Effect<StatusSnapshot, KernelReaderSchema.Error>
  readonly acquireReader: (context: ReaderContext) => Effect.Effect<ReaderLease, KernelReaderSchema.Error, Scope.Scope>
  readonly withReader: <A, E, R>(context: ReaderContext, use: (lease: ReaderLease) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | KernelReaderSchema.Error, Exclude<R, Scope.Scope>>
  // 门面调用不向外要 HttpClient：构造期从 server 图捕获（FetchHttpClient），调用期由
  // withClient 内部提供；构造期缺席 ⇒ 门面整体 disabled，requireSource/requireActive 先 fail-closed。
  readonly claim: (name: string) => Effect.Effect<IdentityInfo, IMKernelExchange.ExchangeError>
  readonly rename: (name: string) => Effect.Effect<IdentityInfo, IMKernelExchange.ExchangeError>
  readonly rebind: (newKey: string) => Effect.Effect<IdentityInfo, IMKernelExchange.ExchangeError>
  /** 重读持久凭据并重新 exchange；先关闭旧连接，成功后替换引擎并进入 active。 */
  readonly retryExchange: Effect.Effect<IdentityInfo, IMKernelExchange.ExchangeError>
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
) => Layer.Layer<IMKernelSync.Service, unknown, IMRepository | IMBroadcasterService | AgentListProviderService | Database.Service | InstanceRegistry.Service>

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
      const env = options?.env ?? process.env
      const protectedMedia = KernelConfig.protectedMediaFromEnv(env)
      const buildEngine = options?.buildEngine ?? IMKernelSync.layerFromConfig
      const repo = yield* IMRepository
      const database = yield* Database.Service
      const broadcaster = yield* IMBroadcasterService
      const agentListProvider = yield* AgentListProviderService
      const auth = yield* Auth.Service
      const instanceStore = yield* InstanceStore.Service
      const instanceRegistry = yield* InstanceRegistry.Service
      const http = Option.getOrUndefined(yield* Effect.serviceOption(HttpClient.HttpClient))
      const v2Session = Option.getOrUndefined(yield* Effect.serviceOption(SessionV2.Service))

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
      const engineScope = yield* Ref.make<Option.Option<Scope.Closeable>>(Option.none())
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
          if (Option.isSome(previous)) yield* Scope.close(previous.value, Exit.void)
        }),
      )
      yield* Effect.addFinalizer(() => stopEngine)

      // 引擎装配：依赖从本服务构造期上下文现取（与 B1 server.ts 接线等价的 provide 集），
      // 每代引擎独占子 scope；换凭证和 facade 关闭时都先停止旧引擎。
      const startEngine = (config: KernelConfig.Info): Effect.Effect<IMKernelSync.Interface, unknown> =>
        engineLock.withPermits(1)(
          Effect.gen(function* () {
            yield* revokeOwner
            yield* Ref.set(engine, Option.none())
            const previous = yield* Ref.getAndSet(engineScope, Option.none())
            if (Option.isSome(previous)) yield* Scope.close(previous.value, Exit.void)
            const scope = yield* Scope.make()
            const generation = { active: true, invalidations: new Set<() => void>() }
            owner.current = generation
            const depsBase = Context.make(IMRepository, repo).pipe(
              Context.add(IMBroadcasterService, broadcaster),
              Context.add(AgentListProviderService, agentListProvider),
              Context.add(Database.Service, database),
              Context.add(InstanceRegistry.Service, instanceRegistry),
            )
            const deps = v2Session ? depsBase.pipe(Context.add(SessionV2.Service, v2Session)) : depsBase
            const built = yield* Layer.buildWithScope(
              Layer.provide(
                buildEngine({ ...config, protectedMedia }, {
                  ownerCurrent: () => generation.active && owner.current === generation,
                  onOwnerRevoked: (invalidate) => {
                    if (generation.active) generation.invalidations.add(invalidate)
                    if (!generation.active) invalidate()
                    return () => { generation.invalidations.delete(invalidate) }
                  },
                  inspectConversation: config.identity
                    ? (input) =>
                        Effect.gen(function* () {
                          const source = yield* Ref.get(sourceRef)
                          if (!http || Option.isNone(source))
                            return yield* new IMKernelExchange.ExchangeError({
                              code: "im_unavailable",
                              message: "Conversation verification is unavailable",
                              retryable: true,
                            })
                          return yield* IMKernelExchange.inspectConversation({ ...source.value, ...input }).pipe(
                            Effect.provideService(HttpClient.HttpClient, http),
                          )
                        })
                    : undefined,
                }),
                Layer.succeedContext(deps),
              ),
              scope,
            ).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? Effect.sync(() => {
              generation.active = false
              generation.invalidations.forEach((invalidate) => invalidate())
              generation.invalidations.clear()
              if (owner.current === generation) owner.current = undefined
            }).pipe(Effect.andThen(Scope.close(scope, exit))) : Effect.void))
            yield* Ref.set(engineScope, Option.some(scope))
            const instance = Context.get(built, IMKernelSync.Service)
            yield* Ref.set(engine, Option.some(instance))
            log.info("kernel sync engine started", { userID: config.userID, identity: config.identity?.name })
            return instance
          }),
        )

      // 凭据解析：URL 只认 env；key 的优先级 stored(auth.json, rebind 写入——最新已知可用) > env。
      // 两边都没有 ⇒ fail-closed disabled（半截配置绝不连接，与 B1 一致；不打日志 value——key 是凭证）。
      const facadeURL = env[KernelConfig.facadeEnvKeys.url]
      const resolveSource = Effect.gen(function* () {
        if (!facadeURL) return Option.none<KernelConfig.FacadeSource>()
        const stored = yield* auth.get(AUTH_KEY).pipe(
          Effect.map((info) => (info?.type === "api" && (!info.metadata?.imSource || info.metadata.imSource ===
            createHash("sha256").update(JSON.stringify(new URL(facadeURL).href.replace(/\/+$/, ""))).digest("hex")) ? info.key : undefined)),
          Effect.orElseSucceed(() => undefined),
        )
        const envKey = env[KernelConfig.facadeEnvKeys.key]
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
        yield* startEngine(IMKernelExchange.toKernelConfig(payload)).pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              log.error("kernel engine start failed", {
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        )
        return identity
      })

      // boot：exchange 的失败不落错误通道（绝不阻塞 server 启动），落可重试的状态机。
      const boot = Effect.gen(function* () {
        const sourceOption = yield* resolveSource
        if (Option.isNone(sourceOption)) {
          // B1 PoC 直连 env 注入：无组织身份，门面功能关闭，引擎照跑。
          const poc = env.DEEPAGENT_IM_ALLOW_UNPAID_DEV_KERNEL === "true" && process.env.NODE_ENV !== "production" ? KernelConfig.fromEnv(env) : undefined
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
          message: "IM facade is not configured (DEEPAGENT_IM_FACADE_URL/KEY absent)",
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
          const source = yield* resolveSource
          yield* Ref.set(sourceRef, source)
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

      yield* boot

      const acquireReader = (context: ReaderContext) => Effect.gen(function* () {
        const actual = yield* InstanceRef
        if (!actual) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
        const workspaceID = (yield* InstanceState.workspaceID) ?? actual.directory
        if (context.workspaceID !== workspaceID || context.userID !== SERVER_USER_ID || context.directory !== undefined && context.directory !== actual.directory || (yield* instanceStore.peek(actual.directory)) !== actual) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
        const current = Option.getOrUndefined(yield* Ref.get(engine))
        if (!current?.acquireReader) return yield* KernelReaderSchema.failure("reader_unavailable", "workspace-lease")
        return yield* current.acquireReader({ instance: actual, workspaceID, userID: SERVER_USER_ID, instanceCurrent: instanceStore.peek(actual.directory).pipe(Effect.map((value) => value === actual)) })
      })
      const withReader: Interface["withReader"] = (context, use) => Effect.scoped(Effect.flatMap(acquireReader(context), use))
      const currentReaderContext = Effect.gen(function* () {
        const actual = yield* InstanceRef
        if (!actual) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
        return { workspaceID: (yield* InstanceState.workspaceID) ?? actual.directory, userID: SERVER_USER_ID, directory: actual.directory }
      })
      const exchangeReaderError = (error: KernelReaderSchema.Error) => new IMKernelExchange.ExchangeError({ code: "im_unavailable", message: "Protected delivery reader is unavailable", retryable: true })

      yield* Effect.gen(function* () {
        const backoff = yield* Ref.get(rateLimitedUntil)
        if (backoff > performance.now()) return
        const expiration = yield* Ref.get(expiresAt)
        if (expiration === undefined && backoff === 0) return
        const running = yield* Ref.get(engine)
        const connection = Option.isSome(running) ? yield* SubscriptionRef.get(running.value.state) : undefined
        if (backoff === 0 && expiration !== undefined && Date.now() < expiration * 1_000 - 60_000 && connection !== "failed" && connection !== "disconnected") return
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
        status: Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state)
          const running = yield* Ref.get(engine)
          const actual = yield* InstanceRef
          const observed = actual && Option.isSome(running) ? yield* withReader(yield* currentReaderContext, (lease) => SubscriptionRef.get(lease.reader.state)) : undefined
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
            ...(observed ? { reader: observed, recovery: observed.state === "ready" ? { status: "ready" as const } : observed.state === "unavailable" ? { status: "failed" as const, message: "Remote conversation is currently unavailable" } : { status: "pending" as const } } : {}),
            keyOrigin: yield* Ref.get(keyOriginRef),
          } satisfies StatusSnapshot
        }),
        claim: (raw) =>
          identityLock.withPermits(1)(
            Effect.gen(function* () {
              const source = yield* requireSource
              const name = yield* validatedName(raw)
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
              const payload = yield* withClient(IMKernelExchange.rebind({ ...source, newKey: key }))
              // 身份已在门面侧迁移 ⇒ 后续门面调用立即改用新 key；持久化（auth.json，0o600）供下次
              // 启动优先于 env。server mode 禁写 auth.json（gateway 托管 key）——记日志后继续。
              yield* Ref.set(sourceRef, Option.some({ facadeURL: source.facadeURL, key }))
              yield* auth.set(AUTH_KEY, new Auth.Api({ type: "api", key })).pipe(
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
        resolve: (raw) =>
          Effect.gen(function* () {
            const { source } = yield* requireActive
            const name = yield* validatedName(raw)
            return yield* withClient(IMKernelExchange.resolve({ ...source, name }))
          }),
        createGroup: (input) => withReader({ workspaceID: input.workspaceID, userID: SERVER_USER_ID }, (lease) =>
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
            const groupID = yield* lease.reader.pending({ conversationType: 2, conversationID: created.group_id, name: created.name })
            return yield* lease.reader.withOutput({ workspaceID: lease.workspaceID, userID: lease.userID, groupIDs: [groupID] }, repo.getGroup({ groupID, userID: lease.userID })).pipe(Effect.flatMap((group) => group ? Effect.succeed(group) : Effect.fail(new GroupLookupError({ message: "Protected conversation is unavailable" }))))
          })).pipe(Effect.catchIf((error) => error instanceof KernelReaderSchema.Error, (error) => Effect.fail(exchangeReaderError(error)))),
        openDirect: (input) => withReader({ workspaceID: input.workspaceID, userID: SERVER_USER_ID }, (lease) =>
          Effect.gen(function* () {
            const active = yield* requireActive
            const name = yield* validatedName(input.name)
            yield* lease.assertCurrent
            yield* lease.reader.verifyScope
            const peer = yield* withClient(IMKernelExchange.resolve({ ...active.source, name }))
            yield* lease.assertCurrent
            if (peer.uuid === active.identity.uuid) return yield* new IMKernelExchange.ExchangeError({ code: "invalid_request", message: "cannot open a direct chat with yourself", status: 400, retryable: false })
            const groupID = yield* lease.reader.pending({ conversationType: 1, conversationID: peer.uuid, name: peer.name })
            return yield* lease.reader.withOutput({ workspaceID: lease.workspaceID, userID: lease.userID, groupIDs: [groupID] }, repo.getGroup({ groupID, userID: lease.userID })).pipe(Effect.flatMap((group) => group ? Effect.succeed(group) : Effect.fail(new GroupLookupError({ message: "Protected conversation is unavailable" }))))
          })).pipe(Effect.catchIf((error) => error instanceof KernelReaderSchema.Error, (error) => Effect.fail(exchangeReaderError(error)))),
        invite: (input) => Effect.gen(function* () {
          const context = yield* currentReaderContext
          return yield* withReader(context, (lease) => Effect.gen(function* () {
            const active = yield* requireActive
            const name = yield* validatedName(input.name)
            const group = yield* repo.getGroupByID(input.groupID)
            if (!group || group.workspaceID !== lease.workspaceID) return yield* new GroupLookupError({ message: "Protected conversation is unavailable" })
            const conversation = group.kernelConvID?.startsWith("kr1:") ? yield* lease.reader.conversation(group.id) : undefined
            if (!conversation || conversation.conversationType !== 2) return yield* new GroupLookupError({ message: "Protected conversation is unavailable" })
            yield* lease.assertCurrent
            yield* lease.reader.verifyScope
            const peer = yield* withClient(IMKernelExchange.resolve({ ...active.source, name }))
            yield* lease.assertCurrent
            yield* withClient(IMKernelExchange.inviteToGroup({ ...active.source, groupID: conversation.conversationID, name: peer.name }))
            yield* lease.assertCurrent
            yield* repo.addMember({ groupID: group.id, memberID: peer.uuid, memberType: "user", role: "member" }).pipe(Effect.catch((error) => Effect.sync(() => log.warn("local member row insert skipped", { message: error.message }))))
          }))
        }).pipe(Effect.catchIf((error) => error instanceof KernelReaderSchema.Error, (error) => Effect.fail(exchangeReaderError(error)))),
      })
    }),
  )
