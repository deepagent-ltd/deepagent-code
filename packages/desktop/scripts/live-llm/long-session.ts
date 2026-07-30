import { strict as assert } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
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

    const interruptedBefore = await startPrompt(
      runtime,
      session.id,
      "Call question exactly once to ask whether the retained release proof should be reported, with one Continue option. Wait for the answer and do not call other tools.",
      "live-long",
    )
    const question = await waitFor(
      async () => (await request<QuestionRequest[]>(runtime, "/question")).find((item) => item.sessionID === session.id),
      "long-session Question latch",
      config.timeoutMs,
    )
    await request<boolean>(runtime, `/session/${session.id}/abort`, { method: "POST" })
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
          .some((part) => part.type === "tool" && part.tool === "question" && part.state.status === "error")
        if (statuses[session.id]?.type !== "busy" && !pending.some((item) => item.id === question.id) && interrupted) {
          return true
        }
      },
      "interrupted Session terminal state",
      config.timeoutMs,
    )

    const finalBefore = await startPrompt(
      runtime,
      session.id,
      "Continue after the interruption. Without calling any tool, report the exact release proof retained from before compaction.",
      "live-long",
    )
    const finalMessages = await waitForPrompt(runtime, session.id, finalBefore, "post-interruption continuation")
    const finalTurn = finalMessages.filter((message) => !finalBefore.has(message.info.id))
    assertModel(finalMessages, config.modelID)
    assert.match(visibleText(finalTurn), new RegExp(marker))
    assert.equal(tools(finalTurn).length, 0)
    await assertNoPermissionRequests(runtime)
    assert.deepEqual(await request<unknown[]>(runtime, "/question"), [])

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
        interruptedTerminalObserved: true,
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
