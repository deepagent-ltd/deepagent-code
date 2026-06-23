import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildProfile } from "../../src/deepagent/profile-detector"

const withWorkspace = (fn: (cwd: string) => void) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "deepagent-profile-detector-"))
  try {
    fn(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe("DeepAgent profile detector", () => {
  test("marks read-only query requests for deterministic query pack activation", () => {
    withWorkspace((cwd) => {
      const profile = buildProfile({
        cwd,
        agentMode: "max",
        scenarioMode: "direct",
        userRequest: "请查一下当前日志里有多少个 ERROR",
      })

      expect(profile.code_domains).toContain("query")
      expect(profile.code_domains).toContain("deterministic")
      expect(profile.code_domains).toContain("read_only")
    })
  })

  test("does not mark mutation requests as read-only query work", () => {
    withWorkspace((cwd) => {
      const profile = buildProfile({
        cwd,
        agentMode: "max",
        scenarioMode: "direct",
        userRequest: "请更新数据库并删除旧记录",
      })

      expect(profile.code_domains).not.toContain("query")
      expect(profile.code_domains).not.toContain("read_only")
    })
  })
})
