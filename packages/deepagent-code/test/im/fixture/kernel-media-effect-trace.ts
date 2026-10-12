import { createHash } from "node:crypto"
import { Context, Effect, Layer, Option } from "effect"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { IMKernelSync } from "@/im/kernel/sync"
import type { IMFacade } from "@/im/facade"
import type { IMKernelReader } from "@/im/kernel/reader"

export type Fact = { stage: "sdk-effect" | "reader-effect"; operation: string; phase: "start" | "returned" | "error" | "final"; requestID: number; at: number; idHash?: string }
class Request extends Context.Service<Request, { requestID: number }>()("@test/im/MediaEffectTrace/Request") {}

/** Only the QA listener uses this composition seam. Original services, effects,
 * current checks, permit ownership, returned values and errors are delegated. */
export function builder(emit: (fact: Fact) => void): IMFacade.EngineBuilder {
  const calls = { value: 0 }
  const readers = new WeakSet<IMKernelReader.Interface>()
  const report = (fact: Fact) => { try { emit(fact) } catch {} }
  return (config, options) => {
    const observedSDK = Layer.effect(KernelSdk.Service, Effect.gen(function* () {
      const sdk = yield* KernelSdk.Service
      const observe = <A>(operation: string, effect: Effect.Effect<A, KernelSdk.KernelError>, idHash?: string) => Effect.gen(function* () {
        const requestID = Option.getOrUndefined(yield* Effect.serviceOption(Request))?.requestID ?? 0
        const fact = (phase: Fact["phase"]) => Effect.sync(() => report({ stage: "sdk-effect", operation, phase, requestID, at: Date.now(), ...(idHash ? { idHash } : {}) }))
        yield* fact("start")
        return yield* effect.pipe(Effect.tap(() => fact("returned")), Effect.tapError(() => fact("error")), Effect.ensuring(fact("final")))
      })
      return KernelSdk.Service.of({ ...sdk, media: sdk.media ? { ...sdk.media,
        capabilities: () => observe("capabilities", sdk.media!.capabilities()),
        begin: (input) => observe("begin", sdk.media!.begin(input), createHash("sha256").update(input.upload.uploadID).digest("hex")),
        putChunk: (input) => observe("chunk", sdk.media!.putChunk(input), createHash("sha256").update(input.objectID).digest("hex")),
        finalize: (input) => observe("finalize", sdk.media!.finalize(input), createHash("sha256").update(input.objectID).digest("hex")),
      } : undefined })
    })).pipe(Layer.provide(KernelSdk.liveFromConfig(config)))
    const original = IMKernelSync.layer(config, options).pipe(Layer.provide(KernelClient.layer.pipe(Layer.provide(observedSDK))))
    return Layer.effect(IMKernelSync.Service, Effect.gen(function* () {
      const sync = yield* IMKernelSync.Service
      if (!sync.acquireReader) return sync
      return IMKernelSync.Service.of({ ...sync, acquireReader: (context) => sync.acquireReader!(context).pipe(Effect.tap((lease) => Effect.sync(() => {
        if (readers.has(lease.reader)) return
        readers.add(lease.reader)
        const request = lease.reader.request
        // fixedEngine closes over this same reader object. Wrapping only its
        // exported media property would miss the real createMessage caller.
        Object.defineProperty(lease.reader, "request", { configurable: true, enumerable: true, value: (<A, E>(effect: Effect.Effect<A, E>, lane: "foreground" | "background" = "foreground") => Effect.suspend(() => {
          const requestID = ++calls.value
          const fact = (phase: Fact["phase"]) => Effect.sync(() => report({ stage: "reader-effect", operation: lane, phase, requestID, at: Date.now() }))
          return fact("start").pipe(Effect.andThen(request(effect.pipe(Effect.provideService(Request, { requestID })), lane)),
            Effect.tap(() => fact("returned")), Effect.tapError(() => fact("error")), Effect.ensuring(fact("final")))
        })) as typeof request })
      }))) })
    })).pipe(Layer.provide(original))
  }
}

export * as MediaEffectTrace from "./kernel-media-effect-trace"
