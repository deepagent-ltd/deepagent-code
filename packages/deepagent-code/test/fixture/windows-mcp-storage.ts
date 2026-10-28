import { Effect, Layer } from "effect"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"

// The compiled entry has already installed the original Native capture. Use the
// production Root assembly, including settings custody and the real DPAPI port.
export const windowsMcpStorage = process.platform === "win32"
  ? Layer.unwrap(Effect.promise(async () => {
      const { Root } = await import("../../src/effect/root")
      return Root.windowsStorageLayer.pipe(Layer.provide(EffectFlock.defaultLayer))
    }))
  : Layer.empty
