export * as IMKernelExchange from "./exchange"

import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { KernelConfig } from "./config"

// 门面 /api/im 的 typed 客户端（design §4：sk- key → 内核连接坐标）。B2 用 exchange 替换 B1 的
// 直连 env 注入：key 已认领 ⇒ exchange 幂等地 RegisterUser + 确保加入全员群后返回内核 token；
// 未认领 ⇒ 409 im_not_claimed（先 claim）。token 长效，refresh-on-restart（每次启动重新 exchange，
// 门面侧自愈）；运行期 401 重换列 follow-up。

export class ExchangeError extends Schema.TaggedErrorClass<ExchangeError>()("IMKernelExchangeError", {
  /** 门面业务码（im_not_claimed/im_key_invalid/…）或客户端侧分类（transport_error/invalid_response）。 */
  code: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  /** 5xx / 传输层失败 ⇒ 可重试；4xx 业务拒绝 ⇒ 重试无意义。 */
  retryable: Schema.Boolean,
}) {}

export const IdentityPayload = Schema.Struct({
  uuid: Schema.String,
  name: Schema.String,
  org_id: Schema.Number,
  org_all_group_id: Schema.String,
})

export const ExchangePayload = Schema.Struct({
  kernel_token: Schema.String,
  navigator_url: Schema.String,
  appkey: Schema.String,
  identity: IdentityPayload,
  ttl: Schema.Struct({ msg_life_time_ms: Schema.Number }),
})
export type ExchangePayload = Schema.Schema.Type<typeof ExchangePayload>

// new-api common.ApiSuccess / imError 的包封套：成功 {success:true, data}，失败 {success:false, code, message}。
const Envelope = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
})

export interface ExchangeInput {
  /** 门面 base URL（如 http://127.0.0.1:3100），尾斜杠在此归一。 */
  readonly facadeURL: string
  /** sk- key（Bearer 头发送；门面的 TokenAuth 同时接受裸 key，Bearer 是规范形）。 */
  readonly key: string
}

const post = (input: ExchangeInput, path: string, body: unknown) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const url = `${input.facadeURL.replace(/\/+$/, "")}${path}`
    const response = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ authorization: `Bearer ${input.key}` }),
      HttpClientRequest.bodyJson(body),
      Effect.flatMap((request) => http.execute(request)),
      Effect.mapError(
        (error) =>
          new ExchangeError({ code: "transport_error", message: `facade ${path} unreachable: ${error.message}`, retryable: true }),
      ),
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(new ExchangeError({ code: "transport_error", message: `facade ${path} timed out (15s)`, retryable: true })),
      }),
    )
    const invalid = (detail: string) =>
      new ExchangeError({
        code: "invalid_response",
        message: `facade ${path} returned an unreadable response: ${detail}`,
        status: response.status,
        retryable: response.status >= 500,
      })
    const envelope = yield* HttpClientResponse.schemaBodyJson(Envelope)(response).pipe(
      Effect.mapError((error) => invalid(error.message)),
    )
    if (!envelope.success)
      return yield* new ExchangeError({
        code: envelope.code ?? "http_error",
        message: envelope.message ?? `facade ${path} rejected the request (HTTP ${response.status})`,
        status: response.status,
        retryable: response.status >= 500,
      })
    if (envelope.data === undefined) return yield* invalid("success envelope without data")
    const decoded = Schema.decodeUnknownOption(ExchangePayload)(envelope.data)
    if (Option.isNone(decoded)) return yield* invalid("data does not match the exchange payload contract")
    return decoded.value
  })

/** 已认领 key → 内核连接坐标（幂等：每次调用都刷新内核 token 并自愈全员群成员关系）。 */
export const exchange = (input: ExchangeInput) => post(input, "/api/im/exchange", {})

/** 认领：把 IM 身份（name，org 内唯一）绑定到 key 并返回内核连接坐标。同 key 重认领幂等。 */
export const claim = (input: ExchangeInput & { readonly name: string }) =>
  post(input, "/api/im/claim", { name: input.name })

/** exchange 返回 → 内核连接配置。内核 user_id 即身份 uuid（门面 RegisterUser(acc.Uuid, acc.Name)）。 */
export const toKernelConfig = (payload: ExchangePayload): KernelConfig.Info => ({
  appkey: payload.appkey,
  navigator: payload.navigator_url,
  token: payload.kernel_token,
  userID: payload.identity.uuid,
  identity: {
    uuid: payload.identity.uuid,
    name: payload.identity.name,
    orgAllGroupID: payload.identity.org_all_group_id,
  },
})
