import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

// The former V1 WorldStateBaseline/PromptEpoch tables are no longer written by the provider
// owner. This case proves ordinary V2 automatic compaction retains a prior user fact; X-05's
// provider-specific hard-gate checkpoint is pinned separately by the Core runner tests.
const marker = `retention-${crypto.randomUUID()}`
const artifact = await runLegacyLiveCases({
  suite: "automatic-compaction-retention-v2",
  permission: { "*": "deny" },
  cases: [
    {
      name: "establish-context",
      prompt: `Remember the exact recovery code ${marker} for my next question. For this turn only, reply READY. ` +
        "Earlier inert details. ".repeat(180),
    },
    {
      name: "recover-after-compaction",
      prompt: "What exact recovery code did I give you in the previous turn? Reply with the code only. " +
        "Recent inert details. ".repeat(250),
    },
  ],
  sharedSession: true,
  inspectDurability: true,
  inspectProviderTurns: true,
  // The two prepared turns measure about 2.6k and 4.0k full-request tokens. The compaction
  // estimator measured the second below the former 3.7k trigger, so cross 3.2k instead while
  // leaving room for the provider's 2k output reservation.
  modelContextTokens: 8_192,
  modelMaxTokens: 256,
  compaction: { auto: true, preserve_recent_tokens: 512, reserved: 5_000 },
  maxProviderTurns: 4,
  timeoutMs: 180_000,
})

await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${artifact.suite}-observed`,
  artifact,
  { redactions: [{ value: marker, replacement: "<retention-marker>" }] },
)

const first = artifact.cases.find((testCase) => testCase.name === "establish-context")
const recovery = artifact.cases.find((testCase) => testCase.name === "recover-after-compaction")
if (!first?.durability || !recovery?.durability) throw new Error("V2 compaction durability evidence is missing")
if (first.sessionID !== recovery.sessionID) throw new Error("V2 compaction crossed Session identities")
if (first.durability.v2.contextCheckpoints.length !== 0) {
  throw new Error("The first provider turn compacted before establishing the marker")
}
const compactions = recovery.durability.v2.compactions
  .filter((message) => message.type === "compaction" && message.reason === "auto")
if (compactions.length !== 1) throw new Error(`Expected one V2 automatic compaction, received ${compactions.length}`)
const compaction = compactions[0]!
if (compaction.type !== "compaction") throw new Error("The V2 compaction journal row was not decoded")
if (
  recovery.providerErrors.length !== 0 ||
  recovery.newTools.length !== 0 ||
  (recovery.providerTurns?.filter((turn) => turn.state === "settled").length ?? 0) < 1 ||
  recovery.finalText.trim() !== marker
) {
  throw new Error(`Compaction lost the prior user fact or failed the real provider turn: ${JSON.stringify({
    answer: recovery.finalText,
    providerTurns: recovery.providerTurns,
    providerErrors: recovery.providerErrors,
    tools: recovery.newTools,
  })}`)
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    markerHash: Bun.hash(marker).toString(16),
    automaticCompactions: compactions.length,
    settledRecoveryTurns: recovery.providerTurns?.filter((turn) => turn.state === "settled").length ?? 0,
    retainedFact: true,
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
  {
    redactions: [{ value: marker, replacement: `<retention-marker hash=${result.evidence.markerHash}>` }],
    harnessFiles: [
      "packages/deepagent-code/script/live-llm/compaction-retention.ts",
      "packages/deepagent-code/script/live-llm/runtime.ts",
      "packages/llm/script/live-llm/config.ts",
    ],
    oracleVersion: "v2-auto-compaction-retention-v1",
  },
)
console.log(`${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID})`)

finishLiveScript()
