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
  "LEFT prompt: Read only fixtures/left.txt exactly once. Then use write exactly once to write those exact bytes to output/left.txt. Do not use bash or edit. Return result set to the exact bytes written.",
  "RIGHT description: implement right PR fixture.",
  "RIGHT prompt: Read only fixtures/right.txt exactly once. Then use write exactly once to write those exact bytes to output/right.txt. Do not use bash or edit. Return result set to the exact bytes written.",
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
  artifact,
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
const seniorReviewers = observation.children.filter((child) => child.agent === "senior-reviewer")
if (workers.length !== 2 || reviewers.length !== 1 || seniorReviewers.length !== 1) {
  throw new Error(
    `Expected 2 workers, 1 Reviewer, and 1 Senior Reviewer; received ${workers.length}/${reviewers.length}/${seniorReviewers.length}`,
  )
}
for (const child of observation.children) {
  if (
    child.parentID !== observation.sessionID ||
    child.model?.providerID !== "live-deepseek" ||
    child.model.id !== artifact.fingerprint.modelID ||
    child.assistants.some(
      (assistant) =>
        assistant.providerID !== "live-deepseek" ||
        assistant.modelID !== artifact.fingerprint.modelID ||
        assistant.error !== undefined,
    )
  ) {
    throw new Error(`PR collaboration child ${child.id} has invalid lineage or model identity`)
  }
  const subagent = nestedRecord(child.metadata, ["deepagent", "subagent"])
  if (subagent.state !== "completed" || subagent.finished !== true || subagent.reason !== "structured_output_valid") {
    throw new Error(`PR collaboration child ${child.id} did not persist a valid terminal result`)
  }
}
if (workers.some((child) => child.directoryExists || child.status !== "<removed>")) {
  throw new Error("Merged worker worktrees were not removed")
}
if (new Set(workers.map((child) => child.directory)).size !== 2) {
  throw new Error("Parallel PR workers did not receive distinct worktrees")
}
for (const worker of workers) {
  const tools = worker.assistants.flatMap((assistant) => assistant.tools)
  if (
    tools.filter((tool) => tool.name === "read" && tool.status === "completed").length !== 1 ||
    tools.filter((tool) => tool.name === "write" && tool.status === "completed").length !== 1 ||
    tools.filter((tool) => tool.name === "StructuredOutput" && tool.status === "completed").length !== 1 ||
    tools.some((tool) => tool.status !== "completed")
  ) {
    throw new Error(`Worker ${worker.id} has an invalid tool sequence`)
  }
}
const reviewerTools = reviewers[0]!.assistants.flatMap((assistant) => assistant.tools)
if (
  reviewerTools.filter((tool) => tool.name === "StructuredOutput" && tool.status === "completed").length !== 2 ||
  reviewerTools.some((tool) => ["bash", "edit", "write", "patch", "task"].includes(tool.name))
) {
  throw new Error("The batch Reviewer did not complete two read-only structured reviews")
}
const seniorTools = seniorReviewers[0]!.assistants.flatMap((assistant) => assistant.tools)
if (
  seniorTools.filter((tool) => tool.name === "StructuredOutput" && tool.status === "completed").length < 1 ||
  seniorTools.some((tool) => ["bash", "task"].includes(tool.name))
) {
  throw new Error("The Senior Reviewer did not complete a bounded stage review")
}

const taskTools = observation.tools.filter((tool) => tool.name === "task" && tool.status === "completed")
const finalizeTools = observation.tools.filter((tool) => tool.name === "pr_finalize" && tool.status === "completed")
if (taskTools.length !== 2 || new Set(taskTools.map((tool) => tool.messageID)).size !== 1) {
  throw new Error("Parent did not emit two completed task calls in one provider response")
}
if (finalizeTools.length !== 1 || finalizeTools[0]!.messageID === taskTools[0]!.messageID) {
  throw new Error("Parent did not finalize the PR batch in one subsequent provider response")
}
if (observation.tools.some((tool) => tool.status === "completed" && !["task", "pr_finalize"].includes(tool.name))) {
  throw new Error("Parent executed a forbidden non-collaboration tool")
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
if (!collaboration) throw new Error("Missing persisted PR collaboration evidence")
const queue = record(collaboration.queue, "PR queue")
const entries = array(queue.entries, "PR queue entries").map((entry) => record(entry, "PR queue entry"))
if (entries.length !== 2 || entries.some((entry) => entry.status !== "merged")) {
  throw new Error(`Expected two merged PR queue entries: ${JSON.stringify(entries)}`)
}
if (
  new Set(entries.map((entry) => entry.parentID)).size !== 1 ||
  entries[0]?.parentID !== observation.sessionID ||
  new Set(entries.map((entry) => entry.reviewerID)).size !== 1 ||
  entries[0]?.reviewerID !== reviewers[0]!.id ||
  new Set(entries.map((entry) => record(entry.metadata, "PR metadata").batchID)).size !== 1 ||
  entries.some((entry) => entry.sha !== entry.workerHead || !workers.some((worker) => worker.id === entry.workerID))
) {
  throw new Error("PR queue ownership, batch, reviewer, or exact-SHA binding is invalid")
}
const stageReviews = entries.map((entry) => record(record(entry.metadata, "PR metadata").stageReview, "stage review"))
if (
  stageReviews.some(
    (review) =>
      review.status !== "approved" ||
      review.reviewerID !== seniorReviewers[0]!.id ||
      review.implementationCommitSha !== collaboration.head,
  )
) {
  throw new Error(`Senior review ownership or durable settlement is invalid: ${JSON.stringify(stageReviews)}`)
}
const mergeCommits = collaboration.firstParentLog.filter((line) => line.split("\t")[1]?.split(" ").length === 2)
if (mergeCommits.length !== 2) {
  throw new Error(
    `Expected exactly two first-parent no-ff merge commits: ${JSON.stringify(collaboration.firstParentLog)}`,
  )
}
if (!collaboration.branch.startsWith("deepagent-code/session-")) {
  throw new Error(`PR batch ran on an unsafe target branch: ${collaboration.branch}`)
}
if ((collaboration.worktrees.match(/^worktree /gm) ?? []).length !== 1) {
  throw new Error(`PR collaboration leaked worker worktrees: ${collaboration.worktrees}`)
}
if (
  artifact.workspace.files["output/left.txt"] !== `${leftMarker}\n` ||
  artifact.workspace.files["output/right.txt"] !== `${rightMarker}\n` ||
  artifact.workspace.status.trim() !== ""
) {
  throw new Error("Merged PR outputs or final parent cleanliness are invalid")
}
const evaluation = record(artifact.evaluation, "hidden verifier")
if (evaluation.exitCode !== 0 || !String(evaluation.stdout).includes(verifierSuccess)) {
  throw new Error(`Hidden PR collaboration verifier failed: ${JSON.stringify(evaluation)}`)
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    workerSessionIDs: workers.map((worker) => worker.id),
    reviewerSessionID: reviewers[0]!.id,
    seniorReviewerSessionID: seniorReviewers[0]!.id,
    prIDs: entries.map((entry) => entry.id),
    sharedBatchID: record(entries[0]!.metadata, "PR metadata").batchID,
    exactWorkerSHAs: entries.map((entry) => entry.workerHead),
    sessionBranch: collaboration.branch,
    mergeCommits,
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
    `${workers.length} workers, ${entries.length} merged PRs, ${mergeCommits.length} serial merges)`,
)

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} is not an array`)
  return value
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
