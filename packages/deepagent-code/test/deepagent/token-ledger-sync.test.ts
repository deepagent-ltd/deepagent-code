import { describe, expect, test } from "bun:test"
import { cleanupRunsDir, readJson, runDeepAgentStream, tempRunsDir } from "./_gateway"

describe("DeepAgent token ledger sync", () => {
  test("copies provider usage into ledger and monitor totals", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(dir)
      expect(await readJson(runDir, "token_usage_ledger.json")).toMatchObject({
        input_tokens: 11,
        output_tokens: 7,
        reasoning_tokens: 2,
      })
      expect(await readJson(runDir, "run_monitor_snapshot.json")).toMatchObject({
        token_totals: {
          input_tokens: 11,
          output_tokens: 7,
          reasoning_tokens: 2,
        },
      })
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})
