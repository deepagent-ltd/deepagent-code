import { EventV2 } from "@deepagent-code/core/event"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { ProviderV2 } from "@deepagent-code/core/provider"
import {
  APIError,
  AbortedError,
  Assistant,
  AuthError,
  CompactionPart,
  ContextOverflowError,
  DoomLoopError,
  Info,
  OutputDegenerationError,
  OutputLengthError,
  PlanProtocolViolationError,
  Part,
  StructuredOutputError,
  SubtaskPart,
  TaskBudgetExceededError,
  User,
  WithParts,
  type ToolPart,
} from "@deepagent-code/core/v1/session"

import { NamedError } from "@deepagent-code/core/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Database } from "@deepagent-code/core/database/database"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import {
  MessageTable,
  PartTable,
  SessionForkAdmissionTable,
  SessionForkIntentTable,
  SessionPromptEpochMessageTable,
  SessionTable,
  SessionWorldStateBaselineTable,
} from "@deepagent-code/core/session/sql"
import { SessionPromptEpochTable } from "./prompt-epoch.sql"
import { ProviderError } from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import type { Provider } from "@/provider/provider"
import { Data, Effect, Exit, Option, Schema } from "effect"
import * as EffectLogger from "@deepagent-code/core/effect/logger"
import { SessionHistoryStateTable } from "@deepagent-code/core/session/sql"
import { CompactionArtifactTable, CompactionRunTable } from "./compaction-sql"
import { HistoryAuthority } from "./history-authority"
import {
  collectSessionWorldStateBaseline,
  renderSessionWorldStateBaseline,
  sessionWorldStateBaselineHash,
  type SessionWorldStateBaselineSection,
} from "./context-ledger"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorldStateSlot } from "@deepagent-code/core/deepagent/context/world-state"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

const transientTransportCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
])

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"
export { isMedia }

export class HistoryAuthorityError extends Data.TaggedError("SessionHistory.AuthorityError")<{
  readonly sessionID: SessionID
  readonly reason: string
}> {}

export type PromptHistoryProjection = {
  readonly sessionID: SessionID
  readonly epoch: number
  readonly messages: WithParts[]
  readonly orderedMessageIDs: MessageID[]
  readonly effectiveHistoryHash: string
  readonly projectionVersion: number
  readonly canonicalizationVersion: number
  readonly baseMessageCount: number
  readonly window: {
    readonly firstWindowID: string
    readonly previousWindowID?: string
    readonly windowID: string
  }
  readonly worldStateBaselineHash?: string
}

export type PromptWorldStateProjection = {
  readonly sessionID: SessionID
  readonly epoch: number
  readonly windowID: string
  readonly effectiveHistoryHash: string
  readonly hash: string
  readonly rendered: string
  readonly sections: readonly SessionWorldStateBaselineSection[]
}

export function validateProviderPromptBoundary(input: {
  readonly authority: PromptHistoryProjection
  readonly dispatch: PromptHistoryProjection
  readonly assistantMessageID: MessageID
  readonly parentMessageID: MessageID
}) {
  if (input.dispatch.epoch !== input.authority.epoch) return "prompt epoch changed"
  if (input.dispatch.window.windowID !== input.authority.window.windowID) return "context window changed"
  if (input.dispatch.messages.length !== input.authority.messages.length + 1) {
    return "effective history changed outside the current assistant draft"
  }
  const draft = input.dispatch.messages.at(-1)
  if (draft?.info.id !== input.assistantMessageID) return "current assistant draft is not the history tail"
  if (draft.info.role !== "assistant") return "current assistant draft has an invalid role"
  if (draft.info.parentID !== input.parentMessageID) return "current assistant draft has an invalid parent"
  if (
    draft.parts.length !== 0 ||
    draft.info.error !== undefined ||
    draft.info.finish !== undefined ||
    draft.info.time.completed !== undefined ||
    draft.info.providerAttemptID !== undefined
  ) {
    return "current assistant draft is no longer pristine"
  }
  if (HistoryAuthority.hash(input.dispatch.messages.slice(0, -1)) !== input.authority.effectiveHistoryHash) {
    return "effective history hash changed"
  }
}

export function appendPromptWorldState(input: {
  readonly messages: readonly WithParts[]
  readonly sessionID: SessionID
  readonly epoch: number
  readonly baselineHash: string
  readonly rendered: string
  readonly agent: string
  readonly model: User["model"]
}): WithParts[] {
  if (input.rendered.trim().length === 0) return [...input.messages]
  const messageID = MessageID.make(
    `msg_${Hash.sha256(`world-state-message:v1:${input.sessionID}:${input.epoch}:${input.baselineHash}`).slice(0, 26)}`,
  )
  const partID = PartID.make(
    `prt_${Hash.sha256(`world-state-part:v1:${input.sessionID}:${input.epoch}:${input.baselineHash}`).slice(0, 26)}`,
  )
  const contextProvenance = {
    source: "world_state",
    ownerSessionID: input.sessionID,
    ownerPromptEpoch: input.epoch,
    snapshotHash: input.baselineHash,
    durable: true,
  }
  return [
    ...input.messages,
    {
      info: {
        id: messageID,
        role: "user",
        sessionID: input.sessionID,
        time: { created: 0 },
        agent: input.agent,
        model: input.model,
        metadata: { deepagent: { contextProvenance } },
      },
      parts: [
        {
          id: partID,
          messageID,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: input.rendered,
          metadata: { deepagent: { contextProvenance } },
        },
      ],
    },
  ]
}

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

export const Event = {
  Updated: SessionV1.Event.MessageUpdated,
  Removed: SessionV1.Event.MessageRemoved,
  PartUpdated: SessionV1.Event.PartUpdated,
  PartDelta: EventV2.define({
    type: "message.part.delta",
    schema: {
      sessionID: SessionID,
      messageID: MessageID,
      partID: PartID,
      field: Schema.String,
      delta: Schema.String,
    },
  }),
  PartRemoved: SessionV1.Event.PartRemoved,
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

// Legacy-data repair: OutputFormatText/OutputFormatJsonSchema are Schema.Class, so their ENCODERS
// are instanceof-gated. Subagent (researcher/reviewer) messages persisted BEFORE the d6c325e fix
// stored `format` as a PLAIN OBJECT literal. On read, the messages endpoint encodes the Info through
// the schema; a plain-object format then throws "Expected OutputFormatJsonSchema, got {...}" at
// ["info"]["format"], which rejects fetchMessages and crashes the renderer (the app "restart" the
// user sees on clicking such a session). d6c325e fixed the WRITE path but not already-persisted rows,
// so we coerce here — the single choke point every stored message flows through on read. Idempotent:
// a value that is already an instance (or absent, or unrecognized) is returned untouched.
const decodeFormat = Schema.decodeUnknownExit(SessionV1.Format)
export const normalizeFormat = (data: Record<string, unknown>): Record<string, unknown> => {
  const format = (data as { format?: unknown }).format
  if (!format || typeof format !== "object") return data
  if (format instanceof SessionV1.OutputFormatText || format instanceof SessionV1.OutputFormatJsonSchema) return data
  // Coerce a legacy plain-object format to an instance through the SAME decode path the write-side
  // fix (d6c325e prompt()) uses — idempotent, fills retryCount's decoding default, handles both
  // variants. If it doesn't decode (unrecognized shape), leave it: the encoder will surface a clear
  // error rather than us silently dropping a field.
  const decoded = decodeFormat(format)
  return Exit.isSuccess(decoded) ? { ...data, format: decoded.value } : data
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...normalizeFormat(row.data as Record<string, unknown>),
    id: row.id,
    sessionID: row.session_id,
  }) as Info

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

function hydrate(db: Database.Interface["db"], rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  return Effect.gen(function* () {
    if (ids.length > 0) {
      const partRows = yield* db
        .select({ part: PartTable })
        .from(PartTable)
        .innerJoin(
          MessageTable,
          and(eq(MessageTable.id, PartTable.message_id), eq(MessageTable.session_id, PartTable.session_id)),
        )
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all()
        .pipe(Effect.orDie)
      for (const row of partRows) {
        const next = part(row.part)
        const list = partByMessage.get(row.part.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.part.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  })
}

export function messagesInTransaction(
  tx: Database.Interface["db"],
  sessionID: SessionID,
  messageIDs: readonly MessageID[],
) {
  return Effect.gen(function* () {
    if (messageIDs.length === 0) return [] as WithParts[]
    const rows = yield* tx
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, sessionID), inArray(MessageTable.id, [...messageIDs])))
      .all()
    if (rows.length !== messageIDs.length) return
    const hydrated = yield* hydrate(tx, rows)
    const byID = new Map(hydrated.map((message) => [message.info.id, message]))
    const ordered = messageIDs.flatMap((messageID) => {
      const message = byID.get(messageID)
      return message ? [message] : []
    })
    if (ordered.length !== messageIDs.length) return
    return ordered
  })
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, deepagent_activity_progress: __, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

function toolCallProviderMeta(metadata: Record<string, any> | undefined, differentModel: boolean) {
  const type = metadata?.deepagent?.toolType
  if (type !== "custom" && type !== "function") return differentModel ? undefined : providerMeta(metadata)
  if (!differentModel) return providerMeta(metadata)
  return { deepagent: { toolType: type } }
}

type ReasoningReplay =
  | { readonly mode: "none" }
  | { readonly mode: "active-continuation" }
  | { readonly mode: "signed-prefix"; readonly metadataKey: "anthropic" | "bedrock" }
  | { readonly mode: "encrypted-prefix" }

function reasoningReplayCapability(model: Provider.Model): ReasoningReplay {
  if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic") {
    return { mode: "signed-prefix", metadataKey: "anthropic" }
  }
  if (model.api.npm === "@ai-sdk/amazon-bedrock") {
    return { mode: "signed-prefix", metadataKey: "bedrock" }
  }
  if (
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/azure" ||
    model.api.npm === "@ai-sdk/github-copilot" ||
    model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    return { mode: "encrypted-prefix" }
  }
  if (model.capabilities.interleaved !== false) return { mode: "active-continuation" }
  return { mode: "none" }
}

function hasReasoningState(part: SessionV1.ReasoningPart, replay: ReasoningReplay) {
  if (replay.mode === "active-continuation") return true
  if (replay.mode === "signed-prefix") {
    const state = part.metadata?.[replay.metadataKey]
    return [state?.signature, state?.redactedData].some((value) => typeof value === "string" && value.trim().length > 0)
  }
  if (replay.mode === "encrypted-prefix") {
    const state = part.metadata?.openai
    return [state?.reasoningEncryptedContent, state?.encryptedContent].some(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  }
  return false
}

function isActivityProgress(part: SessionV1.TextPart) {
  const progress = part.metadata?.deepagent_activity_progress
  return (
    progress?.state === "progress" &&
    typeof progress.activity_id === "string" &&
    progress.activity_id.length > 0 &&
    Number.isInteger(progress.revision) &&
    progress.revision >= 0
  )
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number; terminalBoundaryID?: MessageID },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  const reasoningReplay = reasoningReplayCapability(model)
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support that media type in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Some SDKs only support a subset
  // of media in tool results; e.g. Bedrock supports images but not PDFs there.
  //
  // Only apply this workaround if the model actually supports that media input -
  // otherwise unsupportedParts() will turn it into a user-visible error.
  const supportsMediaInToolResult = (attachment: { mime: string }) => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/xai") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  }

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      for (const part of msg.parts) {
        // User message parts should never be empty
        if (part.type === "text" && !part.ignored && part.text !== "")
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
      if (userMessage.parts.length > 0) result.push(userMessage)
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const isActive = !options?.terminalBoundaryID || msg.info.id > options.terminalBoundaryID
      const media: Array<{ mime: string; url: string; filename?: string }> = []

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      // Anthropic adaptive thinking can persist assistant turns like:
      // step-start, reasoning(signature), text(""), step-start,
      // reasoning(signature). The empty text part is a structural separator,
      // but it does not carry the signature metadata itself. Dropping it shifts
      // signed thinking positions after step-start splitting/provider regrouping;
      // keeping it as "" is filtered by the AI SDK and rejected by Anthropic.
      // It is unclear whether this shape originates in our stream processing,
      // a proxy, or a lower-level library, but preserving a non-empty separator
      // here is the only safe replay point we have.
      // Use a single space so the separator survives replay without changing
      // the neighboring signed reasoning blocks.
      const hasSignedReasoning =
        !differentModel &&
        msg.parts.some((part) => {
          if (part.type !== "reasoning") return false
          return (
            reasoningReplay.mode === "signed-prefix" &&
            reasoningReplay.metadataKey === "anthropic" &&
            hasReasoningState(part, reasoningReplay)
          )
        })
      const settledActivityProgress = msg.parts.some((part) => part.type === "text" && isActivityProgress(part))
      for (const part of msg.parts) {
        if (part.type === "text") {
          if (!isActive && settledActivityProgress) continue
          const text = part.text === "" && hasSignedReasoning ? " " : part.text
          assistantMessage.parts.push({
            type: "text",
            text,
            ...(differentModel ? {} : { providerMetadata: providerMeta(part.metadata) }),
          })
        }
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const extractedMedia = mediaAttachments.filter((a) => !supportsMediaInToolResult(a))
            if (extractedMedia.length > 0) {
              media.push(...extractedMedia)
            }
            const finalAttachments = attachments.filter((a) => !isMedia(a.mime) || supportsMediaInToolResult(a))

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(toolCallProviderMeta(part.metadata, differentModel)
                ? { callProviderMetadata: toolCallProviderMeta(part.metadata, differentModel) }
                : {}),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(toolCallProviderMeta(part.metadata, differentModel)
                  ? { callProviderMetadata: toolCallProviderMeta(part.metadata, differentModel) }
                  : {}),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(toolCallProviderMeta(part.metadata, differentModel)
                  ? { callProviderMetadata: toolCallProviderMeta(part.metadata, differentModel) }
                  : {}),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(toolCallProviderMeta(part.metadata, differentModel)
                ? { callProviderMetadata: toolCallProviderMeta(part.metadata, differentModel) }
                : {}),
            })
        }
        if (part.type === "reasoning") {
          if (differentModel) {
            if (!isActive) continue
            if (part.text.trim().length > 0)
              assistantMessage.parts.push({
                type: "text",
                text: part.text,
              })
            continue
          }
          // Replay only protocol state the selected provider can consume. Plain same-model
          // reasoning is audit history, not an append-only provider prefix; after settlement it
          // must not become input to a new user activity.
          if (!hasReasoningState(part, reasoningReplay)) continue
          if (reasoningReplay.mode === "active-continuation" && !isActive) continue
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            providerMetadata: part.metadata,
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
                filename: attachment.filename,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number; terminalBoundaryID?: MessageID },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options).pipe(Effect.provide(EffectLogger.layer)))
}

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const { db } = yield* Database.Service
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(where)
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    const row = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = yield* hydrate(db, slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})

export function stream(sessionID: SessionID) {
  const size = 50
  return Effect.gen(function* () {
    const result = [] as WithParts[]
    let before: string | undefined
    while (true) {
      const next = yield* page({ sessionID, limit: size, before }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () =>
          Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
        ),
      )
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        const item = next.items[i]
        if (item) result.push(item)
      }
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
    return result
  })
}

export function parts(messageID: MessageID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ part: PartTable })
      .from(PartTable)
      .innerJoin(
        MessageTable,
        and(eq(MessageTable.id, PartTable.message_id), eq(MessageTable.session_id, PartTable.session_id)),
      )
      .where(eq(PartTable.message_id, messageID))
      .orderBy(PartTable.id)
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => part(row.part))
  })
}

export const get = Effect.fn("MessageV2.get")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: yield* parts(input.messageID),
  }
})

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ]
  }
  return result
}

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return filterCompacted(yield* stream(sessionID))
})

const projectPromptHistory = Effect.fn("MessageV2.projectPromptHistory")(function* (
  sessionID: SessionID,
  ignoredCompactionMarkerID?: MessageID,
) {
  const { db } = yield* Database.Service
  const initial = yield* readHistorySnapshot(db, sessionID, ignoredCompactionMarkerID)
  const snapshot =
    initial.epoch?.authority_state === "ready"
      ? initial
      : yield* migrateHistoryAuthority({
          sessionID,
          chronological: initial.chronological,
          existing: initial.epoch,
          ignoredCompactionMarkerID,
        }).pipe(
          Effect.provideService(Database.Service, { db }),
          Effect.andThen(readHistorySnapshot(db, sessionID, ignoredCompactionMarkerID)),
        )
  const epoch = snapshot.epoch
  const chronological = snapshot.chronological

  if (!epoch) {
    return yield* failHistoryAuthority({ sessionID, reason: "active history authority is missing" })
  }

  if (epoch.authority_state === "recovery_required") {
    return yield* new HistoryAuthorityError({
      sessionID,
      reason: epoch.recovery_reason ?? "history authority recovery is required",
    })
  }
  if (
    epoch.authority_state !== "ready" ||
    epoch.projection_version !== HistoryAuthority.PROJECTION_VERSION ||
    epoch.canonicalization_version !== HistoryAuthority.CANONICALIZATION_VERSION ||
    epoch.base_message_count === null ||
    !epoch.effective_history_hash ||
    !epoch.first_window_id ||
    !epoch.window_id
  ) {
    return yield* failHistoryAuthority({
      sessionID,
      epoch: epoch.epoch,
      reason: `epoch ${epoch.epoch} authority is incomplete`,
    })
  }

  const selected = selectEpochHistory(chronological, epoch, snapshot.replacementMessageIDs)
  if (!selected.ok) return yield* failHistoryAuthority({ sessionID, epoch: epoch.epoch, reason: selected.reason })
  if (epoch.base_message_count < 0 || epoch.base_message_count > selected.messages.length) {
    return yield* failHistoryAuthority({
      sessionID,
      epoch: epoch.epoch,
      reason: `epoch ${epoch.epoch} base message count is outside the effective projection`,
    })
  }
  if (HistoryAuthority.hash(selected.messages.slice(0, epoch.base_message_count)) !== epoch.effective_history_hash) {
    return yield* failHistoryAuthority({
      sessionID,
      epoch: epoch.epoch,
      reason: `epoch ${epoch.epoch} immutable replacement history hash mismatch`,
    })
  }

  return {
    sessionID,
    epoch: epoch.epoch,
    messages: selected.messages,
    orderedMessageIDs: selected.messages.map((message) => message.info.id),
    effectiveHistoryHash: HistoryAuthority.hash(selected.messages),
    projectionVersion: epoch.projection_version,
    canonicalizationVersion: epoch.canonicalization_version,
    baseMessageCount: epoch.base_message_count,
    window: {
      firstWindowID: epoch.first_window_id,
      ...(epoch.previous_window_id ? { previousWindowID: epoch.previous_window_id } : {}),
      windowID: epoch.window_id,
    },
    ...(epoch.world_state_baseline_hash ? { worldStateBaselineHash: epoch.world_state_baseline_hash } : {}),
  } satisfies PromptHistoryProjection
})

export const promptHistoryProjectionEffect = Effect.fn("MessageV2.promptHistoryProjection")(function* (
  sessionID: SessionID,
) {
  return yield* projectPromptHistory(sessionID)
})

export const promptHistoryBeforeCompactionEffect = Effect.fn("MessageV2.promptHistoryBeforeCompaction")(
  function* (input: { sessionID: SessionID; markerMessageID: MessageID }) {
    return yield* projectPromptHistory(input.sessionID, input.markerMessageID)
  },
)

export const promptHistoryEffect = Effect.fn("MessageV2.promptHistory")(function* (sessionID: SessionID) {
  return (yield* promptHistoryProjectionEffect(sessionID)).messages
})

export const promptWorldStateProjectionEffect = Effect.fn("MessageV2.promptWorldStateProjection")(function* (
  sessionID: SessionID,
) {
  const projection = yield* promptHistoryProjectionEffect(sessionID)
  if (!projection.worldStateBaselineHash) {
    if (projection.epoch === 0) return undefined
    return yield* failHistoryAuthority({
      sessionID,
      epoch: projection.epoch,
      reason: `epoch ${projection.epoch} has no World State baseline binding`,
    })
  }

  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(SessionWorldStateBaselineTable)
    .where(
      and(
        eq(SessionWorldStateBaselineTable.session_id, sessionID),
        eq(SessionWorldStateBaselineTable.prompt_epoch, projection.epoch),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    return yield* failHistoryAuthority({
      sessionID,
      epoch: projection.epoch,
      reason: `epoch ${projection.epoch} World State baseline rows are missing`,
    })
  }

  const sections = yield* Effect.forEach(
    rows.sort((a, b) => a.section_id.localeCompare(b.section_id)),
    (row) =>
      Effect.gen(function* () {
        const snapshot = Option.getOrUndefined(Schema.decodeUnknownOption(WorldStateSlot)(row.snapshot))
        if (!snapshot) {
          return yield* failHistoryAuthority({
            sessionID,
            epoch: projection.epoch,
            reason: `invalid World State snapshot: ${row.section_id}`,
          })
        }
        const fragmentHash = Hash.sha256(
          CanonicalJson.stringify({ sectionID: row.section_id, slot: snapshot, fragment: row.fragment }),
        )
        if (fragmentHash !== row.fragment_hash) {
          return yield* failHistoryAuthority({
            sessionID,
            epoch: projection.epoch,
            reason: `World State fragment hash mismatch: ${row.section_id}`,
          })
        }
        return {
          sectionID: row.section_id,
          snapshot,
          fragment: row.fragment,
          fragmentHash,
        } satisfies SessionWorldStateBaselineSection
      }),
  )
  const rendered = renderSessionWorldStateBaseline(sections)
  if (sessionWorldStateBaselineHash({ sections, rendered }) !== projection.worldStateBaselineHash) {
    return yield* failHistoryAuthority({
      sessionID,
      epoch: projection.epoch,
      reason: `World State baseline hash mismatch for epoch ${projection.epoch}`,
    })
  }
  return {
    sessionID,
    epoch: projection.epoch,
    windowID: projection.window.windowID,
    effectiveHistoryHash: projection.effectiveHistoryHash,
    hash: projection.worldStateBaselineHash,
    rendered,
    sections,
  } satisfies PromptWorldStateProjection
})

export const promptControlHistoryEffect = Effect.fn("MessageV2.promptControlHistory")(function* (sessionID: SessionID) {
  const history = yield* promptHistoryEffect(sessionID)
  const { db } = yield* Database.Service
  const markers = new Set(
    (yield* db
      .select({ message_id: CompactionArtifactTable.message_id })
      .from(CompactionArtifactTable)
      .innerJoin(CompactionRunTable, eq(CompactionRunTable.run_id, CompactionArtifactTable.run_id))
      .where(
        and(
          eq(CompactionArtifactTable.session_id, sessionID),
          eq(CompactionArtifactTable.kind, "marker"),
          eq(CompactionArtifactTable.state, "pending"),
          inArray(CompactionRunTable.state, ["requested", "summarizing"] as const),
        ),
      )
      .all()
      .pipe(Effect.orDie)).map((row) => row.message_id),
  )
  if (markers.size === 0) return history
  const known = new Set(history.map((message) => message.info.id))
  return [
    ...history,
    ...(yield* stream(sessionID))
      .reverse()
      .filter((message) => markers.has(message.info.id) && !known.has(message.info.id)),
  ]
})

type EpochRow = typeof SessionPromptEpochTable.$inferSelect
type EpochSelection =
  | { readonly ok: true; readonly messages: WithParts[] }
  | { readonly ok: false; readonly reason: string }

function readHistorySnapshotInTransaction(
  tx: Database.Interface["db"],
  sessionID: SessionID,
  ignoredCompactionMarkerID?: MessageID,
) {
  return Effect.gen(function* () {
    const hidden = new Set(
      (yield* tx
        .select({ message_id: CompactionArtifactTable.message_id, state: CompactionArtifactTable.state })
        .from(CompactionArtifactTable)
        .where(eq(CompactionArtifactTable.session_id, sessionID))
        .all())
        .filter((artifact) => artifact.state !== "committed")
        .map((artifact) => artifact.message_id),
    )
    const physical = (yield* stream(sessionID).pipe(Effect.provideService(Database.Service, { db: tx }))).reverse()
    const visible = physical.filter(
      (message) => message.info.id === ignoredCompactionMarkerID || !hidden.has(message.info.id),
    )
    const chronological = stripIgnoredCompactionMarker(visible, ignoredCompactionMarkerID)
    const epoch = yield* tx
      .select()
      .from(SessionPromptEpochTable)
      .where(and(eq(SessionPromptEpochTable.session_id, sessionID), eq(SessionPromptEpochTable.state, "active")))
      .get()
    const replacementMessageIDs = epoch
      ? (yield* tx
          .select({ message_id: SessionPromptEpochMessageTable.message_id })
          .from(SessionPromptEpochMessageTable)
          .where(
            and(
              eq(SessionPromptEpochMessageTable.session_id, sessionID),
              eq(SessionPromptEpochMessageTable.prompt_epoch, epoch.epoch),
            ),
          )
          .orderBy(SessionPromptEpochMessageTable.ordinal)
          .all()).map((row) => row.message_id)
      : []
    return { chronological, epoch, replacementMessageIDs }
  })
}

function readHistorySnapshot(
  db: Database.Interface["db"],
  sessionID: SessionID,
  ignoredCompactionMarkerID?: MessageID,
) {
  return db
    .transaction((tx) =>
      readHistorySnapshotInTransaction(tx as unknown as Database.Interface["db"], sessionID, ignoredCompactionMarkerID),
    )
    .pipe(Effect.orDie)
}

function selectEpochHistory(
  chronological: WithParts[],
  epoch: EpochRow,
  replacementMessageIDs: readonly MessageID[] = [],
): EpochSelection {
  if (epoch.base_message_count !== null && epoch.base_message_count !== replacementMessageIDs.length) {
    return { ok: false, reason: `epoch ${epoch.epoch} replacement membership is incomplete` }
  }
  if (replacementMessageIDs.length > 0) {
    const messages = new Map(chronological.map((message) => [message.info.id, message]))
    const replacement = replacementMessageIDs.flatMap((messageID) => {
      const message = messages.get(messageID)
      return message ? [message] : []
    })
    if (replacement.length !== replacementMessageIDs.length) {
      return { ok: false, reason: `epoch ${epoch.epoch} replacement message is missing` }
    }
    if (epoch.epoch > 0) {
      const user = replacement[0]
      const assistant = replacement[1]
      if (
        !epoch.checkpoint_user_id ||
        !epoch.checkpoint_assistant_id ||
        user?.info.id !== epoch.checkpoint_user_id ||
        user.info.role !== "user" ||
        !user.parts.some((part) => part.type === "compaction") ||
        assistant?.info.id !== epoch.checkpoint_assistant_id ||
        assistant.info.role !== "assistant" ||
        assistant.info.parentID !== user.info.id ||
        !assistant.info.summary ||
        !assistant.info.finish ||
        assistant.info.error
      ) {
        return { ok: false, reason: `epoch ${epoch.epoch} replacement checkpoint binding is invalid` }
      }
    }
    const boundaryID = epoch.source_end_message_id ?? epoch.checkpoint_assistant_id
    const boundaryIndex = boundaryID ? chronological.findIndex((message) => message.info.id === boundaryID) : -1
    if (boundaryID && boundaryIndex < 0) {
      return { ok: false, reason: `epoch ${epoch.epoch} append boundary is missing` }
    }
    const replacementIDs = new Set(replacementMessageIDs)
    return {
      ok: true,
      messages: [
        ...replacement,
        ...(boundaryIndex < 0
          ? []
          : chronological.slice(boundaryIndex + 1).filter((message) => !replacementIDs.has(message.info.id))),
      ],
    }
  }
  if (epoch.epoch === 0) return { ok: true, messages: chronological }
  if (!epoch.checkpoint_user_id || !epoch.checkpoint_assistant_id) {
    return { ok: false, reason: `epoch ${epoch.epoch} is missing checkpoint authority` }
  }

  const userIndex = chronological.findIndex((message) => message.info.id === epoch.checkpoint_user_id)
  const assistantIndex = chronological.findIndex((message) => message.info.id === epoch.checkpoint_assistant_id)
  const user = chronological[userIndex]
  const assistant = chronological[assistantIndex]
  if (
    userIndex < 0 ||
    assistantIndex <= userIndex ||
    user?.info.role !== "user" ||
    !user.parts.some((part) => part.type === "compaction") ||
    assistant?.info.role !== "assistant" ||
    assistant.info.parentID !== user.info.id ||
    !assistant.info.summary ||
    !assistant.info.finish ||
    assistant.info.error
  ) {
    return { ok: false, reason: `epoch ${epoch.epoch} checkpoint binding is invalid` }
  }

  const tailIndex = epoch.retained_tail_start_id
    ? chronological.findIndex((message) => message.info.id === epoch.retained_tail_start_id)
    : -1
  if (epoch.retained_tail_start_id && (tailIndex < 0 || tailIndex >= userIndex)) {
    return { ok: false, reason: `epoch ${epoch.epoch} retained tail is invalid` }
  }
  return {
    ok: true,
    messages: [
      user,
      assistant,
      ...(tailIndex >= 0 ? chronological.slice(tailIndex, userIndex) : []),
      ...chronological.slice(assistantIndex + 1),
    ],
  }
}

// Read-only production projection for callers that already hold the SQLite write transaction used
// for their CAS commit. It deliberately does not run legacy migration or quarantine mutations: a
// missing/incomplete authority simply fails the caller's CAS so no replacement window is committed
// against a different physical history.
export function promptHistoryProjectionInTransaction(
  tx: Database.Interface["db"],
  sessionID: SessionID,
  ignoredCompactionMarkerID?: MessageID,
) {
  return Effect.gen(function* () {
    const snapshotExit = yield* Effect.exit(readHistorySnapshotInTransaction(tx, sessionID, ignoredCompactionMarkerID))
    if (Exit.isFailure(snapshotExit)) return
    const snapshot = snapshotExit.value
    const epoch = snapshot.epoch
    if (
      !epoch ||
      epoch.authority_state !== "ready" ||
      epoch.projection_version !== HistoryAuthority.PROJECTION_VERSION ||
      epoch.canonicalization_version !== HistoryAuthority.CANONICALIZATION_VERSION ||
      epoch.base_message_count === null ||
      !epoch.effective_history_hash ||
      !epoch.first_window_id ||
      !epoch.window_id
    )
      return
    const selected = selectEpochHistory(snapshot.chronological, epoch, snapshot.replacementMessageIDs)
    if (!selected.ok || epoch.base_message_count < 0 || epoch.base_message_count > selected.messages.length) return
    if (HistoryAuthority.hash(selected.messages.slice(0, epoch.base_message_count)) !== epoch.effective_history_hash)
      return
    return {
      sessionID,
      epoch: epoch.epoch,
      messages: selected.messages,
      orderedMessageIDs: selected.messages.map((message) => message.info.id),
      effectiveHistoryHash: HistoryAuthority.hash(selected.messages),
      projectionVersion: epoch.projection_version,
      canonicalizationVersion: epoch.canonicalization_version,
      baseMessageCount: epoch.base_message_count,
      window: {
        firstWindowID: epoch.first_window_id,
        ...(epoch.previous_window_id ? { previousWindowID: epoch.previous_window_id } : {}),
        windowID: epoch.window_id,
      },
      ...(epoch.world_state_baseline_hash ? { worldStateBaselineHash: epoch.world_state_baseline_hash } : {}),
    } satisfies PromptHistoryProjection
  })
}

const migrateHistoryAuthority = Effect.fn("MessageV2.migrateHistoryAuthority")(function* (input: {
  sessionID: SessionID
  chronological: WithParts[]
  existing?: EpochRow
  ignoredCompactionMarkerID?: MessageID
}) {
  const { db } = yield* Database.Service
  const session = yield* db
    .select({ metadata: SessionTable.metadata, directory: SessionTable.directory })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!session) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })

  const currentState = yield* db
    .select()
    .from(SessionHistoryStateTable)
    .where(eq(SessionHistoryStateTable.session_id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (currentState?.state === "recovery_required") {
    return yield* new HistoryAuthorityError({
      sessionID: input.sessionID,
      reason: currentState.reason ?? "legacy history migration requires recovery",
    })
  }

  const deepagent = session.metadata?.deepagent
  const taskManifest =
    deepagent && typeof deepagent === "object"
      ? (deepagent as { task_fork_manifest?: unknown }).task_fork_manifest
      : session.metadata?.task_fork_manifest
  const foregroundManifest = session.metadata?.forkedFrom
  const foregroundMigration =
    foregroundManifest && typeof foregroundManifest === "object"
      ? (foregroundManifest as Record<string, unknown>)
      : undefined
  const migrationAdmission =
    foregroundMigration?.legacyMigrationVersion === 1 &&
    (foregroundMigration.manifestState === "prepared" || foregroundMigration.manifestState === "complete") &&
    typeof foregroundMigration.forkIntentID === "string" &&
    typeof foregroundMigration.parentSessionID === "string"
      ? yield* db
          .select({
            intent_id: SessionForkAdmissionTable.intent_id,
            fork_mode: SessionForkAdmissionTable.fork_mode,
            source_session_id: SessionForkAdmissionTable.source_session_id,
            target_session_id: SessionForkAdmissionTable.target_session_id,
            state: SessionForkAdmissionTable.state,
          })
          .from(SessionForkAdmissionTable)
          .where(eq(SessionForkAdmissionTable.intent_id, foregroundMigration.forkIntentID))
          .get()
          .pipe(Effect.orDie)
      : undefined
  const migrationIntent =
    foregroundMigration?.legacyMigrationVersion === 1 &&
    foregroundMigration.manifestState === "complete" &&
    typeof foregroundMigration.forkIntentID === "string"
      ? yield* db
          .select({
            state: SessionForkIntentTable.state,
            side_effects_completed_at: SessionForkIntentTable.side_effects_completed_at,
          })
          .from(SessionForkIntentTable)
          .where(eq(SessionForkIntentTable.intent_id, foregroundMigration.forkIntentID))
          .get()
          .pipe(Effect.orDie)
      : undefined
  const verifiedForegroundMigration =
    migrationAdmission?.fork_mode === "foreground" &&
    migrationAdmission.source_session_id === foregroundMigration?.parentSessionID &&
    migrationAdmission.target_session_id === input.sessionID &&
    ((foregroundMigration?.manifestState === "prepared" && migrationAdmission.state === "ready") ||
      (foregroundMigration?.manifestState === "complete" &&
        migrationAdmission.state === "manifest_committed" &&
        migrationIntent?.state === "complete" &&
        migrationIntent.side_effects_completed_at !== null))
  if (taskManifest || (foregroundManifest && !verifiedForegroundMigration)) {
    const reason = taskManifest
      ? "legacy task fork has no verifiable sanitation manifest"
      : "legacy foreground fork has no verifiable source projection manifest"
    yield* setHistoryRecoveryRequired(input.sessionID, reason)
    return yield* new HistoryAuthorityError({
      sessionID: input.sessionID,
      reason,
    })
  }

  const needsWorldStateBaseline =
    verifiedForegroundMigration ||
    (input.existing?.epoch ?? 0) > 0 ||
    input.chronological.some(
      (message) => message.info.role === "user" && message.parts.some((part) => part.type === "compaction"),
    )
  const baselineExit = needsWorldStateBaseline
    ? yield* Effect.exit(collectSessionWorldStateBaseline({ workspacePath: session.directory }))
    : undefined
  if (baselineExit && Exit.isFailure(baselineExit)) {
    const reason = "legacy World State baseline collection failed"
    yield* setHistoryRecoveryRequired(input.sessionID, reason)
    return yield* new HistoryAuthorityError({ sessionID: input.sessionID, reason })
  }
  const baseline = baselineExit && Exit.isSuccess(baselineExit) ? baselineExit.value : undefined

  const result = yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const active = yield* tx
            .select()
            .from(SessionPromptEpochTable)
            .where(
              and(eq(SessionPromptEpochTable.session_id, input.sessionID), eq(SessionPromptEpochTable.state, "active")),
            )
            .get()
          if (active?.authority_state === "ready") return { row: active } as const
          if (active && input.existing && active.epoch !== input.existing.epoch) {
            return { error: "active epoch changed during migration" } as const
          }

          const artifacts = yield* tx
            .select({ message_id: CompactionArtifactTable.message_id, state: CompactionArtifactTable.state })
            .from(CompactionArtifactTable)
            .where(eq(CompactionArtifactTable.session_id, input.sessionID))
            .all()
          const hidden = new Set(
            artifacts.filter((artifact) => artifact.state !== "committed").map((artifact) => artifact.message_id),
          )
          const physical = (yield* stream(input.sessionID).pipe(
            Effect.provideService(Database.Service, {
              db: tx as unknown as Database.Interface["db"],
            }),
          )).reverse()
          const visible = physical.filter(
            (message) => message.info.id === input.ignoredCompactionMarkerID || !hidden.has(message.info.id),
          )
          const live = stripIgnoredCompactionMarker(visible, input.ignoredCompactionMarkerID)
          if (input.existing && !active) return { error: "active epoch disappeared during migration" } as const
          const candidate = active ? { ok: true as const, row: active } : legacyEpochCandidate(input.sessionID, live)
          if (!candidate.ok) return { error: candidate.reason } as const
          const selected =
            candidate.row.epoch === 0
              ? selectEpochHistory(live, candidate.row)
              : { ok: true as const, messages: filterCompacted([...live].reverse()) }
          if (!selected.ok) return { error: selected.reason } as const
          if (
            candidate.row.epoch > 0 &&
            (selected.messages[0]?.info.id !== candidate.row.checkpoint_user_id ||
              selected.messages[1]?.info.id !== candidate.row.checkpoint_assistant_id)
          ) {
            return { error: "legacy compaction projection does not match its checkpoint binding" } as const
          }
          if (candidate.row.epoch > 0 && !baseline) {
            return { error: "legacy compacted window has no World State baseline" } as const
          }
          const baseMessageCount = candidate.row.epoch === 0 ? 0 : selected.messages.length
          const windowID = HistoryAuthority.legacyWindowID(input.sessionID, candidate.row.epoch)
          const now = Date.now()
          const replacementHistoryHash = HistoryAuthority.hash(selected.messages.slice(0, baseMessageCount))

          const row = {
            ...candidate.row,
            checkpoint_hash: candidate.row.epoch > 0 ? replacementHistoryHash : null,
            projection_version: HistoryAuthority.PROJECTION_VERSION,
            canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
            base_message_count: baseMessageCount,
            effective_history_hash: replacementHistoryHash,
            source_end_message_id: candidate.row.epoch > 0 ? (live.at(-1)?.info.id ?? null) : null,
            first_window_id: windowID,
            previous_window_id: null,
            window_id: windowID,
            world_state_baseline_hash: candidate.row.epoch > 0 || verifiedForegroundMigration ? baseline!.hash : null,
            authority_state: "ready" as const,
            recovery_reason: null,
          }
          if (active) {
            yield* tx
              .update(SessionPromptEpochTable)
              .set(row)
              .where(
                and(
                  eq(SessionPromptEpochTable.session_id, input.sessionID),
                  eq(SessionPromptEpochTable.epoch, active.epoch),
                  eq(SessionPromptEpochTable.state, "active"),
                ),
              )
              .run()
          } else {
            yield* tx.insert(SessionPromptEpochTable).values(row).run()
          }
          yield* tx
            .delete(SessionPromptEpochMessageTable)
            .where(
              and(
                eq(SessionPromptEpochMessageTable.session_id, input.sessionID),
                eq(SessionPromptEpochMessageTable.prompt_epoch, candidate.row.epoch),
              ),
            )
            .run()
          if (baseMessageCount > 0) {
            yield* tx
              .insert(SessionPromptEpochMessageTable)
              .values(
                selected.messages.slice(0, baseMessageCount).map((message, ordinal) => ({
                  session_id: input.sessionID,
                  prompt_epoch: candidate.row.epoch,
                  ordinal,
                  message_id: message.info.id,
                })),
              )
              .run()
          }
          if (candidate.row.epoch > 0 || verifiedForegroundMigration) {
            yield* tx
              .delete(SessionWorldStateBaselineTable)
              .where(
                and(
                  eq(SessionWorldStateBaselineTable.session_id, input.sessionID),
                  eq(SessionWorldStateBaselineTable.prompt_epoch, candidate.row.epoch),
                ),
              )
              .run()
            yield* tx
              .insert(SessionWorldStateBaselineTable)
              .values(
                baseline!.sections.map((section) => ({
                  session_id: input.sessionID,
                  prompt_epoch: candidate.row.epoch,
                  section_id: section.sectionID,
                  snapshot: section.snapshot,
                  fragment: section.fragment,
                  fragment_hash: section.fragmentHash,
                  provenance: "legacy_migration" as const,
                  created_at: now,
                })),
              )
              .run()
          }
          yield* tx
            .insert(SessionHistoryStateTable)
            .values({
              session_id: input.sessionID,
              state: "ready",
              reason: null,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoUpdate({
              target: SessionHistoryStateTable.session_id,
              set: { state: "ready", reason: null, time_updated: now },
            })
            .run()
          const migrated = yield* tx
            .select()
            .from(SessionPromptEpochTable)
            .where(
              and(eq(SessionPromptEpochTable.session_id, input.sessionID), eq(SessionPromptEpochTable.state, "active")),
            )
            .get()
          if (!migrated) return yield* Effect.die(new Error(`history migration failed for ${input.sessionID}`))
          return { row: migrated } as const
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
  if ("error" in result) {
    const reason = result.error ?? "legacy history migration could not reconstruct the active projection"
    const quarantined = yield* setHistoryRecoveryRequired(input.sessionID, reason)
    if (!quarantined) {
      const ready = yield* db
        .select()
        .from(SessionPromptEpochTable)
        .where(
          and(eq(SessionPromptEpochTable.session_id, input.sessionID), eq(SessionPromptEpochTable.state, "active")),
        )
        .get()
        .pipe(Effect.orDie)
      if (ready?.authority_state === "ready") return ready
    }
    return yield* new HistoryAuthorityError({ sessionID: input.sessionID, reason })
  }
  return result.row
})

function stripIgnoredCompactionMarker(messages: WithParts[], markerMessageID?: MessageID) {
  if (!markerMessageID) return messages
  const marker = messages.at(-1)
  if (
    marker?.info.id !== markerMessageID ||
    marker.info.role !== "user" ||
    !marker.parts.some((part) => part.type === "compaction")
  ) {
    throw new Error(`ignored compaction marker must be the latest visible user message: ${markerMessageID}`)
  }
  const parts = marker.parts.filter((part) => part.type !== "compaction")
  if (parts.length === 0) return messages.slice(0, -1)
  return [...messages.slice(0, -1), { info: marker.info, parts }]
}

function legacyEpochCandidate(
  sessionID: SessionID,
  chronological: WithParts[],
): { readonly ok: true; readonly row: EpochRow } | { readonly ok: false; readonly reason: string } {
  const markerIndexes = chronological.flatMap((message, index) =>
    message.info.role === "user" && message.parts.some((part) => part.type === "compaction") ? [index] : [],
  )
  if (markerIndexes.length === 0) {
    const windowID = HistoryAuthority.legacyWindowID(sessionID, 0)
    return {
      ok: true,
      row: {
        session_id: sessionID,
        epoch: 0,
        state: "active",
        checkpoint_user_id: null,
        checkpoint_assistant_id: null,
        retained_tail_start_id: null,
        source_end_message_id: null,
        checkpoint_hash: null,
        projection_version: null,
        canonicalization_version: null,
        base_message_count: null,
        effective_history_hash: null,
        first_window_id: windowID,
        previous_window_id: null,
        window_id: windowID,
        world_state_baseline_hash: null,
        authority_state: "legacy_pending",
        recovery_reason: null,
        reason: "bootstrap",
        created_at: Date.now(),
        retired_at: null,
      },
    }
  }

  const markerIndex = markerIndexes.at(-1)!
  const marker = chronological[markerIndex]
  const summary = marker
    ? chronological.find(
        (message, index) =>
          index > markerIndex &&
          message.info.role === "assistant" &&
          message.info.parentID === marker.info.id &&
          message.info.summary &&
          message.info.finish &&
          !message.info.error,
      )
    : undefined
  const part = marker?.parts.find((item): item is CompactionPart => item.type === "compaction")
  if (!marker || marker.info.role !== "user" || !summary || summary.info.role !== "assistant" || !part) {
    return { ok: false, reason: "legacy compaction checkpoint cannot be reconstructed uniquely" }
  }
  const windowID = HistoryAuthority.legacyWindowID(sessionID, markerIndexes.length)
  return {
    ok: true,
    row: {
      session_id: sessionID,
      epoch: markerIndexes.length,
      state: "active",
      checkpoint_user_id: marker.info.id,
      checkpoint_assistant_id: summary.info.id,
      retained_tail_start_id: part.tail_start_id ?? null,
      source_end_message_id: null,
      checkpoint_hash: null,
      projection_version: null,
      canonicalization_version: null,
      base_message_count: null,
      effective_history_hash: null,
      first_window_id: windowID,
      previous_window_id: null,
      window_id: windowID,
      world_state_baseline_hash: null,
      authority_state: "legacy_pending",
      recovery_reason: null,
      reason: "compaction",
      created_at: Date.now(),
      retired_at: null,
    },
  }
}

const setHistoryRecoveryRequired = Effect.fn("MessageV2.setHistoryRecoveryRequired")(function* (
  sessionID: SessionID,
  reason: string,
) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const active = yield* tx
            .select({ authority_state: SessionPromptEpochTable.authority_state })
            .from(SessionPromptEpochTable)
            .where(and(eq(SessionPromptEpochTable.session_id, sessionID), eq(SessionPromptEpochTable.state, "active")))
            .get()
          if (active?.authority_state === "ready") return false

          const now = Date.now()
          yield* tx
            .update(SessionPromptEpochTable)
            .set({ authority_state: "recovery_required", recovery_reason: reason })
            .where(
              and(
                eq(SessionPromptEpochTable.session_id, sessionID),
                eq(SessionPromptEpochTable.state, "active"),
                sql`${SessionPromptEpochTable.authority_state} IS NOT 'ready'`,
              ),
            )
            .run()
          yield* tx
            .insert(SessionHistoryStateTable)
            .values({ session_id: sessionID, state: "recovery_required", reason, time_created: now, time_updated: now })
            .onConflictDoUpdate({
              target: SessionHistoryStateTable.session_id,
              set: { state: "recovery_required", reason, time_updated: now },
            })
            .run()
          return true
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

function failHistoryAuthority(input: { sessionID: SessionID; epoch?: number; reason: string }) {
  return Effect.gen(function* () {
    yield* quarantineHistoryAuthority(input)
    return yield* new HistoryAuthorityError({ sessionID: input.sessionID, reason: input.reason })
  })
}

const quarantineHistoryAuthority = Effect.fn("MessageV2.quarantineHistoryAuthority")(function* (input: {
  sessionID: SessionID
  epoch?: number
  reason: string
}) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const active = yield* tx
            .select({
              epoch: SessionPromptEpochTable.epoch,
              authority_state: SessionPromptEpochTable.authority_state,
              recovery_reason: SessionPromptEpochTable.recovery_reason,
            })
            .from(SessionPromptEpochTable)
            .where(
              and(eq(SessionPromptEpochTable.session_id, input.sessionID), eq(SessionPromptEpochTable.state, "active")),
            )
            .get()
          if (input.epoch !== undefined && active?.epoch !== input.epoch) return false

          const reason =
            active?.authority_state === "recovery_required" ? (active.recovery_reason ?? input.reason) : input.reason
          if (active?.authority_state === "ready") {
            const quarantined = yield* tx
              .update(SessionPromptEpochTable)
              .set({ authority_state: "recovery_required", recovery_reason: reason })
              .where(
                and(
                  eq(SessionPromptEpochTable.session_id, input.sessionID),
                  eq(SessionPromptEpochTable.epoch, active.epoch),
                  eq(SessionPromptEpochTable.state, "active"),
                  eq(SessionPromptEpochTable.authority_state, "ready"),
                ),
              )
              .returning({ epoch: SessionPromptEpochTable.epoch })
              .get()
            if (!quarantined) return false
          } else if (active && active.authority_state !== "recovery_required") {
            return false
          }

          const now = Date.now()
          yield* tx
            .insert(SessionHistoryStateTable)
            .values({
              session_id: input.sessionID,
              state: "recovery_required",
              reason,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoUpdate({
              target: SessionHistoryStateTable.session_id,
              set: { state: "recovery_required", reason, time_updated: now },
            })
            .run()
          return true
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

// filterCompacted reorders messages for model consumption
// ([compaction-user, summary, ...retained tail..., continue-user]), so array
// position is not chronological. Derive each binding by max id (MessageID
// is monotonic via MessageID.ascending) so a pre-compaction overflowing tail
// assistant doesn't get mistaken for the most recent turn. tasks are
// compaction/subtask parts attached to user messages newer than the latest
// finished assistant — i.e. unprocessed work.
export function latest(msgs: WithParts[]) {
  let user: User | undefined
  let assistant: Assistant | undefined
  let finished: Assistant | undefined
  for (const msg of msgs) {
    const info = msg.info
    if (info.role === "user" && (!user || info.id > user.id)) user = info
    if (info.role === "assistant" && (!assistant || info.id > assistant.id)) assistant = info
    if (info.role === "assistant" && info.finish && (!finished || info.id > finished.id)) finished = info
  }
  const tasks = msgs.flatMap((m) =>
    finished && m.info.id <= finished.id
      ? []
      : m.parts.filter((p): p is CompactionPart | SubtaskPart => p.type === "compaction" || p.type === "subtask"),
  )
  return { user, assistant, finished, tasks }
}

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderV2.ID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  const transport = transientTransportError(e)
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    case ContextOverflowError.isInstance(e):
      return e
    case OutputLengthError.isInstance(e):
      return e
    case OutputDegenerationError.isInstance(e):
      return e
    case DoomLoopError.isInstance(e):
      return e
    case TaskBudgetExceededError.isInstance(e):
      return e
    case PlanProtocolViolationError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case transport !== undefined:
      if (ctx.aborted) {
        return new AbortedError({ message: transport.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message:
            transport.code === "ECONNRESET" ? "Connection reset by server" : "Provider connection was interrupted",
          isRetryable: true,
          metadata: transport,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.HeaderTimeoutError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
            timeoutMs: String(e.ms),
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.ResponseStreamError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

function transientTransportError(
  error: unknown,
  message?: string,
  seen = new Set<Error>(),
): { code: string; message: string } | undefined {
  if (!(error instanceof Error) || seen.has(error)) return
  seen.add(error)
  const rootMessage = message ?? error.message
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined
  if (code && transientTransportCodes.has(code)) return { code, message: rootMessage }
  const cause = transientTransportError(error.cause, rootMessage, seen)
  if (cause) return cause
  if (error instanceof TypeError && error.message.trim().toLowerCase() === "terminated") {
    return { code: "UND_ERR_SOCKET", message: rootMessage }
  }
}

export * as MessageV2 from "./message-v2"
