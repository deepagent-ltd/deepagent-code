import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ValidationFailureKind, ValidationResult } from "./round-state"

export type ValidationCommandSource = "package_script" | "builtin" | "agents_md" | "user"
export type ValidationScriptDialect = "posix"

export type ValidationCommand =
  | {
      readonly id: string
      readonly source: ValidationCommandSource
      readonly transport: "argv"
      readonly executable: string
      readonly args: readonly string[]
      readonly display: string
    }
  | {
      readonly id: string
      readonly source: ValidationCommandSource
      readonly transport: ValidationScriptDialect
      readonly script: string
      readonly display: string
    }

export type ValidationCommandInput = string | ValidationCommand

export type ValidationPlan = {
  readonly commands: readonly ValidationCommand[]
  readonly timeout_ms: number
  readonly failFast: boolean
}

export type ValidationConfig = {
  readonly cwd: string
  readonly commands: readonly ValidationCommandInput[]
  readonly timeout_ms?: number
}

// The workspace facts validation inference depends on. Every producer (V1 workspace detection, the
// V2 runner's prepare path, the finalizer's validation harvest) reads the same files and passes the
// same record here, so no producer can drift into a different command set for one workspace.
export type WorkspaceValidationSignals = {
  readonly packageJson?: { scripts?: Record<string, string>; packageManager?: string }
  readonly agentsMd?: string
  readonly hasTypeScript: boolean
  readonly hasPython: boolean
  /** Go module marker; used by the runtime finalizer for Go workspaces such as abs. */
  readonly hasGo?: boolean
}

// Workspace markers that make a directory a Python project — one list, so a project detected by one
// path (V1 prompt) is never missed by another (finalizer validation harvest).
export const PYTHON_WORKSPACE_MARKERS = ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"]

// The package-script runner for a workspace, derived from its declared package manager so inferred
// scripts actually run (a pnpm workspace must not be validated with `npm run`). Detection is
// advisory, so an unknown or absent declaration falls back to the caller's default.
export const packageScriptRunner = (packageJson: { packageManager?: string } | undefined, fallback: string): string => {
  const packageManager = packageJson?.packageManager?.split("@")[0]
  if (packageManager === "bun" || packageManager === "pnpm" || packageManager === "npm") return `${packageManager} run`
  if (packageManager === "yarn") return "yarn"
  return fallback
}

// The runner is not a workspace fact to probe — it is derived from the package manifest. Callers
// that already hold the signals (and their own default) merge it in here, so the derived value is
// computed one way everywhere.
export const withPackageScriptRunner = <Signals extends { packageJson?: { packageManager?: string } }>(
  signals: Signals,
  fallback: string,
): Signals & { readonly runner: string } => ({
  ...signals,
  runner: packageScriptRunner(signals.packageJson, fallback),
})

export const inferValidationPlan = (
  context: WorkspaceValidationSignals & { readonly runner?: string },
): ValidationCommand[] => {
  const commands: ValidationCommand[] = []
  const run = context.runner ?? packageScriptRunner(context.packageJson, "bun run")
  const runner = run.trim().split(/\s+/).filter(Boolean)
  const runnerBin = runner[0] ?? "npm"
  const packageScript = (name: string): ValidationCommand => ({
    id: `package:${name}`,
    source: "package_script",
    transport: "argv",
    executable: runnerBin,
    args: [...runner.slice(1), name],
    display: `${run} ${name}`,
  })

  if (context.packageJson?.scripts) {
    const scripts = context.packageJson.scripts
    if (scripts.typecheck) commands.push(packageScript("typecheck"))
    else if (scripts["type-check"]) commands.push(packageScript("type-check"))
    else if (context.hasTypeScript)
      commands.push(
        runnerBin === "bun"
          ? {
              id: "builtin:typecheck",
              source: "builtin",
              transport: "argv",
              executable: "bun",
              args: ["typecheck"],
              display: "bun typecheck",
            }
          : {
              id: "builtin:typecheck",
              source: "builtin",
              transport: "argv",
              executable: "npx",
              args: ["tsc", "--noEmit"],
              display: "npx tsc --noEmit",
            },
      )

    if (scripts.lint) commands.push(packageScript("lint"))
    // P1-3: the test command is part of the micro-round validation gate — a failing test means
    // "not done". Only added when a test script actually exists (no blind test runs).
    if (scripts.test) commands.push(packageScript("test"))
    if (scripts.build && !scripts.test) commands.push(packageScript("build"))
  } else if (context.hasTypeScript) {
    commands.push({
      id: "builtin:typecheck",
      source: "builtin",
      transport: "argv",
      executable: "npx",
      args: ["tsc", "--noEmit"],
      display: "npx tsc --noEmit",
    })
  }

  if (context.hasPython) {
    commands.push({
      id: "builtin:python-compile",
      source: "builtin",
      transport: "argv",
      executable: "python",
      args: ["-m", "compileall", "-q", "."],
      display: "python -m compileall -q .",
    })
  }

  if (context.hasGo) {
    commands.push({
      id: "builtin:go-test",
      source: "builtin",
      transport: "argv",
      executable: "go",
      args: ["test", "./..."],
      display: "go test ./...",
    })
  }

  if (context.agentsMd) {
    const inferredFromAgents = extractCommandsFromAgentsMd(context.agentsMd)
    for (const cmd of inferredFromAgents)
      if (!commands.some((item) => item.display === cmd))
        commands.push({
          id: `agents:${commands.length}`,
          source: "agents_md",
          transport: "posix",
          script: cmd,
          display: cmd,
        })
  }

  return commands
}

// The workspace probe the V2 runner uses on its prepare path. It is deliberately SYNCHRONOUS:
// prepare runs inside the drain fiber, and every `yield*` to the async fs service is a scheduler
// yield point between "prompt admitted" and "provider dispatched". That widening window is not free
// — session tests that assert dispatch right after `prompt` resolve find the drain still parked, and
// the runtime pays an extra scheduling hop on every provider turn for seven tiny local reads.
// Sync local reads keep the probe off the fiber's yield path; the reads are the same files the V1
// detector and the finalizer's harvest read synchronously.
export const detectValidationSignals = (
  directory: string,
): WorkspaceValidationSignals & { readonly runner: string } => {
  const packageJson = readJsonIfExists(join(directory, "package.json"))
  return withPackageScriptRunner(
    {
      packageJson,
      agentsMd: readTextIfExists(join(directory, "AGENTS.md")),
      hasTypeScript: existsSync(join(directory, "tsconfig.json")) || packageJson?.scripts?.typecheck !== undefined,
      hasPython: PYTHON_WORKSPACE_MARKERS.some((file) => existsSync(join(directory, file))),
      hasGo: existsSync(join(directory, "go.mod")),
    },
    "bun run",
  )
}

const readTextIfExists = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

const readJsonIfExists = (file: string): PackageJson | undefined => {
  const text = readTextIfExists(file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as PackageJson
  } catch {
    return undefined
  }
}

type PackageJson = { scripts?: Record<string, string>; packageManager?: string }

export const inferValidationCommands = (context: Parameters<typeof inferValidationPlan>[0]): string[] =>
  inferValidationPlan(context).map((command) => command.display)

export const normalizeValidationCommand = (command: ValidationCommandInput): ValidationCommand =>
  typeof command === "string"
    ? {
        id: `user:${command}`,
        source: "user",
        transport: "posix",
        script: command,
        display: command,
      }
    : command

export const validationCommandDisplay = (command: ValidationCommandInput): string =>
  normalizeValidationCommand(command).display

// P2-7: the single AGENTS.md command extractor (was duplicated in workspace-context with a
// drifting regex). Matches both "`cmd` - typecheck" list items and "run `cmd` to typecheck" prose.
export const extractCommandsFromAgentsMd = (content: string): string[] => {
  const commands: string[] = []
  const lines = content.split("\n")
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s*`([^`]+)`\s*[-–—:]?\s*(typecheck|lint|test|build|check)/i)
    if (match) commands.push(match[1])
    const backtickCmd = line.match(/(?:run|execute)\s+`([^`]+)`.*(?:to|for)?\s*(?:typecheck|lint|test|verify|build)/i)
    if (backtickCmd && !commands.includes(backtickCmd[1])) commands.push(backtickCmd[1])
  }
  return commands
}

export const buildValidationPlan = (config: ValidationConfig): ValidationPlan => ({
  commands:
    config.commands.length > 0
      ? config.commands.map(normalizeValidationCommand)
      : [normalizeValidationCommand("echo 'no validation commands configured'")],
  timeout_ms: config.timeout_ms ?? 60_000,
  failFast: true,
})

export const parseValidationOutput = (
  command: string,
  exitCode: number,
  output: string,
  duration_ms: number,
  kind: ValidationFailureKind = "command_exit",
): ValidationResult => ({
  command,
  passed: kind === "command_exit" && exitCode === 0,
  kind,
  exit_code: exitCode,
  output: output.slice(-4000),
  duration_ms,
})

// An empty result set is NOT "all passed": there is no positive validation evidence, so a
// completion gate must not treat "no checks ran" as success (vacuous-truth footgun).
export const allPassed = (results: readonly ValidationResult[]): boolean =>
  results.length > 0 && results.every((r) => r.passed)

export const summarizeResults = (results: readonly ValidationResult[]): string => {
  if (results.length === 0) return "No validations run."
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)
  if (failed.length === 0) return `All ${passed} validations passed.`
  const failedSummary = failed.map((r) => `  - ${r.command}: FAILED`).join("\n")
  return `${passed}/${results.length} passed, ${failed.length} failed:\n${failedSummary}`
}
