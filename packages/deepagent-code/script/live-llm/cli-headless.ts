import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  loadLiveLLMConfig,
  modelFingerprint,
  preflightLiveLLM,
  writeLiveArtifact,
} from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { liveSubprocessEnvironment, liveWorkspaceConfig, runtimeProviderID } from "./runtime"

const config = await loadLiveLLMConfig()
const preflight = await preflightLiveLLM(config)
const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-code-cli-live-"))
const workspace = path.join(root, "workspace")
const home = path.join(root, "home")
const data = path.join(root, "deepagent-home")
const attachmentMarker = `attachment-${crypto.randomUUID()}`
const readMarker = `read-${crypto.randomUUID()}`
const startedAt = Date.now()

try {
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(path.join(data, "node_modules"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(path.join(workspace, "attachment.txt"), `${attachmentMarker}\n`),
    Bun.write(path.join(workspace, "private.txt"), `${readMarker}\n`),
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

  const environment = liveSubprocessEnvironment({
    HOME: home,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    DEEPAGENT_CODE_TEST_HOME: home,
    DEEPAGENT_CODE_HOME: data,
    DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify(
      liveWorkspaceConfig(
        config,
        { "*": "deny", read: { "*": "deny", "private.txt": "ask" } },
        { "*": "deny", read: { "*": "deny", "private.txt": "ask" } },
      ),
    ),
    DEEPAGENT_CODE_DISABLE_PROJECT_CONFIG: "1",
    DEEPAGENT_CODE_PURE: "1",
    DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
    DEEPAGENT_CODE_DISABLE_AUTOCOMPACT: "1",
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
    DEEPAGENT_CODE_AUTH_CONTENT: "{}",
    DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: config.apiKeyFile,
    DEEPAGENT_ENABLED: "false",
    DEEPAGENT_MODE: "general",
  })
  const subprocess = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../src/index.ts"),
      "run",
      [
        "The attached text file contains one private marker.",
        "Call read exactly once for private.txt to obtain the second private marker.",
        "Do not call another tool. Report both markers exactly after the read completes.",
      ].join("\n"),
      "--model",
      `${runtimeProviderID}/${config.modelID}`,
      "--agent",
      "live-test",
      "--format",
      "json",
      "--dangerously-skip-permissions",
      "--file",
      "attachment.txt",
    ],
    {
      cwd: workspace,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timeout = setTimeout(() => subprocess.kill("SIGKILL"), config.timeoutMs * 2)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  clearTimeout(timeout)

  const events = stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const value: unknown = JSON.parse(line)
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("CLI JSON output contained a non-object event")
      }
      return value as Record<string, unknown>
    })
  const permissionEvents = events.filter((event) => event.type === "permission")
  const toolEvents = events.flatMap((event) => {
    if (event.type !== "tool_use") return []
    const part = record(event.part, "CLI tool event")
    return [{ part, state: record(part.state, "CLI tool state") }]
  })
  const callIDs = new Set(
    toolEvents.flatMap((event) => (typeof event.part.callID === "string" ? [event.part.callID] : [])),
  )
  const toolInputs = toolEvents.flatMap((event) =>
    typeof event.state.input === "object" && event.state.input !== null && !Array.isArray(event.state.input)
      ? [event.state.input as Record<string, unknown>]
      : [],
  )
  const toolInputPaths = await Promise.all(
    toolInputs.map((input) =>
      typeof input.filePath === "string" ? realpath(input.filePath).catch(() => undefined) : undefined,
    ),
  )
  const expectedReadPath = await realpath(path.join(workspace, "private.txt"))
  const markerPresence = {
    attachment: stdout.includes(attachmentMarker),
    read: stdout.includes(readMarker),
  }
  await writeLiveArtifact(
    config,
    "cli-headless-observed",
    {
      suite: "cli-headless",
      mode: "live",
      stack: "cli-subprocess",
      status: "observed",
      fingerprint: { ...modelFingerprint(config), runtimeProviderID },
      preflight: { durationMs: preflight.durationMs },
      process: {
        exitCode,
        stdoutBytes: stdout.length,
        stderrTail: stderr.slice(-4_000),
        eventTypes: events.map((event) => event.type),
        markerPresence,
        permissionReplies: permissionEvents.length,
        readToolEvents: toolEvents.length,
        readToolCalls: callIDs.size,
      },
      events,
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    },
    {
      redactions: [
        { value: attachmentMarker, replacement: "<attachment-marker>" },
        { value: readMarker, replacement: "<read-marker>" },
      ],
    },
  )
  if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr.slice(-4_000)}`)
  if (!markerPresence.attachment || !markerPresence.read) {
    throw new Error("CLI final JSON stream lost an attachment or read marker")
  }
  if (permissionEvents.length !== 1 || permissionEvents[0]?.reply !== "once") {
    throw new Error(`CLI emitted ${permissionEvents.length} permission replies instead of one read approval`)
  }
  const permissionRequest = record(permissionEvents[0]?.request, "CLI permission request")
  const permissionPatterns = Array.isArray(permissionRequest.patterns)
    ? permissionRequest.patterns.filter((value): value is string => typeof value === "string")
    : []
  if (
    permissionRequest.permission !== "read" ||
    permissionPatterns.length !== 1 ||
    path.resolve(workspace, permissionPatterns[0]!) !== path.join(workspace, "private.txt")
  ) {
    throw new Error(`CLI approved an unexpected permission request: ${JSON.stringify(permissionRequest)}`)
  }
  if (
    toolEvents.length === 0 ||
    callIDs.size !== 1 ||
    toolEvents.some((event) => event.part.tool !== "read") ||
    toolInputPaths.length === 0 ||
    toolInputPaths.some((inputPath) => inputPath !== expectedReadPath)
  ) {
    throw new Error("CLI did not execute exactly one canonical private.txt read call")
  }

  const artifact = {
    suite: "cli-headless",
    mode: "live" as const,
    stack: "cli-subprocess" as const,
    status: "passed" as const,
    fingerprint: { ...modelFingerprint(config), runtimeProviderID },
    preflight: { durationMs: preflight.durationMs },
    process: {
      exitCode,
      jsonEvents: events.length,
      readToolEvents: toolEvents.length,
      readToolCalls: callIDs.size,
      permissionReplies: permissionEvents.length,
      stderrTail: stderr.replaceAll(root, "<isolated-root>").slice(-2_000),
    },
    evidence: {
      attachmentMarkerHash: Bun.hash(attachmentMarker).toString(16),
      readMarkerHash: Bun.hash(readMarker).toString(16),
      hostConfigUsed: false,
      stdinMode: "ignore",
    },
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  }
  await writeLiveArtifact(config, artifact.suite, artifact)
  console.log(
    `${artifact.suite}: passed (${artifact.fingerprint.providerID}/${artifact.fingerprint.modelID}, ` +
      `${artifact.process.jsonEvents} JSON events)`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

finishLiveScript()

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}
