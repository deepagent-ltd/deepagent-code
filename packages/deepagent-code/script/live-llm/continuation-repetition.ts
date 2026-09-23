import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// Regression for session-scoped DeepAgent state and full round-context re-injection. The first case
// deliberately completes validation. The second admission must start with no stale round/results/plan
// context, then execute one expected failing validation followed by four serial reads. Every request
// after a tool result must carry the compact continuation tail, never the full task/activation block.
const passMarker = `continuation-pass-${crypto.randomUUID()}`
const failMarker = `continuation-fail-${crypto.randomUUID()}`
const objectiveMarker = `continuation-objective-${crypto.randomUUID()}`
const facts = Array.from({ length: 4 }, (_, index) => ({
  path: `facts/${index + 1}.txt`,
  marker: `fact-${index + 1}-${crypto.randomUUID()}`,
}))
const verifier = [
  "#!/bin/sh",
  'if [ "$1" = "pass" ]; then',
  `  printf '%s\\n' '${passMarker}'`,
  "  exit 0",
  "fi",
  `printf '%s\\n' '${failMarker}' >&2`,
  "exit 17",
  "",
].join("\n")
const prompts = {
  complete: `Run ./verify pass exactly once and reply with its exact marker.`,
  continuation: [
    `Objective label: ${objectiveMarker}.`,
    "Run ./verify fail exactly once. This failure is an expected fixture result, not work to repair.",
    `Then read ${facts.map((fact) => fact.path).join(", ")} in that exact order.`,
    "Issue exactly one tool call per assistant turn and wait for each result before calling the next tool.",
    "Do not re-explain the objective, phase, or expected failure between tools.",
    "In the final answer, print the objective label exactly once followed by the four fact markers in order.",
  ].join("\n"),
}
const redactions = [
  { value: passMarker, replacement: "<pass-marker>" },
  { value: failMarker, replacement: "<fail-marker>" },
  { value: objectiveMarker, replacement: "<objective-marker>" },
  ...facts.map((fact, index) => ({ value: fact.marker, replacement: `<fact-${index + 1}-marker>` })),
]
const artifact = await runLegacyLiveCases({
  suite: "continuation-repetition-legacy",
  permission: {
    "*": "deny",
    bash: { "*": "deny", "./verify pass": "allow", "./verify fail": "allow" },
    read: { "*": "deny", ...Object.fromEntries(facts.map((fact) => [fact.path, "allow" as const])) },
  },
  cases: [
    { name: "complete", prompt: prompts.complete },
    { name: "continuation", prompt: prompts.continuation },
  ],
  files: {
    ...Object.fromEntries(facts.map((fact) => [fact.path, `${fact.marker}\n`])),
    "AGENTS.md":
      "- `./verify pass` - passing fixture validation\n- `./verify fail` - expected failing fixture validation\n",
  },
  toolSandbox: { verifierScript: verifier },
  sharedSession: true,
  inspectProviderTurns: true,
  environment: { DEEPAGENT_MODE: "high" },
  primaryPrompt:
    "This is a serial tool-continuation contract test. Use only the tools named by the current user, " +
    "exactly one per assistant turn. An explicitly expected verifier failure is evidence to record, not a repair task.",
  modelMaxTokens: 1024,
  maxProviderTurns: 10,
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
  { redactions },
)

const completed = artifact.cases.find((testCase) => testCase.name === "complete")
const continuation = artifact.cases.find((testCase) => testCase.name === "continuation")
if (!completed || !continuation) throw new Error("Missing continuation-repetition observation")
const completedTools = completed.newTools.filter((tool) => tool.status === "completed")
if (
  completedTools.length !== 1 ||
  completedTools[0]?.name !== "bash" ||
  !completedTools[0].output?.includes(passMarker)
) {
  throw new Error("Setup activity did not complete through the passing verifier")
}

const tools = continuation.newTools.filter((tool) => tool.status === "completed")
// Provider-generic continuation contract: the failing validation is observed, every fact is
// read exactly once before being reported, and the turn context is a compact continuation.
// The exact interleaving of bash/read calls is model behavior, not a product guarantee.
const toolNames = tools.map((tool) => tool.name)
if (
  tools.length === 0 ||
  !toolNames.includes("bash") ||
  toolNames.filter((name) => name === "read").length !== facts.length ||
  continuation.newTools.some((tool) => tool.status !== "completed")
) {
  throw new Error(
    `Continuation tool sequence mismatch: ${continuation.newTools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}
const failOutput = tools.find((tool) => tool.name === "bash" && tool.output?.includes(failMarker))
if (!failOutput) {
  throw new Error("Continuation activity did not observe the expected failing validation")
}
const factOutputs = tools.filter((tool) => tool.name === "read")
for (const [index, fact] of facts.entries()) {
  if (
    !factOutputs.some((tool) => tool.output?.includes(fact.marker)) ||
    !continuation.finalText.includes(fact.marker)
  ) {
    throw new Error(`Continuation activity did not preserve fact ${index + 1}`)
  }
}
const finalMarkers = [objectiveMarker, ...facts.map((fact) => fact.marker)].map((marker) =>
  continuation.finalText.indexOf(marker),
)
if (finalMarkers.some((index) => index < 0) || finalMarkers.some((index, offset) => offset > 0 && index <= finalMarkers[offset - 1]!)) {
  throw new Error(`Continuation final markers are missing or out of order: ${finalMarkers.join(", ")}`)
}

// Durable V2 context-kind oracle: the legacy assembled-request fingerprint event is
// legacy-owner-only, so the classification reads the provider-turn receipts' volatile system
// parts instead — the exact control tail the request carried. Markers come from the gateway's
// own renderers (buildVolatileContinuationContext / buildVolatileRoundContext).
const contextKinds = (continuation.providerTurns ?? []).map((turn) => {
  const parts = turn.systemVolatileParts
  if (parts.some((part) => part.includes("# Tool continuation"))) return "continuation"
  if (parts.some((part) => part.includes("# 本轮状态 (round context)"))) return "round"
  return "none"
})
if ((continuation.providerTurns ?? []).length === 0) {
  throw new Error("Continuation activity observed no durable provider-turn receipts")
}
// A fresh activity's first provider turn must not be a tool continuation, and must not inherit
// the PREVIOUS case's round state: the passing validation from case 1 (passMarker) has no live
// source in this case, so its appearance in the first turn's control tail is stale re-injection.
// Under V2 the first turn legitimately carries a FRESH round context (kind "round"), so "none"
// is no longer the expected first-turn kind.
if (contextKinds[0] === "continuation") {
  throw new Error(`New activity opened as a tool continuation: ${contextKinds.join(" -> ")}`)
}
if ((continuation.providerTurns ?? [])[0]?.systemVolatileParts.some((part) => part.includes(passMarker))) {
  throw new Error(`New activity inherited stale runtime context: ${contextKinds.join(" -> ")}`)
}
if (
  contextKinds.length < tools.length + 1 ||
  contextKinds.slice(1).some((kind) => kind !== "continuation")
) {
  throw new Error(`Tool turns did not use compact continuation context: ${contextKinds.join(" -> ")}`)
}
const objectiveOccurrences = (continuation.allText.match(new RegExp(objectiveMarker, "g")) ?? []).length
if (objectiveOccurrences !== 1) {
  throw new Error(`The objective label appeared ${objectiveOccurrences} times instead of exactly once`)
}

const narrations = continuation.assistantTexts.map(normalize).filter((text) => text.length >= 24)
const repeatedPairs = narrations.flatMap((left, index) =>
  narrations.slice(index + 1).flatMap((right) => (dice(left, right) >= 0.68 ? [[left, right] as const] : [])),
)
if (repeatedPairs.length > 1) {
  throw new Error(`Assistant repeated semantically equivalent narration across ${repeatedPairs.length} turn pairs`)
}
if (artifact.workspace.status.trim()) {
  throw new Error(`Read-only continuation suite mutated the workspace: ${artifact.workspace.status}`)
}

const result = {
  ...artifact,
  evidence: {
    contextKinds,
    assistantTurns: continuation.assistantTurns,
    completedTools: tools.map((tool) => tool.name),
    repeatedNarrationPairs: repeatedPairs.length,
    maxNarrationSimilarity: Math.max(
      0,
      ...narrations.flatMap((left, index) => narrations.slice(index + 1).map((right) => dice(left, right))),
    ),
    objectiveMarkerHash: Bun.hash(objectiveMarker).toString(16),
    factMarkerHashes: facts.map((fact) => Bun.hash(fact.marker).toString(16)),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
  { redactions },
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${continuation.assistantTurns} assistant turns, ${contextKinds.length} requests)`,
)

function normalize(value: string) {
  return value.toLowerCase().replace(/[\p{P}\p{S}\s\d_]+/gu, "")
}

function dice(left: string, right: string) {
  const grams = (value: string) =>
    new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2)))
  const a = grams(left)
  const b = grams(right)
  if (a.size === 0 || b.size === 0) return 0
  const overlap = [...a].filter((gram) => b.has(gram)).length
  return (2 * overlap) / (a.size + b.size)
}

finishLiveScript()
