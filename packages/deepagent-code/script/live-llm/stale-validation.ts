import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// Suite C2: stale-validation-not-reinjected. `extractValidationResults` re-scans the whole transcript every
// turn, so one genuine failure used to be re-harvested and re-recorded on every later turn: addCandidate
// appends unconditionally, so after N turns the candidate list held N copies of the SAME stale
// ValidationResult and collectValidationFailureText emitted that identical block N times. The model kept
// re-explaining an already-repaired failure instead of doing the new work it was asked for. The guard is the
// `validationFingerprint` comparison at src/session/llm/request.ts:542 (defined at :684, rationale at
// :531-546). The three cases run in ONE durable Session on purpose: round 3 is a brand new read-only task,
// so round 1's per-run error marker has no live source there.
//
// SCOPE HONESTY: the real symptom is duplication inside ASSEMBLED PROVIDER CONTEXT, which this harness
// cannot observe. Oracle 5 is therefore a proxy (marker leakage forward), and Oracle 4 (round-3 shell
// count) is recorded as evidence rather than asserted. See the comments at each oracle.
//
// The gateway that owns this state IS live here: DEEPAGENT_ENABLED=false only gates the core V2 stack
// (packages/core/src/location-layer.ts:48, consumed at :130), while the legacy path this suite exercises
// hardcodes `enabled: true` at packages/deepagent-code/src/deepagent/config.ts:44.
const successMarker = `stale-ok-${crypto.randomUUID()}`
const errorMarker = `stale-error-${crypto.randomUUID()}`
const readMarker = `stale-reference-${crypto.randomUUID()}`
const verifier = [
  "#!/bin/sh",
  'if [ "$(cat src/pipeline.txt)" = "mode=ready" ]; then',
  `  printf '%s\\n' '${successMarker}'`,
  "  exit 0",
  "fi",
  `printf '%s\\n' '${errorMarker}' >&2`,
  "exit 23",
  "",
].join("\n")
const validationCommand = "bun run verify"
const prompts = {
  fail: [
    `Run ${validationCommand} exactly once. It is expected to fail.`,
    "Report the real error text it printed. Do not repair anything yet and do not call any other tool.",
  ].join("\n"),
  repair: [
    "Now repair the failure: read src/pipeline.txt, edit its exact mode value from broken to ready,",
    `then run ${validationCommand} exactly once more. Report the success marker from that verifier result.`,
  ].join("\n"),
  // No "do not call bash" prohibition here on purpose. An explicit prohibition would make the round-3
  // shell count a measure of instruction-following rather than of stale-evidence re-injection.
  unrelated: [
    "New unrelated task. The earlier verification work is finished and closed; do not revisit or re-explain it.",
    "Read notes/reference.txt exactly once and report its exact reference code.",
  ].join("\n"),
}
const artifact = await runLegacyLiveCases({
  suite: "stale-validation-legacy",
  permission: {
    "*": "deny",
    bash: { "*": "deny", [validationCommand]: "allow" },
    read: { "*": "deny", "src/pipeline.txt": "allow", "notes/reference.txt": "allow" },
    edit: { "*": "deny", "src/pipeline.txt": "allow" },
  },
  cases: [
    { name: "fail", prompt: prompts.fail },
    { name: "repair", prompt: prompts.repair },
    { name: "unrelated", prompt: prompts.unrelated },
  ],
  files: { "src/pipeline.txt": "mode=broken\n", "notes/reference.txt": `reference=${readMarker}\n` },
  packageScripts: { verify: "./verify" },
  inspectFiles: ["src/pipeline.txt", "notes/reference.txt"],
  toolSandbox: { verifierScript: verifier, initialVerifier: "fail" },
  sharedSession: true,
  observeAssembledRequestFingerprints: true,
  // The runtime's default primary prompt says "do not add validation steps", which would pre-suppress the
  // re-validation this suite is trying to observe and would turn Oracle 4 into a tautology. Use a neutral
  // multi-round prompt instead so a re-injected stale failure is free to produce its original symptom.
  primaryPrompt:
    "This is a multi-round tool contract test in one durable Session. Treat each round on its own merits: " +
    "do the work the current round asks for, and do not redo work that an earlier round already completed.",
  modelMaxTokens: 1024,
})

// Oracle 6 (HARD): no marker may reach the model through a prompt. Every round is checked against every
// marker, so each oracle below can only be satisfied by real tool output.
if (
  Object.values(prompts).some((prompt) =>
    [successMarker, errorMarker, readMarker].some((marker) => prompt.includes(marker)),
  )
) {
  throw new Error("Stale-validation marker leaked into a prompt")
}
// Oracle 7 (HARD): Oracle 5 is only meaningful if round 3 really shares round 1's durable history.
if (new Set(artifact.cases.map((testCase) => testCase.sessionID)).size !== 1) {
  throw new Error("Stale-validation cases did not reuse one durable Session")
}
const failed = requireCase("fail")
const repaired = requireCase("repair")
const unrelated = requireCase("unrelated")

const requestFingerprints = (testCase: typeof failed) =>
  testCase.assembledRequestFingerprints.map((properties) => record(properties, "assembled request fingerprint"))
const validationState = (properties: Record<string, unknown>) => {
  const counts = record(properties.counts, "assembled request counts")
  const fingerprints = properties.validationFingerprints
  if (!Array.isArray(fingerprints)) throw new Error("Assembled request validation fingerprints are missing")
  return {
    validations: integer(counts.validations, "validation count"),
    duplicates: integer(counts.validationDuplicates, "validation duplicate count"),
    fingerprints: fingerprints.map((item) => {
      const entry = record(item, "validation fingerprint")
      return {
        fingerprint: nonEmptyString(entry.fingerprint, "validation fingerprint value"),
        count: integer(entry.count, "fingerprint count"),
      }
    }),
  }
}
const failedValidation = validationState(requireLast(requestFingerprints(failed), "fail request fingerprint"))
const repairedValidation = validationState(requireLast(requestFingerprints(repaired), "repair request fingerprint"))
const unrelatedValidation = validationState(requireLast(requestFingerprints(unrelated), "unrelated request fingerprint"))
if (failedValidation.validations !== 1 || failedValidation.duplicates !== 0) {
  throw new Error("Round 1 did not assemble exactly one distinct failing validation result")
}
if (repairedValidation.validations !== 2 || repairedValidation.duplicates !== 0) {
  throw new Error("Round 2 did not assemble exactly the distinct fail and repair validation results")
}
if (unrelatedValidation.validations !== repairedValidation.validations || unrelatedValidation.duplicates !== 0) {
  throw new Error("Round 3 changed validation multiplicity without running another validation")
}
const repairedFingerprintCounts = new Map(
  repairedValidation.fingerprints.map((item) => [item.fingerprint, item.count] as const),
)
if (
  unrelatedValidation.fingerprints.some(
    (item) => item.count !== 1 || repairedFingerprintCounts.get(item.fingerprint) !== item.count,
  )
) {
  throw new Error("A stale validation fingerprint was duplicated or replaced in the unrelated round")
}

// Oracle 1 (HARD): round 1 produced a real, nonzero validation failure — the evidence whose re-injection
// this suite is about. Without a genuine failure at t0 there is nothing for a later round to inherit.
const failedShell = failed.newTools.find((tool) => tool.name === "bash" && tool.status === "completed")
const failedExit = record(failedShell?.metadata, "failing Bash metadata").exit
if (typeof failedExit !== "number" || failedExit === 0 || !failedShell?.output?.includes(errorMarker)) {
  throw new Error(`Round 1 did not record a real failing validation: exit ${JSON.stringify(failedExit)}`)
}

// Oracle 2 (HARD): round 2 repaired it for real — hidden verifier exit 0 plus byte-exact bytes on disk.
// This is also what makes Oracle 5 sound: after this point the verifier can no longer emit errorMarker.
const repairedShell = repaired.newTools.findLast((tool) => tool.name === "bash" && tool.status === "completed")
const repairedExit = record(repairedShell?.metadata, "repairing Bash metadata").exit
if (repairedExit !== 0 || !repairedShell?.output?.includes(successMarker)) {
  throw new Error(`Round 2 did not record a passing validation after the repair: exit ${JSON.stringify(repairedExit)}`)
}
if (artifact.workspace.files["src/pipeline.txt"] !== "mode=ready\n") {
  throw new Error("Round 2 did not persist the exact source repair")
}

// Oracle 3 (HARD): round 3 did the NEW work it was asked for. This is the load-bearing "did not get stuck
// re-litigating the old failure" check now that Oracle 4 no longer throws — a model trapped in the original
// symptom never reaches the new file at all.
const reference = unrelated.newTools.find((tool) => tool.name === "read" && tool.status === "completed")
if (!reference?.output?.includes(readMarker) || !unrelated.finalText.includes(readMarker)) {
  throw new Error("Round 3 did not complete the unrelated read task from real file content")
}

// Oracle 4 (EVIDENCE, deliberately not an assertion): round 3's shell count. Re-running the verifier
// during an unrelated task is the shape of the original symptom, but with the prohibition removed from the
// prompt an innocent re-verify is ordinary model variance, not proof of re-injection. Throwing here would
// manufacture false failures, so this is measured into `evidence.bashCallsPerCase` and left to review.
const unrelatedShells = unrelated.newTools.filter((tool) => tool.name === "bash")

// Oracle 5 (HARD, and a PROXY — the one anti-regression assertion in this suite). The documented symptom
// lives at src/session/llm/request.ts:531-546 (STALE-REHARVEST GUARD): extractValidationResults re-scans
// the whole transcript every turn, and without the `validationFingerprint` comparison at :542 (defined at
// :684) each turn re-ran recordValidation → processValidationResults → addCandidate, which appends
// unconditionally. After N turns the candidate list held N copies of the SAME stale ValidationResult and
// collectValidationFailureText emitted that identical block N times into ASSEMBLED CONTEXT. This harness
// cannot observe assembled context, so it cannot assert on that block directly — hence a proxy: the error
// marker is minted per run and is only ever reachable through round 1's verifier stderr, so its appearance
// in round 3's answer means round 1's failure was replayed forward rather than deduplicated.
// This stays valid even if round 3 does re-run the verifier: src/pipeline.txt is already repaired by then,
// so a fresh run prints successMarker and exits 0. errorMarker has no live source in round 3.
const errorMarkerInUnrelatedFinalText = unrelated.finalText.includes(errorMarker)
const errorMarkerInUnrelatedTools = JSON.stringify(unrelated.newTools).includes(errorMarker)
if (errorMarkerInUnrelatedFinalText || errorMarkerInUnrelatedTools) {
  throw new Error(
    "Round 3 surfaced round 1's failure marker, so stale validation evidence survived into a later round " +
      "(src/session/llm/request.ts:531-546 STALE-REHARVEST GUARD / validationFingerprint at :542)",
  )
}

// Oracle 8 (HARD): the run must have executed inside the qualified sandbox, otherwise the hidden verifier is
// writable/reachable and stops being an oracle at all.
if (!artifact.sandbox?.networkDenied || !artifact.sandbox.verifierWriteDenied) {
  throw new Error("Stale-validation regression ran without a qualified sandbox")
}

// Classified LIVE+DET/P0 in docs/llmrealtest-v2.md, so the artifact keeps the runtime's "live" mode.
const result = {
  ...artifact,
  evidence: {
    errorMarkerHash: Bun.hash(errorMarker).toString(16),
    successMarkerHash: Bun.hash(successMarker).toString(16),
    readMarkerHash: Bun.hash(readMarker).toString(16),
    distinctSessionIDs: new Set(artifact.cases.map((testCase) => testCase.sessionID)).size,
    failingExitCode: failedExit,
    repairedExitCode: repairedExit,
    // Oracle 4 lives here rather than in an assertion: measured, reviewable, never thrown on.
    bashCallsPerCase: Object.fromEntries(
      artifact.cases.map((testCase) => [
        testCase.name,
        testCase.newTools.filter((tool) => tool.name === "bash").length,
      ]),
    ),
    unrelatedBashCalls: unrelatedShells.length,
    errorMarkerInUnrelatedFinalText,
    errorMarkerInUnrelatedTools,
    unrelatedToolSequence: unrelated.newTools.map((tool) => `${tool.name}:${tool.status}`),
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

function requireLast<T>(items: readonly T[], name: string): T {
  const item = items.at(-1)
  if (item === undefined) throw new Error(`Missing ${name}`)
  return item
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`)
  return value
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is invalid`)
  return value
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

function requireCase(name: string) {
  const testCase = artifact.cases.find((item) => item.name === name)
  if (!testCase) throw new Error(`Missing stale-validation case ${name}`)
  return testCase
}

finishLiveScript()
