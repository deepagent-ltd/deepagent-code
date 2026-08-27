import * as fs from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { tempRoot, localSessionStack, summarizeGroups, timeEffect, type ScenarioOutcome } from "../lib"
import { slopePerStep } from "../stats"

export interface MemoryOptions {
  readonly operations: number
  readonly rssSampleEvery: number
}

const PROBE_TEXT = "perf baseline long-run memory probe. ".repeat(4)

/**
 * Long-run growth proxy on the durable path: a single process repeatedly admits
 * prompts (durable writes, journal growth) and RSS is sampled every N operations.
 * No model execution and no compaction are involved — this measures sustained
 * durable admission pressure in one process, not full provider-turn lifecycle.
 */
export const runMemoryGrowth = async (options: MemoryOptions): Promise<ScenarioOutcome> => {
  const startedAt = performance.now()
  const root = tempRoot("memory")
  const file = path.join(root, "memory.db")
  const layer = localSessionStack(file)

  const program = Effect.gen(function* () {
    const sessionService = yield* SessionV2.Service
    const info = yield* sessionService.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
    const prompt = new Prompt({ text: PROBE_TEXT })

    const rssSeries: number[] = []
    const admitTimings: number[] = []
    for (let index = 1; index <= options.operations; index++) {
      const [, elapsed] = yield* timeEffect(sessionService.prompt({ sessionID: info.id, prompt, resume: false }))
      if (index % Math.max(1, Math.floor(options.operations / 500)) === 0 || index <= 20) admitTimings.push(elapsed)
      if (index % options.rssSampleEvery === 0) rssSeries.push(process.memoryUsage().rss)
    }
    yield* sessionService.prompt({ sessionID: info.id, prompt, resume: false })

    return {
      rss_series: rssSeries,
      admit_sample_timings: admitTimings,
      sessions_created: 1,
      admitted_inputs: options.operations + 1,
      logical_prompt_bytes: (options.operations + 1) * PROBE_TEXT.length,
    }
  }).pipe(Effect.provide(layer))

  try {
    const result = await Effect.runPromise(Effect.scoped(program))
    const firstRss = result.rss_series[0]!
    const lastRss = result.rss_series[result.rss_series.length - 1]!
    return summarizeGroups(
      {
        name: "long-session-memory-growth",
        owner_note:
          "single-process RSS under repeated V2 durable prompt admission (no model turns, no compaction). Sample unit = bytes of RSS.",
        status: "ok",
        evidence_refs: ["packages/core/src/session.ts"],
        groups: [{ group: "admit_wall_time_subsample", values: result.admit_sample_timings, failures: 0 }],
        extras: {
          unit_rss: "bytes",
          unit_admit: "ms",
          sample_basis:
            "1500 admission operations; RSS sampled every 25 ops (60 samples) for the slope; admit wall times are a declared subsample (~500+first20), not the full population",
          operations: options.operations,
          rss_samples: result.rss_series.length,
          rss_first_bytes: firstRss,
          rss_last_bytes: lastRss,
          rss_min_bytes: Math.min(...result.rss_series),
          rss_max_bytes: Math.max(...result.rss_series),
          rss_slope_bytes_per_sample_step: slopePerStep(result.rss_series),
          rss_sample_every_operations: options.rssSampleEvery,
          admitted_inputs: result.admitted_inputs,
          logical_prompt_bytes_written: result.logical_prompt_bytes,
          db_file_bytes_after: fs.existsSync(file) ? fs.statSync(file).size : 0,
          db_wal_bytes_after: fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0,
        },
      },
      performance.now() - startedAt,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
