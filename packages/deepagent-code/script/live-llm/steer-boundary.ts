import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// Starts the production turn first, waits for SessionRunState to report it busy, then admits a
// durable steer through SessionPrompt.promptOrSteer without awaiting the original turn. The runtime
// records active-turn and durable-pending evidence, so a sequential follow-up cannot satisfy this suite.
const steeringMarker = `steer-boundary-${crypto.randomUUID()}`
const prompt = [
  "Inspect README.md using the read tool before answering.",
  "After the read, summarize the repository in one short paragraph.",
  "Do not finish without checking for newer user direction received while this turn is active.",
].join("\n")
const steerText = `Change direction now. In the final answer include this exact marker once: ${steeringMarker}`

const artifact = await runLegacyLiveCases({
  suite: "steer-boundary-legacy",
  permission: { "*": "deny", read: { "*": "deny", "README.md": "allow" } },
  cases: [{ name: "active-turn", prompt }],
  files: {
    "README.md": "# Steering fixture\n\nA fixture that keeps a production session turn active through tool use.\n",
  },
  steerDuringCases: [{ duringCaseName: "active-turn", text: steerText }],
  primaryPrompt:
    "This is a concurrent steering contract test. Use only allowed tools, absorb newer user direction at turn boundaries, and follow the newest direction in the final answer.",
  modelMaxTokens: 768,
  maxProviderTurns: 8,
})

const observation = artifact.cases[0]
assert(observation, "steer-boundary produced no observation")
assert(!prompt.includes(steeringMarker), "steering marker leaked into the initiating prompt")
assert(observation.steering.length === 1, `expected one concurrent steer, got ${observation.steering.length}`)
const steering = observation.steering[0]
assert(steering, "missing concurrent steering evidence")
assert(steering.delivery === "steer", `unexpected steering delivery channel: ${steering.delivery}`)
assert(steering.activeBeforeAdmission, "steer was not admitted while the original turn was active")
assert(steering.pendingAfterAdmission, "steer was not durable immediately after active-turn admission")
assert(steering.consumedAfterAdmission, "steer remained pending after active-turn admission")
assert(
  observation.newTools.some((tool) => tool.name === "read" && tool.status === "completed"),
  "initiating turn did not execute the required read tool",
)
assertIncludes(observation.finalText, steeringMarker, "steered final response")
assert(
  observation.finalText.split(steeringMarker).length === 2,
  "steered final response did not include the marker exactly once",
)
assert(observation.assistantTurns >= 2, "steered turn did not cross a provider boundary after admission")

const result = {
  ...artifact,
  evidence: {
    markerHash: Bun.hash(steeringMarker).toString(16),
    activeBeforeAdmission: steering.activeBeforeAdmission,
    pendingAfterAdmission: steering.pendingAfterAdmission,
    consumedAfterAdmission: steering.consumedAfterAdmission,
    ordinal: steering.ordinal,
    delivery: steering.delivery,
    assistantTurns: observation.assistantTurns,
    toolSequence: observation.newTools.map((tool) => `${tool.name}:${tool.status}`),
    finalTextLength: observation.finalText.length,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${observation.usage.input + observation.usage.output} tokens)`,
)

finishLiveScript()

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertIncludes(value: string, expected: string, label: string): void {
  assert(value.includes(expected), `${label} missing required text: ${expected}`)
}
