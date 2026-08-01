import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const marker = `v4-${crypto.randomUUID()}`
const brokenSource = "export const add = (left: number, right: number) => left - right\n"
const fixedSource = `// ${marker}\nexport const add = (left: number, right: number) => left + right\n`
const verifier = `#!/bin/sh
set -eu
bun test
`

const artifact = await runLegacyLiveCases({
  suite: "v4-multi-agent-runtime",
  permission: { "*": "deny" },
  agentPermissions: {
    auto: {
      "*": "deny",
      read: {
        "*": "deny",
        "fixtures/fix.txt": "allow",
        "src/calc.ts": "allow",
        "test/calc.test.ts": "allow",
        "package.json": "allow",
      },
      edit: { "*": "deny", "src/calc.ts": "allow" },
      bash: { "*": "deny", "./verify": "allow" },
    },
  },
  cases: [],
  files: {
    "fixtures/fix.txt": fixedSource,
    "src/calc.ts": brokenSource,
    "test/calc.test.ts": [
      'import { expect, test } from "bun:test"',
      'import { add } from "../src/calc"',
      'test("adds", () => expect(add(20, 22)).toBe(42))',
      "",
    ].join("\n"),
  },
  inspectFiles: ["src/calc.ts", "test/calc.test.ts"],
  toolSandbox: { verifierScript: verifier, initialVerifier: "fail" },
  v4Event: {
    type: "ci.failure",
    source: "ci",
    payload: {
      files: ["src/calc.ts", "test/calc.test.ts"],
      command: "./verify",
      failure: "the adds test expected 42 and received -2",
      instruction:
        "Read fixtures/fix.txt and replace src/calc.ts with those exact bytes. Run ./verify after the repair and during verification.",
    },
  },
  modelMaxTokens: 1024,
  maxProviderTurns: 8,
  timeoutMs: 240_000,
})

await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
)

if (artifact.status !== "passed" || !artifact.v4) {
  throw new Error(`V4 runtime failed: ${JSON.stringify(artifact.error)}`)
}
if (artifact.mode !== "ext" || artifact.stack !== "v4-event-runtime") {
  throw new Error(`V4 runtime artifact is mislabeled: ${artifact.mode}/${artifact.stack}`)
}
if (
  artifact.v4.dispatch.decision.type !== "dispatch" ||
  !artifact.v4.dispatch.sourceDeliveryPendingBefore ||
  artifact.v4.dispatch.sourceDeliveryPendingAfter
) {
  throw new Error(`V4 event did not traverse and ack the durable dispatcher delivery: ${JSON.stringify(artifact.v4.dispatch)}`)
}
if (
  artifact.v4.summary.hasUnfinished ||
  artifact.v4.summary.outcomes.length !== 2 ||
  artifact.v4.summary.outcomes.some((outcome) => outcome.status !== "completed")
) {
  throw new Error(`V4 DAG did not complete: ${JSON.stringify(artifact.v4.summary)}`)
}
if (
  artifact.v4.executions.length !== 2 ||
  artifact.v4.executions.some(
    (execution) =>
      execution?.status !== "completed" ||
      execution.generation !== 1 ||
      !execution.continuationRef ||
      !execution.artifacts.some((item) => item.startsWith("session:")),
  )
) {
  throw new Error(`V4 durable execution rows are incomplete: ${JSON.stringify(artifact.v4.executions)}`)
}
if (artifact.v4.childSessions.length !== 2) {
  throw new Error(`Expected two real V4 child Sessions, received ${artifact.v4.childSessions.length}`)
}
for (const session of artifact.v4.childSessions) {
  if (
    session.directory === artifact.workspace.directory ||
    session.assistants.length === 0 ||
    session.assistants.some(
      (assistant) =>
        assistant.providerID !== "live-deepseek" ||
        assistant.modelID !== artifact.fingerprint.modelID ||
        assistant.error !== undefined,
    ) ||
    session.assistants.reduce(
      (total, assistant) =>
        total + assistant.tokens.input + assistant.tokens.output + assistant.tokens.reasoning,
      0,
    ) <= 0
  ) {
    throw new Error(`V4 child Session lacks real provider evidence: ${JSON.stringify(session)}`)
  }
}
artifact.v4.childSessions.forEach((session, index) => {
  const expected = session.assistants.reduce(
    (total, assistant) =>
      total + assistant.tokens.input + assistant.tokens.output + assistant.tokens.reasoning,
    0,
  )
  if (artifact.v4?.executions[index]?.tokensUsed !== expected) {
    throw new Error(
      `Durable token debit does not equal the complete child Session: execution=${artifact.v4?.executions[index]?.tokensUsed}, session=${expected}`,
    )
  }
})
const tools = artifact.v4.childSessions.flatMap((session) =>
  session.assistants.flatMap((assistant) => assistant.tools.filter((tool) => tool.status === "completed")),
)
if (
  !tools.some((tool) => tool.name === "read") ||
  !tools.some((tool) => tool.name === "write" || tool.name === "edit") ||
  !tools.some((tool) => tool.name === "bash")
) {
  throw new Error(`V4 turns did not execute the required production tools: ${JSON.stringify(tools)}`)
}
const finalRef = artifact.v4.executions.at(-1)?.continuationRef
if (!finalRef || artifact.v4.refFiles[finalRef]?.["src/calc.ts"] !== fixedSource) {
  throw new Error(`Final continuation does not contain the hidden repair: ${JSON.stringify(artifact.v4.refFiles)}`)
}
const v4PR = artifact.v4.prCollaboration.entries[0]
const v4Author = artifact.v4.childSessions.find((session) => session.id === v4PR?.workerID)
if (
  artifact.v4.prCollaboration.entries.length !== 1 ||
  v4PR?.status !== "awaiting_review" ||
  v4PR.workerHead !== finalRef ||
  v4PR.parentID !== artifact.v4.parentSession.id ||
  v4PR.metadata?.cleanupRequired !== true ||
  v4PR.metadata?.workerDirectory !== v4Author?.directory ||
  !artifact.v4.prCollaboration.worktrees.includes(`worktree ${v4Author?.directory}`) ||
  artifact.v4.prCollaboration.approvals.length !== 1 ||
  artifact.v4.parentSession.children.some((child) => child.parentID !== artifact.v4?.parentSession.id) ||
  artifact.v4.prCollaboration.branch !== `deepagent-code/session-${artifact.v4.parentSession.id}`
) {
  throw new Error(`V4 continuation did not enter the PR collaboration boundary: ${JSON.stringify(artifact.v4)}`)
}
if (
  artifact.workspace.files["src/calc.ts"] !== brokenSource ||
  artifact.workspace.status.trim() !== "" ||
  artifact.v4.permissionRequests.length > 0 ||
  artifact.v4.questionRequests.length > 0 ||
  artifact.v4.pendingPermissionIDs.length > 0 ||
  artifact.v4.pendingQuestionIDs.length > 0
) {
  throw new Error("V4 runtime mutated the parent checkout or leaked an interactive request")
}

const result = {
  ...artifact,
  status: "passed" as const,
  evidence: {
    eventID: artifact.v4.event.id,
    agents: artifact.v4.childSessions.map((session) => session.agent),
    continuations: artifact.v4.executions.map((execution) => execution?.continuationRef),
    prIDs: artifact.v4.prCollaboration.entries.map((entry) => entry.id),
    completedTools: tools.map((tool) => tool.name),
    parentCheckoutClean: true,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(`${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID})`)
finishLiveScript()
