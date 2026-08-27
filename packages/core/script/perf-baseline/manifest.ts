import { PerfStats, STAT_METHOD } from "./stats"
import { UNIT, recordArtifact, sha256Short, writeSamplesCsv, writeSummariesJsonl } from "./samples"
import * as fs from "node:fs"
import * as path from "node:path"
import { bunVersion, gitIdentity, powerState, machineInfo, interferenceSnapshot, type GitIdentity } from "./run-env"
import type { ScenarioOutcome } from "./lib"

export const EVIDENCE_LEVEL_DECLARATION =
  "alpha 开发机动态基线（D3-local），不等同 D5/D6 package/release 证据。alpha development-machine dynamic baseline (D3-local); NOT D5/D6 package/release evidence."

export interface RunManifest {
  readonly run_id: string
  readonly declaration: string
  readonly started_at: string
  readonly finished_at: string
  readonly evidence_level: string
  readonly frozen_base: {
    readonly expected_commit: string
    readonly expected_tree: string
    readonly actual_git: GitIdentity
    readonly warn_mismatch: boolean
  }
  readonly tools: {
    readonly bun_version: string
    readonly node_compat: string
    readonly os_arch: string
  }
  readonly machine: ReturnType<typeof machineInfo>
  readonly power_state: ReturnType<typeof powerState>
  readonly interference_processes: {
    readonly at_start: ReturnType<typeof interferenceSnapshot>
    readonly at_end: ReturnType<typeof interferenceSnapshot>
  }
  readonly fixture_scale: Record<string, unknown>
  readonly env_allowlist: Record<string, string | null>
  readonly warmup_policy: Record<string, string>
  readonly statistics_method: string
  readonly unit: string
  readonly scenarios: Array<Record<string, unknown>>
}

const scenarioArtifacts = async (outputDir: string, outcome: ScenarioOutcome) => {
  const rawDir = path.join(outputDir, "raw")
  const files: Array<Record<string, unknown>> = []
  for (const group of outcome.groups) {
    const relative = `raw/${outcome.name}-${group.group}.csv`
    writeSamplesCsv(path.join(outputDir, relative), `${outcome.name}/${group.group}`, [
      { name: group.group, values: group.values },
    ])
    files.push({ ...recordArtifact(outputDir, relative), samples: group.values.length })
  }
  return files
}

export interface ManifestInput {
  readonly runId: string
  readonly outputDir: string
  readonly startedAtMs: number
  readonly outcomes: readonly ScenarioOutcome[]
  readonly fixtureScale: Record<string, unknown>
  readonly testHome: string
  readonly expectations?: { readonly commit?: string; readonly tree?: string }
}

export const buildAndWriteManifest = async (input: ManifestInput): Promise<string> => {
  const repoRoot = path.resolve(import.meta.dir, "../../../..")
  const actualGit = gitIdentity(repoRoot)
  const warnMismatch =
    (input.expectations?.commit !== undefined && input.expectations.commit !== actualGit.commit) ||
    (input.expectations?.tree !== undefined && input.expectations.tree !== actualGit.tree)

  const summariesRows = input.outcomes.flatMap((outcome) =>
    outcome.groups.map((group) => ({
      scenario: outcome.name,
      group: group.group,
      owner_note: outcome.owner_note,
      status: outcome.status,
      unit: UNIT,
      ...PerfStats.summarize(group.values),
      failures: group.failures,
      extras: outcome.extras ?? {},
    })),
  )
  writeSummariesJsonl(path.join(input.outputDir, "summaries.jsonl"), summariesRows)

  const scenarios: Array<Record<string, unknown>> = []
  for (const outcome of input.outcomes) {
    scenarios.push({
      name: outcome.name,
      status: outcome.status,
      owner_note: outcome.owner_note,
      unavailable_reason: outcome.unavailable_reason,
      evidence_refs: outcome.evidence_refs,
      duration_ms: Math.round(outcome.duration_ms),
      groups: Object.fromEntries(
        outcome.groups.map((group) => [
          group.group,
          {
            ...PerfStats.summarize(group.values),
            failures: group.failures,
          },
        ]),
      ),
      extras: outcome.extras ?? {},
      artifacts: await scenarioArtifacts(input.outputDir, outcome),
    })
  }

  const manifest: RunManifest = {
    run_id: input.runId,
    declaration: EVIDENCE_LEVEL_DECLARATION,
    started_at: new Date(input.startedAtMs).toISOString(),
    finished_at: new Date().toISOString(),
    evidence_level: "D3-local",
    frozen_base: {
      expected_commit: input.expectations?.commit ?? "",
      expected_tree: input.expectations?.tree ?? "",
      actual_git: actualGit,
      warn_mismatch: warnMismatch,
    },
    tools: {
      bun_version: bunVersion() ?? "unknown",
      node_compat: process.versions.node,
      os_arch: `${process.platform} ${process.arch}`,
    },
    machine: machineInfo(),
    power_state: powerState(),
    interference_processes: {
      at_start: interferenceSnapshot(),
      at_end: interferenceSnapshot(),
    },
    fixture_scale: input.fixtureScale,
    env_allowlist: {
      // The only environment redirection mechanism used by this harness and its child processes.
      DEEPAGENT_CODE_TEST_HOME: input.testHome,
      DEEPAGENT_CODE_HOME: process.env.DEEPAGENT_CODE_HOME ?? "(not set)",
      note: "DEEPAGENT_CODE_TEST_HOME alone resolves the data root to $TEST_HOME/.deepagent/code (packages/core/src/global-path.ts); no production data directory was touched",
    },
    warmup_policy: Object.fromEntries(
      input.outcomes.map((outcome) => [
        outcome.name,
        String((outcome.extras as Record<string, unknown> | undefined)?.warmup_policy ?? "none declared"),
      ]),
    ),
    statistics_method: STAT_METHOD,
    unit: UNIT,
    scenarios,
  }

  const body = JSON.stringify(manifest, null, 2)
  fs.writeFileSync(path.join(input.outputDir, "manifest.json"), `${body}\n`)
  const digest = {
    files: fs.readdirSync(path.join(input.outputDir, "raw")).map((name) => {
      const relative = path.join("raw", name)
      return { path: relative, sha256_12: sha256Short(fs.readFileSync(path.join(input.outputDir, relative))) }
    }),
  }
  fs.writeFileSync(path.join(input.outputDir, "artifact-hashes.json"), `${JSON.stringify(digest, null, 2)}\n`)
  return path.join(input.outputDir, "manifest.json")
}
