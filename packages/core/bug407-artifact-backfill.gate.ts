const database = process.env.BUG407_GATE_DATABASE
if (!database) throw new Error("BUG407_GATE_DATABASE is required")

process.env.DEEPAGENT_CODE_DB = database

const { Effect } = await import("effect")
const { EventV2 } = await import("./src/event.ts")

const started = performance.now()
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    let cursor: EventV2.ID | undefined
    let batches = 0
    let processed = 0

    while (true) {
      const page = yield* events.canonicalizeLegacyArtifacts({
        ...(cursor ? { afterID: cursor } : {}),
        limit: EventV2.LEGACY_ARTIFACT_BATCH_EVENTS,
      })
      batches += 1
      processed += page.processed
      if (!page.next) break
      cursor = page.next
    }

    return { batches, processed }
  }).pipe(Effect.provide(EventV2.defaultLayer)),
)

process.stdout.write(`${JSON.stringify({ ...result, elapsedMs: Math.round(performance.now() - started) })}\n`)
