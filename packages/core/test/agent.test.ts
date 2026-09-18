import { describe, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Location } from "@deepagent-code/core/location"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { AgentPlugin } from "@deepagent-code/core/plugin/agent"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(AgentV2.locationLayer)

describe("AgentV2", () => {
  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service

      expect(yield* agent.all()).toEqual([])
      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      const transform = yield* agent.transform()

      yield* transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.all()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      const transform = yield* agent.transform()

      yield* transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Old description"
          info.hidden = true
        }),
      )
      yield* transform((editor) =>
        editor.update(id, (info) => {
          info.description = "New description"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("scoped")
      const scope = yield* Scope.make()
      const transform = yield* agent.transform().pipe(Scope.provide(scope))

      yield* transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("build")

      yield* agent.update((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("custom")

      yield* agent.update((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(AgentV2.Info.empty(id))

      yield* agent.update((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("does not ambiently opt built-in agents into bash", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const agents = yield* agent.all()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "auto",
        "compaction",
        "design",
        "explore",
        "general",
        "goal-worker",
        "loop",
        "plan",
        "researcher",
        "reviewer",
        "senior-reviewer",
        "summary",
        "title",
      ])
      // goal-worker is the sanctioned exception: the Goal Loop worker (V3.9 §D) carries out plan
      // steps, which requires a working ruleset — bash runs the step's validation commands.
      // senior-reviewer (RI-26 port) may apply ordinary file fixes but still gets bash only via the
      // wildcard default, never a literal bash grant.
      for (const item of agents.filter((item) => item.id !== AgentV2.ID.make("goal-worker"))) {
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
      }

      const researcher = yield* agent.get(AgentV2.ID.make("researcher"))
      expect(researcher).toBeDefined()
      expect(PermissionV2.evaluate("read", "fixtures/cp01.txt", researcher?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("grep", "marker", researcher?.permissions ?? []).effect).toBe("allow")
      for (const action of ["bash", "write", "edit", "task", "question"]) {
        expect(PermissionV2.evaluate(action, "*", researcher?.permissions ?? []).effect).toBe("deny")
      }

      const goalWorker = yield* agent.get(AgentV2.ID.make("goal-worker"))
      expect(goalWorker).toBeDefined()
      expect(goalWorker?.hidden).toBe(true)
      expect(goalWorker?.mode).toBe("subagent")
      for (const action of ["read", "grep", "edit", "write", "bash", "plan"]) {
        expect(PermissionV2.evaluate(action, "*", goalWorker?.permissions ?? []).effect).toBe("allow")
      }
      expect(PermissionV2.evaluate("task", "*", goalWorker?.permissions ?? []).effect).toBe("deny")

      const build = yield* agent.get(AgentV2.defaultID)
      expect(build?.system).toContain("maps each requirement to concrete code or validation evidence")
      expect(build?.system).toContain("plan status alone is not proof")
      expect(build?.system).toContain("reserve the remaining work for validation")
    }),
  )

  it.effect("resolves the legacy build selection to auto without registering a duplicate agent", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* agent.update((editor) =>
        editor.update(AgentV2.defaultID, (item) => {
          item.mode = "primary"
          item.system = "Auto instructions"
        }),
      )

      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
      expect(yield* agent.resolve("build")).toMatchObject({ id: AgentV2.defaultID, system: "Auto instructions" })
      expect(yield* agent.select("build")).toMatchObject({ id: AgentV2.defaultID, info: { id: AgentV2.defaultID } })
    }),
  )
})
