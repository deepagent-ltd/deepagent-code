// Ablation metrics extractor: pier job dir -> per-run metrics JSON.
// Reads every trial's ATIF trajectory + verifier reward and emits the measurement set
// the ablation plan (§2.3) defines: pass, steps, investigation depth, tokens, wallclock,
// convergence quality. Usage: bun script/ablation/extract-metrics.ts <jobs-dir> [out.json]
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

type Step = {
  step_id: number
  source: string
  message?: { tool_calls?: Array<{ function_name: string; arguments: unknown }>; content?: unknown }
  metrics?: Record<string, unknown>
  observations?: Array<{ content?: unknown; metrics?: Record<string, unknown> }>
}

type Trajectory = {
  agent?: { name?: string; model_name?: string }
  steps?: Step[]
  final_metrics?: Record<string, number>
}

type RunMetrics = {
  job: string
  trial: string
  agent: string
  model: string
  reward: number | null
  passed: boolean | null
  assistantSteps: number
  toolCalls: number
  investigationBeforeFirstEdit: number
  toolHistogram: Record<string, number>
  repeatedToolCalls: number
  errorToolCalls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  costUsd: number
  wallclockMs: number | null
  /** Reasoning trace volume — the driver of per-delta costs (see the stall postmortem). */
  reasoningChars: number
  assistantTextChars: number
  /** Ablation-correctness evidence parsed from the `[beacon]` lines in the agent transcript. */
  beaconStartup: Record<string, string> | null
  beaconEngagements: Record<string, number>
}

const EDIT_TOOLS = new Set(["edit", "write", "apply", "applypatch", "apply_patch"])
const INVESTIGATION_TOOLS = new Set(["read", "grep", "glob", "list", "search", "find", "bash"])

function toolNameOf(step: Step): string {
  const call = step.message?.tool_calls?.[0]
  return (call?.function_name ?? "").toLowerCase()
}

function observationError(step: Step): boolean {
  const text = JSON.stringify(step.observations ?? [])
  return /"error"|exit code [1-9]|command not found|no such file/i.test(text)
}

async function extractTrial(jobsDir: string, job: string, trialDir: string): Promise<RunMetrics | null> {
  const trajPath = path.join(trialDir, "agent", "trajectory.json")
  let trajectory: Trajectory
  try {
    trajectory = JSON.parse(await readFile(trajPath, "utf8")) as Trajectory
  } catch {
    return null
  }
  const steps = trajectory.steps ?? []
  const agentSteps = steps.filter((step) => step.source === "agent")

  // Captured agent transcript (the pier tee target): carries the `[beacon]` evidence lines.
  let agentLog: string[] = []
  for (const candidate of ["deepagent.txt", "mini-swe-agent.txt"]) {
    try {
      agentLog = (await readFile(path.join(trialDir, "agent", candidate), "utf8")).split("\n")
      if (agentLog.length > 0) break
    } catch {}
  }

  const toolHistogram: Record<string, number> = {}
  let investigation = 0
  let edited = false
  let repeated = 0
  let errors = 0
  const seen = new Map<string, number>()
  for (const step of agentSteps) {
    const name = toolNameOf(step)
    if (!name) continue
    toolHistogram[name] = (toolHistogram[name] ?? 0) + 1
    const signature = `${name}:${JSON.stringify(step.message?.tool_calls?.[0]?.arguments ?? "")}`
    repeated = Math.max(repeated, (seen.get(signature) ?? 0) + 1)
    seen.set(signature, (seen.get(signature) ?? 0) + 1)
    if (observationError(step)) errors += 1
    if (!edited) {
      if (EDIT_TOOLS.has(name) || /git (commit|apply)|>>(?![^(]*dirname)/.test(JSON.stringify(step.message?.tool_calls))) {
        edited = true
      } else if (INVESTIGATION_TOOLS.has(name) || name === "bash") {
        investigation += 1
      }
    }
  }

  // Verifier reward: pier writes trial result.json with verifier output.
  let reward: number | null = null
  try {
    const trialResult = JSON.parse(await readFile(path.join(trialDir, "result.json"), "utf8")) as {
      verification?: { reward?: number }
    }
    reward = trialResult.verification?.reward ?? null
  } catch {}

  const verifierRewardPath = path.join(trialDir, "verifier", "reward.json")
  if (reward === null) {
    try {
      reward = (JSON.parse(await readFile(verifierRewardPath, "utf8")) as { reward?: number }).reward ?? null
    } catch {}
  }

  const first = agentSteps[0]?.metrics?.start_epoch_ms
  const last = agentSteps.at(-1)?.metrics?.end_epoch_ms ?? agentSteps.at(-1)?.metrics?.start_epoch_ms
  // Reasoning/text volume: the per-delta hot paths scale with these (postmortem §IV).
  let reasoningChars = 0
  let assistantTextChars = 0
  for (const step of steps) {
    for (const part of step.message?.content ?? []) {
      if (part?.type === "reasoning" && typeof part.text === "string") reasoningChars += part.text.length
      if (part?.type === "text" && typeof part.text === "string") assistantTextChars += part.text.length
    }
  }
  // Mechanism beacons: the ablation-correctness ledger parsed from the captured transcript.
  const beaconStartup: Record<string, string> | null = (() => {
    const line = agentLog?.find((l) => l.startsWith("[beacon] startup "))
    if (!line) return null
    try {
      return JSON.parse(line.slice("[beacon] startup ".length)) as Record<string, string>
    } catch {
      return null
    }
  })()
  const beaconEngagements: Record<string, number> = {}
  for (const line of agentLog ?? []) {
    if (line.startsWith("[beacon] summary ")) {
      try {
        const parsed = JSON.parse(line.slice("[beacon] summary ".length)) as Record<string, { count: number }>
        for (const [id, value] of Object.entries(parsed)) beaconEngagements[id] = value.count
      } catch {}
      continue
    }
    const m = line.match(/^\[beacon\] engage mechanism=(\S+)/)
    if (m) beaconEngagements[m[1]] = (beaconEngagements[m[1]] ?? 0) + 1
  }
  return {
    job,
    trial: path.basename(trialDir),
    agent: trajectory.agent?.name ?? "unknown",
    model: trajectory.agent?.model_name ?? "unknown",
    reward,
    passed: reward === null ? null : reward >= 1,
    assistantSteps: agentSteps.length,
    toolCalls: Object.values(toolHistogram).reduce((a, b) => a + b, 0),
    investigationBeforeFirstEdit: investigation,
    toolHistogram,
    repeatedToolCalls: repeated,
    errorToolCalls: errors,
    promptTokens: trajectory.final_metrics?.total_prompt_tokens ?? 0,
    completionTokens: trajectory.final_metrics?.total_completion_tokens ?? 0,
    cachedTokens: trajectory.final_metrics?.total_cached_tokens ?? 0,
    costUsd: trajectory.final_metrics?.total_cost ?? 0,
    wallclockMs: typeof first === "number" && typeof last === "number" ? last - first : null,
    reasoningChars,
    assistantTextChars,
    beaconStartup,
    beaconEngagements,
  }
}

const jobsDir = process.argv[2]
const outPath = process.argv[3] ?? path.join(jobsDir ?? ".", "ablation-metrics.json")
if (!jobsDir) {
  console.error("usage: bun script/ablation/extract-metrics.ts <jobs-dir> [out.json]")
  process.exit(1)
}

const runs: RunMetrics[] = []
for (const job of (await readdir(jobsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)) {
  const jobDir = path.join(jobsDir, job)
  for (const entry of await readdir(jobDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.includes("__")) continue
    const metrics = await extractTrial(jobsDir, job, path.join(jobDir, entry.name))
    if (metrics) runs.push(metrics)
  }
}
await writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 2) + "\n")
console.log(`extracted ${runs.length} run(s) -> ${outPath}`)
for (const run of runs) {
  console.log(
    `${run.job}/${run.trial} agent=${run.agent} pass=${run.pass} reward=${run.reward} steps=${run.assistantSteps} tools=${run.toolCalls} investigate=${run.investigationBeforeFirstEdit} repeats=${run.repeatedToolCalls} errors=${run.errorToolCalls} tokens=${run.promptTokens}/${run.completionTokens}`,
  )
}
