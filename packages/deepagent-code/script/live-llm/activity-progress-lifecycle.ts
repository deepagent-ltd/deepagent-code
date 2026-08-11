import { loadLiveLLMConfig, writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { assertActivityProgressObservation } from "./activity-progress-oracle"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const config = await loadLiveLLMConfig()
if (config.providerID !== "deepseek" || config.modelID !== "deepseek-v4-flash") {
  throw new Error("Activity progress release test requires DeepSeek deepseek-v4-flash")
}

const marker = `activity-progress-${crypto.randomUUID()}`
const facts = Array.from({ length: 3 }, (_, index) => ({
  path: `facts/${index + 1}.txt`,
  value: `durable-fact-${index + 1}-${crypto.randomUUID()}`,
}))
const triggerText = [
  `Read ${facts.map((fact) => fact.path).join(", ")} in that exact order.`,
  "Issue exactly one read call per assistant turn and wait for each result before reading the next file.",
  "After all reads, return the three file values in order in one short final line.",
  "Before every action, absorb any newer user direction delivered while this turn is active.",
].join(" ")
const steerText = [
  "Keep the same read sequence and do not repeat any completed read.",
  `In the final line append this exact marker once: ${marker}`,
].join(" ")

const artifact = await runLegacyLiveCases({
  suite: "activity-progress-lifecycle-legacy",
  config,
  permission: {
    "*": "deny",
    read: { "*": "deny", ...Object.fromEntries(facts.map((fact) => [fact.path, "allow" as const])) },
  },
  cases: [{ name: "tool-continuation-with-steer", prompt: triggerText }],
  files: Object.fromEntries(facts.map((fact) => [fact.path, `${fact.value}\n`])),
  steerDuringCases: [{ duringCaseName: "tool-continuation-with-steer", text: steerText }],
  primaryPrompt: [
    "This is a durable activity/progress lifecycle test.",
    "Use only the read tool explicitly requested by the current user and issue exactly one tool call per assistant turn.",
    "At every provider boundary absorb newer steer input, continue unfinished work once, and never repeat a completed tool call.",
    "The final answer must contain only the requested fact values and marker, each exactly once.",
  ].join(" "),
  inspectDurability: true,
  observeAssembledRequestFingerprints: true,
  modelMaxTokens: 768,
  maxProviderTurns: 8,
})

await writeLiveArtifact(config, `${artifact.suite}-observed`, artifact, {
  redactions: [
    { value: marker, replacement: "<activity-progress-marker>" },
    ...facts.map((fact, index) => ({ value: fact.value, replacement: `<activity-fact-${index + 1}>` })),
  ],
})
if (artifact.status !== "passed") {
  throw new Error(`Activity progress Provider run failed: ${JSON.stringify(artifact.error)}`)
}
const observation = artifact.cases[0]
if (!observation) throw new Error("Activity progress suite produced no observation")
const evidence = assertActivityProgressObservation({
  caseName: observation.name,
  triggerText,
  steerText,
  marker,
  expectedTools: facts.map(() => "read"),
  observation,
})
facts.forEach((fact, index) => {
  if (!observation.finalText.includes(fact.value)) {
    throw new Error(`Activity progress final response omitted fact ${index + 1}`)
  }
})
const indexes = [
  ...facts.map((fact) => observation.finalText.indexOf(fact.value)),
  observation.finalText.indexOf(marker),
]
if (
  indexes.some((index) => index < 0) ||
  indexes.some((index, offset) => offset > 0 && index <= indexes[offset - 1]!)
) {
  throw new Error(`Activity progress final evidence was missing or out of order: ${indexes.join(", ")}`)
}
if (artifact.workspace.status.trim()) throw new Error("Activity progress read-only suite mutated the workspace")

const result = {
  ...artifact,
  evidence: {
    provider: config.providerID,
    model: config.modelID,
    markerHash: Bun.hash(marker).toString(16),
    factHashes: facts.map((fact) => Bun.hash(fact.value).toString(16)),
    activityIDHash: Bun.hash(evidence.activity.activity_id).toString(16),
    activityState: evidence.activity.state,
    progressStates: evidence.progress.map((progress) => `${progress.revision}:${progress.state}`),
    assistantTurns: observation.assistantTurns,
    toolSequence: observation.newTools.map((tool) => `${tool.name}:${tool.status}`),
    userMessages: observation.users.length,
  },
}
await writeLiveArtifact(config, result.suite, result, {
  redactions: [
    { value: marker, replacement: `<activity-progress-marker hash=${result.evidence.markerHash}>` },
    ...facts.map((fact, index) => ({
      value: fact.value,
      replacement: `<activity-fact-${index + 1} hash=${result.evidence.factHashes[index]}>`,
    })),
  ],
})
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${result.evidence.assistantTurns} assistant turns, ${result.evidence.progressStates.length} progress revisions)`,
)

finishLiveScript()
