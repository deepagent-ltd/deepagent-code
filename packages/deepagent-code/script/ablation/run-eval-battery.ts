// Tier A mechanism-ablation battery runner (ablation-plan.md §Tier A, user-ruled 2026-09-02).
//
//   bun script/ablation/run-eval-battery.ts --mechanism plangate --concurrency 4
//
// For every selected task family it runs the seed-templated micro-tasks TWICE — mechanism ON
// (baseline env) and mechanism OFF (the ablation-plan §2.2 env key) — through the live-llm
// harness (isolated HOME/DB per case, real GLM), scores via each task's verifier, and writes a
// paired differential report. The ON∧OFF-fail differential per family is the causal-evidence
// unit; "OFF also passes" is recorded as "no causal contribution on this task" (never hidden).

import { copyFile, lstat, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { runLegacyLiveCases } from "../live-llm/runtime"
import { finishLiveScript } from "../live-llm/lifecycle"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { parseVerifierChecks, verifierMarker } from "../live-llm/eval-scoring"
import {
  batteryTasksByFamily,
  batteryFamilies,
  buildBatteryTasks,
  mechanismEnvKeys,
  type BatteryTask,
  type MechanismID,
} from "./battery-tasks"

type CliOptions = {
  mechanisms: MechanismID[] | "all"
  families: string[] | undefined
  seeds: number[]
  concurrency: number
  roundTimeoutMs: number
  dryRun: boolean
}

function usage(): never {
  console.log(`usage: bun script/ablation/run-eval-battery.ts [options]

options:
  --mechanism <id|all>   mechanism to ablate (${[...Object.keys(mechanismEnvKeys), "all"].join("|")}); default all
  --family <name>        restrict to task families (repeatable; default all)
  --seeds <n>            number of seeds per family (default 3)
  --concurrency <n>      parallel cases (default 4; GLM 429s above ~8)
  --round-timeout <ms>   per-case timeout (default 240000)
  --dry-run              print the plan without calling the model`)
  process.exit(1)
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mechanisms: "all",
    families: undefined,
    seeds: [1, 2, 3],
    concurrency: 4,
    roundTimeoutMs: 240_000,
    dryRun: false,
  }
  const families: string[] = []
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => (index + 1 < argv.length ? argv[++index] : usage())
    if (arg === "--mechanism") {
      const value = next()
      options.mechanisms = value === "all" ? "all" : ([value] as MechanismID[])
    } else if (arg === "--family") families.push(next())
    else if (arg === "--seeds") {
      const count = Math.max(1, Math.min(10, Number(next()) || 3))
      options.seeds = Array.from({ length: count }, (_, i) => i + 1)
    } else if (arg === "--concurrency") options.concurrency = Math.max(1, Math.min(16, Number(next()) || 4))
    else if (arg === "--round-timeout") options.roundTimeoutMs = Math.max(30_000, Number(next()) || 240_000)
    else if (arg === "--dry-run") options.dryRun = true
    else {
      console.error(`unknown option: ${arg}`)
      usage()
    }
  }
  if (families.length > 0) {
    const unknown = families.filter((family) => !batteryFamilies.includes(family))
    if (unknown.length > 0) {
      console.error(`unknown families: ${unknown.join(", ")} (available: ${batteryFamilies.join(", ")})`)
      usage()
    }
    options.families = families
  }
  if (options.mechanisms !== "all") {
    for (const mechanism of options.mechanisms) {
      if (mechanism === "none" || !mechanismEnvKeys[mechanism]) {
        console.error(`unknown mechanism: ${mechanism} (${Object.keys(mechanismEnvKeys).join("|")})`)
        usage()
      }
    }
  }
  return options
}

type ArmResult = {
  task: string
  family: string
  seed: number
  arm: "on" | "off"
  passed: boolean
  error?: string
  assistantTurns: number
  toolCalls: number
  durationMs: number
}

async function runCase(
  task: BatteryTask,
  arm: "on" | "off",
  mechanism: Exclude<MechanismID, "none"> | null,
  timeoutMs: number,
): Promise<ArmResult> {
  const environment =
    arm === "off" && mechanism
      ? { [mechanismEnvKeys[mechanism].key]: mechanismEnvKeys[mechanism].offValue, ...(task.environment ?? {}) }
      : task.environment
  try {
    const artifact = await runLegacyLiveCases({
      suite: `ablation-${task.id}-${arm}`,
      permission: task.permission,
      cases: [{ name: task.id, prompt: task.prompt }],
      files: task.files,
      inspectFiles: task.allowedPaths,
      toolSandbox: task.verifier
        ? { verifierScript: task.verifier.script, initialVerifier: task.initialVerifier }
        : undefined,
      primaryPrompt:
        "Work autonomously on the isolated coding task. Inspect relevant files, make only necessary changes, and verify when a verifier is available. The only authorized verifier command is exactly ./verify; do not run Python directly, inspect .live-llm-harness, or try alternate verifier paths. Never simulate tool output or claim success without evidence.",
      modelMaxTokens: 2048,
      maxProviderTurns: task.maxProviderTurns ?? 8,
      modelContextTokens: task.modelContextTokens,
      timeoutMs,
      environment,
      evaluateWorkspace: (directory, sandbox) => evaluateWorkspace(task, directory, sandbox),
    })
    const observation = artifact.cases[0]
    if (!observation) throw new Error("no case observation")
    const evaluation = artifact.evaluation as { passed?: boolean } | undefined
    const result: ArmResult = {
      task: task.id,
      family: task.family,
      seed: task.seed,
      arm,
      passed: evaluation?.passed === true,
      assistantTurns: observation.assistantTurns,
      toolCalls: observation.tools.length,
      durationMs: artifact.durationMs,
    }
    console.log(
      `  [${arm}${mechanism ? `:${mechanism}` : ""}] ${task.id} turns=${result.assistantTurns} tools=${result.toolCalls} ${result.passed ? "PASS" : "FAIL"}`,
    )
    if (process.env.ABLATION_BATTERY_DEBUG) {
      const dump = observation as unknown as Record<string, unknown>
      console.log(JSON.stringify({ evaluation, models: dump.models, finalText: dump.finalText }, null, 1))
    }
    return result
  } catch (error) {
    console.log(`  [${arm}] ${task.id} ERROR ${error instanceof Error ? error.message : String(error)}`)
    return {
      task: task.id,
      family: task.family,
      seed: task.seed,
      arm,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      assistantTurns: 0,
      toolCalls: 0,
      durationMs: 0,
    }
  }
}

// Hidden fresh-copy verifier evaluation — same discipline as autonomous-eval's evaluateFreshCopy:
// copy task files + the model's allowed-path edits into a pristine directory and run ./verify
// there, so passing requires the workspace state itself (not a lucky in-place run).
async function evaluateWorkspace(task: BatteryTask, directory: string, sandbox?: Parameters<NonNullable<Parameters<typeof runLegacyLiveCases>[0]["evaluateWorkspace"]>>[1]) {
  const regularFiles = await Promise.all(
    task.allowedPaths.map(async (file) => {
      try {
        return (await lstat(path.join(directory, file))).isFile()
      } catch {
        return false
      }
    }),
  )
  if (!task.verifier) {
    return { passed: regularFiles.every(Boolean), checks: [], hiddenVerifier: false }
  }
  if (!sandbox) throw new Error("Battery verifier requires a qualified tool sandbox")
  const fresh = path.join(directory, `.battery-fresh-${Bun.hash(task.id + task.seed).toString(16)}`)
  await mkdir(fresh, { recursive: true })
  try {
    await Promise.all(
      [...new Set([...Object.keys(task.files), ...task.allowedPaths])].map(async (file) => {
        const source = path.join(directory, file)
        if (!(await Bun.file(source).exists()) || source === fresh) return
        await mkdir(path.dirname(path.join(fresh, file)), { recursive: true })
        await copyFile(source, path.join(fresh, file))
      }),
    )
    const oracle = Bun.spawn([sandbox.shell, "-c", `cd '${fresh.replace(/'/g, `'\\''`)}' && ../verify`], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, , exitCode] = await Promise.all([
      new Response(oracle.stdout).text(),
      new Response(oracle.stderr).text(),
      oracle.exited,
    ])
    return {
      passed: exitCode === 0,
      hiddenVerifier: true,
      sandboxed: true,
      exitCode,
      verifierStructured: stdout.split("\n").some((line) => line.startsWith(verifierMarker)),
      checks: parseVerifierChecks(stdout, task.verifier.checks),
    }
  } finally {
    await rm(fresh, { recursive: true, force: true })
  }
}

async function main() {
  const options = parseArgs(process.argv)
  const tasks = buildBatteryTasks({ families: options.families, seeds: options.seeds })
  const mechanisms =
    options.mechanisms === "all"
      ? (Object.keys(mechanismEnvKeys) as Exclude<MechanismID, "none">[])
      : (options.mechanisms as Exclude<MechanismID, "none">[])

  // Pairing unit: (task × mechanism) runs ON then OFF. Families whose target mechanism is not in
  // the selection still run ON-only (calibration arms — honesty/doom-loop have no switch).
  const plan: Array<{ task: BatteryTask; mechanism: Exclude<MechanismID, "none"> | null; arm: "on" | "off" }> = tasks.flatMap((task) => [
    ...mechanisms
      .filter((mechanism) => task.mechanism === mechanism)
      .map((mechanism) => ({ task, mechanism, arm: "off" as const })),
    { task, mechanism: null, arm: "on" as const },
  ])

  console.log(`Tier A battery: ${tasks.length} tasks × (on${mechanisms.length > 0 ? ` + ${mechanisms.length} off-arm` : ""}) = ${plan.length} cases, concurrency ${options.concurrency}`)
  if (options.dryRun) {
    for (const entry of plan) {
      console.log(`  ${entry.task.family}/${entry.task.seed} [${entry.arm}${entry.mechanism ? `:${entry.mechanism}` : ""}] turns≤${entry.task.maxProviderTurns ?? 8}`)
    }
    return
  }

  const startedAt = Date.now()
  const results: ArmResult[] = []
  const queue = [...plan]
  const workers = Array.from({ length: options.concurrency }, async () => {
    for (;;) {
      const entry = queue.shift()
      if (!entry) return
      results.push(await runCase(entry.task, entry.arm, entry.mechanism, options.roundTimeoutMs))
    }
  })
  await Promise.all(workers)

  // Paired differential per (family, mechanism): ON pass-rate vs OFF pass-rate.
  const report = {
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    mechanisms,
    seeds: options.seeds,
    results,
    differentials: mechanisms.map((mechanism) => ({
      mechanism,
      families: batteryTasksByFamily(tasks).map((familyTasks) => {
        const on = results.filter((r) => r.family === familyTasks.family && r.arm === "on")
        const off = results.filter((r) => r.family === familyTasks.family && r.arm === "off")
        const rate = (rows: ArmResult[]) => (rows.length === 0 ? null : rows.filter((r) => r.passed).length / rows.length)
        return {
          family: familyTasks.family,
          onPassRate: rate(on),
          offPassRate: rate(off),
          verdict:
            on.length === 0 || off.length === 0
              ? ("insufficient" as const)
              : rate(on)! > rate(off)!
                ? ("causal-contribution" as const)
                : rate(on)! === rate(off)!
                  ? ("no-difference" as const)
                  : ("off-better" as const),
        }
      }),
    })),
  }

  const artifactDirectory = path.resolve(import.meta.dir, "../../.artifacts/ablation-battery")
  await mkdir(artifactDirectory, { recursive: true })
  await writeLiveArtifact({ artifactDirectory }, `battery-${Date.now()}`, report)
  console.log(`\nDifferentials:`)
  for (const differential of report.differentials) {
    for (const family of differential.families) {
      if (family.onPassRate === null) continue
      console.log(`  ${differential.mechanism} × ${family.family}: ON ${family.onPassRate.toFixed(2)} vs OFF ${family.offPassRate?.toFixed(2) ?? "—"} → ${family.verdict}`)
    }
  }
  console.log(`report: ${artifactDirectory}/battery-${new Date(startedAt).getTime()}`)
}

void main().then(
  () => finishLiveScript(),
  (error) => finishLiveScript(),
)
