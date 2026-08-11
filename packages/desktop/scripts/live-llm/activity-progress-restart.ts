import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  close,
  closeAll,
  createSession,
  hardKill,
  launch,
  loadLiveConfig,
  messages,
  preflight,
  startPrompt,
  waitFor,
  writeArtifact,
  type Runtime,
} from "./runtime.ts"

const suite = "activity-progress-restart"
const config = await loadLiveConfig()
if (config.modelID !== "deepseek-v4-flash") {
  throw new Error("Activity progress restart test requires DeepSeek deepseek-v4-flash")
}
const preflightResult = await preflight(config)
const startedAt = Date.now()
const results: RestartResult[] = []

const cases = [
  {
    name: "streaming-recovery-required",
    point: "after_provider_streaming",
    prompt: (marker: string) => `Reply with exactly ${marker}. Do not call any tool.`,
    expectedBefore: { activity: "active", progress: "provisional", receipt: "streaming" },
    expectedAfter: { activity: "recovery_required", progress: "recovery_required" },
  },
  {
    name: "terminal-receipt-final-reconciliation",
    point: "after_provider_receipt_terminal",
    prompt: (marker: string) => `Reply with exactly ${marker}. Do not call any tool.`,
    expectedBefore: { activity: "active", progress: "provisional", receipt: "settled" },
    expectedAfter: { activity: "settled", progress: "final" },
  },
  {
    name: "settled-tool-progress-recovery-required",
    point: "after_progress_settled",
    prompt: (_marker: string) =>
      "Read restart-fact.txt exactly once. After the tool result, return the exact file content and do not call any other tool.",
    file: "restart-fact.txt",
    expectedBefore: { activity: "active", progress: "progress", receipt: "settled" },
    expectedAfter: { activity: "recovery_required", progress: "progress" },
  },
] as const

try {
  for (const testCase of cases) {
    console.log(`${suite}: starting ${testCase.name}`)
    const root = await mkdtemp(path.join(os.tmpdir(), `deepagent-code-${suite}-${testCase.name}-`))
    const markerFile = path.join(root, "crash-marker.json")
    const marker = `restart-${randomUUID()}`
    let initial: Runtime | undefined
    let restarted: Runtime | undefined
    try {
      initial = await launch(suite, config, {
        root,
        cleanupRoot: false,
        environment: {
          DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_POINT: testCase.point,
          DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_MARKER: markerFile,
        },
      })
      if ("file" in testCase) await writeFile(path.join(initial.workspace, testCase.file), `${marker}\n`)
      const session = await createSession(initial, `DeepSeek restart ${testCase.name}`, "live-ui")
      const promptRequest = startPrompt(initial, session.id, testCase.prompt(marker), "live-ui").then(
        () => ({ state: "acknowledged" as const }),
        (error) => ({ state: "disconnected" as const, error: error instanceof Error ? error.message : String(error) }),
      )
      const crash = await waitFor(
        async () => {
          const value = await readFile(markerFile, "utf8").catch(() => undefined)
          if (value) return JSON.parse(value) as { point: string; pid: number; reachedAt: number }
        },
        `${testCase.name} crash point`,
        config.timeoutMs,
      )
      console.log(`${suite}: reached ${testCase.point} in sidecar ${crash.pid}`)
      assert.equal(crash.point, testCase.point)
      const before = inspect(path.join(root, "deepagent.sqlite"), session.id)
      console.log(`${suite}: captured durable pre-kill state for ${session.id}`)
      assert.equal(before.activity?.state, testCase.expectedBefore.activity)
      assert.equal(before.progress.at(-1)?.state, testCase.expectedBefore.progress)
      assert.equal(before.receipts.at(-1)?.provider_state, testCase.expectedBefore.receipt)
      const initialAppPID = initial.app.process().pid
      console.log(`${suite}: sending SIGKILL to Electron ${initialAppPID}`)
      await hardKill(initial)
      initial = undefined
      const promptOutcome = await Promise.race([
        promptRequest,
        new Promise<{ state: "timed_out" }>((resolve) => setTimeout(() => resolve({ state: "timed_out" }), 10_000)),
      ])
      assert.notEqual(promptOutcome.state, "timed_out")

      console.log(`${suite}: restarting from ${root}`)
      restarted = await launch(suite, config, { root, cleanupRoot: false })
      const restartedAppPID = restarted.app.process().pid
      assert.notEqual(restartedAppPID, initialAppPID)
      const after = await waitFor(
        async () => {
          const value = inspect(path.join(root, "deepagent.sqlite"), session.id)
          if (
            value.activity?.state === testCase.expectedAfter.activity &&
            value.progress.at(-1)?.state === testCase.expectedAfter.progress
          )
            return value
        },
        `${testCase.name} restart reconciliation`,
        30_000,
      )
      console.log(`${suite}: reconciled ${testCase.name} in Electron ${restartedAppPID}`)
      assert.equal(after.receipts.length, before.receipts.length)
      assert.equal(after.messageCount, before.messageCount)
      assert.equal(after.toolPartCount, before.toolPartCount)
      assert.equal(after.userMessageCount, 1)
      if (testCase.point === "after_provider_receipt_terminal") {
        assert.equal(
          (await messages(restarted, session.id)).some((message) =>
            message.parts.some((part) => part.type === "text" && part.text.includes(marker)),
          ),
          true,
        )
      }
      results.push({
        name: testCase.name,
        point: testCase.point,
        sessionID: session.id,
        crash,
        initialAppPID,
        restartedAppPID,
        promptOutcome,
        before,
        after,
      })
    } finally {
      if (initial) await close(initial).catch(() => undefined)
      if (restarted) await close(restarted).catch(() => undefined)
      if (process.env.DEEPAGENT_CODE_KEEP_LIVE_SMOKE !== "1") await rm(root, { recursive: true, force: true })
    }
  }

  await writeArtifact(suite, {
    suite,
    mode: "live",
    stack: "desktop-sidecar-process-restart",
    status: "passed",
    fingerprint: {
      providerID: "deepseek",
      runtimeProviderID: "live-deepseek",
      modelID: config.modelID,
      modelRevision: config.modelRevision,
      baseURL: config.baseURL,
    },
    preflight: preflightResult,
    evidence: results,
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  })
  console.log(`${suite}: passed (deepseek/${config.modelID}, ${results.length} SIGKILL boundaries)`)
} finally {
  await closeAll()
}

type Snapshot = ReturnType<typeof inspect>
type RestartResult = {
  name: string
  point: string
  sessionID: string
  crash: { point: string; pid: number; reachedAt: number }
  initialAppPID?: number
  restartedAppPID?: number
  promptOutcome: { state: "acknowledged" } | { state: "disconnected"; error: string }
  before: Snapshot
  after: Snapshot
}

function inspect(databasePath: string, sessionID: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    database.exec("PRAGMA busy_timeout = 5000")
    const activity = database
      .prepare(
        "SELECT activity_id, owner_token, state, terminal_reason FROM session_legacy_activity WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1",
      )
      .get(sessionID) as
      | { activity_id: string; owner_token: string; state: string; terminal_reason: string | null }
      | undefined
    const progress = database
      .prepare(
        "SELECT revision, assistant_message_id, provider_receipt_id, state, finish_observed FROM session_activity_progress WHERE activity_id = ? ORDER BY revision",
      )
      .all(activity?.activity_id ?? "") as Array<{
      revision: number
      assistant_message_id: string
      provider_receipt_id: string
      state: string
      finish_observed: string | null
    }>
    const receipts = database
      .prepare(
        "SELECT receipt_id, assistant_message_id, provider_state, request_state, call_ids FROM session_tool_request_receipt WHERE session_id = ? ORDER BY request_ordinal",
      )
      .all(sessionID) as Array<{
      receipt_id: string
      assistant_message_id: string
      provider_state: string
      request_state: string
      call_ids: string
    }>
    const counts = database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM message WHERE session_id = ?) AS message_count,
          (SELECT COUNT(*) FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user') AS user_message_count,
          (SELECT COUNT(*) FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool') AS tool_part_count`,
      )
      .get(sessionID, sessionID, sessionID) as {
      message_count: number
      user_message_count: number
      tool_part_count: number
    }
    return {
      activity,
      progress,
      receipts: receipts.map((receipt) => ({ ...receipt, call_ids: JSON.parse(receipt.call_ids) as string[] })),
      messageCount: counts.message_count,
      userMessageCount: counts.user_message_count,
      toolPartCount: counts.tool_part_count,
    }
  } finally {
    database.close()
  }
}
