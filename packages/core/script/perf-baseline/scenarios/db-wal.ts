import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { tempRoot, summarizeGroups, timeEffect, Recorder, type ScenarioOutcome } from "../lib"

const Probe = EventV2.define({
  type: "perf.wal.probe",
  sync: { version: 1, aggregate: "key" },
  schema: { key: Schema.String, blob: Schema.String },
})

export interface DbWalOptions {
  readonly warmup: number
  readonly measured: number
  readonly payloadBytes: number
  readonly sizeSampleEvery: number
}

interface SizeSnapshot {
  readonly db_bytes: number
  readonly wal_bytes: number
}

const sizeSnapshot = (file: string): SizeSnapshot => ({
  db_bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
  wal_bytes: fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0,
})

/**
 * Write-amplification observation against the production open path and the production
 * durable event bus on ONE fresh temp database (WAL mode with wal_autocheckpoint=200
 * pages is what Database.layerFromPath itself configures — packages/core/src/database/database.ts).
 *
 * Observable physical quantities: main-db file growth, WAL high-water mark over the burst,
 * WAL residue after an explicit TRUNCATE checkpoint, and the number of in-run WAL collapse
 * episodes (approximate autocheckpoint count). These are reported next to the exact logical
 * payload bytes; cumulative byte counters that the OS would need are declared out of scope.
 */
export const runDbWalWriteAmplification = async (options: DbWalOptions): Promise<ScenarioOutcome> => {
  const startedAt = performance.now()
  const root = tempRoot("db-wal")
  const file = path.join(root, "db-wal.db")
  const databaseLayer = Database.layerFromPath(file)
  const layer = Layer.mergeAll(databaseLayer, EventV2.layer.pipe(Layer.provide(databaseLayer)))

  const program = Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const recorder = new Recorder()
    const key = "ses_perf_wal_probe"

    // The post-migration baseline: schema pages exist but no probe rows yet.
    const beforeWrites = sizeSnapshot(file)

    const payloadOf = (index: number) => ({
      key,
      blob: `${String(index).padStart(8, "0")}${"x".repeat(Math.max(0, options.payloadBytes - 24))}`,
    })

    for (let index = 0; index < options.warmup; index++) {
      const [, elapsed] = yield* timeEffect(events.publish(Probe, payloadOf(index)))
      recorder.add("publish_warmup", elapsed)
    }

    const walSeries: number[] = []
    const dbSeries: number[] = []
    let logicalPayloadBytes = 0
    for (let index = 0; index < options.measured; index++) {
      const payload = payloadOf(options.warmup + index)
      logicalPayloadBytes += JSON.stringify(payload).length
      const [, elapsed] = yield* timeEffect(events.publish(Probe, payload))
      recorder.add("publish_measured", elapsed)
      if ((index + 1) % options.sizeSampleEvery === 0 || index === options.measured - 1) {
        const snapshot = sizeSnapshot(file)
        walSeries.push(snapshot.wal_bytes)
        dbSeries.push(snapshot.db_bytes)
      }
    }

    const peakWalBytes = Math.max(...walSeries)
    const beforeCheckpoint = sizeSnapshot(file)
    yield* database.db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie)
    const afterCheckpoint = sizeSnapshot(file)

    // Every sample where the WAL shrank by more than half marks one merge into the main db
    // (manual TRUNCATE checkpoints only happen after the loop, so each drop is an autocheckpoint).
    let checkpointEpisodes = 0
    for (let index = 1; index < walSeries.length; index++) {
      if (walSeries[index]! < walSeries[index - 1]! / 2) checkpointEpisodes += 1
    }

    return {
      groups: recorder.results(),
      sizes: {
        db_bytes_before_writes: beforeWrites.db_bytes,
        db_bytes_peak_during_writes: Math.max(...dbSeries),
        db_bytes_after_checkpoint: afterCheckpoint.db_bytes,
        wal_high_water_bytes: peakWalBytes,
        wal_bytes_at_loop_end: beforeCheckpoint.wal_bytes,
        wal_bytes_after_truncate_checkpoint: afterCheckpoint.wal_bytes,
        db_growth_over_logical_payload_ratio:
          logicalPayloadBytes > 0 ? (afterCheckpoint.db_bytes - beforeWrites.db_bytes) / logicalPayloadBytes : 0,
        logical_payload_bytes: logicalPayloadBytes,
        estimated_autocheckpoint_episodes: checkpointEpisodes,
      },
      wal_series_bytes: walSeries,
      db_series_bytes: dbSeries,
    }
  }).pipe(Effect.provide(layer))

  try {
    const result = await Effect.runPromise(Effect.scoped(program))
    return summarizeGroups(
      {
        name: "db-wal-size-write-amplification",
        owner_note:
          "sizes and amplification observed through the production writer stack (Database.layerFromPath PRAGMAs + EventV2 durable publish); unit = bytes for size fields, ms for publish wall times",
        status: "ok",
        evidence_refs: ["packages/core/src/database/database.ts", "packages/core/src/event/sql.ts"],
        groups: result.groups,
        extras: {
          unit: "ms",
          unit_sizes: "bytes",
          ...result.sizes,
          wal_series_bytes: result.wal_series_bytes,
          db_series_bytes: result.db_series_bytes,
          sample_basis: `one fresh temp database; ${options.measured} measured publishes of ~${options.payloadBytes}B payloads after ${options.warmup} warmups; file sizes sampled every ${options.sizeSampleEvery} writes plus at loop end`,
          limitation:
            "db_growth/logical-payload is the durable-storage amplification observable from file metadata; total bytes physically written by SQLite per statement needs OS-level counters and is out of scope (declared)",
        },
      },
      performance.now() - startedAt,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
