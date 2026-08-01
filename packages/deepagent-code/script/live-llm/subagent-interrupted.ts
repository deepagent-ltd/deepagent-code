import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const marker = `partial-${crypto.randomUUID()}`
const prompt = [
  "Call task exactly once in foreground mode with subagent_type researcher and description interrupted fixture research.",
  "Your first action must be task. In the parent, use only task, task_status, and task_read; never invent or call file/search tools.",
  "The child prompt must be exactly: Read fixtures/partial.txt exactly once. Then call question exactly once to ask whether to continue, with one Continue option. Do not return a final result before the question is answered. Do not call task.",
  "Do not read the fixture in the parent.",
  "The child will be interrupted by the test operator while its question is pending.",
  "After task reports the interruption, do not retry it. Call task_status exactly once, then call task_read exactly once for the interrupted task id with limit 100 and no before cursor.",
  "Finally report the partial evidence recovered only from task_read and state that the child was interrupted.",
].join("\n")
const artifact = await runLegacyLiveCases({
  suite: "subagent-interrupted-legacy",
  permission: { "*": "deny", read: "allow", question: "allow" },
  primaryPermission: { "*": "deny", task: "allow", task_status: "allow", task_read: "allow" },
  questionAction: { type: "abort" },
  primaryPrompt:
    "This parent is a constrained task supervision test. Use only task, task_status, and task_read in the exact requested order. Never call unavailable file or search tools.",
  cases: [{ name: "interrupted", prompt }],
  files: { "fixtures/partial.txt": `${marker}\n` },
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
)

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing interrupted subagent observation")
if (prompt.includes(marker)) throw new Error("Interrupted marker leaked into the parent prompt")
if (observation.children.length !== 1) {
  throw new Error(`Expected one interrupted child, received ${observation.children.length}`)
}
const child = observation.children[0]
if (!child || child.parentID !== observation.sessionID || child.agent !== "researcher") {
  throw new Error("Interrupted child lineage or agent identity is incorrect")
}
const subagent = nestedRecord(child.metadata, ["deepagent", "subagent"])
if (subagent.state !== "interrupted" || subagent.finished !== true || subagent.reason !== "human") {
  throw new Error(`Interrupted child has invalid durable metadata: ${JSON.stringify(subagent)}`)
}
const childTools = child.assistants.flatMap((assistant) => assistant.tools)
const read = childTools.find(
  (tool) => tool.name === "read" && tool.status === "completed" && tool.output?.includes(marker),
)
if (!read?.output?.includes(marker)) throw new Error("Interrupted child did not persist completed read evidence")
const pendingQuestion = observation.questionRequests.find(
  (request) => request.sessionID === child.id && request.latch?.type === "abort",
)
if (!pendingQuestion) throw new Error("Interrupted child was not cancelled through the Question event latch")
const task = observation.tools.find((tool) => tool.name === "task")
const status = observation.tools.find((tool) => tool.name === "task_status" && tool.status === "completed")
const transcript = observation.tools.find((tool) => tool.name === "task_read" && tool.status === "completed")
const unexpected = observation.tools.filter(
  (tool) => !["task", "task_status", "task_read"].includes(tool.name),
)
if (unexpected.length > 0) {
  throw new Error(
    `Parent called unexpected tools: ${unexpected.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}
if (task?.status !== "error" || !task.error?.includes("Partial work is preserved")) {
  throw new Error(`Foreground task did not surface the typed interruption recovery hint: ${task?.error}`)
}
if (!status?.output?.includes("[interrupted]") || !status.output.includes(child.id)) {
  throw new Error("task_status did not report the interrupted child")
}
if (!transcript?.output?.includes('state="interrupted"') || !transcript.output.includes(marker)) {
  throw new Error("task_read did not recover the interrupted child's completed evidence")
}
if (!observation.finalText.includes(marker) || !observation.finalText.toLowerCase().includes("interrupt")) {
  throw new Error("Parent did not report recovered interrupted evidence")
}
if (
  child.model?.providerID !== "live-deepseek" ||
  child.model.id !== artifact.fingerprint.modelID ||
  child.assistants.some(
    (assistant) =>
      assistant.providerID !== "live-deepseek" || assistant.modelID !== artifact.fingerprint.modelID,
  )
) {
  throw new Error("Interrupted child persisted the wrong provider/model identity")
}

const result = {
  ...artifact,
  evidence: {
    markerHash: Bun.hash(marker).toString(16),
    childSessionIDLength: child.id.length,
    childMessageCount: child.messageCount,
    childCompletedRead: true,
    questionLatch: "abort",
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
