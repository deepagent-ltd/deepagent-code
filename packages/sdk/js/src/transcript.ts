import type { AssistantMessage, Part, Provider, UserMessage } from "./gen/types.gen.js"

/**
 * Human-readable session transcript → Markdown. Canonical formatter shared by the
 * TUI (/export), the GUI (session.export), and the CLI (deepagent export --format md)
 * so every surface exports the same shape. Kept free of filesystem/Bun APIs so the
 * web app can import it; callers own file writing and collision handling.
 */

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  /** Prepend each message header with a local ISO timestamp. Defaults to true. */
  timestamps?: boolean
  providers?: Provider[]
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

const titlecase = (value: string) => (value.length === 0 ? value : value[0].toUpperCase() + value.slice(1))

const pad = (value: number) => String(value).padStart(2, "0")

/** Local ISO-style timestamp (YYYY-MM-DD HH:mm:ss) — stable, timezone-local, no deps. */
const timestamp = (ms: number) => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const headerPrefix = (ms: number, options: Pick<TranscriptOptions, "timestamps">) =>
  options.timestamps === false ? "## " : `## ${timestamp(ms)} — `

const providerIndex = (list: Provider[] | undefined) => new Map((list ?? []).map((item) => [item.id, item] as const))

const modelName = (list: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string, modelID: string) => {
  const provider =
    list instanceof Map ? list.get(providerID) : Array.isArray(list) ? list.find((item) => item.id === providerID) : undefined
  return provider?.models[modelID]?.name ?? modelID
}

/**
 * Exported file name: `<slugified-title>-<YYYY-MM-DD>.md`, dated by session creation.
 * Untitled sessions fall back to `session-<id>-<date>.md`; collision suffixing is the
 * caller's job (it owns the filesystem).
 */
export function transcriptFilename(session: { id: string; title?: string | null; time: { created: number } }): string {
  const slug = (session.title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "")
  const date = new Date(session.time.created)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${slug || `session-${session.id}`}-${day}.md`
}

export function formatTranscript(session: SessionInfo, messages: MessageWithParts[], options: TranscriptOptions): string {
  const providers = providerIndex(options.providers)
  let transcript = `# ${session.title}\n\n`
  transcript += `**Session ID:** ${session.id}\n`
  transcript += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  transcript += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  transcript += `---\n\n`

  for (const msg of messages) {
    transcript += formatMessage(msg.info, msg.parts, options, providers)
    transcript += `---\n\n`
  }

  return transcript
}

export function formatMessage(
  msg: UserMessage | AssistantMessage,
  parts: Part[],
  options: TranscriptOptions,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  let result = ""

  if (msg.role === "user") {
    result += `${headerPrefix(msg.time.created, options)}User\n\n`
  } else {
    result += formatAssistantHeader(msg, options, providers ?? options.providers)
  }

  for (const part of parts) {
    result += formatPart(part, options)
  }

  return result
}

export function formatAssistantHeader(
  msg: AssistantMessage,
  options: Pick<TranscriptOptions, "assistantMetadata" | "timestamps">,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  const prefix = headerPrefix(msg.time.created, options)
  if (!options.assistantMetadata) return `${prefix}Assistant\n\n`
  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""
  const model = modelName(providers, msg.providerID, msg.modelID)
  return `${prefix}Assistant (${titlecase(msg.agent)} · ${model}${duration ? ` · ${duration}` : ""})\n\n`
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  if (part.type === "text" && !part.synthetic) {
    return `${part.text}\n\n`
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `_Thinking:_\n\n${part.text}\n\n`
    }
    return ""
  }

  if (part.type === "tool") {
    let result = `**Tool: ${part.tool}**\n`
    if (options.toolDetails && part.state.input) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "completed" && part.state.output) {
      result += `\n**Output:**\n\`\`\`\n${part.state.output}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "error" && part.state.error) {
      result += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\`\n`
    }
    result += `\n`
    return result
  }

  if (part.type === "file") {
    if (part.synthetic) return ""
    const label =
      part.filename ??
      (part.source?.type === "file" || part.source?.type === "symbol" ? part.source.path : undefined) ??
      (part.source?.type === "resource" ? part.source.uri : undefined) ??
      part.url
    return `**File: \`${label}\`** _(${part.mime})_\n\n`
  }

  if (part.type === "patch") {
    const files = part.files.map((file) => `- \`${file}\``).join("\n")
    return `**Patch \`${part.hash.slice(0, 8)}\` — ${part.files.length} file${part.files.length === 1 ? "" : "s"} changed**\n\n${files}\n\n`
  }

  if (part.type === "subtask") {
    let result = `### Subtask: ${part.description}\n\n**Agent:** \`${part.agent}\``
    if (part.command) result += ` · **Command:** \`${part.command}\``
    result += `\n\n${part.prompt}\n\n`
    return result
  }

  if (part.type === "compaction") {
    // The marker carries no summary itself — the summary is committed as the checkpoint
    // assistant message right after it, which the transcript renders as ordinary text.
    const kind = part.auto ? "auto" : "manual"
    const overflow = part.overflow ? " · triggered by context overflow" : ""
    const tokens = part.context_tokens === undefined ? "" : ` · ~${part.context_tokens} context tokens`
    return `> **Context compaction checkpoint** (${kind}${overflow}${tokens}) — earlier messages were summarized; the transcript continues from the summary below.\n\n`
  }

  return ""
}
