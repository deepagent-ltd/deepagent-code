import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { gatewayConfig, reviewRunsDir } from "../../src/deepagent/config"

describe("DeepAgent Code config", () => {
  test("uses DEEPAGENT_CODE_HOME/runs by default and enables runtime by default", () => {
    const home = mkdtempSync(path.join(tmpdir(), "deepagent-code-config-"))
    const previous = process.env.DEEPAGENT_CODE_HOME
    const previousRuns = process.env.DEEPAGENT_RUNS_DIR
    try {
      process.env.DEEPAGENT_CODE_HOME = home
      delete process.env.DEEPAGENT_RUNS_DIR
      expect(gatewayConfig().runsDir).toBe(path.join(home, "runs"))
      expect(gatewayConfig().enabled).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.DEEPAGENT_CODE_HOME
      else process.env.DEEPAGENT_CODE_HOME = previous
      if (previousRuns === undefined) delete process.env.DEEPAGENT_RUNS_DIR
      else process.env.DEEPAGENT_RUNS_DIR = previousRuns
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("keeps explicit runsDir above environment defaults", () => {
    const home = mkdtempSync(path.join(tmpdir(), "deepagent-code-config-"))
    const previous = process.env.DEEPAGENT_CODE_HOME
    try {
      process.env.DEEPAGENT_CODE_HOME = home
      expect(gatewayConfig({ provider: { deepagent: { options: { runsDir: "/explicit/runs" } } } }).runsDir).toBe(
        "/explicit/runs",
      )
    } finally {
      if (previous === undefined) delete process.env.DEEPAGENT_CODE_HOME
      else process.env.DEEPAGENT_CODE_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("aligns review runs with the runtime store by default", () => {
    const home = mkdtempSync(path.join(tmpdir(), "deepagent-code-config-"))
    const previousHome = process.env.DEEPAGENT_CODE_HOME
    const previousRuns = process.env.DEEPAGENT_RUNS_DIR
    try {
      process.env.DEEPAGENT_CODE_HOME = home
      delete process.env.DEEPAGENT_RUNS_DIR
      expect(reviewRunsDir()).toBe(path.join(home, "runs"))
      expect(gatewayConfig().runsDir).toBe(path.join(home, "runs"))
    } finally {
      if (previousHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
      else process.env.DEEPAGENT_CODE_HOME = previousHome
      if (previousRuns === undefined) delete process.env.DEEPAGENT_RUNS_DIR
      else process.env.DEEPAGENT_RUNS_DIR = previousRuns
      rmSync(home, { recursive: true, force: true })
    }
  })
})
