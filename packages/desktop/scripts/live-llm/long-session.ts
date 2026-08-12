import { strict as assert } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  assertModel,
  assertNoPermissionRequests,
  close,
  closeAll,
  createSession,
  launch,
  loadLiveConfig,
  messages,
  preflight,
  request,
  startPrompt,
  tools,
  visibleText,
  waitFor,
  waitForPrompt,
  writeArtifact,
  type QuestionRequest,
  type Status,
} from "./runtime.ts"

const suite = "long-session"
const config = await loadLiveConfig()
const preflightResult = await preflight(config)
const startedAt = Date.now()

try {
  const runtime = await launch(suite, config)
  try {
    const marker = `long-session-${randomUUID()}`
    await writeFile(path.join(runtime.workspace, "memory.txt"), `${marker}\n`)
    const session = await createSession(runtime, "DeepSeek V4 Flash long Session", "live-long")

    const firstBefore = await startPrompt(
      runtime,
      session.id,
      "Read memory.txt exactly once and report its exact content as the release proof. Do not call other tools.",
      "live-long",
    )
    const first = await waitForPrompt(runtime, session.id, firstBefore, "initial long-session evidence")
    assert.equal(
      tools(first).some(
        (part) => part.tool === "read" && part.state.status === "completed" && part.state.output.includes(marker),
      ),
      true,
    )
    assert.match(visibleText(first), new RegExp(marker))

    const contextBefore = await startPrompt(
      runtime,
      session.id,
      "Remember that the exact release proof from the initial file is the only durable fact needed later. Acknowledge briefly without calling tools.",
      "live-long",
    )
    await waitForPrompt(runtime, session.id, contextBefore, "pre-compaction context")

    await request<boolean>(runtime, `/session/${session.id}/summarize`, {
      method: "POST",
      body: JSON.stringify({ providerID: "live-deepseek", modelID: config.modelID, auto: false }),
    })
    const compacted = await messages(runtime, session.id)
    const compactionIndex = compacted.findIndex((message) => message.parts.some((part) => part.type === "compaction"))
    assert.notEqual(compactionIndex, -1)
    const summary = compacted
      .slice(compactionIndex + 1)
      .find((message) => message.info.role === "assistant" && message.info.time.completed !== undefined)
    assert.ok(summary)
    assert.match(visibleText([summary]), new RegExp(marker))

    const questionPrompt =
      "Call question exactly once to ask whether the retained release proof should be reported, with one Continue option. Wait for the answer and do not call other tools."
    const interruptedBefore = await startPrompt(
      runtime,
      session.id,
      questionPrompt,
      "live-long",
    )
    const question = await waitFor(
      async () => (await request<QuestionRequest[]>(runtime, "/question")).find((item) => item.sessionID === session.id),
      "long-session Question latch",
      config.timeoutMs,
    )
    await request<boolean>(runtime, `/question/${question.id}/reject`, { method: "POST" })
    await waitFor(
      async () => {
        const [all, statuses, pending] = await Promise.all([
          messages(runtime, session.id),
          request<Record<string, Status>>(runtime, "/session/status"),
          request<QuestionRequest[]>(runtime, "/question"),
        ])
        const interrupted = all
          .filter((message) => !interruptedBefore.has(message.info.id))
          .flatMap((message) => message.parts)
          .some(
            (part) =>
              part.type === "tool" &&
              part.tool === "question" &&
              part.state.status === "error" &&
              part.state.metadata?.failureCode === "user_rejected_question",
          )
        if (statuses[session.id]?.type !== "busy" && !pending.some((item) => item.id === question.id) && interrupted) {
          return true
        }
      },
      "rejected Question terminal state",
      config.timeoutMs,
    )
    const rejected = inspectLatestActivity(path.join(runtime.root, "deepagent.sqlite"), session.id)
    assertLifecycle(rejected, {
      activity: "interrupted",
      reason: "user_rejected_question",
      run: "interrupted",
      terminal: "interrupted",
      source: "host_stop",
      progress: "progress",
    })

    const continuationPrompt =
      "Continue after the rejected question. Without calling any tool, report the exact release proof retained from before compaction."
    const finalBefore = await startPrompt(
      runtime,
      session.id,
      continuationPrompt,
      "live-long",
    )
    const finalMessages = await waitForPrompt(runtime, session.id, finalBefore, "post-interruption continuation")
    const finalTurn = finalMessages.filter((message) => !finalBefore.has(message.info.id))
    assertModel(finalMessages, config.modelID)
    assert.match(visibleText(finalTurn), new RegExp(marker))
    assert.equal(tools(finalTurn).length, 0)
    await assertNoPermissionRequests(runtime)
    assert.deepEqual(await request<unknown[]>(runtime, "/question"), [])
    const completed = inspectLatestActivity(path.join(runtime.root, "deepagent.sqlite"), session.id)
    assert.notEqual(completed.activity_id, rejected.activity_id)
    assertLifecycle(completed, {
      activity: "settled",
      reason: "assistant_completed",
      run: "completed",
      terminal: "settled",
      source: "provider_final",
      progress: "final",
    })
    const allMessages = await messages(runtime, session.id)
    assert.equal(
      allMessages.filter((message) => message.info.role === "user" && visibleText([message]) === questionPrompt).length,
      1,
    )
    assert.equal(
      allMessages.filter((message) => message.info.role === "user" && visibleText([message]) === continuationPrompt).length,
      1,
    )

    await writeArtifact(suite, {
      suite,
      mode: "ext",
      stack: "packaged-sidecar",
      status: "passed",
      fingerprint: {
        providerID: "deepseek",
        runtimeProviderID: "live-deepseek",
        modelID: config.modelID,
        modelRevision: config.modelRevision,
        baseURL: config.baseURL,
      },
      preflight: preflightResult,
      evidence: {
        markerHash: createHash("sha256").update(marker).digest("hex"),
        manualCompactionPersisted: true,
        summaryRetainedMarker: true,
        questionCount: question.questions.length,
        questionRejectedThroughProductionRoute: true,
        rejectedActivity: lifecycleEvidence(rejected),
        continuationActivity: lifecycleEvidence(completed),
        continuationUsedNoTools: true,
        pendingPermissions: 0,
        pendingQuestions: 0,
        humanReplies: 0,
      },
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    })
    console.log(`${suite}: passed (deepseek/${config.modelID})`)
  } finally {
    await close(runtime)
  }
} finally {
  await closeAll()
}

type Lifecycle = ReturnType<typeof inspectLatestActivity>

function inspectLatestActivity(databasePath: string, sessionID: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    database.exec("PRAGMA busy_timeout = 5000")
    const activity = database
      .prepare(
        `SELECT
          activity_id,
          state,
          terminal_reason
        FROM session_legacy_activity
        WHERE session_id = ?
        ORDER BY ordinal DESC
        LIMIT 1`,
      )
      .get(sessionID) as { activity_id: string; state: string; terminal_reason: string | null } | undefined
    assert.ok(activity)
    const runs = database
      .prepare(
        `SELECT run_id, state, terminal_reason
        FROM session_legacy_activity_run
        WHERE activity_id = ?
        ORDER BY generation`,
      )
      .all(activity.activity_id) as Array<{ run_id: string; state: string; terminal_reason: string | null }>
    const terminals = database
      .prepare(
        `SELECT state, reason_code, source, run_id, progress_revision
        FROM session_legacy_activity_terminal
        WHERE activity_id = ?`,
      )
      .all(activity.activity_id) as Array<{
      state: string
      reason_code: string
      source: string
      run_id: string | null
      progress_revision: number | null
    }>
    const progress = database
      .prepare(
        `SELECT revision, state, provider_receipt_id
        FROM session_activity_progress
        WHERE activity_id = ?
        ORDER BY revision`,
      )
      .all(activity.activity_id) as Array<{ revision: number; state: string; provider_receipt_id: string }>
    return { ...activity, runs, terminals, progress }
  } finally {
    database.close()
  }
}

function assertLifecycle(
  lifecycle: Lifecycle,
  expected: {
    activity: string
    reason: string
    run: string
    terminal: string
    source: string
    progress: string
  },
) {
  assert.equal(lifecycle.state, expected.activity)
  assert.equal(lifecycle.terminal_reason, expected.reason)
  assert.equal(lifecycle.runs.length, 1)
  assert.equal(lifecycle.runs[0]?.state, expected.run)
  assert.equal(lifecycle.runs[0]?.terminal_reason, expected.reason)
  assert.equal(lifecycle.terminals.length, 1)
  assert.equal(lifecycle.terminals[0]?.state, expected.terminal)
  assert.equal(lifecycle.terminals[0]?.reason_code, expected.reason)
  assert.equal(lifecycle.terminals[0]?.source, expected.source)
  assert.equal(lifecycle.terminals[0]?.run_id, lifecycle.runs[0]?.run_id)
  assert.equal(lifecycle.progress.length, 1)
  assert.equal(lifecycle.progress[0]?.revision, 0)
  assert.equal(lifecycle.progress[0]?.state, expected.progress)
  assert.equal(lifecycle.terminals[0]?.progress_revision, lifecycle.progress[0]?.revision)
  assert.equal(new Set(lifecycle.progress.map((item) => item.provider_receipt_id)).size, 1)
}

function lifecycleEvidence(lifecycle: Lifecycle) {
  return {
    activityIDHash: createHash("sha256").update(lifecycle.activity_id).digest("hex"),
    activityState: lifecycle.state,
    terminalReason: lifecycle.terminal_reason,
    runState: lifecycle.runs[0]?.state,
    terminalState: lifecycle.terminals[0]?.state,
    terminalSource: lifecycle.terminals[0]?.source,
    progressStates: lifecycle.progress.map((item) => `${item.revision}:${item.state}`),
    providerDispatches: new Set(lifecycle.progress.map((item) => item.provider_receipt_id)).size,
  }
}
