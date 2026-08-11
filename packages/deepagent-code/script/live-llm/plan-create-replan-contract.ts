import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { loadLiveLLMConfig, writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { assertPlanCreateObservation, assertPlanReplanObservation } from "./plan-create-replan-oracle"
import { runLegacyLiveCases } from "./runtime"

const config = await loadLiveLLMConfig()
if (config.providerID !== "deepseek" || config.modelID !== "deepseek-v4-flash") {
  throw new Error("Plan create/replan release test requires DeepSeek deepseek-v4-flash")
}

const goal = "Prove create and replan preserve server-owned Plan authority"
const assumptions = ["server_assigns_every_new_step_id", "retained_identity_is_authoritative"]
const titles = {
  inspect: "Inspect the authoritative Plan contract",
  replan: "Replan without guessing hidden identity",
  verify: "Verify server allocated the new step ID",
  release: "Record the release evidence",
}
const reasons = {
  addVerification: "Add an explicit verification step after inspecting the contract",
  addReleaseEvidence: "Add the final release-evidence step after verification begins",
}
const conflictCase = "replan-after-authority-race"
const concurrentNote = "concurrent authority note retained"
let conflictInjected = false

const artifact = await runLegacyLiveCases({
  suite: "plan-create-replan-contract-legacy",
  config,
  permission: { "*": "deny" },
  primaryPermission: { "*": "deny", plan: "ask" },
  permissionReply: { reply: "once" },
  sharedSession: true,
  inspectDurability: true,
  inspectPlan: true,
  observeAssembledRequestFingerprints: true,
  environment: { DEEPAGENT_ENABLED: "true", DEEPAGENT_MODE: "high" },
  primaryPrompt: [
    "This is a Plan create/replan parameter-contract test in one durable Session.",
    "Call only the plan tool requested by the current user.",
    "For create, expected_plan_id and expected_version are null; omit every step_id and omit active_step_id.",
    "For replan, copy the visible plan ID, version, and retained step IDs exactly.",
    "Omit step_id for every new replan step and omit active_step_id so the server derives it.",
    "For retained steps, do not guess title, acceptance, assigned_agent, or note; omit them unless an authoritative correction explicitly supplies them.",
    "Omit assumptions on replan so the server retains the authoritative list.",
    "If a plan conflict occurs, retry the requested replan exactly once using the authoritative correction.",
  ].join(" "),
  modelMaxTokens: 1024,
  maxProviderTurns: 5,
  cases: [
    {
      name: "create-server-owned-ids",
      prompt: [
        "Call plan exactly once with operation create.",
        `Set goal exactly to: ${goal}`,
        `Set assumptions to the exact JSON array ${JSON.stringify(assumptions)} without changing any character.`,
        `Create exactly two steps in order: ${titles.inspect} with status active; ${titles.replan} with status pending.`,
        "Each step object must contain only title and status.",
        "Set expected_plan_id and expected_version to null. Omit active_step_id and omit every step_id.",
        "Do not call another tool.",
      ].join(" "),
    },
    {
      name: "replan-retain-and-allocate",
      prompt: replanPrompt({
        reason: reasons.addVerification,
        statuses: [
          [titles.inspect, "done"],
          [titles.replan, "active"],
        ],
        newTitle: titles.verify,
        conflict: false,
      }),
    },
    {
      name: conflictCase,
      prompt: replanPrompt({
        reason: reasons.addReleaseEvidence,
        statuses: [
          [titles.inspect, "done"],
          [titles.replan, "done"],
          [titles.verify, "active"],
        ],
        newTitle: titles.release,
        conflict: true,
      }),
    },
  ],
  beforePermissionReply: async ({ caseName, request }) => {
    if (caseName !== conflictCase || request.permission !== "plan" || conflictInjected) return
    const current = AgentGateway.DeepAgentPlanStore.getPlanDoc(request.sessionID)
    const ref = AgentGateway.DeepAgentPlanStore.planDocRef(request.sessionID)
    if (!current || !ref) throw new Error("Create/replan conflict injection could not read Plan authority")
    const committed = AgentGateway.DeepAgentPlanStore.compareAndCommitPlan({
      sessionId: request.sessionID,
      expected: { plan_id: current.plan_id, doc_id: ref.id, version: ref.version },
      candidate: {
        ...current,
        steps: current.steps.map((step) => (step.title === titles.verify ? { ...step, note: concurrentNote } : step)),
      },
      origin: "runtime_goal_bridge",
    })
    AgentGateway.DeepAgentSessionState.bindPlan(request.sessionID, committed.plan, current, committed.changed)
    conflictInjected = true
  },
})

await writeLiveArtifact(config, `${artifact.suite}-observed`, artifact)
if (artifact.status !== "passed") {
  throw new Error(`Plan create/replan Provider run failed: ${JSON.stringify(artifact.error)}`)
}
if (new Set(artifact.cases.map((testCase) => testCase.sessionID)).size !== 1) {
  throw new Error("Plan create/replan cases did not reuse one durable Session")
}

const create = requireCase("create-server-owned-ids")
const created = assertPlanCreateObservation({
  caseName: create.name,
  observation: create,
  goal,
  assumptions,
  steps: [
    { title: titles.inspect, status: "active" },
    { title: titles.replan, status: "pending" },
  ],
})
const replan = requireCase("replan-retain-and-allocate")
const replanned = assertPlanReplanObservation({
  caseName: replan.name,
  observation: replan,
  authority: created,
  expectedVersion: 2,
  expectedActiveTitle: titles.replan,
  expectedReason: reasons.addVerification,
  expectedStatuses: {
    [titles.inspect]: "done",
    [titles.replan]: "active",
    [titles.verify]: "pending",
  },
  expectedNewTitles: [titles.verify],
  expectedCalls: [{ version: 1, protocol: "success" }],
})
const conflicted = requireCase(conflictCase)
const finalPlan = assertPlanReplanObservation({
  caseName: conflicted.name,
  observation: conflicted,
  authority: replanned,
  expectedVersion: 4,
  expectedActiveTitle: titles.verify,
  expectedReason: reasons.addReleaseEvidence,
  expectedStatuses: {
    [titles.inspect]: "done",
    [titles.replan]: "done",
    [titles.verify]: "active",
    [titles.release]: "pending",
  },
  expectedNewTitles: [titles.release],
  expectedCalls: [
    { version: 2, protocol: "conflict" },
    { version: 3, protocol: "success", notes: { [titles.verify]: concurrentNote } },
  ],
  expectedNotes: { [titles.verify]: concurrentNote },
})
if (!conflictInjected) throw new Error("Plan create/replan suite did not inject the authority race")
if (artifact.cases.some((testCase) => testCase.providerErrors.length > 0)) {
  throw new Error("Plan create/replan suite recorded Provider errors")
}

const result = {
  ...artifact,
  evidence: {
    provider: config.providerID,
    model: config.modelID,
    conflictInjected,
    planIDHash: Bun.hash(finalPlan.plan_id).toString(16),
    allocatedStepIDHashes: finalPlan.steps.map((step) => Bun.hash(step.step_id).toString(16)),
    finalPlanVersion: conflicted.plan?.ref?.version,
    planCalls: artifact.cases.flatMap((testCase) =>
      testCase.newTools.map((tool) => ({
        caseName: testCase.name,
        status: tool.status,
        protocol:
          typeof tool.metadata === "object" && tool.metadata !== null && "plan_protocol" in tool.metadata
            ? tool.metadata.plan_protocol
            : undefined,
      })),
    ),
  },
}
await writeLiveArtifact(config, result.suite, result)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${result.evidence.planCalls.length} Plan calls, final version ${result.evidence.finalPlanVersion})`,
)

finishLiveScript()

function replanPrompt(input: {
  reason: string
  statuses: ReadonlyArray<readonly [title: string, status: string]>
  newTitle: string
  conflict: boolean
}) {
  return [
    "Call plan with operation replan.",
    "Copy expected_plan_id, expected_version, and every retained step_id exactly from the latest plan-status or authoritative plan result.",
    `Copy the current goal exactly and set replan_reason exactly to: ${input.reason}`,
    `Retain the existing steps in their current order with these statuses: ${input.statuses.map(([title, status]) => `${title}=${status}`).join("; ")}.`,
    `Append exactly one new step titled ${input.newTitle} with status pending.`,
    "Each retained step must contain only step_id and status. The new step must contain only title and status.",
    "Omit active_step_id. Omit assumptions. Omit title, acceptance, assigned_agent, and note for retained steps.",
    input.conflict
      ? "If the first result is a Plan conflict, retry the same requested replan exactly once using the authoritative correction and preserve any concurrent note."
      : "Call plan exactly once. No conflict is expected.",
    "Do not call another tool.",
  ].join(" ")
}

function requireCase(name: string) {
  const testCase = artifact.cases.find((item) => item.name === name)
  if (!testCase) throw new Error(`Missing Plan create/replan case ${name}`)
  return testCase
}
