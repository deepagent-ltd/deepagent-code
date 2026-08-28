import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import type { PlanDoc } from "@deepagent-code/core/deepagent/plan-controller"
import { loadPlanLiveLLMConfig, writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { assertPlanAdvanceObservation } from "./plan-advance-oracle"
import { runLegacyLiveCases } from "./runtime"

const config = await loadPlanLiveLLMConfig()
const conflictCase = "retry-after-authority-race"
const concurrentNote = "concurrent authority update"
let immutable: PlanDoc | undefined
let conflictInjected = false

const artifact = await runLegacyLiveCases({
  suite: "plan-advance-contract-legacy",
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
    "This is a Plan advance parameter-contract test in one durable Session.",
    "Call only the plan tool requested by the current user.",
    "For operation advance, copy expected_plan_id, expected_version, and step_id values exactly from the latest plan-status or plan result.",
    "Send only operation, expected_plan_id, expected_version, active_step_id, and steps containing step_id plus status.",
    "Never send goal, assumptions, replan_reason, title, acceptance, or assigned_agent on advance.",
    "If the tool returns plan_protocol conflict, retry the same requested transition exactly once from the authoritative parameters in that result.",
  ].join(" "),
  modelMaxTokens: config.providerID === "kimi" ? 1536 : 768,
  maxProviderTurns: 5,
  cases: [
    {
      name: "advance-first-boundary",
      prompt: planPrompt("step_1", "step_2", false),
    },
    {
      name: "advance-second-boundary",
      prompt: planPrompt("step_2", "step_3", false),
    },
    {
      name: conflictCase,
      prompt: planPrompt("step_3", "step_4", true),
    },
  ],
  beforeCase: async ({ caseName, sessionID }) => {
    if (caseName !== "advance-first-boundary") return
    AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, "high")
    const plan = AgentGateway.DeepAgentPlanController.createPlanDoc(
      sessionID,
      "Verify model Plan advances preserve server-owned authority",
      [
        {
          step_id: "step_1",
          title: "Inspect the authoritative Plan snapshot",
          status: "active",
          acceptance: "The model uses the supplied CAS precondition",
          assigned_agent: "primary",
        },
        {
          step_id: "step_2",
          title: "Advance with a minimal status patch",
          status: "pending",
          acceptance: "Server-owned identity remains unchanged",
          assigned_agent: "primary",
        },
        {
          step_id: "step_3",
          title: "Recover from an injected authority race",
          status: "pending",
          acceptance: "The retry uses the returned authoritative baseline",
          assigned_agent: "primary",
        },
        {
          step_id: "step_4",
          title: "Retain the concurrent authority update",
          status: "pending",
          acceptance: "Concurrent server-owned data survives the retry",
          assigned_agent: "primary",
        },
      ],
      ["The Plan document is the only structural authority"],
    )
    const committed = AgentGateway.DeepAgentPlanStore.compareAndCommitPlan({
      sessionId: sessionID,
      expected: null,
      candidate: plan,
      origin: "runtime_goal_bridge",
    })
    AgentGateway.DeepAgentSessionState.bindPlan(sessionID, committed.plan, null, committed.changed)
    immutable = committed.plan
  },
  beforePermissionReply: async ({ caseName, request }) => {
    if (caseName !== conflictCase || request.permission !== "plan" || conflictInjected) return
    const current = AgentGateway.DeepAgentPlanStore.getPlanDoc(request.sessionID)
    const ref = AgentGateway.DeepAgentPlanStore.planDocRef(request.sessionID)
    if (!current || !ref) throw new Error("Conflict injection could not read the Plan authority")
    const committed = AgentGateway.DeepAgentPlanStore.compareAndCommitPlan({
      sessionId: request.sessionID,
      expected: { plan_id: current.plan_id, doc_id: ref.id, version: ref.version },
      candidate: {
        ...current,
        steps: current.steps.map((step) => (step.step_id === "step_3" ? { ...step, note: concurrentNote } : step)),
      },
      origin: "runtime_goal_bridge",
    })
    AgentGateway.DeepAgentSessionState.bindPlan(request.sessionID, committed.plan, current, committed.changed)
    conflictInjected = true
  },
})

await writeLiveArtifact(config, `${artifact.suite}-observed`, artifact)

if (!immutable) throw new Error("Plan contract suite did not seed its authoritative Plan")
const authoritativePlan = immutable
if (!conflictInjected) throw new Error("Plan contract suite did not inject the authority race")
if (artifact.status !== "passed")
  throw new Error(`Plan contract Provider run failed: ${JSON.stringify(artifact.error)}`)
if (new Set(artifact.cases.map((testCase) => testCase.sessionID)).size !== 1) {
  throw new Error("Plan contract cases did not reuse one durable Session")
}

const expectations = [
  {
    caseName: "advance-first-boundary",
    version: 2,
    activeStepID: "step_2",
    statuses: { step_1: "done", step_2: "active", step_3: "pending", step_4: "pending" },
    notes: { step_1: null, step_2: null, step_3: null, step_4: null },
    calls: [{ version: 1, protocol: "success" as const }],
  },
  {
    caseName: "advance-second-boundary",
    version: 3,
    activeStepID: "step_3",
    statuses: { step_1: "done", step_2: "done", step_3: "active", step_4: "pending" },
    notes: { step_1: null, step_2: null, step_3: null, step_4: null },
    calls: [{ version: 2, protocol: "success" as const }],
  },
  {
    caseName: conflictCase,
    version: 5,
    activeStepID: "step_4",
    statuses: { step_1: "done", step_2: "done", step_3: "done", step_4: "active" },
    notes: { step_1: null, step_2: null, step_3: concurrentNote, step_4: null },
    calls: [
      { version: 3, protocol: "conflict" as const },
      { version: 4, protocol: "success" as const },
    ],
  },
]

expectations.forEach((expected) => {
  const observation = artifact.cases.find((testCase) => testCase.name === expected.caseName)
  if (!observation) throw new Error(`Missing Plan contract case ${expected.caseName}`)
  const statusPatch: Record<string, string> =
    expected.caseName === "advance-first-boundary"
      ? { step_1: "done", step_2: "active" }
      : expected.caseName === "advance-second-boundary"
        ? { step_2: "done", step_3: "active" }
        : { step_3: "done", step_4: "active" }
  assertPlanAdvanceObservation({
    caseName: expected.caseName,
    observation,
    immutable: authoritativePlan,
    expectedVersion: expected.version,
    expectedActiveStepID: expected.activeStepID,
    expectedStatuses: expected.statuses,
    expectedNotes: expected.notes,
    expectedCalls: expected.calls.map((call) => ({
      ...call,
      activeStepID: expected.activeStepID,
      statuses: statusPatch,
    })),
  })
  if (observation.providerErrors.length > 0) {
    throw new Error(`${expected.caseName} recorded Provider errors: ${JSON.stringify(observation.providerErrors)}`)
  }
  if (observation.assembledRequestFingerprints.length < expected.calls.length) {
    throw new Error(`${expected.caseName} did not capture every Provider request boundary`)
  }
})

const result = {
  ...artifact,
  evidence: {
    provider: config.providerID,
    durableSessionCount: new Set(artifact.cases.map((testCase) => testCase.sessionID)).size,
    conflictInjected,
    finalPlanVersion: artifact.cases.at(-1)?.plan?.ref?.version,
    planCalls: artifact.cases.flatMap((testCase) =>
      testCase.newTools.map((tool) => ({
        caseName: testCase.name,
        name: tool.name,
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

function planPrompt(doneStepID: string, activeStepID: string, retryConflict: boolean) {
  return [
    `Call plan to mark ${doneStepID} done and ${activeStepID} active.`,
    "Use operation advance and copy the exact expected_plan_id and expected_version from the latest plan-status.",
    `Set active_step_id to ${activeStepID}. Send exactly two steps: ${doneStepID} with status done, then ${activeStepID} with status active.`,
    "Each step object must contain only step_id and status. Omit goal, assumptions, replan_reason, title, acceptance, assigned_agent, and note.",
    retryConflict
      ? "If the first result is a Plan conflict, retry this same transition exactly once with the authoritative expected_* values returned by the tool."
      : "Call plan exactly once. No conflict is expected.",
    "Do not call any other tool.",
  ].join(" ")
}
