export * as ApplyPatchChunkTool from "./apply-patch-chunk"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { Effect, Layer, Schema } from "effect"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ApplyPatchTool } from "./apply-patch"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "apply_patch_chunk"

const MAX_CHUNK_BYTES = 12_000
const MAX_PATCH_BYTES = 2_000_000
const MAX_TRANSACTIONS_PER_SESSION = 8
const TRANSACTION_TTL_MS = 30 * 60 * 1000
const encoder = new TextEncoder()

const Input = Schema.Struct({
  action: Schema.Literals(["begin", "append", "commit", "abort"]).annotate({
    description: "begin starts a transaction; append adds text; commit validates and applies; abort discards it",
  }),
  transactionID: Schema.optional(Schema.String).annotate({
    description: "The transaction ID returned by begin; required for append, commit, and abort",
  }),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "UTF-8 byte offset for append or commit; must equal nextOffset from the previous result",
  }),
  patchText: Schema.optional(Schema.String).annotate({
    description: `A verbatim patch chunk of at most ${MAX_CHUNK_BYTES} UTF-8 bytes`,
  }),
})

const Output = Schema.Struct({
  transactionID: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  chunks: Schema.optional(Schema.Number),
  nextOffset: Schema.optional(Schema.Number),
  applied: Schema.optional(Schema.Array(ApplyPatchTool.Applied)),
  message: Schema.String,
})

/**
 * Location-scoped port of the V1 chunked-patch transaction tool (RI-26 W2). The transaction map
 * is per-layer-instance, session-keyed, count-bounded, and TTL-swept on every call: an abandoned
 * transaction can neither accumulate unbounded memory nor outlive a stalled session by more than
 * the TTL. Commit delegates to the SAME apply pipeline as the plain apply_patch tool.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const apply = ApplyPatchTool.makeApply({
      mutation: yield* LocationMutation.Service,
      files: yield* FileMutation.Service,
      fs: yield* FSUtil.Service,
      permission: yield* PermissionV2.Service,
    })

    const transactions = new Map<
      string,
      {
        readonly sessionID: string
        readonly createdAt: number
        readonly chunks: ReadonlyArray<string>
        readonly size: number
      }
    >()

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description: `Stage a large apply_patch payload in bounded JSON chunks, then validate and apply it as one transaction.

Use this only when a normal apply_patch call may be too large for one tool call. Call begin with offset 0 and the first patchText chunk. For every append and the final commit, send the exact nextOffset returned by the previous result. Chunks are concatenated verbatim. Each patchText must be at most ${MAX_CHUNK_BYTES} UTF-8 bytes; keep Chinese-language chunks below roughly 4000 characters. Commit never accepts patchText. No workspace file is changed before commit. Abort discards the staged patch.`,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [toolText({ type: "text", text: output.message })],
            execute: (input, context) =>
              Effect.gen(function* () {
                for (const [id, entry] of transactions)
                  if (Date.now() - entry.createdAt > TRANSACTION_TTL_MS) transactions.delete(id)

                const patchBytes = input.patchText ? encoder.encode(input.patchText).byteLength : 0
                if (patchBytes > MAX_CHUNK_BYTES)
                  return yield* new ToolFailure({
                    message: `apply_patch_chunk failed: patchText has ${patchBytes} UTF-8 bytes; split it into chunks of at most ${MAX_CHUNK_BYTES} bytes`,
                  })

                if (input.action === "begin") {
                  if (!input.patchText)
                    return yield* new ToolFailure({ message: "apply_patch_chunk failed: begin requires a non-empty patchText chunk" })
                  if (input.offset !== undefined && input.offset !== 0)
                    return yield* new ToolFailure({ message: "apply_patch_chunk failed: begin offset must be 0" })
                  const active = Array.from(transactions.values()).filter((item) => item.sessionID === context.sessionID).length
                  if (active >= MAX_TRANSACTIONS_PER_SESSION)
                    return yield* new ToolFailure({
                      message: `apply_patch_chunk failed: session already has ${MAX_TRANSACTIONS_PER_SESSION} active transactions`,
                    })
                  const transactionID = `patch_${crypto.randomUUID()}`
                  transactions.set(transactionID, {
                    sessionID: context.sessionID,
                    createdAt: Date.now(),
                    chunks: [input.patchText],
                    size: patchBytes,
                  })
                  return {
                    transactionID,
                    size: patchBytes,
                    chunks: 1,
                    nextOffset: patchBytes,
                    message: `Patch transaction ${transactionID} started with ${patchBytes} UTF-8 bytes. Use offset ${patchBytes} for the next append or commit. No workspace files have changed.`,
                  }
                }

                if (!input.transactionID)
                  return yield* new ToolFailure({ message: `apply_patch_chunk failed: ${input.action} requires transactionID` })
                const transaction = transactions.get(input.transactionID)
                if (!transaction || transaction.sessionID !== context.sessionID)
                  return yield* new ToolFailure({ message: `apply_patch_chunk failed: transaction not found: ${input.transactionID}` })

                if (input.action === "abort") {
                  transactions.delete(input.transactionID)
                  return {
                    transactionID: input.transactionID,
                    message: `Patch transaction ${input.transactionID} was discarded. No workspace files changed.`,
                  }
                }

                if (input.offset === undefined)
                  return yield* new ToolFailure({ message: `apply_patch_chunk failed: ${input.action} requires offset` })
                if (input.offset !== transaction.size)
                  return yield* new ToolFailure({
                    message: `apply_patch_chunk failed: ${input.action} offset ${input.offset} does not match next expected UTF-8 byte offset ${transaction.size}`,
                  })

                if (input.action === "commit" && input.patchText !== undefined)
                  return yield* new ToolFailure({
                    message: "apply_patch_chunk failed: commit does not accept patchText; append the final chunk first",
                  })

                const size = transaction.size + patchBytes
                if (size > MAX_PATCH_BYTES) {
                  transactions.delete(input.transactionID)
                  return yield* new ToolFailure({
                    message: `apply_patch_chunk failed: assembled patch exceeds ${MAX_PATCH_BYTES} UTF-8 bytes and was discarded`,
                  })
                }
                const chunks = input.patchText ? [...transaction.chunks, input.patchText] : transaction.chunks

                if (input.action === "append") {
                  if (!input.patchText)
                    return yield* new ToolFailure({ message: "apply_patch_chunk failed: append requires a non-empty patchText chunk" })
                  transactions.set(input.transactionID, { ...transaction, chunks, size })
                  return {
                    transactionID: input.transactionID,
                    size,
                    chunks: chunks.length,
                    nextOffset: size,
                    message: `Staged chunk ${chunks.length} for ${input.transactionID}; ${size} UTF-8 bytes total. Use offset ${size} for the next append or commit. No workspace files have changed.`,
                  }
                }

                transactions.delete(input.transactionID)
                const result = yield* apply({ patchText: chunks.join("") }, context)
                return {
                  transactionID: input.transactionID,
                  message: `Patch transaction ${input.transactionID} committed.`,
                  applied: result.applied,
                }
              }),
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)
