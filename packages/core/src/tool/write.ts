/**
 * Model-facing V2 file-write leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval. Named project references
 * are read-oriented and deliberately are not accepted by mutation tools.
 */
export * as WriteTool from "./write"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { FileLock } from "../file-lock"
import { FileMutation } from "../file-mutation"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { WorkToolPolicy } from "../session/work-tool-policy"
import { WorkFileCapability } from "../session/work-file-capability"
import { WorkCommandSchema } from "../session/work-command.schema"
import * as SessionState from "../deepagent/session-state"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "write"
const nativeWrites = new WeakSet<object>()
export function isNativeWrite(tool: object) { return nativeWrites.has(tool) }

// TODO: Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.
export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to write. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval. Named project references are read-oriented and are not accepted.",
  }),
  content: Schema.Union([Schema.String, WorkCommandSchema.OutputReference]).annotate({
    description: "Text content, or an authenticated command_output reference from the same managed Work (at most 50 KiB)." }),
  overwrite: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Required to overwrite an unread existing file in an ordinary session. Managed Work must still read the current file first; overwrite never bypasses its authenticated observation or native version check.",
  }),
})

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}`

/** Deferred V2 write UX integrations remain visible at the model-facing seam. */
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after V2 LSP runtime exists.

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const permission = yield* PermissionV2.Service
    const fileLock = yield* FileLock.Service
    // The freshness precondition needs the on-disk version; FSUtil is the shared Location fs service
    // the other mutating leaves already acquire.
    const fs = yield* FSUtil.Service
    const storage = yield* SessionState.CurrentStorage

    const tool = Tool.withPermission(
          Tool.make({
            description:
              "Write content to one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval. Named project references are read-oriented and are not accepted.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [toolText({ type: "text", text: toModelOutput(output) })],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const resource = yield* WorkToolPolicy.writeResource(context, input.path).pipe(Effect.orDie)
                if (resource !== undefined) {
                  if (!permission.authorizeAction || !permission.checkAction)
                    return yield* Effect.die(new Error("Project native write requires current scoped approval and observed content"))
                  const request = { action: "edit", resources: [resource], save: [resource],
                    sessionID: context.sessionID, agent: context.agent, source }
                  const checkAction = permission.checkAction
                  const authorizeAction = permission.authorizeAction
                  return yield* Effect.scoped(Effect.gen(function* () {
                    const permit = yield* authorizeAction(request)
                    // The model's overwrite intent cannot waive managed Work's read
                    // observation, scoped approval or Native compare-and-swap.
                    const result = yield* WorkToolPolicy.write(context, { path: input.path, content: input.content,
                      checkPermission: checkAction(permit, request).pipe(Effect.mapError(() => new WorkFileCapability.Error({
                        code: "WORK_FILE_CHANGED", message: "The native write approval is no longer current",
                      }))),
                    }).pipe(Effect.orDie)
                    if (result.outcome === "refused_before_publish") return yield* new ToolFailure({ message: WorkToolPolicy.WRITE_REFUSED })
                    return { operation: "write" as const, target: resource, resource, existed: result.existed }
                  }))
                }
                if (typeof input.content !== "string") return yield* new ToolFailure({ message: "Command output references require the originating managed Work" })
                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                const external = target.externalDirectory
                if (external)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                yield* permission.assert({
                  action: "edit",
                  resources: [target.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                // V3.7 Phase 4.1C: block agent write when a human editor holds the lock
                const lock = fileLock.status(target.canonical)
                if (lock?.kind === "human") {
                  return yield* Effect.fail(
                    new ToolFailure({
                      message: `File ${input.path} is locked by a human editor. Wait for them to finish or ask them to save.`,
                    }),
                  )
                }
                // Freshness precondition. `edit` has one for free — its `oldString` must match the
                // bytes on disk — but `write` replaces content wholesale, so without this an agent
                // can silently clobber a file it never read (or read before someone else changed
                // it). This mirrors the two halves the reference implementations kept: Claude Code
                // requires a prior read for an existing path and re-checks the mtime before
                // committing, and deepseek-harness turns every write into a compare-and-swap against
                // the observed version. The failure comes back as an ordinary tool error whose text
                // states the recovery step; nothing is retried for the model (the same posture as
                // the references, where recovery is model-driven off the error result).
                const current = yield* fs.stat(target.canonical).pipe(Effect.orElseSucceed(() => undefined))
                if (current !== undefined) {
                  const observed = storage.run(() => SessionState.observedFile(context.sessionID, target.canonical))
                  const now = {
                    mtimeMs: current.mtime.pipe(
                      Option.map((date) => date.getTime()),
                      Option.getOrElse(() => 0),
                    ),
                    size: Number(current.size),
                  }
                  if (observed === undefined) {
                    if (input.overwrite !== true)
                      return yield* Effect.fail(
                        new ToolFailure({
                          message: `File ${input.path} already exists and has not been read in this session. Read it first, or pass overwrite: true if replacing it is intended.`,
                        }),
                      )
                  } else if (now.mtimeMs !== observed.mtimeMs || now.size !== observed.size) {
                    return yield* Effect.fail(
                      new ToolFailure({
                        message: `File ${input.path} was modified since it was read (by you, the user, or a linter). Read it again before attempting to write it.`,
                      }),
                    )
                  }
                }
                const written = yield* files.writeTextPreservingBom({ target, content: input.content })
                // The write is itself an observation: the session now knows this exact version, so a
                // second write without an intervening re-read is legitimate. Stat AFTER the write so
                // the recorded version is the one on disk, not an assumption about it.
                const after = yield* fs.stat(target.canonical).pipe(Effect.orElseSucceed(() => undefined))
                if (after !== undefined)
                  yield* Effect.sync(() => storage.run(() => {
                    SessionState.observeFile(context.sessionID, target.canonical, {
                      mtimeMs: after.mtime.pipe(
                        Option.map((date) => date.getTime()),
                        Option.getOrElse(() => 0),
                      ),
                      size: Number(after.size),
                    })
                  }))
                return written
              }).pipe(
                // Preserve the freshness precondition's own message (it names the recovery step);
                // everything else keeps the generic shape, exactly like the edit leaf.
                Effect.mapError((error) => {
                  const refusal = PermissionV2.permissionToolFailure(error)
                  if (error instanceof ToolFailure) return error
                  if (refusal !== null) return refusal
                  return new ToolFailure({ message: `Unable to write ${input.path}` })
                }),
              ),
          }),
          "edit",
        )
    nativeWrites.add(tool)
    yield* tools.register({ [name]: tool }).pipe(Effect.orDie)
  }),
  // V3.7 Phase 4.1C: FileLock.layer is self-contained (no external deps),
  // provided here so WriteTool.layer doesn't leak FileLock.Service as a requirement.
).pipe(Layer.provide(FileLock.layer))
