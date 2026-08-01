import { strict as assert } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
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
  tools,
  visibleText,
  waitFor,
  writeArtifact,
} from "./runtime.ts"

const suite = "desktop-ui"
const config = await loadLiveConfig()
const preflightResult = await preflight(config)
const startedAt = Date.now()

try {
  const runtime = await launch(suite, config)
  try {
    const marker = `renderer-${randomUUID()}`
    const fixtureName = "ui-fixture.txt"
    const fixture = path.join(runtime.workspace, fixtureName)
    const prompt = [
      `Call read exactly once for ${fixtureName}.`,
      "Then report the exact file content without quotes or explanation.",
      "Do not call any other tool.",
    ].join(" ")
    await writeFile(fixture, `${marker}\n`)
    const session = await createSession(runtime, "DeepSeek V4 Flash renderer UI", "live-ui")
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
    const pageErrors: string[] = []
    runtime.page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await runtime.page.reload({ waitUntil: "domcontentloaded" })
    await runtime.page
      .getByRole("heading", { name: "DeepSeek V4 Flash renderer UI" })
      .waitFor({ state: "visible", timeout: 60_000 })
    const editor = runtime.page.locator('[data-component="prompt-input"]')
    await editor.waitFor({ state: "visible", timeout: 60_000 })
    await runtime.page.locator('[data-action="prompt-scenario-direct"]').click()
    assert.equal(
      await runtime.page.locator('[data-action="prompt-scenario-direct"]').getAttribute("data-active"),
      "true",
    )
    await editor.fill(prompt)
    assert.equal(await editor.textContent(), prompt)
    assert.equal(await runtime.page.locator('[data-action="prompt-submit"]').isEnabled(), true)
    await runtime.page.locator('[data-action="prompt-submit"]').click()

    const persisted = await waitFor(
      async () => {
        const all = await messages(runtime, session.id)
        const completedRead = tools(all).find(
          (part) => part.tool === "read" && part.state.status === "completed" && part.state.output.includes(marker),
        )
        const latest = all.filter((message) => message.info.role === "assistant").at(-1)
        const final = latest?.parts.some(
          (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.includes(marker),
        )
        if (completedRead && latest?.info.time.completed !== undefined && final) return all
      },
      "renderer terminal assistant",
      config.timeoutMs,
    )
    assertModel(persisted, config.modelID)
    assert.equal(prompt.includes(marker), false)
    assert.deepEqual(
      tools(persisted).map((part) => ({ name: part.tool, status: part.state.status })),
      [{ name: "read", status: "completed" }],
    )
    assert.match(visibleText(persisted), new RegExp(marker))
    await assertNoPermissionRequests(runtime)
    const toolWrapper = runtime.page.locator('[data-component="tool-part-wrapper"]')
    const contextToolGroup = runtime.page.locator('[data-component="context-tool-group-trigger"]')
    await waitFor(
      async () => {
        const markerRendered = await runtime.page.getByText(marker, { exact: false }).count()
        const toolRendered = (await toolWrapper.count()) + (await contextToolGroup.count())
        if (markerRendered > 0 && toolRendered > 0) return true
      },
      "live renderer assistant and tool DOM",
      30_000,
    ).catch(async (error) => {
      throw new Error(
        `${String(error)}\nLive renderer diagnostics: ${JSON.stringify({
          toolWrappers: await toolWrapper.count(),
          contextToolGroups: await contextToolGroup.count(),
          markerNodes: await runtime.page.getByText(marker, { exact: false }).count(),
          turns: await runtime.page.locator('[data-component="session-turn"]').count(),
          progress: await runtime.page.locator('[data-component="session-progress"]').count(),
          body: (await runtime.page.locator("body").innerText()).slice(-4_000),
        })}`,
      )
    })
    const genericToolCount = await toolWrapper.count()
    const contextToolCount = await contextToolGroup.count()
    assert.equal(genericToolCount + contextToolCount, 1)
    if (contextToolCount === 1) {
      await contextToolGroup.click()
      assert.equal(await runtime.page.locator('[data-slot="context-tool-group-item"]').count(), 1)
    }
    await runtime.page.getByText(marker, { exact: false }).waitFor({ state: "visible", timeout: 30_000 })
    await waitFor(
      async () => {
        const label = await runtime.page.locator('[data-action="prompt-submit"]').getAttribute("aria-label")
        if (label && !/stop|停止/i.test(label)) return label
      },
      "renderer terminal submit state",
      30_000,
    )
    assert.deepEqual(pageErrors, [])

    const artifactDirectory = path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."), ".artifacts/live-llm")
    await mkdir(artifactDirectory, { recursive: true })
    const screenshot = path.join(artifactDirectory, `${suite}.png`)
    await runtime.page.screenshot({ path: screenshot, fullPage: false })
    const artifact = {
      suite,
      mode: "ext",
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
        promptHash: createHash("sha256").update(prompt).digest("hex"),
        markerHash: createHash("sha256").update(marker).digest("hex"),
        userPromptPersisted: true,
        unattendedPermissionConfig: true,
        toolPartsRendered: genericToolCount + contextToolCount,
        contextToolGroupRendered: contextToolCount === 1,
        assistantMarkerRendered: true,
        terminalComposerRendered: true,
        pageErrors,
        screenshot: path.basename(screenshot),
      },
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    }
    await writeArtifact(suite, artifact)
    console.log(`${suite}: passed (deepseek/${config.modelID})`)
  } finally {
    await close(runtime)
  }
} finally {
  await closeAll()
}
