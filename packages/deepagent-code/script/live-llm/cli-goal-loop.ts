import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareToolSandbox } from "../../../core/script/live-llm/sandbox"
import {
  loadLiveLLMConfig,
  modelFingerprint,
  preflightLiveLLM,
  writeLiveArtifact,
} from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import {
  assertGoalCliLifecycleOrder,
  assertGoalCliVerifierEvidence,
  type GoalCliToolEvidence,
  requirePostFeedbackMutations,
} from "./goal-cli-oracle"
import { liveSubprocessEnvironment, liveWorkspaceConfig, runtimeProviderID } from "./runtime"

const config = await loadLiveLLMConfig()
const preflight = await preflightLiveLLM(config)
const testRoot = await mkdtemp(path.join(os.tmpdir(), "deepagent-code-goal-cli-live-"))
const workspace = path.join(testRoot, "workspace")
const home = path.join(testRoot, "home")
const data = path.join(testRoot, "deepagent-home")
const startedAt = Date.now()

try {
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(path.join(data, "node_modules"), { recursive: true }),
  ])
  const canonicalWorkspace = await realpath(workspace)
  await Promise.all([
    Bun.write(path.join(workspace, "result.txt"), "BROKEN\n"),
    Bun.write(path.join(workspace, "feedback.txt"), "PENDING\n"),
    Bun.write(path.join(workspace, "package.json"), JSON.stringify({ private: true })),
    Bun.write(
      path.join(data, "package.json"),
      JSON.stringify({ private: true, dependencies: { "@deepagent-code/plugin": "workspace:*" } }),
    ),
    Bun.write(
      path.join(data, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": { dependencies: { "@deepagent-code/plugin": "workspace:*" } } },
      }),
    ),
  ])

  const sandbox = await prepareToolSandbox({
    workspace,
    testRoot,
    verifierScript: "#!/bin/sh\nexit 1\n",
  })
  const validationLauncher = `.live-llm-grader-${crypto.randomUUID()}`
  const validationCommand = `./${validationLauncher}`
  const expectedFeedback = `tests_pass: one or more of [${validationCommand}] failed`
  const verifier = path.join(workspace, ".live-llm-harness/oracle/verify")
  await chmod(verifier, 0o755)
  await Bun.write(
    verifier,
    [
      "#!/bin/sh",
      "set -eu",
      'test "$(cat result.txt)" = "OK"',
      "test -f feedback.txt",
      `test "$(cat feedback.txt)" = ${quote(expectedFeedback)}`,
      "",
    ].join("\n"),
  )
  await chmod(verifier, 0o555)
  await Bun.write(path.join(workspace, validationLauncher), `#!/bin/sh\nexec ${quote(sandbox.shell)} -c ./verify\n`)
  await chmod(path.join(workspace, validationLauncher), 0o555)
  await mkdir(path.join(workspace, ".deepagent-code/plans"), { recursive: true })
  await Bun.write(
    path.join(workspace, ".deepagent-code/plans/goal+plan.md"),
    [
      "## Goal",
      "Repair result.txt and preserve the exact grader feedback that made the repair necessary.",
      "",
      "## Criteria",
      "- plan complete",
      `- tests pass: \`${validationCommand}\``,
      "",
      "## Plan",
      "- [>] After the GRADER FEEDBACK block appears, make result.txt exactly OK and replace PENDING in feedback.txt with the exact tests_pass gap text from the previous tick, including its short ./grader command. The GRADER FEEDBACK block renders gaps as list items: copy only the text after the leading '- ' marker. feedback.txt must begin exactly with 'tests_pass:' and must not contain a leading hyphen, bullet, quote, or backtick. If reading is necessary, invoke read only on result.txt and feedback.txt directly; never call read on ., the workspace path, or any directory. Treat the GRADER FEEDBACK block as authoritative: never inspect or execute grader, verifier, dotfile, or harness paths. If no GRADER FEEDBACK block is visible yet, do not mutate either file and do not invent feedback: keep this same step active for the next tick. Do not add, remove, rename, or rewrite plan steps. Mark step_1 done only after both files are correct. — acceptance: result.txt is exactly OK and feedback.txt is the exact previous tests_pass gap without its list marker",
      "",
    ].join("\n"),
  )

  const initialExitCode = await runVerifier(sandbox.shell, workspace)
  if (initialExitCode === 0) throw new Error("D2/E1 hidden verifier passed before the Goal Loop ran")

  const permission = {
    "*": "deny",
    read: { "*": "deny", "result.txt": "allow", "feedback.txt": "allow" },
    edit: { "*": "deny", "result.txt": "allow", "feedback.txt": "allow" },
    plan: "allow",
  } as const
  const workspaceConfig = {
    ...liveWorkspaceConfig(config, permission, permission, undefined, {
      modelMaxTokens: 1024,
      maxProviderTurns: 8,
    }),
    shell: sandbox.shell,
  }
  const environment = liveSubprocessEnvironment({
    HOME: home,
    XDG_CONFIG_HOME: path.join(testRoot, "config"),
    XDG_DATA_HOME: path.join(testRoot, "data"),
    XDG_STATE_HOME: path.join(testRoot, "state"),
    XDG_CACHE_HOME: path.join(testRoot, "cache"),
    DEEPAGENT_CODE_TEST_HOME: home,
    DEEPAGENT_CODE_HOME: data,
    DEEPAGENT_CODE_CONFIG_DIR: data,
    DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify(workspaceConfig),
    DEEPAGENT_CODE_DISABLE_PROJECT_CONFIG: "1",
    DEEPAGENT_CODE_PURE: "1",
    DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
    DEEPAGENT_CODE_DISABLE_AUTOCOMPACT: "1",
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
    DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "1",
    DEEPAGENT_CODE_AUTH_CONTENT: "{}",
    DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: config.apiKeyFile,
    DEEPAGENT_ENABLED: "true",
    DEEPAGENT_MODE: "general",
    DEEPAGENT_CODE_EXPERIMENTAL_GOAL_LOOP: "true",
    DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME: "false",
    DEEPAGENT_CODE_V4_GOAL_TICK_EVENT_DRIVEN: "false",
  })

  await git(workspace, "init")
  await git(workspace, "config", "user.email", "live-llm@example.invalid")
  await git(workspace, "config", "user.name", "Live LLM")
  await git(workspace, "add", ".")
  await git(workspace, "commit", "-m", "goal fixture")

  const subprocess = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../src/index.ts"),
      "run",
      "--goal",
      "--agent",
      "loop",
      "--model",
      `${runtimeProviderID}/${config.modelID}`,
      "--format",
      "json",
    ],
    {
      cwd: canonicalWorkspace,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    },
  )
  let timedOut = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    terminateProcessTree(subprocess.pid)
    escalation = setTimeout(() => {
      if (subprocess.exitCode === null) terminateProcessTree(subprocess.pid, "SIGKILL")
    }, 1_000)
  }, config.timeoutMs * 4)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  clearTimeout(timeout)
  if (escalation) clearTimeout(escalation)
  if (timedOut) throw new Error(`Goal CLI exceeded ${config.timeoutMs * 4} ms`)

  const events = stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const value: unknown = JSON.parse(line)
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Goal CLI JSON output contained a non-object event")
      }
      return value as Record<string, unknown>
    })
  await writeLiveArtifact(config, "goal-grader-cli-entry-observed", {
    suite: "goal-grader-cli-entry",
    mode: "ext",
    stack: "cli-subprocess",
    status: "observed",
    fingerprint: { ...modelFingerprint(config), runtimeProviderID },
    preflight: { durationMs: preflight.durationMs },
    sandbox: sandbox.evidence,
    process: {
      exitCode,
      jsonEvents: events.length,
      stderrTail: stderr.replaceAll(testRoot, "<isolated-root>").slice(-2_000),
    },
    events,
    workspace: {
      result: await Bun.file(path.join(workspace, "result.txt")).text(),
      feedback: await Bun.file(path.join(workspace, "feedback.txt")).text(),
    },
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  })
  if (exitCode !== 0) {
    throw new Error(`Goal CLI exited ${exitCode}:\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-4_000)}`)
  }

  const indexedGoals = events.flatMap((event, index) =>
    event.type === "goal" ? [{ index, goal: record(event.goal, "goal event") }] : [],
  )
  const goals = indexedGoals.map((entry) => entry.goal)
  const goalStartIndex = events.findIndex((event) => event.type === "goal_start")
  const runningIndex = indexedGoals.find((entry) => entry.goal.phase === "running")?.index ?? -1
  const feedbackIndex =
    indexedGoals.find(
      (entry) => Array.isArray(entry.goal.gaps) && entry.goal.gaps.some((gap) => gap === expectedFeedback),
    )?.index ?? -1
  const doneIndex = indexedGoals.find((entry) => entry.goal.phase === "done")?.index ?? -1
  const terminalIndex = events.findIndex((event) => event.type === "session_terminal" && event.phase === "done")
  assertGoalCliLifecycleOrder({ goalStartIndex, runningIndex, feedbackIndex, doneIndex, terminalIndex })
  if (events.some((event) => event.type === "permission" || event.type === "question")) {
    throw new Error("D2/E1 requested unattended permission or question input")
  }
  const goalToolEvents = events.flatMap<GoalCliToolEvidence & { readonly completed: boolean }>((event, index) => {
    if (event.type !== "goal_tool_use") return []
    const part = record(event.part, "goal tool event")
    const state = record(part.state, "goal tool state")
    if (typeof part.tool !== "string") {
      throw new Error(`D2/E1 observed a non-completed child tool: ${JSON.stringify({ tool: part.tool, state })}`)
    }
    const input = record(state.input, "goal tool input")
    if (state.status === "completed") return [{ index, name: part.tool, input, completed: true as const }]
    if (
      state.status === "error" &&
      part.tool === "read" &&
      input.filePath === canonicalWorkspace &&
      typeof state.error === "string" &&
      state.error.includes("prevents you from using this specific tool call")
    ) {
      return [{ index, name: part.tool, input, completed: false as const }]
    }
    throw new Error(`D2/E1 observed an unexpected child tool failure: ${JSON.stringify({ tool: part.tool, state })}`)
  })
  const goalTools = goalToolEvents.filter(
    (tool): tool is GoalCliToolEvidence & { readonly completed: true } => tool.completed,
  )
  const feedbackMutations = requirePostFeedbackMutations({
    tools: goalTools,
    feedbackIndex,
    workspace: canonicalWorkspace,
    files: ["feedback.txt", "result.txt"],
  })

  const finalExitCode = await runVerifier(sandbox.shell, workspace)
  const changedPaths = (await git(workspace, "status", "--short", "--untracked-files=all"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.slice(3))
    .toSorted()
  if (
    ![expectedFeedback, `${expectedFeedback}\n`].includes(await Bun.file(path.join(workspace, "feedback.txt")).text())
  ) {
    throw new Error("D2 worker did not persist the exact prior grader feedback")
  }
  const changedStats = await Promise.all(
    changedPaths.map(async (file) => ({ file, stat: await lstat(path.join(workspace, file)) })),
  )
  if (changedStats.some((item) => !item.stat.isFile() || (item.stat.mode & 0o111) !== 0)) {
    throw new Error("D2/E1 produced a symlink, non-file, or executable mutation")
  }

  const fresh = path.join(workspace, `.live-llm-fresh-${crypto.randomUUID()}`)
  await mkdir(fresh)
  let freshExitCode = -1
  try {
    await Promise.all(
      ["result.txt", "feedback.txt"].map((file) => copyFile(path.join(workspace, file), path.join(fresh, file))),
    )
    freshExitCode = await runVerifier(sandbox.shell, fresh, "../verify")
    const stats = await Promise.all(["result.txt", "feedback.txt"].map((file) => lstat(path.join(fresh, file))))
    if (stats.some((stat) => !stat.isFile())) {
      throw new Error(`D2/E1 fresh-copy verifier failed: ${freshExitCode}`)
    }
  } finally {
    await rm(fresh, { recursive: true, force: true })
  }
  assertGoalCliVerifierEvidence({
    initialExitCode,
    finalExitCode,
    freshCopyExitCode: freshExitCode,
    changedPaths,
    expectedPaths: ["feedback.txt", "result.txt"],
  })

  const artifact = {
    suite: "goal-grader-cli-entry",
    mode: "ext" as const,
    stack: "cli-subprocess" as const,
    status: "passed" as const,
    fingerprint: { ...modelFingerprint(config), runtimeProviderID },
    preflight: { durationMs: preflight.durationMs },
    sandbox: sandbox.evidence,
    process: {
      exitCode,
      jsonEvents: events.length,
      stderrTail: stderr.replaceAll(testRoot, "<isolated-root>").slice(-2_000),
    },
    evidence: {
      goalEventCount: goals.length,
      feedbackHash: Bun.hash(expectedFeedback).toString(16),
      firstTickFeedbackObserved: true,
      eventOrder: { goalStartIndex, runningIndex, feedbackIndex, doneIndex, terminalIndex },
      goalToolSequence: goalTools.map((tool) => tool.name),
      deniedWorkspaceReadCount: goalToolEvents.filter((tool) => !tool.completed).length,
      feedbackMutationIndices: feedbackMutations.map((tool) => tool.index),
      terminalPhase: "done",
      initialVerifierExitCode: initialExitCode,
      finalVerifierExitCode: finalExitCode,
      freshCopyVerifierExitCode: freshExitCode,
      changedPaths,
      permissionRequestCount: 0,
      questionRequestCount: 0,
    },
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  }
  await writeLiveArtifact(config, artifact.suite, artifact)
  console.log(
    `${artifact.suite}: passed (${artifact.fingerprint.providerID}/${artifact.fingerprint.modelID}, ` +
      `${goals.length} goal events, ${artifact.durationMs} ms)`,
  )
} finally {
  await rm(testRoot, { recursive: true, force: true })
}

finishLiveScript()

async function runVerifier(shell: string, cwd: string, verifier = "./verify") {
  const process = Bun.spawn([shell, "-c", verifier], { cwd, stdout: "ignore", stderr: "ignore" })
  return process.exited
}

async function git(directory: string, ...args: string[]) {
  const process = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim() || exitCode}`)
  return stdout
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

function quote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function terminateProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  if (process.platform === "win32") {
    Bun.spawn(["taskkill", "/pid", String(pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      return
    }
  }
}
