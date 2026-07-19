import { EOL } from "os"
import { Effect, Option } from "effect"
import type { Session, Message, Part, FilePart } from "@deepagent-code/sdk/v2"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { SessionClient } from "../../services/session-client"

type ExportData = { info: Session; messages: Array<{ info: Message; parts: Part[] }> }

export default Runtime.handler(Commands.commands.export, (input) =>
  Effect.gen(function* () {
    const sessionID = Option.getOrElse(input.sessionID, () => undefined)
    if (!sessionID) {
      return yield* Effect.fail(new Error("sessionID is required (usage: dacode export <sessionID>)"))
    }

    process.stderr.write(`Exporting session: ${sessionID}\n`)

    const sessionResult = yield* SessionClient.get({ sessionID })
    if (!sessionResult.data) {
      return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
    }

    const messagesResult = yield* SessionClient.messages({ sessionID })
    const messages = messagesResult.data ?? []

    const exportData: ExportData = { info: sessionResult.data, messages }
    const output = input.sanitize ? sanitize(exportData) : exportData
    process.stdout.write(JSON.stringify(output, null, 2) + EOL)
  }),
)

function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

function redactObj(kind: string, id: string, value: Record<string, unknown> | undefined) {
  if (!value) return value
  return Object.keys(value).length ? { redacted: `${kind}:${id}` } : value
}

function sanitizeFilePart(part: FilePart): FilePart {
  return {
    ...part,
    url: redact("file-url", part.id, part.url),
    filename: part.filename === undefined ? undefined : redact("file-name", part.id, part.filename),
    source: !part.source
      ? part.source
      : part.source.type === "symbol"
        ? { ...part.source, path: redact("file-path", part.id, part.source.path), name: redact("file-symbol", part.id, part.source.name), text: { ...part.source.text, value: redact("file-text", part.id, part.source.text.value) } }
        : part.source.type === "resource"
          ? { ...part.source, clientName: redact("file-client", part.id, part.source.clientName), uri: redact("file-uri", part.id, part.source.uri), text: { ...part.source.text, value: redact("file-text", part.id, part.source.text.value) } }
          : { ...part.source, path: redact("file-path", part.id, part.source.path), text: { ...part.source.text, value: redact("file-text", part.id, part.source.text.value) } },
  }
}

function sanitizePart(part: Part): Part {
  switch (part.type) {
    case "text":
      return { ...part, text: redact("text", part.id, part.text), metadata: redactObj("text-metadata", part.id, part.metadata) }
    case "reasoning":
      return { ...part, text: redact("reasoning", part.id, part.text), metadata: redactObj("reasoning-metadata", part.id, part.metadata) }
    case "file":
      return sanitizeFilePart(part)
    case "subtask":
      return {
        ...part,
        prompt: redact("subtask-prompt", part.id, part.prompt),
        description: redact("subtask-description", part.id, part.description),
        command: part.command === undefined ? undefined : redact("subtask-command", part.id, part.command),
      }
    case "tool":
      return { ...part, metadata: redactObj("tool-metadata", part.id, part.metadata) }
    case "patch":
      return { ...part, hash: redact("patch", part.id, part.hash), files: part.files.map((item, i) => redact("patch-file", `${part.id}-${i}`, item)) }
    case "snapshot":
      return { ...part, snapshot: redact("snapshot", part.id, part.snapshot) }
    case "step-start":
    case "step-finish":
      return part.snapshot === undefined ? part : { ...part, snapshot: redact("snapshot", part.id, part.snapshot) }
    case "agent":
      return !part.source ? part : { ...part, source: { ...part.source, value: redact("agent-source", part.id, part.source.value) } }
    default:
      return part
  }
}

function sanitize(data: ExportData): ExportData {
  return {
    info: {
      ...data.info,
      title: redact("session-title", data.info.id, data.info.title),
      directory: redact("session-directory", data.info.id, data.info.directory),
    },
    messages: data.messages.map((msg) => ({
      info:
        msg.info.role === "user"
          ? { ...msg.info, system: msg.info.system === undefined ? undefined : redact("system", msg.info.id, msg.info.system) }
          : { ...msg.info, path: { cwd: redact("cwd", msg.info.id, msg.info.path.cwd), root: redact("root", msg.info.id, msg.info.path.root) } },
      parts: msg.parts.map(sanitizePart),
    })),
  }
}
