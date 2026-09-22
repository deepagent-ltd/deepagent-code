import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// A1-06 (design §4.7 code-intel scenarios): live contract for the canonical V2 context tools
// code_intel / context_query, served through the Core ContextToolRuntime seam that
// script/live-llm/runner-frame.ts now wires into the harness the same way production does
// (src/session/v2-runner-frame.ts). Both cases assert the tool completed through that seam: the
// V2 runtime always answers with the contract JSON envelope (schemaVersion 2 for code_intel,
// schemaVersion 1 for context_query), and a REAL result carries no `error` field — the
// unavailable stub does, so these assertions fail if the seam ever regresses to it.
const artifact = await runLegacyLiveCases({
  suite: "code-intel-context-tools-v2",
  permission: { "*": "deny" },
  primaryPermission: { "*": "deny", code_intel: "allow", context_query: "allow" },
  files: {
    "src/evidence.ts": [
      "export const codeIntelSentinel = 'v2-context-tool-evidence'",
      "export function describeSentinel() {",
      "  return codeIntelSentinel",
      "}",
      "",
    ].join("\n"),
  },
  cases: [
    {
      name: "code-intel-outline",
      prompt: [
        "Call code_intel exactly once with intent outline and file src/evidence.ts.",
        "Do not call another tool. Report the tool's JSON result, including the symbols it lists.",
      ].join("\n"),
    },
    {
      name: "context-query-search",
      prompt: [
        "Call context_query exactly once with intent search and query 'codeIntelSentinel'.",
        "Do not call another tool. Report the tool's JSON result verbatim, even when it is an honest empty result.",
      ].join("\n"),
    },
  ],
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  artifact.suite,
  artifact,
)

for (const testCase of artifact.cases) {
  if (testCase.providerErrors.length > 0) {
    throw new Error(`${testCase.name} hit provider errors: ${JSON.stringify(testCase.providerErrors)}`)
  }
  if (
    testCase.models.length === 0 ||
    testCase.models.some(
      (model) =>
        model.providerID !== artifact.fingerprint.runtimeProviderID || model.modelID !== artifact.fingerprint.modelID,
    )
  ) {
    throw new Error(`${testCase.name} persisted the wrong provider/model identity`)
  }
}

const outline = requireSeamResult(artifact, "code-intel-outline", "code_intel", 2)
if (!JSON.stringify(outline).includes("describeSentinel")) {
  throw new Error(`code-intel-outline lost the workspace symbol: ${JSON.stringify(outline).slice(0, 400)}`)
}
requireSeamResult(artifact, "context-query-search", "context_query", 1)

console.log(
  `${artifact.suite}: passed (${artifact.fingerprint.providerID}/${artifact.fingerprint.modelID}, ` +
    `${artifact.cases.reduce((total, testCase) => total + testCase.usage.input + testCase.usage.output, 0)} tokens)`,
)

finishLiveScript()

function requireSeamResult(
  live: { cases: Array<{ name: string; tools: Array<{ name: string; status: string; output?: string }> }> },
  caseName: string,
  toolName: string,
  schemaVersion: number,
) {
  const testCase = live.cases.find((candidate) => candidate.name === caseName)
  if (!testCase) throw new Error(`Missing code-intel case ${caseName}`)
  const completed = testCase.tools.filter((tool) => tool.status === "completed")
  if (completed.length !== 1 || completed[0]?.name !== toolName || testCase.tools.some((tool) => tool.status !== "completed")) {
    throw new Error(
      `${caseName} tool sequence mismatch: ${testCase.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
    )
  }
  const output: unknown = JSON.parse(completed[0]?.output ?? "")
  if (
    typeof output !== "object" ||
    output === null ||
    !("schemaVersion" in output) ||
    output.schemaVersion !== schemaVersion
  ) {
    throw new Error(`${caseName} did not return the V2 contract envelope: ${JSON.stringify(output).slice(0, 400)}`)
  }
  if ("error" in output) {
    throw new Error(`${caseName} returned the unavailable/degraded envelope: ${JSON.stringify(output).slice(0, 400)}`)
  }
  return output
}
