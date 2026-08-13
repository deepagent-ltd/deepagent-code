const database = process.env.BUG407_GATE_DATABASE
if (!database) throw new Error("BUG407_GATE_DATABASE is required")

process.env.DEEPAGENT_CODE_DB = database

const { Effect } = await import("effect")
const { EventV2 } = await import("./src/event.ts")

const started = performance.now()
await Effect.runPromise(Effect.gen(function* () {
  yield* EventV2.Service
}).pipe(Effect.provide(EventV2.defaultLayer)))
process.stdout.write(`${JSON.stringify({ elapsedMs: Math.round(performance.now() - started) })}\n`)
