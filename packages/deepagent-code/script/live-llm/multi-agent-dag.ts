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
const researchContent = `${researchMarker}\n`
const expectedContent = expectedOutput
const verifierSuccess = `dag-ok-${crypto.randomUUID()}`
const verifierFailure = `dag-error-${crypto.randomUUID()}`
const workerOutputSchema = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
}
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
  "Coordinate exactly three FOREGROUND task calls, sequentially, and do not use background mode.",
  "First call task with subagent_type researcher and output_schema ResearchResult.",
  "Its prompt must tell it to read fixtures/research.txt exactly once and return a valid ResearchResult whose mechanism is the exact file content.",
  "Second call task with subagent_type worker and the raw output_schema provided below; pass it as an object, not a string.",
  `Use this exact worker output_schema: ${JSON.stringify(workerOutputSchema)}.`,
  "In the worker prompt, include the exact mechanism returned by the researcher.",
  "Tell the worker to read fixtures/instruction.txt exactly once, write its exact content to output/result.txt, and return result set to the exact bytes it wrote.",
  "Tell the worker that read returns literal file text: a value beginning artifact- is the content to copy, not an artifact reference. Do not re-read it.",
  "After the worker returns, call pr_finalize exactly once with no pr_ids so its automatic PR is reviewed and merged.",
  "Wait for pr_finalize to finish before starting the third task.",
  "Third call task with subagent_type reviewer and output_schema ReviewResult.",
  "Tell the reviewer to read output/result.txt exactly once, verify it against the expected value stated in fixtures/review.txt, and return approve only when byte-exact; otherwise block with a finding.",
  "Do not read, write, edit, or run bash yourself. Do not call task_status or task_read.",
  "After all three foreground tasks return, report the researcher mechanism, worker result, and reviewer verdict exactly.",
].join(" ")

const artifact = await runLegacyLiveCases({
  suite: "multi-agent-dag-legacy",
  permission: { "*": "deny" },
  primaryPermission: { "*": "deny", task: "allow", pr_finalize: "allow" },
  agentPermissions: {
    researcher: {
      "*": "deny",
      read: { "*": "deny", "fixtures/research.txt": "allow" },
    },
    worker: {
      "*": "deny",
      read: { "*": "deny", "fixtures/instruction.txt": "allow" },
      edit: { "*": "deny", "output/result.txt": "allow" },
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
    "fixtures/research.txt": researchContent,
    "fixtures/instruction.txt": expectedContent,
    "fixtures/review.txt": expectedContent,
  },
  inspectFiles: ["fixtures/research.txt", "fixtures/instruction.txt", "fixtures/review.txt", "output/result.txt"],
  inspectPRCollaboration: true,
  inspectTaskRuns: true,
  toolSandbox: { verifierScript, initialVerifier: "fail" },
  evaluateWorkspace: async (directory, sandbox) => {
    if (!sandbox) throw new Error("Multi-Agent DAG verifier requires a qualified tool sandbox")
    const result = Bun.spawnSync([sandbox.shell, "-c", sandbox.verifier], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  },
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
if (observation.providerErrors.length > 0) {
  throw new Error(`Multi-Agent DAG provider failed: ${JSON.stringify(observation.providerErrors)}`)
}
const researcher = observation.children.find((child) => child.agent === "researcher")
const worker = observation.children.find((child) => child.agent === "worker")
const reviewers = observation.children.filter((child) => child.agent === "reviewer")
const prReviewer = reviewers.find((child) => child.v2Tools.length === 0)
const resultReviewer = reviewers.find((child) => child.v2Tools.some((tool) => tool.name === "read"))
if (!researcher || !worker || !prReviewer || !resultReviewer || observation.children.length !== 4) {
  throw new Error("DAG did not produce researcher, worker, PR reviewer, and result reviewer")
}
for (const child of observation.children) {
  if (
    child.parentID !== observation.sessionID || child.v2Assistants.length === 0 ||
    child.v2Assistants.some((assistant) => assistant.model.providerID !== artifact.fingerprint.runtimeProviderID ||
      assistant.model.id !== artifact.fingerprint.modelID) ||
    child.v2ProviderTurns.length === 0 ||
    child.v2ProviderTurns.some((turn) => turn.providerID !== artifact.fingerprint.runtimeProviderID ||
      turn.modelID !== artifact.fingerprint.modelID || turn.state !== "settled") ||
    child.structuredEvidence?.length !== 1 || child.structuredEvidence[0]?.validationOutcome !== "validated"
  ) {
    throw new Error(`DAG child ${child.id} lacks V2 lineage, model, or structured-output evidence`)
  }
}
const researchRead = researcher.v2Tools.filter((tool) => tool.name === "read" && tool.status === "completed")
if (researcher.v2Tools.length !== 1 || researchRead.length !== 1 || researchRead[0]?.output !== researchContent) {
  throw new Error("Researcher did not read the hidden mechanism exactly once")
}
const workerRead = worker.v2Tools.find((tool) => tool.name === "read" && tool.status === "completed")
const workerWrite = worker.v2Tools.find((tool) => tool.name === "write" && tool.status === "completed")
if (
  worker.v2Tools.length !== 2 || !workerRead || !workerWrite ||
  workerRead.output !== expectedContent ||
  typeof workerWrite.input !== "object" || workerWrite.input === null ||
  workerWrite.input.content !== expectedContent
) {
  throw new Error("Worker did not transfer the instruction bytes with one read and one write")
}
const resultReads = resultReviewer.v2Tools.filter((tool) => tool.name === "read" && tool.status === "completed")
if (
  resultReviewer.v2Tools.length !== 2 || resultReads.length !== 2 ||
  new Set(resultReads.map((tool) => typeof tool.input === "object" && tool.input !== null ? tool.input.path : undefined)).size !== 2 ||
  resultReads.some((tool) => tool.output !== expectedContent)
) {
  throw new Error("Result reviewer did not independently read the output and expected fixture")
}
if (prReviewer.v2Tools.length > 0) throw new Error("PR reviewer called a tool")
const taskTools = observation.tools.filter((tool) => tool.name === "task" && tool.status === "completed")
const finalizeTools = observation.tools.filter((tool) => tool.name === "pr_finalize" && tool.status === "completed")
if (
  taskTools.length !== 3 || finalizeTools.length !== 1 || observation.tools.length !== 4 ||
  observation.tools[0]?.name !== "task" || observation.tools[1]?.name !== "task" ||
  observation.tools[2]?.name !== "pr_finalize" || observation.tools[3]?.name !== "task"
) {
  throw new Error("Parent did not execute researcher, worker, PR finalize, and result reviewer in order")
}
const finalized: unknown = JSON.parse(finalizeTools[0]!.output ?? "null")
if (!Array.isArray(finalized) || finalized.length !== 1 || finalized[0]?.status !== "merged") {
  throw new Error(`DAG worker PR was not merged: ${JSON.stringify(finalized)}`)
}
const runs = observation.taskRuns ?? []
if (
  runs.length !== 4 || runs.some((run) => run.executionRuntime !== "v2" || run.state !== "completed" ||
    run.parentSessionID !== observation.sessionID ||
    !observation.children.some((child) => child.id === run.childSessionID))
) {
  throw new Error(`DAG V2 task runs did not settle: ${JSON.stringify(runs)}`)
}
if (observation.permissionRequests.length > 0) {
  throw new Error("DAG unexpectedly required permission interaction")
}
if (artifact.workspace.files["output/result.txt"] !== expectedContent || artifact.workspace.status.trim() !== "") {
  throw new Error("DAG PR did not produce a clean, exact parent output")
}
const verifier = artifact.evaluation as { exitCode?: number; stdout?: string } | undefined
if (!verifier || verifier.exitCode !== 0 || !verifier.stdout?.includes(verifierSuccess)) {
  throw new Error(`DAG hidden verifier failed: ${JSON.stringify(verifier)}`)
}
if (
  !observation.finalText.includes(researchMarker) ||
  !observation.finalText.includes(expectedOutput) ||
  !observation.finalText.toLowerCase().includes("approve")
) {
  throw new Error("Parent did not aggregate researcher, worker, and reviewer results")
}
const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    childSessionIDs: observation.children.map((child) => child.id),
    prID: finalized[0].prID,
    hiddenVerifierExit: verifier.exitCode,
    resultHash: Bun.hash(expectedContent).toString(16),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(`${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, 4 V2 children)`)

finishLiveScript()
