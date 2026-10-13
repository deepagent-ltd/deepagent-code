import type { useSDK } from "../context/sdk"
import type {
  ImMessagesCreateResponse,
  ImGroupsListResponse,
  ImGroupsListPageResponse,
  ImGroupsGetResponse,
  ImMessagesListResponse,
  ImFacadeStatusResponse,
  ImMessagesMarkReadResponse,
  ImMessagesMarkReadData,
  ImAttachmentsRemoteGetResponse,
} from "@deepagent-code/sdk"
import { Option, Schema } from "effect"
import { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"
import { IMActivationSchema } from "@deepagent-code/core/im/activation.schema"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { AttachmentPreview } from "@deepagent-code/core/im/attachment-preview"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { MediaBatch } from "@deepagent-code/core/im/media-batch"
import { PingEvent, type PongEvent } from "@deepagent-code/core/im/websocket"
import type { MediaFileStream } from "./im-media"

export type IMRemoteAttachment = ImAttachmentsRemoteGetResponse
export type IMRemoteAttachmentRef = { groupID: string; messageID: string; attachment: IMRemoteAttachment }

export type IMGroupPage = ImGroupsListPageResponse
export type IMGroupDetail = ImGroupsGetResponse
export type IMDacBinding = typeof IMDacSessionSchema.BindingResponse.Type
export type IMDacCommand = typeof IMDacSessionSchema.CommandResponse.Type

export type IMReaderGroup = NonNullable<ImGroupsListResponse[number]["reader"]>
export type IMReaderPage = NonNullable<ImMessagesListResponse["reader"]>
export type IMReaderStatus = NonNullable<ImFacadeStatusResponse["reader"]>
export type IMReadResult = ImMessagesMarkReadResponse
export type IMReadAction = Required<Pick<ImMessagesMarkReadData["body"], "actionID">> &
  Pick<ImMessagesMarkReadData["body"], "reconcile" | "continue" | "cancel" | "newAction">

export type IMGroup = {
  reader?: IMReaderGroup
  id: string
  workspaceID: string
  projectID: string | null
  type: string
  name: string
  createdBy: string
  kernelConvID: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export type MessageMetadata =
  | (readonly { type: "attachment_ref"; attachmentID: string; batch: true }[] & { readonly type?: undefined })
  | { type: "attachment_ref"; attachmentID: string }
  | { type: "file_ref"; path: string; line?: number }
  | { type: "code_ref"; path?: string; startLine?: number; endLine?: number }
  | { type: "agent_run"; sessionID?: string; status: string }
  | { type: "debug"; info: string }
  | { type: "profile"; operation: string; duration: number }
  | { type: "error"; code: string; message: string }

export type IMMessage = {
  remoteAttachments?: ImMessagesCreateResponse["remoteAttachments"]
  transport?: ImMessagesCreateResponse["transport"]
  id: string
  groupID: string
  senderID: string
  senderType: "user" | "agent" | "system" | string
  type: string
  content: string
  mentions: string[] | null
  metadata: MessageMetadata | null
  replyToID: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export type IMMessagePage = {
  reader?: IMReaderPage
  protectedUnavailable?: boolean
  messages: IMMessage[]
  nextCursor: string | null
  hasMore: boolean
}

export type IMFacadeIdentity = { uuid: string; name: string; orgID: number; orgAllGroupID: string }
export type IMFacadeStatus = {
  media?: MediaBatch.Policy
  reader?: IMReaderStatus | null
  facade: "disabled" | "claim_required" | "blocked" | "active"
  identity: IMFacadeIdentity | null
  blocked: { code: string; message: string } | null
  kernel: "connecting" | "connected" | "disconnected" | "failed" | null
  keyOrigin: "stored" | "env" | "none"
  viewer?: { memberID: string }
  recovery?: { status: "pending" | "ready" | "failed"; message?: string }
}
export type IMSDK = Pick<ReturnType<typeof useSDK>, "client" | "url" | "directory"> & { fetch?: typeof fetch }

export class IMRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message)
    this.name = "IMRequestError"
  }
}

export class IMDacCommandRejected extends IMRequestError {
  readonly admitted = false
}

function transport(sdk: IMSDK) {
  return (
    sdk.client as unknown as {
      client: {
        getConfig(): { headers?: RequestInit["headers"]; signal?: AbortSignal | null }
      }
    }
  ).client
}

// Keep the SDK credentials, but preserve the routing header on GETs too. The SDK's generic
// query rewrite strips it, while a gateway HTTP hop may drop the query string.
type IMClientScope = {
  url: string
  directory?: string
  headers: Headers
  signal?: AbortSignal | null
  client: IMSDK["client"]
}
export function createIMClient(sdk: IMSDK, fixed?: IMClientScope) {
  let snapshot: IMClientScope | undefined
  const scope = () => {
    if (fixed) return fixed
    const config = transport(sdk).getConfig()
    const headers = new Headers(config.headers)
    if (
      !snapshot ||
      snapshot.client !== sdk.client ||
      snapshot.url !== sdk.url ||
      snapshot.directory !== sdk.directory ||
      snapshot.signal !== config.signal ||
      JSON.stringify([...snapshot.headers.entries()]) !== JSON.stringify([...headers.entries()])
    )
      snapshot = { url: sdk.url, directory: sdk.directory, headers, signal: config.signal, client: sdk.client }
    return snapshot
  }
  const request = async <T>(options: {
    method: string
    url: string
    body?: unknown
    signal?: AbortSignal
    redirect?: RequestRedirect
  }): Promise<T> => {
    const config = scope()
    const url = new URL(`${config.url.replace(/\/+$/, "")}${options.url}`)
    const headers = new Headers(config.headers)
    if (config.directory) {
      url.searchParams.set("directory", config.directory)
      url.searchParams.set("location[directory]", config.directory)
      headers.set("x-deepagent-code-directory", encodeURIComponent(config.directory))
    }
    if (options.body !== undefined) headers.set("Content-Type", "application/json")
    const response = await (sdk.fetch ?? fetch)(
      new Request(url, {
        method: options.method,
        headers,
        redirect: options.redirect,
        signal:
          options.signal && config.signal
            ? AbortSignal.any([options.signal, config.signal])
            : (options.signal ?? config.signal),
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      }),
    ).catch(() => {
      throw new IMRequestError("transport_error", "IM server could not be reached")
    })
    const result: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const error = result as { data?: { code?: unknown; message?: unknown } } | undefined
      throw new IMRequestError(
        typeof error?.data?.code === "string" ? error.data.code : "http_error",
        typeof error?.data?.message === "string" ? error.data.message : "IM request failed",
      )
    }
    if (result === undefined || result === null)
      throw new IMRequestError("invalid_response", "IM server returned no data")
    return result as T
  }

  const groupRecord = (value: IMGroupDetail["group"]): IMGroup => {
    if (
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      typeof value.updatedAt !== "number" ||
      !Number.isFinite(value.updatedAt)
    )
      throw new IMRequestError("invalid_response", "Invalid conversation timestamp")
    return { ...value, createdAt: value.createdAt, updatedAt: value.updatedAt, deletedAt: null }
  }

  const observeGroups = async <T extends IMGroupPage | IMGroupDetail>(load: () => Promise<T>) => {
    const captured = scope()
    const started = performance.now()
    const result = await load()
    const returned = performance.now()
    const protectedResult =
      "lane" in result ? result.lane === "protected" : !!result.group.reader || !!result.group.kernelConvID
    const proof = result.reader
    if (captured !== scope() || (protectedResult && !proof))
      throw new IMRequestError("reader_unavailable", "Conversation observation is unavailable")
    if (
      proof &&
      (!Number.isInteger(proof.proofWindowMs) ||
        proof.proofWindowMs <= 0 ||
        proof.proofWindowMs > 1000 ||
        performance.now() >= returned + proof.proofWindowMs ||
        !proof.displayEpoch ||
        (proof.nextExpiryAt !== null &&
          (proof.validatedServerNow === undefined ||
            performance.now() >= started + proof.nextExpiryAt - proof.validatedServerNow)))
    )
      throw new IMRequestError("reader_stale", "Conversation observation expired")
    return result
  }

  const mediaRequest = async (resource: string, signal: AbortSignal, form?: FormData) => {
    const config = scope()
    const url = new URL(`${config.url.replace(/\/+$/, "")}${resource}`)
    const headers = new Headers(config.headers)
    headers.delete("content-type")
    if (config.directory) {
      url.searchParams.set("directory", config.directory)
      headers.set("x-deepagent-code-directory", encodeURIComponent(config.directory))
    }
    const response = await (sdk.fetch ?? fetch)(
      new Request(url, {
        method: form ? "POST" : "GET",
        headers,
        body: form,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000), ...(config.signal ? [config.signal] : [])]),
      }),
    )
    if (scope() !== config || !response.ok) throw new IMRequestError("media_unavailable", "Attachment is unavailable")
    return response
  }

  const remotePath = (ref: IMRemoteAttachmentRef) => {
    if (!ref.groupID || !ref.messageID || ref.groupID.length > 512 || ref.messageID.length > 512)
      throw new IMRequestError("media_unavailable", "Attachment locator is unavailable")
    return `/api/v1/im/groups/${encodeURIComponent(ref.groupID)}/messages/${encodeURIComponent(ref.messageID)}/attachments/${encodeURIComponent(ref.attachment.attachmentID)}`
  }
  const remoteMetadata = async (ref: IMRemoteAttachmentRef, signal: AbortSignal) => {
    const target = scope()
    const original = Schema.decodeUnknownSync(KernelReaderSchema.RemoteAttachment)(ref.attachment, {
      onExcessProperty: "error",
    })
    const value = Schema.decodeUnknownSync(KernelReaderSchema.RemoteAttachment)(
      await (await mediaRequest(remotePath(ref), signal)).json(),
      { onExcessProperty: "error" },
    )
    signal.throwIfAborted()
    if (scope() !== target || JSON.stringify(value) !== JSON.stringify(original) || value.expiresAt <= Date.now())
      throw new IMRequestError("media_unavailable", "Attachment changed")
    return value
  }
  // The SDK request interceptor moves placement headers into the query. Restore both at
  // the final transport hop so an IM gateway cannot silently lose directory/workspace routing.
  const scopedFetch = (captured: IMClientScope): typeof fetch =>
    Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        const headers = new Headers(request.headers)
        captured.headers.forEach((value, key) => headers.set(key, value))
        if (captured.directory) {
          headers.set("x-deepagent-code-directory", encodeURIComponent(captured.directory))
          url.searchParams.set("directory", captured.directory)
          if (url.pathname.startsWith("/api/")) url.searchParams.set("location[directory]", captured.directory)
        }
        const workspace = captured.headers.get("x-deepagent-code-workspace")
        if (workspace !== null) {
          url.searchParams.set("workspace", workspace)
          if (url.pathname.startsWith("/api/")) url.searchParams.set("location[workspace]", workspace)
        }
        return (sdk.fetch ?? fetch)(new Request(url, new Request(request, { headers })))
      },
      { preconnect: (sdk.fetch ?? fetch).preconnect },
    )

  const scopedOptions = (captured: IMClientScope, signal: AbortSignal) => ({
    headers: new Headers(captured.headers),
    fetch: scopedFetch(captured),
    signal: AbortSignal.any([signal, ...(captured.signal ? [captured.signal] : [])]),
  })
  const sdkResponse = <T>(response: { data?: T; error?: unknown; response?: Response }, captured: IMClientScope) => {
    if (captured !== scope() || captured.signal?.aborted)
      throw new IMRequestError("dac_scope_changed", "DAC scope changed", 409)
    if (!response.response?.ok || response.data === undefined) {
      const error = response.error
      const rejected = Schema.decodeUnknownOption(
        Schema.Struct({
          name: Schema.Literal("IM_DAC_COMMAND_REJECTED"),
          data: Schema.Struct({ code: Schema.NonEmptyString, admitted: Schema.Literal(false) }),
        }),
        { onExcessProperty: "error" },
      )(error)
      if (
        response.response?.status === 409 &&
        Option.isSome(rejected) &&
        rejected.value.data.code !== "command_conflict"
      )
        throw new IMDacCommandRejected(rejected.value.data.code, "DAC command was not admitted", 409)
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : error &&
              typeof error === "object" &&
              "data" in error &&
              error.data &&
              typeof error.data === "object" &&
              "code" in error.data &&
              typeof error.data.code === "string"
            ? error.data.code
            : "dac_request_failed"
      throw new IMRequestError(code, "DAC request failed", response.response?.status ?? 0)
    }
    return response.data
  }
  const location = (captured: IMClientScope) => ({
    directory: captured.directory,
    workspace: captured.headers.get("x-deepagent-code-workspace") ?? undefined,
  })
  const dacAvailable = () => {
    const value = URL.parse(scope().url)
    if (!value || (value.protocol !== "http:" && value.protocol !== "https:")) return false
    if (value.hostname === "deepagent-code.internal") return !!sdk.fetch
    return value.hostname === "localhost" || value.hostname === "127.0.0.1" || value.hostname === "[::1]"
  }
  const requireLocalDac = () => {
    if (!dacAvailable()) throw new IMRequestError("dac_local_only", "Personal DAC requires the local connection")
  }
  const requireLocalActivation = () => {
    if (!dacAvailable())
      throw new IMRequestError("im_activation_unavailable", "Activation requires the local connection")
  }
  const dacBinding = async (groupID: string, signal: AbortSignal) => {
    requireLocalDac()
    const captured = scope()
    const value = Schema.decodeUnknownSync(IMDacSessionSchema.BindingResponse)(
      sdkResponse(
        await captured.client.im.dacBinding(
          { groupId: groupID, ...location(captured) },
          scopedOptions(captured, signal),
        ),
        captured,
      ),
      { onExcessProperty: "error" },
    )
    signal.throwIfAborted()
    if (
      value.groupID !== groupID ||
      !captured.directory ||
      value.directory !== captured.directory ||
      value.workspaceID !== (captured.headers.get("x-deepagent-code-workspace") ?? null)
    )
      throw new IMRequestError("dac_scope_changed", "DAC Session location changed", 409)
    if (
      value.recentCommands?.some(
        (command) =>
          command.groupID !== value.groupID ||
          command.projectID !== value.projectID ||
          command.directory !== value.directory ||
          command.workspaceID !== value.workspaceID ||
        command.bindingID !== value.bindingID,
      )
    )
      throw new IMRequestError("dac_scope_changed", "DAC command binding changed", 409)
    return value
  }
  const dacCommandResponse = (response: unknown, captured: IMClientScope, groupID: string, commandID: string) => {
    const value = Schema.decodeUnknownSync(IMDacSessionSchema.CommandResponse)(response, { onExcessProperty: "error" })
    if (
      captured !== scope() ||
      captured.signal?.aborted ||
      value.groupID !== groupID ||
      value.commandID !== commandID ||
      !captured.directory ||
      value.directory !== captured.directory ||
      value.workspaceID !== (captured.headers.get("x-deepagent-code-workspace") ?? null)
    )
      throw new IMRequestError("dac_scope_changed", "DAC command location changed", 409)
    return value
  }

  return {
    scope,
    dacAvailable,
    activationQuote: async (signal: AbortSignal) => {
      requireLocalActivation()
      const captured = scope()
      const response = sdkResponse(
        await captured.client.im.activationQuote(location(captured), scopedOptions(captured, signal)),
        captured,
      )
      signal.throwIfAborted()
      return Schema.decodeUnknownSync(IMActivationSchema.Quote)(response, { onExcessProperty: "error" })
    },
    activationPending: async (signal: AbortSignal) => {
      requireLocalActivation()
      const captured = scope()
      const response = sdkResponse(
        await captured.client.im.activationPending(location(captured), scopedOptions(captured, signal)),
        captured,
      )
      signal.throwIfAborted()
      return Schema.decodeUnknownSync(IMActivationSchema.Pending)(response, { onExcessProperty: "error" }).transaction
    },
    activate: async (input: IMActivationSchema.Submit, signal: AbortSignal) => {
      requireLocalActivation()
      const captured = scope()
      const body = Schema.decodeUnknownSync(IMActivationSchema.Submit)(input, { onExcessProperty: "error" })
      const response = sdkResponse(
        await captured.client.im.activate({ ...body, ...location(captured) }, scopedOptions(captured, signal)),
        captured,
      )
      signal.throwIfAborted()
      const value = Schema.decodeUnknownSync(IMActivationSchema.Transaction)(response, { onExcessProperty: "error" })
      if (
        value.transactionID !== body.transactionID ||
        value.name !== body.name ||
        value.method !== body.method ||
        value.quoteID !== body.quoteID
      )
        throw new IMRequestError("im_activation_unavailable", "Activation transaction changed")
      return value
    },
    activationStatus: async (transactionID: string, signal: AbortSignal) => {
      requireLocalActivation()
      const captured = scope()
      const response = sdkResponse(
        await captured.client.im.activationStatus(
          { transactionID, ...location(captured) },
          scopedOptions(captured, signal),
        ),
        captured,
      )
      signal.throwIfAborted()
      const value = Schema.decodeUnknownSync(IMActivationSchema.Transaction)(response, { onExcessProperty: "error" })
      if (value.transactionID !== transactionID)
        throw new IMRequestError("im_activation_unavailable", "Activation transaction changed")
      return value
    },
    imModelSettings: async (signal: AbortSignal) => {
      requireLocalDac()
      const captured = scope()
      const [config, providers] = await Promise.all([
        captured.client.config.get(location(captured), scopedOptions(captured, signal)),
        captured.client.provider.list(location(captured), scopedOptions(captured, signal)),
      ])
      signal.throwIfAborted()
      const catalog = sdkResponse(providers, captured)
      return {
        model: sdkResponse(config, captured).im?.model,
        models: catalog.all
          .filter((provider) => catalog.connected.includes(provider.id))
          .flatMap((provider) =>
            Object.entries(provider.models)
              .filter(([, model]) => model.status !== "deprecated")
              .map(([id, model]) => ({ id: `${provider.id}/${id}`, name: model.name, provider: provider.name })),
          ),
      }
    },
    setIMModel: async (model: string, signal: AbortSignal) => {
      requireLocalDac()
      const captured = scope()
      const settings = await captured.client.provider.list(location(captured), scopedOptions(captured, signal))
      const catalog = sdkResponse(settings, captured)
      signal.throwIfAborted()
      if (
        !catalog.all.some(
          (provider) =>
            catalog.connected.includes(provider.id) &&
            Object.entries(provider.models).some(
              ([id, value]) => `${provider.id}/${id}` === model && value.status !== "deprecated",
            ),
        )
      )
        throw new IMRequestError("im_model_unavailable", "IM model is unavailable")
      const result = sdkResponse(
        await captured.client.global.config.update({ config: { im: { model } } }, scopedOptions(captured, signal)),
        captured,
      )
      signal.throwIfAborted()
      if (result.im?.model !== model) throw new IMRequestError("im_model_unavailable", "IM model was not observed")
      return result.im.model
    },
    dacBinding,
    dacSubmit: async (groupID: string, input: typeof IMDacSessionSchema.Submit.Type, signal: AbortSignal) => {
      requireLocalDac()
      const captured = scope()
      const value = dacCommandResponse(
        sdkResponse(
          await captured.client.im.dacSubmit(
            {
              groupId: groupID,
              commandID: input.commandID,
              text: input.text,
              delivery: input.delivery,
              ...location(captured),
              ...(input.referenceMessageIDs ? { referenceMessageIDs: [...input.referenceMessageIDs] } : {}),
              ...(input.newSession !== undefined ? { newSession: input.newSession } : {}),
            },
            scopedOptions(captured, signal),
          ),
          captured,
        ),
        captured,
        groupID,
        input.commandID,
      )
      signal.throwIfAborted()
      return value
    },
    dacCommand: async (groupID: string, commandID: string, signal: AbortSignal) => {
      requireLocalDac()
      const captured = scope()
      const value = dacCommandResponse(
        sdkResponse(
          await captured.client.im.dacCommand(
            { groupId: groupID, commandID, ...location(captured) },
            scopedOptions(captured, signal),
          ),
          captured,
        ),
        captured,
        groupID,
        commandID,
      )
      signal.throwIfAborted()
      return value
    },
    dacReplyRetry: async (groupID: string, commandID: string, signal: AbortSignal) => {
      requireLocalDac()
      const captured = scope()
      const value = dacCommandResponse(
        sdkResponse(
          await captured.client.im.dacReplyRetry(
            { groupId: groupID, commandID, ...location(captured) },
            scopedOptions(captured, signal),
          ),
          captured,
        ),
        captured,
        groupID,
        commandID,
      )
      signal.throwIfAborted()
      return value
    },
    dacSession: async (groupID: string, sessionID: string, signal: AbortSignal, commandID?: string) => {
      const captured = scope()
      const binding = await dacBinding(groupID, signal)
      const historical = binding.sessionID !== sessionID && commandID ? dacCommandResponse(
        sdkResponse(await captured.client.im.dacCommand(
          { groupId: groupID, commandID, ...location(captured) }, scopedOptions(captured, signal)), captured),
        captured, groupID, commandID) : undefined
      if (!binding.bindingID || !binding.sessionID || (binding.sessionID !== sessionID &&
        (!historical || historical.state !== "admitted" || historical.bindingID !== binding.bindingID ||
          historical.sessionID !== sessionID || historical.projectID !== binding.projectID)))
        throw new IMRequestError("dac_scope_changed", "DAC Session binding changed", 409)
      const response = await captured.client.session.get(
        { sessionID, ...location(captured) },
        { ...scopedOptions(captured, signal), throwOnError: true },
      )
      signal.throwIfAborted()
      if (
        scope() !== captured ||
        !response.data ||
        response.data.id !== sessionID ||
        response.data.ordinaryEligible !== true ||
        response.data.projectID !== binding.projectID ||
        response.data.directory !== binding.directory ||
        (response.data.workspaceID ?? null) !== binding.workspaceID
      )
        throw new IMRequestError("dac_scope_changed", "DAC Session placement changed", 409)
      const current = await dacBinding(groupID, signal)
      if (
        scope() !== captured ||
        current.groupID !== binding.groupID ||
        current.projectID !== binding.projectID ||
        current.directory !== binding.directory ||
        current.workspaceID !== binding.workspaceID ||
        current.bindingID !== binding.bindingID ||
        current.sessionID !== binding.sessionID
      )
        throw new IMRequestError("dac_scope_changed", "DAC Session binding changed", 409)
      // Only an authoritative command in this exact binding can provide a historical pointer.
      // The current binding is revalidated above; this does not adopt or execute the Session.
      return { ...binding, sessionID }
    },
    getRemoteAttachment: remoteMetadata,
    streamRemoteAttachment: async (input: IMRemoteAttachmentRef, signal: AbortSignal): Promise<MediaFileStream> => {
      const target = scope()
      const ref = { groupID: input.groupID, messageID: input.messageID, attachment: { ...input.attachment } }
      const value = await remoteMetadata(ref, signal)
      if (scope() !== target) throw new IMRequestError("media_unavailable", "Attachment scope changed")
      const response = await mediaRequest(`${remotePath(ref)}/content`, signal)
      if (
        scope() !== target ||
        response.status !== 200 ||
        response.redirected ||
        response.headers.get("content-type") !==
          (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.mime)
            ? value.mime
            : "application/octet-stream") ||
        (response.headers.has("content-length") &&
          response.headers.get("content-length") !== String(value.sizeBytes)) ||
        response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("x-content-type-options") !== "nosniff" ||
        (!response.body && value.sizeBytes !== 0)
      ) {
        await response.body?.cancel().catch(() => undefined)
        throw new IMRequestError("media_unavailable", "Attachment response is unavailable")
      }
      return Object.freeze({
        body:
          response.body ??
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
        sizeBytes: value.sizeBytes,
        checksum: value.sha256,
        expiresAt: value.expiresAt,
        mime: value.mime,
        seal: async () => {
          signal.throwIfAborted()
          if (scope() !== target) throw new IMRequestError("media_unavailable", "Attachment scope changed")
          await remoteMetadata(ref, signal)
          signal.throwIfAborted()
          if (scope() !== target || value.expiresAt <= Date.now())
            throw new IMRequestError("media_unavailable", "Attachment observation expired")
        },
      })
    },
    downloadRemoteAttachment: async (input: IMRemoteAttachmentRef, signal: AbortSignal) => {
      const target = scope()
      const ref = { groupID: input.groupID, messageID: input.messageID, attachment: { ...input.attachment } }
      const value = await remoteMetadata(ref, signal)
      const response = await mediaRequest(`${remotePath(ref)}/content`, signal)
      if (
        response.status !== 200 ||
        response.redirected ||
        response.headers.get("content-type") !==
          (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.mime)
            ? value.mime
            : "application/octet-stream") ||
        (response.headers.has("content-length") &&
          response.headers.get("content-length") !== String(value.sizeBytes)) ||
        response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("x-content-type-options") !== "nosniff"
      )
        throw new IMRequestError("media_unavailable", "Attachment response is unavailable")
      const bytes =
        !response.body && value.sizeBytes === 0
          ? new Uint8Array(0)
          : await MediaIntent.readBytes(response.body, value.sizeBytes, signal)
      if (
        (await MediaIntent.checksum(bytes)) !== value.sha256 ||
        value.expiresAt <= Date.now() ||
        (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.mime) &&
          AttachmentPreview.mime(bytes) !== value.mime)
      )
        throw new IMRequestError("media_unavailable", "Attachment integrity failed")
      await remoteMetadata(ref, signal)
      signal.throwIfAborted()
      if (scope() !== target || value.expiresAt <= Date.now())
        throw new IMRequestError("media_unavailable", "Attachment observation expired")
      return bytes
    },
    listGroups: (signal?: AbortSignal) => request<IMGroup[]>({ method: "GET", url: "/api/v1/im/groups", signal }),
    listGroupPage: (lane: IMGroupPage["lane"], cursor?: string, signal?: AbortSignal) =>
      observeGroups(() =>
        request<IMGroupPage>({
          method: "GET",
          url: `/api/v1/im/groups/page?${new URLSearchParams({ lane, ...(cursor ? { cursor } : {}) })}`,
          signal,
        }),
      ).then((page) => ({ ...page, groups: page.groups.map(groupRecord) })),
    getGroup: (groupID: string, signal?: AbortSignal) =>
      observeGroups(() =>
        request<IMGroupDetail>({ method: "GET", url: `/api/v1/im/groups/${encodeURIComponent(groupID)}`, signal }),
      ).then((detail) => ({ ...detail, group: groupRecord(detail.group) })),
    refreshGroup: (groupID: string, signal?: AbortSignal) =>
      observeGroups(() =>
        request<IMGroupDetail>({
          method: "POST",
          url: `/api/v1/im/groups/${encodeURIComponent(groupID)}/refresh`,
          signal,
        }),
      ).then((detail) => ({ ...detail, group: groupRecord(detail.group) })),
    createGroup: (payload: {
      name: string
      type: "project" | "system" | "direct"
      member?: { memberID: string; memberType: "user" | "agent" }
    }) => request<IMGroup>({ method: "POST", url: "/api/v1/im/groups", body: payload }),
    listMessages: (groupID: string, limit = 50, cursor?: string, signal?: AbortSignal) =>
      request<IMMessagePage>({
        method: "GET",
        signal,
        url: `/api/v1/im/groups/${encodeURIComponent(groupID)}/messages?${new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) })}`,
      }),
    createMessage: (
      groupID: string,
      payload: {
        content: string
        type?: string
        mentions?: string[]
        clientRequestID?: string
        attachmentID?: string
        attachmentIDs?: string[]
      },
      signal?: AbortSignal,
    ) =>
      request<IMMessage>({
        method: "POST",
        signal:
          payload.type === "file"
            ? AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])])
            : signal,
        redirect: payload.type === "file" ? "error" : undefined,
        url: `/api/v1/im/groups/${encodeURIComponent(groupID)}/messages`,
        body: { senderType: "user", type: payload.type ?? "text", ...payload },
      }),
    mediaEnabled: async (signal: AbortSignal) => {
      const response: unknown = await (await mediaRequest("/global/capabilities", signal)).json()
      return (
        typeof response === "object" &&
        response !== null &&
        "features" in response &&
        typeof response.features === "object" &&
        response.features !== null &&
        "v4FileUploadEnabled" in response.features &&
        response.features.v4FileUploadEnabled === true
      )
    },
    uploadAttachment: async (file: File, groupID: string, signal: AbortSignal) => {
      const form = new FormData()
      form.append("file", file, file.name)
      form.append("groupId", groupID)
      return MediaIntent.attachment(await (await mediaRequest("/api/v1/im/attachments", signal, form)).json())
    },
    getAttachment: async (id: string, signal: AbortSignal) =>
      MediaIntent.attachment(
        await (await mediaRequest(`/api/v1/im/attachments/${encodeURIComponent(id)}`, signal)).json(),
      ),
    downloadAttachment: async (value: MediaIntent.Attachment, signal: AbortSignal) => {
      const target = scope()
      const path = `/api/v1/im/attachments/${encodeURIComponent(value.id)}`
      const before = MediaIntent.attachment(await (await mediaRequest(path, signal)).json())
      if (JSON.stringify(before) !== JSON.stringify(value) || !value.messageID || value.expiresAt <= Date.now())
        throw new IMRequestError("media_unavailable", "Attachment changed")
      const bytes = await MediaIntent.verifiedBytes(await mediaRequest(`${path}/content`, signal), value, signal)
      const after = MediaIntent.attachment(await (await mediaRequest(path, signal)).json())
      if (scope() !== target || JSON.stringify(after) !== JSON.stringify(before))
        throw new IMRequestError("media_unavailable", "Attachment changed")
      return bytes
    },
    streamAttachment: async (value: MediaIntent.Attachment, signal: AbortSignal): Promise<MediaFileStream> => {
      const target = scope()
      const original = MediaIntent.attachment(value)
      const path = `/api/v1/im/attachments/${encodeURIComponent(original.id)}`
      const before = MediaIntent.attachment(await (await mediaRequest(path, signal)).json())
      if (
        JSON.stringify(before) !== JSON.stringify(original) ||
        !original.messageID ||
        original.expiresAt <= Date.now()
      )
        throw new IMRequestError("media_unavailable", "Attachment changed")
      if (scope() !== target) throw new IMRequestError("media_unavailable", "Attachment scope changed")
      const response = await mediaRequest(`${path}/content`, signal)
      const length = response.headers.get("content-length")
      if (
        scope() !== target ||
        response.status !== 200 ||
        response.redirected ||
        (length !== null && Number(length) !== original.sizeBytes) ||
        (!response.body && original.sizeBytes !== 0)
      ) {
        await response.body?.cancel().catch(() => undefined)
        throw new IMRequestError("media_unavailable", "Attachment response is unavailable")
      }
      return Object.freeze({
        body:
          response.body ??
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
        sizeBytes: original.sizeBytes,
        checksum: original.checksum,
        expiresAt: original.expiresAt,
        mime: original.mime,
        seal: async () => {
          signal.throwIfAborted()
          if (scope() !== target) throw new IMRequestError("media_unavailable", "Attachment scope changed")
          const after = MediaIntent.attachment(await (await mediaRequest(path, signal)).json())
          signal.throwIfAborted()
          if (
            scope() !== target ||
            JSON.stringify(after) !== JSON.stringify(before) ||
            original.expiresAt <= Date.now()
          )
            throw new IMRequestError("media_unavailable", "Attachment changed")
        },
      })
    },
    markRead: (groupID: string, action?: IMReadAction) =>
      request<IMReadResult>({
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        url: `/api/v1/im/groups/${encodeURIComponent(groupID)}/read`,
        body: action ?? {},
      }),
    facadeStatus: (signal?: AbortSignal) =>
      request<IMFacadeStatus>({ method: "GET", url: "/api/v1/im/status", signal }),
    facadeRename: (name: string) =>
      request<IMFacadeIdentity>({ method: "POST", url: "/api/v1/im/facade/rename", body: { name } }),
    facadeRetry: () => request<IMFacadeIdentity>({ method: "POST", url: "/api/v1/im/facade/retry", body: {} }),
    facadeResolve: (name: string) =>
      request<{ uuid: string; name: string }>({
        method: "GET",
        url: `/api/v1/im/facade/resolve?${new URLSearchParams({ name })}`,
      }),
    facadeOpenDirect: (name: string) =>
      request<IMGroup>({ method: "POST", url: "/api/v1/im/facade/direct", body: { name } }),
    facadeCreateGroup: (name: string, memberNames: string[]) =>
      request<IMGroup>({ method: "POST", url: "/api/v1/im/facade/groups", body: { name, memberNames } }),
    facadeInvite: (groupID: string, name: string) =>
      request<{ ok: boolean }>({
        method: "POST",
        url: `/api/v1/im/facade/groups/${encodeURIComponent(groupID)}/invite`,
        body: { name },
      }),
  }
}

export type IMClient = ReturnType<typeof createIMClient>

// Recover the entire gap to the oldest displayed message. Stopping at any shared ID is
// unsafe: a WS message received during the HTTP request can overlap the first page while
// the disconnected interval is still missing farther down the history.
export async function recoverIMMessages(client: IMClient, groupID: string, oldestID?: string, signal?: AbortSignal) {
  const messages: IMMessage[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let pageCount = 0; pageCount < 256; pageCount += 1) {
    const page = await client.listMessages(groupID, 50, cursor, signal)
    const boundary = page.messages.findIndex((message) => message.id === oldestID)
    messages.push(...(boundary < 0 ? page.messages : page.messages.slice(0, boundary + 1)))
    if (!oldestID || boundary >= 0 || !page.hasMore) return { ...page, messages }
    if (!page.nextCursor || cursors.has(page.nextCursor))
      throw new IMRequestError("invalid_response", "IM history did not advance; retry the recovery")
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw new IMRequestError("invalid_response", "IM history recovery exceeded its page limit; retry the recovery")
}

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
    if (mode !== "live" || (previous && httpObservations.has(previous))) httpObservations.add(next)
    merged.set(message.id, next)
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

// Live channel for one group. The WS event protocol (server → client): message_created,
// message_failed, agent_status, typing, read_receipt, ping. Reconnect with backoff; only
// message_created/message_failed matter for the TUI surface so far.
export function openIMGroupSocket(
  sdk: IMSDK,
  groupID: string,
  handlers: {
    onMessage?: (message: IMMessage) => void
    onFailed?: (payload: { clientMessageID?: string; code: string; message: string }) => void
    onOpen?: () => void
    protected?: boolean
    onReaderChanged?: (value: { groupID: string; displayEpoch: string }) => void
    onReaderInvalidated?: (value: { groupID: string; displayEpoch: string; code: string }) => void
    onState?: (state: "connecting" | "connected" | "disconnected") => void
  },
) {
  const url = new URL(`${sdk.url.replace(/\/+$/, "")}/ws/im/group/${encodeURIComponent(groupID)}`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (sdk.directory) {
    url.searchParams.set("directory", sdk.directory)
    url.searchParams.set("location[directory]", sdk.directory)
  }
  const signal = transport(sdk).getConfig().signal
  const headers = new Headers(transport(sdk).getConfig().headers)
  if (sdk.directory) headers.set("x-deepagent-code-directory", encodeURIComponent(sdk.directory))
  let socket: WebSocket | undefined
  let closed = false
  let attempt = 0
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined

  const close = () => {
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    if (retry) clearTimeout(retry)
    signal?.removeEventListener("abort", close)
    socket?.close()
  }

  const connect = () => {
    if (closed) return
    handlers.onState?.("connecting")
    // TUI runs on Bun, whose WebSocket supports the same authenticated headers as HTTP.
    const Socket = WebSocket as unknown as new (url: string, options: { headers?: RequestInit["headers"] }) => WebSocket
    const active = new Socket(url.toString(), { headers })
    socket = active
    active.onopen = () => {
      if (closed || socket !== active) return
      attempt = 0
      handlers.onState?.("connected")
      handlers.onOpen?.()
      heartbeat = setInterval(() => {
        if (active.readyState === WebSocket.OPEN)
          active.send(JSON.stringify({ type: "ping", data: { ts: Date.now() } } satisfies PingEvent))
      }, 30_000)
    }
    active.onmessage = (event) => {
      if (closed || socket !== active) return
      try {
        const payload = JSON.parse(String(event.data)) as { type: string; data?: unknown }
        if (Schema.is(PingEvent)(payload) && active.readyState === WebSocket.OPEN)
          active.send(JSON.stringify({ type: "pong", data: { ts: payload.data.ts } } satisfies PongEvent))
        if (payload.type === "message_created" && !handlers.protected) handlers.onMessage?.(payload.data as IMMessage)
        if (payload.type === "reader_changed" || payload.type === "reader_invalidated") {
          const data = payload.data as { groupID?: unknown; displayEpoch?: unknown; code?: unknown } | undefined
          if (data?.groupID !== groupID || typeof data.displayEpoch !== "string") return
          if (payload.type === "reader_changed")
            handlers.onReaderChanged?.({ groupID, displayEpoch: data.displayEpoch })
          else
            handlers.onReaderInvalidated?.({
              groupID,
              displayEpoch: data.displayEpoch,
              code: typeof data.code === "string" ? data.code : "reader_unavailable",
            })
        }
        if (payload.type === "message_failed")
          handlers.onFailed?.(payload.data as { clientMessageID?: string; code: string; message: string })
      } catch {
        // Ignore malformed frames — the next HTTP re-sync heals.
      }
    }
    active.onerror = () => {
      // Bun emits close after a failed handshake; that single owner schedules the retry.
    }
    active.onclose = () => {
      if (socket !== active) return
      if (heartbeat) clearInterval(heartbeat)
      if (closed) return
      handlers.onState?.("disconnected")
      attempt += 1
      retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)))
    }
  }
  signal?.addEventListener("abort", close, { once: true })
  if (signal?.aborted) close()
  if (!closed) connect()

  return { close }
}
