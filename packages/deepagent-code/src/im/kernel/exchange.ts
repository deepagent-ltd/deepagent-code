export * as IMKernelExchange from "./exchange"

import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { KernelConfig } from "./config"

// 门面 /api/im 的 typed 客户端（design §4：sk- key → 内核连接坐标）。B2 用 exchange 替换 B1 的
// 直连 env 注入：key 已认领 ⇒ exchange 幂等地 RegisterUser + 确保加入全员群后返回内核 token；
// 未认领 ⇒ 409 im_not_claimed（先 claim）。灰度短期 token 携带 credential_expires_at，
// facade 在到期前或断线后重新 exchange，并关闭旧 SDK 后安装新凭证。

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
  credential_expires_at: Schema.optional(Schema.Number),
  navigator_url: Schema.String,
  appkey: Schema.String,
  identity: IdentityPayload,
  ttl: Schema.Struct({ msg_life_time_ms: Schema.Number }),
})
export type ExchangePayload = Schema.Schema.Type<typeof ExchangePayload>

// B2 通讯录/群管理的门面载荷（resolve / groups / invite）。createGroup 返回内核群 id + 成员 uuid
// 清单（成员解析失败的请求被门面整体拒绝——im_member_not_found）。
export const ResolvePayload = Schema.Struct({
  uuid: Schema.String,
  name: Schema.String,
})
export type ResolvePayload = Schema.Schema.Type<typeof ResolvePayload>

export const CreateGroupPayload = Schema.Struct({
  group_id: Schema.String,
  name: Schema.String,
  member_uuids: Schema.Array(Schema.String),
})
export type CreateGroupPayload = Schema.Schema.Type<typeof CreateGroupPayload>

export const InspectConversationPayload = Schema.Struct({
  conversation_type: Schema.Literals([1, 2]),
  conversation_id: Schema.String,
  name: Schema.String,
  member_uuids: Schema.Array(Schema.String),
  org_id: Schema.Number,
})
export type InspectConversationPayload = Schema.Schema.Type<typeof InspectConversationPayload>

export interface InspectConversationInput {
  readonly conversationType: 1 | 2
  readonly conversationID: string
  readonly senderID?: string
}

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

// 门面调用的公共半：包络解包 + 业务码透传 + 按调用方给的解码器解 data（v4 Schema 的泛型签名在
// helper 边界会丢解码类型，故传 Schema.decodeUnknownOption(<具体 schema>) 的部分应用）。各端点
// 只声明自己的 HttpClientRequest 与解码器。失败语义与 B1 一致：业务码原样进 ExchangeError.code，
// 4xx 不可重试，5xx/传输层可重试，success 包络载荷畸形 ⇒ fail-closed invalid_response。
const call = <A>(
  input: ExchangeInput,
  request: HttpClientRequest.HttpClientRequest,
  decode: (data: unknown) => Option.Option<A>,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const path = new URL(request.url).pathname
    const response = yield* http.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new ExchangeError({
            code: "transport_error",
            message: `facade ${path} unreachable: ${error.message}`,
            retryable: true,
          }),
      ),
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(
            new ExchangeError({ code: "transport_error", message: `facade ${path} timed out (15s)`, retryable: true }),
          ),
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
    const decoded = decode(envelope.data)
    if (Option.isNone(decoded)) return yield* invalid("data does not match the payload contract")
    return decoded.value
  })

const baseURL = (input: ExchangeInput) => input.facadeURL.replace(/\/+$/, "")

const post = <A>(input: ExchangeInput, path: string, body: unknown, decode: (data: unknown) => Option.Option<A>) =>
  HttpClientRequest.post(`${baseURL(input)}${path}`).pipe(
    HttpClientRequest.setHeaders({ authorization: `Bearer ${input.key}` }),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap((request) => call(input, request, decode)),
    // bodyJson 的编码失败（不可 JSON 的 body）归入 invalid_response 的客户端侧 fail-closed
    Effect.mapError((error) =>
      error instanceof ExchangeError
        ? error
        : new ExchangeError({
            code: "invalid_response",
            message: `facade ${path} request body not JSON-encodable: ${error.message}`,
            retryable: false,
          }),
    ),
  )

/** 已认领 key → 内核连接坐标（幂等：每次调用都刷新内核 token 并自愈全员群成员关系）。 */
export const exchange = (input: ExchangeInput) =>
  post(input, "/api/im/exchange", {}, Schema.decodeUnknownOption(ExchangePayload))

/** 认领：把 IM 身份（name，org 内唯一）绑定到 key 并返回内核连接坐标。同 key 重认领幂等。 */
export const claim = (input: ExchangeInput & { readonly name: string }) =>
  post(input, "/api/im/claim", { name: input.name }, Schema.decodeUnknownOption(ExchangePayload))

/** 改名：uuid/群成员关系不变，返回新的内核连接坐标（token 同样刷新）。 */
export const rename = (input: ExchangeInput & { readonly name: string }) =>
  post(input, "/api/im/rename", { name: input.name }, Schema.decodeUnknownOption(ExchangePayload))

/** 换 key 找回：把当前（auth 头）key 上的 IM 身份迁到 new_key（同 org 有效付费且未绑定）。 */
export const rebind = (input: ExchangeInput & { readonly newKey: string }) =>
  post(input, "/api/im/rebind", { new_key: input.newKey }, Schema.decodeUnknownOption(ExchangePayload))

/** 通讯录：org 内精确匹配（无模糊搜索）。未命中 ⇒ im_not_found (404)。 */
export const resolve = (input: ExchangeInput & { readonly name: string }) =>
  call(
    input,
    HttpClientRequest.get(`${baseURL(input)}/api/im/resolve?name=${encodeURIComponent(input.name)}`).pipe(
      HttpClientRequest.setHeaders({ authorization: `Bearer ${input.key}` }),
    ),
    Schema.decodeUnknownOption(ResolvePayload),
  )

/** 建群：创建者自动是群首成员；member_names 是 org 内成员名清单。 */
export const createGroup = (
  input: ExchangeInput & { readonly name: string; readonly memberNames: ReadonlyArray<string> },
) =>
  post(
    input,
    "/api/im/groups",
    { name: input.name, member_names: [...input.memberNames] },
    Schema.decodeUnknownOption(CreateGroupPayload),
  )

/** 邀请：仅群成员可邀请；按名邀请（门面侧解析名 → uuid）。 */
export const inviteToGroup = (input: ExchangeInput & { readonly groupID: string; readonly name: string }) =>
  post(
    input,
    "/api/im/groups/invite",
    { group_id: input.groupID, name: input.name },
    Schema.decodeUnknownOption(Schema.Struct({})),
  )

/** Platform authority for receiving a conversation; kernel payloads alone cannot establish membership. */
export const inspectConversation = (input: ExchangeInput & InspectConversationInput) =>
  post(
    input,
    "/api/im/conversations/inspect",
    {
      conversation_type: input.conversationType,
      conversation_id: input.conversationID,
      ...(input.senderID ? { sender_uuid: input.senderID } : {}),
    },
    Schema.decodeUnknownOption(InspectConversationPayload),
  )

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
    orgID: payload.identity.org_id,
  },
})
