export * as ReadTool from "./read"

import { ToolFailure } from "@deepagent-code/llm"
import { Effect, Layer, Schema } from "effect"
import * as SessionState from "../deepagent/session-state"
import { FileSystem } from "../filesystem"
import { Image } from "../image"
import { PermissionV2 } from "../permission"
import { WorkToolPolicy } from "../session/work-tool-policy"
import { recoverReadDefect } from "./read-failure"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "read"
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const LocationInput = Schema.Struct({
  ...FileSystem.ReadInput.fields,
  offset: FileSystem.ListPageInput.fields.offset.annotate({
    description: "The 1-based directory entry or text line offset to start reading from",
  }),
  limit: FileSystem.ListPageInput.fields.limit.annotate({
    description: "The maximum number of directory entries or text lines to read",
  }),
})
export const Input = Schema.Struct({
  ...LocationInput.fields,
  byteOffset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))),
  pageBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(51_200))),
})
const ProjectPage = Schema.Struct({ type: Schema.Literal("work-text-page"), content: Schema.String,
  nextByteOffset: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) })
const Output = Schema.Union([FileSystem.Content, FileSystem.TextPage, FileSystem.ListPage, ProjectPage])
const nativeReads = new WeakSet<object>()
export function isNativeRead(tool: object) { return nativeReads.has(tool) }

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const filesystem = yield* FileSystem.Service
    const image = yield* Image.Service
    const permission = yield* PermissionV2.Service
    const storage = yield* SessionState.CurrentStorage

    const tool = Tool.make({
          description:
            "Read a text file or supported image, page through a large UTF-8 text file by line offset, or list a directory page in the current Location. Paths may be Location-relative or absolute within the current Location. Absolute managed tool-output paths are also accepted. In an explicitly authorized project Work, use only a relative path; byteOffset defaults to 0 and pageBytes defaults to the captured file budget (at most 51200). Offset/limit, images and directory reads are unavailable in that native read profile. Continue at the returned nextByteOffset.",
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => {
            if ("type" in output && output.type === "work-text-page")
              return [{ type: "text", text: output.nextByteOffset === null ? output.content
                : `${output.content}\n\n... continue reading at byteOffset ${output.nextByteOffset} ...` }]
            if ("type" in output && output.type === "text") return [{ type: "text", text: output.content }]
            if ("type" in output && output.type === "text-page")
              return [
                {
                  type: "text",
                  text:
                    output.truncated && output.next !== undefined
                      ? `${output.content}\n\n... continue reading at offset ${output.next} ...`
                      : output.content,
                },
              ]
            if (!("type" in output) || output.type !== "binary" || !SUPPORTED_IMAGE_MIMES.has(output.mime)) return []
            return [
              { type: "text", text: "Image read successfully" },
              { type: "file", data: output.content, mime: output.mime, name: input.path },
            ]
          },
          execute: (input, context) => {
            return Effect.gen(function* () {
              const projectResource = yield* WorkToolPolicy.readResource(context, input).pipe(Effect.catchTag("WorkAuthority.Error", Effect.die))
              if (projectResource !== undefined) {
                yield* permission.assert({ action: name, resources: [projectResource], save: [projectResource],
                  sessionID: context.sessionID, agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const result = yield* WorkToolPolicy.read(context, { path: input.path, byteOffset: input.byteOffset,
                  pageBytes: input.pageBytes }).pipe(Effect.orDie)
                if (!result) return yield* Effect.die(new Error("Project native read scope expired"))
                return { type: "work-text-page" as const, content: result.text, nextByteOffset: result.next }
              }
              if (input.byteOffset !== undefined || input.pageBytes !== undefined)
                return yield* new ToolFailure({ message: "Byte pagination requires an authorized project Work" })
              const resolved = yield* filesystem.resolveReadPath(input)
              yield* permission.assert({
                action: name,
                resources: [resolved.resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              if (resolved.type === "directory") return yield* filesystem.listPage(input)
              const content = yield* filesystem.readTool(input, {
                offset: input.offset,
                limit: input.limit,
              })
              if (content.type === "binary" && SUPPORTED_IMAGE_MIMES.has(content.mime)) {
                return yield* image
                  .normalize(resolved.resource, content)
                  .pipe(Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)))
              }
              if (content.type === "binary")
                return yield* Effect.fail(new FileSystem.BinaryFileError(resolved.resource))
              // Permission resources are relative labels, not filesystem paths. Only the actual
              // contained FD read can provide a canonical/version observation for the write guard.
              const observed = FileSystem.readObservation(content)
              if (observed)
                yield* Effect.sync(() => storage.run(() =>
                  SessionState.observeFile(context.sessionID, observed.canonical,
                    { mtimeMs: observed.mtimeMs, size: observed.size })))
              return content
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const refusal = PermissionV2.permissionToolFailure(error)
                if (refusal !== null) return refusal
                const message =
                  error instanceof FileSystem.BinaryFileError ||
                  error instanceof FileSystem.MediaIngestLimitError ||
                  error instanceof Image.DecodeError ||
                  error instanceof Image.SizeError
                    ? error.message
                    : `Unable to read ${input.path}`
                return new ToolFailure({ message })
              }),
              Effect.catchDefect((defect) => recoverReadDefect(input.path, defect)),
            )
          },
        })
    nativeReads.add(tool)
    yield* tools.register({ [name]: tool }).pipe(Effect.orDie)
  }),
)
