import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const marker = `headless-long-session-${crypto.randomUUID()}`
const prompts = {
  evidence:
    "Read memory.txt exactly once and report its exact content as the release proof. Do not call other tools.",
  context:
    "Remember that the exact release proof from the initial file is the only durable fact needed later. Acknowledge briefly without calling tools.",
  interrupt:
    "Call question exactly once to ask whether the retained release proof should be reported, with one Continue option. Wait for the answer and do not call other tools.",
  continue:
    "Continue after the interruption. Without calling any tool, report the exact release proof retained from before compaction.",
}
const artifact = await runLegacyLiveCases({
  suite: "long-session-legacy",
  permission: {
    "*": "deny",
    read: { "*": "deny", "memory.txt": "allow" },
    question: "allow",
  },
  cases: [
    { name: "evidence", prompt: prompts.evidence },
    { name: "pre-compaction", prompt: prompts.context },
    { name: "interrupted", prompt: prompts.interrupt },
    { name: "continued", prompt: prompts.continue },
  ],
  files: { "memory.txt": `${marker}\n` },
  questionAction: { type: "abort" },
  sharedSession: true,
  compactAfterCases: ["pre-compaction"],
  modelMaxTokens: 1024,
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
)

if (Object.values(prompts).some((prompt) => prompt.includes(marker))) {
  throw new Error("Long-session marker leaked into a prompt")
}
if (new Set(artifact.cases.map((testCase) => testCase.sessionID)).size !== 1) {
  throw new Error("Long-session cases did not reuse one durable Session")
}
const evidence = requireCase("evidence")
const compacted = requireCase("pre-compaction")
const interrupted = requireCase("interrupted")
const continued = requireCase("continued")
const read = evidence.newTools.find((tool) => tool.name === "read" && tool.status === "completed")
if (!read?.output?.includes(marker) || !evidence.finalText.includes(marker)) {
  throw new Error("Initial headless Session did not persist file-only evidence")
}
if (compacted.compactionCount < 1 || !compacted.compactionTexts.some((text) => text.includes(marker))) {
  throw new Error("Manual compaction did not preserve the release proof")
}
const question = interrupted.newTools.find((tool) => tool.name === "question")
if (question?.status !== "error" || interrupted.questionRequests[0]?.latch?.type !== "abort") {
  throw new Error("Headless Session interruption did not terminate a pending Question")
}
if (continued.newTools.length !== 0 || !continued.finalText.includes(marker)) {
  throw new Error("Post-interruption continuation did not use compacted evidence without tools")
}
if (
  artifact.cases.some(
    (testCase) =>
      testCase.permissionRequests.length > 0 ||
      testCase.models.some(
        (model) => model.providerID !== "live-deepseek" || model.modelID !== artifact.fingerprint.modelID,
      ),
  )
) {
  throw new Error("Long-session run required permission interaction or persisted the wrong model identity")
}

const result = {
  ...artifact,
  mode: "ext",
  evidence: {
    markerHash: Bun.hash(marker).toString(16),
    sharedSession: true,
    manualCompactionPersisted: true,
    interruptedTerminalObserved: true,
    continuationUsedNoTools: true,
    permissionRequests: 0,
    humanReplies: 0,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${continued.usage.input + continued.usage.output} cumulative tokens)`,
)

function requireCase(name: string) {
  const testCase = artifact.cases.find((item) => item.name === name)
  if (!testCase) throw new Error(`Missing long-session case ${name}`)
  return testCase
}

finishLiveScript()
