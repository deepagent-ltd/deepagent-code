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

for (const child of observation.children) {
  if (
    child.parentID !== observation.sessionID ||
    child.agent !== "worker" ||
    child.model?.providerID !== "live-deepseek" ||
    child.model.id !== artifact.fingerprint.modelID ||
    child.assistants.some(
      (assistant) =>
        assistant.providerID !== "live-deepseek" ||
        assistant.modelID !== artifact.fingerprint.modelID ||
        assistant.error !== undefined,
    )
  ) {
    throw new Error(`Parallel child ${child.id} has invalid lineage, role, or model identity`)
  }
  const subagent = nestedRecord(child.metadata, ["deepagent", "subagent"])
  if (subagent.state !== "completed" || subagent.finished !== true || subagent.reason !== "structured_output_valid") {
    throw new Error(`Parallel child ${child.id} did not persist a completed structured result`)
  }
  const tools = child.assistants.flatMap((assistant) => assistant.tools)
  if (
    tools.filter((tool) => tool.name === "read" && tool.status === "completed").length !== 1 ||
    tools.filter((tool) => tool.name === "write" && tool.status === "completed").length !== 1 ||
    tools.filter((tool) => tool.name === "StructuredOutput" && tool.status === "completed").length !== 1 ||
    tools.some((tool) => tool.status !== "completed")
  ) {
    throw new Error(
      `Parallel child ${child.id} has an invalid tool sequence: ${tools.map((tool) => `${tool.name}:${tool.status}`).join(" -> ")}`,
    )
  }
  const isLeft = child.files["output/left.txt"] === leftContent && child.files["output/right.txt"] === undefined
  const isRight = child.files["output/right.txt"] === rightContent && child.files["output/left.txt"] === undefined
  if ((!isLeft && !isRight) || child.status.trim().split("\n").filter(Boolean).length !== 1) {
    throw new Error(`Parallel child ${child.id} did not retain exactly one isolated output`)
  }
  if (child.verifier?.exitCode !== 0 || !child.verifier.stdout.includes(verifierSuccess)) {
    throw new Error(`Parallel child ${child.id} hidden verifier failed with exit ${child.verifier?.exitCode}`)
  }
}
if (
  observation.children.filter((child) => child.files["output/left.txt"] === leftContent).length !== 1 ||
  observation.children.filter((child) => child.files["output/right.txt"] === rightContent).length !== 1
) {
  throw new Error("Parallel workers did not produce one left and one right isolated result")
}

const taskTools = observation.tools.filter((tool) => tool.name === "task" && tool.status === "completed")
if (taskTools.length !== 2 || new Set(taskTools.map((tool) => tool.messageID)).size !== 1) {
  throw new Error("Parent did not emit two completed task calls in one provider response")
}
for (const child of observation.children) {
  const results = child.assistants.flatMap((assistant) => {
    if (
      typeof assistant.structured !== "object" ||
      assistant.structured === null ||
      Array.isArray(assistant.structured)
    ) {
      return []
    }
    return typeof assistant.structured.result === "string" ? [assistant.structured.result] : []
  })
  if (
    results.length !== 1 ||
    !taskTools.some((tool) => tool.output?.includes(`<task id="${child.id}" state="completed">`))
  ) {
    throw new Error(`Parallel child ${child.id} did not return one structured result through its parent task`)
  }
}
if (
  taskTools.some((tool) => {
    const input = record(tool.input, "task input")
    return input.subagent_type !== "worker" || input.isolation !== "worktree" || input.background === true
  })
) {
  throw new Error("Parent parallel task calls did not preserve worker/worktree/foreground inputs")
}
if (observation.tools.some((tool) => tool.status === "completed" && tool.name !== "task")) {
  throw new Error("Parent executed a forbidden non-task tool")
}

const permissionIDs = observation.permissionRequests.map((request) => String(request.id)).sort()
if (
  permissionIDs.length !== 2 ||
  new Set(observation.permissionRequests.map((request) => request.sessionID)).size !== 2 ||
  observation.permissionRequests.some(
    (request) => request.permission !== "read" || request.eventDirectory !== artifact.workspace.directory,
  )
) {
  throw new Error(`Parallel permission routing is invalid: ${JSON.stringify(observation.permissionRequests)}`)
}
if (
  observation.permissionBarrierSnapshots.length !== 1 ||
  observation.permissionBarrierSnapshots[0]?.slice().sort().join("\0") !== permissionIDs.join("\0")
) {
  throw new Error("Parent permission list never observed both child requests at the concurrency barrier")
}
if (observation.pendingPermissionIDs.length !== 0) {
  throw new Error(`Parallel suite left pending permissions: ${observation.pendingPermissionIDs.join(", ")}`)
}

if (
  artifact.workspace.files["output/left.txt"] !== undefined ||
  artifact.workspace.files["output/right.txt"] !== undefined ||
  artifact.workspace.status.trim() !== ""
) {
  throw new Error(`Explicit worktree output leaked into the parent checkout: ${JSON.stringify(artifact.workspace)}`)
}
if (![leftContent.trim(), rightContent.trim()].every((marker) => observation.finalText.includes(marker))) {
  throw new Error("Parent did not aggregate both parallel worker results")
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    childIDs: observation.children.map((child) => child.id),
    childDirectories: observation.children.map((child) => child.directory),
    sharedParentToolMessageID: taskTools[0]?.messageID,
    concurrentPermissionIDs: permissionIDs,
    parentBarrierSnapshot: observation.permissionBarrierSnapshots[0],
    parentPendingAfterCompletion: observation.pendingPermissionIDs,
    permissionEventDirectories: observation.permissionRequests.map((request) => request.eventDirectory),
    leftOutputHash: Bun.hash(leftContent).toString(16),
    rightOutputHash: Bun.hash(rightContent).toString(16),
    hiddenVerifierExits: observation.children.map((child) => child.verifier?.exitCode),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${observation.children.length} concurrent workers, ${observation.permissionRequests.length} parent-routed permissions)`,
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
