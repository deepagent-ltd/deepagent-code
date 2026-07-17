import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode, makeLocationNode, tags } from "../../src/effect/app-node"
import { LayerNode } from "../../src/effect/layer-node"

// Wave A0 (deepagentcore-v4.0.3 阶段 A): the AppNode foundation (layer-node + app-node, ported
// byte-for-byte from upstream opencode) must compile and produce working layers, and must COEXIST
// with our existing Layer.effect paradigm (no forced migration). This smoke test pins that contract
// before any subsystem migrates onto makeGlobalNode/makeLocationNode in later waves. It is NOT a
// variant of upstream — upstream exercises the foundation only through subsystem tests (process,
// system-context) that arrive in A1+; this asserts the foundation itself in isolation.

class Greeter extends Context.Service<Greeter, { readonly hello: () => string }>()("test/Greeter") {}
class Loud extends Context.Service<Loud, { readonly shout: () => string }>()("test/Loud") {}

describe("Wave A0 — AppNode foundation", () => {
  test("makeGlobalNode builds a compilable node whose service resolves", async () => {
    const node = makeGlobalNode({
      service: Greeter,
      layer: Layer.succeed(Greeter, { hello: () => "hi" }),
      deps: [],
    })
    const layer = LayerNode.compile(node)
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const g = yield* Greeter
        return g.hello()
      }).pipe(Effect.provide(layer)),
    )
    expect(out).toBe("hi")
  })

  test("a node's declared deps are provided when compiled (dependency graph wiring)", async () => {
    const greeter = makeGlobalNode({
      service: Greeter,
      layer: Layer.succeed(Greeter, { hello: () => "hi" }),
      deps: [],
    })
    const loud = makeGlobalNode({
      service: Loud,
      // Loud depends on Greeter — the node graph must provide it at compile time.
      layer: Layer.effect(
        Loud,
        Effect.gen(function* () {
          const g = yield* Greeter
          return { shout: () => g.hello().toUpperCase() }
        }),
      ),
      deps: [greeter],
    })
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const l = yield* Loud
        return l.shout()
      }).pipe(Effect.provide(LayerNode.compile(loud))),
    )
    expect(out).toBe("HI")
  })

  test("makeLocationNode tags a node in the location scope (scope encoded on the node)", () => {
    const node = makeLocationNode({
      service: Greeter,
      layer: Layer.succeed(Greeter, { hello: () => "loc" }),
      deps: [],
    })
    // The location tag is carried on the node (this is what encodes global vs per-location scope).
    expect(node.tag).toBe(tags.values.location)
    expect(node.name).toBe("test/Greeter")
  })

  test("coexists with the existing Layer paradigm — a node layer composes with a plain Layer", async () => {
    // A node-compiled layer and a hand-written Layer.effect must interoperate (the A0 coexistence gate:
    // AppNode does not require migrating everything at once).
    const nodeLayer = LayerNode.compile(
      makeGlobalNode({ service: Greeter, layer: Layer.succeed(Greeter, { hello: () => "node" }), deps: [] }),
    )
    const plainLayer = Layer.effect(
      Loud,
      Effect.gen(function* () {
        const g = yield* Greeter
        return { shout: () => g.hello() + "!" }
      }),
    ).pipe(Layer.provide(nodeLayer))
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* Loud).shout()
      }).pipe(Effect.provide(plainLayer)),
    )
    expect(out).toBe("node!")
  })

  test("compile throws on an unbound node (a required dependency was never bound)", () => {
    // An unbound node has no implementation; compiling it directly must throw rather than silently
    // producing a layer missing its service. Use the real global tag so the node is well-typed.
    const unboundNode = LayerNode.unbound(Greeter, tags.values.global)
    expect(() => LayerNode.compile(unboundNode as never)).toThrow()
  })
})
