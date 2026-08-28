import { afterEach, describe, expect } from "bun:test"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Effect, Layer, Ref, Exit, Cause } from "effect"
import { Git } from "../../src/git"
import { Worktree } from "../../src/worktree"
import { RuntimeBase } from "../../src/runtime/base"
import { InstanceState } from "../../src/effect/instance-state"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// R0 (S1-v3.5): the runtime common base shared by DAP + PAP. Covers the four
// acceptance criteria: approve-once-per-session, fail-closed privilege gate,
// worktree isolation, and the output budget → artifact summary.

const baseLayer = (probe?: RuntimeBase.PrivilegeProbe) =>
  Layer.mergeAll(
    RuntimeBase.testLayer(probe).pipe(Layer.provide(Worktree.defaultLayer)),
    Worktree.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Git.defaultLayer,
  )

describe("R0 runtime base", () => {
  afterEach(() => disposeAllInstances())

  describe("execution approval (once per session)", () => {
    const it = testEffect(baseLayer(RuntimeBase.allowAllProbe))
    it.instance(
      "asks once on first op, reuses the grant for in-session sub-ops",
      () =>
        Effect.gen(function* () {
          const base = yield* RuntimeBase.Service
          const calls = yield* Ref.make(0)
          const ask = () => Ref.update(calls, (n) => n + 1)
          const gate = () => base.gate({ sessionKey: "sess-1", privileges: [], requestApproval: ask })
          yield* gate() // start → asks
          yield* gate() // step → reuses
          yield* gate() // continue → reuses
          expect(yield* Ref.get(calls)).toBe(1)
          // A different session asks again.
          yield* base.gate({ sessionKey: "sess-2", privileges: [], requestApproval: ask })
          expect(yield* Ref.get(calls)).toBe(2)
        }),
      { git: true },
    )
  })

  describe("privilege gate (fail-closed)", () => {
    const it = testEffect(baseLayer(RuntimeBase.denyAllProbe))
    it.instance(
      "fails closed when a required privilege is unavailable; never approves",
      () =>
        Effect.gen(function* () {
          const base = yield* RuntimeBase.Service
          const calls = yield* Ref.make(0)
          const exit = yield* base
            .gate({
              sessionKey: "sess-priv",
              privileges: [{ kind: "gpu_performance_counter", reason: "ncu needs GPU counters" }],
              requestApproval: () => Ref.update(calls, (n) => n + 1),
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(err).toBeInstanceOf(RuntimeBase.UnsatisfiedPrivilegeError)
            if (err instanceof RuntimeBase.UnsatisfiedPrivilegeError) {
              expect(err.checks.some((c) => !c.satisfied)).toBe(true)
            }
          }
          // fail-closed means we did NOT prompt for approval on an unrunnable op.
          expect(yield* Ref.get(calls)).toBe(0)
        }),
      { git: true },
    )
  })

  describe("worktree isolation", () => {
    const it = testEffect(baseLayer(RuntimeBase.allowAllProbe))
    it.instance(
      "runs the body in a worktree dir distinct from the main dir, then cleans up",
      () =>
        Effect.gen(function* () {
          const base = yield* RuntimeBase.Service
          const instance = yield* InstanceState.context
          const workdir = yield* base.withIsolation({ name: "r0-iso" }, (dir) => Effect.succeed(dir))
          expect(workdir).not.toBe(instance.directory)
          expect(workdir).toContain("r0-iso")
          // After completion the clean worktree is removed.
          const wt = yield* Worktree.Service
          const list = yield* wt.list()
          expect(list.some((w) => w.directory === workdir)).toBe(false)
        }),
      { git: true },
    )
  })

  describe("output budget → artifact", () => {
    const it = testEffect(baseLayer(RuntimeBase.allowAllProbe))
    it.instance(
      "keeps a small output inline; truncates a large one and flags it",
      () =>
        Effect.gen(function* () {
          const small = RuntimeBase.applyOutputBudget("hello", { timeoutMs: 1000, maxInlineBytes: 100 })
          expect(small.truncated).toBe(false)
          expect(small.inline).toBe("hello")

          const big = "x".repeat(500)
          const out = RuntimeBase.applyOutputBudget(big, { timeoutMs: 1000, maxInlineBytes: 100 })
          expect(out.truncated).toBe(true)
          expect(out.fullBytes).toBe(500)
          expect(out.inline).toContain("truncated")
          expect(out.inline.length).toBeLessThan(big.length)
        }),
      { git: true },
    )
  })
})
