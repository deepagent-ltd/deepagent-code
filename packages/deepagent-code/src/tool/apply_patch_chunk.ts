import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { ApplyPatchTool } from "./apply_patch"

const MAX_CHUNK_BYTES = 12_000
const MAX_PATCH_BYTES = 2_000_000
const MAX_TRANSACTIONS_PER_SESSION = 8
const TRANSACTION_TTL_MS = 30 * 60 * 1000
const encoder = new TextEncoder()

interface Metadata {
  [key: string]: unknown
  transactionID?: string
  size?: number
  chunks?: number
  nextOffset?: number
}

export const Parameters = Schema.Struct({
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

export const ApplyPatchChunkTool = Tool.define(
  "apply_patch_chunk",
  Effect.gen(function* () {
    const patch = yield* ApplyPatchTool
    const executePatch = yield* Tool.init(patch)
    const transactions = new Map<
      string,
      {
        readonly sessionID: string
        readonly createdAt: number
        readonly chunks: ReadonlyArray<string>
        readonly size: number
      }
    >()

    const fail = (message: string) => Effect.fail(new Error(`apply_patch_chunk failed: ${message}`))

    const run: (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) => Effect.Effect<Tool.ExecuteResult<Metadata>, Error> = Effect.fn("ApplyPatchChunkTool.execute")(
      function* (params, ctx) {
        Array.from(transactions.entries())
          .filter((entry) => Date.now() - entry[1].createdAt > TRANSACTION_TTL_MS)
          .forEach((entry) => transactions.delete(entry[0]))

        const patchBytes = params.patchText ? encoder.encode(params.patchText).byteLength : 0
        if (patchBytes > MAX_CHUNK_BYTES) {
          return yield* fail(
            `patchText has ${patchBytes} UTF-8 bytes; split it into chunks of at most ${MAX_CHUNK_BYTES} bytes`,
          )
        }

        if (params.action === "begin") {
          if (!params.patchText) return yield* fail("begin requires a non-empty patchText chunk")
          if (params.offset !== undefined && params.offset !== 0) return yield* fail("begin offset must be 0")
          const active = Array.from(transactions.values()).filter((item) => item.sessionID === ctx.sessionID).length
          if (active >= MAX_TRANSACTIONS_PER_SESSION) {
            return yield* fail(`session already has ${MAX_TRANSACTIONS_PER_SESSION} active transactions`)
          }
          const transactionID = `patch_${crypto.randomUUID()}`
          transactions.set(transactionID, {
            sessionID: ctx.sessionID,
            createdAt: Date.now(),
            chunks: [params.patchText],
            size: patchBytes,
          })
          return {
            title: "Patch transaction started",
            metadata: { transactionID, size: patchBytes, chunks: 1, nextOffset: patchBytes },
            output: `Patch transaction ${transactionID} started with ${patchBytes} UTF-8 bytes. Use offset ${patchBytes} for the next append or commit. No workspace files have changed.`,
          }
        }

        if (!params.transactionID) return yield* fail(`${params.action} requires transactionID`)
        const transaction = transactions.get(params.transactionID)
        if (!transaction || transaction.sessionID !== ctx.sessionID) {
          return yield* fail(`transaction not found: ${params.transactionID}`)
        }

        if (params.action === "abort") {
          transactions.delete(params.transactionID)
          return {
            title: "Patch transaction aborted",
            metadata: { transactionID: params.transactionID },
            output: `Patch transaction ${params.transactionID} was discarded. No workspace files changed.`,
          }
        }

        if (params.offset === undefined) return yield* fail(`${params.action} requires offset`)
        if (params.offset !== transaction.size) {
          return yield* fail(
            `${params.action} offset ${params.offset} does not match next expected UTF-8 byte offset ${transaction.size}`,
          )
        }

        if (params.action === "commit" && params.patchText !== undefined) {
          return yield* fail("commit does not accept patchText; append the final chunk first")
        }

        const size = transaction.size + patchBytes
        if (size > MAX_PATCH_BYTES) {
          transactions.delete(params.transactionID)
          return yield* fail(`assembled patch exceeds ${MAX_PATCH_BYTES} UTF-8 bytes and was discarded`)
        }
        const chunks = params.patchText ? [...transaction.chunks, params.patchText] : transaction.chunks

        if (params.action === "append") {
          if (!params.patchText) return yield* fail("append requires a non-empty patchText chunk")
          transactions.set(params.transactionID, { ...transaction, chunks, size })
          return {
            title: "Patch chunk staged",
            metadata: { transactionID: params.transactionID, size, chunks: chunks.length, nextOffset: size },
            output: `Staged chunk ${chunks.length} for ${params.transactionID}; ${size} UTF-8 bytes total. Use offset ${size} for the next append or commit. No workspace files have changed.`,
          }
        }

        transactions.delete(params.transactionID)
        const result = yield* executePatch.execute({ patchText: chunks.join("") }, ctx)
        return { ...result, metadata: result.metadata as Metadata }
      },
    )

    return {
      description: `Stage a large apply_patch payload in bounded JSON chunks, then validate and apply it as one transaction.

Use this only when a normal apply_patch call may be too large for one tool call. Call begin with offset 0 and the first patchText chunk. For every append and the final commit, send the exact nextOffset returned by the previous result. Chunks are concatenated verbatim. Each patchText must be at most ${MAX_CHUNK_BYTES} UTF-8 bytes; keep Chinese-language chunks below roughly 4000 characters. Commit never accepts patchText. No workspace file is changed before commit. Abort discards the staged patch.`,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
