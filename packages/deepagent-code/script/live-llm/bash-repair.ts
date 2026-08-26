import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const successMarker = `legacy-bash-ok-${crypto.randomUUID()}`
const errorMarker = `legacy-bash-error-${crypto.randomUUID()}`
const verifier = [
  "#!/bin/sh",
  'if [ "$(cat src/state.txt)" = "state=ready" ]; then',
  `  printf '%s\\n' '${successMarker}'`,
  "  exit 0",
  "fi",
  `printf '%s\\n' '${errorMarker}' >&2`,
  "exit 17",
  "",
].join("\n")
const prompt =
  "Run ./verify exactly. It must fail first. Then read src/state.txt, edit its exact state value from broken to ready, " +
  "and run ./verify exactly again. Reply with the success marker from the second verifier result."
const artifact = await runLegacyLiveCases({
  suite: "bash-repair-legacy",
  permission: {
    "*": "deny",
    bash: { "*": "deny", "./verify": "allow" },
    read: { "*": "deny", "src/state.txt": "allow" },
    edit: { "*": "deny", "src/state.txt": "allow" },
  },
  cases: [{ name: "repair", prompt }],
  files: { "src/state.txt": "state=broken\n" },
  inspectFiles: ["src/state.txt"],
  toolSandbox: { verifierScript: verifier },
})

const repair = artifact.cases[0]
if (!repair) throw new Error("Missing legacy Bash repair observation")
const completed = repair.tools.filter((tool) => tool.status === "completed")
if (
  completed.length !== 4 ||
  completed.some((tool, index) => tool.name !== ["bash", "read", "edit", "bash"][index])
) {
  throw new Error(`Unexpected Bash repair sequence: ${repair.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`)
}
const first = record(completed[0]?.metadata, "first Bash metadata")
const second = record(completed[3]?.metadata, "second Bash metadata")
if (first.exit !== 17 || typeof completed[0]?.output !== "string" || !completed[0].output.includes(errorMarker)) {
  throw new Error("First legacy verifier result did not preserve stderr and exit code 17")
}
if (second.exit !== 0 || typeof completed[3]?.output !== "string" || !completed[3].output.includes(successMarker)) {
  throw new Error("Second legacy verifier result did not preserve stdout and exit code 0")
}
if (artifact.workspace.files["src/state.txt"] !== "state=ready\n") {
  throw new Error("Legacy Bash repair did not persist the exact source fix")
}
if (prompt.includes(successMarker)) throw new Error("Legacy verifier marker leaked into the prompt")
if (!artifact.sandbox?.networkDenied || !artifact.sandbox.verifierWriteDenied) {
  throw new Error("Legacy Bash repair ran without a qualified sandbox")
}
const changedPaths = artifact.workspace.status
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => line.slice(3))
if (changedPaths.length !== 1 || changedPaths[0] !== "src/state.txt") {
  throw new Error(`Legacy Bash repair mutation allowlist mismatch: ${changedPaths.join(", ")}`)
}

const result = {
  ...artifact,
  evidence: {
    firstExitCode: first.exit,
    secondExitCode: second.exit,
    errorMarkerHash: Bun.hash(errorMarker).toString(16),
    successMarkerHash: Bun.hash(successMarker).toString(16),
    finalTextLength: repair.finalText.length,
    changedPaths,
    rejectedToolCalls: repair.tools.filter((tool) => tool.status === "error").map((tool) => tool.name),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${repair.usage.input + repair.usage.output} tokens)`,
)

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

finishLiveScript()
