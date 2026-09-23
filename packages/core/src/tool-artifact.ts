export * as ToolArtifact from "./tool-artifact"

import { createHash, randomUUID } from "node:crypto"
import { realpath, rename } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { Effect, Schema } from "effect"
import { toolFile, toolText, type ToolContent, type ToolFileContent } from "@deepagent-code/llm/schema"
import { ContentSafety } from "./deepagent/content-safety"

export const MAX_BYTES = 8 * 1024 * 1024
const REF = /^artifact:sha256:(unplaced|[a-f0-9]{64}):([a-f0-9]{64}):(0|[1-9][0-9]*)$/
const MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"])
const TEXT = new Set(["text/plain", "application/json"])

export class Error extends Schema.TaggedErrorClass<Error>()("ToolArtifact.Error", {
  reason: Schema.Literals([
    "invalid_source",
    "unavailable",
    "too_large",
    "unsupported_content_type",
    "integrity_mismatch",
  ]),
}) {}

const fail = (reason: Error["reason"]) => new Error({ reason })
const mimeOf = (value: string) => value.split(";", 1)[0]?.trim().toLowerCase() ?? ""
const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const artifactPath = (root: string, digest: string) => path.join(root, `${digest}.bin`)

const readRemote = (url: string, mime: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const parsed = URL.parse(url)
      if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
        throw fail("invalid_source")
      const response = await fetch(parsed, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
      if (!response.ok || !response.body) throw fail("unavailable")
      if (mimeOf(response.headers.get("content-type") ?? "") !== mime) throw fail("unsupported_content_type")
      const declaredLength = Number(response.headers.get("content-length"))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) throw fail("too_large")
      const chunks: Uint8Array[] = []
      const reader = response.body.getReader()
      let size = 0
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > MAX_BYTES) {
          await reader.cancel()
          throw fail("too_large")
        }
        chunks.push(next.value)
      }
      return Buffer.concat(chunks, size)
    },
    catch: (cause) => (cause instanceof Error ? cause : fail("unavailable")),
  })

const readManaged = (uri: string, managedRoot: string) =>
  Effect.tryPromise({
    try: async () => {
      const parsed = URL.parse(uri)
      if (parsed?.protocol !== "file:") throw fail("invalid_source")
      const root = await realpath(managedRoot)
      const file = await realpath(fileURLToPath(parsed))
      if (!file.startsWith(root + path.sep)) throw fail("invalid_source")
      const source = Bun.file(file)
      if (source.size > MAX_BYTES) throw fail("too_large")
      return new Uint8Array(await source.arrayBuffer())
    },
    catch: (cause) => (cause instanceof Error ? cause : fail("unavailable")),
  })

const checkedBytes = (bytes: Uint8Array, mime: string): Effect.Effect<Uint8Array, Error> => {
  if (bytes.byteLength > MAX_BYTES) return Effect.fail(fail("too_large"))
  if (!TEXT.has(mime) && !MEDIA.has(mime)) return Effect.fail(fail("unsupported_content_type"))
  if (!TEXT.has(mime)) return Effect.succeed(bytes)
  // Text is scrubbed before retention, so replay and provider egress see identical safe bytes.
  // The byte ceiling is checked above; unlike log previews, this path never silently truncates.
  return Effect.succeed(
    Buffer.from(ContentSafety.scrub({ content: Buffer.from(bytes).toString("utf8"), maxLogChars: MAX_BYTES }).content),
  )
}

/** Store a remote or managed source behind a Location-scoped, content-addressed reference. */
export const materialize = (input: { file: ToolFileContent; root: string; scopeID: string; managedRoot: string }) =>
  Effect.gen(function* () {
    const mime = mimeOf(input.file.mime)
    if (!TEXT.has(mime) && !MEDIA.has(mime)) return yield* fail("unsupported_content_type")
    if (input.file.source.type === "data") {
      const data = input.file.source.data
      if (data.length > Math.ceil(MAX_BYTES / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
        return yield* fail("invalid_source")
      if (Buffer.from(data, "base64").toString("base64") !== data) return yield* fail("invalid_source")
      const bytes = yield* checkedBytes(Buffer.from(data, "base64"), mime)
      return TEXT.has(mime)
        ? toolText({ type: "text", text: Buffer.from(bytes).toString("utf8") })
        : toolFile({
            type: "file",
            source: { type: "data", data: Buffer.from(bytes).toString("base64") },
            mime,
            name: input.file.name,
          })
    }
    const source = input.file.source
    const bytes = yield* checkedBytes(
      yield* source.type === "url" ? readRemote(source.url, mime) : readManaged(source.uri, input.managedRoot),
      mime,
    )
    const digest = hashOf(bytes)
    yield* Effect.tryPromise({
      try: async () => {
        const temporary = path.join(input.root, `${digest}.${randomUUID()}.tmp`)
        await Bun.write(temporary, bytes, { createPath: true })
        await rename(temporary, artifactPath(input.root, digest))
      },
      catch: () => fail("unavailable"),
    })
    return toolFile({
      type: "file",
      source: { type: "file" as const, uri: `artifact:sha256:${input.scopeID}:${digest}:${bytes.byteLength}` },
      mime,
      name: input.file.name,
    })
  })

/** Rehydrate only a persisted artifact ref; historical remote URLs are never fetched on replay. */
export const rehydrate = (input: {
  file: ToolFileContent
  root: string
  sessionID: string
}): Effect.Effect<ToolContent, Error> =>
  Effect.gen(function* () {
    if (input.file.source.type === "data")
      return yield* materialize({ file: input.file, root: input.root, scopeID: "unplaced", managedRoot: input.root })
    if (input.file.source.type !== "file") return yield* fail("invalid_source")
    const match = REF.exec(input.file.source.uri)
    if (!match) return yield* fail("invalid_source")
    const digest = match[2]
    const expectedBytes = Number(match[3])
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_BYTES) return yield* fail("too_large")
    const mime = mimeOf(input.file.mime)
    if (!TEXT.has(mime) && !MEDIA.has(mime)) return yield* fail("unsupported_content_type")
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const file = Bun.file(artifactPath(path.join(input.root, match[1], input.sessionID), digest))
        if (file.size > MAX_BYTES) throw fail("too_large")
        return new Uint8Array(await file.arrayBuffer())
      },
      catch: (cause) => (cause instanceof Error ? cause : fail("unavailable")),
    })
    if (bytes.byteLength !== expectedBytes || hashOf(bytes) !== digest) return yield* fail("integrity_mismatch")
    if (TEXT.has(mime)) return toolText({ type: "text", text: Buffer.from(bytes).toString("utf8") })
    return toolFile({
      type: "file",
      source: { type: "data", data: Buffer.from(bytes).toString("base64") },
      mime,
      name: input.file.name,
    })
  })
