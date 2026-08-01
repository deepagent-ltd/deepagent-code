import { describe, expect, test } from "bun:test"
import { resolveDeepAgentCodeHome } from "../../src/deepagent/workspace"

// P0-0 guard: the DeepAgent storage root must be a SINGLE source of truth. resolveDeepAgentCodeHome
// (used by the control plane) must compute the identical root as core's Global.Path resolution for
// every env combination. Production is fixed to ~/.deepagent/code; tests may use an isolated home
// and may choose an exact data root only inside that explicit test boundary.
describe("P0-0 storage root single source", () => {
  const homedir = require("node:os").homedir() as string
  const path = require("node:path") as typeof import("node:path")

  test("DEEPAGENT_CODE_HOME is ignored outside an explicit test boundary", () => {
    expect(resolveDeepAgentCodeHome({ DEEPAGENT_CODE_HOME: "/explicit/home" })).toBe(
      path.resolve(homedir, ".deepagent", "code"),
    )
  })

  test("DEEPAGENT_CODE_HOME may choose the exact root inside a test boundary", () => {
    expect(
      resolveDeepAgentCodeHome({ DEEPAGENT_CODE_HOME: "/explicit/home", DEEPAGENT_CODE_TEST_HOME: "/test/home" }),
    ).toBe(path.resolve("/explicit/home"))
  })

  test("DEEPAGENT_CODE_TEST_HOME is honored when CODE_HOME absent (the P0-0 fix)", () => {
    expect(resolveDeepAgentCodeHome({ DEEPAGENT_CODE_TEST_HOME: "/test/home" })).toBe(
      path.resolve("/test/home", ".deepagent", "code"),
    )
  })

  test("falls back to real homedir only when neither env is set", () => {
    expect(resolveDeepAgentCodeHome({})).toBe(path.resolve(homedir, ".deepagent", "code"))
  })
})
