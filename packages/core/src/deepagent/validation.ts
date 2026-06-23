import type { ValidationResult } from "./round-state"

export type ValidationPlan = {
  readonly commands: readonly string[]
  readonly timeout_ms: number
  readonly failFast: boolean
}

export type ValidationConfig = {
  readonly cwd: string
  readonly commands: readonly string[]
  readonly timeout_ms?: number
}

export const inferValidationCommands = (context: {
  readonly cwd: string
  readonly packageJson?: { scripts?: Record<string, string> }
  readonly agentsMd?: string
  readonly hasTypeScript: boolean
  readonly hasPython: boolean
  // The package-script runner for this workspace (e.g. "npm run", "bun run"). Defaults to npm.
  // P2-7: single inference impl; the deepagent-code production path passes "bun run".
  readonly runner?: string
}): string[] => {
  const commands: string[] = []
  const run = context.runner ?? "npm run"
  const runnerBin = run.split(/\s+/)[0] ?? "npm" // "bun"/"npm" for the bare typecheck fallback

  if (context.packageJson?.scripts) {
    const scripts = context.packageJson.scripts
    if (scripts.typecheck) commands.push(`${run} typecheck`)
    else if (scripts["type-check"]) commands.push(`${run} type-check`)
    else if (context.hasTypeScript) commands.push(runnerBin === "bun" ? "bun typecheck" : "npx tsc --noEmit")

    if (scripts.lint) commands.push(`${run} lint`)
    // P1-3: the test command is part of the micro-round validation gate — a failing test means
    // "not done". Only added when a test script actually exists (no blind test runs).
    if (scripts.test) commands.push(`${run} test`)
    if (scripts.build && !scripts.test) commands.push(`${run} build`)
  } else if (context.hasTypeScript) {
    commands.push("npx tsc --noEmit")
  }

  if (context.hasPython) {
    commands.push("python -m py_compile *.py")
  }

  if (context.agentsMd) {
    const inferredFromAgents = extractCommandsFromAgentsMd(context.agentsMd)
    for (const cmd of inferredFromAgents) {
      if (!commands.includes(cmd)) commands.push(cmd)
    }
  }

  return commands
}

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
  commands: config.commands.length > 0 ? config.commands : ["echo 'no validation commands configured'"],
  timeout_ms: config.timeout_ms ?? 60_000,
  failFast: true,
})

export const parseValidationOutput = (command: string, exitCode: number, output: string, duration_ms: number): ValidationResult => ({
  command,
  passed: exitCode === 0,
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
