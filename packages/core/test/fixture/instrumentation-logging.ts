import { Log } from "../../src/util/log"
import { emitStartupBeacon, recordEngagement, emitSummaryBeacon } from "../../src/deepagent/mechanism-beacon"
import { recordTurn, emitTurnSummary } from "../../src/deepagent/turn-observability"

await Log.init({ print: process.argv[2] === "print" })
const file = Log.file()
emitStartupBeacon({})
recordEngagement("context_federation", "fixture")
emitSummaryBeacon()
recordTurn({
  seq: 1,
  finish: "stop",
  toolCalls: 0,
  usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
})
emitTurnSummary()
// Reinitialization closes the preceding file sink before publishing the result.
await Log.init({ print: true })
process.stdout.write(JSON.stringify({ file }))
