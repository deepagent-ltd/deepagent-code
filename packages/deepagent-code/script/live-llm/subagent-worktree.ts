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
  files: { "fixtures/worktree.txt": `${marker}\n` },
  inspectFiles: ["fixtures/worktree.txt"],
  toolSandbox: {},
  awaitParentTools: ["task"],
  modelMaxTokens: 2048,
  maxProviderTurns: 12,
})

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
  child.model?.providerID !== "live-deepseek" ||
  child.model.id !== artifact.fingerprint.modelID ||
  child.assistants.some(
    (assistant) =>
      assistant.providerID !== "live-deepseek" || assistant.modelID !== artifact.fingerprint.modelID,
  )
) {
  throw new Error("Worktree routing child persisted the wrong provider/model identity")
}

const childTools = child.assistants.flatMap((assistant) => assistant.tools)
const completedChildTools = childTools.filter((tool) => tool.status === "completed").map((tool) => tool.name)
const expectedChildTools = ["bash", "glob", "grep", "read", "StructuredOutput"]
if (completedChildTools.join("\0") !== expectedChildTools.join("\0")) {
  throw new Error(`Child tool sequence was ${completedChildTools.join(" -> ")}`)
}
if (childTools.some((tool) => tool.status !== "completed")) {
  throw new Error(`Child has non-terminal or failed tools: ${childTools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`)
}
const bash = record(childTools[0]?.input, "bash input")
if (bash.command !== bashCommand) throw new Error(`Child bash command was ${JSON.stringify(bash.command)}`)

const task = observation.tools.find((tool) => tool.name === "task" && tool.status === "completed")
if (!task) throw new Error("Parent did not complete the foreground task")
if (observation.tools.length !== 1) {
  throw new Error(`Parent tool sequence was ${observation.tools.map((tool) => `${tool.name}:${tool.status}`).join(" -> ")}`)
}
const taskInput = record(task.input, "task input")
if (taskInput.isolation !== "worktree") throw new Error("Parent task did not request worktree isolation")
if (observation.tools.some((tool) => ["bash", "read", "grep", "glob"].includes(tool.name))) {
  throw new Error("Parent directly used a child-only filesystem or shell tool")
}

const subagent = nestedRecord(child.metadata, ["deepagent", "subagent"])
if (subagent.state !== "completed" || subagent.finished !== true || subagent.reason !== "structured_output_valid") {
  throw new Error(`Child durable metadata is not a completed structured result: ${JSON.stringify(subagent)}`)
}
const finalizer = child.assistants.find((assistant) => assistant.structured !== undefined)
const result = record(finalizer?.structured, "ResearchResult")
if (result.mechanism !== marker) throw new Error("Child structured result did not preserve the hidden marker")
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
    completedChildTools,
    permissionRequestCount: observation.permissionRequests.length,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${resultArtifact.suite}-observed`,
  resultArtifact,
  {
    redactions: [{ value: marker, replacement: `<hidden-marker hash=${Bun.hash(marker).toString(16)}>` }],
  },
)
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  resultArtifact.suite,
  resultArtifact,
  {
    redactions: [{ value: marker, replacement: `<hidden-marker hash=${Bun.hash(marker).toString(16)}>` }],
  },
)
console.log(
  `${resultArtifact.suite}: passed (${resultArtifact.fingerprint.providerID}/${resultArtifact.fingerprint.modelID}, ` +
    `${completedChildTools.join("/")}, ${observation.usage.input + observation.usage.output} tokens)`,
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
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined,
  )
  if (!result) throw new Error(`Missing object path ${keys.join(".")}`)
  return result
}

finishLiveScript()
