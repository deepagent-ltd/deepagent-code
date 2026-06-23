import { describe, expect, test } from "bun:test"
import { resolveDeepAgentCodeHome } from "../../src/deepagent/workspace"

// P0-0 guard: the DeepAgent storage root must be a SINGLE source of truth. resolveDeepAgentCodeHome
// (used by the control plane) must compute the identical root as core's Global.Path resolution for
// every env combination — DEEPAGENT_CODE_HOME wins, else <DEEPAGENT_CODE_TEST_HOME ?? homedir>/
// .deepagent/code. Previously this resolver ignored TEST_HOME while Global honored it, so tests
// wrote durable data into the real user home. These cases lock the contract.
describe("P0-0 storage root single source", () => {
  const homedir = require("node:os").homedir() as string
  const path = require("node:path") as typeof import("node:path")

  test("DEEPAGENT_CODE_HOME takes precedence over everything", () => {
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
