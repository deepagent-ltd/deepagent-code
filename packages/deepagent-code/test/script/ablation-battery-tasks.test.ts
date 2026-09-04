// Tier A battery task-library invariants: seed determinism, template regeneration (anti-overfit),
// and the mechanism → env-key map against the ablation-plan §2.2 table. These pin the battery's
// building blocks without calling a model — the live pairing runs via run-eval-battery.ts.
import { describe, expect, test } from "bun:test"
import { buildBatteryTasks, mechanismEnvKeys, taskFamilies } from "../../script/ablation/battery-tasks"

describe("ablation battery tasks", () => {
  test("every family regenerates deterministically per seed", () => {
    for (const [family, build] of Object.entries(taskFamilies)) {
      const a = build(7)
      const b = build(7)
      expect(a.prompt).toBe(b.prompt)
      expect(a.files).toEqual(b.files)
      expect(a.family).toBe(family)
      expect(a.verifier?.script).toBe(b.verifier?.script)
    }
  })

  test("different seeds change the template (anti-overfit regeneration)", () => {
    for (const build of Object.values(taskFamilies)) {
      const a = build(1)
      const b = build(2)
      expect(a.prompt).not.toBe(b.prompt)
    }
  })

  test("task ids are unique across families and seeds", () => {
    const tasks = buildBatteryTasks({ seeds: [1, 2, 3] })
    const ids = tasks.map((task) => task.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("mechanism env keys match the ablation-plan §2.2 switch table", () => {
    expect(mechanismEnvKeys.federation).toEqual({ key: "DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION", offValue: "false" })
    expect(mechanismEnvKeys.learning).toEqual({ key: "DEEPAGENT_DURABLE_LEARNING", offValue: "false" })
    expect(mechanismEnvKeys.plangate).toEqual({ key: "DEEPAGENT_CODE_STRICT_PLAN_GATE", offValue: "false" })
    expect(mechanismEnvKeys.autocompact).toEqual({ key: "DEEPAGENT_CODE_DISABLE_AUTOCOMPACT", offValue: "true" })
    expect(mechanismEnvKeys["event-admission"]).toEqual({ key: "DEEPAGENT_CODE_EVENT_V2_ADMISSION", offValue: "false" })
    expect(mechanismEnvKeys["im-single-write"]).toEqual({ key: "DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE", offValue: "false" })
    expect(mechanismEnvKeys["v2-owner"]).toEqual({ key: "DEEPAGENT_CODE_CORE_V2_EXECUTION_OWNER", offValue: "false" })
  })

  test("calibration arms carry no mechanism switch", () => {
    const honesty = taskFamilies["F1-honesty"](1)
    const doom = taskFamilies["F5-no-progress"](1)
    expect(honesty.mechanism).toBe("none")
    expect(doom.mechanism).toBe("none")
  })

  test("honesty task's verifier demands NOT_FOUND (reward-hacking sentinel)", () => {
    const task = taskFamilies["F1-honesty"](3)
    expect(task.prompt).toContain("NOT_FOUND")
    expect(task.verifier?.script).toContain("NOT_FOUND")
  })

  test("federation task hides the target behind a re-export chain", () => {
    const task = taskFamilies["F2-federation"](5)
    const files = Object.keys(task.files)
    expect(files.some((file) => file.startsWith("src/") && file.endsWith(".ts"))).toBe(true)
    expect(files).toContain("src/config/constants.ts")
    // the prompt must NOT leak the base value it asks the model to find
    const baseValue = task.files["src/config/constants.ts"].match(/BASE_THRESHOLD = (\d+)/)?.[1]
    expect(baseValue).toBeDefined()
    expect(new RegExp(`\\b${baseValue}\\b`).test(task.prompt)).toBe(false)
  })
})
