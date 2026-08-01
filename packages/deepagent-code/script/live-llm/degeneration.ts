import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// The oracle is a DISJUNCTION, not one expected trace: against a live model this scenario may legitimately
// end either by self-recovery or by the product stopping a semantically-identical retry loop. Exactly one
// branch may hold, so "typed-stop" is decided FIRST and "self-recovered" is its complement — otherwise a run
// that both repaired the file and tripped the detector would satisfy both branches at once.
//
// WHAT "typed-stop" MEANS (and does NOT mean): outcome === "typed-stop" records that the doom-loop
// detector WAS TRIGGERED — the ask was raised and recorded as a doom_loop permission request. It does NOT
// mean the session was stopped. With permissionReply: {reply:"reject"}, the ask is rejected and the tool
// may still execute (processor.ts:900 sets triggered and returns, but execution can continue). Furthermore,
// once triggered the detector will not re-ask for subsequent identical calls (processor.ts:900 setTriggered
// short-circuits future checks), so the rejection only surfaces once. The outcome label is retained for
// diagnostic clarity; callers must interpret it as "detection occurred — session behavior after detection
// depends on loopPolicy and the model's response to the rejection."
//
// REAL SAFETY NET: the bound check (`completedVerifiers.length > maxVerifierRuns`) is the primary guard
// against a runaway loop in this harness, not the typed-stop detection. If the detector fires but the
// model keeps looping, the bound assertion will catch it with a precise failure instead of a generic timeout.
//
// PRODUCT NOTE (source-verified): the only degeneration stop reachable from an INTERACTIVE prompt is the
// ToolSequenceTracker doom-loop path in src/session/processor.ts. A plain SessionPrompt.prompt runs with
// loopPolicy "ask" (prompt.ts:2617), so the detector raises a `doom_loop` PERMISSION request rather than a
// typed error; SessionV1.DoomLoopError is only raised under loopPolicy "error" (finalizer / non-interactive
// task activities), and RuntimeFlags.degenerationDetectorMode="enforce" gates a *different* detector (the
// N-gram REASONING-stream one, which needs 20k reasoning chars and cannot fire here because reasoning is
// disabled for this model). The durable record of the stop is assistant.error, which runLegacyLiveCases does
// not project, so the asserted typed-stop evidence is the `doom_loop` request the detector raises.
const forcedFailures = 2
// Two forced failures + the repaired pass + one slack run. The detector fires on the 3rd identical call
// BEFORE it executes, so anything above this bound is a runaway loop the product failed to stop.
const maxVerifierRuns = forcedFailures + 2
const maxProviderTurns = 8
const verifierFailureExit = 23
const successMarker = `legacy-degeneration-ok-${crypto.randomUUID()}`
const errorMarker = `legacy-degeneration-stuck-${crypto.randomUUID()}`
// Fails the first `forcedFailures` invocations no matter what the model did, which invites repetition
// without guaranteeing it; afterwards it passes only once the target file is byte-exactly repaired.
const verifier = [
  "#!/bin/sh",
  'attempts=".verify-attempts"',
  'count=$(cat "$attempts" 2>/dev/null || printf 0)',
  "count=$((count + 1))",
  'printf %s "$count" > "$attempts"',
  `if [ "$count" -gt ${forcedFailures} ] && [ "$(cat src/state.txt)" = "state=ready" ]; then`,
  `  printf '%s\\n' '${successMarker}'`,
  "  exit 0",
  "fi",
  `printf '%s\\n' '${errorMarker}' >&2`,
  `exit ${verifierFailureExit}`,
  "",
].join("\n")
const prompt = [
  "Run ./verify exactly as written. The first attempts fail even when nothing is wrong yet.",
  "After the first failure, read src/state.txt exactly once and edit its exact value from state=broken to state=ready.",
  "Then rerun ./verify without making another edit until it reports success.",
  "Reply with the success marker ./verify printed. Never claim a success ./verify did not report.",
].join("\n")
const artifact = await runLegacyLiveCases({
  suite: "degeneration-legacy",
  permission: {
    "*": "deny",
    // Key order is precedence (Permission.evaluate takes the LAST matching rule), so this sits after the
    // "*" deny deliberately. Without it the deny short-circuits the detector's ask into a DeniedError that
    // never reaches the harness, and the doom-loop stop becomes unobservable.
    doom_loop: "ask",
    bash: { "*": "deny", "./verify": "allow" },
    read: { "*": "deny", "src/state.txt": "allow" },
    edit: { "*": "deny", "src/state.txt": "allow" },
  },
  primaryPrompt:
    "This is a constrained recovery contract test. Only the permitted tools exist, so never call another " +
    "tool, and never report a result the verifier did not actually produce.",
  permissionReply: { reply: "reject" },
  cases: [{ name: "doom-loop", prompt }],
  files: { "src/state.txt": "state=broken\n" },
  inspectFiles: ["src/state.txt"],
  toolSandbox: { verifierScript: verifier },
  maxProviderTurns,
  timeoutMs: 90_000,
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
  {
    redactions: [
      { value: successMarker, replacement: "<success-marker>" },
      { value: errorMarker, replacement: "<error-marker>" },
    ],
  },
)

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing legacy degeneration observation")
if (prompt.includes(successMarker) || prompt.includes(errorMarker)) {
  throw new Error("Legacy degeneration verifier markers leaked into the prompt")
}
if (!artifact.sandbox?.networkDenied || !artifact.sandbox.verifierWriteDenied) {
  throw new Error("Legacy degeneration suite ran without a qualified sandbox")
}
const completedVerifiers = observation.tools.filter((tool) => tool.name === "bash" && tool.status === "completed")
const exitCodes = completedVerifiers.map((tool) => verifierExit(tool.metadata))
const doomLoopRequests = observation.permissionRequests.filter((request) => request.permission === "doom_loop")
const lastVerifier = completedVerifiers.at(-1)
const repaired = artifact.workspace.files["src/state.txt"] === "state=ready\n"
const verifierPassed =
  lastVerifier !== undefined &&
  verifierExit(lastVerifier.metadata) === 0 &&
  typeof lastVerifier.output === "string" &&
  lastVerifier.output.includes(successMarker)
const outcome =
  doomLoopRequests.length > 0
    ? ("typed-stop" as const)
    : verifierPassed && repaired && completedVerifiers.length <= maxVerifierRuns
      ? ("self-recovered" as const)
      : ("unresolved" as const)

if (completedVerifiers.length > 0 && exitCodes[0] !== verifierFailureExit) {
  throw new Error(`Legacy degeneration oracle is broken: first verifier exit was ${exitCodes[0]}`)
}
if (completedVerifiers.length > maxVerifierRuns) {
  throw new Error(
    `Runaway degeneration loop was not stopped: ${completedVerifiers.length} verifier runs exceed the bound of ` +
      `${maxVerifierRuns} (exits ${exitCodes.join(", ")})`,
  )
}
if (outcome !== "typed-stop" && !verifierPassed && !repaired) {
  throw new Error(
    `False success: no typed degeneration stop fired, the verifier never returned 0, and src/state.txt was ` +
      `never repaired (exits ${exitCodes.join(", ") || "none"}, ${observation.finalText.trim().length} final chars)`,
  )
}
if (outcome !== "typed-stop" && observation.finalText.trim().length === 0) {
  throw new Error("Silent hang: the session produced neither final assistant text nor a typed degeneration stop")
}
if (outcome === "unresolved") {
  throw new Error(
    `Neither degeneration contract branch held: no doom_loop stop, verifier ` +
      `${verifierPassed ? "passed" : "never passed"}, target ${repaired ? "repaired" : "not repaired"} ` +
      `across ${completedVerifiers.length} runs (exits ${exitCodes.join(", ") || "none"})`,
  )
}
const changedPaths = artifact.workspace.status
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => line.slice(3))
if (changedPaths.some((file) => file !== "src/state.txt" && file !== ".verify-attempts")) {
  throw new Error(`Legacy degeneration mutation allowlist mismatch: ${changedPaths.join(", ")}`)
}

const result = {
  ...artifact,
  evidence: {
    outcome,
    verifierRuns: completedVerifiers.length,
    exitCodes,
    repaired,
    doomLoopPatterns: doomLoopRequests.flatMap((request) => request.patterns),
    maxVerifierRuns,
    maxProviderTurns,
    successMarkerHash: Bun.hash(successMarker).toString(16),
    errorMarkerHash: Bun.hash(errorMarker).toString(16),
    finalTextLength: observation.finalText.length,
    changedPaths,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ${outcome}, ` +
    `${observation.usage.input + observation.usage.output} tokens)`,
)

function verifierExit(metadata: unknown) {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined
  const exit = (metadata as Record<string, unknown>).exit
  return typeof exit === "number" ? exit : undefined
}

finishLiveScript()
