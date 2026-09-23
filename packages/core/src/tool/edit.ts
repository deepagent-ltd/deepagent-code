/**
 * Model-facing V2 exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval. Named project references
 * are read-oriented and deliberately are not accepted by mutation tools.
 */
export * as EditTool from "./edit"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { Effect, Layer, Option, Schema } from "effect"
import * as SessionState from "../deepagent/session-state"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { EditReplace } from "./edit-replace"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval. Named project references are read-oriented and are not accepted.",
  }),
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
  replacements: Schema.Number,
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return { bom, content, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
}

const previewLines = (value: string, prefix: "+" | "-") => {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

export const toModelOutput = (output: Output, oldString: string, newString: string) =>
  [
    `Edited file successfully: ${output.resource}`,
    `Replacements: ${output.replacements}`,
    "```diff",
    ...previewLines(oldString, "-"),
    ...previewLines(newString, "+"),
    "```",
  ].join("\n")

/** Deferred V2 edit behavior and UX integrations remain visible at the model-facing seam. */
// RI-26 W2: the V1 fuzzy correction ladder (edit-replace.ts) is now the matching path; the exact
// strategy remains FIRST in the ladder, so previously-exact edits behave identically.
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after V2 LSP runtime exists.

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Replace exact text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval. Named project references are read-oriented and are not accepted.",
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => [
              toolText({ type: "text", text: toModelOutput(output, input.oldString, input.newString) }),
            ],
            execute: (input, context) => {
              const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.mapError((error) => {
                    const refusal = PermissionV2.permissionToolFailure(error)
                    if (refusal !== null) return refusal
                    if (error instanceof FileMutation.StaleContentError)
                      return new ToolFailure({
                        message: "File changed after permission approval. Read it again before editing.",
                      })
                    return new ToolFailure({ message: `Unable to edit ${input.path}` })
                  }),
                )

              return Effect.gen(function* () {
                const permissionSource = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (input.oldString === input.newString) {
                  return yield* new ToolFailure({
                    message: "No changes to apply: oldString and newString are identical.",
                  })
                }
                if (input.oldString === "") {
                  return yield* new ToolFailure({
                    message: "oldString must not be empty. Use write to create or overwrite a file.",
                  })
                }

                const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
                const external = target.externalDirectory
                if (external) {
                  yield* unableToEdit(
                    permission.assert({
                      ...LocationMutation.externalDirectoryPermission(external),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: permissionSource,
                    }),
                  )
                }

                yield* unableToEdit(
                  permission.assert({
                    action: "edit",
                    resources: [target.resource],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: permissionSource,
                  }),
                )
                const source = decodeUtf8(yield* unableToEdit(fs.readFile(target.canonical)))
                const ending = detectLineEnding(source.text)
                const oldString = convertToLineEnding(input.oldString, ending)
                const newString = convertToLineEnding(input.newString, ending)
                // RI-26 W2 fuzzy parity: the V1 correction-strategy ladder (exact → line-trimmed →
                // block-anchor similarity → whitespace/indentation/escape normalization → context
                // anchors). A fuzzy span only applies when it resolves to a unique occurrence (or
                // replaceAll), and the disproportionate-match guard refuses loose anchors that
                // swallow far more than oldString names.
                const outcome = EditReplace.replace(source.text, oldString, newString, input.replaceAll === true)
                if (!outcome.ok) {
                  if (outcome.reason === "not_found")
                    return yield* new ToolFailure({
                      message:
                        "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
                    })
                  if (outcome.reason === "disproportionate_match")
                    return yield* new ToolFailure({
                      message:
                        "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
                    })
                  return yield* new ToolFailure({
                    message:
                      "Found multiple matches for oldString. Provide more surrounding context or set replaceAll to true.",
                  })
                }

                const next = splitBom(outcome.text)
                const result = yield* unableToEdit(
                  files.writeIfUnchanged({
                    target,
                    expected: source.content,
                    content: joinBom(next.text, source.bom || next.bom),
                  }),
                )
                // A successful mutation is an observation of the version it produced, so the write
                // leaf's freshness precondition sees this session as up to date on the file.
                const after = yield* fs.stat(target.canonical).pipe(Effect.orElseSucceed(() => undefined))
                if (after !== undefined)
                  yield* Effect.sync(() => {
                    SessionState.observeFile(context.sessionID, target.canonical, {
                      mtimeMs: after.mtime.pipe(
                        Option.map((date) => date.getTime()),
                        Option.getOrElse(() => 0),
                      ),
                      size: Number(after.size),
                    })
                  })
                return { ...result, replacements: outcome.replacements } satisfies Output
              })
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/edit",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, FSUtil.node, PermissionV2.node],
})
