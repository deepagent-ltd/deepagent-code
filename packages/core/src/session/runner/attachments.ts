import { InvalidRequestReason, LLMError } from "@deepagent-code/llm"
import { Buffer } from "node:buffer"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { FSUtil } from "../../fs-util"
import { SessionMessage } from "../message"
import { FileAttachment } from "../prompt"

// Attachment wire normalization (V1 parity with the legacy `createUserMessage` Read-tool expansion
// and the `unsupportedParts` provider transform). The durable prompt keeps the file REFERENCE
// (exact-retry identity; display keeps the attachment); only the wire-bound copy is rewritten here,
// and nothing reaches the provider in its internal representation:
//
// - text/* attachments are readable content, not wire media — a model without file-input support
//   must still receive the content, and no protocol route accepts a text/plain media part. Inlined
//   as `<attached-file>` blocks; files that no longer read degrade to a note block (V1 inlined an
//   error text) instead of failing the turn.
// - application/x-directory is a Location listing, not media — V1 ran the Read tool on the
//   directory and dropped the file part from the wire (legacy message-v2.ts). Inlined as an
//   `<attached-directory>` block carrying the same listing page the Read tool produces.
// - Binary media must arrive in a shape the protocol route accepts: file: references are
//   materialized into base64 data URLs (V1 inlined the bytes at message creation), data: URLs pass
//   through, and any other URI scheme typed-rejects instead of leaking the internal reference onto
//   the wire. A model whose catalog capabilities declare no matching input modality gets the V1
//   degrade: a model-facing ERROR text in place of the part. Route-level support (e.g. pdf lowers
//   only on document-capable routes) stays with the protocol layer's own typed validation.

// Paste-style clients deliver text attachments as data: URLs. Decode both base64 and
// percent-encoded bodies (mirrors the legacy util/data-url.ts helper).
const decodeTextDataUrl = (uri: string) => {
  const comma = uri.indexOf(",")
  if (comma === -1) return undefined
  const body = uri.slice(comma + 1)
  if (uri.slice(0, comma).includes(";base64")) return Buffer.from(body, "base64").toString("utf8")
  return decodeURIComponent(body)
}

const textAttachmentBlock = (file: FileAttachment, content: string | undefined) =>
  content === undefined
    ? `[Attached file ${file.name ?? file.uri} could not be read]`
    : `<attached-file name="${file.name ?? file.uri}" mime="${file.mime}">\n${content}\n</attached-file>`

const directoryAttachmentBlock = (file: FileAttachment, listing: string | undefined) =>
  listing === undefined
    ? `[Attached directory ${file.name ?? file.uri} could not be read]`
    : `<attached-directory name="${file.name ?? file.uri}">\n${listing}\n</attached-directory>`

// Legacy provider/transform.ts mimeToModality: catalog capabilities.input lists models.dev
// modality names ("text", "image", "audio", "video", "pdf").
const modalityOf = (mime: string) => {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

// Exact legacy degrade wording (provider/transform.ts unsupportedParts).
const unsupportedModalityText = (file: FileAttachment, modality: string) =>
  `ERROR: Cannot read ${file.name !== undefined ? `"${file.name}"` : modality} (this model does not support ${modality} input). Inform the user.`

const DIRECTORY_PAGE_LIMIT = 2_000

// Same page shape as the Read tool directory listing (legacy tool/read.ts): alphabetized entries,
// directories carry a trailing slash, one bounded page with the same continuation note.
const directoryListing = (directory: string, names: readonly string[]) => {
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const page = sorted.slice(0, DIRECTORY_PAGE_LIMIT)
  return [
    `<path>${directory}</path>`,
    `<type>directory</type>`,
    `<entries>`,
    page.join("\n"),
    page.length < sorted.length
      ? `\n(Showing ${page.length} of ${sorted.length} entries. Use 'offset' parameter to read beyond entry ${page.length + 1})`
      : `\n(${sorted.length} entries)`,
    `</entries>`,
  ].join("\n")
}

const readTextAttachment = Effect.fnUntraced(function* (file: FileAttachment) {
  if (file.uri.startsWith("data:")) return decodeTextDataUrl(file.uri)
  if (!file.uri.startsWith("file:")) return undefined
  const fs = yield* FSUtil.Service
  return yield* fs.readFileStringSafe(fileURLToPath(file.uri)).pipe(Effect.catch(() => Effect.succeed(undefined)))
})

const readDirectoryListing = Effect.fnUntraced(function* (file: FileAttachment) {
  if (!file.uri.startsWith("file:")) return undefined
  const fs = yield* FSUtil.Service
  const directory = fileURLToPath(file.uri)
  const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (entries === undefined) return undefined
  const names = yield* Effect.forEach(entries, (entry) => {
    if (entry.type === "directory") return Effect.succeed(`${entry.name}/`)
    if (entry.type !== "symlink") return Effect.succeed(entry.name)
    return Effect.map(
      fs.stat(join(directory, entry.name)).pipe(Effect.catch(() => Effect.succeed(undefined))),
      (target) => (target?.type === "Directory" ? `${entry.name}/` : entry.name),
    )
  })
  return directoryListing(directory, names)
})

// V1 read the bytes at message creation and stored a data: URL part; V2 keeps the durable file:
// reference and materializes the same wire shape here, per request construction.
const readBinaryDataUrl = Effect.fnUntraced(function* (file: FileAttachment) {
  const fs = yield* FSUtil.Service
  const bytes = yield* fs.readFile(fileURLToPath(file.uri)).pipe(Effect.catch(() => Effect.succeed(undefined)))
  return bytes === undefined ? undefined : `data:${file.mime};base64,${Buffer.from(bytes).toString("base64")}`
})

type NormalizedAttachment =
  | { readonly _tag: "keep"; readonly file: FileAttachment }
  | { readonly _tag: "inline"; readonly text: string }

const normalizeFile = Effect.fnUntraced(function* (
  file: FileAttachment,
  input: readonly string[] | undefined,
): Effect.fn.Return<NormalizedAttachment, LLMError, FSUtil.Service> {
  if (file.mime.startsWith("text/"))
    return { _tag: "inline", text: textAttachmentBlock(file, yield* readTextAttachment(file)) }
  if (file.mime === "application/x-directory")
    return { _tag: "inline", text: directoryAttachmentBlock(file, yield* readDirectoryListing(file)) }
  const modality = modalityOf(file.mime)
  if (modality !== undefined && input !== undefined && !input.includes(modality))
    return { _tag: "inline", text: unsupportedModalityText(file, modality) }
  if (file.uri.startsWith("data:")) return { _tag: "keep", file }
  if (file.uri.startsWith("file:")) {
    const dataUrl = yield* readBinaryDataUrl(file)
    return dataUrl === undefined
      ? { _tag: "inline", text: textAttachmentBlock(file, undefined) }
      : { _tag: "keep", file: new FileAttachment({ ...file, uri: dataUrl }) }
  }
  // No protocol route can fetch or lower a remote/unknown attachment URI; passing it through would
  // leak the internal reference onto the wire, so reject typed with a clear error instead.
  return yield* new LLMError({
    module: "SessionRunner",
    method: "normalizeAttachments",
    reason: new InvalidRequestReason({
      message: `Cannot materialize attachment ${file.name ?? "attachment"} (${file.mime}) with URI ${file.uri}: only data: and file: attachment URIs can be lowered to provider wire media`,
    }),
  })
})

export const normalizeAttachments = Effect.fn("SessionRunner.normalizeAttachments")(function* (
  messages: readonly SessionMessage.Message[],
  input: readonly string[] | undefined,
) {
  return yield* Effect.forEach(messages, (message): Effect.Effect<SessionMessage.Message, LLMError, FSUtil.Service> => {
    if (message.type !== "user" || (message.files ?? []).length === 0) return Effect.succeed(message)
    return Effect.map(
      Effect.forEach(message.files ?? [], (file) => normalizeFile(file, input)),
      (normalized) =>
        new SessionMessage.User({
          ...message,
          text: [message.text, ...normalized.flatMap((part) => (part._tag === "inline" ? [part.text] : []))]
            .filter((value) => value.length > 0)
            .join("\n\n"),
          files: normalized.flatMap((part) => (part._tag === "keep" ? [part.file] : [])),
        }),
    )
  })
})
