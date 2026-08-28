import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const directMarker = `direct-intent-${crypto.randomUUID()}`
const rewriteMarker = `rewrite-intent-${crypto.randomUUID()}`
const directIntentID = `intent-direct-${crypto.randomUUID()}`
const rewriteIntentID = `intent-rewrite-${crypto.randomUUID()}`
// Keep classifier input natural; response markers belong to the agent prompt, not the user request.
const directPrompt = "你好"
const conflictingPrompt = "你好！"
const rewritePrompt = "谢谢"

const artifact = await runLegacyLiveCases({
  suite: "prompt-intent-fencing-legacy",
  permission: { "*": "deny" },
  cases: [
    {
      name: "intelligence-direct",
      prompt: directPrompt,
      intelligence: { outputLanguage: "english", expectedRoute: "general" },
      admission: {
        intentID: directIntentID,
        source: "intelligence",
        variant: "original",
        exactRetry: true,
        conflictingRetry: { prompt: conflictingPrompt, variant: "rewritten" },
      },
    },
    {
      name: "revert-rewrite",
      prompt: rewritePrompt,
      admission: {
        intentID: rewriteIntentID,
        source: "rewrite",
        variant: "rewritten",
        exactRetry: true,
      },
      revertBefore: { targetCase: "intelligence-direct", retryTargetIntent: true },
    },
  ],
  sharedSession: true,
  primaryPrompt:
    `When the user says "${directPrompt}", reply with exactly ${directMarker}. ` +
    `When the user says "${rewritePrompt}", reply with exactly ${rewriteMarker}. ` +
    "Do not call tools or add any other text.",
  modelMaxTokens: 128,
  maxProviderTurns: 2,
})

const direct = requireCase("intelligence-direct")
const rewrite = requireCase("revert-rewrite")

if (direct.sessionID !== rewrite.sessionID) throw new Error("Prompt intent fencing did not use one durable Session")
if (direct.intelligenceDraft?.route !== "general" || direct.intelligenceDraft.preview !== directPrompt) {
  throw new Error("Intelligence preparation did not select the direct route with the original prompt")
}
if (
  direct.admission?.state !== "admitted" ||
  direct.admission.source !== "intelligence" ||
  direct.admission.variant !== "original" ||
  direct.admission.delivery !== "turn"
) {
  throw new Error(`Direct intent receipt was invalid: ${JSON.stringify(direct.admission)}`)
}
const directRetry = direct.admission.retry
if (
  directRetry?.exact?.accepted !== true ||
  !directRetry.activeBeforeRetry ||
  directRetry.exact.userCountBefore !== directRetry.exact.userCountAfter
) {
  throw new Error("Exact direct-intent retry was not an active-turn admission no-op")
}
if (
  directRetry.conflict?.accepted !== false ||
  directRetry.conflict.error !== "SessionPromptIntent.Conflict"
) {
  throw new Error(`Late rewritten draft was not rejected: ${JSON.stringify(directRetry.conflict)}`)
}
if (direct.users.length !== 1 || direct.users[0]?.text !== directPrompt) {
  throw new Error(`Direct route materialized ${direct.users.length} user messages instead of the original input once`)
}
if (direct.users[0].metadata?.deepagent?.prompt_pipeline?.mode !== "direct_override") {
  throw new Error("Direct-route user message did not preserve direct_override metadata")
}
if (
  direct.assistantTurns !== 1 ||
  direct.newTools.length !== 0 ||
  direct.providerErrors.length !== 0 ||
  !direct.finalText.includes(directMarker)
) {
  throw new Error("Direct-route execution did not complete exactly once through the real provider")
}

if (
  rewrite.revert?.targetCase !== "intelligence-direct" ||
  rewrite.revert.epochAfter !== rewrite.revert.epochBefore + 1 ||
  rewrite.revert.retry?.accepted !== false ||
  rewrite.revert.retry.error !== "SessionMutationEpoch.Stale"
) {
  throw new Error(`Revert did not fence the old prompt intent: ${JSON.stringify(rewrite.revert)}`)
}
if (
  rewrite.admission?.state !== "admitted" ||
  rewrite.admission.source !== "rewrite" ||
  rewrite.admission.variant !== "rewritten" ||
  rewrite.admission.mutationEpoch !== rewrite.revert.epochAfter
) {
  throw new Error(`Rewrite intent receipt was invalid: ${JSON.stringify(rewrite.admission)}`)
}
const rewriteRetry = rewrite.admission.retry
if (
  rewriteRetry?.exact?.accepted !== true ||
  !rewriteRetry.activeBeforeRetry ||
  rewriteRetry.exact.userCountBefore !== rewriteRetry.exact.userCountAfter
) {
  throw new Error("Exact rewrite retry was not an active-turn admission no-op")
}
if (rewrite.users.length !== 1 || rewrite.users[0]?.text !== rewritePrompt) {
  throw new Error(`Revert/rewrite materialized ${rewrite.users.length} current user messages instead of one`)
}
if (
  rewrite.assistantTurns !== 1 ||
  rewrite.newTools.length !== 0 ||
  rewrite.providerErrors.length !== 0 ||
  !rewrite.finalText.includes(rewriteMarker)
) {
  throw new Error("Rewritten prompt did not execute exactly once through the real provider")
}
if (rewrite.allText.includes(directMarker) || artifact.workspace.status.trim()) {
  throw new Error("Revert left stale output in the active transcript or mutated the workspace")
}
if (
  artifact.cases.some(
    (testCase) => testCase.permissionRequests.length !== 0 || testCase.questionRequests.length !== 0,
  )
) {
  throw new Error("Prompt intent fencing requested undeclared permission or question input")
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    directIntentHash: Bun.hash(directIntentID).toString(16),
    rewriteIntentHash: Bun.hash(rewriteIntentID).toString(16),
    directMarkerHash: Bun.hash(directMarker).toString(16),
    rewriteMarkerHash: Bun.hash(rewriteMarker).toString(16),
    exactRetries: 2,
    conflictingDraftRejected: true,
    staleEpochRetryRejected: true,
    mutationEpochAdvance: rewrite.revert.epochAfter - rewrite.revert.epochBefore,
    userMessagesAfterRewrite: rewrite.users.length,
    providerTurns: direct.assistantTurns + rewrite.assistantTurns,
  },
}

await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
  {
    redactions: [
      { value: directMarker, replacement: `<direct-marker hash=${result.evidence.directMarkerHash}>` },
      { value: rewriteMarker, replacement: `<rewrite-marker hash=${result.evidence.rewriteMarkerHash}>` },
      { value: directIntentID, replacement: `<direct-intent hash=${result.evidence.directIntentHash}>` },
      { value: rewriteIntentID, replacement: `<rewrite-intent hash=${result.evidence.rewriteIntentHash}>` },
    ],
  },
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${result.evidence.providerTurns} provider turns, epoch +${result.evidence.mutationEpochAdvance})`,
)

finishLiveScript()

function requireCase(name: string) {
  const testCase = artifact.cases.find((item) => item.name === name)
  if (!testCase) throw new Error(`Missing prompt-intent case ${name}`)
  return testCase
}
