import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const prompt = [
  "Your first assistant response must contain exactly one task tool call and no text.",
  "Call task in foreground mode with subagent_type researcher and description verify bounded takeover.",
  "The child prompt must be exactly: Call question immediately and exactly once to ask whether to continue, with one Continue option. Wait for the answer. Do not call any other tool and do not return before the answer.",
  "The test operator will deliberately leave the question unanswered.",
  "After the task reports that bounded takeover was exhausted, do not call any more tools. Report that the child timed out and takeover stopped at its configured limit.",
].join(" ")

const artifact = await runLegacyLiveCases({
  suite: "subagent-takeover-legacy",
  permission: { "*": "deny", question: "allow" },
  primaryPermission: { "*": "deny", task: "allow" },
  questionAction: { type: "hold" },
  cases: [{ name: "bounded-takeover", prompt }],
  environment: {
    DEEPAGENT_ENABLED: "false",
    DEEPAGENT_CODE_SUBAGENT_TIMEOUT_MS: "15000",
    DEEPAGENT_CODE_SUBAGENT_TAKEOVER_LIMIT: "1",
  },
  modelMaxTokens: 512,
  maxProviderTurns: 6,
  timeoutMs: 120_000,
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
)

const observation = artifact.cases[0]
if (!observation || observation.providerErrors.length > 0) {
  throw new Error(`Bounded takeover provider turn failed: ${JSON.stringify(observation?.providerErrors)}`)
}
if (
  observation.tools.length !== 1 ||
  observation.tools[0]?.name !== "task" ||
  observation.tools[0].status !== "error"
) {
  throw new Error(
    `Parent did not execute exactly one failing task: ${observation.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}
if (
  !observation.tools[0].error?.includes("bounded takeover") ||
  !observation.tools[0].error.includes("[timeout]") ||
  !observation.tools[0].error.includes("task_read")
) {
  throw new Error(`Task did not surface the bounded timeout recovery contract: ${observation.tools[0].error}`)
}
if (observation.children.length !== 2) {
  throw new Error(`Expected the original child and one takeover child, received ${observation.children.length}`)
}
if (observation.questionRequests.length !== 2 || observation.pendingQuestionIDs.length !== 0) {
  throw new Error(
    `Question lifecycle did not settle after takeover: ${JSON.stringify({
      requests: observation.questionRequests,
      pending: observation.pendingQuestionIDs,
    })}`,
  )
}

const terminal = observation.children.map((child) => {
  if (
    child.parentID !== observation.sessionID ||
    child.agent !== "researcher" ||
    child.model?.providerID !== "live-deepseek" ||
    child.model.id !== artifact.fingerprint.modelID ||
    child.assistants.length === 0 ||
    child.assistants.some(
      (assistant) =>
        assistant.providerID !== "live-deepseek" ||
        assistant.modelID !== artifact.fingerprint.modelID ||
        record(assistant.error, "expected timeout assistant error").name !== "MessageAbortedError",
    )
  ) {
    throw new Error(`Takeover child ${child.id} has invalid lineage or provider/model identity`)
  }
  const questions = child.assistants.flatMap((assistant) => assistant.tools).filter((tool) => tool.name === "question")
  if (
    questions.length !== 1 ||
    questions[0]?.status !== "error" ||
    !questions[0].error?.includes("aborted") ||
    observation.questionRequests.filter((request) => request.sessionID === child.id).length !== 1
  ) {
    throw new Error(`Takeover child ${child.id} did not reach exactly one held production question`)
  }
  return nestedRecord(child.metadata, ["deepagent", "subagent"])
})

if (
  terminal[0]?.state !== "cancelled" ||
  terminal[0].reason !== "takeover" ||
  terminal[0].finished !== true ||
  terminal[1]?.state !== "error" ||
  terminal[1].reason !== "timeout" ||
  terminal[1].finished !== true
) {
  throw new Error(`Takeover attempts have invalid durable terminal states: ${JSON.stringify(terminal)}`)
}
if (
  !observation.finalText.toLowerCase().includes("timeout") &&
  !observation.finalText.toLowerCase().includes("timed out") &&
  !observation.finalText.includes("超时")
) {
  throw new Error("Parent did not report the bounded timeout outcome")
}
if (observation.pendingPermissionIDs.length !== 0) {
  throw new Error(`Bounded takeover leaked permission requests: ${observation.pendingPermissionIDs.join(", ")}`)
}

const result = {
  ...artifact,
  status: "passed" as const,
  evidence: {
    childCount: observation.children.length,
    questionCount: observation.questionRequests.length,
    pendingQuestionCount: observation.pendingQuestionIDs.length,
    terminalStates: terminal.map((item) => `${String(item.state)}:${String(item.reason)}`),
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
  const result = keys.reduce<Record<string, unknown> | undefined>(
    (current, key) => {
      if (!current) return undefined
      const next = current[key]
      if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined
      return next as Record<string, unknown>
    },
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined,
  )
  if (!result) throw new Error(`Missing object path ${keys.join(".")}`)
  return result
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

finishLiveScript()
