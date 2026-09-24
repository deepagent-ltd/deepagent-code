import { createHash } from "node:crypto"
import path from "node:path"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const marker = `worktree-marker-${crypto.randomUUID()}`
const bashCommand = "pwd && git status --short --branch"
const prompt = [
  "Call task exactly once in foreground mode with subagent_type researcher, isolation worktree, and output_schema ResearchResult.",
  "The child must not call task and must perform this exact sequence:",
  `1. Call bash exactly once with ${JSON.stringify(bashCommand)} and treat the first output line as ROOT.`,
  "2. Call glob exactly once with pattern fixtures/*.txt and path ROOT.",
  "3. Call grep exactly once with pattern worktree-marker- and path ROOT/fixtures/worktree.txt.",
  "4. Call read exactly once with filePath ROOT/fixtures/worktree.txt.",
  "5. Return a valid ResearchResult whose mechanism is the exact file content, whose module is worktree-routing, and whose keyFiles contains fixtures/worktree.txt.",
  "After the foreground task returns, report the exact mechanism from the child result. Do not call bash, read, grep, or glob yourself.",
].join(" ")

const artifact = await runLegacyLiveCases({
  suite: "subagent-worktree-routing-legacy",
  permission: { "*": "deny" },
  primaryPermission: { "*": "deny", task: "allow" },
  agentPermissions: {
    researcher: {
      "*": "deny",
      bash: { "*": "deny", pwd: "allow", "git status --short --branch": "allow" },
      read: { "*": "deny", "fixtures/worktree.txt": "allow" },
      grep: { "*": "deny", "worktree-marker-": "allow" },
      glob: { "*": "deny", "fixtures/*.txt": "allow" },
    },
  },
  cases: [{ name: "worktree-instance-routing", prompt }],
  // The prompt asks for the exact file content, so keep the fixture byte-equal to the oracle.
  files: { "fixtures/worktree.txt": marker },
  inspectFiles: ["fixtures/worktree.txt"],
  toolSandbox: {},
  awaitParentTools: ["task"],
  inspectTaskRuns: true,
  modelMaxTokens: 2048,
  maxProviderTurns: 12,
})
const artifactDirectory = path.resolve(import.meta.dir, "../../.artifacts/live-llm")
const redactions = [{ value: marker, replacement: `<hidden-marker hash=${Bun.hash(marker).toString(16)}>` }]
// Preserve redacted durable observations even when a later strict assertion fails.
await writeLiveArtifact({ artifactDirectory }, `${artifact.suite}-observed`, artifact, { redactions })

if (prompt.includes(marker)) throw new Error("Worktree routing marker leaked into the parent prompt")
if (!artifact.sandbox?.hostReadDenied || !artifact.sandbox.systemHostReadDenied || !artifact.sandbox.networkDenied) {
  throw new Error("Worktree routing suite did not run with a qualified sandbox")
}

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing worktree routing observation")
if (observation.children.length !== 1) {
  throw new Error(`Expected one researcher child, received ${observation.children.length}`)
}
const child = observation.children[0]
if (!child || child.parentID !== observation.sessionID || child.agent !== "researcher") {
  throw new Error("Worktree routing child lineage or agent identity is incorrect")
}

const parentDirectory = FSUtil.resolve(artifact.workspace.directory)
const childDirectory = FSUtil.resolve(child.directory)
if (childDirectory === parentDirectory) throw new Error("Child did not receive a distinct worktree")
if (child.directory !== childDirectory) throw new Error("Child persisted a non-canonical worktree directory")
if (
  child.assistants.some(
    (assistant) =>
      FSUtil.resolve(assistant.path.cwd) !== childDirectory || FSUtil.resolve(assistant.path.root) !== childDirectory,
  )
) {
  throw new Error("Child assistant messages were created outside the persisted worktree Instance")
}

if (
  (child.model &&
    (child.model.providerID !== artifact.fingerprint.runtimeProviderID ||
      child.model.id !== artifact.fingerprint.modelID)) ||
  child.v2Assistants.length === 0 ||
  child.v2Assistants.some(
    (assistant) =>
      assistant.model.providerID !== artifact.fingerprint.runtimeProviderID ||
      assistant.model.id !== artifact.fingerprint.modelID,
  ) ||
  child.v2ProviderTurns.length === 0 ||
  child.v2ProviderTurns.some(
    (turn) =>
      turn.providerID !== artifact.fingerprint.runtimeProviderID ||
      turn.modelID !== artifact.fingerprint.modelID ||
      turn.state !== "settled",
  ) ||
  child.assistants.some(
    (assistant) =>
      assistant.providerID !== artifact.fingerprint.runtimeProviderID || assistant.modelID !== artifact.fingerprint.modelID,
  )
) {
  throw new Error("Worktree routing child persisted the wrong provider/model identity")
}

const childTools = child.assistants.flatMap((assistant) => assistant.tools)
const completedChildTools = childTools.filter((tool) => tool.status === "completed").map((tool) => tool.name)
// The V2 child researches with the allowed tool set; structured finalization is sealed
// in V2StructuredOutputEvidence, not represented as a StructuredOutput tool call.
const allowedChildTools = new Set(["bash", "glob", "grep", "read"])
if (
  completedChildTools.length === 0 ||
  completedChildTools.some((name) => !allowedChildTools.has(name)) ||
  completedChildTools.filter((name) => name === "bash").length < 1 ||
  completedChildTools.filter((name) => name === "read" || name === "grep" || name === "glob").length < 1 ||
  JSON.stringify(child.v2Tools.map((tool) => ({ name: tool.name, status: tool.status }))) !==
    JSON.stringify(childTools.map((tool) => ({ name: tool.name, status: tool.status })))
) {
  throw new Error(`Child tool sequence was ${completedChildTools.join(" -> ")}`)
}
if (childTools.some((tool) => tool.status !== "completed")) {
  throw new Error(`Child has non-terminal or failed tools: ${childTools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`)
}
const bashTool = childTools.find((tool) => tool.name === "bash")
const bash = record(bashTool?.input, "bash input")
if (bash.command !== bashCommand) throw new Error(`Child bash command was ${JSON.stringify(bash.command)}`)

const task = observation.tools.find((tool) => tool.name === "task" && tool.status === "completed")
if (!task) throw new Error("Parent did not complete the foreground task")
if (observation.tools.length !== 1) {
  throw new Error(`Parent tool sequence was ${observation.tools.map((tool) => `${tool.name}:${tool.status}`).join(" -> ")}`)
}
const taskInput = record(task.input, "task input")
if (taskInput.subagent_type !== "researcher" || taskInput.background === true) {
  throw new Error("Parent task did not request the foreground ResearchResult researcher")
}
if (observation.tools.some((tool) => ["bash", "read", "grep", "glob"].includes(tool.name))) {
  throw new Error("Parent directly used a child-only filesystem or shell tool")
}

const taskRun = observation.taskRuns?.[0]
if (
  observation.taskRuns?.length !== 1 ||
  taskRun?.parentSessionID !== observation.sessionID ||
  taskRun.childSessionID !== child.id ||
  taskRun.executionRuntime !== "v2" ||
  taskRun.state !== "completed" ||
  taskRun.workspaceMode !== "worktree"
) {
  throw new Error(`Child durable task run did not complete in a worktree: ${JSON.stringify(observation.taskRuns)}`)
}
const evidence = child.structuredEvidence?.[0]
if (
  child.structuredEvidence?.length !== 1 ||
  evidence?.runID !== taskRun.runID ||
  evidence.childSessionID !== child.id ||
  evidence.validationOutcome !== "validated" ||
  !["ResearchResult", "default:researcher"].includes(evidence.schemaName) ||
  !/^[0-9a-f]{64}$/.test(evidence.schemaSha256) ||
  evidence.outputSha256 !== createHash("sha256").update(evidence.rawOutput).digest("hex") ||
  !evidence.outputMessageID ||
  evidence.outputMessageID !== child.v2Assistants.at(-1)?.id
) {
  throw new Error("Child structured output lacks one validated, message-bound V2 evidence row")
}
const result = record(JSON.parse(evidence.rawOutput), "ResearchResult")
if (result.mechanism !== marker) throw new Error("Child structured result did not preserve the hidden marker")
if (
  result.module !== "worktree-routing" ||
  !Array.isArray(result.keyFiles) ||
  !result.keyFiles.includes("fixtures/worktree.txt")
) {
  throw new Error("Child structured result did not preserve the module and key file")
}
if (typeof task.output !== "string" || !task.output.includes(marker)) {
  throw new Error("Foreground task output did not carry the child marker")
}
if (!observation.finalText.includes(marker)) throw new Error("Parent final text did not carry the child marker")
if (observation.permissionRequests.length > 0) {
  throw new Error(
    `Unexpected permission requests: ${observation.permissionRequests.map((request) => `${request.permission}@${request.sessionID}`).join(", ")}`,
  )
}

const resultArtifact = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    markerHash: Bun.hash(marker).toString(16),
    parentDirectory,
    childDirectory,
    childAssistantPaths: child.assistants.map((assistant) => assistant.path),
    v2ProviderTurnCount: child.v2ProviderTurns.length,
    taskRunID: taskRun.runID,
    structuredEvidenceMessageID: evidence.outputMessageID,
    completedChildTools,
    permissionRequestCount: observation.permissionRequests.length,
  },
}
await writeLiveArtifact(
  { artifactDirectory },
  `${resultArtifact.suite}-observed`,
  resultArtifact,
  { redactions },
)
await writeLiveArtifact(
  { artifactDirectory },
  resultArtifact.suite,
  resultArtifact,
  { redactions },
)
console.log(
  `${resultArtifact.suite}: passed (${resultArtifact.fingerprint.providerID}/${resultArtifact.fingerprint.modelID}, ` +
    `${completedChildTools.join("/")}, ${observation.usage.input + observation.usage.output} tokens)`,
)

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

finishLiveScript()
