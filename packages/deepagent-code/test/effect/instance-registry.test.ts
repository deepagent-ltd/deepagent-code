import { describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { InstanceRegistry } from "@/effect/instance-registry"
import type { InstanceContext } from "@/project/instance-context"

const context = (directory: string) =>
  ({ directory, worktree: directory, project: { id: directory } }) as InstanceContext

describe("InstanceRegistry", () => {
  test("isolates initializer and disposer callbacks between runtime roots", async () => {
    const left = ManagedRuntime.make(InstanceRegistry.layer)
    const right = ManagedRuntime.make(InstanceRegistry.layer)
    const calls: string[] = []

    await left.runPromise(
      Effect.all([
        InstanceRegistry.registerInitializer(async (ctx) => void calls.push(`left:init:${ctx.directory}`)),
        InstanceRegistry.registerDisposer(async (directory) => void calls.push(`left:dispose:${directory}`)),
      ]),
    )
    await right.runPromise(
      Effect.all([
        InstanceRegistry.registerInitializer(async (ctx) => void calls.push(`right:init:${ctx.directory}`)),
        InstanceRegistry.registerDisposer(async (directory) => void calls.push(`right:dispose:${directory}`)),
      ]),
    )

    await left.runPromise(InstanceRegistry.initializeInstance(context("/left")))
    await right.runPromise(InstanceRegistry.disposeInstance("/right"))

    expect(calls).toEqual(["left:init:/left", "right:dispose:/right"])
    await Promise.all([left.dispose(), right.dispose()])
  })

  test("runs every disposer and surfaces aggregate failure", async () => {
    const runtime = ManagedRuntime.make(InstanceRegistry.layer)
    const calls: string[] = []
    await runtime.runPromise(
      Effect.all([
        InstanceRegistry.registerDisposer(async () => {
          calls.push("failed")
          throw new Error("broken disposer")
        }),
        InstanceRegistry.registerDisposer(async () => void calls.push("completed")),
      ]),
    )

    await expect(runtime.runPromise(InstanceRegistry.disposeInstance("/fixture"))).rejects.toThrow(
      "Instance disposal failed",
    )
    expect(calls).toEqual(["failed", "completed"])
    await runtime.dispose()
  })
})
