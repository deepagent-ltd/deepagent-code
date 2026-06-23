import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { cleanupRunsDir, runDeepAgentStream, tempRunsDir } from "./_gateway"

describe("DeepAgent hidden contamination guard", () => {
  test("does not place hidden evaluator feedback into model-visible artifacts", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(dir)
      for (const file of ["MODEL_WORK_PACKAGE.json", "RUN_CONTEXT.md", "MODEL_ROUTER_AUDIT.json"]) {
        const contents = await readFile(path.join(runDir, file), "utf8")
        expect(contents).not.toContain("official_hidden")
        expect(contents).not.toContain("retired_hidden_feedback")
      }
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})

