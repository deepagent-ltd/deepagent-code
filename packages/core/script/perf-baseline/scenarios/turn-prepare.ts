import * as fs from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionHistory } from "@deepagent-code/core/session/history"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { tempRoot, localSessionStack, summarizeGroups, timeEffect, Recorder, type ScenarioOutcome } from "../lib"

export interface TurnPrepareOptions {
  readonly warmup: number
  readonly measured: number
  readonly retries: number
  readonly historySamples: number
}

const PROBE_TEXT = "perf baseline turn prepare probe"

/**
 * Turn preparation segments measurable without a provider:
 *  - prompt admission (durable materialization incl. exact-retry reconciliation read)
 *    through the V2 public entry SessionV2.prompt(resume:false) -> SessionInput.admit.
 *  - projected history reload (legacy-owner projection decode) via SessionHistory.load,
 *    which is what a runner reloads before dispatching a model turn.
 * Everything after these segments (catalog/model resolution, validation, receipt,
 * PreparedProviderTurn assembly, physical llm.stream) is NOT measured here.
 */
export const runTurnPrepare = async (options: TurnPrepareOptions): Promise<ScenarioOutcome> => {
  const startedAt = performance.now()
  const root = tempRoot("turn-prepare")
  const file = path.join(root, "turn-prepare.db")
  const layer = localSessionStack(file)

  const program = Effect.gen(function* () {
    const sessionService = yield* SessionV2.Service
    const { db } = yield* Database.Service
    const recorder = new Recorder()
    const directory = AbsolutePath.make(process.cwd())

    const info = yield* sessionService.create({ location: { directory } })
    const prompt = new Prompt({ text: PROBE_TEXT })

    const admitOnce = Effect.gen(function* () {
      const [admitted, elapsed] = yield* timeEffect(
        sessionService.prompt({ sessionID: info.id, prompt, resume: false }),
      )
      return [admitted, elapsed] as const
    })

    for (let index = 0; index < options.warmup; index++) {
      const [, elapsed] = yield* admitOnce
      recorder.add("admit_warmup", elapsed)
    }
    let admittedSeqHigh = 0
    for (let index = 0; index < options.measured; index++) {
      const [admitted, elapsed] = yield* admitOnce
      admittedSeqHigh = Math.max(admittedSeqHigh, admitted.admittedSeq)
      recorder.add("admit_measured", elapsed)
    }
    // Exact retry of an already-admitted id: prime once (publishes), then time only the
    // find/reconcile fast path which must not re-publish.
    for (let index = 0; index < options.retries; index++) {
      const id = SessionMessage.ID.create()
      yield* sessionService.prompt({ sessionID: info.id, prompt, id, resume: false })
      const [, retryElapsed] = yield* timeEffect(
        sessionService.prompt({ sessionID: info.id, prompt, id, resume: false }),
      )
      recorder.add("exact_retry_reconcile", retryElapsed)
    }

    // History reload over the accumulating probe session (legacy-projected rows decoded).
    for (let index = 0; index < options.historySamples; index++) {
      const [, elapsed] = yield* timeEffect(SessionHistory.load(db, info.id))
      recorder.add("history_reload", elapsed)
    }

    return {
      groups: recorder.results(),
      extras: {
        unit: "ms",
        sample_basis:
          "120 admission samples + 30 exact-retry reconciles + 30 history reloads after 5 warmup admissions; individually sub-ms operations need the larger N for stable p95/p99",
        session_id: info.id,
        admitted_inputs_written: options.warmup + options.measured + options.retries * 2,
        probe_journal_depth_seq: admittedSeqHigh + options.retries * 2,
        segment_ownership:
          "admit_* = V2 durable admission owner (SessionInput.admit under SessionV2.prompt); exact_retry_reconcile = V2 admission reconcile fast path; history_reload = legacy-owner projection decode (session_message rows)",
      },
    }
  }).pipe(Effect.provide(layer))

  try {
    const result = await Effect.runPromise(Effect.scoped(program))
    return summarizeGroups(
      {
        name: "turn-prepare",
        owner_note:
          "measurable pre-dispatch preparation on this alpha: V2 durable prompt admission + exact-retry reconcile (V2 owner), projected history reload (legacy-owner projection). Provider-side prepare stages are UNAVAILABLE.",
        status: "ok",
        evidence_refs: ["packages/core/src/session.ts", "packages/core/src/session/input.ts", "packages/core/src/session/history.ts"],
        groups: result.groups,
        extras: result.extras,
      },
      performance.now() - startedAt,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
