import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// Internal intelligence-draft contract. This intentionally covers SessionPrompt's persisted
// refineIntelligenceDraft → confirmed_draft_id → prompt seam; it is not the E1 CLI/DeepAgent entry
// contract, which requires a real `deepagent-code run` subprocess with DEEPAGENT_ENABLED=true.

const userPrompt = [
  "Analyze the codebase structure and suggest an improvement plan.",
  "Consider architectural patterns, code organization, and potential refactorings.",
].join("\n")

const artifact = await runLegacyLiveCases({
  suite: "intelligence-draft-confirmation-legacy",
  permission: { "*": "deny", read: "allow" },
  files: {
    "main.ts": [
      "// Main application entry",
      "function main() {",
      "  console.log('Hello');",
      "  processData();",
      "  cleanup();",
      "}",
      "function processData() { /* ... */ }",
      "function cleanup() { /* ... */ }",
    ].join("\n"),
    "README.md": "# Sample Project\n\nA simple TypeScript application.",
  },
  cases: [{ name: "intelligence-pipeline", prompt: userPrompt, intelligence: { outputLanguage: "english" } }],
  modelMaxTokens: 1024,
  maxProviderTurns: 16,
})

const observation = artifact.cases[0]
assert(observation, "intelligence-draft-confirmation produced no observation")

// Oracle 1: prompt_prepare must have made a real, persisted, confirmable code draft.
const draft = observation.intelligenceDraft
assert(draft?.route === "code", `expected a code intelligence draft, got ${draft?.route ?? "none"}`)
assert(draft.prompt_draft_id.startsWith("prompt_draft:"), "prompt_prepare did not return a persisted draft id")
assert(draft.preview.length > userPrompt.length, "intelligence draft did not expand the raw request")

// Oracle 2: prompt submission must have confirmed that exact draft and replaced the raw prompt.
const submitted = observation.users[0]
assert(submitted, "confirmed intelligence prompt did not create a user message")
const pipeline = submitted.metadata?.deepagent?.prompt_pipeline
assert(pipeline?.confirmed === true, "submitted intelligence draft was not marked confirmed")
assert(pipeline.prompt_draft_id === draft.prompt_draft_id, "submitted prompt used a different intelligence draft")
assert(submitted.text !== userPrompt, "confirmed draft did not replace the raw prompt")

// Oracle 3: the executed refined draft must inspect the fixture rather than only describe a plan.
const readTools = observation.tools.filter((tool) => tool.name === "read" && tool.status === "completed")
assert(readTools.length >= 1, `expected at least 1 read tool execution, got ${readTools.length}`)

// Oracle 4: the execution following the separate refinement model call must complete with a plan.
const coordinatorText = observation.finalText.toLowerCase()
assert(observation.assistantTurns >= 1, "confirmed intelligence draft did not execute")
assert(
  coordinatorText.includes("analysis") ||
    coordinatorText.includes("plan") ||
    coordinatorText.includes("suggest") ||
    coordinatorText.includes("refactor"),
  "final response did not contain expected analysis/plan keywords",
)

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    promptDraftID: draft.prompt_draft_id,
    contextPlanID: draft.context_plan_id,
    confirmed: pipeline.confirmed,
    submittedPromptLength: submitted.text.length,
    readToolCount: readTools.length,
    assistantTurns: observation.assistantTurns,
    coordinatorTextLength: observation.finalText.length,
    toolSequence: observation.tools.map((tool) => `${tool.name}:${tool.status}`).join(","),
  },
}

await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${observation.usage.input + observation.usage.output} tokens, ${observation.assistantTurns} turns)`,
)

finishLiveScript()

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
