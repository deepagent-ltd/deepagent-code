#!/usr/bin/env bun

import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { validateLiveLLMKeyFile } from "../packages/llm/script/live-llm/config"

export type RunnerConfig = {
  baseURL: string
  apiKeyFile: string
  model: string
  modelRevision?: string
  requestTimeoutMs: number
  suiteTimeoutMs: number
  evalRuns: number
  installDependencies: boolean
}

export type Suite = {
  id: string
  package: "root" | "llm" | "core" | "deepagent-code" | "desktop"
  command: string[]
  realLLM: boolean
  desktop?: boolean
  eval?: boolean
  install?: boolean
  packageScript?: string
  gate?: boolean
}

const repository = path.resolve(import.meta.dir, "..")
const defaultConfigFile = path.join(import.meta.dir, "live-llm.config.local.json")
const reportFile = path.join(repository, "packages/llm/.artifacts/live-llm/all-tests.json")
export const defaultModelsSnapshotFile = path.join(
  repository,
  "packages/deepagent-code/test/tool/fixtures/models-api.json",
)

export const suites: Suite[] = [
  {
    id: "setup:install",
    package: "root",
    command: ["bun", "install", "--frozen-lockfile"],
    realLLM: false,
    install: true,
    gate: true,
  },
  {
    id: "det:core-sandbox",
    package: "core",
    command: ["bun", "run", "test:llm-sandbox"],
    realLLM: false,
    gate: true,
  },
  {
    id: "det:core-contracts",
    package: "core",
    command: ["bun", "run", "test:llm-det:contracts"],
    realLLM: false,
    gate: true,
  },
  {
    id: "det:deepagent-routes",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-routes"],
    realLLM: false,
    gate: true,
  },
  {
    id: "det:deepagent-contracts",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-det:contracts"],
    realLLM: false,
    gate: true,
  },
  {
    id: "live:adapter-provider",
    package: "llm",
    command: ["bun", "run", "test:llm-live:provider"],
    realLLM: true,
  },
  {
    id: "live:adapter-structured",
    package: "llm",
    command: ["bun", "run", "test:llm-live:structured-adapter"],
    realLLM: true,
  },
  {
    id: "ext:adapter-abort",
    package: "llm",
    command: ["bun", "run", "test:llm-ext:provider-abort"],
    realLLM: true,
  },
  {
    id: "live:core-v2-provider-loop",
    package: "core",
    command: ["bun", "run", "test:llm-live:v2-provider-loop"],
    realLLM: true,
  },
  {
    id: "live:core-file-read",
    package: "core",
    command: ["bun", "run", "test:llm-live:file-read"],
    realLLM: true,
  },
  {
    id: "live:core-file-mutations",
    package: "core",
    command: ["bun", "run", "test:llm-live:file-mutations"],
    realLLM: true,
  },
  {
    id: "ext:core-file-read",
    package: "core",
    command: ["bun", "run", "test:llm-ext:file-read"],
    realLLM: true,
  },
  {
    id: "ext:core-file-mutations",
    package: "core",
    command: ["bun", "run", "test:llm-ext:file-mutations"],
    realLLM: true,
  },
  {
    id: "live:core-bash-repair",
    package: "core",
    command: ["bun", "run", "test:llm-live:bash-repair"],
    realLLM: true,
  },
  {
    id: "live:legacy-structured",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:structured-legacy"],
    realLLM: true,
  },
  {
    id: "live:cli-headless",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:cli-headless"],
    realLLM: true,
  },
  {
    id: "live:legacy-file-read",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:file-read"],
    realLLM: true,
  },
  {
    id: "live:legacy-file-mutations",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:file-mutations"],
    realLLM: true,
  },
  {
    id: "ext:legacy-file-read",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:file-read"],
    realLLM: true,
  },
  {
    id: "ext:legacy-file-mutations",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:file-mutations"],
    realLLM: true,
  },
  {
    id: "live:legacy-bash-repair",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:bash-repair"],
    realLLM: true,
  },
  {
    id: "ext:legacy-bash-truncation",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:bash-truncation"],
    realLLM: true,
  },
  {
    id: "ext:legacy-failure-recovery",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:failure-recovery"],
    realLLM: true,
  },
  {
    id: "ext:legacy-tool-ecosystem",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:tool-ecosystem"],
    realLLM: true,
  },
  {
    id: "live:subagent-foreground",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:subagent-foreground"],
    realLLM: true,
  },
  {
    id: "live:subagent-control-plane",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:subagent-control-plane"],
    realLLM: true,
  },
  {
    id: "live:shell-exit-contract",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:shell-exit-contract"],
    realLLM: true,
  },
  {
    id: "live:stale-validation",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:stale-validation"],
    realLLM: true,
  },
  {
    id: "live:continuation-repetition",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:continuation-repetition"],
    realLLM: true,
  },
  {
    id: "live:degeneration",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:degeneration"],
    realLLM: true,
  },
  {
    id: "live:plan-advance",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:plan-advance"],
    realLLM: true,
  },
  {
    id: "ext:finalizer-isolation",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:finalizer-isolation"],
    realLLM: true,
  },
  {
    id: "live:steer-boundary",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-live:steer-boundary"],
    realLLM: true,
  },
  {
    id: "ext:subagent-worktree",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:subagent-worktree"],
    realLLM: true,
  },
  {
    id: "ext:multi-agent-dag",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:multi-agent-dag"],
    realLLM: true,
  },
  {
    id: "ext:multi-agent-parallel-worktrees",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:multi-agent-parallel-worktrees"],
    realLLM: true,
  },
  {
    id: "ext:multi-agent-pr-collaboration",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:multi-agent-pr-collaboration"],
    realLLM: true,
  },
  {
    id: "ext:v4-multi-agent-runtime",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:v4-multi-agent-runtime"],
    realLLM: true,
  },
  {
    id: "ext:subagent-intensity",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:subagent-intensity"],
    realLLM: true,
  },
  {
    id: "ext:subagent-resume",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:subagent-resume"],
    realLLM: true,
  },
  {
    id: "ext:subagent-takeover",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:subagent-takeover"],
    realLLM: true,
  },
  {
    id: "ext:subagent-interrupted",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:subagent-interrupted"],
    realLLM: true,
  },
  {
    id: "ext:subagent-background",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:subagent-background"],
    realLLM: true,
  },
  {
    id: "ext:permissions-deny",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:permissions-deny"],
    realLLM: true,
  },
  {
    id: "ext:mcp-marker",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:mcp-marker"],
    realLLM: true,
  },
  {
    id: "ext:long-session",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:long-session"],
    realLLM: true,
  },
  {
    id: "ext:goal-cli",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:goal-cli"],
    realLLM: true,
  },
  {
    id: "ext:compaction-retention",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:compaction-retention"],
    realLLM: true,
  },
  {
    id: "ext:expert-panel",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:expert-panel"],
    realLLM: true,
  },
  {
    id: "ext:intelligence-draft",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:intelligence-draft"],
    realLLM: true,
  },
  {
    id: "ext:prompt-intent-fencing",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-ext:prompt-intent-fencing"],
    realLLM: true,
  },
  {
    id: "eval:autonomous",
    package: "deepagent-code",
    command: ["bun", "run", "test:llm-eval:autonomous"],
    realLLM: true,
    eval: true,
  },
  {
    id: "setup:desktop-build",
    package: "desktop",
    command: ["bun", "run", "build"],
    realLLM: false,
    desktop: true,
  },
  {
    id: "det:desktop-sidecar",
    package: "desktop",
    command: ["node", "--experimental-strip-types", "./scripts/subagents-smoke.ts"],
    realLLM: false,
    desktop: true,
  },
  {
    id: "ext:desktop-sidecar",
    package: "desktop",
    command: ["node", "--experimental-strip-types", "./scripts/live-llm/packaged-sidecar.ts"],
    realLLM: true,
    desktop: true,
    packageScript: "test:llm-ext:sidecar",
  },
  {
    id: "release:desktop-subagents",
    package: "desktop",
    command: ["node", "--experimental-strip-types", "./scripts/live-llm/desktop-subagents.ts"],
    realLLM: true,
    desktop: true,
    packageScript: "test:llm-release:subagents",
  },
  {
    id: "release:desktop-ui",
    package: "desktop",
    command: ["node", "--experimental-strip-types", "./scripts/live-llm/desktop-ui.ts"],
    realLLM: true,
    desktop: true,
    packageScript: "test:llm-release:ui",
  },
  {
    id: "release:desktop-long-session",
    package: "desktop",
    command: ["node", "--experimental-strip-types", "./scripts/live-llm/long-session.ts"],
    realLLM: true,
    desktop: true,
    packageScript: "test:llm-release:long-session",
  },
  {
    id: "release:desktop-observed",
    package: "desktop",
    command: ["node", "--experimental-strip-types", "./scripts/live-llm/desktop-observed.ts"],
    realLLM: true,
    desktop: true,
    packageScript: "test:llm-release:observed",
  },
]

export function selectSuites(input: {
  headless: boolean
  skipEval: boolean
  skipInstall: boolean
  installDependencies: boolean
}) {
  return suites.filter((suite) => {
    if (input.headless && suite.desktop) return false
    if (input.skipEval && suite.eval) return false
    if ((input.skipInstall || !input.installDependencies) && suite.install) return false
    return true
  })
}

export function runnerEnvironment(
  config: RunnerConfig,
  hostEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  includeCredential = false,
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      [
        "PATH",
        "TMPDIR",
        "SHELL",
        "LANG",
        "LC_ALL",
        "TERM",
        "COLORTERM",
        "NO_COLOR",
        "FORCE_COLOR",
        "CI",
        "BUN_INSTALL",
        "USER",
        "LOGNAME",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
      ].flatMap((key) => (hostEnvironment[key] === undefined ? [] : ([[key, hostEnvironment[key]]] as const))),
    ),
    MODELS_DEV_API_JSON: hostEnvironment.MODELS_DEV_API_JSON ?? defaultModelsSnapshotFile,
    ...(includeCredential
      ? {
          DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: config.apiKeyFile,
          DEEPAGENT_CODE_LIVE_LLM_BASE_URL: config.baseURL,
          DEEPAGENT_CODE_LIVE_LLM_MODEL: config.model,
          DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS: String(config.requestTimeoutMs),
          DEEPAGENT_CODE_LIVE_LLM_EVAL_RUNS: String(config.evalRuns),
          ...(config.modelRevision ? { DEEPAGENT_CODE_LIVE_LLM_REVISION: config.modelRevision } : {}),
        }
      : {}),
  }
}

export function validateRunnerConfig(input: unknown, baseDirectory = repository): RunnerConfig {
  if (!isRecord(input)) throw new Error("Live LLM config must be a JSON object")
  if ("apiKey" in input) {
    throw new Error(
      "Legacy live LLM JSON field apiKey is not accepted; move the key to a chmod 600 one-line file and " +
        "set apiKeyFile (recommended: ~/.deepagent/code/tmp/live-llm-deepseek.key)",
    )
  }
  const baseURL = requiredString(input.baseURL, "baseURL")
  if (!URL.canParse(baseURL)) throw new Error("baseURL must be a valid URL")
  const endpoint = new URL(baseURL)
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.deepseek.com") {
    throw new Error(
      `Real LLM suites currently require the official https://api.deepseek.com endpoint, received ${baseURL}`,
    )
  }
  const apiKeyFile = resolveKeyFile(requiredString(input.apiKeyFile, "apiKeyFile"), baseDirectory)
  const modelRevision = optionalString(input.modelRevision)
  return {
    baseURL: baseURL.replace(/\/$/, ""),
    apiKeyFile,
    model: requiredString(input.model, "model"),
    ...(modelRevision ? { modelRevision } : {}),
    requestTimeoutMs: integer(input.requestTimeoutMs, "requestTimeoutMs", 1_000, 15 * 60_000),
    suiteTimeoutMs: integer(input.suiteTimeoutMs, "suiteTimeoutMs", 60_000, 60 * 60_000),
    evalRuns: integer(input.evalRuns, "evalRuns", 1, 20),
    installDependencies: boolean(input.installDependencies, "installDependencies"),
  }
}

export async function validateSuiteManifest() {
  const inventory = await loadRealLLMSuiteInventory()
  const registered = suites
    .filter((suite) => suite.realLLM)
    .map((suite) => {
      const packageScript = suite.packageScript ?? suite.command.at(-1)
      if (!packageScript?.startsWith("test:llm-")) {
        throw new Error(`${suite.id} does not identify its package script`)
      }
      return `${suite.package}:${packageScript}`
    })
  const missing = inventory.filter((script) => !registered.includes(script))
  const stale = registered.filter((script) => !inventory.includes(script))
  if (missing.length || stale.length) {
    throw new Error(
      `Real LLM suite manifest is out of date` +
        `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
        `${stale.length ? `; stale: ${stale.join(", ")}` : ""}`,
    )
  }
}

export async function loadRealLLMSuiteInventory() {
  return (
    await Promise.all(
      (["llm", "core", "deepagent-code", "desktop"] as const).map(async (packageName) => {
        const payload: unknown = await Bun.file(path.join(repository, "packages", packageName, "package.json")).json()
        if (!isRecord(payload) || !isRecord(payload.scripts)) {
          throw new Error(`packages/${packageName}/package.json does not contain a scripts object`)
        }
        return Object.keys(payload.scripts)
          .filter(
            (script) =>
              script.startsWith("test:llm-") &&
              script !== "test:llm-routes" &&
              script !== "test:llm-sandbox" &&
              !script.startsWith("test:llm-det:"),
          )
          .map((script) => `${packageName}:${script}`)
      }),
    )
  ).flat()
}

async function main() {
  const options = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", default: defaultConfigFile },
      headless: { type: "boolean", default: false },
      "skip-eval": { type: "boolean", default: false },
      "skip-install": { type: "boolean", default: false },
      "stop-on-failure": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  }).values
  const configFile = path.resolve(options.config)
  if (!(await Bun.file(configFile).exists())) {
    throw new Error(
      `Live LLM config not found: ${configFile}\n` +
        `Create it with: cp script/live-llm.config.example.json script/live-llm.config.local.json`,
    )
  }
  const config = validateRunnerConfig(await Bun.file(configFile).json(), path.dirname(configFile))
  await validateSuiteManifest()
  if (!options["dry-run"]) await validateLiveLLMKeyFile(config.apiKeyFile)
  const selected = selectSuites({
    headless: options.headless,
    skipEval: options["skip-eval"],
    skipInstall: options["skip-install"],
    installDependencies: config.installDependencies,
  })
  const realCount = selected.filter((suite) => suite.realLLM).length
  console.log(
    `Real LLM all-tests: ${selected.length} commands (${realCount} model suites), ` +
      `model=${config.model}, endpoint=${config.baseURL}`,
  )
  if (options["dry-run"]) {
    selected.forEach((suite, index) => console.log(`${index + 1}. ${suite.id}: ${suite.command.join(" ")}`))
    return
  }

  const results: Array<{
    id: string
    package: Suite["package"]
    realLLM: boolean
    status: "passed" | "failed" | "timed-out" | "reported"
    exitCode: number
    durationMs: number
    evaluation?: {
      passed: number
      runs: number
      successRate: number
      score: { earnedPoints: number; possiblePoints: number; normalized: number; outOf100: number }
    }
    reportError?: string
  }> = []
  let interrupted = false
  let activePID: number | undefined
  const interrupt = () => {
    interrupted = true
    if (activePID) terminateProcessTree(activePID)
  }
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)

  for (const [index, suite] of selected.entries()) {
    if (interrupted) break
    console.log(`\n[${index + 1}/${selected.length}] START ${suite.id}`)
    const startedAt = Date.now()
    const subprocess = Bun.spawn(suite.command, {
      cwd: suiteDirectory(suite),
      env: runnerEnvironment(config, process.env, suite.realLLM),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      detached: process.platform !== "win32",
    })
    activePID = subprocess.pid
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      terminateProcessTree(subprocess.pid)
      setTimeout(() => {
        if (subprocess.exitCode === null) terminateProcessTree(subprocess.pid, "SIGKILL")
      }, 1_000)
    }, config.suiteTimeoutMs)
    const exitCode = await subprocess.exited
    clearTimeout(timeout)
    activePID = undefined
    const evaluationResult =
      suite.eval && !timedOut && exitCode === 0
        ? await readEvaluationSummary().then(
            (evaluation) => ({ evaluation }),
            (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
          )
        : undefined
    const status = timedOut
      ? "timed-out"
      : exitCode !== 0 || (evaluationResult && "error" in evaluationResult)
        ? "failed"
        : suite.eval
          ? "reported"
          : "passed"
    results.push({
      id: suite.id,
      package: suite.package,
      realLLM: suite.realLLM,
      status,
      exitCode,
      durationMs: Date.now() - startedAt,
      ...(evaluationResult && "evaluation" in evaluationResult ? { evaluation: evaluationResult.evaluation } : {}),
      ...(evaluationResult && "error" in evaluationResult ? { reportError: evaluationResult.error } : {}),
    })
    console.log(`[${index + 1}/${selected.length}] ${status.toUpperCase()} ${suite.id}`)
    if (status !== "passed" && status !== "reported" && suite.gate) {
      console.error(`${suite.id} is a safety gate; real model execution will not continue`)
      break
    }
    if (status !== "passed" && status !== "reported" && options["stop-on-failure"]) break
  }

  process.off("SIGINT", interrupt)
  process.off("SIGTERM", interrupt)
  await mkdir(path.dirname(reportFile), { recursive: true })
  await Bun.write(
    reportFile,
    `${JSON.stringify(
      {
        suite: "all-live-llm-tests",
        status: interrupted
          ? "interrupted"
          : results.every((result) => result.status === "passed" || result.status === "reported")
            ? "passed"
            : "failed",
        fingerprint: {
          providerID: "deepseek",
          baseURL: config.baseURL,
          modelID: config.model,
          modelRevision: config.modelRevision,
        },
        selected: selected.length,
        completed: results.length,
        results,
        completedAt: new Date().toISOString(),
      },
      undefined,
      2,
    )}\n`,
  )

  console.log("\nReal LLM all-tests summary")
  results.forEach((result) => {
    console.log(
      `${result.status === "passed" ? "PASS" : result.status === "reported" ? "REPORTED" : "FAIL"} ` +
        `${result.id} ${(result.durationMs / 1000).toFixed(1)}s` +
        `${
          result.evaluation
            ? ` (${result.evaluation.score.outOf100.toFixed(2)}/100, ` +
              `${result.evaluation.score.earnedPoints}/${result.evaluation.score.possiblePoints} points, ` +
              `${result.evaluation.passed}/${result.evaluation.runs} full-task passes)`
            : ""
        }`,
    )
  })
  console.log(`Report: ${reportFile}`)
  if (interrupted || results.some((result) => result.status !== "passed" && result.status !== "reported")) {
    process.exitCode = 1
  }
}

async function readEvaluationSummary() {
  const payload: unknown = await Bun.file(
    path.join(repository, "packages/llm/.artifacts/live-llm/autonomous-eval.json"),
  ).json()
  return parseEvaluationSummary(payload)
}

export function parseEvaluationSummary(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.report)) throw new Error("Autonomous eval artifact has no report")
  const passed = payload.report.passed
  const runs = payload.report.runs
  const successRate = payload.report.successRate
  const score = payload.report.score
  if (typeof passed !== "number" || typeof runs !== "number" || typeof successRate !== "number") {
    throw new Error("Autonomous eval report has invalid counters")
  }
  if (
    !isRecord(score) ||
    typeof score.earnedPoints !== "number" ||
    typeof score.possiblePoints !== "number" ||
    typeof score.normalized !== "number" ||
    typeof score.outOf100 !== "number"
  ) {
    throw new Error("Autonomous eval report has an invalid normalized score")
  }
  return {
    passed,
    runs,
    successRate,
    score: {
      earnedPoints: score.earnedPoints,
      possiblePoints: score.possiblePoints,
      normalized: score.normalized,
      outOf100: score.outOf100,
    },
  }
}

function suiteDirectory(suite: Suite) {
  if (suite.package === "root") return repository
  return path.join(repository, "packages", suite.package)
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

function resolveKeyFile(file: string, baseDirectory: string) {
  if (file.startsWith("~/")) return path.join(os.homedir(), file.slice(2))
  return path.isAbsolute(file) ? file : path.resolve(baseDirectory, file)
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalString(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error("modelRevision must be a string")
  return value.trim() || undefined
}

function integer(value: unknown, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

function boolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

if (import.meta.main) await main()
