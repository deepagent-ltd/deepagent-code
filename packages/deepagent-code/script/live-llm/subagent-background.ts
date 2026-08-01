import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const marker = `background-${crypto.randomUUID()}`
const release = `release-${crypto.randomUUID()}`
const prompt = [
  "Call task exactly once with background=true, subagent_type researcher, and description background fixture research.",
  "Your first action must be task. In the parent, use only task, task_status, and task_read; never invent or call file, search, or shell tools.",
  "The child prompt must be exactly: Read fixtures/background.txt exactly once. Then call question exactly once to ask for the release word, with one Continue option. After the answer arrives, return a valid ResearchResult whose mechanism is the exact file content followed by one space and the exact question answer. Do not call task.",
  "Do not read the fixture in the parent and do not poll while the task is running.",
  "End the current response after the background task starts.",
  "When the automatic completion notification arrives, call task_status exactly once and task_read exactly once for that completed task id with limit 100 and no before cursor.",
  "Finally report the evidence obtained only from the completion notification and task transcript.",
].join("\n")
const artifact = await runLegacyLiveCases({
  suite: "subagent-background-legacy",
  permission: { "*": "deny", read: "allow", question: "allow" },
  primaryPermission: { "*": "deny", task: "allow", task_status: "allow", task_read: "allow" },
  questionAction: { type: "background", reply: release },
  awaitParentTools: ["task", "task_status", "task_read"],
  primaryPrompt:
    "This parent is a constrained background task supervision test. Use only task, task_status, and task_read in the exact requested order. Never call unavailable file, search, or shell tools.",
  cases: [{ name: "background", prompt }],
  files: { "fixtures/background.txt": `${marker}\n` },
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
)

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing background subagent observation")
if (prompt.includes(marker) || prompt.includes(release)) throw new Error("Background evidence leaked into the parent prompt")
if (observation.children.length !== 1) {
  throw new Error(`Expected one background child, received ${observation.children.length}`)
}
const child = observation.children[0]
if (!child || child.parentID !== observation.sessionID || child.agent !== "researcher") {
  throw new Error("Background child lineage or agent identity is incorrect")
}
const subagent = nestedRecord(child.metadata, ["deepagent", "subagent"])
if (subagent.state !== "completed" || subagent.finished !== true || subagent.reason !== "structured_output_valid") {
  throw new Error(`Background child has invalid durable metadata: ${JSON.stringify(subagent)}`)
}
const latch = observation.questionRequests.find(
  (request) =>
    request.sessionID === child.id &&
    request.latch?.type === "background" &&
    request.latch.parentSessionID === observation.sessionID &&
    request.latch.taskRunning === true,
)
if (!latch) throw new Error("Background Question latch did not observe a nonterminal parent task result")
const task = observation.tools.find((tool) => tool.name === "task" && tool.status === "completed")
const status = observation.tools.find((tool) => tool.name === "task_status" && tool.status === "completed")
const transcript = observation.tools.find((tool) => tool.name === "task_read" && tool.status === "completed")
const expectedParentTools = ["task", "task_status", "task_read"]
if (
  observation.tools.length !== expectedParentTools.length ||
  observation.tools.some(
    (tool, index) => tool.name !== expectedParentTools[index] || tool.status !== "completed",
  )
) {
  throw new Error(
    `Parent tool sequence mismatch: ${observation.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}
if (!task?.output?.includes('state="running"') || !task.output.includes(child.id)) {
  throw new Error("Background task did not return immediately in running state")
}
if (!status?.output?.includes("[completed]") || !status.output.includes(child.id)) {
  throw new Error("task_status did not report the completed background child")
}
if (
  !transcript?.output?.includes('state="completed"') ||
  !transcript.output.includes(marker) ||
  !transcript.output.includes(release)
) {
  throw new Error("task_read did not expose the completed background transcript")
}
if (!observation.allText.includes(marker) || !observation.allText.includes(release)) {
  throw new Error("Automatic background continuation did not report the child evidence")
}
const childTools = child.assistants.flatMap((assistant) => assistant.tools)
if (!childTools.some((tool) => tool.name === "read" && tool.status === "completed" && tool.output?.includes(marker))) {
  throw new Error("Background child did not obtain its marker through read")
}
if (!childTools.some((tool) => tool.name === "question" && tool.status === "completed" && tool.output?.includes(release))) {
  throw new Error("Background child did not resume from the Question latch answer")
}
if (
  child.model?.providerID !== "live-deepseek" ||
  child.model.id !== artifact.fingerprint.modelID ||
  child.assistants.some(
    (assistant) =>
      assistant.providerID !== "live-deepseek" || assistant.modelID !== artifact.fingerprint.modelID,
  )
) {
  throw new Error("Background child persisted the wrong provider/model identity")
}

const result = {
  ...artifact,
  evidence: {
    markerHash: Bun.hash(marker).toString(16),
    releaseHash: Bun.hash(release).toString(16),
    childSessionIDLength: child.id.length,
    childMessageCount: child.messageCount,
    nonterminalLatch: true,
    automaticContinuation: true,
    durableState: subagent.state,
    parentTools: observation.tools.map((tool) => `${tool.name}:${tool.status}`),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(`${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID})`)

function nestedRecord(value: unknown, keys: string[]) {
  const result = keys.reduce<Record<string, unknown> | undefined>((current, key) => {
    if (!current) return undefined
    const next = current[key]
    if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined
    return next as Record<string, unknown>
  }, typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)
  if (!result) throw new Error(`Missing object path ${keys.join(".")}`)
  return result
}

finishLiveScript()
