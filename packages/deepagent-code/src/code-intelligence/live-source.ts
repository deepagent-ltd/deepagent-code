import { EditorBufferSnapshot } from "@deepagent-code/core/code-intelligence/editor-buffer"
import type { LocationKey } from "@deepagent-code/core/context-federation/reference"
import { Hash } from "@deepagent-code/core/util/hash"
import { Effect, Schema } from "effect"
import { readFile, realpath } from "node:fs/promises"
import path from "node:path"

export class SourceUnavailableError extends Schema.TaggedErrorClass<SourceUnavailableError>()(
  "CodeLiveSource.SourceUnavailableError",
  { reason: Schema.Literals(["path", "missing", "symlink_escape"]) },
) {}

export type Result = {
  readonly content: string
  readonly contentSource: "editor_buffer" | "filesystem"
  readonly contentSha: string
  readonly documentVersion?: number
  readonly graph: "current" | "stale"
  readonly editorOverlay: "ready" | "unavailable" | "not_applicable"
  readonly reasonCode?: "buffer_lsp_mismatch"
}

export function materialize(input: {
  readonly root: string
  readonly locationKey: LocationKey
  readonly path: string
  readonly sessionId: string
  readonly graphContentSha?: string
  readonly lsp?: { readonly documentVersion?: number; readonly contentSha?: string }
}): Effect.Effect<Result, SourceUnavailableError, EditorBufferSnapshot.Service> {
  return Effect.gen(function* () {
    if (!validPath(input.path)) return yield* new SourceUnavailableError({ reason: "path" })
    const buffer = yield* (yield* EditorBufferSnapshot.Service).get({
      locationKey: input.locationKey,
      path: input.path,
      sessionId: input.sessionId,
    })
    const aligned =
      buffer &&
      (!input.lsp ||
        ((input.lsp.documentVersion !== undefined || input.lsp.contentSha !== undefined) &&
          (input.lsp.documentVersion === undefined || input.lsp.documentVersion === buffer.documentVersion) &&
          (input.lsp.contentSha === undefined || input.lsp.contentSha === buffer.contentSha)))
    if (buffer && aligned) {
      return {
        content: buffer.content,
        contentSource: "editor_buffer",
        contentSha: buffer.contentSha,
        documentVersion: buffer.documentVersion,
        graph: input.graphContentSha === undefined || input.graphContentSha === buffer.contentSha ? "current" : "stale",
        editorOverlay: "ready",
      }
    }
    const root = yield* Effect.tryPromise({
      try: () => realpath(input.root),
      catch: () => new SourceUnavailableError({ reason: "missing" }),
    })
    const target = path.resolve(root, input.path)
    const canonical = yield* Effect.tryPromise({
      try: () => realpath(target),
      catch: () => new SourceUnavailableError({ reason: "missing" }),
    })
    if (!inside(root, canonical)) return yield* new SourceUnavailableError({ reason: "symlink_escape" })
    const content = yield* Effect.tryPromise({
      try: () => readFile(canonical, "utf8"),
      catch: () => new SourceUnavailableError({ reason: "missing" }),
    })
    const contentSha = Hash.sha256(content)
    return {
      content,
      contentSource: "filesystem",
      contentSha,
      graph: input.graphContentSha === undefined || input.graphContentSha === contentSha ? "current" : "stale",
      editorOverlay: buffer ? "unavailable" : "not_applicable",
      ...(buffer ? { reasonCode: "buffer_lsp_mismatch" as const } : {}),
    }
  })
}

function validPath(filePath: string) {
  return Boolean(filePath && !filePath.startsWith("/") && !filePath.includes("\\") && !filePath.split("/").includes(".."))
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
