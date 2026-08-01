import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const marker = `narrow-${crypto.randomUUID()}`
const verifier = [
  "#!/bin/sh",
  'if [ "${1-}" = narrow ]; then',
  `  printf '%s\\n' '${marker}'`,
  "  exit 0",
  "fi",
  "i=0",
  'while [ "$i" -lt 200 ]; do',
  "  printf 'noise-%04d-xxxxxxxxxxxxxxxxxxxxxxxx\\n' \"$i\"",
  "  i=$((i + 1))",
  "done",
  "printf '%s\\n' 'diagnostic: rerun ./verify narrow'",
  "",
].join("\n")
const artifact = await runLegacyLiveCases({
  suite: "bash-truncation-legacy",
  permission: { "*": "deny", bash: { "*": "deny", "./verify": "allow", "./verify narrow": "allow" } },
  cases: [
    {
      name: "narrow-after-truncation",
      prompt: [
        "Run ./verify exactly once. Its output is intentionally too large and must be reported as truncated.",
        "After reading the real truncation result, run ./verify narrow exactly once.",
        "Do not call any other tool. Report the marker from the narrower command.",
      ].join("\n"),
    },
  ],
  toolSandbox: { verifierScript: verifier },
  toolOutput: { max_bytes: 2_048, max_lines: 100 },
})

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing Bash truncation observation")
if (
  observation.tools.length !== 2 ||
  observation.tools.some((tool) => tool.name !== "bash" || tool.status !== "completed")
) {
  throw new Error(
    `Bash truncation sequence mismatch: ${observation.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}
const first = record(observation.tools[0]?.metadata, "first Bash metadata")
const second = record(observation.tools[1]?.metadata, "second Bash metadata")
if (first.truncated !== true || typeof first.outputPath !== "string") {
  throw new Error(`First Bash result did not persist truncation metadata and an output path: ${JSON.stringify(first)}`)
}
if (!observation.tools[0]?.output?.includes("output truncated")) {
  throw new Error("Model-visible Bash result omitted the truncation warning")
}
if (second.exit !== 0 || !observation.tools[1]?.output?.includes(marker) || !observation.finalText.includes(marker)) {
  throw new Error("Narrow Bash diagnostic did not survive continuation")
}
if (observation.tools[1] && record(observation.tools[1].input, "second Bash input").command !== "./verify narrow") {
  throw new Error("Model did not use the requested narrower verifier command")
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    markerHash: Bun.hash(marker).toString(16),
    firstTruncated: first.truncated,
    outputPathRecorded: typeof first.outputPath === "string",
    secondExitCode: second.exit,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${observation.usage.input + observation.usage.output} tokens)`,
)

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

finishLiveScript()
