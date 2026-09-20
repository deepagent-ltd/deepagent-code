import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@deepagent-code/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  SystemPrompt.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ),
  ),
)

describe("session.system", () => {
  // W1 gap repair: the workflow discipline section (understand → plan → execute → verify → deliver)
  // must reach every provider baseline EXCEPT anthropic (which carries its own strong plan section —
  // appending it again would double-bill the same discipline).
  describe("workflow discipline distribution", () => {
    const model = (id: string) =>
      ({ api: { id }, providerID: "test" }) as unknown as Parameters<typeof SystemPrompt.provider>[0]

    test("appends the discipline section to the unlisted-provider fallback (GLM et al.)", () => {
      const sections = SystemPrompt.provider(model("glm-5.3-flash"))
      expect(sections).toHaveLength(2)
      expect(sections[1]).toContain("Task Workflow Discipline")
      expect(sections[1]).toContain("plan")
    })

    test("appends the discipline section to every listed non-anthropic provider", () => {
      for (const id of ["gpt-5", "gpt-4.1", "o3-mini", "gpt-5-codex", "gemini-3-pro", "trinity-2", "kimi-k3"]) {
        const sections = SystemPrompt.provider(model(id))
        expect(sections.some((s) => s.includes("Task Workflow Discipline"))).toBeTrue()
      }
    })

    test("keeps anthropic on its own plan discipline without the shared section", () => {
      const sections = SystemPrompt.provider(model("claude-opus-4"))
      expect(sections).toHaveLength(1)
      expect(sections[0]).toContain("plan")
      expect(sections[0]).not.toContain("Task Workflow Discipline")
    })
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )
})
