// Gamma G0 turn report: pier job dir -> per-run prompt-composition and behavior tables.
//
// Reads the structured observability lines the instrumented binary writes next to the transcript:
//   [beacon] startup <json> / [beacon] summary <json>   — mechanism activation evidence
//   [turn] prepared seq=<n> parts=<json>                 — per-turn prompt composition (first 3)
//   [turn] summary <json>                                — per-drain totals (parts sums + usage + behavior)
// plus the trial's verifier result.json and trajectory.json for reward/steps. Structured JSON
// parsing only — no transcript text grep.
//
// Usage: bun script/ablation/turn-report.ts <jobs-dir> [arm-prefix=c2-fullon]
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

type TurnSummary = {
  turns: number
  behavior: Record<string, number>
  finish: Record<string, number>
  parts: {
    stable_system: number
    volatile_system: number
    control_message: number
    history: number
    tool_results: number
    total_estimated: number
  }
  usage: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
}

const jobsDir = process.argv[2]
const armPrefix = process.argv[3] ?? ""
if (!jobsDir) {
  console.error("usage: bun script/ablation/turn-report.ts <jobs-dir> [arm-prefix]")
  process.exit(1)
}

const parseJsonLine = <T>(line: string, prefix: string): T | null => {
  if (!line.startsWith(prefix)) return null
  try {
    return JSON.parse(line.slice(prefix.length)) as T
  } catch {
    return null
  }
}

const firstTrialDir = async (jobDir: string) => {
  for (const entry of await readdir(jobDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.includes("__")) return path.join(jobDir, entry.name)
  }
  return undefined
}

for (const job of (await readdir(jobsDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && (armPrefix === "" || e.name.startsWith(armPrefix)))
  .map((e) => e.name)
  .sort()) {
  const jobDir = path.join(jobsDir, job)
  const trialDir = await firstTrialDir(jobDir)
  if (!trialDir) continue
  let reward: number | null = null
  let f2p = ""
  try {
    const result = JSON.parse(await readFile(path.join(trialDir, "result.json"), "utf8")) as {
      stats?: { evals?: Record<string, { metrics?: Array<{ reward?: number; f2p_passed?: number; f2p_total?: number }> }> }
    }
    const metrics = Object.values(result.stats?.evals ?? {})[0]?.metrics?.[0]
    reward = metrics?.reward ?? null
    f2p = `${metrics?.f2p_passed ?? "?"}/${metrics?.f2p_total ?? "?"}`
  } catch {}
  let steps: number | null = null
  try {
    const trajectory = JSON.parse(await readFile(path.join(trialDir, "agent", "trajectory.json"), "utf8")) as {
      final_metrics?: { total_steps?: number }
    }
    steps = trajectory.final_metrics?.total_steps ?? null
  } catch {}
  const summaries: TurnSummary[] = []
  let beacon: Record<string, { count: number }> | null = null
  for (const candidate of ["deepagent.txt", "mini-swe-agent.txt"]) {
    try {
      const text = await readFile(path.join(trialDir, "agent", candidate), "utf8")
      for (const line of text.split("\n")) {
        const summary = parseJsonLine<TurnSummary>(line, "[turn] summary ")
        if (summary) summaries.push(summary)
        const bSummary = parseJsonLine<Record<string, { count: number }>>(line, "[beacon] summary ")
        if (bSummary) beacon = bSummary
      }
      break
    } catch {}
  }
  // [turn] summary is a CUMULATIVE process-level rollup emitted at each drain end — later lines
  // already contain everything earlier lines reported. Summing them double-counts by the drain
  // count (verified against trajectory.json total_prompt_tokens); the LAST line is the truth.
  const last = summaries.at(-1)
  const total = {
    turns: last?.turns ?? 0,
    behavior: last?.behavior ?? {},
    input: last?.usage?.input ?? 0,
    output: last?.usage?.output ?? 0,
    cacheRead: last?.usage?.cacheRead ?? 0,
    parts: last?.parts ?? {},
  }
  const est = total.parts.total_estimated ?? 0
  const providerInput = total.input + total.cacheRead
  console.log(`\n=== ${job} (reward=${reward} f2p=${f2p} steps=${steps}) ===`)
  if (summaries.length === 0) {
    console.log("  (no [turn] summary lines — run predates G0 instrumentation)")
    continue
  }
  console.log(`  turns=${total.turns} drains=${summaries.length} provider_input=${providerInput.toLocaleString()}`)
  console.log(
    `  billed(DS≈): input=${total.input.toLocaleString()} + cacheRead/10=${Math.round(
      total.cacheRead / 10,
    ).toLocaleString()} = ${(total.input + total.cacheRead / 10).toLocaleString()}`,
  )
  console.log(
    `  parts(estimated): stable=${(total.parts.stable_system ?? 0).toLocaleString()} volatile=${(
      total.parts.volatile_system ?? 0
    ).toLocaleString()} control=${(total.parts.control_message ?? 0).toLocaleString()} history=${(
      total.parts.history ?? 0
    ).toLocaleString()} tool_results=${(total.parts.tool_results ?? 0).toLocaleString()}`,
  )
  if (providerInput > 0)
    console.log(
      `  estimate-vs-usage: estimated=${est.toLocaleString()} provider=${providerInput.toLocaleString()} ratio=${(
        est / providerInput
      ).toFixed(2)}`,
    )
  console.log(`  behavior: ${JSON.stringify(total.behavior)}`)
  if (beacon) console.log(`  beacon: ${JSON.stringify(beacon)}`)
}
