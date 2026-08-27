import * as fs from "node:fs"
import * as path from "node:path"
import { buildAndWriteManifest, EVIDENCE_LEVEL_DECLARATION } from "./manifest"
import { runStartup } from "./scenarios/startup"
import { buildDbFixture, DB_TIERS, type DbFixture } from "./fixtures"
import { runDatabaseOpen } from "./scenarios/database-open"
import { runTurnPrepare } from "./scenarios/turn-prepare"
import { runSystemContext } from "./scenarios/system-context"
import { runEventBus } from "./scenarios/event-bus"
import { runDbWalWriteAmplification } from "./scenarios/db-wal"
import { runJournalHydration } from "./scenarios/journal"
import { runMemoryGrowth } from "./scenarios/memory"
import { runFourMapStatus } from "./scenarios/four-map"
import { PerfStats } from "./stats"
import type { ScenarioOutcome } from "./lib"

const FROZEN_COMMIT = "584d2ff985f0d3890bb0b1c33b3540c420f1bf39"
const FROZEN_TREE = "f19b63e9e90f75da5086a4e35b2d6feff0f2e94a"

interface Args {
  readonly out: string
}

const parseArgs = (): Args => {
  const index = process.argv.indexOf("--out")
  if (index === -1 || process.argv[index + 1] === undefined) {
    console.error("usage: bun run script/perf-baseline/run-baseline.ts --out .artifacts/perf-baseline/<run-id>")
    process.exit(2)
  }
  return { out: process.argv[index + 1]! }
}

const guard = async (name: string, body: () => Promise<ScenarioOutcome>): Promise<ScenarioOutcome> => {
  console.log(`[perf-baseline] running ${name} ...`)
  try {
    const outcome = await body()
    for (const group of outcome.groups) {
      const summary = group.values.length > 0 ? PerfStats.summarize(group.values) : undefined
      console.log(
        `  ${name}/${group.group}: n=${group.values.length} failures=${group.failures}` +
          (summary ? ` p50=${summary.p50.toFixed(3)}ms p95=${summary.p95.toFixed(3)}ms max=${summary.max.toFixed(3)}ms` : ""),
      )
    }
    if (outcome.status !== "ok") console.log(`  ${name}: status=${outcome.status} (${outcome.unavailable_reason ?? ""})`)
    return outcome
  } catch (error) {
    console.error(`  ${name}: ERROR ${String(error)}`)
    return {
      name,
      owner_note: "",
      status: "error",
      unavailable_reason: String(error),
      evidence_refs: [],
      duration_ms: 0,
      groups: [],
      extras: {},
    }
  }
}

const main = async () => {
  const args = parseArgs()
  const outputDir = path.resolve(process.cwd(), args.out)
  fs.mkdirSync(outputDir, { recursive: true })
  // Redirect every Global.Path.data touch of this harness process (and inherited child env)
  // into an untracked sandbox root; nothing may reach ~/.deepagent.
  const testHome = path.join(outputDir, ".tmp", "harness-home")
  fs.mkdirSync(testHome, { recursive: true })
  // Defense in depth: pre-create the redirected data root so any residual global-path
  // opener finds a sandbox dir instead of SQLITE_CANTOPEN (and never the real home).
  fs.mkdirSync(path.join(testHome, ".deepagent", "code"), { recursive: true })
  process.env.DEEPAGENT_CODE_TEST_HOME = testHome
  // Airtight home redirection: clear the exact override so the data root can never be
  // redirected away from the sandbox, and pin HOME so os.homedir() cannot reach the real
  // account home. Every spawned child (cold-start composition root) inherits these and then
  // overrides DEEPAGENT_CODE_TEST_HOME with its own empty temp home per sample.
  delete process.env.DEEPAGENT_CODE_HOME
  process.env.HOME = testHome
  if (process.platform.startsWith("win")) process.env.USERPROFILE = testHome

  // Prove the sandbox root is the only possible data root before any scenario runs.
  // We assert through the production resolver (packages/core/src/global-path.ts), never by
  // reading the real default data directory (that is forbidden as a measurement object).
  const { resolveDataPath, resolveHomeBase } = await import("@deepagent-code/core/global-path")
  const dataRoot = resolveDataPath(process.env)
  const homeBase = resolveHomeBase(process.env)
  const isolation = {
    isolated: dataRoot.startsWith(testHome) && homeBase === testHome,
    data_root: dataRoot,
    home_base: homeBase,
    test_home: testHome,
    check: "resolveDataPath(process.env) must resolve under testHome and resolveHomeBase must equal testHome; DEEPAGENT_CODE_HOME was cleared, HOME pinned to testHome; sandbox root is the only data root",
  }
  if (!isolation.isolated) {
    throw new Error(`data root isolation check failed: dataRoot=${dataRoot} homeBase=${homeBase} testHome=${testHome}`)
  }
  console.log(`[perf-baseline] isolation ok: dataRoot=${dataRoot}`)

  const startedAtMs = Date.now()
  console.log(EVIDENCE_LEVEL_DECLARATION)
  console.log(`[perf-baseline] out=${outputDir}`)

  const outcomes: ScenarioOutcome[] = []

  outcomes.push(
    await guard("cold-start-to-shell-ready", () =>
      runStartup({ warmup: Number(process.env.PERF_STARTUP_WARMUP ?? 5), measured: Number(process.env.PERF_STARTUP_MEASURED ?? 25) }),
    ),
  )

  const fixtureRoot = path.join(outputDir, ".tmp", "fixture-dbs")
  const fixtures = {} as Record<(typeof DB_TIERS)[number], DbFixture>
  for (const tier of DB_TIERS) {
    console.log(`[perf-baseline] building fixture ${tier} ...`)
    fixtures[tier] = await buildDbFixture(fixtureRoot, tier)
    console.log(
      `  fixture ${tier}: sessions=${fixtures[tier].actual_session_rows} messages=${fixtures[tier].actual_message_rows} bytes=${fixtures[tier].db_bytes} migrate=${fixtures[tier].migrate_ms.toFixed(1)}ms populate=${fixtures[tier].populate_ms.toFixed(1)}ms`,
    )
  }

  outcomes.push(await guard("database-open-migration-check", () => runDatabaseOpen({ fixtures, opensPerTier: 36 })))
  outcomes.push(
    await guard("turn-prepare", () =>
      runTurnPrepare({
        warmup: 5,
        measured: Number(process.env.PERF_TURN_MEASURED ?? 120),
        retries: 30,
        historySamples: 30,
      }),
    ),
  )
  outcomes.push(await guard("system-context-build", () => runSystemContext({ warmup: 5, measured: 60, environmentBytes: 400 })))
  outcomes.push(
    await guard("event-publish-claim", () =>
      runEventBus({ warmup: 10, measured: Number(process.env.PERF_EVENT_MEASURED ?? 300), claims: 60 }),
    ),
  )
  outcomes.push(
    await guard("db-wal-size-write-amplification", () =>
      runDbWalWriteAmplification({
        warmup: 10,
        measured: Number(process.env.PERF_WAL_MEASURED ?? 4000),
        payloadBytes: 1024,
        sizeSampleEvery: 200,
      }),
    ),
  )
  outcomes.push(
    await guard("journal-hydration", () =>
      runJournalHydration([{ sessions: 10 }, { sessions: 100 }, { sessions: 1000 }], { warmSweeps: 3 }),
    ),
  )
  outcomes.push(await guard("long-session-memory-growth", () => runMemoryGrowth({ operations: 1500, rssSampleEvery: 25 })))
  outcomes.push(await guard("four-map-federation-status", () => runFourMapStatus()))

  // Clean our own scratch directories; artifact CSVs/manifest stay.
  fs.rmSync(path.join(outputDir, ".tmp"), { recursive: true, force: true })

  const manifestPath = await buildAndWriteManifest({
    runId: path.basename(outputDir),
    outputDir,
    startedAtMs,
    outcomes,
    fixtureScale: Object.fromEntries(
      DB_TIERS.map((tier) => [
        tier,
        {
          session_rows: fixtures[tier].actual_session_rows,
          message_rows: fixtures[tier].actual_message_rows,
          db_bytes: fixtures[tier].db_bytes,
          builder_migrate_ms: fixtures[tier].migrate_ms,
          builder_populate_ms: fixtures[tier].populate_ms,
        },
      ]),
    ),
    testHome,
    isolation,
    expectations: { commit: FROZEN_COMMIT, tree: FROZEN_TREE },
  })
  console.log(`[perf-baseline] manifest: ${manifestPath}`)
}

await main()
