export * as LegacyWire from "./legacy-wire"

import { DateTime } from "effect"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionV1 } from "../v1/session"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"

// W4-6 — the canonical SessionMessage → SessionV1.WithParts converter, shared by the journal→
// wire projection egress (core projector) and re-exported from SessionV2 for the host callers.
// Extracted from session.ts so the projector can import it without a module cycle
// (session.ts imports the projector).

export function legacyAssistant(input: {
  readonly sessionID: SessionSchema.ID
  readonly parentMessageID: SessionV1.MessageID
  readonly directory: string
  readonly root: string
  readonly message: SessionMessage.Assistant
}): SessionV1.WithParts {
  const created = DateTime.toEpochMillis(input.message.time.created)
  const completed = input.message.time.completed ? DateTime.toEpochMillis(input.message.time.completed) : undefined
  const messageID = SessionV1.MessageID.ascending(input.message.id)
  const parts = input.message.content.map((part, index): SessionV1.Part => {
    const id = SessionV1.PartID.ascending(`prt_${input.message.id.slice("msg_".length)}_${index}`)
    if (part.type === "text") {
      return {
        id,
        sessionID: input.sessionID,
        messageID,
        type: "text",
        text: part.text,
        time: { start: created, ...(completed === undefined ? {} : { end: completed }) },
      }
    }
    if (part.type === "reasoning") {
      return {
        id,
        sessionID: input.sessionID,
        messageID,
        type: "reasoning",
        text: part.text,
        metadata: part.providerMetadata,
        time: { start: created, ...(completed === undefined ? {} : { end: completed }) },
      }
    }
    return {
      id,
      sessionID: input.sessionID,
      messageID,
      type: "tool",
      callID: part.id,
      tool: part.name,
      metadata: part.provider?.metadata,
      state: legacyAssistantToolState(part, { sessionID: input.sessionID, messageID }),
    }
  })
  const tokens = input.message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  // F-17: a completed assistant message carries a synthesized step-finish part — the V1 SSE
  // surface (run CLI, app) keys turn accounting and per-turn token/cost capture on it; without it
  // a projected V2 turn is invisible to step counters.
  if (completed !== undefined) {
    parts.push({
      id: SessionV1.PartID.ascending(`prt_${input.message.id.slice("msg_".length)}_finish`),
      sessionID: input.sessionID,
      messageID,
      type: "step-finish",
      reason: input.message.finish ?? "stop",
      cost: input.message.cost ?? 0,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: tokens.cache,
      },
    })
  }
  return {
    info: {
      id: messageID,
      sessionID: input.sessionID,
      role: "assistant",
      time: { created, ...(completed === undefined ? {} : { completed }) },
      ...(input.message.error
        ? { error: { name: "UnknownError", data: { message: input.message.error.message } } }
        : {}),
      ...(input.message.structured === undefined ? {} : { structured: input.message.structured }),
      parentID: input.parentMessageID,
      modelID: input.message.model.id,
      providerID: input.message.model.providerID,
      mode: input.message.agent,
      agent: input.message.agent,
      path: { cwd: input.directory, root: input.root },
      cost: input.message.cost ?? 0,
      tokens,
      ...(input.message.model.variant === undefined ? {} : { variant: input.message.model.variant }),
      ...(input.message.finish === undefined ? {} : { finish: input.message.finish }),
    },
    parts,
  }
}

function toolDisplayOutput(state: SessionMessage.ToolStateCompleted): string {
  if (state.content.length === 1 && state.content[0]?.type === "text") return state.content[0].text
  if (state.content.length > 0)
    return state.content
      .map((item) => (item.type === "text" ? item.text : `[${item.type}: ${item.name}]`))
      .join("\n")
  const json = JSON.stringify(state.structured)
  return json === "{}" || json === undefined ? "" : json
}

/**
 * The V1 wire part metadata. Before the V2 projection this field carried the tool's own result
 * metadata (bash exit/truncated/outputPath, plugin metadata, ...); the provider channel carried
 * only protocol riders like plan outcomes. Projecting ONLY provider.resultMetadata therefore
 * emptied the field for every locally-executed tool — the CLI lost bash exit codes and the live
 * battery lost every truncation/exit assertion. The durable structured output is the metadata
 * authority now: spread it, alias the bash exit vocabulary (`exitCode` → the legacy `exit` every
 * V1 consumer reads), surface ToolOutputStore truncation through the legacy truncated/outputPath
 * keys, and let the provider channel override on explicit key collisions (plan protocol riders).
 */
function legacyCompletedMetadata(
  state: SessionMessage.ToolStateCompleted,
  resultMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const structured =
    typeof state.structured === "object" && state.structured !== null && !Array.isArray(state.structured)
      ? state.structured
      : {}
  const outputPaths = state.outputPaths ?? []
  return {
    ...structured,
    ...(typeof structured.exitCode === "number" && structured.exit === undefined
      ? { exit: structured.exitCode }
      : {}),
    ...(outputPaths.length > 0 ? { truncated: true, outputPath: outputPaths[0] } : {}),
    ...(resultMetadata ?? {}),
  }
}

function legacyAssistantToolState(
  part: SessionMessage.AssistantTool,
  identity: { readonly sessionID: SessionSchema.ID; readonly messageID: SessionV1.MessageID },
): SessionV1.ToolState {
  const start = DateTime.toEpochMillis(part.time.ran ?? part.time.created)
  if (part.state.status === "pending") {
    return { status: "pending", input: {}, raw: part.state.input }
  }
  if (part.state.status === "running") {
    return { status: "running", input: part.state.input, title: part.name, time: { start } }
  }
  if (part.state.status === "completed") {
    // JSON.stringify(undefined) is undefined (not a string) — the V1 schema requires a string
    // output, so an absent result must land as "" rather than dying the whole projection.
    // Locally-executed tools never persist `state.result` (the event only carries it for
    // provider-executed calls); derive the display output from the persisted content/structured
    // the model itself consumed, so the V1 wire shows what the tool actually returned instead
    // of an empty string.
    const result =
      typeof part.state.result === "string"
        ? part.state.result
        : part.state.result === undefined
          ? toolDisplayOutput(part.state)
          : JSON.stringify(part.state.result)
    return {
      status: "completed",
      input: part.state.input,
      output: result,
      title: part.name,
      metadata: legacyCompletedMetadata(part.state, part.provider?.resultMetadata),
      time: { start, end: DateTime.toEpochMillis(part.time.completed ?? part.time.created) },
      attachments: part.state.attachments?.map((file, index) => ({
        id: SessionV1.PartID.ascending(`prt_${part.id}_${index}`),
        sessionID: identity.sessionID,
        messageID: identity.messageID,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: file.uri,
        source: file.source
          ? {
              type: "file",
              path: file.uri,
              text: { value: file.source.text, start: file.source.start, end: file.source.end },
            }
          : undefined,
      })),
    }
  }
  return {
    status: "error",
    input: part.state.input,
    error: part.state.error.message,
    metadata: part.provider?.resultMetadata,
    time: { start, end: DateTime.toEpochMillis(part.time.completed ?? part.time.created) },
  }
}

/**
 * The canonical user/synthetic converter (W4-6; moved from the projector beside
 * {@link legacyAssistant} so the W-02 M-1 batch MD exporter shares the exact wire shape).
 * The wire user row feeds next-turn model resolution (currentModel falls back to the last user
 * message's model); it carries the session's model so the fallback never resolves empty.
 */
export function legacyUser(input: {
  readonly sessionID: SessionSchema.ID
  readonly message: SessionMessage.User | SessionMessage.Synthetic
  readonly agent: string | null
  readonly model: { id: string; providerID: string; variant?: string } | null
  readonly synthetic?: boolean
}): SessionV1.WithParts {
  const created = DateTime.toEpochMillis(input.message.time.created)
  const messageID = SessionV1.MessageID.ascending(input.message.id)
  const agent = input.message.type === "user" ? (input.message.agent ?? input.agent) : input.agent
  const model = input.message.type === "user" ? (input.message.model ?? input.model) : input.model
  const parts: SessionV1.Part[] = []
  if (input.message.text) {
    parts.push({
      id: SessionV1.PartID.ascending(`prt_${input.message.id.slice("msg_".length)}_0`),
      sessionID: input.sessionID,
      messageID,
      type: "text",
      text: input.message.text,
      ...(input.synthetic === true ? { synthetic: true } : {}),
      time: { start: created, end: created },
    })
  }
  const files = input.message.type === "user" ? (input.message.files ?? []) : []
  for (const [index, file] of files.entries()) {
    parts.push({
      id: SessionV1.PartID.ascending(`prt_${input.message.id.slice("msg_".length)}_f${index}`),
      sessionID: input.sessionID,
      messageID,
      type: "file",
      url: file.uri,
      mime: file.mime,
      ...(file.name === undefined ? {} : { filename: file.name }),
      time: { start: created, end: created },
    } as SessionV1.Part)
  }
  return {
    info: {
      id: messageID,
      sessionID: input.sessionID,
      role: "user",
      time: { created },
      agent: agent ?? "",
      model: {
        providerID: (model?.providerID ?? "") as ProviderV2.ID,
        modelID: (model?.id ?? "") as ModelV2.ID,
        ...(model?.variant === undefined ? {} : { variant: model.variant }),
      },
      ...(input.message.metadata === undefined ? {} : { metadata: input.message.metadata }),
      // V1-wire parity: the durable user row carries the structured-output request (Prompt.format
      // survives promotion); the legacy owner persisted it on the user message and the read model
      // (API/messages surface) still expects it, so the egress must not drop it. The V1 Info codec
      // only accepts Format CLASS instances (a plain object fails encode — see the app's
      // structured-output tests), so re-instantiate rather than copy.
      ...(input.message.type === "user" && input.message.format !== undefined
        ? {
            format:
              input.message.format.type === "json_schema"
                ? new SessionV1.OutputFormatJsonSchema({
                    type: "json_schema",
                    schema: input.message.format.schema ?? {},
                    ...(input.message.format.retryCount === undefined
                      ? {}
                      : { retryCount: input.message.format.retryCount }),
                  })
                : new SessionV1.OutputFormatText({ type: "text" }),
          }
        : {}),
    },
    parts,
  }
}
