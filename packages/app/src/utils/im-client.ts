import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { authTokenFromCredentials, createSdkForServer } from "@/utils/server"
import type {
  AgentDescriptor,
  IMAttachment,
  IMRemoteAttachment,
  IMGroup,
  IMGroupPage,
  IMGroupDetail,
  IMMessage,
  IMReaderPage,
  IMReaderStatus,
  IMReadAction,
  IMReadResult,
} from "@/components/im/types"
import { Schema } from "effect"
import { AttachmentPreview } from "@deepagent-code/core/im/attachment-preview"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { MediaBatch } from "@deepagent-code/core/im/media-batch"
import type { DacInput } from "@/components/im/personal-command"
import { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"
import { IMEntitlementSchema } from "@deepagent-code/core/im/entitlement.schema"

// ── B2 门面（多用户 IM）────────────────────────────────────────────────────────
// 类型镜像服务端 groups/im.ts 的 IMStatusResponse/IMIdentityResponse/IMResolveResponse。
// 门面错误体是 {name, data:{code, message}}——GUI 一律按 code 出文案（见
// components/im/facade-errors.ts 的逐码映射），HTTP status 只作粗分类。

export interface IMFacadeIdentity {
  uuid: string
  name: string
  orgID: number
  orgAllGroupID: string
}

export interface IMFacadeStatus {
  service?: { url: string | null; source: "config" | "environment" | "none"; reconnectRequired: boolean }
  media?: MediaBatch.Policy
  reader?: IMReaderStatus
  facade: "disabled" | "claim_required" | "blocked" | "active"
  identity: IMFacadeIdentity | null
  blocked: { code: string; message: string } | null
  kernel: "connecting" | "connected" | "disconnected" | "failed" | null
  keyOrigin: "stored" | "env" | "none"
  viewer?: { memberID: string }
  recovery?: { status: "pending" | "ready" | "failed"; message?: string }
}

export interface IMResolveResult {
  uuid: string
  name: string
}

/** 门面调用失败：code 是 15 个业务码之一或 4 个客户端侧分类码（core facade-contract）。 */
export class IMFacadeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly notAdmitted = false,
  ) {
    super(message)
    this.name = "IMFacadeRequestError"
  }
}

export interface IMClientConfig {
  /** Server base URL (e.g. http://127.0.0.1:PORT, or <gateway>/w in server mode). */
  url: string
  /** Active project directory — routed to the server as `?directory=`. */
  directory: string
  /** Grouping workspace id, when a routed workspace is available. */
  workspace?: string
  /** IM realm selection participates in scope retirement, never in the DAC request URL. */
  serviceURL?: string | null
  username?: string
  password?: string
  /** JWT bearer for Server Edition (gateway) connections. Takes precedence over Basic. */
  bearer?: string
}

export interface IMMessagePage {
  reader?: IMReaderPage
  protectedUnavailable?: boolean
  messages: IMMessage[]
  nextCursor: string | null
  hasMore: boolean
}

function authHeaders(config: IMClientConfig): Record<string, string> {
  if (config.bearer) return { Authorization: `Bearer ${config.bearer}` }
  if (!config.password) return {}
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: config.username, password: config.password })}`,
  }
}

/**
 * Authenticated client for the IM HTTP + WebSocket API.
 *
 * The IM API is defined as its own `HttpApi` (not part of the generated SDK
 * client), so we hand-roll the requests here — but we route them through the
 * same base URL, Basic auth, and `?directory=` routing the rest of the app uses
 * via the SDK. Config is read lazily through an accessor so credentials and the
 * active directory stay reactive.
 */
export function createIMClient(config: () => IMClientConfig) {
  let snapshot: Readonly<IMClientConfig> | undefined
  const scope = () => {
    const next = config()
    if (
      !snapshot ||
      (Object.keys(next) as Array<keyof IMClientConfig>).some((key) => next[key] !== snapshot?.[key]) ||
      (Object.keys(snapshot) as Array<keyof IMClientConfig>).some((key) => snapshot?.[key] !== next[key])
    )
      snapshot = Object.freeze({ ...next })
    return snapshot
  }
  const buildURL = (path: string, query?: Record<string, string | undefined>) => {
    const c = config()
    const base = new URL(c.url, typeof location !== "undefined" ? location.href : undefined)
    // Append `path` onto the base's pathname rather than treating it as an
    // absolute path — the Server Edition base URL is `<gateway>/w`, and a bare
    // `new URL("/ws/...", base)` would discard the `/w` prefix, breaking the
    // gateway proxy route. Join with exactly one slash.
    const basePath = base.pathname.replace(/\/+$/, "")
    const url = new URL(base.origin + basePath + (path.startsWith("/") ? path : `/${path}`))
    if (c.directory) url.searchParams.set("directory", c.directory)
    if (c.workspace) url.searchParams.set("workspace", c.workspace)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    return url
  }

  const request = async <T>(
    path: string,
    options?: {
      method?: string
      query?: Record<string, string | undefined>
      body?: unknown
      signal?: AbortSignal
      redirect?: RequestRedirect
    },
  ): Promise<T> => {
    const c = config()
    const headers: Record<string, string> = { ...authHeaders(c) }
    // Also send the directory as a header, not just `?directory=`. The Server
    // Edition gateway's HTTP proxy forwards the path but DROPS the query string
    // (only WebSocket upgrades preserve it), so a query-only directory would be
    // lost end-to-end. The header survives the proxy and is what the SDK uses.
    if (c.directory) headers["x-deepagent-code-directory"] = encodeURIComponent(c.directory)
    if (c.workspace) headers["x-deepagent-code-workspace"] = c.workspace
    const init: RequestInit = {
      method: options?.method ?? "GET",
      headers,
      signal: options?.signal,
      redirect: options?.redirect,
    }
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(options.body)
    }
    const response = await fetch(buildURL(path, options?.query), init)
    if (!response.ok) {
      const parsed = await response.json().catch(() => undefined)
      throw new IMFacadeRequestError(
        typeof parsed?.data?.code === "string" ? parsed.data.code : "http_error",
        "IM request failed",
        response.status,
      )
    }
    return (await response.json()) as T
  }

  const groupRecord = (value: IMGroupDetail["group"]): IMGroup => {
    if (
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      typeof value.updatedAt !== "number" ||
      !Number.isFinite(value.updatedAt)
    )
      throw new IMFacadeRequestError("invalid_response", "Invalid conversation timestamp", 503)
    return { ...value, createdAt: value.createdAt, updatedAt: value.updatedAt, deletedAt: null }
  }

  const observeGroups = async <T extends IMGroupPage | IMGroupDetail>(load: () => Promise<T>) => {
    const captured = scope()
    const started = performance.now()
    const result = await load()
    // The response carries a remaining local consumption window; the request's
    // full flight still counts against message expiry below.
    const received = performance.now()
    const protectedResult =
      "lane" in result ? result.lane === "protected" : !!result.group.reader || !!result.group.kernelConvID
    const proof = result.reader
    if (captured !== scope() || (protectedResult && !proof))
      throw new IMFacadeRequestError("reader_unavailable", "Conversation observation is unavailable", 503)
    if (
      proof &&
      (!Number.isInteger(proof.proofWindowMs) ||
        proof.proofWindowMs <= 0 ||
        proof.proofWindowMs > 1000 ||
        performance.now() >= received + proof.proofWindowMs ||
        !proof.displayEpoch ||
        (proof.nextExpiryAt !== null &&
          (proof.validatedServerNow === undefined ||
            performance.now() >= started + proof.nextExpiryAt - proof.validatedServerNow)))
    )
      throw new IMFacadeRequestError("reader_stale", "Conversation observation expired", 503)
    return result
  }

  // 门面调用（B2）与普通 request 的差别只在错误解析：门面错误体 {name, data:{code,message}}
  // 必须逐码透出（IMFacadeRequestError.code），UI 按码给文案。
  const facadeRequest = async <T>(
    path: string,
    options?: { method?: string; query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal },
  ): Promise<T> => {
    const c = scope()
    const headers: Record<string, string> = { ...authHeaders(c) }
    if (c.directory) headers["x-deepagent-code-directory"] = encodeURIComponent(c.directory)
    if (c.workspace) headers["x-deepagent-code-workspace"] = c.workspace
    const init: RequestInit = { method: options?.method ?? "GET", headers, signal: options?.signal }
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(options.body)
    }
    const response = await fetch(buildURL(path, options?.query), init)
    if (c !== scope()) throw new IMFacadeRequestError("status_changed", "IM service scope changed", 409)
    if (!response.ok) {
      const parsed = (await response.json().catch(() => undefined)) as
        | { name?: string; data?: { code?: unknown; message?: unknown } }
        | undefined
      const code = typeof parsed?.data?.code === "string" ? parsed.data.code : "http_error"
      const message =
        typeof parsed?.data?.message === "string" && parsed.data.message
          ? parsed.data.message
          : `IM facade request failed (${response.status})`
      throw new IMFacadeRequestError(code, message, response.status)
    }
    const result = (await response.json()) as T
    if (c !== scope()) throw new IMFacadeRequestError("status_changed", "IM service scope changed", 409)
    return result
  }

  // Multipart request for file uploads — the JSON `request` helper can't carry a
  // FormData body. Reuses the same auth + directory/workspace routing headers,
  // but lets the browser set the multipart Content-Type (with its boundary).
  const mediaRequest = async (path: string, options?: { form?: FormData; signal?: AbortSignal }) => {
    const c = scope()
    const headers: Record<string, string> = { ...authHeaders(c) }
    if (c.directory) headers["x-deepagent-code-directory"] = c.directory
    if (c.workspace) headers["x-deepagent-code-workspace"] = c.workspace
    const response = await fetch(buildURL(path), {
      method: options?.form ? "POST" : "GET",
      headers,
      body: options?.form,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(options?.signal ? [options.signal] : [])]),
    })
    if (!response.ok || c !== scope()) throw new Error("Attachment is unavailable")
    return response
  }

  const dacSDK = () => {
    const captured = scope()
    return {
      captured,
      client: createSdkForServer({ server: captured, directory: captured.directory, workspace: captured.workspace }),
    }
  }
  const dacResponse = <T>(response: { data?: T; error?: unknown; response?: Response }, captured: IMClientConfig) => {
    if (captured !== scope()) throw new IMFacadeRequestError("dac_scope_changed", "DAC session scope changed", 409)
    if (!response.response?.ok || response.data === undefined) {
      const error = response.error
      const data = error && typeof error === "object" && "data" in error ? error.data : undefined
      const code =
        data && typeof data === "object" && "code" in data && typeof data.code === "string"
          ? data.code
          : "dac_request_failed"
      const notAdmitted =
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "IM_DAC_COMMAND_REJECTED" &&
        data &&
        typeof data === "object" &&
        "admitted" in data &&
        data.admitted === false
      throw new IMFacadeRequestError(code, "DAC command request failed", response.response?.status ?? 0, !!notAdmitted)
    }
    return response.data
  }

  return {
    // Memory-only identity. Callers remount and discard receipts when this changes; never render it.
    scope,
    dacBinding: async (groupID: string, signal: AbortSignal) => {
      const target = dacSDK()
      return Schema.decodeUnknownSync(IMDacSessionSchema.BindingResponse)(
        dacResponse(
          await target.client.im.dacBinding(
            { groupId: groupID, directory: target.captured.directory, workspace: target.captured.workspace },
            { signal },
          ),
          target.captured,
        ),
      )
    },
    dacSubmit: async (groupID: string, input: DacInput, signal: AbortSignal) => {
      const target = dacSDK()
      return Schema.decodeUnknownSync(IMDacSessionSchema.CommandResponse)(
        dacResponse(
          await target.client.im.dacSubmit(
            {
              groupId: groupID,
              ...input,
              referenceMessageIDs: input.referenceMessageIDs ? [...input.referenceMessageIDs] : undefined,
              directory: target.captured.directory,
              workspace: target.captured.workspace,
            },
            { signal },
          ),
          target.captured,
        ),
      )
    },
    dacCommand: async (groupID: string, commandID: string, signal: AbortSignal) => {
      const target = dacSDK()
      return Schema.decodeUnknownSync(IMDacSessionSchema.CommandResponse)(
        dacResponse(
          await target.client.im.dacCommand(
            { groupId: groupID, commandID, directory: target.captured.directory, workspace: target.captured.workspace },
            { signal },
          ),
          target.captured,
        ),
      )
    },
    dacReplyReconcile: async (groupID: string, commandID: string, cursor: string | undefined, signal: AbortSignal) => {
      const target = dacSDK()
      const value = Schema.decodeUnknownSync(IMDacSessionSchema.ReplyReconcileResponse)(
        dacResponse(
          await target.client.im.dacReplyReconcile(
            {
              groupId: groupID,
              commandID,
              cursor,
              directory: target.captured.directory,
              workspace: target.captured.workspace,
            },
            { signal },
          ),
          target.captured,
        ),
        { onExcessProperty: "error" },
      )
      signal.throwIfAborted()
      return value
    },
    dacReplyRetry: async (groupID: string, commandID: string, signal: AbortSignal) => {
      const target = dacSDK()
      return Schema.decodeUnknownSync(IMDacSessionSchema.CommandResponse)(
        dacResponse(
          await target.client.im.dacReplyRetry(
            { groupId: groupID, commandID, directory: target.captured.directory, workspace: target.captured.workspace },
            { signal },
          ),
          target.captured,
        ),
      )
    },
    listGroups: (signal?: AbortSignal) => request<IMGroup[]>(`/api/v1/im/groups`, { signal }),
    listGroupPage: (lane: IMGroupPage["lane"], cursor?: string, signal?: AbortSignal) =>
      observeGroups(() => request<IMGroupPage>("/api/v1/im/groups/page", { query: { lane, cursor }, signal })).then(
        (page) => ({ ...page, groups: page.groups.map(groupRecord) }),
      ),
    getGroup: (groupID: string, signal?: AbortSignal) =>
      observeGroups(() => request<IMGroupDetail>(`/api/v1/im/groups/${encodeURIComponent(groupID)}`, { signal })).then(
        (detail) => ({ ...detail, group: groupRecord(detail.group) }),
      ),
    refreshGroup: (groupID: string, signal?: AbortSignal) =>
      observeGroups(() =>
        request<IMGroupDetail>(`/api/v1/im/groups/${encodeURIComponent(groupID)}/refresh`, {
          method: "POST",
          signal,
        }),
      ).then((detail) => ({ ...detail, group: groupRecord(detail.group) })),
    // §B3: `direct` groups carry a `member` (the counterparty) alongside the
    // server-user creator. `member` is required by the backend when type ===
    // "direct" and ignored otherwise.
    createGroup: (payload: {
      name: string
      type: "project" | "system" | "direct"
      projectID?: string
      member?: { memberID: string; memberType: "user" | "agent" }
    }) => request<IMGroup>(`/api/v1/im/groups`, { method: "POST", body: payload }),
    listMessages: (groupID: string, limit = 50, cursor?: string, signal?: AbortSignal, anchorID?: string) =>
      request<IMMessagePage>(`/api/v1/im/groups/${groupID}/messages`, {
        query: { limit: String(limit), cursor, anchorID },
        signal,
      }),
    createMessage: (
      groupID: string,
      payload: {
        content: string
        type?: string
        mentions?: string[]
        replyToID?: string
        clientRequestID?: string
        attachmentID?: string
        attachmentIDs?: string[]
      },
      signal?: AbortSignal,
    ) =>
      request<IMMessage>(`/api/v1/im/groups/${groupID}/messages`, {
        method: "POST",
        signal:
          payload.type === "file"
            ? AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])])
            : signal,
        redirect: payload.type === "file" ? "error" : undefined,
        body: { senderType: "user", type: payload.type ?? "text", ...payload },
      }),
    markRead: (groupID: string, action?: number | IMReadAction) =>
      request<IMReadResult>(`/api/v1/im/groups/${groupID}/read`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        body: typeof action === "number" ? { readAt: action } : (action ?? {}),
      }),
    listAgents: (signal?: AbortSignal) => request<AgentDescriptor[]>(`/api/v1/im/agents`, { signal }),
    // §B3 Thread — the replies to a parent message, keyset paginated (ASC chronological).
    listThread: (groupID: string, messageID: string, limit = 50, cursor?: string) =>
      request<IMMessagePage>(`/api/v1/im/groups/${groupID}/messages/${messageID}/thread`, {
        signal: AbortSignal.timeout(10_000),
        query: { limit: String(limit), cursor },
      }),
    // §B3 搜索 — full-text + metadata search across the caller's group memberships.
    searchMessages: (params: {
      q: string
      groupId?: string
      senderType?: "user" | "agent" | "system"
      type?: "text" | "code" | "file" | "agent_status" | "system"
      metadataType?: string
      limit?: number
      cursor?: string
    }) =>
      request<IMMessagePage>(`/api/v1/im/search`, {
        signal: AbortSignal.timeout(10_000),
        query: {
          q: params.q,
          groupId: params.groupId,
          senderType: params.senderType,
          type: params.type,
          metadataType: params.metadataType,
          limit: params.limit !== undefined ? String(params.limit) : undefined,
          cursor: params.cursor,
        },
      }),
    // Upload only to a local conversation; the file-message transaction owns message binding.
    mediaEnabled: async (signal?: AbortSignal) => {
      const result: unknown = await (await mediaRequest("/global/capabilities", { signal })).json()
      return (
        typeof result === "object" &&
        result !== null &&
        "features" in result &&
        typeof result.features === "object" &&
        result.features !== null &&
        "v4FileUploadEnabled" in result.features &&
        result.features.v4FileUploadEnabled === true
      )
    },
    uploadAttachment: async (file: File, opts: { groupId: string; signal?: AbortSignal }) => {
      const form = new FormData()
      form.append("file", file, file.name)
      form.append("groupId", opts.groupId)
      return MediaIntent.attachment(
        await (await mediaRequest(`/api/v1/im/attachments`, { form, signal: opts.signal })).json(),
      )
    },
    getAttachment: async (id: string, signal?: AbortSignal) =>
      MediaIntent.attachment(
        await (await mediaRequest(`/api/v1/im/attachments/${encodeURIComponent(id)}`, { signal })).json(),
      ),
    downloadAttachment: async (attachment: IMAttachment, signal = new AbortController().signal) => {
      const target = scope()
      const path = `/api/v1/im/attachments/${encodeURIComponent(attachment.id)}`
      const before = MediaIntent.attachment(await (await mediaRequest(path, { signal })).json())
      if (!before.messageID || JSON.stringify(before) !== JSON.stringify(attachment))
        throw new Error("Attachment changed")
      const bytes = await MediaIntent.verifiedBytes(await mediaRequest(`${path}/content`, { signal }), before, signal)
      const after = MediaIntent.attachment(await (await mediaRequest(path, { signal })).json())
      if (scope() !== target || JSON.stringify(after) !== JSON.stringify(before)) throw new Error("Attachment changed")
      return new Blob([bytes], { type: attachment.preview ? attachment.mime : "application/octet-stream" })
    },
    getRemoteAttachment: async (
      locator: { groupID: string; messageID: string; attachmentID: string },
      signal?: AbortSignal,
    ) =>
      Schema.decodeUnknownSync(KernelReaderSchema.RemoteAttachment)(
        await (
          await mediaRequest(
            `/api/v1/im/groups/${encodeURIComponent(locator.groupID)}/messages/${encodeURIComponent(locator.messageID)}/attachments/${encodeURIComponent(locator.attachmentID)}`,
            { signal },
          )
        ).json(),
        { onExcessProperty: "error" },
      ),
    downloadRemoteAttachment: async (
      locator: { groupID: string; messageID: string; attachmentID: string },
      attachment: IMRemoteAttachment,
      signal = new AbortController().signal,
    ) => {
      const target = scope()
      const path = `/api/v1/im/groups/${encodeURIComponent(locator.groupID)}/messages/${encodeURIComponent(locator.messageID)}/attachments/${encodeURIComponent(locator.attachmentID)}`
      const before = Schema.decodeUnknownSync(KernelReaderSchema.RemoteAttachment)(
        await (await mediaRequest(path, { signal })).json(),
        { onExcessProperty: "error" },
      )
      if (JSON.stringify(before) !== JSON.stringify(attachment) || before.expiresAt <= Date.now())
        throw new Error("Attachment changed")
      const response = await mediaRequest(`${path}/content`, { signal })
      if (
        response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("x-content-type-options") !== "nosniff" ||
        response.headers.get("content-type") !==
          (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(before.mime)
            ? before.mime
            : "application/octet-stream")
      )
        throw new Error("Attachment is unavailable")
      const bytes = await MediaIntent.readBytes(response.body, before.sizeBytes, signal)
      if (
        (await MediaIntent.checksum(bytes)) !== before.sha256 ||
        before.expiresAt <= Date.now() ||
        (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(before.mime) &&
          AttachmentPreview.mime(bytes) !== before.mime)
      )
        throw new Error("Attachment integrity failed")
      const after = Schema.decodeUnknownSync(KernelReaderSchema.RemoteAttachment)(
        await (await mediaRequest(path, { signal })).json(),
        { onExcessProperty: "error" },
      )
      if (scope() !== target || JSON.stringify(after) !== JSON.stringify(before) || after.expiresAt <= Date.now())
        throw new Error("Attachment changed")
      signal.throwIfAborted()
      return new Blob([bytes], {
        type: ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.mime)
          ? attachment.mime
          : "application/octet-stream",
      })
    },
    // §B3 文件 — list attachment records for a group / message / the workspace.
    listAttachments: (opts?: { groupId?: string; messageId?: string; limit?: number }) =>
      request<IMAttachment[]>(`/api/v1/im/attachments`, {
        query: {
          groupId: opts?.groupId,
          messageId: opts?.messageId,
          limit: opts?.limit !== undefined ? String(opts.limit) : undefined,
        },
      }),
    // ── B2 门面端点 ───────────────────────────────────────────────────────────
    facadeStatus: (signal?: AbortSignal) => facadeRequest<IMFacadeStatus>(`/api/v1/im/status`, { signal }),
    entitlement: async (signal?: AbortSignal) =>
      Schema.decodeUnknownSync(IMEntitlementSchema.Observation)(
        await facadeRequest<unknown>(`/api/v1/im/entitlement`, { signal }),
      ),
    plans: async (signal?: AbortSignal) =>
      Schema.decodeUnknownSync(IMEntitlementSchema.PlansObservation)(
        await facadeRequest<unknown>(`/api/v1/im/plans`, { signal }),
      ),
    facadeRename: (name: string) =>
      facadeRequest<IMFacadeIdentity>(`/api/v1/im/facade/rename`, { method: "POST", body: { name } }),
    facadeRetry: () => facadeRequest<IMFacadeIdentity>(`/api/v1/im/facade/retry`, { method: "POST", body: {} }),
    facadeResolve: (name: string, signal?: AbortSignal) =>
      facadeRequest<IMResolveResult>(`/api/v1/im/facade/resolve`, { query: { name }, signal }),
    facadeOpenDirect: (name: string) =>
      facadeRequest<IMGroup>(`/api/v1/im/facade/direct`, { method: "POST", body: { name } }),
    facadeCreateGroup: (name: string, memberNames: string[]) =>
      facadeRequest<IMGroup>(`/api/v1/im/facade/groups`, { method: "POST", body: { name, memberNames } }),
    facadeInvite: (groupID: string, name: string) =>
      facadeRequest<{ ok: boolean }>(`/api/v1/im/facade/groups/${groupID}/invite`, { method: "POST", body: { name } }),
    // Server Edition only: set the `access_token` cookie the gateway reads to
    // authenticate the WebSocket upgrade (browsers can't set WS headers). No-op
    // for self-hosted (which uses the `auth_token` query instead) or outside a
    // document context. The cookie is scoped to the gateway origin's `/w` path.
    setWebSocketAuthCookie: () => {
      const c = config()
      if (!c.bearer || typeof document === "undefined") return
      try {
        const base = new URL(c.url, typeof location !== "undefined" ? location.href : undefined)
        const secure = base.protocol === "https:" ? "; Secure" : ""
        document.cookie = `access_token=${encodeURIComponent(c.bearer)}; Path=/; SameSite=None${secure}`
      } catch {
        // Ignore malformed base URLs.
      }
    },
    webSocketURL: (groupID: string) => {
      const c = config()
      const url = buildURL(`/ws/im/group/${groupID}`)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      // Server Edition: the gateway authenticates the WS upgrade via the JWT
      // (bearer or an `access_token` cookie) and injects Basic to the container
      // downstream — so we must NOT append the container's `auth_token` here.
      // `directory` still travels as a query param (the gateway's WS proxy
      // preserves the query string, unlike its HTTP proxy). The bearer is
      // delivered out-of-band via an `access_token` cookie (see setWebSocketAuthCookie).
      if (c.bearer) return url.toString()
      // Self-hosted: browsers can't set WS headers, so Basic travels as the
      // `auth_token` base64 query, exactly like the PTY connect endpoint.
      if (c.password) {
        url.searchParams.set("auth_token", authTokenFromCredentials({ username: c.username, password: c.password }))
      }
      return url.toString()
    },
  }
}

export type IMClient = ReturnType<typeof createIMClient>

/** A read started before a newer observation cannot overwrite it. WS creation echoes are not
 * transport-status revisions; only a later authoritative HTTP read may downgrade an ACK. */
const httpObservations = new WeakSet<IMMessage>()

export function mergeIMMessages(
  current: IMMessage[],
  incoming: IMMessage[],
  mode: "snapshot" | "live" | "receipt" = "snapshot",
  observed?: ReadonlyMap<string, IMMessage>,
) {
  const merged = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) {
    const previous = merged.get(message.id)
    if (previous && observed && observed.get(message.id) !== previous && httpObservations.has(previous)) {
      // A create response can complete after a GET has observed its prepared row. Let the
      // actual ACK converge, but never replace an ACK or a newly verified record mismatch.
      if (
        mode !== "receipt" ||
        previous.transport?.state === "acknowledged" ||
        previous.transport?.reason === "receipt_mismatch" ||
        (previous.transport?.state === "unknown" && message.transport?.state !== "acknowledged")
      )
        continue
    }
    // Production broadcasts creation before returning the HTTP receipt. That echo cannot
    // suppress the receipt or invent a newer transport revision, even if it carries old fields.
    const next =
      mode === "live"
        ? {
            ...(previous && message.updatedAt < previous.updatedAt ? message : previous),
            ...(previous && message.updatedAt < previous.updatedAt ? previous : message),
            transport: previous?.transport,
          }
        : message
    // A freshly admitted identical remote snapshot keeps its mounted card and
    // verified temporary preview. Permission invalidation still clears the list.
    if (mode === "snapshot" && previous?.remoteAttachments && JSON.stringify(previous) === JSON.stringify(next)) {
      httpObservations.add(previous)
      continue
    }
    if (mode !== "live" || (previous && httpObservations.has(previous))) httpObservations.add(next)
    merged.set(message.id, next)
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/**
 * Build an IM client bound to the current SDK/server context. Must be called
 * under `SDKProvider` (the `/:dir` layout) so a directory is available.
 */
export function useIMClient(): IMClient {
  const sdk = useSDK()
  const server = useServer()
  const sync = useServerSync()
  return createIMClient(() => ({
    url: sdk.url,
    directory: sdk.directory,
    username: server.current?.http.username,
    password: server.current?.http.password,
    bearer: server.current?.http.bearer,
    serviceURL: sync.data.config.im?.url,
  }))
}
