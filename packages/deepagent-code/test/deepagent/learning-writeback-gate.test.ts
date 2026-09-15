import { describe, expect, test } from "bun:test"
import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { cleanupRunsDir, deepagentRunInput, readJson, runDeepAgentStream, tempRunsDir } from "./_gateway"

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

  // The memory candidate is policy-gated on "completed in exactly one round" (Learning.extract), and
  // the writeback itself runs on the LEGACY queue — which `runBackgroundLearning` skips entirely when
  // durable learning is on, and durable learning DEFAULTS TO ON. Both facts have to be set up honestly
  // for this test to observe anything: without them the job never reaches the queue `flushLearning`
  // drains, and the assertion could only ever be satisfied by knowledge documents that other runs had
  // left in the storage root it was accidentally reading.
  test("runs background learning from managed stream session finalization", async () => {
    const dir = await tempRunsDir()
    const home = await tempRunsDir()
    // TWO environment variables, and both are load-bearing: `resolveDataPath` (global-path.ts)
    // honours an exact data-root override ONLY alongside the explicit test-home boundary, so setting
    // DEEPAGENT_CODE_HOME alone leaves storage at the real ~/.deepagent/code. The same mistake in
    // `settings/store.test.ts` ("so we never touch the real ~/.deepagent/code") really did touch it.
    const previousHome = process.env.DEEPAGENT_CODE_HOME
    const previousTestHome = process.env.DEEPAGENT_CODE_TEST_HOME
    try {
      process.env.DEEPAGENT_CODE_TEST_HOME = home
      process.env.DEEPAGENT_CODE_HOME = home
      // The legacy writeback queue is SKIPPED for a durable run, and durable learning defaults to ON
      // with `configure` merging (`config.durableLearning ?? current.durableLearning`) rather than
      // re-reading the environment — so this has to be an explicit config value, not an env flag.
      await runDeepAgentStream(dir, undefined, "high", undefined, { durableLearning: false })

      // Drive the REAL round transition rather than fabricating a document: the extractor reads this
      // exact fact, so the precondition is the mechanism's own input.
      const sessionID = deepagentRunInput.sessionID
      const sessions = AgentGateway.DeepAgentSessionState
      sessions.getOrCreate(sessionID, "high")
      // The memory candidate is gated on "completed in exactly one round". The managed stream usually
      // advances the counter itself on completion; when it does not, the extractor has nothing to
      // stage, so step it once here. Either way this assertion is the precondition made explicit —
      // the previous version of this test never established it and could only pass on stray data.
      if ((sessions.get(sessionID)?.roundState.round ?? 0) === 0) sessions.advanceToNextRound(sessionID, "complete")
      expect(sessions.get(sessionID)?.roundState.round).toBe(1)
      await AgentGateway.flushLearning()

      // docs/34 §8: learning writes to the SINGLE durable DocumentStore body under
      // <home>/project/<pid>/knowledge.
      const files = await walk(path.join(home, "project"))
      const knowledgeDocs = files.filter((f) => f.includes(`${path.sep}knowledge${path.sep}`) && f.endsWith(".json"))
      expect(knowledgeDocs.length).toBeGreaterThan(0)
      const contents = await Promise.all(knowledgeDocs.map((f) => readFile(f, "utf8").catch(() => "")))
      // The candidate the mechanism is contracted to stage for a one-round success.
      expect(contents.some((c) => c.includes("first-pass-success"))).toBe(true)
    } finally {
      if (previousHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
      else process.env.DEEPAGENT_CODE_HOME = previousHome
      if (previousTestHome === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
      else process.env.DEEPAGENT_CODE_TEST_HOME = previousTestHome
      await cleanupRunsDir(dir)
      await rm(home, { recursive: true, force: true })
    }
  })
})
