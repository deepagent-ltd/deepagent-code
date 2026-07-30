import path from "node:path"
import { DEFAULT_QUORUM_POLICY, type PanelOpinion, type PanelVerdict } from "../../src/agent/schema/panel"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { assertPanelArbitrationEvidence } from "./expert-panel-oracle"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const evidence = {
  correctness: `evidence-${crypto.randomUUID()}`,
  security: `evidence-${crypto.randomUUID()}`,
  architecture: `evidence-${crypto.randomUUID()}`,
}
const evidenceRedactions = Object.values(evidence).map((marker) => ({
  value: marker,
  replacement: `<hidden-evidence hash=${Bun.hash(marker).toString(16)}>`,
}))
const files = {
  correctness: "fixtures/correctness.ts",
  security: "fixtures/security.ts",
  architecture: "fixtures/architecture.ts",
} as const
const question = [
  "Your differentiated panel instructions state your assigned lens.",
  "Follow this exact real-tool sequence for your assigned lens:",
  "1. Invoke the registered read tool exactly once for the assigned file. Do not print or imitate XML/tool markup.",
  "2. Wait for the read tool result and use the EVIDENCE constant from that result.",
  "3. Write a complete textual draft containing the required finding and verdict; the separate finalizer will convert it to ReviewResult.",
  "CORRECTNESS: read only fixtures/correctness.ts, return verdict block with one correctness or edge-case finding, and finding confidence 0.95.",
  "SECURITY: read only fixtures/security.ts, return verdict block with one security finding, and finding confidence 0.95.",
  "ARCHITECTURE: read only fixtures/architecture.ts, return verdict revise with one convention finding, and finding confidence 0.95.",
  "Use the exact EVIDENCE constant returned by the real read as your private evidence check; the final finding must instead preserve the fixture-specific code fact required for your lens.",
  "Use the assigned relative file path in the finding and give a concrete failureScenario.",
  "Do not add lens or panelist identity fields or phrases such as 'my lens'; normal technical terms and file paths remain allowed.",
  "Do not call any other tool.",
].join("\n")

const artifact = await runLegacyLiveCases({
  suite: "expert-panel-lens-differentiation-legacy",
  permission: {
    "*": "deny",
    read: { "*": "deny", ...Object.fromEntries(Object.values(files).map((file) => [file, "allow"])) },
  },
  agentPermissions: {
    reviewer: {
      "*": "deny",
      read: { "*": "deny", ...Object.fromEntries(Object.values(files).map((file) => [file, "allow"])) },
    },
  },
  cases: [{ name: "convene-production-panel", prompt: "Reply exactly PANEL_READY without calling tools." }],
  files: {
    [files.correctness]: [
      `export const EVIDENCE = ${JSON.stringify(evidence.correctness)}`,
      "export function middle<T>(items: T[]) {",
      "  return items[Math.ceil(items.length / 2)]",
      "}",
      "",
    ].join("\n"),
    [files.security]: [
      `export const EVIDENCE = ${JSON.stringify(evidence.security)}`,
      'export const productionToken = "sk_live_hardcoded_panel_fixture"',
      "",
    ].join("\n"),
    [files.architecture]: [
      'import { rawConnection } from "../database/internal"',
      `export const EVIDENCE = ${JSON.stringify(evidence.architecture)}`,
      "export const loadDashboard = () => rawConnection.query('select * from dashboard')",
      "",
    ].join("\n"),
  },
  sharedSession: true,
  panel: {
    afterCaseName: "convene-production-panel",
    question,
    codeRefs: Object.values(files),
    lenses: ["correctness", "security", "architecture"],
    maxRounds: 1,
    policy: "default",
  },
  primaryPrompt: "Reply exactly as requested and do not call tools.",
  modelMaxTokens: 1536,
  maxProviderTurns: 8,
  toolSandbox: {},
})

await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  { ...artifact, status: "observed" },
  { redactions: evidenceRedactions },
)

if (Object.values(evidence).some((marker) => question.includes(marker))) {
  throw new Error("D3 evidence marker leaked into the frozen panel question")
}
if (!artifact.sandbox?.hostReadDenied || !artifact.sandbox.systemHostReadDenied || !artifact.sandbox.networkDenied) {
  throw new Error("D3 did not run in the qualified tool sandbox")
}

const observation = artifact.cases[0]
if (!observation) throw new Error("Missing D3 parent observation")
if (observation.tools.length !== 0) throw new Error("D3 parent called tools outside consultPanel")
if (observation.children.length !== 3 || new Set(observation.children.map((child) => child.id)).size !== 3) {
  throw new Error(`D3 expected three distinct reviewer children, received ${observation.children.length}`)
}
if (
  observation.children.some(
    (child) =>
      child.parentID !== observation.sessionID ||
      child.agent !== "reviewer" ||
      child.model?.providerID !== "live-deepseek" ||
      child.model.id !== artifact.fingerprint.modelID ||
      child.assistants.some(
        (assistant) =>
          assistant.providerID !== "live-deepseek" || assistant.modelID !== artifact.fingerprint.modelID,
      ),
  )
) {
  throw new Error("D3 child lineage, role, or provider/model identity is incorrect")
}

const panel = record(artifact.panel, "panel evidence")
const verdict = panel.verdict as PanelVerdict
const opinions = panel.opinions as PanelOpinion[]
if (!Array.isArray(opinions) || opinions.length !== 3) {
  throw new Error(`D3 observed ${Array.isArray(opinions) ? opinions.length : 0} arbiter opinions`)
}

const expected = {
  correctness: {
    file: files.correctness,
    marker: evidence.correctness,
    category: ["correctness", "edge-case"],
    verdict: "block",
    findingEvidence: ["Math.ceil"],
  },
  security: {
    file: files.security,
    marker: evidence.security,
    category: ["security"],
    verdict: "block",
    findingEvidence: ["sk_live_hardcoded_panel_fixture"],
  },
  architecture: {
    file: files.architecture,
    marker: evidence.architecture,
    category: ["convention"],
    verdict: "revise",
    findingEvidence: ["rawConnection", "../database/internal"],
  },
} as const
for (const opinion of opinions) {
  const contract = expected[opinion.lens as keyof typeof expected]
  if (!contract) throw new Error(`D3 returned unexpected lens ${opinion.lens}`)
  if (opinion.verdict !== contract.verdict || opinion.findings.length !== 1) {
    throw new Error(`D3 ${opinion.lens} opinion did not follow its seeded verdict contract`)
  }
  const finding = opinion.findings[0]
  const findingText = finding
    ? [finding.summary, finding.failureScenario, finding.suggestion ?? ""].join("\n")
    : ""
  const foreignMarkerPresent = Object.values(evidence).some(
    (marker) => marker !== contract.marker && findingText.includes(marker),
  )
  const missingFindingEvidence = contract.findingEvidence.filter((value) => !findingText.includes(value))
  if (
    !finding ||
    finding.file !== contract.file ||
    !contract.category.includes(finding.category as never) ||
    foreignMarkerPresent ||
    missingFindingEvidence.length > 0 ||
    finding.failureScenario.trim().length === 0 ||
    finding.confidence !== 0.95
  ) {
    throw new Error(
      `D3 ${opinion.lens} finding was not grounded in its unique seeded evidence: ${JSON.stringify({
        file: finding?.file,
        category: finding?.category,
        foreignMarkerPresent,
        missingFindingEvidence,
        failureScenarioPresent: Boolean(finding?.failureScenario.trim()),
        confidence: finding?.confidence,
      })}`,
    )
  }
  const prose = [finding.summary, finding.failureScenario, finding.suggestion ?? ""].join("\n").toLowerCase()
  if (/\b(?:my|assigned)\s+lens\b|\bpanelist\b|\blens\s+(?:is|:)\b/.test(prose)) {
    throw new Error(`D3 ${opinion.lens} finding leaked its panel identity`)
  }

  const child = observation.children.find((candidate) =>
    candidate.users.some((user) => user.text.toUpperCase().includes(`LENS IS ${opinion.lens.toUpperCase()}`)),
  )
  if (!child) throw new Error(`D3 could not map ${opinion.lens} to a differentiated child prompt`)
  const tools = child.assistants.flatMap((assistant) => assistant.tools)
  const completed = tools.filter((tool) => tool.status === "completed")
  if (
    tools.length !== 2 ||
    completed.map((tool) => tool.name).join("\0") !== ["read", "StructuredOutput"].join("\0")
  ) {
    throw new Error(`D3 ${opinion.lens} tool sequence was ${tools.map((tool) => `${tool.name}:${tool.status}`).join(" -> ")}`)
  }
  const read = record(completed[0]?.input, `${opinion.lens} read input`)
  if (typeof read.filePath !== "string" || !read.filePath.endsWith(contract.file)) {
    throw new Error(`D3 ${opinion.lens} read the wrong evidence file`)
  }
  const readOutput = typeof completed[0]?.output === "string" ? completed[0].output : ""
  const researchText = child.assistants.map((assistant) => assistant.text).join("\n")
  const evidenceText = `${readOutput}\n${researchText}`
  if (
    !readOutput.includes(contract.marker) ||
    Object.values(evidence).some((marker) => marker !== contract.marker && evidenceText.includes(marker))
  ) {
    throw new Error(`D3 ${opinion.lens} did not receive only its unique evidence through the real read tool`)
  }
  const structured = child.assistants.find((assistant) => assistant.structured !== undefined)?.structured
  if (record(structured, `${opinion.lens} ReviewResult`).lens !== undefined) {
    throw new Error(`D3 ${opinion.lens} model output leaked a lens field into ReviewResult`)
  }
}

assertPanelArbitrationEvidence({
  opinions,
  verdict,
  policy: DEFAULT_QUORUM_POLICY,
  rounds: 1,
  expectedLenses: ["correctness", "security", "architecture"],
})
if (verdict.decision !== "block" || verdict.dissent.length !== 1 || verdict.dissent[0]?.lens !== "architecture") {
  throw new Error("D3 did not preserve the overruled architecture opinion as dissent")
}
if (observation.permissionRequests.length !== 0 || observation.questionRequests.length !== 0) {
  throw new Error("D3 requested undeclared permission or question input")
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    evidenceHashes: Object.values(evidence).map((marker) => Bun.hash(marker).toString(16)),
    childSessionIDs: observation.children.map((child) => child.id),
    opinionLenses: opinions.map((opinion) => opinion.lens).toSorted(),
    verdict,
    arbiterRecomputed: true,
    permissionRequestCount: observation.permissionRequests.length,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
  { redactions: evidenceRedactions },
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${opinions.length} opinions, verdict ${verdict.decision})`,
)

finishLiveScript()

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}
