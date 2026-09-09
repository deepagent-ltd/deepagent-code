import { Effect, Layer } from "effect"
import { InstanceStore } from "./instance-store"
import { InstanceRegistry } from "@/effect/instance-registry"
import * as Project from "./project"

export const layer = Layer.unwrap(
  Effect.promise(async () => {
    const { InstanceBootstrap } = await import("./bootstrap")
    return InstanceStore.layer.pipe(
      Layer.provide(Project.defaultLayer),
      Layer.provide(InstanceBootstrap.defaultLayer),
      Layer.provideMerge(InstanceRegistry.layer),
    )
  }),
)

export * as InstanceLayer from "./instance-layer"
