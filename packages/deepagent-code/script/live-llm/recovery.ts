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
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  { ...artifact, status: "observed" },
)

const stale = requireCase("stale-edit")
// Provider-generic stale-edit contract: the model observes the file (read family), a stale
// edit attempt fails with the not-found error, and a later edit completes. Exact counts and
// ordering around the failure are model behavior.
const staleRead = stale.tools.some((tool) => ["read", "grep", "glob"].includes(tool.name) && tool.status === "completed")
const staleErrors = stale.tools.filter((tool) => tool.status === "error")
const staleEditCompletedAfterError = stale.tools.some(
  (tool, index) => tool.name === "edit" && tool.status === "completed" && stale.tools.slice(0, index).some((prior) => prior.status === "error"),
)
if (
  !staleRead ||
  staleErrors.length < 1 ||
  !staleErrors.some((tool) => tool.name === "edit" && tool.error?.includes("Could not find oldString")) ||
  !staleEditCompletedAfterError
) {
  throw new Error(
    `Stale edit recovery mismatch: ${stale.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}

const patch = requireCase("patch-rebuild")
// Provider-generic patch-recovery contract: every call is apply_patch_chunk, at least one
// attempt fails the patch-vs-file verification, at least one later attempt completes, and the
// final workspace applies only the valid transaction (asserted below). The exact call count
// and interleaving are model behavior.
const patchErrors = patch.tools.filter((tool) => tool.status === "error")
const patchCompletedAfterError = patch.tools.some(
  (tool, index) => tool.status === "completed" && patch.tools.slice(0, index).some((prior) => prior.status === "error"),
)
// V2-owner wording parity: the core apply pipeline surfaces the stale-line verification failure
// verbatim ("Failed to find expected lines in <path>: ...") instead of the legacy stack's
// "apply_patch verification failed: ..." prefix. Both name the same failed verification against
// the current file content; the workspace assertions below prove no partial application either way.
const patchVerificationFailure = (tool: (typeof patch.tools)[number]) =>
  tool.error?.includes("apply_patch verification failed") || tool.error?.includes("Failed to find expected lines")
if (
  patch.tools.length === 0 ||
  patch.tools.some((tool) => tool.name !== "apply_patch_chunk") ||
  patchErrors.length < 1 ||
  !patchCompletedAfterError ||
  !patchErrors.some(patchVerificationFailure)
) {
  throw new Error(`Patch recovery mismatch: ${patch.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`)
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
