import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// Suite B1: shell-exit-contract. This suite pins TWO contracts that a repair loop depends on.
//
//   1. THE GROUND-TRUTH EXIT TRAILER — src/tool/shell.ts:599-607. Its own comment records the original
//      bug: the exit code lived ONLY in `metadata.exit`, which is never serialized into the transcript the
//      model and the downstream classifiers read. A green (exit 0) command therefore carried no success
//      token in its text, and `extractValidationResults` had to guess pass/fail from arbitrary output,
//      defaulting to FAIL when no "PASS" token appeared — misreading a large fraction of green runs.
//      `exit code: N` is now emitted as the last line of every shell result.
//
//   2. TOOL EXECUTED, NOT SUBSTITUTED — src/session/tools.ts:258-261. When the plan gate returns a
//      `block` directive the chokepoint returns `{ title: "Plan update required", output, metadata: {} }`
//      and never calls `item.execute`. A substituted result therefore has NO exit trailer in its text and
//      NO numeric `metadata.exit`. Oracles 1 and 3 below are what detect that, so a revived soft-block
//      cannot silently masquerade as a real command result again.
//
// WHAT THIS SUITE DOES NOT CLAIM: it does not cover plan-gate warn text. That path cannot produce
// model-visible output under this harness. `isLightweightMode` is true for `general`
// (packages/core/src/deepagent/plan-controller.ts:131) and the harness hardcodes DEEPAGENT_MODE=general
// (script/live-llm/runtime.ts:543), so `gateWarnReason` at src/session/tools.ts:199 is always undefined
// and :205 returns `{ kind: "pass" }` unconditionally. Even outside `general`, the warn path's only
// effect is a `log.info` (src/session/tools.ts:215-218) — never provider-visible or durable content.
// A text-grep oracle for banner placement would be structurally dead here, so this suite has none.
//
// Both markers are minted per run so the model can only learn them by actually executing the verifier.
const successMarker = `shell-exit-ok-${crypto.randomUUID()}`
const errorMarker = `shell-exit-error-${crypto.randomUUID()}`
const verifier = [
  "#!/bin/sh",
  'if [ "$(cat src/pipeline.txt)" = "mode=ready" ]; then',
  `  printf '%s\\n' '${successMarker}'`,
  "  exit 0",
  "fi",
  `printf '%s\\n' '${errorMarker}' >&2`,
  "exit 19",
  "",
].join("\n")
const prompt = [
  "Run ./verify exactly. It is expected to fail the first time; read its real result instead of stopping.",
  "Then read src/pipeline.txt, edit its exact mode value from broken to ready, and run ./verify exactly again.",
  "Reply with the success marker from the second verifier result.",
].join("\n")
const artifact = await runLegacyLiveCases({
  suite: "shell-exit-contract-legacy",
  permission: {
    "*": "deny",
    bash: { "*": "deny", "./verify": "allow" },
    read: { "*": "deny", "src/pipeline.txt": "allow" },
    edit: { "*": "deny", "src/pipeline.txt": "allow" },
  },
  cases: [{ name: "exit-contract", prompt }],
  files: { "src/pipeline.txt": "mode=broken\n" },
  inspectFiles: ["src/pipeline.txt"],
  toolSandbox: { verifierScript: verifier, initialVerifier: "fail" },
  // The repair takes at most ~4 provider turns (fail→read→edit→pass); 8 gives generous slack
  // without allowing a runaway session that would exhaust the harness timeout instead of failing fast.
  maxProviderTurns: 8,
})

// Minimum 2 (fail + pass); +3 slack for extra diagnostic reads or retries a real model may add.
// Without a bound the only gate is the harness timeoutMs, which gives a generic timeout message
// rather than a precise "runaway loop" failure pointing back to the implementation.
const maxVerifierRuns = 5
const observation = artifact.cases[0]
if (!observation) throw new Error("Missing shell exit contract observation")
// Oracle 10 (HARD): no marker may reach the model through the prompt.
if (prompt.includes(successMarker) || prompt.includes(errorMarker)) {
  throw new Error("Shell exit contract verifier marker leaked into the prompt")
}
const completed = observation.tools.filter((tool) => tool.status === "completed")
const shells = completed.filter((tool) => tool.name === "bash")

// Oracle 6 (HARD): the turn must not degrade to chat-only, the original user-visible symptom. Checked
// first so the first/last-call oracles below can rely on at least two shell calls existing.
if (shells.length < 2 || !completed.some((tool) => tool.name === "edit" || tool.name === "write")) {
  throw new Error(
    `Shell exit contract degraded away from tool use: ${observation.tools
      .map((tool) => `${tool.name}:${tool.status}`)
      .join(", ")}`,
  )
}
// Oracle 5 (HARD): runaway-loop bound. A repair should take exactly 2 verifier runs; extra slack for
// one diagnostic re-read or an intermediate check. Exceeding this bound means the repair loop is not
// converging and we need a precise failure, not a generic harness timeout.
if (shells.length > maxVerifierRuns) {
  throw new Error(
    `Shell exit contract runaway: ${shells.length} bash calls exceeds bound of ${maxVerifierRuns} ` +
      `(exits: ${shells.map((t) => record(t.metadata, "bash metadata").exit).join(", ")})`,
  )
}

// One measured pass over every completed shell result. Anchored to end-of-STRING (no /m flag) because
// src/tool/shell.ts:599-607 promises the trailer is the LAST line: tail() truncation keeps the end, and
// the trailer is appended after truncation, so nothing may follow it. `null (terminated)` is accepted
// here and attributed separately by Oracle 2 — a killed command must never be reported as a missing
// trailer, which would blame src/tool/shell.ts for what is actually a termination.
const trailers = shells.map((tool) => ({
  exit:
    typeof tool.output === "string" ? /\nexit code: (\d+|null \(terminated\))\s*$/.exec(tool.output)?.[1] : undefined,
  metadataExit: record(tool.metadata, "Bash metadata").exit,
}))

// Oracle 1 (HARD): the trailer contract itself — src/tool/shell.ts:599-607. Dual purpose: a missing
// trailer is either that regression OR a substituted (never-executed) result per src/session/tools.ts:258-261.
const missingTrailer = trailers.filter((trailer) => trailer.exit === undefined)
if (missingTrailer.length > 0) {
  throw new Error(
    `${missingTrailer.length}/${trailers.length} Bash results lack a trailing 'exit code: N' line ` +
      "(regression in src/tool/shell.ts:599-607, or a substituted result that never reached item.execute)",
  )
}

// Oracle 2 (HARD): correct attribution for termination. A terminated command legitimately renders
// `exit code: null (terminated)`, so it must be reported as a termination and never as a trailer defect.
const terminated = trailers.filter((trailer) => trailer.exit === "null (terminated)")
if (terminated.length > 0) {
  throw new Error(
    `${terminated.length}/${trailers.length} Bash calls were terminated (exit code: null) rather than ` +
      "completing; the exit trailer contract is intact but this run is not a valid repair observation",
  )
}

// Oracle 3 (HARD): tool executed, not substituted — src/session/tools.ts:258-261. A `block` directive
// returns `metadata: {}`, so a numeric `metadata.exit` on every completed shell call proves each result
// came from a real `item.execute` run rather than from the gate's substituted payload.
// Cannot fire under current implementation: the block path at src/session/tools.ts:188-190 is documented
// dead. Present as a forward-looking tripwire only.
const substituted = trailers.filter((trailer) => typeof trailer.metadataExit !== "number")
if (substituted.length > 0) {
  throw new Error(
    `${substituted.length}/${trailers.length} Bash results carry no numeric metadata.exit, so the tool ` +
      "never executed (substituted result from the plan gate block branch at src/session/tools.ts:258-261)",
  )
}

// Oracles 4 and 5 (HARD): the first verifier run must carry the real failure, the last the real success.
const firstShell = shells[0]
const lastShell = shells.at(-1)
const firstExit = trailers[0]?.metadataExit
const lastExit = trailers.at(-1)?.metadataExit
if (typeof firstExit !== "number" || firstExit === 0 || !firstShell?.output?.includes(errorMarker)) {
  throw new Error(`First verifier run did not report a real nonzero failure: exit ${JSON.stringify(firstExit)}`)
}
if (lastExit !== 0 || !lastShell?.output?.includes(successMarker)) {
  throw new Error(`Last verifier run did not report a real exit 0 success: exit ${JSON.stringify(lastExit)}`)
}

// Oracle 7 (HARD): the hidden verifier only passes on the byte-exact repair, so confirm the same bytes on disk.
if (artifact.workspace.files["src/pipeline.txt"] !== "mode=ready\n") {
  throw new Error("Shell exit contract did not persist the exact source repair")
}

// Oracle 8 (HARD): mutation allowlist.
const changedPaths = artifact.workspace.status
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => line.slice(3))
if (changedPaths.length !== 1 || changedPaths[0] !== "src/pipeline.txt") {
  throw new Error(`Shell exit contract mutation allowlist mismatch: ${changedPaths.join(", ")}`)
}

// Oracle 9 (HARD): the run must have executed inside the qualified sandbox, otherwise the verifier is not an oracle.
if (!artifact.sandbox?.networkDenied || !artifact.sandbox.verifierWriteDenied) {
  throw new Error("Shell exit contract ran without a qualified sandbox")
}

const result = {
  ...artifact,
  evidence: {
    errorMarkerHash: Bun.hash(errorMarker).toString(16),
    successMarkerHash: Bun.hash(successMarker).toString(16),
    bashCalls: shells.length,
    trailerExitCodes: trailers.map((trailer) => trailer.exit),
    metadataExitCodes: trailers.map((trailer) => trailer.metadataExit),
    terminatedCalls: terminated.length,
    missingTrailerCalls: missingTrailer.length,
    toolSequence: observation.tools.map((tool) => `${tool.name}:${tool.status}`),
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
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${observation.usage.input + observation.usage.output} tokens)`,
)

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

finishLiveScript()
