import { Effect } from "effect"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { PerfStats, type Summary } from "./perf-baseline/stats"
import { Database as BunDatabase } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// C1A-10 durability benchmark. Measures the cost of switching the authority DB from synchronous=NORMAL
// to synchronous=FULL (design §10.6): single-row transactional commit cost at FULL vs NORMAL, and a
// short migration-apply throughput sample, on a temp DB only (never production / DEEPAGENT_CODE_TEST_HOME).
//
// GATE (relative only, machine-stable): FULL median single-row commit must be <= 10x NORMAL median on
// the SAME run. No absolute wall-clock assertion (machine-dependent). The C0-06 baseline budgets
// (startup / turn-prepare) are holistic and are only reported against for context, never asserted here.

const COMMITS = Number(process.env.DURABILITY_COMMITS ?? 800)

// ---------------------------------------------------------------------------
// Single-row transactional commit cost
// ---------------------------------------------------------------------------

const makeCommitDb = (file: string) => {
  const db = new BunDatabase(file, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("CREATE TABLE IF NOT EXISTS bench (id INTEGER PRIMARY KEY, v TEXT NOT NULL)")
  return db
}

const warmup = (db: BunDatabase, synchronous: number, startingId: number, n: number) => {
  db.exec(`PRAGMA synchronous = ${synchronous}`)
  for (let i = 0; i < n; i++) {
    db.exec("BEGIN")
    db.exec(`INSERT INTO bench (id, v) VALUES (${startingId + i}, 'warmup')`)
    db.exec("COMMIT")
  }
}

/** Measure the wall time of `rounds` single-row transactional commits at a given synchronous level. */
const measureCommits = (db: BunDatabase, synchronous: number, startingId: number, rounds: number) => {
  db.exec(`PRAGMA synchronous = ${synchronous}`)
  const samples: number[] = []
  for (let i = 0; i < rounds; i++) {
    const start = performance.now()
    db.exec("BEGIN")
    db.exec(`INSERT INTO bench (id, v) VALUES (${startingId + i}, 'x')`)
    db.exec("COMMIT")
    samples.push(performance.now() - start)
  }
  return samples
}

const summarize = (samples: number[]): Summary => PerfStats.summarize(samples)

// ---------------------------------------------------------------------------
// Migration-apply throughput sample
// ---------------------------------------------------------------------------

const migrationApplySample = async (file: string) => {
  const started = performance.now()
  const applyMs: number[] = []
  // Open a real effect-drizzle DB on the temp file and run the production apply() once, timing only
  // the migration phase (a short throughput sample for context — not part of the gate).
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const t0 = performance.now()
      const run = yield* DatabaseMigration.apply(db)
      applyMs.push(performance.now() - t0)
      // Sanity probe: the run reached a terminal state (ready).
      const state = run?.state ?? "no-pending"
      return { state }
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename: file, disableWAL: false })),
      Effect.scoped,
    ),
  )
  const total = performance.now() - started
  return { result, totalMs: total, applyMs: applyMs[0] }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const tempBase = process.env.DEEPAGENT_CODE_TEST_HOME
  ? path.join(process.env.DEEPAGENT_CODE_TEST_HOME, "tmp")
  : path.join(os.tmpdir(), "deepagent-durability")
fs.mkdirSync(tempBase, { recursive: true })
const tmpDir = fs.mkdtempSync(path.join(tempBase, "durability-"))

const commitFile = path.join(tmpDir, "commit.db")
const commitDb = makeCommitDb(commitFile)
try {
  // Warm up at both levels so the first-commit path is not measured (distinct id ranges).
  warmup(commitDb, 1, 0, 30)
  warmup(commitDb, 2, 1_000_000, 30)

  const normalSamples = measureCommits(commitDb, 1, 10_000_000, COMMITS)
  const fullSamples = measureCommits(commitDb, 2, 20_000_000, COMMITS)

  const normal = summarize(normalSamples)
  const full = summarize(fullSamples)
  const ratio = full.p50 / normal.p50

  const row = (label: string, s: Summary) =>
    `${label}: n=${s.n} p50=${s.p50.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms p99=${s.p99.toFixed(3)}ms mean=${s.mean.toFixed(3)}ms max=${s.max.toFixed(3)}ms`

  console.log("[durability] single-row transactional commit — synchronous=NORMAL vs FULL")
  console.log("  " + row("NORMAL", normal))
  console.log("  " + row("FULL  ", full))
  console.log(`  p50 FULL/NORMAL ratio = ${ratio.toFixed(2)}`)
  console.log(`  p95 FULL/NORMAL ratio = ${(full.p95 / normal.p95).toFixed(2)}`)

  // GATE (relative only): FULL median commit must not exceed 10x NORMAL median on this run.
  if (!Number.isFinite(ratio) || ratio > 10) {
    console.error(`[durability] GATE FAILED: FULL median is ${ratio.toFixed(2)}x NORMAL (> 10x).`)
    process.exitCode = 1
  } else {
    console.log(`[durability] GATE PASSED: FULL median is ${ratio.toFixed(2)}x NORMAL (<= 10x).`)
  }
} finally {
  commitDb.close()
}

const migrateFile = path.join(tmpDir, "migrate.db")
const migrate = await migrationApplySample(migrateFile)
console.log("[durability] migration-apply throughput sample (context, not gated)")
console.log(`  state=${migrate.result.state} totalMs=${migrate.totalMs.toFixed(1)}ms applyMs=${migrate.applyMs.toFixed(1)}ms`)

fs.rmSync(tmpDir, { recursive: true, force: true })
