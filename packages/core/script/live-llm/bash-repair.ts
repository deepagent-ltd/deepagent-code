import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { runV2LiveCases } from "./runtime"

const successMarker = `bash-ok-${crypto.randomUUID()}`
const errorMarker = `bash-error-${crypto.randomUUID()}`
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
const artifact = await runV2LiveCases({
  suite: "bash-repair-v2",
  agents: {
    "bash-repair": {
      prompt:
        "Follow the repair procedure exactly. Treat nonzero exit codes and stderr as failure. Never claim success before the verifier exits with code 0.",
      permission: {
        "*": "deny",
        bash: { "*": "deny", "./verify": "allow" },
        read: { "*": "deny", "src/state.txt": "allow" },
        edit: { "*": "deny", "src/state.txt": "allow" },
      },
    },
  },
  cases: [{ name: "repair", agent: "bash-repair", prompt }],
  files: { "src/state.txt": "state=broken\n" },
  inspectFiles: ["src/state.txt"],
  toolSandbox: { verifierScript: verifier },
})

const repair = artifact.cases[0]
if (!repair) throw new Error("Missing V2 Bash repair observation")
const completed = repair.tools.filter((tool) => tool.status === "completed")
if (
  completed.length !== 4 ||
  completed.some((tool, index) => tool.name !== ["bash", "read", "edit", "bash"][index])
) {
  throw new Error(`Unexpected Bash repair sequence: ${repair.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`)
}
const first = record(completed[0]?.structured, "first Bash result")
const second = record(completed[3]?.structured, "second Bash result")
if (first.exitCode !== 17 || typeof first.output !== "string" || !first.output.includes(errorMarker)) {
  throw new Error("First V2 verifier result did not preserve stderr and exit code 17")
}
if (second.exitCode !== 0 || typeof second.output !== "string" || !second.output.includes(successMarker)) {
  throw new Error("Second V2 verifier result did not preserve stdout and exit code 0")
}
if (artifact.workspace.files["src/state.txt"] !== "state=ready\n") {
  throw new Error("V2 Bash repair did not persist the exact source fix")
}
if (prompt.includes(successMarker)) throw new Error("V2 verifier marker leaked into the prompt")
if (!artifact.sandbox?.networkDenied || !artifact.sandbox.verifierWriteDenied) {
  throw new Error("V2 Bash repair ran without a qualified sandbox")
}
const changedPaths = artifact.workspace.status
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => line.slice(3))
if (changedPaths.length !== 1 || changedPaths[0] !== "src/state.txt") {
  throw new Error(`V2 Bash repair mutation allowlist mismatch: ${changedPaths.join(", ")}`)
}

const result = {
  ...artifact,
  evidence: {
    firstExitCode: first.exitCode,
    secondExitCode: second.exitCode,
    errorMarkerHash: Bun.hash(errorMarker).toString(16),
    successMarkerHash: Bun.hash(successMarker).toString(16),
    finalTextLength: repair.finalText.length,
    changedPaths,
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
