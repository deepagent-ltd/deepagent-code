import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const prompt = [
  "Your first assistant response must contain exactly one task tool call and no text.",
  "Call task in foreground mode with subagent_type researcher and description verify explicit timeout recovery.",
  "The child prompt must be exactly: Call question immediately and exactly once to ask whether to continue, with one Continue option. Wait for the answer. Do not call any other tool and do not return before the answer.",
  "The test operator will deliberately leave the question unanswered.",
  "After task returns an attempt_timeout error, call task_read exactly once with the child session id from that error.",
  "After task_read returns, do not call any more tools. Report that automatic retry was disabled, no replacement child was created, and the interrupted transcript was recovered.",
].join(" ")

const artifact = await runLegacyLiveCases({
  suite: "subagent-takeover-legacy",
  permission: { "*": "deny", question: "allow" },
  primaryPermission: { "*": "deny", task: "allow", task_read: "allow" },
  questionAction: { type: "hold" },
  cases: [{ name: "explicit-timeout-recovery", prompt }],
  environment: {
    DEEPAGENT_ENABLED: "false",
    DEEPAGENT_CODE_SUBAGENT_TIMEOUT_MS: "15000",
  },
  modelMaxTokens: 512,
  maxProviderTurns: 8,
  timeoutMs: 120_000,
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  { ...artifact, status: "observed" },
)

const observation = artifact.cases[0]
if (!observation || observation.providerErrors.length > 0) {
  throw new Error(`Explicit timeout recovery provider turn failed: ${JSON.stringify(observation?.providerErrors)}`)
}
const task = observation.tools.find((tool) => tool.name === "task")
const transcript = observation.tools.find((tool) => tool.name === "task_read")
if (observation.tools.length !== 2 || task?.status !== "error" || transcript?.status !== "completed") {
  throw new Error(
    `Parent did not execute one failing task followed by task_read: ${observation.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}
if (
  !task.error?.includes("[attempt_timeout]") ||
  !task.error.includes("Automatic retry is disabled") ||
  !task.error.includes("task_read")
) {
  throw new Error(`Task did not surface the explicit timeout recovery contract: ${task.error}`)
}
if (observation.children.length !== 1) {
  throw new Error(`Expected one interrupted child without automatic replay, received ${observation.children.length}`)
}
if (observation.questionRequests.length !== 1 || observation.pendingQuestionIDs.length !== 0) {
  throw new Error(
    `Question lifecycle did not settle after timeout: ${JSON.stringify({
      requests: observation.questionRequests,
      pending: observation.pendingQuestionIDs,
    })}`,
  )
}

const child = observation.children[0]!
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
  throw new Error(`Interrupted child ${child.id} has invalid lineage or provider/model identity`)
}
const questions = child.assistants.flatMap((assistant) => assistant.tools).filter((tool) => tool.name === "question")
if (
  questions.length !== 1 ||
  questions[0]?.status !== "error" ||
  !questions[0].error?.includes("aborted") ||
  observation.questionRequests.filter((request) => request.sessionID === child.id).length !== 1
) {
  throw new Error(`Interrupted child ${child.id} did not reach exactly one held production question`)
}
const terminal = nestedRecord(child.metadata, ["deepagent", "subagent"])
if (
  terminal.state !== "interrupted" ||
  terminal.reason !== "attempt_timeout" ||
  terminal.finished !== true ||
  terminal.attempts !== 0
) {
  throw new Error(`Timed out child has invalid durable terminal state: ${JSON.stringify(terminal)}`)
}
if (!transcript.output?.includes(`id="${child.id}"`) || !transcript.output.includes('state="interrupted"')) {
  throw new Error("task_read did not recover the original interrupted child transcript")
}
if (observation.pendingPermissionIDs.length !== 0) {
  throw new Error(
    `Explicit timeout recovery leaked permission requests: ${observation.pendingPermissionIDs.join(", ")}`,
  )
}

const result = {
  ...artifact,
  status: "passed" as const,
  evidence: {
    childCount: observation.children.length,
    questionCount: observation.questionRequests.length,
    pendingQuestionCount: observation.pendingQuestionIDs.length,
    terminalState: `${String(terminal.state)}:${String(terminal.reason)}`,
    recoveredTranscript: true,
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
