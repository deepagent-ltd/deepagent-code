import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// Suite D1 (design/real-llm-testing.md) — subagent finalizer isolation. The researcher child runs two
// phases in ONE child Session: a research turn with the normal read-only registry, then a bounded
// finalizer turn whose registry is emptied down to `StructuredOutput` alone (prompt.ts: `tools =
// finalizerMode ? {} : SessionTools.resolve(...)`). The regression this guards: research-phase tools
// leaking into the finalizer turn, which produced empty/invalid structured results or let the model
// keep researching instead of finalizing. The finalizer turn is identified durably — it is the only
// child assistant carrying a non-null `structured` (the research prompt has no `format`, so
// `structured` stays undefined there).
const markers = {
  module: `module-${crypto.randomUUID()}`,
  mechanism: `mechanism-${crypto.randomUUID()}`,
  interface: `interface-${crypto.randomUUID()}`,
  risk: `risk-${crypto.randomUUID()}`,
  openQuestion: `question-${crypto.randomUUID()}`,
}
const fixture = [
  `module: ${markers.module}`,
  `mechanism: ${markers.mechanism}`,
  `interface: ${markers.interface}`,
  `risk: ${markers.risk}`,
  `openQuestion: ${markers.openQuestion}`,
  "",
].join("\n")
const prompt = [
  "Call task exactly once in foreground mode with subagent_type researcher and description finalizer isolation fixture.",
  "The child prompt must be exactly: Read fixtures/data.txt exactly once. It holds five labelled values: module, mechanism, interface, risk, openQuestion. Return a ResearchResult copying each value byte for byte, with no quotes, labels, or commentary: module and mechanism from their own labels, interfaces as [interface value], risks as [risk value], openQuestions as [openQuestion value], keyFiles as [{path: fixtures/data.txt, role: fixture}]. Do not call task.",
  "Never read fixtures/data.txt yourself; only the child may read it.",
  "When task returns, report that the child research result was received without restating its values.",
].join("\n")
const artifact = await runLegacyLiveCases({
  suite: "subagent-finalizer-isolation-legacy",
  permission: { "*": "deny", read: "allow" },
  primaryPermission: { "*": "deny", task: "allow" },
  primaryPrompt:
    "This parent is a constrained delegation test. Use only the task tool, exactly once. Never call file, search, or shell tools, and never inspect the workspace yourself.",
  cases: [{ name: "finalizer", prompt }],
  files: { "fixtures/data.txt": fixture },
  // The finalizer must emit five UUID-sized values inside one JSON tool call; 512 output tokens is
  // too tight for that plus the research turn's verbatim relay.
  modelMaxTokens: 1024,
})
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
)

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing finalizer isolation observation")
const markerValues = Object.values(markers)
if (markerValues.some((value) => prompt.includes(value))) {
  throw new Error("Fixture markers leaked into the parent prompt")
}
if (observation.children.length !== 1) {
  throw new Error(`Expected one researcher child Session, received ${observation.children.length}`)
}
const child = observation.children[0]
if (!child || child.parentID !== observation.sessionID || child.agent !== "researcher") {
  throw new Error("Finalizer isolation child lineage or agent identity is incorrect")
}
if (
  child.model?.providerID !== "live-deepseek" ||
  child.model.id !== artifact.fingerprint.modelID ||
  child.assistants.some(
    (assistant) => assistant.providerID !== "live-deepseek" || assistant.modelID !== artifact.fingerprint.modelID,
  )
) {
  throw new Error("Finalizer isolation child persisted the wrong provider/model identity")
}
const childTools = child.assistants.flatMap((assistant) => assistant.tools)
if (
  !childTools.some(
    (tool) => tool.name === "read" && tool.status === "completed" && tool.output?.includes(markers.mechanism),
  )
) {
  throw new Error("Child research phase did not read the fixture through a completed read tool")
}
const structuredCalls = childTools.filter((tool) => tool.name === "StructuredOutput" && tool.status === "completed")
if (structuredCalls.length !== 1) {
  throw new Error(
    `Expected exactly one completed child StructuredOutput call, received ${structuredCalls.length}: ` +
      childTools.map((tool) => `${tool.name}:${tool.status}`).join(", "),
  )
}
const finalizers = child.assistants.filter((assistant) => assistant.structured !== undefined)
if (finalizers.length !== 1) {
  throw new Error(`Expected exactly one child finalizer turn, received ${finalizers.length}`)
}
// The finalizer's OWN tools array is the isolation oracle: a leaked research tool would land as a
// completed part on this same assistant message, not on an earlier research turn.
const finalizer = finalizers[0]
const foreignFinalizerTools = finalizer.tools.filter(
  (tool) => tool.status === "completed" && tool.name !== "StructuredOutput",
)
if (foreignFinalizerTools.length > 0) {
  throw new Error(
    `Finalizer turn executed research-phase tools: ${foreignFinalizerTools.map((tool) => tool.name).join(", ")}`,
  )
}
if (!finalizer.tools.some((tool) => tool.name === "StructuredOutput" && tool.status === "completed")) {
  throw new Error("Finalizer turn carries a structured result without its own completed StructuredOutput call")
}
const subagent = nestedRecord(child.metadata, ["deepagent", "subagent"])
if (subagent.state !== "completed" || subagent.finished !== true || subagent.reason !== "structured_output_valid") {
  throw new Error(`Child durable metadata is not a valid completed structured result: ${JSON.stringify(subagent)}`)
}
const result = record(finalizer.structured, "ResearchResult")
if (result.module !== markers.module || result.mechanism !== markers.mechanism) {
  throw new Error("Child ResearchResult scalar fields are not byte-exact copies of the fixture")
}
if (
  !Array.isArray(result.interfaces) ||
  !result.interfaces.includes(markers.interface) ||
  !Array.isArray(result.risks) ||
  !result.risks.includes(markers.risk) ||
  !Array.isArray(result.openQuestions) ||
  !result.openQuestions.includes(markers.openQuestion)
) {
  throw new Error("Child ResearchResult array fields do not hold the fixture values as exact elements")
}
const keyFiles = Array.isArray(result.keyFiles) ? result.keyFiles.map((entry) => record(entry, "ResearchKeyFile")) : []
if (keyFiles.length === 0 || !keyFiles.some((entry) => entry.path === "fixtures/data.txt")) {
  throw new Error("Child ResearchResult keyFiles does not cite the fixture path")
}
const parentTools = observation.tools.filter((tool) => tool.status === "completed")
if (parentTools.length !== 1 || parentTools[0]?.name !== "task") {
  throw new Error(
    `Parent must make exactly one task call (no task_status or task_read — those are denied): ${observation.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  )
}
// Only one marker is asserted on the parent-facing task result: renderOutput can bound the excerpt via
// DEEPAGENT_CODE_SUBAGENT_OUTPUT_MAX_CHARS, which the harness does not isolate. The byte-exact
// field-by-field oracle runs above, on child.structured, where no bound applies.
if (!parentTools[0]?.output?.includes(markers.mechanism)) {
  throw new Error("Parent task result did not carry the child's structured result")
}
const parentRead = observation.tools.find(
  (tool) =>
    tool.name === "read" &&
    tool.status === "completed" &&
    markerValues.some((value) => tool.output?.includes(value) ?? false),
)
if (parentRead) throw new Error("Parent read the fixture itself, so child isolation was not exercised")

// Production guard: unexpected parent tool errors indicate the parent called a denied tool
// (e.g., task_status or task_read). Deny decisions do NOT fire permission events so they
// won't appear in permissionRequests — this explicit check catches them.
const unexpectedParentErrors = observation.tools.filter(
  tool => tool.status === "error" && tool.name !== "task",
)
if (unexpectedParentErrors.length > 0) {
  throw new Error(
    `Parent made ${unexpectedParentErrors.length} unexpected denied tool call(s): ` +
      unexpectedParentErrors.map(t => t.name).join(", ") +
      " — check primaryPermission matches the parent prompt",
  )
}

const resultArtifact = {
  ...artifact,
  mode: "ext",
  evidence: {
    childSessionID: child.id,
    childAssistantTurns: child.assistants.length,
    structuredOutputCallCount: structuredCalls.length,
    finalizerTurnForeignToolCount: foreignFinalizerTools.length,
    researchToolNames: childTools.map((tool) => tool.name),
    parentReadOfFixture: parentRead !== undefined,
    markerHashes: Object.fromEntries(
      Object.entries(markers).map(([field, value]) => [field, Bun.hash(value).toString(16)]),
    ),
    durableReason: subagent.reason,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  resultArtifact.suite,
  resultArtifact,
)
console.log(
  `${resultArtifact.suite}: passed (${resultArtifact.fingerprint.providerID}/${resultArtifact.fingerprint.modelID}, ` +
    `${observation.usage.input + observation.usage.output} parent tokens)`,
)

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

function nestedRecord(value: unknown, keys: string[]) {
  const result = keys.reduce<Record<string, unknown> | undefined>((current, key) => {
    if (!current) return undefined
    const next = current[key]
    if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined
    return next as Record<string, unknown>
  }, typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)
  if (!result) throw new Error(`Missing object path ${keys.join(".")}`)
  return result
}

finishLiveScript()
