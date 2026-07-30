import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// Suite: multi-agent-dag-legacy
// Exercises a real parent -> researcher -> worker -> reviewer orchestration on the legacy production
// task path. The parent never receives fixture-read permission, so every hidden input must travel
// through a completed child result. The worker performs the only mutation; the reviewer independently
// checks the resulting bytes; the parent must aggregate all three durable child results.
const researchMarker = `research-${crypto.randomUUID()}`
const expectedOutput = `artifact-${crypto.randomUUID()}`
const verifierSuccess = `dag-ok-${crypto.randomUUID()}`
const verifierFailure = `dag-error-${crypto.randomUUID()}`
const verifierScript = `#!/bin/sh
set -eu
if [ "$(cat output/result.txt 2>/dev/null || true)" = "${expectedOutput}" ]; then
  printf '%s\n' '${verifierSuccess}'
  exit 0
fi
printf '%s\n' '${verifierFailure}' >&2
exit 31
`

const prompt = [
  "Coordinate exactly three FOREGROUND child tasks, sequentially, and do not use background mode.",
  "First call task with subagent_type researcher and output_schema ResearchResult.",
  "Its prompt must tell it to read fixtures/research.txt exactly once and return a valid ResearchResult whose mechanism is the exact file content.",
  "Second call task with subagent_type worker and a raw output_schema requiring an object with one required string property named result.",
  "In the worker prompt, include the exact mechanism returned by the researcher.",
  "Tell the worker to read fixtures/instruction.txt exactly once, write its exact content to output/result.txt, and return result set to the exact bytes it wrote.",
  "Third call task with subagent_type reviewer and output_schema ReviewResult.",
  "Tell the reviewer to read output/result.txt exactly once, verify it against the expected value stated in fixtures/review.txt, and return approve only when byte-exact; otherwise block with a finding.",
  "Do not read, write, edit, or run bash yourself. Do not call task_status or task_read.",
  "After all three foreground tasks return, report the researcher mechanism, worker result, and reviewer verdict exactly.",
].join(" ")

const artifact = await runLegacyLiveCases({
  suite: "multi-agent-dag-legacy",
  permission: { "*": "deny" },
  primaryPermission: { "*": "deny", task: "allow" },
  agentPermissions: {
    researcher: {
      "*": "deny",
      read: { "*": "deny", "fixtures/research.txt": "allow" },
    },
    worker: {
      "*": "deny",
      read: { "*": "deny", "fixtures/instruction.txt": "allow" },
      write: { "*": "deny", "output/result.txt": "allow" },
    },
    reviewer: {
      "*": "deny",
      read: {
        "*": "deny",
        "output/result.txt": "allow",
        "fixtures/review.txt": "allow",
      },
    },
  },
  cases: [{ name: "dag", prompt }],
  files: {
    "fixtures/research.txt": researchMarker,
    "fixtures/instruction.txt": expectedOutput,
    "fixtures/review.txt": expectedOutput,
  },
  inspectFiles: [
    "fixtures/research.txt",
    "fixtures/instruction.txt",
    "fixtures/review.txt",
    "output/result.txt",
  ],
  toolSandbox: { verifierScript, initialVerifier: "fail" },
  modelMaxTokens: 2048,
  maxProviderTurns: 14,
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
)

if ([researchMarker, expectedOutput, verifierSuccess, verifierFailure].some((marker) => prompt.includes(marker))) {
  throw new Error("Multi-Agent DAG hidden marker leaked into the parent prompt")
}
if (!artifact.sandbox?.networkDenied || !artifact.sandbox.verifierWriteDenied) {
  throw new Error("Multi-Agent DAG requires a qualified sandbox with a write-protected verifier")
}

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing Multi-Agent DAG observation")
const children = observation.children
if (children.length !== 3) {
  throw new Error(`Expected exactly three child sessions, received ${children.length}`)
}
const researcher = requireChild("researcher")
const worker = requireChild("worker")
const reviewer = requireChild("reviewer")

for (const child of children) {
  if (child.parentID !== observation.sessionID) {
    throw new Error(`Child ${child.id} has incorrect parent lineage`)
  }
  if (
    child.model?.providerID !== "live-deepseek" ||
    child.model.id !== artifact.fingerprint.modelID ||
    child.assistants.some(
      (assistant) =>
        assistant.providerID !== "live-deepseek" || assistant.modelID !== artifact.fingerprint.modelID,
    )
  ) {
    throw new Error(`Child ${child.id} persisted the wrong provider/model identity`)
  }
  const subagent = nestedRecord(child.metadata, ["deepagent", "subagent"])
  if (subagent.state !== "completed" || subagent.finished !== true || subagent.reason !== "structured_output_valid") {
    throw new Error(`Child ${child.id} did not persist a completed structured result`)
  }
  const structuredCalls = child.assistants
    .flatMap((assistant) => assistant.tools)
    .filter((tool) => tool.name === "StructuredOutput" && tool.status === "completed")
  if (structuredCalls.length !== 1) {
    throw new Error(`Child ${child.id} expected one completed StructuredOutput call, got ${structuredCalls.length}`)
  }
}

const researchResult = structuredResult(researcher, "ResearchResult")
if (researchResult.mechanism !== researchMarker) {
  throw new Error(`Researcher returned wrong hidden marker: ${JSON.stringify(researchResult.mechanism)}`)
}
const researcherReads = completedTools(researcher, "read")
if (researcherReads.length !== 1) {
  throw new Error(`Researcher expected one completed read, got ${researcherReads.length}`)
}

const workerResult = structuredResult(worker, "WorkerResult")
if (workerResult.result !== expectedOutput) {
  throw new Error(`Worker structured result is not byte-exact: ${JSON.stringify(workerResult.result)}`)
}
if (completedTools(worker, "read").length !== 1 || completedTools(worker, "write").length !== 1) {
  throw new Error("Worker did not complete exactly one read and one write")
}

const reviewResult = structuredResult(reviewer, "ReviewResult")
if (reviewResult.verdict !== "approve" || reviewResult.requires_human !== false) {
  throw new Error(`Reviewer did not independently approve exact output: ${JSON.stringify(reviewResult)}`)
}
if (completedTools(reviewer, "read").length !== 2) {
  throw new Error("Reviewer did not complete exactly two reads")
}

const taskTools = observation.tools.filter((tool) => tool.name === "task" && tool.status === "completed")
if (taskTools.length !== 3) {
  throw new Error(`Parent expected three completed task calls, got ${taskTools.length}`)
}
const forbiddenParentTools = observation.tools.filter(
  (tool) => tool.status === "completed" && tool.name !== "task",
)
if (forbiddenParentTools.length > 0) {
  throw new Error(`Parent executed forbidden tools: ${forbiddenParentTools.map((tool) => tool.name).join(", ")}`)
}
if (observation.permissionRequests.length > 0) {
  throw new Error(
    `Unexpected permission requests: ${observation.permissionRequests.map((request) => `${request.permission}@${request.sessionID}`).join(", ")}`,
  )
}

const output = artifact.workspace.files["output/result.txt"]
if (output !== expectedOutput) {
  throw new Error(`Final artifact bytes mismatch: ${JSON.stringify(output)}`)
}
const verifier = Bun.spawnSync(["./verify"], {
  cwd: artifact.workspace.directory,
  stdout: "pipe",
  stderr: "pipe",
})
const verifierStdout = verifier.stdout.toString()
if (verifier.exitCode !== 0 || !verifierStdout.includes(verifierSuccess)) {
  throw new Error(
    `Hidden verifier did not pass after DAG completion: exit=${verifier.exitCode}, stdout=${JSON.stringify(verifierStdout)}`,
  )
}

const changedPaths = artifact.workspace.status
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => line.slice(3).trim())
if (changedPaths.length !== 1 || changedPaths[0] !== "output/result.txt") {
  throw new Error(`Unexpected workspace mutations: ${JSON.stringify(changedPaths)}`)
}
for (const marker of [researchMarker, expectedOutput]) {
  if (!observation.finalText.includes(marker)) {
    throw new Error("Parent did not aggregate all hidden child results")
  }
}
if (!observation.finalText.toLowerCase().includes("approve")) {
  throw new Error("Parent did not aggregate the reviewer verdict")
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    childIDs: children.map((child) => child.id),
    childAgents: children.map((child) => child.agent),
    researchMarkerHash: Bun.hash(researchMarker).toString(16),
    expectedOutputHash: Bun.hash(expectedOutput).toString(16),
    taskCallCount: taskTools.length,
    changedPaths,
    hiddenVerifierExit: verifier.exitCode,
    hiddenVerifierPassed: verifierStdout.includes(verifierSuccess),
    parentAggregatedResearch: observation.finalText.includes(researchMarker),
    parentAggregatedWorker: observation.finalText.includes(expectedOutput),
    parentAggregatedReview: observation.finalText.toLowerCase().includes("approve"),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${children.length} children, ${observation.usage.input + observation.usage.output} parent tokens)`,
)

function requireChild(agent: string) {
  const matches = children.filter((child) => child.agent === agent)
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`Expected exactly one ${agent} child, received ${matches.length}`)
  }
  return matches[0]
}

function completedTools(child: (typeof children)[number], name: string) {
  return child.assistants
    .flatMap((assistant) => assistant.tools)
    .filter((tool) => tool.name === name && tool.status === "completed")
}

function structuredResult(child: (typeof children)[number], name: string) {
  const finalizers = child.assistants.filter((assistant) => assistant.structured !== undefined)
  if (finalizers.length !== 1 || !finalizers[0]) {
    throw new Error(`${name} child expected exactly one structured finalizer turn`)
  }
  return record(finalizers[0].structured, name)
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not an object`)
  }
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
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined,
  )
  if (!result) throw new Error(`Missing object path ${keys.join(".")}`)
  return result
}

finishLiveScript()
