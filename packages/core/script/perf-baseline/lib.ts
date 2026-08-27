import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionV2 } from "@deepagent-code/core/session"
import { PerfStats, type Summary } from "./stats"

export interface GroupResult {
  readonly group: string
  readonly values: readonly number[]
  readonly failures: number
}

export interface ScenarioOutcome {
  readonly name: string
  /** What actually owns the measured code path today (legacy | v2 | ...). */
  readonly owner_note: string
  readonly status: "ok" | "unavailable" | "error"
  readonly unavailable_reason?: string
  readonly evidence_refs: readonly string[]
  readonly duration_ms: number
  readonly groups: readonly GroupResult[]
  readonly extras?: Record<string, unknown>
}

export const nowMs = () => performance.now()

/** Wall-clock around an async body; the timer wraps exactly the awaited work. */
export const stopwatch = async <A>(body: () => Promise<A>): Promise<[A, number]> => {
  const started = nowMs()
  const value = await body()
  return [value, nowMs() - started]
}

/**
 * Effect timing helper: returns [value, elapsed-ms]. Uses performance.now around
 * a suspended effect instead of Effect.timed so clock reading matches every other
 * scenario and stays unit-consistent (ms, floating point).
 */
export const timeEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const started = nowMs()
    return effect.pipe(Effect.map((value) => [value, nowMs() - started] as const))
  })

/** Mutable accumulator usable inside Effect.gen loops; converted to GroupResult[] afterwards. */
export class Recorder {
  readonly buckets = new Map<string, number[]>()
  readonly failures = new Map<string, number>()

  add(group: string, value: number) {
    const bucket = this.buckets.get(group)
    if (bucket === undefined) this.buckets.set(group, [value])
    else bucket.push(value)
  }

  fail(group: string) {
    this.failures.set(group, (this.failures.get(group) ?? 0) + 1)
  }

  results(): GroupResult[] {
    return Array.from(this.buckets.entries()).map(([group, values]) => ({
      group,
      values,
      failures: this.failures.get(group) ?? 0,
    }))
  }
}

export const summarizeGroups = (outcome: Omit<ScenarioOutcome, "duration_ms">, durationMs: number): ScenarioOutcome => ({
  ...outcome,
  duration_ms: durationMs,
})

export interface SummaryRow {
  readonly scenario: string
  readonly group: string
  readonly owner_note: string
  readonly fixture?: unknown
  readonly summary: Summary
  readonly failures: number
  readonly extras?: Record<string, number>
}

export const tempRoot = (label: string) => fs.mkdtempSync(path.join(os.tmpdir(), `deepagent-perf-${label}-`))

/**
 * Full V2 session stack bound to ONE fixture sqlite file. Mirrors the production-test
 * composition (packages/core/test/session-create.test.ts) so every collaborator — events,
 * store, projector, project resolution — reads and writes the same local file instead of
 * silently falling back to the process-global data root.
 */
export const localSessionStack = (file: string) => {
  const database = Database.layerFromPath(file)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const projects = ProjectV2.layer.pipe(
    Layer.provide(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Git.defaultLayer),
  )
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(database, events, projects, projector, store, sessions)
}

export const summarizeAll = (recorder: Recorder): Record<string, Summary> =>
  Object.fromEntries(Array.from(recorder.buckets.entries()).map(([group, values]) => [group, PerfStats.summarize(values)]))
