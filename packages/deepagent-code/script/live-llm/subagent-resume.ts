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

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing subagent resume observation")
if (observation.providerErrors.length > 0) {
  throw new Error(`Subagent resume provider turn failed: ${JSON.stringify(observation.providerErrors)}`)
}
const tasks = observation.tools.filter((tool) => tool.name === "task")
if (observation.tools.length !== 2 || tasks.length !== 2 || tasks.some((tool) => tool.status !== "completed")) {
  throw new Error(
    `Subagent resume parent sequence mismatch: ${observation.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}
if (observation.children.length !== 1) {
  throw new Error(`Task resume created ${observation.children.length} children instead of reusing one`)
}
const child = observation.children[0]
if (!child) throw new Error("Missing resumed child")
if (child.parentID !== observation.sessionID || child.agent !== "researcher") {
  throw new Error("Resumed child lineage or agent identity is incorrect")
}
if (
  child.model?.providerID !== "live-deepseek" ||
  child.model.id !== artifact.fingerprint.modelID ||
  child.assistants.some(
    (assistant) =>
      assistant.providerID !== "live-deepseek" ||
      assistant.modelID !== artifact.fingerprint.modelID ||
      assistant.error !== undefined,
  )
) {
  throw new Error("Resumed child persisted the wrong provider/model identity or a provider error")
}
const secondInput = record(tasks[1]?.input, "second task input")
if (secondInput.task_id !== child.id) throw new Error("Second task call did not reuse the persisted child Session id")
const childTools = child.assistants.flatMap((assistant) => assistant.tools)
if (
  childTools.filter((tool) => tool.name === "StructuredOutput" && tool.status === "completed").length !== 2 ||
  childTools.some((tool) => tool.status !== "completed" || !["read", "StructuredOutput"].includes(tool.name))
) {
  throw new Error(
    `Resumed child tool sequence mismatch: ${childTools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}
const readInputs = childTools
  .filter((tool) => tool.name === "read")
  .map((tool) => String(record(tool.input, "read input").filePath ?? record(tool.input, "read input").path ?? ""))
if (
  !childTools.some(
    (tool) =>
      tool.name === "read" &&
      String(
        record(tool.input, "first read input").filePath ?? record(tool.input, "first read input").path ?? "",
      ).endsWith("fixtures/resume-first.txt") &&
      tool.output?.includes(firstMarker),
  ) ||
  !childTools.some(
    (tool) =>
      tool.name === "read" &&
      String(
        record(tool.input, "second read input").filePath ?? record(tool.input, "second read input").path ?? "",
      ).endsWith("fixtures/resume-second.txt") &&
      tool.output?.includes(secondMarker),
  )
) {
  throw new Error(`Resumed child did not read both phase fixtures: ${readInputs.join(", ")}`)
}
const subagent = nestedRecord(child.metadata, ["deepagent", "subagent"])
if (
  subagent.state !== "completed" ||
  subagent.finished !== true ||
  subagent.reason !== "structured_output_valid" ||
  subagent.generation !== 2
) {
  throw new Error(`Resumed child durable generation is invalid: ${JSON.stringify(subagent)}`)
}
const childText = child.assistants
  .map((assistant) => `${assistant.text}\n${JSON.stringify(assistant.structured)}`)
  .join("\n")
if (!childText.includes(firstMarker) || !childText.includes(secondMarker)) {
  throw new Error("Resumed child transcript did not retain old evidence and add new evidence")
}
if (!tasks[1]?.output?.includes(firstMarker) || !tasks[1].output.includes(secondMarker)) {
  throw new Error("Second task result did not return both phases of child evidence")
}
if (!observation.finalText.includes(firstMarker) || !observation.finalText.includes(secondMarker)) {
  throw new Error("Parent final answer lost resumed child evidence")
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    firstMarkerHash: Bun.hash(firstMarker).toString(16),
    secondMarkerHash: Bun.hash(secondMarker).toString(16),
    childCount: observation.children.length,
    taskCalls: tasks.length,
    childGeneration: subagent.generation,
    childToolCalls: childTools.map((tool) => tool.name),
    childReadCalls: readInputs.length,
    childMessageCount: child.messageCount,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${observation.usage.input + observation.usage.output} parent tokens)`,
)

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

function nestedRecord(value: unknown, keys: string[]) {
  const result = keys.reduce<Record<string, unknown> | undefined>(
    (current, key) => {
      if (!current) return undefined
      const next = current[key]
      if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined
      return next as Record<string, unknown>
    },
    record(value, keys[0] ?? "value"),
  )
  if (!result) throw new Error(`Missing object path ${keys.join(".")}`)
  return result
}

finishLiveScript()
