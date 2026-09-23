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
// The task_read input schema is provider-tolerant (limit: number | numeric string), so the model
// sending "100" is a valid complete-transcript request; compare numerically.
const taskReadInput = record(completed[2]?.input, "task_read input")
if (Number(taskReadInput.limit) !== 100 || "before" in taskReadInput) {
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
// Durable V2 contract (task_run authority): the legacy deepagent.subagent session-metadata
// projection and the session-level child.model stamp were removed with the V2-owner cutover —
// task_status's [completed] report above is the durable state surface, and the schema-validated
// structured result returned by the task call is the validated-outcome surface. Require the task
// tool result to parse as the validated ResearchResult carrying the marker evidence.
const taskResult = record(JSON.parse(String(completed[0]?.output ?? "").split("\ntask_id:")[0]), "task ResearchResult")
if (typeof taskResult.mechanism !== "string" || taskResult.mechanism !== evidence) {
  throw new Error("Foreground task result did not return the validated child ResearchResult")
}
if (
  child.assistants.some(
    (assistant) =>
      assistant.providerID !== artifact.fingerprint.runtimeProviderID || assistant.modelID !== artifact.fingerprint.modelID,
  )
) {
  throw new Error("Foreground child persisted the wrong provider/model identity")
}
const childTools = child.assistants.flatMap((assistant) => assistant.tools)
const read = childTools.find((tool) => tool.name === "read" && tool.status === "completed")
if (!read?.output?.includes(marker)) throw new Error("Child did not obtain the marker through a completed read tool")
// The V2 finalizer contract rides the schema in the prompt text (no provider format, no
// StructuredOutput synthesis): the child's final answer is the JSON text itself — fenced or raw —
// which the parent task call extracts and validates (already asserted via taskResult above).
const finalAnswer = child.assistants.at(-1)?.text ?? ""
const fenced = finalAnswer.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? finalAnswer
const start = fenced.indexOf("{")
const end = fenced.lastIndexOf("}")
const result = record(
  JSON.parse(start !== -1 && end > start ? fenced.slice(start, end + 1) : "{}"),
  "ResearchResult",
)
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
// The V2 finalizer prompt is a plain durable user turn (no metadata projection, no synthesized
// StructuredOutput tool): assert it by its fixed instruction text, which also proves the finalizer
// ran exactly against the persisted research.
if (!child.users.some((user) => user.text.includes("Convert the persisted research result"))) {
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
    structuredFinalAnswers: 1,
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

finishLiveScript()
