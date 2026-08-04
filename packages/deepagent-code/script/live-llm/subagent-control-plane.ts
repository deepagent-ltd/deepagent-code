import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// ─── REAL-CP-01: dirty-workspace read-only subagent ───────────────────────────
//
// Oracle: task_run.mutation_capability DB row (read_only enforced by L3a admission),
// observed via:
//   1. task_run.state = "completed" surfaced through task_status (L10 durable overlay)
//   2. child session's tool set — no write/edit/bash completed calls (read_only fence)
//   3. dirty parent workspace did NOT block admission (L3b only blocks writers)

const marker01 = `cp01-${crypto.randomUUID()}`
const evidence01 = `Control plane fixture key: ${marker01}`

const prompt01 = [
  "Call task exactly once in foreground mode with subagent_type researcher and description cp01 dirty-workspace read-only research.",
  "The child prompt must be exactly: Read fixtures/cp01.txt exactly once. Return a valid ResearchResult with mechanism set to the file content exactly, without quotes or explanation. Do not call task.",
  "Do not read the fixture in the parent.",
  "After the task completes, call task_status exactly once.",
  "Report the child session id and the completion state shown by task_status.",
].join("\n")

const artifact01 = await runLegacyLiveCases({
  suite: "subagent-cp-dirty-readonly",
  permission: { "*": "deny", read: "allow" },
  primaryPermission: { "*": "deny", task: "allow", task_status: "allow" },
  environment: { DEEPAGENT_CODE_SUBAGENT_CONTROL_PLANE: "durable" },
  cases: [{ name: "subagent-dirty-readonly", prompt: prompt01 }],
  files: { "fixtures/cp01.txt": `${evidence01}\n` },
  beforeCase: async ({ directory }) => {
    // Write an uncommitted file so the parent workspace is dirty.
    // A researcher (mutation_capability=read_only) must still be admitted — only
    // automatic writers are blocked by L3b preflight (design §3.2 + §15.3.3).
    await Bun.write(path.join(directory, "dirty-marker.txt"), `dirty-${marker01}\n`)
  },
})

await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact01.suite}-observed`,
  artifact01,
)

// ─── Oracle: REAL-CP-01 ───────────────────────────────────────────────────────

const cp01 = artifact01.cases[0]
if (!cp01) throw new Error("REAL-CP-01: Missing observation")

const cp01Done = cp01.tools.filter((t) => t.status === "completed")
if (!cp01Done.some((t) => t.name === "task")) {
  throw new Error(
    `REAL-CP-01: Parent did not complete a task call; tools: ${cp01.tools.map((t) => `${t.name}:${t.status}`).join(", ")}`,
  )
}
if (!cp01Done.some((t) => t.name === "task_status")) {
  throw new Error("REAL-CP-01: Parent did not call task_status")
}

// DB-oracle: task_status reads from task_run.state (L10 durable overlay in task_status.ts).
// D-2 (P1-10): production outputs English "completed" state, not French "[terminé]".
// Accept either so this harness works after the string alignment fix.
const statusOut01 = cp01Done.find((t) => t.name === "task_status")?.output ?? ""
if (!statusOut01.includes("completed") && !statusOut01.includes("[terminé]")) {
  throw new Error(
    `REAL-CP-01: task_status DB-oracle did not report completed state. Output: ${statusOut01.slice(0, 300)}`,
  )
}

if (cp01.children.length !== 1) {
  throw new Error(`REAL-CP-01: Expected one child session, received ${cp01.children.length}`)
}
const child01 = cp01.children[0]!
if (child01.parentID !== cp01.sessionID || child01.agent !== "researcher") {
  throw new Error("REAL-CP-01: Child lineage or agent type incorrect")
}

// DB-oracle: child session metadata — set by settleSubagentRun in task.ts
const subagent01 = nestedRecord(child01.metadata, ["deepagent", "subagent"])
if (subagent01.finished !== true || subagent01.state !== "completed") {
  throw new Error(
    `REAL-CP-01: Child durable metadata state incorrect: ${JSON.stringify(subagent01)}`,
  )
}
if (typeof subagent01.run_id !== "string" || subagent01.run_id.length === 0) {
  throw new Error("REAL-CP-01: Child durable metadata missing run_id — legacy path was used, not durable")
}

// mutation_capability=read_only fence: child must NOT have successfully called mutating tools
const childTools01 = child01.assistants.flatMap((a) => a.tools)
const mutating01 = childTools01.filter(
  (t) => t.status === "completed" && ["write", "edit", "bash"].includes(t.name),
)
if (mutating01.length > 0) {
  throw new Error(
    `REAL-CP-01: Read-only subagent completed mutating tool calls: ${mutating01.map((t) => t.name).join(", ")}`,
  )
}

// L3b admission gate must NOT have blocked the researcher despite the dirty workspace
const taskOut01 = cp01Done.find((t) => t.name === "task")?.output ?? ""
if (taskOut01.includes("workspace_dirty") || taskOut01.includes("uncommitted changes")) {
  throw new Error("REAL-CP-01: L3b dirty-workspace gate incorrectly rejected read-only researcher")
}

// Child must have read the fixture through a completed read tool
if (!childTools01.some((t) => t.name === "read" && t.status === "completed" && t.output?.includes(marker01))) {
  throw new Error("REAL-CP-01: Child did not obtain the marker through a completed read tool")
}

const result01 = {
  ...artifact01,
  evidence: {
    markerHash: Bun.hash(marker01).toString(16),
    childSessionIDLength: child01.id.length,
    dirtyWorkspaceAllowed: true,
    mutatingToolsUsed: mutating01.length,
    durableState: subagent01.state,
    runID: (subagent01.run_id as string).slice(0, 8),
    taskStatusDbOracle: statusOut01.includes("[terminé]"),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result01.suite,
  result01,
)
console.log(`${result01.suite}: passed (${result01.fingerprint.providerID}/${result01.fingerprint.modelID})`)

// ─── REAL-CP-02: durable event audit trail ────────────────────────────────────
//
// Oracle: task_run_event table (run_queued → run_claimed → execution_started → run_settled).
// These four events must all have been written for task_run.state to reach "completed".
// Direct table access is not available from the live-test harness, so we verify the
// implied invariant: task_run.state = "completed" (surfaced by task_status L10 overlay)
// + child.metadata.deepagent.subagent.{finished, state, run_id, generation} set by
// settleSubagentRun — which is only reached after run_settled is written.

const marker02 = `cp02-${crypto.randomUUID()}`
const evidence02 = `Audit fixture key: ${marker02}`

const prompt02 = [
  "Call task exactly once in foreground mode with subagent_type researcher and description cp02 durable-events audit.",
  "The child prompt must be exactly: Read fixtures/cp02.txt exactly once. Return a valid ResearchResult with mechanism set to the file content exactly, without quotes or explanation. Do not call task.",
  "Do not read the fixture in the parent.",
  "After the task completes, call task_status exactly once.",
  "Report the child session id and the state shown by task_status.",
].join("\n")

const artifact02 = await runLegacyLiveCases({
  suite: "subagent-cp-durable-events",
  permission: { "*": "deny", read: "allow" },
  primaryPermission: { "*": "deny", task: "allow", task_status: "allow" },
  environment: { DEEPAGENT_CODE_SUBAGENT_CONTROL_PLANE: "durable" },
  cases: [{ name: "subagent-durable-events", prompt: prompt02 }],
  files: { "fixtures/cp02.txt": `${evidence02}\n` },
})

await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact02.suite}-observed`,
  artifact02,
)

// ─── Oracle: REAL-CP-02 ───────────────────────────────────────────────────────

const cp02 = artifact02.cases[0]
if (!cp02) throw new Error("REAL-CP-02: Missing observation")

const cp02Done = cp02.tools.filter((t) => t.status === "completed")
if (!cp02Done.some((t) => t.name === "task")) {
  throw new Error(
    `REAL-CP-02: Parent did not complete a task call; tools: ${cp02.tools.map((t) => `${t.name}:${t.status}`).join(", ")}`,
  )
}
if (!cp02Done.some((t) => t.name === "task_status")) {
  throw new Error("REAL-CP-02: Parent did not call task_status")
}

// DB-oracle: task_run.state sourced via task_status L10 durable overlay.
// "completed" in task_status means the run_settled event was committed to task_run_event,
// which is only written after execution_started, which follows run_claimed, run_queued.
// D-2 (P1-10): accept both "completed" and "[terminé]" for forward/backward compat.
const statusOut02 = cp02Done.find((t) => t.name === "task_status")?.output ?? ""
if (!statusOut02.includes("completed") && !statusOut02.includes("[terminé]")) {
  throw new Error(
    `REAL-CP-02: task_status DB-oracle did not report completed state. Output: ${statusOut02.slice(0, 300)}`,
  )
}

if (cp02.children.length !== 1) {
  throw new Error(`REAL-CP-02: Expected one child session, received ${cp02.children.length}`)
}
const child02 = cp02.children[0]!
if (child02.parentID !== cp02.sessionID || child02.agent !== "researcher") {
  throw new Error("REAL-CP-02: Child lineage or agent type incorrect")
}

// DB-oracle: metadata set by settleSubagentRun → implies run_settled event was written
const subagent02 = nestedRecord(child02.metadata, ["deepagent", "subagent"])
if (subagent02.finished !== true || subagent02.state !== "completed") {
  throw new Error(
    `REAL-CP-02: Durable event audit incomplete — child has state=${subagent02.state} finished=${subagent02.finished}`,
  )
}

// Presence of run_id and generation proves the durable code path was taken (not legacy)
if (typeof subagent02.run_id !== "string" || subagent02.run_id.length === 0) {
  throw new Error("REAL-CP-02: Child durable metadata missing run_id — durable path was not activated")
}
if (typeof subagent02.generation !== "number") {
  throw new Error("REAL-CP-02: Child durable metadata missing generation — durable path was not activated")
}

// Child must have read the fixture through a completed read tool
const childTools02 = child02.assistants.flatMap((a) => a.tools)
if (!childTools02.some((t) => t.name === "read" && t.status === "completed" && t.output?.includes(marker02))) {
  throw new Error("REAL-CP-02: Child did not obtain the marker through a completed read tool")
}

const result02 = {
  ...artifact02,
  evidence: {
    markerHash: Bun.hash(marker02).toString(16),
    childSessionIDLength: child02.id.length,
    durableState: subagent02.state,
    runID: (subagent02.run_id as string).slice(0, 8),
    generation: subagent02.generation,
    taskStatusDbOracle: statusOut02.includes("[terminé]"),
    // All four events must have been written in task_run_event for state="completed":
    impliedEventTrail: ["run_queued", "run_claimed", "execution_started", "run_settled"],
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result02.suite,
  result02,
)
console.log(`${result02.suite}: passed (${result02.fingerprint.providerID}/${result02.fingerprint.modelID})`)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nestedRecord(value: unknown, keys: string[]) {
  const result = keys.reduce<Record<string, unknown> | undefined>((current, key) => {
    if (!current) return undefined
    const next = current[key]
    if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined
    return next as Record<string, unknown>
  }, typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)
  if (!result) throw new Error(`Missing object path ${keys.join(".")}`)
  return result
}

finishLiveScript()
