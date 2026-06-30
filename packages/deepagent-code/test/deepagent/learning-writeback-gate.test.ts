import { describe, expect, test } from "bun:test"
import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { cleanupRunsDir, readJson, runDeepAgentStream, tempRunsDir } from "./_gateway"

// Recursively collect file paths under a dir (best-effort; missing dir => []).
const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

describe("DeepAgent learning writeback gate", () => {
  test("stages candidates and requires review before active promotion", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(dir)
      expect(await readJson(runDir, "LEARNING_WRITEBACK_MANIFEST.json")).toMatchObject({
        promotion_decision: "staged",
        target_scope: "run_local",
        strategy_candidates: [{ status: "staged", source_ref: "MODEL_WORK_PACKAGE.json" }],
        policy_checks: [
          { check_id: "no_hidden_lineage", status: "pass" },
          { check_id: "review_required_before_active_promotion", status: "needs_review" },
        ],
      })
    } finally {
      await cleanupRunsDir(dir)
    }
  })

  test("runs background learning from managed stream session finalization", async () => {
    const dir = await tempRunsDir()
    const home = await tempRunsDir()
    const previousHome = process.env.DEEPAGENT_CODE_HOME
    try {
      process.env.DEEPAGENT_CODE_HOME = home
      await runDeepAgentStream(dir)
      // docs/34 §8: learning writes to the SINGLE durable DocumentStore body under
      // <home>/project/<pid>/knowledge. Scan the project tree for the staged memory doc.
      const files = await walk(path.join(home, "project"))
      const knowledgeDocs = files.filter((f) => f.includes(`${path.sep}knowledge${path.sep}`) && f.endsWith(".json"))
      const contents = await Promise.all(knowledgeDocs.map((f) => readFile(f, "utf8").catch(() => "")))
      expect(contents.some((c) => c.includes("first-pass-success") || c.includes("first round"))).toBe(true)
    } finally {
      if (previousHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
      else process.env.DEEPAGENT_CODE_HOME = previousHome
      await cleanupRunsDir(dir)
      await rm(home, { recursive: true, force: true })
    }
  })
})
