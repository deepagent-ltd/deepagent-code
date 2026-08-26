import { strict as assert } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
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
  subagentState,
  tools,
  visibleText,
  waitFor,
  writeArtifact,
  type QuestionRequest,
} from "./runtime.ts"

const suite = "desktop-observed"
const config = await loadLiveConfig()
const preflightResult = await preflight(config)
const startedAt = Date.now()

try {
  const runtime = await launch(suite, config)
  try {
    const marker = `gui-observed-${randomUUID()}`
    const filename = "gui-subagent-result.json"
    const expected = {
      scenario: "subagent-interrupted",
      marker,
      childExited: true,
    }
    const session = await createSession(runtime, "GUI observable: Subagent → exit → JSON", "live-observed")
    const slug = Buffer.from(runtime.workspace).toString("base64url")
    const sessionKey = `local\u0000${slug}/${session.id}`
    await runtime.page.evaluate(
      async ({ layout, pageLayout, server }) => {
        const api = (window as unknown as {
          api: { storeSet(name: string, key: string, value: string): Promise<void> }
        }).api
        await api.storeSet("deepagent.global.dat", "layout", JSON.stringify(layout))
        await api.storeSet("deepagent.global.dat", "layout.page", JSON.stringify(pageLayout))
        await api.storeSet("deepagent.global.dat", "server", JSON.stringify(server))
      },
      {
        layout: { sessionView: { [sessionKey]: { scroll: {} } } },
        pageLayout: {
          lastProjectSession: {
            [runtime.workspace]: { directory: runtime.workspace, id: session.id, at: Date.now() },
          },
        },
        server: {
          list: [],
          projects: { local: [{ worktree: runtime.workspace, expanded: true }] },
          lastProject: { local: runtime.workspace },
        },
      },
    )
    await runtime.page.reload({ waitUntil: "domcontentloaded" })
    await runtime.page
      .getByRole("heading", { name: "GUI observable: Subagent → exit → JSON" })
      .waitFor({ state: "visible", timeout: 60_000 })

    const prompt = [
      "Call task exactly once in foreground mode with subagent_type researcher and description visible interruption test.",
      "The child prompt must be exactly: Call question exactly once to ask whether the visible GUI test should continue, with one Continue option. Wait for the answer and do not call any other tool.",
      "The GUI test operator will interrupt the child while that question is pending. Do not retry the task.",
      `After the task reports interruption, call write exactly once for ${filename}.`,
      `The complete file content must be exactly this valid JSON: ${JSON.stringify(expected)}`,
      `Then call read exactly once for ${filename}.`,
      "Finally report that the child exited and include the exact JSON returned by read. Do not call any other tool.",
    ].join("\n")
    const editor = runtime.page.locator('[data-component="prompt-input"]')
    await editor.waitFor({ state: "visible", timeout: 60_000 })
    await runtime.page.locator('[data-action="prompt-scenario-direct"]').click()
    await editor.fill(prompt)
    console.log(`${suite}: prompt is visible; submitting through the renderer`)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    await runtime.page.locator('[data-action="prompt-submit"]').click()

    const latch = await waitFor(
      async () => {
        const child = (await children(runtime, session.id))[0]
        if (!child) return
        const question = (await request<QuestionRequest[]>(runtime, "/question")).find(
          (item) => item.sessionID === child.id,
        )
        if (question) return { child, question }
      },
      "visible child Question latch",
      config.timeoutMs,
    )
    console.log(`${suite}: child Question is visible; interrupting the child in 3 seconds`)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    await request<boolean>(runtime, `/session/${latch.child.id}/abort`, { method: "POST" })

    const persisted = await waitFor(
      async () => {
        const all = await messages(runtime, session.id)
        const parts = tools(all)
        const wrote = parts.some((part) => part.tool === "write" && part.state.status === "completed")
        const read = parts.find(
          (part) =>
            part.tool === "read" &&
            part.state.status === "completed" &&
            part.state.output.includes(marker),
        )
        const latest = all.filter((message) => message.info.role === "assistant").at(-1)
        const final = latest?.parts.some(
          (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.includes(marker),
        )
        if (wrote && read && latest?.info.time.completed !== undefined && final) return all
      },
      "visible JSON write/read and final response",
      config.timeoutMs,
    )

    const child = (await children(runtime, session.id))[0]
    assert(child)
    assert.deepEqual(subagentState(child), { state: "interrupted", reason: "human" })
    assertModel(persisted, config.modelID)
    assert.deepEqual(JSON.parse(await readFile(path.join(runtime.workspace, filename), "utf8")), expected)
    assert.match(visibleText(persisted), new RegExp(marker))
    assert.deepEqual(
      tools(persisted).map((part) => `${part.tool}:${part.state.status}`),
      ["task:error", "write:completed", "read:completed"],
    )
    await assertNoPermissionRequests(runtime)
    assert.deepEqual(await request<QuestionRequest[]>(runtime, "/question"), [])
    await waitFor(
      async () => ((await runtime.page.locator('[data-slot="question-text"]').count()) === 0 ? true : undefined),
      "renderer child Question cleanup",
      30_000,
    )

    const artifactDirectory = path.join(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."),
      ".artifacts/live-llm",
    )
    await mkdir(artifactDirectory, { recursive: true })
    const screenshot = path.join(artifactDirectory, `${suite}.png`)
    await runtime.page.screenshot({ path: screenshot, fullPage: false })
    await writeArtifact(suite, {
      suite,
      mode: "release",
      stack: "renderer-ui",
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
        sessionIDLength: session.id.length,
        childState: subagentState(child),
        questionCount: latch.question.questions.length,
        tools: tools(persisted).map((part) => `${part.tool}:${part.state.status}`),
        markerHash: createHash("sha256").update(marker).digest("hex"),
        jsonValidatedFromDisk: true,
        permissionRequests: 0,
        questionRequests: 0,
        questionDockCleared: true,
        screenshot: path.basename(screenshot),
      },
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    })
    console.log(`${suite}: passed; keeping the final GUI visible for 10 seconds`)
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  } finally {
    await close(runtime)
  }
} finally {
  await closeAll()
}
