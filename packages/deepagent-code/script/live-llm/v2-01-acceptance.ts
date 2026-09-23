import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { failLiveScript, finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// V2.0.1-001 P4 live acceptance (docs/V2.0.1-001-llm-agent-system-manual.md §4.7/§5.8/§6.3/§8.3).
// Three suites, each a self-contained isolated run against the production V2 prompt path:
//   manual-chain        — L1 pack_search -> L2 domain_pack_load reachable; per-turn load budget ≤2 (§4.7)
//   knowledge-propose   — WS7 B6 stages a human-review candidate, never active-direct (§8.3)
//   permission-feedback — B1: operator feedback survives to the model; no unchanged retry (§6.3)
//   delegation-worktree — WS4b-S2: write-type task output names its deepagent-code/task-* branch (§5.8)
// Run one suite with: bun run script/live-llm/v2-01-acceptance.ts <suite-prefix>

type Failure = { classification: string; message: string }
const only = process.argv[2]
const artifactDirectory = path.resolve(import.meta.dir, "../../.artifacts/live-llm")

const totals = { input: 0, output: 0 }
const failures: Failure[] = []
const completedSuites: string[] = []

function usageOf(artifact: { cases: Array<{ usage: { input: number; output: number } }> }) {
  return artifact.cases.reduce(
    (total, testCase) => ({ input: total.input + testCase.usage.input, output: total.output + testCase.usage.output }),
    { input: 0, output: 0 },
  )
}

async function report(suite: string, artifact: object, suiteFailures: Failure[]) {
  await writeLiveArtifact(
    { artifactDirectory },
    suite,
    Object.assign(artifact, { status: suiteFailures.length === 0 ? "passed" : "failed", failures: suiteFailures }),
  )
  failures.push(...suiteFailures.map((failure) => ({ ...failure, message: `${suite}: ${failure.message}` })))
  if (suiteFailures.length === 0) completedSuites.push(suite)
}

// --- Suite A: manual chain + knowledge_propose (read-only surface) -----------------------------

if (!only || "v2-01-manual-chain".startsWith(only)) {
  const artifact = await runLegacyLiveCases({
    suite: "v2-01-manual-chain",
    // Allows must live at BOTH levels: the V2 materialize gate (isActionWhollyDenied) vetoes an
    // action when ANY ruleset's last matching rule is a wildcard deny, and the top-level config
    // permission migrates into the global ruleset appended to every agent — agent-level allows
    // alone did not survive that composition in the first run (pack_search came back "Unknown tool").
    permission: {
      "*": "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
      capability_search: "allow",
      "capability.read": "allow",
      knowledge_propose: "allow",
    },
    primaryPermission: {
      "*": "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
      capability_search: "allow",
      "capability.read": "allow",
      knowledge_propose: "allow",
    },
    cases: [
      {
        name: "manual-chain",
        prompt: [
          "Answer this question about the DeepAgent Code system: where do a write-type subagent's file changes live",
          "before they are merged into the parent branch?",
          "First call pack_search exactly once with a query about subagent worktree branches.",
          "Then call domain_pack_load exactly once for the most relevant card from the search result.",
          "Then answer the question in one or two sentences from the loaded document.",
        ].join("\n"),
      },
      {
        name: "knowledge-propose",
        prompt: [
          "Call knowledge_propose exactly once to remember this project fact for future sessions:",
          "This project deploys via the aly server.",
          'Use type memory, description "Deployment via aly server", body "This project deploys via the aly server."',
          "Then confirm in one sentence what was staged.",
        ].join("\n"),
      },
    ],
  })
  totals.input += usageOf(artifact).input
  totals.output += usageOf(artifact).output
  const suiteFailures: Failure[] = []

  const manual = artifact.cases.find((testCase) => testCase.name === "manual-chain")
  if (!manual) {
    suiteFailures.push({ classification: "runtime", message: "missing manual-chain observation" })
  } else {
    const searches = manual.tools.filter((tool) => tool.name === "pack_search" && tool.status === "completed")
    const loads = manual.tools.filter((tool) => tool.name === "domain_pack_load" && tool.status === "completed")
    if (searches.length !== 1) {
      suiteFailures.push({
        classification: "model-behavior",
        message: `expected one completed pack_search, received ${searches.length} (${manual.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")})`,
      })
    }
    if (searches[0] && (searches[0].output ?? "").trim().startsWith("No matching domain pack documents")) {
      suiteFailures.push({ classification: "runtime", message: "pack_search found no manual documents in the seeded store" })
    }
    if (loads.length < 1 || loads.length > 2) {
      suiteFailures.push({
        classification: loads.length < 1 ? "model-behavior" : "runtime",
        message: `expected 1-2 completed domain_pack_load, received ${loads.length}`,
      })
    }
    if (!/branch|worktree|pr_finalize|deepagent-code\/task/i.test(manual.finalText)) {
      suiteFailures.push({
        classification: "model-behavior",
        message: `final answer does not reflect the loaded manual: ${manual.finalText.slice(0, 200)}`,
      })
    }
  }

  const knowledge = artifact.cases.find((testCase) => testCase.name === "knowledge-propose")
  if (!knowledge) {
    suiteFailures.push({ classification: "runtime", message: "missing knowledge-propose observation" })
  } else {
    const proposes = knowledge.tools.filter((tool) => tool.name === "knowledge_propose" && tool.status === "completed")
    if (proposes.length !== 1) {
      suiteFailures.push({
        classification: "model-behavior",
        message: `expected one completed knowledge_propose, received ${proposes.length} (${knowledge.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")})`,
      })
    }
    if (proposes[0] && !(proposes[0].output ?? "").includes("Staged as a review candidate")) {
      suiteFailures.push({
        classification: "runtime",
        message: `knowledge_propose output is not a staged candidate: ${(proposes[0].output ?? "").slice(0, 200)}`,
      })
    }
  }
  await report("v2-01-manual-chain", artifact, suiteFailures)
}

// --- Suite B: B1 permission rejection feedback -------------------------------------------------

if (!only || "v2-01-permission-feedback".startsWith(only)) {
  const feedback = "Do not create new files. Add the helper to the existing src/utils.ts instead."
  const artifact = await runLegacyLiveCases({
    suite: "v2-01-permission-feedback",
    // Top-level must not wholly-deny edit/write: the write tool's materialize action is its own
    // name, and a wildcard deny here would filter the tool out entirely ("Unknown tool") instead
    // of reaching the ask -> reject-with-feedback path under test.
    permission: { "*": "deny", edit: "ask", write: "ask", read: "allow" },
    primaryPermission: { "*": "deny", edit: "ask", write: "ask", read: "allow" },
    permissionReply: { reply: "reject", message: feedback },
    files: { "src/utils.ts": "export const shout = (value: string) => value\n" },
    inspectFiles: ["src/new-helper.ts"],
    cases: [
      {
        name: "write-rejected-feedback",
        prompt: [
          "Call write exactly once to create src/new-helper.ts with this exact content:",
          "export const shout = (value: string) => value.toUpperCase()",
          "The permission operator will decide whether it runs and may attach feedback.",
          "After the real tool result, follow the operator's feedback if any, then state what happened in one or two sentences.",
          "Never claim success after an error.",
        ].join("\n"),
      },
    ],
  })
  totals.input += usageOf(artifact).input
  totals.output += usageOf(artifact).output
  const suiteFailures: Failure[] = []

  const rejected = artifact.cases[0]
  if (!rejected) {
    suiteFailures.push({ classification: "runtime", message: "missing write-rejected-feedback observation" })
  } else {
    const writes = rejected.tools.filter((tool) => tool.name === "write")
    if (writes.length !== 1 || writes[0]?.status !== "error") {
      suiteFailures.push({
        classification: "model-behavior",
        message: `expected exactly one errored write attempt, received ${rejected.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
      })
    }
    const writeError = writes[0]?.error ?? ""
    if (!writeError.includes("feedback") || !writeError.includes("src/utils.ts")) {
      suiteFailures.push({
        classification: "runtime",
        message: `operator feedback did not reach the model-visible error: ${writeError.slice(0, 240)}`,
      })
    }
    if (rejected.permissionRequests.length < 1) {
      suiteFailures.push({ classification: "runtime", message: "no permission request was recorded for the write attempt" })
    }
    if (artifact.workspace.files["src/new-helper.ts"] !== undefined || artifact.workspace.status.trim()) {
      suiteFailures.push({ classification: "runtime", message: "rejected write produced a filesystem side effect" })
    }
    if (!/reject|denied|not allowed|feedback|utils\.ts/i.test(rejected.finalText)) {
      suiteFailures.push({
        classification: "model-behavior",
        message: `model did not acknowledge the rejection: ${rejected.finalText.slice(0, 200)}`,
      })
    }
  }
  await report("v2-01-permission-feedback", artifact, suiteFailures)
}

// --- Suite C: WS4b delegation branch visibility ------------------------------------------------

if (!only || "v2-01-delegation".startsWith(only)) {
  const artifact = await runLegacyLiveCases({
    suite: "v2-01-delegation",
    // No top-level wildcard deny: inheritedTaskPermissions maps every non-allow parent rule to a
    // child-session deny, and the materialize some() veto would then disarm the write-type child
    // (no edit/write tools in its worktree). Allow-listed permissions keep the child functional,
    // matching the production posture where parents carry no blanket deny.
    permission: { read: "allow", task: "allow", task_status: "allow" },
    primaryPermission: { read: "allow", task: "allow", task_status: "allow" },
    inspectFiles: ["child-marker.txt"],
    evaluateWorkspace: async (directory) => {
      const branches = Bun.spawnSync(["git", "branch", "--list", "deepagent-code/task-*"], {
        cwd: directory,
        stdout: "pipe",
        stderr: "ignore",
      })
      return { taskBranches: branches.stdout.toString().trim() }
    },
    cases: [
      {
        name: "delegation-worktree",
        prompt: [
          "Call task exactly once in foreground mode with subagent_type general and description create marker file.",
          "The child prompt must be exactly: Create a file named child-marker.txt containing the single word bravo, then reply DONE.",
          "Do not create any file yourself.",
          "After task completes, report the branch line from the task result verbatim if one is present,",
          "and state whether the child worked on an isolated branch.",
        ].join("\n"),
      },
    ],
  })
  totals.input += usageOf(artifact).input
  totals.output += usageOf(artifact).output
  const suiteFailures: Failure[] = []

  const delegation = artifact.cases[0]
  if (!delegation) {
    suiteFailures.push({ classification: "runtime", message: "missing delegation-worktree observation" })
  } else {
    const tasks = delegation.tools.filter((tool) => tool.name === "task" && tool.status === "completed")
    if (tasks.length !== 1) {
      suiteFailures.push({
        classification: "model-behavior",
        message: `expected one completed task, received ${delegation.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
      })
    }
    if (delegation.children.length !== 1 || delegation.children[0]?.agent !== "general") {
      suiteFailures.push({
        classification: "runtime",
        message: `expected one general child Session, received ${delegation.children.map((child) => child.agent).join(", ") || "none"}`,
      })
    }
    const taskOutput = tasks[0]?.output ?? ""
    if (!taskOutput.includes("Write-type subagent output is on branch") || !taskOutput.includes("pr_finalize")) {
      suiteFailures.push({
        classification: "runtime",
        message: `write-type task result is missing the branch guidance line: ${taskOutput.slice(-300)}`,
      })
    }
    const branchMatch = taskOutput.match(/deepagent-code\/task-[A-Za-z0-9]+/)
    if (!branchMatch) {
      suiteFailures.push({ classification: "runtime", message: "task result does not name a deepagent-code/task-* branch" })
    }
    const evaluation = artifact.evaluation as { taskBranches?: string } | undefined
    if (branchMatch && !(evaluation?.taskBranches ?? "").includes(branchMatch[0])) {
      suiteFailures.push({
        classification: "runtime",
        message: `branch ${branchMatch[0]} is not retained in the parent repository: ${evaluation?.taskBranches ?? "no task branches"}`,
      })
    }
    if (artifact.workspace.files["child-marker.txt"] !== undefined) {
      suiteFailures.push({ classification: "runtime", message: "write-type subagent leaked its change into the parent checkout" })
    }
  }
  await report("v2-01-delegation", artifact, suiteFailures)
}

if (completedSuites.length === 0 && failures.length === 0) {
  failLiveScript(`v2-01-acceptance: no suite matched filter ${JSON.stringify(only)}`)
}
if (failures.length > 0) {
  failLiveScript(
    `v2-01-acceptance failed: ${failures.map((failure) => `${failure.classification}: ${failure.message}`).join("; ")}`,
  )
}
console.log(`v2-01-acceptance: passed (${completedSuites.join(", ")}; ${totals.input + totals.output} tokens)`)
finishLiveScript()
