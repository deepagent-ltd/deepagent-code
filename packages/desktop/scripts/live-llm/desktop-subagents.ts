import { strict as assert } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import {
  assertModel,
  assertNoPermissionRequests,
  children,
  close,
  closeAll,
  createSession,
  launch,
  loadLiveConfig,
  messages,
  preflight,
  request,
  startPrompt,
  subagentState,
  tools,
  visibleText,
  waitFor,
  waitForPrompt,
  writeArtifact,
  type Message,
  type QuestionRequest,
  type Runtime,
  type Session,
  type ToolPart,
} from "./runtime.ts"

const suite = "desktop-subagents"
const config = await loadLiveConfig()
const preflightResult = await preflight(config)
const startedAt = Date.now()
const scenarios: Array<Record<string, unknown>> = []

try {
  await foregroundScenario()
  await interruptedScenario()
  await backgroundScenario()
  const artifact = {
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
    scenarios,
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  }
  await writeArtifact(suite, artifact)
  console.log(`${suite}: passed (deepseek/${config.modelID})`)
} finally {
  await closeAll()
}

async function foregroundScenario() {
  const runtime = await launch("desktop-subagent-foreground", config)
  try {
    assertSafeEnv(runtime)
    const marker = `desktop-foreground-${randomUUID()}`
    const fixture = path.join(runtime.workspace, "foreground.txt")
    await writeFile(fixture, `${marker}\n`)
    const parent = await createSession(runtime, "Desktop foreground subagent")
    const prompt = [
      "Call task exactly once in foreground mode with subagent_type researcher and description desktop foreground research.",
      "The child prompt must be exactly: Read foreground.txt exactly once. Return a valid ResearchResult with mechanism set to the file content exactly, without quotes or explanation. Do not call task.",
      "Do not read the fixture in the parent.",
      "After task completes, call task_status exactly once and task_read exactly once for the completed task id with limit 100.",
      "Finally report the exact evidence recovered from the task tools.",
    ].join("\n")
    const before = await startPrompt(runtime, parent.id, prompt)
    const parentMessages = await waitForPrompt(runtime, parent.id, before, "desktop foreground parent", async () => {
      await assertNoPendingPermissions(runtime)
    })
    const child = onlyChild(await children(runtime, parent.id), parent.id, "foreground")
    const childMessages = await messages(runtime, child.id)
    assertModel(parentMessages, config.modelID)
    assertModel(childMessages, config.modelID)
    assert.equal(prompt.includes(marker), false)
    assert.equal(subagentState(child).state, "completed")
    const parentTools = tools(parentMessages)
    assert.equal(parentTools.some((part) => part.tool === "read"), false)
    assert.match(completed(parentTools, "task").state.output, new RegExp(marker))
    assert.match(completed(parentTools, "task_status").state.output, /\[completed\]/)
    assert.match(completed(parentTools, "task_read").state.output, new RegExp(marker))
    assert.match(visibleText(parentMessages), new RegExp(marker))
    assert.equal(
      tools(childMessages).some(
        (part) => part.tool === "read" && part.state.status === "completed" && part.state.output.includes(marker),
      ),
      true,
    )
    await assertUnattendedPermissions(runtime)
    scenarios.push({
      name: "foreground",
      status: "passed",
      parentSessionIDLength: parent.id.length,
      childSessionIDLength: child.id.length,
      markerHash: hash(marker),
      parentTools: parentTools.map((part) => `${part.tool}:${part.state.status}`),
      permissionCount: 0,
      durableState: subagentState(child).state,
    })
  } finally {
    await close(runtime)
  }
}

async function interruptedScenario() {
  const runtime = await launch("desktop-subagent-interrupted", config)
  try {
    assertSafeEnv(runtime)
    const marker = `desktop-interrupted-${randomUUID()}`
    const fixture = path.join(runtime.workspace, "interrupted.txt")
    await writeFile(fixture, `${marker}\n`)
    const parent = await createSession(runtime, "Desktop interrupted subagent")
    const prompt = [
      "Call task exactly once in foreground mode with subagent_type researcher and description desktop interrupted research.",
      "The child prompt must be exactly: Read interrupted.txt exactly once. Then call question exactly once to ask whether to continue, with one Continue option. Do not return a final result before the answer. Do not call task.",
      "Do not read the fixture in the parent.",
      "The test operator will interrupt the child while its question is pending.",
      "After task reports interruption, do not retry. Call task_status exactly once and task_read exactly once for the interrupted task id with limit 100.",
      "Finally report the partial evidence recovered only from task_read and say the child was interrupted.",
    ].join("\n")
    const before = await startPrompt(runtime, parent.id, prompt)
    const latch = await waitFor(
      async () => {
        const items = await children(runtime, parent.id)
        const child = items[0]
        if (!child) return
        await assertNoPendingPermissions(runtime)
        const childMessages = await messages(runtime, child.id)
        const readCompleted = tools(childMessages).some(
          (part) => part.tool === "read" && part.state.status === "completed" && part.state.output.includes(marker),
        )
        const question = (await request<QuestionRequest[]>(runtime, "/question")).find(
          (item) => item.sessionID === child.id,
        )
        if (readCompleted && question) return { child, question }
      },
      "desktop interrupted Question latch",
      config.timeoutMs,
    )
    await request<boolean>(runtime, `/session/${latch.child.id}/abort`, { method: "POST" })
    const parentMessages = await waitForPrompt(runtime, parent.id, before, "desktop interrupted parent", async () => {
      await assertNoPendingPermissions(runtime)
    })
    const child = onlyChild(await children(runtime, parent.id), parent.id, "interrupted")
    const childMessages = await messages(runtime, child.id)
    assertModel(parentMessages, config.modelID)
    assertModel(childMessages, config.modelID)
    assert.equal(prompt.includes(marker), false)
    assert.deepEqual(subagentState(child), { state: "interrupted", reason: "human" })
    const parentTools = tools(parentMessages)
    assert.equal(parentTools.some((part) => part.tool === "read"), false)
    const task = parentTools.find((part) => part.tool === "task")
    assert.equal(task?.state.status, "error")
    if (task?.state.status === "error") assert.match(task.state.error, /Partial work is preserved/)
    assert.match(completed(parentTools, "task_status").state.output, /\[interrupted\]/)
    assert.match(completed(parentTools, "task_read").state.output, new RegExp(marker))
    assert.match(visibleText(parentMessages), new RegExp(marker))
    await assertUnattendedPermissions(runtime)
    scenarios.push({
      name: "interrupted",
      status: "passed",
      parentSessionIDLength: parent.id.length,
      childSessionIDLength: child.id.length,
      markerHash: hash(marker),
      questionCount: latch.question.questions.length,
      parentTools: parentTools.map((part) => `${part.tool}:${part.state.status}`),
      childTools: tools(childMessages).map((part) => `${part.tool}:${part.state.status}`),
      permissionCount: 0,
      durableState: subagentState(child).state,
    })
  } finally {
    await close(runtime)
  }
}

async function backgroundScenario() {
  const runtime = await launch("desktop-subagent-background", config)
  try {
    assertSafeEnv(runtime)
    const marker = `desktop-background-${randomUUID()}`
    const release = `desktop-release-${randomUUID()}`
    const fixture = path.join(runtime.workspace, "background.txt")
    await writeFile(fixture, `${marker}\n`)
    const parent = await createSession(runtime, "Desktop background subagent")
    const prompt = [
      "Call task exactly once with background=true, subagent_type researcher, and description desktop background research.",
      "The child prompt must be exactly: Read background.txt exactly once. Then call question exactly once to ask for the release word, with one Continue option. After the answer, return a valid ResearchResult whose mechanism is the exact file content followed by one space and the exact answer. Do not call task.",
      "Do not read the fixture in the parent and do not poll while the task is running. End the current response after it starts.",
      "When the automatic completion notification arrives, call task_status exactly once and task_read exactly once for the completed task id with limit 100.",
      "Finally report the evidence obtained only from the notification and transcript.",
    ].join("\n")
    const before = await startPrompt(runtime, parent.id, prompt)
    const initial = await waitForPrompt(runtime, parent.id, before, "desktop background admission", async () => {
      await assertNoPendingPermissions(runtime)
    })
    const child = onlyChild(await children(runtime, parent.id), parent.id, "background")
    const initialTask = completed(tools(initial), "task")
    assert.match(initialTask.state.output, /state="running"/)
    assert.match(initialTask.state.output, new RegExp(child.id))
    const question = await waitFor(
      async () => {
        await assertNoPendingPermissions(runtime)
        const childMessages = await messages(runtime, child.id)
        const readCompleted = tools(childMessages).some(
          (part) => part.tool === "read" && part.state.status === "completed" && part.state.output.includes(marker),
        )
        const item = (await request<QuestionRequest[]>(runtime, "/question")).find(
          (candidate) => candidate.sessionID === child.id,
        )
        if (readCompleted && item) return item
      },
      "desktop background Question latch",
      config.timeoutMs,
    )
    assert.notEqual(subagentState((await children(runtime, parent.id))[0] ?? child).state, "completed")
    await request<boolean>(runtime, `/question/${question.id}/reply`, {
      method: "POST",
      body: JSON.stringify({ answers: [[release]] }),
    })
    const parentMessages = await waitFor(
      async () => {
        await assertNoPendingPermissions(runtime)
        const all = await messages(runtime, parent.id)
        const parts = tools(all)
        const hasAudit = ["task_status", "task_read"].every((name) =>
          parts.some((part) => part.tool === name && part.state.status === "completed"),
        )
        const latest = all.filter((message) => message.info.role === "assistant").at(-1)
        const hasText = latest?.parts.some(
          (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
        )
        if (hasAudit && latest?.info.time.completed !== undefined && hasText) return all
      },
      "desktop background automatic continuation",
      config.timeoutMs,
    )
    const settled = onlyChild(await children(runtime, parent.id), parent.id, "background")
    const childMessages = await messages(runtime, child.id)
    assertModel(parentMessages, config.modelID)
    assertModel(childMessages, config.modelID)
    assert.equal(prompt.includes(marker) || prompt.includes(release), false)
    assert.deepEqual(subagentState(settled), { state: "completed", reason: "structured_output_valid" })
    const parentTools = tools(parentMessages)
    assert.equal(parentTools.some((part) => part.tool === "read"), false)
    assert.match(completed(parentTools, "task_status").state.output, /\[completed\]/)
    const transcript = completed(parentTools, "task_read").state.output
    assert.match(transcript, new RegExp(marker))
    assert.match(transcript, new RegExp(release))
    assert.match(visibleText(parentMessages), new RegExp(marker))
    assert.match(visibleText(parentMessages), new RegExp(release))
    await assertUnattendedPermissions(runtime)
    scenarios.push({
      name: "background",
      status: "passed",
      parentSessionIDLength: parent.id.length,
      childSessionIDLength: child.id.length,
      markerHash: hash(marker),
      releaseHash: hash(release),
      questionCount: question.questions.length,
      nonterminalObserved: true,
      automaticContinuation: true,
      parentTools: parentTools.map((part) => `${part.tool}:${part.state.status}`),
      childTools: tools(childMessages).map((part) => `${part.tool}:${part.state.status}`),
      permissionCount: 0,
      durableState: subagentState(settled).state,
    })
  } finally {
    await close(runtime)
  }
}

async function assertUnattendedPermissions(runtime: Runtime) {
  await assertNoPendingPermissions(runtime)
}

async function assertNoPendingPermissions(runtime: Runtime) {
  await assertNoPermissionRequests(runtime)
}

function onlyChild(items: Session[], parentID: string, name: string) {
  assert.equal(items.length, 1, `${name}: expected one child Session`)
  const child = items[0]
  assert.equal(child?.parentID, parentID)
  assert.equal(child?.agent, "researcher")
  return child as Session
}

function completed(parts: ToolPart[], name: string) {
  const part = parts.findLast((item) => item.tool === name && item.state.status === "completed")
  if (!part || part.state.status !== "completed") {
    const failed = parts.findLast((item) => item.tool === name && item.state.status === "error")
    throw new Error(`${name} did not complete${failed?.state.status === "error" ? `: ${failed.state.error}` : ""}`)
  }
  return part as ToolPart & { state: Extract<ToolPart["state"], { status: "completed" }> }
}

function assertSafeEnv(runtime: Runtime) {
  assert.equal(runtime.env.DEEPAGENT_CODE_AUTH_CONTENT, undefined)
  assert.equal(runtime.env.DEEPSEEK_API_KEY, undefined)
  assert.equal(runtime.env.SSH_AUTH_SOCK, undefined)
  assert.equal(Object.keys(runtime.env).some((key) => key.startsWith("AWS_")), false)
  assert.equal(runtime.env.HOME.startsWith(runtime.root), true)
  assert.equal(runtime.env.DEEPAGENT_CODE_DB.startsWith(runtime.root), true)
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
