export * as BrowserFileLeafBridge from "./file-leaf-bridge"

import { Effect } from "effect"
import type { Context } from "effect"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import { BrowserFileCapability } from "@deepagent-code/core/browser/file-capability"
import { BrowserFileExchange } from "@deepagent-code/core/browser/file-exchange"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import type { BrowserProtocol } from "@deepagent-code/core/browser/protocol"
import type { BrowserSchema } from "@deepagent-code/core/browser/schema"

type Request = { artifactID: string } & (
  { operation: "upload.stage" } |
  { operation: "upload.read"; offset: number; length: number } |
  { operation: "download.write"; offset: number; payload: string } |
  { operation: "upload.seal" | "upload.observe" | "download.publish"; bytes: number; sha256: string })
type Reply = { error?: BrowserFileSchema.Error["code"]; payload?: string; publication?: BrowserFileSchema.Publication; stage?: BrowserProtocol.UploadStage }

/** One binary leaf implementation for both private owner protocols. The caller validates
 * its exact original pending RPC/owner first; this bridge retains the same opaque transfer. */
export function make(input: { capability: BrowserFileCapability.Interface; transfer: BrowserFileCapability.Transfer;
  files: readonly { grant: { preview: { name: string } }; artifact: { artifactID: string } }[];
  current: () => Promise<boolean>; context: Context.Context<never> }) {
  const completed = new Map<string, BrowserFileCapability.Observation>()
  const owned = { busy: false }
  return {
    leaf: async (request: Request): Promise<Reply> => {
      if (!input.files.some((entry) => entry.artifact.artifactID === request.artifactID) || owned.busy || completed.has(request.artifactID))
        return { error: "BROWSER_FILE_CHANGED" }
      // Claim before the current check; concurrent leaves must not share a capture offset.
      owned.busy = true
      try {
        if (!await input.current()) return { error: "BROWSER_FILE_CHANGED" }
        return await Effect.runPromiseWith(input.context)(Effect.gen(function* () {
          const file = input.capability
          yield* file.current(input.transfer)
          if (request.operation === "upload.stage") {
            if (!file.uploadStage) return yield* BrowserFileExchange.failure()
            const stage = yield* file.uploadStage(input.transfer, request.artifactID)
            if (!stage) return yield* BrowserFileExchange.failure()
            return { stage }
          }
          if (request.operation === "upload.read") {
            const bytes = yield* file.readUpload(input.transfer, { artifactID: request.artifactID, offset: request.offset, bytes: request.length })
            return { payload: Buffer.from(bytes).toString("base64") }
          }
          if (request.operation === "download.write") {
            const bytes = Buffer.from(request.payload, "base64")
            if (bytes.toString("base64") !== request.payload) return yield* BrowserFileExchange.failure("BROWSER_FILE_INVALID")
            yield* file.writeDownload(input.transfer, { artifactID: request.artifactID, offset: request.offset, bytes })
            return {}
          }
          if (request.operation === "upload.seal") {
            yield* file.sealUpload(input.transfer, request)
            const stage = file.uploadStage ? yield* file.uploadStage(input.transfer, request.artifactID) : undefined
            return stage ? { stage } : {}
          }
          const observed = yield* request.operation === "upload.observe" ? file.observeUpload(input.transfer, request) : file.publishDownload(input.transfer, request)
          const publication = file.describe(observed)
          if (!publication || !file.recordObservation) return yield* BrowserFileExchange.failure()
          yield* file.recordObservation(input.transfer, request.artifactID, observed)
          completed.set(request.artifactID, observed)
          return { publication }
        }))
      } catch (error) {
        return { error: error instanceof BrowserFileSchema.Error ? error.code : "BROWSER_FILE_UNKNOWN" }
      } finally { owned.busy = false }
    },
    unknown: input.capability.unknownAction ? input.capability.unknownAction(input.transfer).pipe(Effect.catch(() => Effect.void)) : Effect.void,
    complete: (result: BrowserSchema.Result) => Effect.gen(function* () {
      if (completed.size !== input.files.length) return yield* BrowserControl.failure("BROWSER_UNKNOWN")
      const expected = input.files.map((entry) => {
        const observed = completed.get(entry.artifact.artifactID)
        const publication = observed && input.capability.describe(observed)
        return publication ? { artifactID: publication.artifactID, grantID: publication.grantID, direction: publication.direction,
          name: entry.grant.preview.name, bytes: publication.bytes, sha256: publication.sha256, state: publication.outcome, nativeVerified: true } : null
      })
      if (expected.some((value) => !value) || BrowserControl.hash(expected) !== BrowserControl.hash(result.files)) return yield* BrowserControl.failure("BROWSER_UNKNOWN")
      // Main success must mean its exact FileList and native stages were cleared. Only then
      // capture real helper/FD cleanup; the canonical tool settles the action before refund.
      yield* input.capability.cleanup(input.transfer).pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_UNKNOWN")))
    }),
  }
}
