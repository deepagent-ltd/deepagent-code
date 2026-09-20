#!/usr/bin/env bun
/**
 * Replay-history runner (2026-09-10): spawns replay-worker.ts per scenario with a CLEAN child
 * environment (HOME pinned at spawn time) and aggregates the pass/fail matrix.
 *
 *   bun run script/replay-history/replay.ts [--dir <manifest-dir>] [--limit N] [--ops N]
 *        [--only <scenario-id>] [--scenario-timeout-ms N]
 *
 * The manifest comes from extract.ts. Results land in <dir>/results.json.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const dir = option("--dir") ?? "/tmp/replay-history"
const limit = Number(option("--limit") ?? 8)
const maxOps = option("--ops")
const only = option("--only")
const scenarioTimeoutMs = option("--scenario-timeout-ms")

const manifest = (await Bun.file(path.join(dir, "manifest.json")).json()) as {
  readonly shortlist: ReadonlyArray<{
    readonly id: string
    readonly agent: string | null
    readonly ops: ReadonlyArray<{ readonly text: string }>
  }>
}
const scenarios = (only ? manifest.shortlist.filter((scenario) => scenario.id === only) : manifest.shortlist).slice(
  0,
  limit,
)
if (scenarios.length === 0) throw new Error(`no scenarios selected (only=${only ?? "-"})`)

const runDir = path.join(dir, "run")
rmSync(runDir, { recursive: true, force: true })
const results: unknown[] = []
for (const scenario of scenarios) {
  const home = path.join(runDir, scenario.id)
  const workspace = path.join(home, "workspace")
  mkdirSync(workspace, { recursive: true })
  await Bun.$`git init --quiet ${workspace}`
  const scenarioFile = path.join(home, "scenario.json")
  await Bun.write(scenarioFile, JSON.stringify(scenario))

  const child = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "replay-worker.ts"), scenarioFile, workspace], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      ...(maxOps ? { REPLAY_OPS: maxOps } : {}),
      ...(scenarioTimeoutMs ? { REPLAY_SCENARIO_TIMEOUT_MS: scenarioTimeoutMs } : {}),
    },
    stdout: "pipe",
    stderr: "inherit",
  })
  const line = child.stdout.toString().trim().split("\n").at(-1)
  const result = line ? (JSON.parse(line) as Record<string, unknown>) : { id: scenario.id, status: "fail", failure: `worker exit=${child.exitCode}` }
  results.push(result)
  console.error(`${String(result.status).padEnd(5)} ${scenario.id} ops=${result.replayedOps} receipts=${result.receipts} evidence=${result.evidenceArtifacts} ${result.failure ?? ""}`)
  rmSync(home, { recursive: true, force: true })
}

const failures = results.filter((result) => (result as { status: string }).status === "fail")
writeFileSync(path.join(dir, "results.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), scenarios: results }, null, 2)}\n`)
console.error(`\ndone: ${results.length} scenarios, ${failures.length} fail -> ${path.join(dir, "results.json")}`)
process.exitCode = failures.length > 0 ? 1 : 0
