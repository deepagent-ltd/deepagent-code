import { strict as assert } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { createReadStream } from "node:fs"
import { readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { DatabaseSync } from "node:sqlite"
import {
  close,
  closeAll,
  createSession,
  focusSession,
  launch,
  loadLiveConfig,
  waitFor,
  writeArtifact,
  type Runtime,
} from "./runtime.ts"

const suite = "activity-progress-package"
const config = await loadLiveConfig()
if (config.modelID !== "deepseek-v4-flash") {
  throw new Error("Packaged activity progress test requires the DeepSeek deepseek-v4-flash configuration")
}
if (process.platform !== "darwin") throw new Error("Packaged activity progress test currently requires macOS")

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const executablePath = await findPackagedExecutable(path.join(packageRoot, "dist"))
const appAsarPath = path.resolve(path.dirname(executablePath), "../Resources/app.asar")
const executableHash = await hashFile(executablePath)
const appAsarHash = await hashFile(appAsarPath)
const sourceCommit = (
  await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: path.resolve(packageRoot, "../..") })
).stdout.trim()
const marker = randomUUID().replaceAll("-", "")
const activityID = `activity-package-${marker}`
const triggerText = `package-trigger-${marker}`
const steerText = `package-steer-${marker}`
const oldProgress = `package-progress-old-${marker}`
const latestProgress = `package-progress-latest-${marker}`
const finalText = `package-final-${marker}`
const startedAt = Date.now()
let setup: Runtime | undefined
let progressRuntime: Runtime | undefined
let finalRuntime: Runtime | undefined
let root: string | undefined

try {
  setup = await launch(suite, config, { executablePath, cleanupRoot: false })
  root = setup.root
  const packaged = await setup.app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))
  assert.equal(packaged.packaged, true)
  const session = await createSession(setup, "Packaged activity progress projection", "live-ui")
  await focusSession(setup, session)
  await close(setup)
  setup = undefined

  seedProgress(path.join(root, "deepagent.sqlite"), {
    sessionID: session.id,
    workspace: path.join(root, "workspace"),
    modelID: config.modelID,
    activityID,
    triggerText,
    steerText,
    oldProgress,
    latestProgress,
  })

  progressRuntime = await launch(suite, config, { root, executablePath, cleanupRoot: false })
  const progressErrors: string[] = []
  progressRuntime.page.on("pageerror", (error) => progressErrors.push(error.stack ?? error.message))
  await progressRuntime.page
    .getByRole("heading", { name: "Packaged activity progress projection" })
    .waitFor({ state: "visible", timeout: 60_000 })
  const progressCounts = await waitFor(
    async () => {
      const counts = await textCounts(progressRuntime!, {
        triggerText,
        steerText,
        oldProgress,
        latestProgress,
        finalText,
      })
      if (counts.trigger === 1 && counts.steer === 1 && counts.oldProgress === 0 && counts.latestProgress === 1) {
        return counts
      }
    },
    "packaged latest activity progress projection",
    60_000,
  )
  assert.deepEqual(progressErrors, [])
  const artifactDirectory = path.join(packageRoot, ".artifacts/live-llm")
  const progressScreenshot = path.join(artifactDirectory, `${suite}-progress.png`)
  await progressRuntime.page.screenshot({ path: progressScreenshot, fullPage: false })
  await close(progressRuntime)
  progressRuntime = undefined

  appendFinal(path.join(root, "deepagent.sqlite"), {
    sessionID: session.id,
    workspace: path.join(root, "workspace"),
    modelID: config.modelID,
    activityID,
    parentID: ids(marker).steer,
    finalText,
  })

  finalRuntime = await launch(suite, config, { root, executablePath, cleanupRoot: false })
  const finalErrors: string[] = []
  finalRuntime.page.on("pageerror", (error) => finalErrors.push(error.stack ?? error.message))
  await finalRuntime.page
    .getByRole("heading", { name: "Packaged activity progress projection" })
    .waitFor({ state: "visible", timeout: 60_000 })
  const finalCounts = await waitFor(
    async () => {
      const counts = await textCounts(finalRuntime!, { triggerText, steerText, oldProgress, latestProgress, finalText })
      if (
        counts.trigger === 1 &&
        counts.steer === 1 &&
        counts.oldProgress === 0 &&
        counts.latestProgress === 0 &&
        counts.final === 1
      ) {
        return counts
      }
    },
    "packaged final activity projection",
    60_000,
  )
  const editor = finalRuntime.page.locator('[data-component="prompt-input"]')
  await editor.waitFor({ state: "visible", timeout: 30_000 })
  const submitLabel = await finalRuntime.page.locator('[data-action="prompt-submit"]').getAttribute("aria-label")
  assert.equal(Boolean(submitLabel && !/stop|停止/i.test(submitLabel)), true)
  assert.deepEqual(finalErrors, [])
  const finalScreenshot = path.join(packageRoot, ".artifacts/live-llm", `${suite}-final.png`)
  await finalRuntime.page.screenshot({ path: finalScreenshot, fullPage: false })

  await writeArtifact(suite, {
    suite,
    mode: "release",
    stack: "packaged-renderer-ui",
    status: "passed",
    fingerprint: {
      providerID: "deepseek",
      runtimeProviderID: "live-deepseek",
      modelID: config.modelID,
      modelRevision: config.modelRevision,
      baseURL: config.baseURL,
    },
    package: {
      sourceCommit,
      version: packaged.version,
      executable: path.relative(packageRoot, executablePath),
      executableHash,
      appAsarHash,
      isPackaged: packaged.packaged,
    },
    evidence: {
      sessionID: session.id,
      activityIDHash: createHash("sha256").update(activityID).digest("hex"),
      progressCounts,
      finalCounts,
      progressScreenshot: path.basename(progressScreenshot),
      finalScreenshot: path.basename(finalScreenshot),
      pageErrors: [...progressErrors, ...finalErrors],
      terminalComposerRendered: true,
    },
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  })
  console.log(`${suite}: passed (${path.basename(executablePath)}, progress -> final)`)
} finally {
  if (setup) await close(setup).catch(() => undefined)
  if (progressRuntime) await close(progressRuntime).catch(() => undefined)
  if (finalRuntime) await close(finalRuntime).catch(() => undefined)
  await closeAll()
  if (root && process.env.DEEPAGENT_CODE_KEEP_LIVE_SMOKE !== "1") await rm(root, { recursive: true, force: true })
}

function seedProgress(
  databasePath: string,
  input: {
    sessionID: string
    workspace: string
    modelID: string
    activityID: string
    triggerText: string
    steerText: string
    oldProgress: string
    latestProgress: string
  },
) {
  const database = new DatabaseSync(databasePath)
  const value = ids(marker)
  const now = Date.now()
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
    insertMessage(database, value.trigger, input.sessionID, now, user(input.triggerText, now, input.modelID))
    insertPart(database, value.triggerPart, value.trigger, input.sessionID, now, {
      type: "text",
      text: input.triggerText,
    })
    insertMessage(
      database,
      value.oldAssistant,
      input.sessionID,
      now + 1,
      assistant(value.trigger, now + 1, input.workspace, input.modelID, "tool-calls"),
    )
    insertPart(database, value.oldProgressPart, value.oldAssistant, input.sessionID, now + 1, {
      type: "text",
      text: input.oldProgress,
      metadata: { deepagent_activity_progress: { activity_id: input.activityID, revision: 0, state: "progress" } },
    })
    insertMessage(database, value.steer, input.sessionID, now + 2, user(input.steerText, now + 2, input.modelID))
    insertPart(database, value.steerPart, value.steer, input.sessionID, now + 2, {
      type: "text",
      text: input.steerText,
    })
    insertMessage(
      database,
      value.latestAssistant,
      input.sessionID,
      now + 3,
      assistant(value.steer, now + 3, input.workspace, input.modelID, "tool-calls"),
    )
    insertPart(database, value.latestProgressPart, value.latestAssistant, input.sessionID, now + 3, {
      type: "text",
      text: input.latestProgress,
      metadata: { deepagent_activity_progress: { activity_id: input.activityID, revision: 1, state: "progress" } },
    })
    database.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(now + 3, input.sessionID)
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  } finally {
    database.close()
  }
}

function appendFinal(
  databasePath: string,
  input: {
    sessionID: string
    workspace: string
    modelID: string
    activityID: string
    parentID: string
    finalText: string
  },
) {
  const database = new DatabaseSync(databasePath)
  const value = ids(marker)
  const now = Date.now()
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
    insertMessage(
      database,
      value.finalAssistant,
      input.sessionID,
      now,
      assistant(input.parentID, now, input.workspace, input.modelID, "stop"),
    )
    insertPart(database, value.finalPart, value.finalAssistant, input.sessionID, now, {
      type: "text",
      text: input.finalText,
      metadata: { deepagent_activity_progress: { activity_id: input.activityID, revision: 2, state: "final" } },
    })
    database.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(now, input.sessionID)
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  } finally {
    database.close()
  }
}

function insertMessage(database: DatabaseSync, id: string, sessionID: string, time: number, data: object) {
  database
    .prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
    .run(id, sessionID, time, time, JSON.stringify(data))
}

function insertPart(
  database: DatabaseSync,
  id: string,
  messageID: string,
  sessionID: string,
  time: number,
  data: object,
) {
  database
    .prepare(
      "INSERT INTO part (id, message_id, session_id, provenance, time_created, time_updated, data) VALUES (?, ?, ?, NULL, ?, ?, ?)",
    )
    .run(id, messageID, sessionID, time, time, JSON.stringify(data))
}

function user(text: string, created: number, modelID: string) {
  return {
    role: "user",
    time: { created },
    agent: "live-ui",
    model: { providerID: "live-deepseek", modelID },
    metadata: { packageProjectionFixture: true, textHash: createHash("sha256").update(text).digest("hex") },
  }
}

function assistant(parentID: string, created: number, workspace: string, modelID: string, finish: string) {
  return {
    role: "assistant",
    time: { created, completed: created + 1 },
    parentID,
    modelID,
    providerID: "live-deepseek",
    mode: "general",
    agent: "live-ui",
    path: { cwd: workspace, root: workspace },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish,
  }
}

function ids(value: string) {
  return {
    trigger: `msg_pkg_trigger_${value}`,
    triggerPart: `prt_pkg_trigger_${value}`,
    oldAssistant: `msg_pkg_old_${value}`,
    oldProgressPart: `prt_pkg_old_${value}`,
    steer: `msg_pkg_steer_${value}`,
    steerPart: `prt_pkg_steer_${value}`,
    latestAssistant: `msg_pkg_latest_${value}`,
    latestProgressPart: `prt_pkg_latest_${value}`,
    finalAssistant: `msg_pkg_final_${value}`,
    finalPart: `prt_pkg_final_${value}`,
  }
}

async function textCounts(
  runtime: Runtime,
  input: { triggerText: string; steerText: string; oldProgress: string; latestProgress: string; finalText: string },
) {
  return {
    trigger: await runtime.page.getByText(input.triggerText, { exact: false }).count(),
    steer: await runtime.page.getByText(input.steerText, { exact: false }).count(),
    oldProgress: await runtime.page.getByText(input.oldProgress, { exact: false }).count(),
    latestProgress: await runtime.page.getByText(input.latestProgress, { exact: false }).count(),
    final: await runtime.page.getByText(input.finalText, { exact: false }).count(),
  }
}

async function findPackagedExecutable(directory: string) {
  const candidates: Array<{ path: string; modified: number }> = []
  async function visit(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(target)
        continue
      }
      const segments = path.relative(directory, target).split(path.sep)
      const app = segments.findIndex((segment) => segment.endsWith(".app"))
      if (app === -1 || segments[app + 1] !== "Contents" || segments[app + 2] !== "MacOS") continue
      const info = await stat(target)
      if ((info.mode & 0o111) !== 0) candidates.push({ path: target, modified: info.mtimeMs })
    }
  }
  await visit(directory)
  const executable = candidates.sort((left, right) => right.modified - left.modified)[0]?.path
  if (!executable) throw new Error(`No packaged macOS executable found under ${directory}`)
  return executable
}

function hashFile(file: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256")
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
  })
}
