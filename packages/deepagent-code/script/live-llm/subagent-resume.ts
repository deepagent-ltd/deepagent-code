import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const firstMarker = `resume-first-${crypto.randomUUID()}`
const secondMarker = `resume-second-${crypto.randomUUID()}`
const artifact = await runLegacyLiveCases({
  suite: "subagent-resume-legacy",
  permission: { "*": "deny", read: "allow" },
  primaryPermission: { "*": "deny", task: "allow" },
  files: {
    "fixtures/resume-first.txt": `${firstMarker}\n`,
    "fixtures/resume-second.txt": `${secondMarker}\n`,
  },
  inspectTaskRuns: true,
  cases: [
    {
      name: "resume",
      prompt: [
        "Call task in foreground with subagent_type researcher and description 'resume phase one'.",
        "Its prompt must tell it to read fixtures/resume-first.txt and return a valid ResearchResult whose mechanism is that exact file content.",
        "After it completes, extract the task id from the real result.",
        "Call task a second time in foreground with the same subagent_type, task_id set to that exact id, and description 'resume phase two'.",
        "The second prompt must tell the existing child to read fixtures/resume-second.txt and return a valid ResearchResult whose mechanism contains both the prior first marker and the new exact file content.",
        "Do not create a fresh second child and do not call another tool. Finally report both markers from the resumed result.",
      ].join("\n"),
    },
  ],
})

await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
)
const observation = artifact.cases[0]
if (!observation) throw new Error("Missing subagent resume observation")
if (observation.providerErrors.length > 0) {
  throw new Error(`Subagent resume provider turn failed: ${JSON.stringify(observation.providerErrors)}`)
}
const tasks = observation.tools.filter((tool) => tool.name === "task" && tool.status === "completed")
if (observation.tools.length !== 2 || tasks.length !== 2 || observation.children.length !== 1) {
  throw new Error("Parent did not make two completed task calls against one child")
}
const child = observation.children[0]!
if (
  child.parentID !== observation.sessionID || child.agent !== "researcher" ||
  child.v2Assistants.length === 0 ||
  child.v2Assistants.some((assistant) => assistant.model.providerID !== artifact.fingerprint.runtimeProviderID ||
    assistant.model.id !== artifact.fingerprint.modelID) ||
  child.v2ProviderTurns.length < 4 ||
  child.v2ProviderTurns.some((turn) => turn.providerID !== artifact.fingerprint.runtimeProviderID ||
    turn.modelID !== artifact.fingerprint.modelID || turn.state !== "settled")
) {
  throw new Error("Resumed V2 child has invalid lineage or provider/model receipts")
}
const secondInput = tasks[1]?.input
if (typeof secondInput !== "object" || secondInput === null || secondInput.task_id !== child.id) {
  throw new Error("Second task call did not reuse the persisted child Session id")
}
const reads = child.v2Tools.filter((tool) => tool.name === "read" && tool.status === "completed")
if (
  child.v2Tools.length !== 2 || reads.length !== 2 ||
  !reads.some((tool) => typeof tool.input === "object" && tool.input !== null &&
    tool.input.path === "fixtures/resume-first.txt" && tool.output === `${firstMarker}\n`) ||
  !reads.some((tool) => typeof tool.input === "object" && tool.input !== null &&
    tool.input.path === "fixtures/resume-second.txt" && tool.output === `${secondMarker}\n`)
) {
  throw new Error("Resumed child did not read both phase fixtures exactly once")
}
const runs = observation.taskRuns ?? []
if (
  runs.length !== 1 || runs[0]?.executionRuntime !== "v2" || runs[0].state !== "completed" ||
  runs[0].childSessionID !== child.id || runs[0].generation !== 1 ||
  child.structuredEvidence?.length !== 1 || child.structuredEvidence[0]?.validationOutcome !== "validated"
) {
  throw new Error(`Resumed child initial durable run is invalid: ${JSON.stringify(runs)}`)
}
const childText = child.v2Assistants.map((assistant) => assistant.text).join("\n")
if (!childText.includes(firstMarker) || !childText.includes(secondMarker)) {
  throw new Error("Resumed child transcript did not retain and extend the evidence")
}
if (!tasks[1]?.output?.includes(firstMarker) || !tasks[1].output.includes(secondMarker) ||
  !observation.finalText.includes(firstMarker) || !observation.finalText.includes(secondMarker)) {
  throw new Error("Resumed result did not reach the parent")
}
const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    firstMarkerHash: Bun.hash(firstMarker).toString(16),
    secondMarkerHash: Bun.hash(secondMarker).toString(16),
    childCount: observation.children.length,
    taskCalls: tasks.length,
    durableRuns: runs.length,
    childReadCalls: reads.length,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(`${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID})`)

finishLiveScript()
