export * as SystemContextRegistry from "./registry"

import { Context, Effect, Layer, Ref, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SystemContext } from "./index"

export interface Entry {
  readonly key: SystemContext.Key
  readonly load: Effect.Effect<SystemContext.SystemContext>
}

export interface Interface {
  readonly register: (entry: Entry) => Effect.Effect<void, never, Scope.Scope>
  readonly load: () => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SystemContextRegistry") {}

export const MAX_ENTRIES = 64

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<Entry>>([])

    return Service.of({
      register: Effect.fn("SystemContextRegistry.register")(function* (entry) {
        yield* Effect.acquireRelease(
          Ref.modify(entries, (current) => {
            if (current.some((item) => item.key === entry.key)) return ["duplicate" as const, current]
            if (current.length >= MAX_ENTRIES) return ["full" as const, current]
            return ["added" as const, [...current, entry]]
          }).pipe(
            Effect.flatMap((result) => {
              if (result === "added") return Effect.void
              if (result === "duplicate") return Effect.die(`Duplicate system context entry key: ${entry.key}`)
              return Effect.die(`System context registry exceeds ${MAX_ENTRIES} entries`)
            }),
            Effect.as(entry),
          ),
          (entry) => Ref.update(entries, (current) => current.filter((item) => item !== entry)),
        )
      }),
      load: Effect.fn("SystemContextRegistry.load")(function* () {
        const current = (yield* Ref.get(entries)).toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        return SystemContext.combine(yield* Effect.forEach(current, (entry) => entry.load, { concurrency: 8 }))
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
