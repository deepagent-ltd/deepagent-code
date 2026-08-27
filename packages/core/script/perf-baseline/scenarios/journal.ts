import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Stream } from "effect"
import { eq, sql } from "drizzle-orm"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { EventV2 } from "@deepagent-code/core/event"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { Database } from "@deepagent-code/core/database/database"
import { EventTable } from "@deepagent-code/core/event/sql"
import { tempRoot, localSessionStack, summarizeGroups, timeEffect, Recorder, type ScenarioOutcome } from "../lib"

export interface JournalTier {
  readonly sessions: number
}

const EVENTS_PER_SESSION = 4
const PROBE_TEXT = "perf baseline journal hydration probe"

/**
 * Journal hydration = draining the per-session durable event log via
 * Event.aggregateEvents (the same durable read the non-interactive journal drive
 * consumes server-side). Fixtures are built through production writers:
 * SessionV2.create + SessionV2.prompt(resume:false) ×EVENTS_PER_SESSION.
 */
export const runJournalHydration = async (
  tiers: readonly JournalTier[],
  options: { readonly warmSweeps: number },
): Promise<ScenarioOutcome> => {
  const startedAt = performance.now()
  const root = tempRoot("journal")
  const tierMeta: Array<Record<string, number | string>> = []
  const groups: Array<ScenarioOutcome["groups"][number]> = []

  for (const tier of tiers) {
    const file = path.join(root, `journal-${tier.sessions}.db`)
    const layer = localSessionStack(file)

    const fixtureProgram = Effect.gen(function* () {
      const sessionService = yield* SessionV2.Service
      const database = yield* Database.Service
      const prompt = new Prompt({ text: PROBE_TEXT })
      // aggregateEvents is a persistent stream (initial drain then a live tail that
      // never completes — see streamEvents in packages/core/src/event.ts), so a
      // bare Stream.runCollect would hang forever. We therefore measure the exact
      // durable row count per session right after writing it and bound every
      // drain with Stream.take(N); the live tail is interrupted at N events.
      const targets: Array<{ readonly id: string; readonly events: number }> = []
      for (let index = 0; index < tier.sessions; index++) {
        const info = yield* sessionService.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
        for (let repeat = 0; repeat < EVENTS_PER_SESSION; repeat++) {
          yield* sessionService.prompt({ sessionID: info.id, prompt, resume: false })
        }
        const counted = yield* database.db
          .select({ n: sql<number>`count(*)` })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, info.id))
          .all()
          .pipe(Effect.orDie)
        targets.push({ id: info.id, events: Number(counted[0]!.n) })
      }
      return targets
    }).pipe(Effect.provide(layer))

    const targets = await Effect.runPromise(Effect.scoped(fixtureProgram))

    // Hydration sweeps against a fresh open of the same DB (restart-shaped).
    const hydrationLayer = localSessionStack(file)
    const drainProgram = Effect.gen(function* () {
      const events = yield* EventV2.Service
      const recorder = new Recorder()
      const drainOnce = (sessionId: string, expected: number) =>
        Stream.runCollect(
          Stream.take(events.aggregateEvents({ aggregateID: sessionId }), expected),
        ).pipe(
          Effect.map((chunk) => Array.from(chunk).length),
        )
      let shortfalls = 0
      for (const target of targets) {
        const [size, coldElapsed] = yield* timeEffect(drainOnce(target.id, target.events))
        if (size !== target.events) shortfalls += 1
        recorder.add(`${tier.sessions}_sessions_cold_first_touch`, coldElapsed)
      }
      for (let sweep = 0; sweep < options.warmSweeps; sweep++) {
        for (const target of targets) {
          const [size, elapsed] = yield* timeEffect(drainOnce(target.id, target.events))
          if (size !== target.events) shortfalls += 1
          recorder.add(`${tier.sessions}_sessions_warm_repeats`, elapsed)
        }
      }
      return { results: recorder.results(), shortfalls }
    }).pipe(Effect.provide(hydrationLayer))

    try {
      const drained = await Effect.runPromise(Effect.scoped(drainProgram))
      groups.push(...drained.results)
      if (drained.shortfalls > 0) throw new Error(`drain delivered fewer events than the measured log rows (${drained.shortfalls} shortfalls)`)
    } catch (error) {
      tierMeta.push({
        tier_sessions: tier.sessions,
        error: String(error),
      })
      continue
    }

    tierMeta.push({
      tier_sessions: tier.sessions,
      events_total_measured: targets.reduce((sum, target) => sum + target.events, 0),
      events_per_session_measured: targets[0]!.events,
      admitted_inputs: tier.sessions * EVENTS_PER_SESSION,
    })
  }

  return summarizeGroups(
    {
      name: "journal-hydration",
      owner_note:
        "per-session durable journal drain through EventV2.aggregateEvents (packages/core/src/event.ts). Writers are production SessionV2.create/prompt admission. Sample unit = one session hydration.",
      status: "ok",
      evidence_refs: ["packages/core/src/event.ts", "packages/deepagent-code/src/session-v2-journal.ts"],
      groups,
      extras: {
        unit: "ms",
        sample_basis:
          "every session hydrated once cold then 3 warm sweeps per tier; the 1000-session tier yields 1000 cold + 3000 warm samples — no sampling reduction applied despite the large tier; each drain is bounded by Stream.take on the DB-measured durable row count (streamEvents has an unterminated live tail, so a bare runCollect would hang; no timeout or outlier trimming involved)",
        warmup_policy: `1 cold first-touch sweep then ${options.warmSweeps} warm sweeps; both reported separately`,
        tiers: tierMeta,
      },
    },
    performance.now() - startedAt,
  )
}
