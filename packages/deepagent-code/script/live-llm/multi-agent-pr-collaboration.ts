import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const leftMarker = `pr-left-${crypto.randomUUID()}`
const rightMarker = `pr-right-${crypto.randomUUID()}`
const verifierSuccess = `pr-collaboration-ok-${crypto.randomUUID()}`
const outputSchema = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
}
const verifierScript = `#!/bin/sh
set -eu
test "$(cat output/left.txt 2>/dev/null || true)" = "${leftMarker}"
test "$(cat output/right.txt 2>/dev/null || true)" = "${rightMarker}"
printf '%s\n' '${verifierSuccess}'
`
const prompt = [
  "Your FIRST assistant response must contain exactly two task tool calls and no text.",
  "Emit both task calls together in that response as parallel FOREGROUND calls; do not wait for one before emitting the other.",
  "Both calls must use subagent_type worker, background false, omit isolation entirely, and use the exact raw output_schema below.",
  `Use this exact output_schema for both calls: ${JSON.stringify(outputSchema)}.`,
  "LEFT description: implement left PR fixture.",
  "LEFT prompt: Read only fixtures/left.txt exactly once. Then use write exactly once to write those exact bytes to output/left.txt. Do not use bash or edit. Return result set to the exact bytes written, including the trailing newline, without Markdown or backticks.",
  "RIGHT description: implement right PR fixture.",
  "RIGHT prompt: Read only fixtures/right.txt exactly once. Then use write exactly once to write those exact bytes to output/right.txt. Do not use bash or edit. Return result set to the exact bytes written, including the trailing newline, without Markdown or backticks.",
  "After both task results return, your NEXT assistant response must contain exactly one pr_finalize tool call and no text. Omit pr_ids so the complete batch is finalized.",
  "Do not call read, write, edit, bash, task_status, or task_read in the parent.",
  "After pr_finalize returns, report that the two PRs and stage review completed.",
].join(" ")

const artifact = await runLegacyLiveCases({
  suite: "multi-agent-pr-collaboration-legacy",
  permission: { "*": "deny" },
  primaryPermission: { "*": "deny", task: "allow", pr_finalize: "allow" },
  agentPermissions: {
    worker: {
      "*": "deny",
      read: {
        "*": "deny",
        "fixtures/left.txt": "ask",
        "fixtures/right.txt": "ask",
      },
      edit: {
        "*": "deny",
        "output/left.txt": "allow",
        "output/right.txt": "allow",
      },
    },
  },
  cases: [{ name: "parallel-pr-batch", prompt }],
  files: {
    "fixtures/left.txt": `${leftMarker}\n`,
    "fixtures/right.txt": `${rightMarker}\n`,
  },
  inspectFiles: ["output/left.txt", "output/right.txt"],
  inspectChildFiles: ["output/left.txt", "output/right.txt"],
  inspectPRCollaboration: true,
  inspectTaskRuns: true,
  toolSandbox: { verifierScript, initialVerifier: "fail" },
  evaluateWorkspace: async (directory, sandbox) => {
    if (!sandbox) throw new Error("PR collaboration verifier requires a qualified tool sandbox")
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
  permissionReply: { reply: "once" },
  permissionBarrierCount: 2,
  modelMaxTokens: 2048,
  maxProviderTurns: 12,
  timeoutMs: 300_000,
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  { ...artifact, status: "observed" },
)

if ([leftMarker, rightMarker, verifierSuccess].some((marker) => prompt.includes(marker))) {
  throw new Error("PR collaboration hidden marker leaked into the parent prompt")
}
if (!artifact.sandbox?.networkDenied || !artifact.sandbox.verifierWriteDenied) {
  throw new Error("PR collaboration suite requires the qualified tool sandbox")
}

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing PR collaboration observation")
if (observation.providerErrors.length > 0) {
  throw new Error(`PR collaboration provider turn failed: ${JSON.stringify(observation.providerErrors)}`)
}
const workers = observation.children.filter((child) => child.agent === "worker")
const reviewers = observation.children.filter((child) => child.agent === "reviewer")
if (workers.length !== 2 || reviewers.length !== 2) {
  throw new Error(`Expected two V2 workers and one reviewer per PR: ${workers.length}/${reviewers.length}`)
}
if (new Set(workers.map((child) => child.directory)).size !== 2) {
  throw new Error("Parallel PR workers did not receive distinct worktrees")
}
if (workers.some((child) => child.directoryExists || child.status !== "<removed>")) {
  throw new Error("Merged worker worktrees were not removed")
}
for (const child of observation.children) {
  if (
    child.parentID !== observation.sessionID ||
    child.v2Assistants.length === 0 ||
    child.v2Assistants.some(
      (assistant) => assistant.model.providerID !== artifact.fingerprint.runtimeProviderID ||
        assistant.model.id !== artifact.fingerprint.modelID,
    ) ||
    child.v2ProviderTurns.length === 0 ||
    child.v2ProviderTurns.some(
      (turn) => turn.providerID !== artifact.fingerprint.runtimeProviderID ||
        turn.modelID !== artifact.fingerprint.modelID || turn.state !== "settled",
    ) ||
    child.structuredEvidence?.length !== 1 ||
    child.structuredEvidence[0]?.validationOutcome !== "validated"
  ) {
    throw new Error(`PR collaboration child ${child.id} lacks valid V2 lineage, model, or output evidence`)
  }
}
for (const worker of workers) {
  const tools = worker.v2Tools
  const read = tools.find((tool) => tool.name === "read" && tool.status === "completed")
  const write = tools.find((tool) => tool.name === "write" && tool.status === "completed")
  if (
    tools.length !== 2 ||
    !read || !write ||
    tools.filter((tool) => tool.name === "read").length !== 1 ||
    tools.filter((tool) => tool.name === "write").length !== 1 ||
    typeof read.output !== "string" ||
    typeof write.input !== "object" || write.input === null ||
    read.output !== write.input.content ||
    ![`${leftMarker}\n`, `${rightMarker}\n`].includes(read.output)
  ) {
    throw new Error(`Worker ${worker.id} did not perform exactly one matching read and write`)
  }
}
if (reviewers.some((reviewer) => reviewer.v2Tools.length > 0)) {
  throw new Error("A V2 PR reviewer called a tool")
}
const taskTools = observation.tools.filter((tool) => tool.name === "task" && tool.status === "completed")
const finalizeTools = observation.tools.filter((tool) => tool.name === "pr_finalize" && tool.status === "completed")
if (taskTools.length !== 2 || new Set(taskTools.map((tool) => tool.messageID)).size !== 1) {
  throw new Error("Parent did not emit two completed task calls in one provider response")
}
if (finalizeTools.length !== 1 || finalizeTools[0]!.messageID === taskTools[0]!.messageID) {
  throw new Error("Parent did not finalize both PRs in a subsequent provider response")
}
if (observation.tools.some((tool) => !["task", "pr_finalize"].includes(tool.name))) {
  throw new Error("Parent executed a forbidden non-collaboration tool")
}
const finalized: unknown = JSON.parse(finalizeTools[0]!.output ?? "null")
if (
  !Array.isArray(finalized) || finalized.length !== 2 ||
  finalized.some((entry) => typeof entry !== "object" || entry === null || entry.status !== "merged") ||
  new Set(finalized.map((entry) => entry.prID)).size !== 2 ||
  new Set(finalized.map((entry) => entry.mode)).size !== 2
) {
  throw new Error(`V2 PR finalization did not merge both branches: ${JSON.stringify(finalized)}`)
}
const runs = observation.taskRuns ?? []
if (
  runs.length !== 4 ||
  runs.some((run) => run.executionRuntime !== "v2" || run.parentSessionID !== observation.sessionID ||
    run.state !== "completed" || !observation.children.some((child) => child.id === run.childSessionID)) ||
  runs.filter((run) => run.workspaceMode === "worktree").length !== 2
) {
  throw new Error(`V2 PR task runs did not settle: ${JSON.stringify(runs)}`)
}
const permissionIDs = observation.permissionRequests.map((request) => String(request.id)).sort()
if (
  permissionIDs.length !== 2 ||
  new Set(observation.permissionRequests.map((request) => request.sessionID)).size !== 2 ||
  observation.permissionRequests.some((request) => request.permission !== "read") ||
  observation.permissionBarrierSnapshots.length !== 1 ||
  observation.permissionBarrierSnapshots[0]?.slice().sort().join("\0") !== permissionIDs.join("\0") ||
  observation.pendingPermissionIDs.length !== 0
) {
  throw new Error("Parallel PR workers did not cross the permission concurrency barrier cleanly")
}
const collaboration = artifact.collaboration
if (!collaboration || (collaboration.worktrees.match(/^worktree /gm) ?? []).length !== 1) {
  throw new Error("PR collaboration leaked worker worktrees")
}
if (
  artifact.workspace.files["output/left.txt"] !== `${leftMarker}\n` ||
  artifact.workspace.files["output/right.txt"] !== `${rightMarker}\n` ||
  artifact.workspace.status.trim() !== ""
) {
  throw new Error("Merged PR outputs or final parent cleanliness are invalid")
}
const evaluation = artifact.evaluation as { exitCode?: number; stdout?: string } | undefined
if (!evaluation || evaluation.exitCode !== 0 || !evaluation.stdout?.includes(verifierSuccess)) {
  throw new Error(`Hidden PR collaboration verifier failed: ${JSON.stringify(evaluation)}`)
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    workerSessionIDs: workers.map((worker) => worker.id),
    reviewerSessionIDs: reviewers.map((reviewer) => reviewer.id),
    prIDs: finalized.map((entry) => entry.prID),
    mergeModes: finalized.map((entry) => entry.mode),
    concurrentPermissionIDs: permissionIDs,
    hiddenVerifierExit: evaluation.exitCode,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${workers.length} workers, ${finalized.length} merged PRs)`,
)

finishLiveScript()
