import { afterEach, describe, expect } from "bun:test"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Git } from "../../src/git"
import { Worktree } from "../../src/worktree"
import { RuntimeBase } from "../../src/runtime/base"
import { InstanceState } from "../../src/effect/instance-state"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// RX (S1-v3.5): verifies that R0's withIsolation creates an isolated worktree
// for BOTH debug and profile scenarios, then cleans up after the body completes.
// This test mirrors the isolation scenario in runtime-base.test.ts but confirms
// that the same mechanism works correctly when called from debug/profile paths.

const baseLayer = (probe?: RuntimeBase.PrivilegeProbe) =>
  Layer.mergeAll(
    RuntimeBase.testLayer(probe).pipe(Layer.provide(Worktree.defaultLayer)),
    Worktree.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Git.defaultLayer,
  )

describe("RX runtime worktree coplay", () => {
  afterEach(() => disposeAllInstances())

  const it = testEffect(baseLayer(RuntimeBase.allowAllProbe))

  describe("debug scenario: isolation for a debug session", () => {
    it.instance(
      "withIsolation returns a directory different from the main instance directory",
      () =>
        Effect.gen(function* () {
          const base = yield* RuntimeBase.Service
          const ctx = yield* InstanceState.context

          const workdir = yield* base.withIsolation({ name: "rx-debug-session" }, (dir) =>
            Effect.succeed(dir),
          )

          // The isolated dir is distinct from the main project dir
          expect(workdir).not.toBe(ctx.directory)
          // The worktree name appears in the path (R0 appends it via Worktree.create)
          expect(workdir).toContain("rx-debug-session")
        }),
      { git: true },
    )

    it.instance(
      "worktree is removed after the body completes (no orphaned worktrees)",
      () =>
        Effect.gen(function* () {
          const base = yield* RuntimeBase.Service
          const wt = yield* Worktree.Service

          const workdir = yield* base.withIsolation({ name: "rx-debug-cleanup" }, (dir) =>
            Effect.succeed(dir),
          )

          // After completion the clean worktree should be gone
          const list = yield* wt.list()
          const still_present = list.some((w) => w.directory === workdir)
          expect(still_present).toBe(false)
        }),
      { git: true },
    )

    it.instance(
      "body result is forwarded — isolation is transparent",
      () =>
        Effect.gen(function* () {
          const base = yield* RuntimeBase.Service

          const result = yield* base.withIsolation({ name: "rx-debug-body-result" }, (_dir) =>
            Effect.succeed({ session_id: "s-42", frames: 7 }),
          )

          expect(result.session_id).toBe("s-42")
          expect(result.frames).toBe(7)
        }),
      { git: true },
    )
  })

  describe("profile scenario: isolation for a profiling run", () => {
    it.instance(
      "withIsolation returns a directory distinct from main dir for profile scenario",
      () =>
        Effect.gen(function* () {
          const base = yield* RuntimeBase.Service
          const ctx = yield* InstanceState.context

          const workdir = yield* base.withIsolation({ name: "rx-profile-run" }, (dir) =>
            Effect.succeed(dir),
          )

          expect(workdir).not.toBe(ctx.directory)
          expect(workdir).toContain("rx-profile-run")
        }),
      { git: true },
    )

    it.instance(
      "two parallel isolation calls produce two distinct worktrees",
      () =>
        Effect.gen(function* () {
          const base = yield* RuntimeBase.Service

          // Simulate two concurrent profile/debug operations each getting their own tree
          const [dirA, dirB] = yield* Effect.all(
            [
              base.withIsolation({ name: "rx-parallel-a" }, (dir) => Effect.succeed(dir)),
              base.withIsolation({ name: "rx-parallel-b" }, (dir) => Effect.succeed(dir)),
            ],
            { concurrency: 2 },
          )

          expect(dirA).not.toBe(dirB)
          expect(dirA).toContain("rx-parallel-a")
          expect(dirB).toContain("rx-parallel-b")
        }),
      { git: true },
    )

    it.instance(
      "isolation cleans up even when the body produces a value (not just void)",
      () =>
        Effect.gen(function* () {
          const base = yield* RuntimeBase.Service
          const wt = yield* Worktree.Service

          const artifactPath = yield* base.withIsolation({ name: "rx-profile-artifact" }, (dir) =>
            // Simulates what a real profile run would do: return an artifact path
            Effect.succeed(`${dir}/PROFILE_RESULT.json`),
          )

          expect(artifactPath).toContain("PROFILE_RESULT.json")

          // The worktree has been cleaned up
          const list = yield* wt.list()
          const wtDir = artifactPath.replace("/PROFILE_RESULT.json", "")
          expect(list.some((w) => w.directory === wtDir)).toBe(false)
        }),
      { git: true },
    )
  })
})
