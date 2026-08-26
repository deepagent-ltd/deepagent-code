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

export const inferValidationPlan = (context: {
  readonly cwd: string
  readonly packageJson?: { scripts?: Record<string, string> }
  readonly agentsMd?: string
  readonly hasTypeScript: boolean
  readonly hasPython: boolean
  // The package-script runner for this workspace (e.g. "npm run", "bun run"). Defaults to npm.
  // P2-7: single inference impl; the deepagent-code production path passes "bun run".
  readonly runner?: string
}): ValidationCommand[] => {
  const commands: ValidationCommand[] = []
  const run = context.runner ?? "npm run"
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
