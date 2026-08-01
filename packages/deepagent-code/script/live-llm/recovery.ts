import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const editMarker = `recovered-${crypto.randomUUID()}`
const invalidPatch = [
  "*** Begin Patch",
  "*** Update File: patch.txt",
  "@@",
  "-missing stale line",
  "+must not appear",
  "*** End Patch",
].join("\n")
const validPatch = [
  "*** Begin Patch",
  "*** Update File: patch.txt",
  "@@",
  "-state=old",
  "+state=recovered",
  "*** End Patch",
].join("\n")
const artifact = await runLegacyLiveCases({
  suite: "failure-recovery-legacy",
  permission: {
    "*": "deny",
    read: { "*": "deny", "stale.txt": "allow" },
    edit: { "*": "deny", "stale.txt": "allow", "patch.txt": "allow" },
    apply_patch_chunk: "allow",
  },
  files: {
    "stale.txt": "header\nstate=current\nneighbor=unchanged\n",
    "patch.txt": "state=old\nneighbor=unchanged\n",
  },
  inspectFiles: ["stale.txt", "patch.txt"],
  cases: [
    {
      name: "stale-edit",
      prompt: [
        "Read stale.txt exactly once, then call edit with oldString exactly 'state=stale' and newString exactly 'state=wrong'.",
        "That edit must fail because the old text is stale. After the real error, recover using the current content from the read.",
        `Call edit with the exact current oldString 'state=current' and newString 'state=${editMarker}'.`,
        "Do not use write, patch, or bash. Report recovery only after the second edit completes.",
      ].join("\n"),
    },
    {
      name: "patch-rebuild",
      prompt: [
        `Start apply_patch_chunk with action begin, offset 0, and patchText exactly ${JSON.stringify(invalidPatch)}.`,
        "Commit it with the returned transactionID and nextOffset. It must fail and must not modify the file.",
        `Then start a new transaction with action begin, offset 0, and patchText exactly ${JSON.stringify(validPatch)}.`,
        "Commit the new transaction with its returned transactionID and nextOffset. Do not use another tool.",
      ].join("\n"),
    },
  ],
  primaryPrompt:
    "This suite verifies recovery from real tool errors. Follow every requested attempt in order, inspect actual error results, and never skip an intentionally failing first attempt.",
})

const stale = requireCase("stale-edit")
if (
  stale.tools.length !== 3 ||
  stale.tools[0]?.name !== "read" ||
  stale.tools[0].status !== "completed" ||
  stale.tools[1]?.name !== "edit" ||
  stale.tools[1].status !== "error" ||
  !stale.tools[1].error?.includes("Could not find oldString") ||
  stale.tools[2]?.name !== "edit" ||
  stale.tools[2].status !== "completed"
) {
  throw new Error(
    `Stale edit recovery mismatch: ${stale.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}

const patch = requireCase("patch-rebuild")
if (
  patch.tools.length !== 4 ||
  patch.tools.some((tool) => tool.name !== "apply_patch_chunk") ||
  patch.tools.map((tool) => tool.status).join(",") !== "completed,error,completed,completed"
) {
  throw new Error(`Patch recovery mismatch: ${patch.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`)
}
if (!patch.tools[1]?.error?.includes("apply_patch verification failed")) {
  throw new Error("Invalid patch did not produce the expected validation error")
}
if (artifact.workspace.files["stale.txt"] !== `header\nstate=${editMarker}\nneighbor=unchanged\n`) {
  throw new Error("Stale edit recovery did not preserve exact file content")
}
if (artifact.workspace.files["patch.txt"] !== "state=recovered\nneighbor=unchanged\n") {
  throw new Error("Patch rebuild did not apply only the valid transaction")
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    editMarkerHash: Bun.hash(editMarker).toString(16),
    staleSequence: stale.tools.map((tool) => `${tool.name}:${tool.status}`),
    patchSequence: patch.tools.map((tool) => `${tool.name}:${tool.status}`),
    changedPaths: artifact.workspace.status
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.slice(3)),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${result.cases.reduce((total, testCase) => total + testCase.usage.input + testCase.usage.output, 0)} tokens)`,
)

function requireCase(name: string) {
  const testCase = artifact.cases.find((value) => value.name === name)
  if (!testCase) throw new Error(`Missing recovery case ${name}`)
  return testCase
}

finishLiveScript()
