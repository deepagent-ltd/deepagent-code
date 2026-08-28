import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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
  request,
  waitFor,
  waitForPrompt,
  writeArtifact,
  type Runtime,
  type Status,
} from "./runtime.ts"

const suite = "activity-progress-restart"
const config = await loadLiveConfig()
if (config.modelID !== "deepseek-v4-flash") {
  throw new Error("Activity progress restart test requires DeepSeek deepseek-v4-flash")
}
const preflightResult = await preflight(config)
const startedAt = Date.now()
const results: RestartResult[] = []

const cases: readonly RestartCase[] = [
  {
    name: "coordinator-reservation-exact-retry",
    point: "after_coordinator_reserve",
    before: {
      dispatches: 0,
      activity: undefined,
      run: undefined,
      receipt: undefined,
      progress: undefined,
      terminals: 0,
    },
    after: {
      dispatches: 0,
      activity: undefined,
      run: undefined,
      receipt: undefined,
      progress: undefined,
      terminals: 0,
    },
    promptOutcome: "disconnected",
    exactRetry: true,
    nextAdmission: "accepted",
  },
  {
    name: "bound-run-pre-dispatch-recovery",
    point: "after_admit_and_bind",
    before: {
      dispatches: 0,
      activity: "active",
      run: "running",
      receipt: undefined,
      progress: undefined,
      terminals: 0,
    },
    after: { dispatches: 0, activity: "failed", run: "failed", receipt: undefined, progress: undefined, terminals: 1 },
    promptOutcome: "disconnected",
    nextAdmission: "accepted",
  },
  {
    name: "prepared-provider-never-dispatched",
    point: "after_provider_prepared",
    before: {
      dispatches: 0,
      activity: "active",
      run: "running",
      receipt: "prepared",
      progress: "provisional",
      terminals: 0,
    },
    after: {
      dispatches: 0,
      activity: "failed",
      run: "failed",
      receipt: "failed",
      progress: "recovery_required",
      terminals: 1,
    },
    promptOutcome: "acknowledged",
    nextAdmission: "accepted",
  },
  {
    name: "streaming-outcome-indeterminate",
    point: "after_provider_streaming",
    before: {
      dispatches: 1,
      activity: "active",
      run: "running",
      receipt: "streaming",
      progress: "provisional",
      terminals: 0,
    },
    after: {
      dispatches: 1,
      activity: "recovery_required",
      run: "recovery_required",
      receipt: "indeterminate_after_crash",
      progress: "recovery_required",
      terminals: 1,
    },
    promptOutcome: "acknowledged",
    nextAdmission: "rejected",
  },
  {
    name: "terminal-receipt-revision-reconciliation",
    point: "after_provider_receipt_terminal",
    before: {
      dispatches: 1,
      activity: "active",
      run: "running",
      receipt: "settled",
      progress: "provisional",
      terminals: 0,
    },
    after: {
      dispatches: 1,
      activity: "recovery_required",
      run: "recovery_required",
      receipt: "settled",
      progress: "final",
      terminals: 1,
    },
    promptOutcome: "acknowledged",
    nextAdmission: "accepted",
  },
  {
    name: "revision-terminal-transaction-rollback",
    point: "inside_revision_terminal_transaction",
    before: {
      dispatches: 1,
      activity: "active",
      run: "finalizing",
      receipt: "settled",
      progress: "provisional",
      terminals: 0,
    },
    after: {
      dispatches: 1,
      activity: "recovery_required",
      run: "recovery_required",
      receipt: "settled",
      progress: "final",
      terminals: 1,
    },
    promptOutcome: "acknowledged",
    nextAdmission: "accepted",
  },
  {
    name: "terminal-commit-survives-lost-publish",
    point: "after_terminal_commit_before_publish",
    before: {
      dispatches: 1,
      activity: "settled",
      run: "completed",
      receipt: "settled",
      progress: "final",
      terminals: 1,
    },
    after: {
      dispatches: 1,
      activity: "settled",
      run: "completed",
      receipt: "settled",
      progress: "final",
      terminals: 1,
    },
    promptOutcome: "acknowledged",
    nextAdmission: "accepted",
  },
  {
    name: "finalizing-follow-up-fails-closed",
    point: "while_finalizing_before_follow_up_drain",
    before: {
      dispatches: 1,
      activity: "active",
      run: "finalizing",
      receipt: "settled",
      progress: "progress",
      terminals: 0,
    },
    after: {
      dispatches: 1,
      activity: "recovery_required",
      run: "recovery_required",
      receipt: "settled",
      progress: "progress",
      terminals: 1,
    },
    promptOutcome: "acknowledged",
    followUp: true,
    nextAdmission: "accepted",
  },
]

// Optional case filter for focused debugging: DEEPAGENT_CODE_LIVE_LLM_CASE_FILTER=name-substring.
const filter = process.env.DEEPAGENT_CODE_LIVE_LLM_CASE_FILTER?.trim()
const runCases = filter ? cases.filter((testCase) => testCase.name.includes(filter)) : cases

try {
  for (const testCase of runCases) {
    console.log(`${suite}: starting ${testCase.name}`)
    const root = await mkdtemp(path.join(os.tmpdir(), `deepagent-code-${suite}-${testCase.name}-`))
    const markerFile = path.join(root, "crash-marker.json")
    const responseMarker = `restart-${randomUUID()}`
    const requestID = randomUUID().replaceAll("-", "")
    const body = promptBody(
      `msg_restart_${requestID}`,
      `intent-restart-${requestID}`,
      `Reply with exactly ${responseMarker}. Do not call any tool.`,
    )
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
      const session = await createSession(initial, `DeepSeek restart ${testCase.name}`, "live-ui")
      const beforeMessages = new Set((await messages(initial, session.id)).map((message) => message.info.id))
      const promptRequest = sendPrompt(initial, session.id, body).then(
        () => ({ state: "acknowledged" as const }),
        (error) => ({ state: "disconnected" as const, error: error instanceof Error ? error.message : String(error) }),
      )
      let followUpOutcome: "acknowledged" | undefined
      if (testCase.followUp) {
        await waitFor(
          async () => {
            const snapshot = inspect(path.join(root, "deepagent.sqlite"), session.id)
            if (["dispatching", "streaming"].includes(snapshot.receipts.at(-1)?.provider_state ?? "")) return true
          },
          `${testCase.name} provider dispatch`,
          config.timeoutMs,
        )
        const followUpID = randomUUID().replaceAll("-", "")
        await sendPrompt(
          initial,
          session.id,
          promptBody(
            `msg_restart_followup_${followUpID}`,
            `intent-restart-followup-${followUpID}`,
            `After the current reply, reply with exactly follow-up-${followUpID}.`,
          ),
        )
        followUpOutcome = "acknowledged"
      }

      const crash = await waitFor(
        async () => {
          const value = await readFile(markerFile, "utf8").catch(() => undefined)
          if (value) return JSON.parse(value) as CrashMarker
        },
        `${testCase.name} crash point`,
        config.timeoutMs,
      )
      assert.equal(crash.point, testCase.point)
      const statuses = await request<Record<string, Status>>(initial, "/session/status")
      assert.equal(statuses[session.id]?.type, "busy")
      const before = inspect(path.join(root, "deepagent.sqlite"), session.id)
      assertSnapshot(before, testCase.before)
      const initialAppPID = initial.app.process().pid
      await hardKill(initial)
      initial = undefined
      const promptOutcome = await Promise.race([
        promptRequest,
        new Promise<{ state: "timed_out" }>((resolve) => setTimeout(() => resolve({ state: "timed_out" }), 10_000)),
      ])
      assert.equal(promptOutcome.state, testCase.promptOutcome)

      restarted = await launch(suite, config, { root, cleanupRoot: false })
      const restartedAppPID = restarted.app.process().pid
      assert.notEqual(restartedAppPID, initialAppPID)
      const after = await waitFor(
        async () => {
          const snapshot = inspect(path.join(root, "deepagent.sqlite"), session.id)
          if (matchesSnapshot(snapshot, testCase.after)) return snapshot
        },
        `${testCase.name} restart reconciliation`,
        30_000,
      ).catch((error) => {
        const snapshot = inspect(path.join(root, "deepagent.sqlite"), session.id)
        console.error(
          "[diag-reconcile] snapshot:",
          JSON.stringify({ activities: snapshot.activities, runs: snapshot.runs, terminals: snapshot.terminals, receipts: snapshot.receipts, progress: snapshot.progress, intents: snapshot.intents.length }),
        )
        throw error
      })
      assertSnapshot(after, testCase.after)
      assert.equal(after.receipts.length, before.receipts.length)
      assert.equal(after.counts.message_count, before.counts.message_count)
      assert.equal(after.counts.part_count, before.counts.part_count)
      assert.equal(after.counts.tool_part_count, before.counts.tool_part_count)
      assert.equal(after.dispatchCount, before.dispatchCount)
      const restartedStatuses = await request<Record<string, Status>>(restarted, "/session/status")
      assert.notEqual(restartedStatuses[session.id]?.type, "busy")

      let retry: Snapshot | undefined
      if (testCase.exactRetry) {
        await sendPrompt(restarted, session.id, body)
        await waitForPrompt(restarted, session.id, beforeMessages, `${testCase.name} exact retry`)
        retry = inspect(path.join(root, "deepagent.sqlite"), session.id)
        assert.equal(retry.dispatchCount, 1)
        assert.equal(retry.counts.user_message_count, 1)
        assert.equal(
          (await messages(restarted, session.id)).some((message) =>
            message.parts.some((part) => part.type === "text" && part.text.includes(responseMarker)),
          ),
          true,
        )
      }

      const nextID = randomUUID().replaceAll("-", "")
      const nextAdmission = await sendPrompt(restarted, session.id, {
        ...promptBody(`msg_restart_next_${nextID}`, `intent-restart-next-${nextID}`, "deferred restart probe"),
        noReply: true,
      }).then(
        () => "accepted" as const,
        () => "rejected" as const,
      )
      assert.equal(nextAdmission, testCase.nextAdmission)
      const afterAdmission = inspect(path.join(root, "deepagent.sqlite"), session.id)
      assert.equal(afterAdmission.dispatchCount, retry?.dispatchCount ?? after.dispatchCount)
      assert.equal(afterAdmission.activities.length, retry?.activities.length ?? after.activities.length)

      results.push({
        name: testCase.name,
        point: testCase.point,
        sessionID: session.id,
        crash,
        initialAppPID,
        restartedAppPID,
        promptOutcome,
        followUpOutcome,
        runnerBefore: statuses[session.id]?.type,
        runnerAfter: restartedStatuses[session.id]?.type ?? "idle",
        nextAdmission,
        before,
        after,
        retry,
        afterAdmission,
      })
      console.log(`${suite}: passed ${testCase.name}`)
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

type CrashPoint =
  | "after_coordinator_reserve"
  | "after_admit_and_bind"
  | "after_provider_prepared"
  | "after_provider_streaming"
  | "after_provider_receipt_terminal"
  | "inside_revision_terminal_transaction"
  | "after_terminal_commit_before_publish"
  | "while_finalizing_before_follow_up_drain"

type SnapshotExpectation = {
  dispatches: number
  activity: string | undefined
  run: string | undefined
  receipt: string | undefined
  progress: string | undefined
  terminals: number
}

type RestartCase = {
  name: string
  point: CrashPoint
  before: SnapshotExpectation
  after: SnapshotExpectation
  promptOutcome: "acknowledged" | "disconnected"
  exactRetry?: true
  followUp?: true
  nextAdmission: "accepted" | "rejected"
}

type CrashMarker = { point: string; pid: number; reachedAt: number }
type Snapshot = ReturnType<typeof inspect>
type RestartResult = {
  name: string
  point: CrashPoint
  sessionID: string
  crash: CrashMarker
  initialAppPID?: number
  restartedAppPID?: number
  promptOutcome: { state: "acknowledged" } | { state: "disconnected"; error: string }
  followUpOutcome?: "acknowledged"
  runnerBefore: string | undefined
  runnerAfter: string
  nextAdmission: "accepted" | "rejected"
  before: Snapshot
  after: Snapshot
  retry?: Snapshot
  afterAdmission: Snapshot
}

function promptBody(messageID: string, intentID: string, text: string) {
  return {
    messageID,
    intentID,
    model: { providerID: "live-deepseek", modelID: config.modelID },
    agent: "live-ui",
    parts: [{ type: "text", text }],
  }
}

function sendPrompt(runtime: Runtime, sessionID: string, body: ReturnType<typeof promptBody> & { noReply?: boolean }) {
  return request<unknown>(runtime, `/session/${sessionID}/prompt_async`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

function matchesSnapshot(snapshot: Snapshot, expected: SnapshotExpectation) {
  return (
    snapshot.dispatchCount === expected.dispatches &&
    snapshot.activities.at(-1)?.state === expected.activity &&
    snapshot.runs.at(-1)?.state === expected.run &&
    snapshot.receipts.at(-1)?.provider_state === expected.receipt &&
    snapshot.progress.at(-1)?.state === expected.progress &&
    snapshot.terminals.length === expected.terminals
  )
}

function assertSnapshot(snapshot: Snapshot, expected: SnapshotExpectation) {
  assert.equal(snapshot.dispatchCount, expected.dispatches)
  assert.equal(snapshot.activities.at(-1)?.state, expected.activity)
  assert.equal(snapshot.runs.at(-1)?.state, expected.run)
  assert.equal(snapshot.receipts.at(-1)?.provider_state, expected.receipt)
  assert.equal(snapshot.progress.at(-1)?.state, expected.progress)
  assert.equal(snapshot.terminals.length, expected.terminals)
}

function inspect(databasePath: string, sessionID: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    database.exec("PRAGMA busy_timeout = 5000")
    const activities = database
      .prepare(
        "SELECT activity_id, owner_token, state, terminal_reason FROM session_legacy_activity WHERE session_id = ? ORDER BY ordinal",
      )
      .all(sessionID) as Array<{
      activity_id: string
      owner_token: string
      state: string
      terminal_reason: string | null
    }>
    const runs = database
      .prepare(
        "SELECT run_id, activity_id, generation, owner_token, state, terminal_reason FROM session_legacy_activity_run WHERE session_id = ? ORDER BY generation",
      )
      .all(sessionID) as Array<{
      run_id: string
      activity_id: string
      generation: number
      owner_token: string
      state: string
      terminal_reason: string | null
    }>
    const progress = database
      .prepare(
        "SELECT activity_id, revision, assistant_message_id, provider_receipt_id, input_membership_ordinal, state, finish_observed FROM session_activity_progress WHERE activity_id IN (SELECT activity_id FROM session_legacy_activity WHERE session_id = ?) ORDER BY activity_id, revision",
      )
      .all(sessionID) as Array<{
      activity_id: string
      revision: number
      assistant_message_id: string
      provider_receipt_id: string
      input_membership_ordinal: number
      state: string
      finish_observed: string | null
    }>
    const receipts = database
      .prepare(
        "SELECT receipt_id, assistant_message_id, provider_state, request_state, request_error_code, call_ids FROM session_tool_request_receipt WHERE session_id = ? ORDER BY request_ordinal",
      )
      .all(sessionID) as Array<{
      receipt_id: string
      assistant_message_id: string
      provider_state: string
      request_state: string
      request_error_code: string | null
      call_ids: string
    }>
    const terminals = database
      .prepare(
        "SELECT activity_id, run_id, state, reason_code, source, assistant_message_id, progress_revision, membership_ordinal FROM session_legacy_activity_terminal WHERE session_id = ? ORDER BY created_at",
      )
      .all(sessionID)
    const intents = database
      .prepare(
        "SELECT intent_id, state, delivery, execution_mode, execution_state, admitted_message_id FROM session_intent WHERE session_id = ? ORDER BY time_created",
      )
      .all(sessionID)
    const steers = database
      .prepare("SELECT id, delivery, consumed_seq, superseded_at FROM session_steer WHERE session_id = ? ORDER BY seq")
      .all(sessionID)
    const counts = database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM message WHERE session_id = ?) AS message_count,
          (SELECT COUNT(*) FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user') AS user_message_count,
          (SELECT COUNT(*) FROM part WHERE session_id = ?) AS part_count,
          (SELECT COUNT(*) FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool') AS tool_part_count`,
      )
      .get(sessionID, sessionID, sessionID, sessionID) as {
      message_count: number
      user_message_count: number
      part_count: number
      tool_part_count: number
    }
    return {
      activities,
      runs,
      progress,
      receipts: receipts.map((receipt) => ({ ...receipt, call_ids: JSON.parse(receipt.call_ids) as string[] })),
      terminals,
      intents,
      steers,
      counts,
      dispatchCount: receipts.filter((receipt) => receipt.request_state === "dispatched").length,
    }
  } finally {
    database.close()
  }
}
