import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// Both foreground task calls must reach Permission.ask before either can continue. This proves real
// overlap without relying on timing thresholds, then verifies explicit worktree isolation.
const leftMarker = `parallel-left-${crypto.randomUUID()}`
const rightMarker = `parallel-right-${crypto.randomUUID()}`
const leftContent = `${leftMarker}\n`
const rightContent = `${rightMarker}\n`
const verifierSuccess = `parallel-ok-${crypto.randomUUID()}`
const verifierScript = `#!/bin/sh
set -eu
left=$(cat output/left.txt 2>/dev/null || true)
right=$(cat output/right.txt 2>/dev/null || true)
if [ "$left" = "${leftMarker}" ]; then
  test -z "$right"
else
  test "$right" = "${rightMarker}"
  test -z "$left"
fi
printf '%s\n' '${verifierSuccess}'
`
const outputSchema = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
}
const prompt = [
  "Your FIRST assistant response must contain exactly two task tool calls and no text.",
  "Emit both calls together in that one response as parallel FOREGROUND calls; do not call one and wait for it before calling the other.",
  "Both calls must use subagent_type worker, background false, isolation worktree, and the raw output_schema provided below.",
  `Use this exact output_schema for both calls: ${JSON.stringify(outputSchema)}.`,
  "LEFT call description: parallel left implementation.",
  "LEFT prompt: Read only fixtures/left.txt exactly once. Then use the write tool exactly once to write the exact file content to output/left.txt. Do not inspect output/left.txt or its parent, and do not call bash or edit. Report the exact bytes written so the finalizer can return result.",
  "RIGHT call description: parallel right implementation.",
  "RIGHT prompt: Read only fixtures/right.txt exactly once. Then use the write tool exactly once to write the exact file content to output/right.txt. Do not inspect output/right.txt or its parent, and do not call bash or edit. Report the exact bytes written so the finalizer can return result.",
  "Do not call read, write, edit, bash, task_status, or task_read in the parent.",
  "After both task results return, report both exact result strings.",
].join(" ")

const artifact = await runLegacyLiveCases({
  suite: "multi-agent-parallel-worktrees-legacy",
  permission: { "*": "deny" },
  primaryPermission: { "*": "deny", task: "allow" },
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
  cases: [{ name: "parallel-worktrees", prompt }],
  files: {
    "fixtures/left.txt": leftContent,
    "fixtures/right.txt": rightContent,
  },
  inspectFiles: ["output/left.txt", "output/right.txt"],
  inspectChildFiles: ["output/left.txt", "output/right.txt"],
  toolSandbox: { verifierScript, initialVerifier: "fail" },
  verifyChildWorktrees: true,
  inspectTaskRuns: true,
  permissionReply: { reply: "once" },
  permissionBarrierCount: 2,
  modelMaxTokens: 2048,
  maxProviderTurns: 10,
  timeoutMs: 180_000,
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
)

if ([leftMarker, rightMarker, verifierSuccess].some((marker) => prompt.includes(marker))) {
  throw new Error("Parallel worktree hidden marker leaked into the parent prompt")
}
if (!artifact.sandbox?.networkDenied || !artifact.sandbox.verifierWriteDenied) {
  throw new Error("Parallel worktree suite requires the qualified tool sandbox")
}

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing parallel worktree observation")
if (observation.providerErrors.length > 0) {
  throw new Error(`Parallel worktree provider turn failed: ${JSON.stringify(observation.providerErrors)}`)
}
if (observation.children.length !== 2 || new Set(observation.children.map((child) => child.id)).size !== 2) {
  throw new Error(`Expected two distinct child sessions, received ${observation.children.length}`)
}
if (
  new Set(observation.children.map((child) => child.directory)).size !== 2 ||
  observation.children.some((child) => child.directory === artifact.workspace.directory)
) {
  throw new Error("Parallel workers did not receive distinct isolated worktrees")
}
const branchFiles = observation.children.map((child) => child.branchFiles)
if (
  branchFiles.filter((files) => files?.["output/left.txt"] === leftContent && files["output/right.txt"] === undefined).length !== 1 ||
  branchFiles.filter((files) => files?.["output/right.txt"] === rightContent && files["output/left.txt"] === undefined).length !== 1
) {
  throw new Error(`Parallel worker branches do not preserve isolated outputs: ${JSON.stringify(branchFiles)}`)
}
for (const child of observation.children) {
  const read = child.v2Tools.find((tool) => tool.name === "read" && tool.status === "completed")
  const write = child.v2Tools.find((tool) => tool.name === "write" && tool.status === "completed")
  if (
    child.parentID !== observation.sessionID || child.agent !== "worker" ||
    child.v2Assistants.length === 0 ||
    child.v2Assistants.some((assistant) => assistant.model.providerID !== artifact.fingerprint.runtimeProviderID ||
      assistant.model.id !== artifact.fingerprint.modelID) ||
    child.v2ProviderTurns.length === 0 ||
    child.v2ProviderTurns.some((turn) => turn.providerID !== artifact.fingerprint.runtimeProviderID ||
      turn.modelID !== artifact.fingerprint.modelID || turn.state !== "settled") ||
    child.structuredEvidence?.length !== 1 ||
    child.structuredEvidence[0]?.validationOutcome !== "validated" ||
    child.v2Tools.length !== 2 || !read || !write ||
    typeof read.output !== "string" || typeof write.input !== "object" || write.input === null ||
    read.output !== write.input.content ||
    child.directoryExists || child.status !== "<removed>" || !child.branch
  ) {
    throw new Error(`Parallel worker ${child.id} has invalid V2 run, tool, or branch evidence`)
  }
}
const runs = observation.taskRuns ?? []
if (
  runs.length !== 2 || runs.some((run) => run.executionRuntime !== "v2" ||
    run.parentSessionID !== observation.sessionID || run.state !== "completed" ||
    run.workspaceMode !== "worktree" || !observation.children.some((child) => child.id === run.childSessionID))
) {
  throw new Error(`Parallel V2 task runs did not settle: ${JSON.stringify(runs)}`)
}
const taskTools = observation.tools.filter((tool) => tool.name === "task" && tool.status === "completed")
if (taskTools.length !== 2 || new Set(taskTools.map((tool) => tool.messageID)).size !== 1) {
  throw new Error("Parent did not emit two completed task calls in one provider response")
}
if (taskTools.some((tool) => {
  const input = tool.input
  return typeof input !== "object" || input === null || input.subagent_type !== "worker" ||
    input.isolation !== "worktree" || input.background === true ||
    !observation.children.some((child) => tool.metadata?.task_id === child.id)
})) {
  throw new Error("Parent task calls did not preserve worker/worktree/foreground inputs and child linkage")
}
if (observation.tools.some((tool) => tool.name !== "task")) {
  throw new Error("Parent executed a forbidden non-task tool")
}
const permissionIDs = observation.permissionRequests.map((request) => String(request.id)).sort()
if (
  permissionIDs.length !== 2 ||
  new Set(observation.permissionRequests.map((request) => request.sessionID)).size !== 2 ||
  observation.permissionRequests.some((request) => request.permission !== "read" ||
    !observation.children.some((child) => child.id === request.sessionID &&
      child.directory === request.eventDirectory)) ||
  observation.permissionBarrierSnapshots.length !== 1 ||
  observation.permissionBarrierSnapshots[0]?.slice().sort().join("\0") !== permissionIDs.join("\0") ||
  observation.pendingPermissionIDs.length !== 0
) {
  throw new Error(`Parallel V2 permission routing or barrier failed: ${JSON.stringify(observation.permissionRequests)}`)
}
if (
  artifact.workspace.files["output/left.txt"] !== undefined ||
  artifact.workspace.files["output/right.txt"] !== undefined ||
  artifact.workspace.status.trim() !== ""
) {
  throw new Error("Explicit worktree output leaked into the parent checkout")
}
if (![leftMarker, rightMarker].every((marker) => observation.finalText.includes(marker))) {
  throw new Error("Parent did not aggregate both parallel worker results")
}
const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    childIDs: observation.children.map((child) => child.id),
    childBranches: observation.children.map((child) => child.branch),
    sharedParentToolMessageID: taskTools[0]?.messageID,
    concurrentPermissionIDs: permissionIDs,
    parentBarrierSnapshot: observation.permissionBarrierSnapshots[0],
    leftOutputHash: Bun.hash(leftContent).toString(16),
    rightOutputHash: Bun.hash(rightContent).toString(16),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${observation.children.length} concurrent workers, ${observation.permissionRequests.length} permissions)`,
)

finishLiveScript()
