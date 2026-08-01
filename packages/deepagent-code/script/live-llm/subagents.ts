import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const marker = `child-${crypto.randomUUID()}`
const evidence = `The fixture mechanism is keyed by ${marker}.`
const prompt = [
  "Call task exactly once in foreground mode with subagent_type researcher and description live fixture research.",
  'The child prompt must be exactly: Read fixtures/research.txt. Return a valid ResearchResult with mechanism set to the file content exactly, without quotes or explanation. Do not call task.',
  "Do not read the fixture in the parent.",
  "After task completes, call task_status exactly once. Extract the completed child task id from its result.",
  "Then call task_read exactly once for that task id with limit 100 and no before cursor. Do not call task again.",
  "Finally report the exact child evidence obtained from the task tools.",
].join("\n")
const artifact = await runLegacyLiveCases({
  suite: "subagent-foreground-legacy",
  permission: { "*": "deny", read: "allow" },
  primaryPermission: { "*": "deny", task: "allow", task_status: "allow", task_read: "allow" },
  cases: [{ name: "foreground", prompt }],
  files: { "fixtures/research.txt": `${evidence}\n` },
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
)

const foreground = artifact.cases[0]
if (!foreground) throw new Error("Missing foreground subagent observation")
const completed = foreground.tools.filter((tool) => tool.status === "completed")
if (
  completed.length !== 3 ||
  completed.some((tool, index) => tool.name !== ["task", "task_status", "task_read"][index])
) {
  throw new Error(
    `Foreground parent tool sequence mismatch: ${foreground.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}
if (record(completed[2]?.input, "task_read input").limit !== 100 || "before" in record(completed[2]?.input, "task_read input")) {
  throw new Error("Parent task_read did not request the complete transcript page")
}
if (foreground.children.length !== 1) {
  throw new Error(`Expected one child Session, received ${foreground.children.length}`)
}
const child = foreground.children[0]
if (!child || child.parentID !== foreground.sessionID || child.agent !== "researcher") {
  throw new Error("Foreground child lineage or agent identity is incorrect")
}
if (!completed[1]?.output?.includes(child.id) || !completed[1].output.includes("[completed]")) {
  throw new Error("Parent task_status result did not report the completed child")
}
const subagent = nestedRecord(child.metadata, ["deepagent", "subagent"])
if (subagent.state !== "completed" || subagent.finished !== true || subagent.reason !== "structured_output_valid") {
  throw new Error("Foreground child durable metadata is not a valid completed structured result")
}
if (
  child.model?.providerID !== "live-deepseek" ||
  child.model.id !== artifact.fingerprint.modelID ||
  child.assistants.some(
    (assistant) =>
      assistant.providerID !== "live-deepseek" || assistant.modelID !== artifact.fingerprint.modelID,
  )
) {
  throw new Error("Foreground child persisted the wrong provider/model identity")
}
const childTools = child.assistants.flatMap((assistant) => assistant.tools)
const read = childTools.find((tool) => tool.name === "read" && tool.status === "completed")
if (!read?.output?.includes(marker)) throw new Error("Child did not obtain the marker through a completed read tool")
const structured = child.assistants.find((assistant) => {
  const encoded = JSON.stringify(assistant.structured)
  return typeof encoded === "string" && encoded.includes(marker)
})?.structured
const result = record(structured, "ResearchResult")
if (
  typeof result.module !== "string" ||
  typeof result.mechanism !== "string" ||
  result.mechanism !== evidence ||
  !Array.isArray(result.keyFiles) ||
  !Array.isArray(result.interfaces) ||
  !Array.isArray(result.risks) ||
  !Array.isArray(result.openQuestions)
) {
  throw new Error("Child ResearchResult is missing required structured fields or marker evidence")
}
if (!completed[0]?.output?.includes(marker) || !completed[2]?.output?.includes(marker)) {
  throw new Error(
    `Parent tool results lost child evidence: task=${completed[0]?.output?.includes(marker) ?? false}, ` +
      `task_read=${completed[2]?.output?.includes(marker) ?? false}`,
  )
}
if (!foreground.finalText.includes(marker) || prompt.includes(marker)) {
  throw new Error(
    `Parent evidence mismatch: final=${foreground.finalText.includes(marker)}, prompt=${prompt.includes(marker)}`,
  )
}
const structuredParts = childTools.filter(
  (tool) => tool.name === "StructuredOutput" && tool.status === "completed",
)
if (structuredParts.length !== 1) {
  throw new Error(`Expected one completed child StructuredOutput part, received ${structuredParts.length}`)
}
if (!child.users.some((user) => nestedRecordOptional(user.metadata, ["deepagent", "structured_finalizer"]))) {
  throw new Error("Child transcript is missing the durable structured finalizer prompt")
}

const resultArtifact = {
  ...artifact,
  evidence: {
    markerHash: Bun.hash(marker).toString(16),
    parentToolCalls: completed.map((tool) => tool.name),
    childSessionIDLength: child.id.length,
    childMessageCount: child.messageCount,
    childAssistantTurns: child.assistants.length,
    structuredToolParts: structuredParts.length,
    rejectedParentToolCalls: foreground.tools.filter((tool) => tool.status === "error").map((tool) => tool.name),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  resultArtifact.suite,
  resultArtifact,
)
console.log(
  `${resultArtifact.suite}: passed (${resultArtifact.fingerprint.providerID}/${resultArtifact.fingerprint.modelID}, ` +
    `${foreground.usage.input + foreground.usage.output} parent tokens)`,
)

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

function nestedRecord(value: unknown, keys: string[]) {
  const result = nestedRecordOptional(value, keys)
  if (!result) throw new Error(`Missing object path ${keys.join(".")}`)
  return result
}

function nestedRecordOptional(value: unknown, keys: string[]) {
  return keys.reduce<Record<string, unknown> | undefined>((current, key) => {
    if (!current) return undefined
    const next = current[key]
    if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined
    return next as Record<string, unknown>
  }, typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)
}

finishLiveScript()
