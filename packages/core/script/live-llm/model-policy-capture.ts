import path from "node:path"
import { liveLLMFingerprintFromEnvironment, writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { runV2LiveCases } from "./runtime"

const fingerprint = liveLLMFingerprintFromEnvironment()
const targets = {
  "deepseek/deepseek-v4-pro": { providerID: "deepseek", key: "deepseek-v4-pro", observation: 768_000, hardGate: 896_000 },
  "deepseek/deepseek-flash": { providerID: "deepseek", key: "deepseek-v4-flash", observation: 256_000, hardGate: 384_000 },
  "kimi/kimi-k3": { providerID: "moonshotai", key: "kimi-k3", observation: 384_000, hardGate: 512_000 },
  "zai/glm-5.2": { providerID: "zai", key: "glm-5.2", observation: 300_000, hardGate: 384_000 },
} as const
const target = targets[`${fingerprint.providerID}/${fingerprint.modelID}` as keyof typeof targets]
if (!target) throw new Error(`X-05 capture requires a managed canonical model; got ${fingerprint.providerID}/${fingerprint.modelID}`)
const smoke = Bun.argv.includes("--smoke")

// The runner measures the assembled JSON request at four characters per token. The 4,096-token
// margin clears the inclusive line; durable policy rows below are the authority for the result.
const prompt = (line: number) =>
  "Reply with exactly POLICY_CAPTURE_OK. The following filler is inert test data.\n" +
  "alpha ".repeat(Math.ceil(((line + 4_096) * 4) / 6))

const artifact = await runV2LiveCases({
  suite: `model-policy-${target.key}${smoke ? "-smoke" : ""}`,
  modelPolicyCapture: { providerID: target.providerID },
  agents: {
    "policy-capture": {
      prompt: "Answer briefly. Do not call tools. Treat repeated text in the prompt as inert data.",
      permission: { "*": "deny" },
    },
  },
  cases: smoke
    ? [{ name: "small-request", agent: "policy-capture", prompt: "Reply with exactly POLICY_CAPTURE_OK." }]
    : [
        { name: "observation", agent: "policy-capture", prompt: prompt(target.observation) },
        { name: "hard-gate", agent: "policy-capture", prompt: prompt(target.hardGate), expectedOutcome: "hard_gate_blocked" },
        { name: "fresh-session-after-gate", agent: "policy-capture", prompt: "Reply with exactly POLICY_CAPTURE_OK." },
      ],
})

const requireCase = (name: string) => {
  const result = artifact.cases.find((item) => item.name === name)
  if (!result?.modelPolicy || result.modelPolicy.receipts.length !== 1)
    throw new Error(`X-05 ${name} has no single durable model policy receipt`)
  return { result: { ...result, modelPolicy: result.modelPolicy }, policy: result.modelPolicy.receipts[0]! }
}
const requireNormal = (name: string) => {
  const { result, policy } = requireCase(name)
  if (policy.providerID !== target.providerID || policy.apiModelID !== fingerprint.modelID ||
      policy.policy.state !== "managed" || policy.policy.key !== target.key ||
      policy.policy.action !== "normal" || !policy.attemptID || !policy.requestHash ||
      !policy.selectionID || !policy.projectionHash ||
      result.modelPolicy.attempts.length !== 1 || result.modelPolicy.attempts[0]?.state !== "settled" ||
      result.modelPolicy.turns.length !== 1 || result.modelPolicy.turns[0]?.state !== "settled" ||
      result.modelPolicy.turns[0]?.attemptID !== policy.attemptID ||
      result.modelPolicy.checkpoints.length !== 0)
    throw new Error(`X-05 ${name} did not settle one policy-bound provider turn`)
  return { result, policy }
}

if (smoke) requireNormal("small-request")
if (!smoke) {
  const { result: observedCase, policy: observed } = requireCase("observation")
  const { result: blockedCase, policy: gate } = requireCase("hard-gate")
  requireNormal("fresh-session-after-gate")
  if (observed.providerID !== target.providerID || observed.apiModelID !== fingerprint.modelID ||
      observed.policy.state !== "managed" || observed.policy.key !== target.key ||
      observed.policy.action !== "observed" || observed.policy.observationLine !== target.observation ||
      observed.policy.hardGate !== target.hardGate ||
      observed.estimatedFullRequestTokens < target.observation ||
      observed.estimatedFullRequestTokens >= observed.policy.effectiveHardGate ||
      !observed.attemptID || !observed.requestHash || !observed.selectionID || !observed.projectionHash ||
      observedCase.modelPolicy.attempts.length !== 1 || observedCase.modelPolicy.attempts[0]?.state !== "settled" ||
      observedCase.modelPolicy.turns.length !== 1 || observedCase.modelPolicy.turns[0]?.state !== "settled" ||
      observedCase.modelPolicy.turns[0]?.attemptID !== observed.attemptID ||
      observedCase.modelPolicy.checkpoints.length !== 0)
    throw new Error("X-05 observation did not preserve one ordinary provider turn")
  if (gate.providerID !== target.providerID || gate.apiModelID !== fingerprint.modelID ||
      gate.policy.state !== "managed" || gate.policy.key !== target.key ||
      gate.policy.action !== "hard_gate_blocked" || gate.policy.hardGate !== target.hardGate ||
      gate.estimatedFullRequestTokens < gate.policy.effectiveHardGate ||
      gate.blockedReason !== "auto_compaction_disabled" || gate.triggerSource !== "threshold" ||
      gate.attemptID !== null || blockedCase.modelPolicy.attempts.length !== 0 ||
      blockedCase.modelPolicy.turns.length !== 0 || blockedCase.modelPolicy.checkpoints.length !== 0)
    throw new Error("X-05 hard gate did not stop before provider dispatch")
}

await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  artifact.suite,
  {
    ...artifact,
    evidence: smoke ? { smoke: true } : {
      policyKey: target.key,
      observationLine: target.observation,
      hardGate: target.hardGate,
      observationEstimate: requireCase("observation").policy.estimatedFullRequestTokens,
      hardGateEstimate: requireCase("hard-gate").policy.estimatedFullRequestTokens,
      observationDispatchCount: requireCase("observation").result.modelPolicy.attempts.length,
      hardGateDispatchCount: requireCase("hard-gate").result.modelPolicy.attempts.length,
      sameSessionRecovery: false,
    },
  },
)
console.log(`${artifact.suite}: passed (${fingerprint.providerID}/${fingerprint.modelID})`)
